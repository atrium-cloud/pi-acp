import { performance } from 'node:perf_hooks'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import { warmSpareLogLine } from '../constants.js'
import { asMessage } from '../server/errors.js'
import type { SessionConnection } from './SessionConnection.js'
import {
  type EstablishedSession,
  establishSession,
  type SessionSetupDeps,
  type SessionSetupRequest,
  validateSessionRequest,
} from './sessionSetup.js'

/** Two requests with one key spawn Pi identically. Server order counts, since
 * the MCP extension registers them in list order. */
export function warmSpareKey(request: SessionSetupRequest): string {
  return JSON.stringify([request.cwd, validateSessionRequest(request)])
}

export interface TakenSpare {
  readonly established: EstablishedSession
  readonly configOptions: SessionConfigOption[]
  readonly ageMs: number
}

interface HeldSpare {
  readonly key: string
  readonly established: EstablishedSession
  readonly startedAt: number
  readonly expiry: NodeJS.Timeout
}

/** One started Pi subprocess held unregistered for the next matching
 * `session/new`. It needs no routing of its own until taken: with no prompt
 * there are no turn events, a startup notify waits for the command
 * announcement, and a dialog is denied as for any session. */
export class WarmSpare {
  private readonly maxAgeMs: number
  private held: HeldSpare | null = null
  private building = false
  private stopped = false

  constructor(maxAgeMs: number) {
    this.maxAgeMs = maxAgeMs
  }

  /** Null sends the caller down the cold path. The slot is claimed before the
   * first await, so two concurrent `session/new` cannot both take it. A dead or
   * expired spare is dropped whatever its key, so it never blocks a refill. */
  async take(request: SessionSetupRequest): Promise<TakenSpare | null> {
    const held = this.held
    if (held === null) return null
    const ageMs = performance.now() - held.startedAt
    if (held.established.connection.dead !== null || ageMs >= this.maxAgeMs) {
      void this.release(held)
      return null
    }
    if (held.key !== warmSpareKey(request)) return null
    clearTimeout(held.expiry)
    this.held = null
    const { connection } = held.established
    try {
      const configOptions = await connection.refreshConfig()
      return { established: held.established, configOptions, ageMs: Math.round(ageMs) }
    } catch (error) {
      void stopSpare(connection)
      console.error(warmSpareLogLine(`config re-read failed, starting cold: ${asMessage(error)}`))
      return null
    }
  }

  /** Fire and forget: a failed build is logged, never thrown. */
  refill(request: SessionSetupRequest, deps: SessionSetupDeps): void {
    if (this.stopped || this.held !== null || this.building) return
    this.building = true
    void this.build(request, deps)
  }

  /** A build still in flight is not awaited: it stops its own subprocess when it
   * lands, and its open pipes keep the adapter process up until then. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.held !== null) await this.release(this.held)
  }

  private async build(request: SessionSetupRequest, deps: SessionSetupDeps): Promise<void> {
    // Aged from the spawn, since Pi reads its settings and resources as it starts.
    const startedAt = performance.now()
    try {
      const key = warmSpareKey(request)
      const established = await establishSession(request, deps, { kind: 'spare' })
      if (this.stopped) {
        await stopSpare(established.connection)
        return
      }
      const held: HeldSpare = {
        key,
        established,
        startedAt,
        expiry: setTimeout(() => void this.release(held), Math.max(0, this.maxAgeMs - (performance.now() - startedAt))),
      }
      held.expiry.unref()
      this.held = held
    } catch (error) {
      console.error(warmSpareLogLine(`failed to start: ${asMessage(error)}`))
    } finally {
      this.building = false
    }
  }

  private release(held: HeldSpare): Promise<void> {
    clearTimeout(held.expiry)
    this.held = null
    return stopSpare(held.established.connection)
  }
}

/** Never rejects, so a stop nobody awaits cannot become an unhandled rejection. */
function stopSpare(connection: SessionConnection): Promise<void> {
  return connection.stop().catch((error: unknown) => {
    console.error(warmSpareLogLine(`failed to stop: ${asMessage(error)}`))
  })
}
