import {
  CATALOG_REFRESH_COMMAND,
  CATALOG_REFRESH_EXTENSION_FILENAME,
  CATALOG_REFRESH_PI_ARGS,
  CATALOG_REFRESH_TIMEOUT_MS,
  catalogRefreshLogLine,
  COMMAND_PREFIX,
} from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'
import { materializeExtension } from '../pi/extensionFile.js'
import { asMessage } from '../server/errors.js'
import type { CreatePiClient, PiClientLike } from './SessionConnection.js'

// The refresh extension: one command whose handler awaits Pi's network refresh of
// every provider's catalog, which Pi saves itself. Pi answers the command `handled`
// once the handler settles, and reports a throw as an `extension_error`, which the
// RPC transport logs. Plain untyped JS, like the gate.
export const CATALOG_REFRESH_EXTENSION_SOURCE = [
  `const COMMAND = ${JSON.stringify(CATALOG_REFRESH_COMMAND)}`,
  `const TIMEOUT_MS = ${CATALOG_REFRESH_TIMEOUT_MS}`,
  `export default function (pi) {`,
  `  pi.registerCommand(COMMAND, {`,
  `    description: 'Refresh the model catalog',`,
  `    handler: async (_args, ctx) => {`,
  `      const result = await ctx.modelRegistry.refresh({ allowNetwork: true, signal: AbortSignal.timeout(TIMEOUT_MS) })`,
  `      if (result.aborted) throw new Error('model catalog refresh timed out after ' + TIMEOUT_MS + 'ms')`,
  `      if (result.errors.size === 0) return`,
  `      const failures = [...result.errors].map(([provider, error]) => provider + ': ' + error.message)`,
  `      throw new Error('model catalog refresh failed: ' + failures.join('; '))`,
  `    },`,
  `  })`,
  `}`,
  '',
].join('\n')

/** Written once at startup; only the refresher's own Pi loads it, so no session
 * advertises the command. */
export function materializeCatalogRefreshExtension(): string {
  return materializeExtension(CATALOG_REFRESH_EXTENSION_FILENAME, CATALOG_REFRESH_EXTENSION_SOURCE)
}

export interface CatalogRefresherOptions {
  readonly launch: PiLaunch
  readonly rpcTimeoutMs: number
  readonly cwd: string
  /** The `-e` args every session loads, so the refresh routes like a session. */
  readonly sessionExtensionArgs: readonly string[]
  readonly extensionPath: string
  readonly startupDelayMs: number
  readonly intervalMs: number
  readonly createPiClient: CreatePiClient
}

/** Runs Pi's catalog refresh in a Pi subprocess of its own, `startupDelayMs`
 * after `start()` and every `intervalMs` after that, so every Pi started
 * afterward restores the refreshed catalog. One refresh runs at a time per
 * adapter process, and a failed one is logged while the catalog Pi saved last
 * keeps serving. */
export class CatalogRefresher {
  private readonly options: CatalogRefresherOptions
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private piClient: PiClientLike | null = null
  private stopped = false

  constructor(options: CatalogRefresherOptions) {
    this.options = options
  }

  start(): void {
    this.schedule(this.options.startupDelayMs)
  }

  /** A call while a refresh runs joins it rather than starting a second Pi. Never rejects. */
  refreshOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Clears the schedule and stops a refresh in flight without logging its
   * failure; resolves once that refresh's Pi is stopped. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    await this.piClient?.stop()
    await this.running
  }

  // A timer overdue across a host suspend fires once on resume.
  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.schedule(this.options.intervalMs)
      void this.refreshOnce()
    }, delayMs)
    this.timer.unref()
  }

  private async run(): Promise<void> {
    const { launch, rpcTimeoutMs, cwd, sessionExtensionArgs, extensionPath, createPiClient } = this.options
    let piClient: PiClientLike | undefined
    try {
      piClient = createPiClient({
        launch,
        cwd,
        args: [...CATALOG_REFRESH_PI_ARGS, ...sessionExtensionArgs, '-e', extensionPath],
        timeoutMs: rpcTimeoutMs,
      })
      this.piClient = piClient
      await piClient.start()
      // Pi answers once the handler settles, which Pi's own timeout bounds.
      const ack = await piClient.request(
        { type: 'prompt', message: `${COMMAND_PREFIX}${CATALOG_REFRESH_COMMAND}` },
        { timeoutMs: CATALOG_REFRESH_TIMEOUT_MS + rpcTimeoutMs },
      )
      if (ack.data.disposition !== 'handled') {
        throw new Error(`Pi answered the refresh command "${ack.data.disposition}": the refresh extension registered no command`)
      }
    } catch (error) {
      if (!this.stopped) console.error(catalogRefreshLogLine(`failed: ${asMessage(error)}`))
    } finally {
      this.piClient = null
      await piClient?.stop().catch((error: unknown) => {
        console.error(catalogRefreshLogLine(`failed to stop Pi: ${asMessage(error)}`))
      })
    }
  }
}
