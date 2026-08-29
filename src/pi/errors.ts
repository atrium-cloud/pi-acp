// Typed transport failures. Distinct types because the lifecycle treats each
// differently: spawn failure is fatal at startup, a timeout fails one request, a
// death tears the session down.

/** How Pi is started: `command` plus the args that put it in RPC mode. */
export interface PiLaunch {
  readonly command: string
  readonly args: readonly string[]
  /** Where the launch came from, e.g. `PI_ACP_PI_BIN` — shown in errors. */
  readonly source: string
}

export function describePiLaunch({ command, args, source }: PiLaunch): string {
  return `pi "${[command, ...args].join(' ')}" (from ${source})`
}

/** The Pi process could not be spawned at all (e.g. ENOENT on a bad path). */
export class PiSpawnError extends Error {
  override readonly name = 'PiSpawnError'
  readonly launch: PiLaunch
  readonly code: string | undefined

  constructor(launch: PiLaunch, options: { code?: string; cause?: unknown }) {
    const suffix = options.code ? ` (${options.code})` : ''
    super(`Pi RPC transport: ${describePiLaunch(launch)} could not be spawned${suffix}`, {
      cause: options.cause,
    })
    this.launch = launch
    this.code = options.code
  }
}

export class PiRpcTimeoutError extends Error {
  override readonly name = 'PiRpcTimeoutError'
  readonly command: string
  readonly timeoutMs: number

  constructor(command: string, timeoutMs: number, stderrTail: string) {
    super(
      `Pi RPC transport: command "${command}" timed out after ${timeoutMs}ms${formatStderrTail(stderrTail)}`,
    )
    this.command = command
    this.timeoutMs = timeoutMs
  }
}

export class PiExitError extends Error {
  override readonly name = 'PiExitError'
  readonly code: number | null
  readonly signal: NodeJS.Signals | null

  constructor(code: number | null, signal: NodeJS.Signals | null, stderrTail: string) {
    super(
      `Pi RPC transport: child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${formatStderrTail(stderrTail)}`,
    )
    this.code = code
    this.signal = signal
  }
}

/** Pi answered a command with `success: false`; carries Pi's own message. */
export class PiRpcError extends Error {
  override readonly name = 'PiRpcError'
  readonly command: string

  constructor(command: string, piMessage: string) {
    super(`Pi RPC method "${command}": ${piMessage}`)
    this.command = command
  }
}

/** Pi's stdout carried something that is not a valid protocol frame. */
export class PiProtocolError extends Error {
  override readonly name = 'PiProtocolError'

  constructor(description: string) {
    super(`Pi RPC transport: protocol violation: ${description}`)
  }
}

/** The transport can no longer carry a command: stopped, or a stdio channel failed. */
export class PiClientClosedError extends Error {
  override readonly name = 'PiClientClosedError'

  constructor(reason: string) {
    super(`Pi RPC transport: ${reason}`)
  }
}

export function formatStderrTail(stderrTail: string): string {
  const trimmed = stderrTail.trim()
  return trimmed ? `; stderr tail:\n${trimmed}` : ''
}
