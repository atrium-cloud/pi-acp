import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import {
  AGENT_NAME,
  DEFAULT_RPC_TIMEOUT_MS,
  SIGTERM_GRACE_MS,
  STDERR_TAIL_MAX_BYTES,
  STDIN_END_GRACE_MS,
} from '../constants.js'
import type { PiLaunch } from './errors.js'
import {
  PiClientClosedError,
  PiExitError,
  PiProtocolError,
  PiRpcError,
  PiRpcTimeoutError,
  PiSpawnError,
  formatStderrTail,
} from './errors.js'
import { attachJsonlLineReader, serializeJsonLine } from './jsonl.js'
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from './types.js'

// ── Constants ───────────────────────────────────────────────────────────────

/** Bounds the wait for `close` after `exit`: a grandchild can hold the pipes. */
const EXIT_TO_CLOSE_GRACE_MS = 2_000
const REQUEST_ID_PREFIX = 'pi-acp-req-'
const NO_PI_ERROR_MESSAGE = '<pi reported no error message>'
const PROTOCOL_EXCERPT_MAX_CHARS = 200
const LOG_PREFIX = `[${AGENT_NAME}]`

// ── Types ───────────────────────────────────────────────────────────────────

type PiChildProcess = ChildProcessByStdio<Writable, Readable, Readable>

/** Pi emits this frame from `runRpcMode`'s extension `onError`; it is not part
 * of `JsonAgentSessionEvent` and upstream ships no type for it. */
interface PiExtensionErrorFrame {
  readonly type: 'extension_error'
  readonly extensionPath?: string
  readonly event?: string
  readonly error?: string
}

interface PendingRequest {
  readonly resolve: (response: RpcResponse) => void
  readonly reject: (error: Error) => void
}

export interface PiRpcClientOptions {
  readonly launch: PiLaunch
  readonly cwd: string
  /** Appended after the launch's own args. */
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly stdinEndGraceMs?: number
  readonly sigtermGraceMs?: number
  readonly onEvent?: (event: JsonAgentSessionEvent) => void
  readonly onExit?: (error: Error) => void
}

// ── Client ──────────────────────────────────────────────────────────────────

export class PiRpcClient {
  private readonly options: PiRpcClientOptions
  private readonly timeoutMs: number
  private readonly stdinEndGraceMs: number
  private readonly sigtermGraceMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: JsonAgentSessionEvent) => void>()
  private readonly closeWaiters = new Set<() => void>()
  private readonly stderrDecoder = new StringDecoder('utf8')

  private child: PiChildProcess | null = null
  private detachStdout: (() => void) | null = null
  private started = false
  private ready = false
  private spawned = false
  private stopping = false
  private stopPromise: Promise<void> | null = null
  private closed = false
  private exitNotified = false
  private childExited = false
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private transportError: Error | null = null
  private stderrBuffer = ''
  private nextRequestId = 0
  private closeFallbackTimer: NodeJS.Timeout | null = null
  private forceKillTimer: NodeJS.Timeout | null = null

  constructor(options: PiRpcClientOptions) {
    this.options = options
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.stdinEndGraceMs = options.stdinEndGraceMs ?? STDIN_END_GRACE_MS
    this.sigtermGraceMs = options.sigtermGraceMs ?? SIGTERM_GRACE_MS
  }

  /** Spawns the child and returns Pi's first `get_state`, which doubles as the
   * readiness probe. */
  async start(): Promise<RpcSessionState> {
    if (this.stopping) throw new PiClientClosedError('start() was called after stop()')
    if (this.started) throw new Error('Pi RPC transport: the client has already been started')
    this.started = true

    const child = this.spawnChild()
    this.child = child

    // Every reader is attached before the first write: an unread stdout blocks
    // Pi on its own drain and an unread stderr fills the pipe, and both turn
    // teardown into a SIGKILL.
    this.detachStdout = attachJsonlLineReader(child.stdout, (line) => {
      this.handleStdoutLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.appendStderr(chunk)
    })
    child.stdout.on('error', (error: Error) => {
      this.handleStreamError('stdout', error)
    })
    child.stderr.on('error', (error: Error) => {
      this.handleStreamError('stderr', error)
    })
    child.stdin.on('error', (error: Error) => {
      this.handleStdinError(error)
    })
    child.on('error', (error: Error) => {
      this.handleChildError(error)
    })
    child.on('exit', (code, signal) => {
      this.handleChildExit(code, signal)
    })
    child.on('close', () => {
      this.handleClosed()
    })

    try {
      // A failed spawn leaves stdin already destroyed, so without this the
      // readiness write would report a closed pipe instead of the real ENOENT.
      await this.waitForSpawn(child)
      const state = await this.getState()
      // A failure before this point surfaces only through start()'s rejection;
      // onExit is for the death of an already-live client, not a startup that
      // never completed.
      this.ready = true
      return state
    } catch (startupFailure) {
      // A child left running after a failed readiness probe keeps its ref'd
      // stdio pipes open, which pins the adapter's event loop forever.
      await this.stop()
      throw startupFailure
    }
  }

  async getState(): Promise<RpcSessionState> {
    const response = await this.request({ type: 'get_state' })
    return response.data
  }

  async request<C extends RpcCommand & { id?: undefined }>(
    command: C,
  ): Promise<Extract<RpcResponse, { command: C['type']; success: true }>> {
    const child = this.child
    if (!child) throw new PiClientClosedError(`command "${command.type}" was issued before start()`)
    if (this.stopping) throw new PiClientClosedError(`command "${command.type}" was issued after stop()`)
    if (this.transportError) throw this.transportError
    const stdin = child.stdin
    if (!stdin.writable || stdin.destroyed) {
      throw new PiClientClosedError(`command "${command.type}" cannot be sent; the child's stdin is closed`)
    }

    const id = `${REQUEST_ID_PREFIX}${++this.nextRequestId}`
    const line = serializeJsonLine({ ...command, id })

    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new PiRpcTimeoutError(command.type, this.timeoutMs, this.stderrTail()))
      }, this.timeoutMs)
      timer.unref()

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      // Not awaiting drain: the stream buffers and preserves write order, while
      // awaiting would let a later request overtake an earlier one.
      stdin.write(line, (writeError) => {
        if (!writeError) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        entry.reject(new PiClientClosedError(`command "${command.type}" failed to reach the child: ${writeError.message}`))
      })
    })

    if (!response.success) {
      const piMessage =
        typeof response.error === 'string' && response.error ? response.error : NO_PI_ERROR_MESSAGE
      throw new PiRpcError(command.type, piMessage)
    }
    if (response.command !== command.type) {
      // A frame answering a command nobody sent means the stream is desynced;
      // like every other protocol violation, nothing after it can be trusted.
      const mismatch = new PiProtocolError(
        `response ${id} answered command "${response.command}" but "${command.type}" was sent`,
      )
      this.failTransport(mismatch)
      throw mismatch
    }
    return response as Extract<RpcResponse, { command: C['type']; success: true }>
  }

  onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /** Idempotent two-stage teardown: stdin end (Pi's lossless exit) → SIGTERM →
   * SIGKILL. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    // Set synchronously and before touching the child, or the teardown's own
    // exit is reported through onExit as an unexpected death.
    this.stopping = true
    this.stopPromise = this.runStop()
    return this.stopPromise
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private spawnChild(): PiChildProcess {
    const { launch } = this.options
    const args = [...launch.args, ...(this.options.args ?? [])]
    try {
      return spawn(launch.command, args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (spawnFailure) {
      throw new PiSpawnError(launch, { cause: spawnFailure })
    }
  }

  private waitForSpawn(child: PiChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        this.spawned = true
        child.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn)
        reject(this.toSpawnError(error))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  private toSpawnError(error: Error): PiSpawnError {
    const code = errnoCode(error)
    return new PiSpawnError(this.options.launch, code === undefined ? { cause: error } : { code, cause: error })
  }

  private async runStop(): Promise<void> {
    const child = this.child
    if (!child) return

    this.rejectAllPending(new PiClientClosedError('the client was stopped before the command completed'))
    if (this.closed) return

    if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end()
    if (await this.waitForClose(this.stdinEndGraceMs)) return this.warnOnUncleanTeardown()

    child.kill('SIGTERM')
    if (await this.waitForClose(this.sigtermGraceMs)) return this.warnOnUncleanTeardown()

    child.kill('SIGKILL')
    await this.waitForClose(this.sigtermGraceMs)
    this.warnOnUncleanTeardown()
  }

  private warnOnUncleanTeardown(): void {
    if (this.exitCode === 0) return
    // A diagnosed fault (protocol/stdio) already reported the real cause through
    // onExit; the nonzero exit here is only our own SIGTERM/SIGKILL completing,
    // so warning again would train readers to ignore this line.
    if (this.transportError && !(this.transportError instanceof PiExitError)) return
    console.error(
      `${LOG_PREFIX} Pi RPC transport: teardown did not exit cleanly (code=${this.exitCode ?? 'null'}, signal=${this.exitSignal ?? 'null'})${formatStderrTail(this.stderrTail())}`,
    )
  }

  private waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.closeWaiters.delete(waiter)
        resolve(false)
      }, timeoutMs)
      timer.unref()
      const waiter = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.closeWaiters.add(waiter)
    })
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (parseFailure) {
      this.failTransport(
        new PiProtocolError(`stdout carried a line that is not JSON (${errorMessage(parseFailure)}): ${excerpt(line)}`),
      )
      return
    }
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed) || typeof parsed.type !== 'string') {
      this.failTransport(new PiProtocolError(`stdout carried a frame without a string "type": ${excerpt(line)}`))
      return
    }

    // Classified on `type` alone: `bash_execution_update` and
    // `extension_ui_request` also carry ids, so an id says nothing here.
    if (parsed.type === 'response') {
      this.handleResponseFrame(parsed as RpcResponse)
      return
    }
    if (parsed.type === 'extension_ui_request') {
      this.handleExtensionUiRequest(parsed as RpcExtensionUIRequest)
      return
    }
    if (parsed.type === 'extension_error') {
      this.handleExtensionError(parsed as PiExtensionErrorFrame)
      return
    }
    this.dispatchEvent(parsed as JsonAgentSessionEvent)
  }

  private handleResponseFrame(response: RpcResponse): void {
    const id = response.id
    if (typeof id !== 'string') {
      // Pi answers a line it could not parse with an id-less `parse` response,
      // and every command this client sends carries an id — so either way an
      // id-less response means the adapter put something invalid on stdin.
      const reason = response.success ? '' : `: ${response.error}`
      this.failTransport(
        new PiProtocolError(`Pi rejected an outbound command line as "${response.command}"${reason}`),
      )
      return
    }

    const entry = this.pending.get(id)
    if (!entry) {
      // Benign: a request that already timed out can still be answered later.
      console.error(
        `${LOG_PREFIX} Pi RPC transport: dropping response ${id} for command "${response.command}"; no request is waiting on it`,
      )
      return
    }
    this.pending.delete(id)
    entry.resolve(response)
  }

  private handleExtensionUiRequest(request: RpcExtensionUIRequest): void {
    switch (request.method) {
      case 'select':
      case 'confirm':
      case 'input':
      case 'editor':
        // Fail closed. Phase 1 has no permission surface, and Pi never
        // auto-resolves `editor` (it carries no timeout), so an unanswered
        // dialog wedges the turn forever.
        this.writeExtensionUiResponse({ type: 'extension_ui_response', id: request.id, cancelled: true })
        return
      case 'notify':
      case 'setStatus':
      case 'setWidget':
      case 'setTitle':
      case 'set_editor_text':
        return
    }
    const unhandled: never = request
    // A newer Pi may add UI methods. Throwing would escape the stdout data
    // handler and crash the adapter.
    this.failTransport(new PiProtocolError(`unhandled extension UI method: ${JSON.stringify(unhandled)}`))
  }

  private writeExtensionUiResponse(response: RpcExtensionUIResponse): void {
    // A dialog racing teardown has nobody left to answer it.
    if (this.stopping) return
    const child = this.child
    if (!child || !child.stdin.writable || child.stdin.destroyed) {
      console.error(
        `${LOG_PREFIX} Pi RPC transport: cannot answer extension UI request ${response.id}; the child's stdin is closed`,
      )
      return
    }
    child.stdin.write(serializeJsonLine(response), (writeError) => {
      if (!writeError) return
      console.error(
        `${LOG_PREFIX} Pi RPC transport: answering extension UI request ${response.id} failed: ${writeError.message}`,
      )
    })
  }

  private handleExtensionError(frame: PiExtensionErrorFrame): void {
    // An extension failure is Pi-side diagnostics, not a turn outcome, so it
    // stays out of the event stream.
    console.error(
      `${LOG_PREFIX} Pi extension error in ${frame.extensionPath ?? '<unknown extension>'} on event "${frame.event ?? '<unknown>'}": ${frame.error ?? '<no message>'}`,
    )
  }

  private dispatchEvent(event: JsonAgentSessionEvent): void {
    // Stdout buffered behind a teardown or a fatal fault must not keep feeding
    // listeners that have already been told the transport is gone.
    if (this.stopping || this.transportError || this.closed) return
    this.options.onEvent?.(event)
    for (const listener of this.eventListeners) listener(event)
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrBuffer += this.stderrDecoder.write(chunk)
    if (this.stderrBuffer.length > STDERR_TAIL_MAX_BYTES) {
      this.stderrBuffer = this.stderrBuffer.slice(-STDERR_TAIL_MAX_BYTES)
    }
  }

  private stderrTail(): string {
    return this.stderrBuffer
  }

  private handleStdinError(error: Error): void {
    // Writing to a dead child raises EPIPE; without this listener it would be
    // an uncaught exception. A death already in flight owns the diagnosis.
    if (this.closed || this.stopping || this.childExited || this.transportError) return
    this.failTransport(new PiClientClosedError(`the child's stdin failed: ${error.message}`))
  }

  private handleStreamError(source: 'stdout' | 'stderr', error: Error): void {
    this.failTransport(new PiClientClosedError(`the child's ${source} stream failed: ${error.message}`))
  }

  private handleChildError(error: Error): void {
    if (!this.spawned) {
      // A child that never spawned emits neither `exit` nor a reliable `close`.
      if (!this.transportError) this.transportError = this.toSpawnError(error)
      this.handleClosed()
      return
    }
    // Post-spawn this is something like a failed kill, not a dead child, so it
    // is neither a spawn failure nor a reason to stop waiting for exit/close.
    console.error(`${LOG_PREFIX} Pi RPC transport: child process reported an error: ${error.message}`)
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.childExited = true
    this.exitCode = code
    this.exitSignal = signal
    // `exit` races the final buffered stdout line, so the client only settles on
    // `close`; a grandchild holding the pipes open bounds how long that waits.
    this.armCloseFallback()
  }

  private armCloseFallback(): void {
    if (this.closeFallbackTimer || this.closed) return
    this.closeFallbackTimer = setTimeout(() => {
      this.handleClosed()
    }, EXIT_TO_CLOSE_GRACE_MS)
    this.closeFallbackTimer.unref()
  }

  private handleClosed(): void {
    if (this.closed) return
    this.closed = true
    if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer)
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer)
    this.detachStdout?.()

    const error = this.transportError ?? new PiExitError(this.exitCode, this.exitSignal, this.stderrTail())
    this.transportError = error
    this.rejectAllPending(error)
    this.notifyExit(error)

    const waiters = [...this.closeWaiters]
    this.closeWaiters.clear()
    for (const waiter of waiters) waiter()
  }

  /** Fatal transport fault: nothing on this child can be trusted afterwards. */
  private failTransport(error: Error): void {
    if (this.transportError) return
    this.transportError = error
    this.rejectAllPending(error)
    this.notifyExit(error)

    const child = this.child
    if (!child || this.closed) return
    if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end()
    child.kill('SIGTERM')
    this.forceKillTimer = setTimeout(() => {
      child.kill('SIGKILL')
    }, this.sigtermGraceMs)
    this.forceKillTimer.unref()
  }

  private notifyExit(error: Error): void {
    if (this.stopping || this.exitNotified || !this.ready) return
    this.exitNotified = true
    this.options.onExit?.(error)
  }

  private rejectAllPending(error: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) entry.reject(error)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errnoCode(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : undefined
}

function excerpt(line: string): string {
  return line.length > PROTOCOL_EXCERPT_MAX_CHARS
    ? `${line.slice(0, PROTOCOL_EXCERPT_MAX_CHARS)} [truncated]`
    : line
}

