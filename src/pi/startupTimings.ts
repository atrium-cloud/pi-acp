import {
  AGENT_NAME,
  CARRIAGE_RETURN_LINE_BREAK,
  LINE_FEED,
  PI_TIMING_BLOCK_ENTRY,
  PI_TIMING_BLOCK_FOOTER,
  PI_TIMING_BLOCK_HEADER,
} from '../constants.js'

/** Pi's timing blocks by namespace (`main`, `extensions`): label → ms, `TOTAL` included. */
export type PiStartupTimings = Readonly<Record<string, Readonly<Record<string, number>>>>

/** One session's startup timing line: an established session's setup or a
 * wake's relaunch, or a `session/new` answered by taking a warm spare. */
export type SessionStartupTiming =
  | {
      readonly mode: 'new' | 'open' | 'spare' | 'wake'
      readonly spawnMs: number | null
      readonly readyMs: number | null
      readonly metadataMs: number
      readonly totalMs: number
      readonly pi: PiStartupTimings | null
    }
  | { readonly mode: 'take'; readonly ageMs: number; readonly totalMs: number }

export const startupTimingLogLine = (sessionId: string, timing: SessionStartupTiming): string =>
  `[${AGENT_NAME}] [${sessionId}] startup timing ${JSON.stringify(timing)}`

/** A block counts only once its footer arrives, so a tail cut mid-block never
 * reports a partial set. A later block for the same namespace replaces it. */
export function parsePiStartupTimings(stderr: string): PiStartupTimings | null {
  const blocks = new Map<string, Readonly<Record<string, number>>>()
  let open: { readonly namespace: string; readonly entries: Map<string, number> } | null = null
  for (const line of stderr.replace(CARRIAGE_RETURN_LINE_BREAK, LINE_FEED).split(LINE_FEED)) {
    const namespace = PI_TIMING_BLOCK_HEADER.exec(line)?.[1]
    if (namespace !== undefined) {
      open = { namespace, entries: new Map() }
      continue
    }
    if (open === null) continue
    const entry = PI_TIMING_BLOCK_ENTRY.exec(line)
    const label = entry?.[1]
    const ms = entry?.[2]
    if (label !== undefined && ms !== undefined) {
      open.entries.set(label, Number(ms))
      continue
    }
    if (PI_TIMING_BLOCK_FOOTER.test(line)) {
      blocks.set(open.namespace, Object.fromEntries(open.entries))
      open = null
    }
  }
  return blocks.size === 0 ? null : Object.fromEntries(blocks)
}
