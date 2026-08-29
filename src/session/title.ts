import { SESSION_TITLE_MAX_CHARS } from '../constants.js'

/** One bounded line, shared by the name a first prompt gives Pi and the title
 * `session/list` derives from a stored transcript, so both read the same. */
export function deriveTitle(text: string): string {
  const firstLine = (text.split('\n', 1)[0] ?? '').trim()
  return firstLine.length > SESSION_TITLE_MAX_CHARS ? firstLine.slice(0, SESSION_TITLE_MAX_CHARS) : firstLine
}
