import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import {
  DEFAULT_PI_AGENT_DIR_SEGMENTS,
  ENV_PI_AGENT_DIR,
  ENV_PI_SESSION_DIR,
  MESSAGE_MAP_KEY_MESSAGES,
  MESSAGE_MAP_KEY_VERSION,
  MESSAGE_MAP_SUFFIX,
  MESSAGE_MAP_VERSION,
  PI_SESSIONS_DIR_NAME,
  PI_SETTINGS_FILE_NAME,
  SESSION_DIR_WRAP,
  SESSION_ENTRY_TYPE_HEADER,
  SESSION_ENTRY_TYPE_INFO,
  SESSION_ENTRY_TYPE_MESSAGE,
  SESSION_FILE_EXTENSION,
  SESSION_FILE_VERSION,
  SESSION_INFO_LOAD_CONCURRENCY,
} from '../constants.js'
import { uuidv7 } from './uuidv7.js'

// The adapter's view of Pi's session store, mirroring Pi's own session-manager
// behavior: the directory precedence, the lossy cwd encoding, and the metadata
// its session list builds. The fork file is the single write, and it reproduces
// what Pi's own fork writes. Reading never repairs a file — Pi's reader appends
// a missing trailing newline during a read, and the adapter must not.

// ── Constants ─────────────────────────────────────────────────────────────────

const FILE_ENCODING = 'utf8'
const BOM_CODE_POINT = 0xfe_ff
const TILDE = '~'
const TILDE_SLASH = '~/'
const TILDE_BACKSLASH = '~\\'
const WINDOWS_PLATFORM = 'win32'
const LEADING_SEPARATOR = /^[/\\]/
const SEPARATOR_OR_COLON = /[/\\:]/g
/** File name is `<timestamp>_<id>.jsonl`; an id may itself contain `_`. */
const SESSION_ID_SEPARATOR = '_'
const CONTENT_BLOCK_TYPE_TEXT = 'text'
const TEXT_BLOCK_SEPARATOR = ' '
const ROLE_USER = 'user'
const ROLE_ASSISTANT = 'assistant'
const CANDIDATE_PATH_SEPARATOR = ', '
const ENTRY_LINE_SEPARATOR = '\n'
/** Pi's file names carry the ISO timestamp with its `:` and `.` flattened. */
const FILE_TIMESTAMP_UNSAFE = /[:.]/g
const FILE_TIMESTAMP_REPLACEMENT = '-'
/** Never clobber an existing session file: a collision is a bug, not a retry. */
const FORK_FILE_WRITE_FLAG = 'wx'

// ── Types ─────────────────────────────────────────────────────────────────────

/** `flat`: one directory holding every session. `perCwd`: one subdirectory per
 * encoded cwd under `root`. */
export type SessionDirs =
  | { readonly mode: 'flat'; readonly dir: string }
  | { readonly mode: 'perCwd'; readonly root: string }

export interface SessionFileInfo {
  readonly path: string
  readonly id: string
  /** Header cwd; `''` when the header carries none. */
  readonly cwd: string
  readonly name: string | undefined
  readonly firstMessage: string | undefined
  readonly modified: Date
}

export interface ListSessionsOptions {
  readonly dirs: SessionDirs
  /** Absolute; narrows the scan and filters on header cwd equality. */
  readonly cwd?: string | undefined
}

export interface FindSessionFileOptions {
  readonly dirs: SessionDirs
  readonly id: string
  readonly cwd?: string | undefined
}

/** One parsed session file line. Only the fields the adapter reads are named;
 * the rest of an entry is carried opaquely, so a fork re-serializes it whole. */
export interface SessionFileEntry {
  readonly type?: unknown
  readonly id?: unknown
  readonly parentId?: unknown
  readonly cwd?: unknown
  readonly timestamp?: unknown
  readonly name?: unknown
  readonly message?: unknown
}

export interface WriteForkFileOptions {
  readonly dirs: SessionDirs
  /** The forked session's file; recorded verbatim as the fork's `parentSession`. */
  readonly parentPath: string
  /** The parent's entries in file order; its header is replaced, not copied. */
  readonly entries: readonly SessionFileEntry[]
  /** The fork's own cwd, which decides where the file lands. */
  readonly cwd: string
}

export interface ForkFile {
  readonly path: string
  readonly id: string
}

interface SessionHeader {
  readonly id: string
  readonly cwd: string
  readonly timestamp: unknown
}

interface MessageWithContent {
  readonly role: string
  readonly content: unknown
  readonly timestamp?: unknown
}

// ── Directory resolution ──────────────────────────────────────────────────────

export function resolveSessionDirs(env: NodeJS.ProcessEnv, homedir: string = osHomedir()): SessionDirs {
  const envSessionDir = env[ENV_PI_SESSION_DIR]
  if (envSessionDir) return { mode: 'flat', dir: resolveUserPath(envSessionDir, homedir) }

  const agentDir = resolveAgentDir(env, homedir)
  const settingsSessionDir = readSettingsSessionDir(agentDir)
  if (settingsSessionDir !== undefined) return { mode: 'flat', dir: resolveUserPath(settingsSessionDir, homedir) }

  return { mode: 'perCwd', root: join(agentDir, PI_SESSIONS_DIR_NAME) }
}

function resolveAgentDir(env: NodeJS.ProcessEnv, homedir: string): string {
  const envAgentDir = env[ENV_PI_AGENT_DIR]
  if (envAgentDir) return resolveUserPath(envAgentDir, homedir)
  return join(homedir, ...DEFAULT_PI_AGENT_DIR_SEGMENTS)
}

/** Pi records a settings parse failure as a diagnostic and falls back to empty
 * settings, so a malformed file leaves the per-cwd default in place. */
function readSettingsSessionDir(agentDir: string): string | undefined {
  const settingsPath = join(agentDir, PI_SETTINGS_FILE_NAME)
  if (!existsSync(settingsPath)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(readFileSync(settingsPath, FILE_ENCODING)))
  } catch {
    return undefined
  }
  const sessionDir = (parsed as { sessionDir?: unknown } | null)?.sessionDir
  return typeof sessionDir === 'string' && sessionDir !== '' ? sessionDir : undefined
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text
}

function resolveUserPath(input: string, homedir: string): string {
  return resolve(expandTilde(input, homedir))
}

function expandTilde(input: string, homedir: string): string {
  if (input === TILDE) return homedir
  if (input.startsWith(TILDE_SLASH) || (process.platform === WINDOWS_PLATFORM && input.startsWith(TILDE_BACKSLASH))) {
    return join(homedir, input.slice(TILDE_SLASH.length))
  }
  return input
}

/** Pi's per-project directory name, copied verbatim. Lossy (`/a/b-c` and `/a/b/c`
 * collide), so the header cwd is always checked on top of it. */
export function sessionDirForCwd(root: string, cwd: string): string {
  // Pi resolves before encoding; a path absolute only on another platform (the
  // Windows form under posix) cannot be resolved here and is encoded as given.
  const source = isAbsolute(cwd) ? resolve(cwd) : cwd
  const encoded = source.replace(LEADING_SEPARATOR, '').replace(SEPARATOR_OR_COLON, '-')
  return join(root, `${SESSION_DIR_WRAP}${encoded}${SESSION_DIR_WRAP}`)
}

// ── Scanning ──────────────────────────────────────────────────────────────────

export async function scanSessionFiles(dirs: SessionDirs): Promise<string[]> {
  if (dirs.mode === 'flat') return await readSessionFilesIn(dirs.dir)

  let rootEntries
  try {
    rootEntries = await readdir(dirs.root, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of rootEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    files.push(...(await readSessionFilesIn(join(dirs.root, entry.name))))
  }
  return files
}

async function readSessionFilesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(SESSION_FILE_EXTENSION)).map((name) => join(dir, name))
  } catch {
    return []
  }
}

async function scanSessionFilesForCwd(dirs: SessionDirs, cwd: string): Promise<string[]> {
  if (dirs.mode === 'flat') return await readSessionFilesIn(dirs.dir)
  return await readSessionFilesIn(sessionDirForCwd(dirs.root, cwd))
}

// ── Session metadata ──────────────────────────────────────────────────────────

/** Mirrors Pi's `buildSessionInfo`. `null` when the first parsed entry is not a
 * session header carrying a string id. */
export async function readSessionInfo(filePath: string): Promise<SessionFileInfo | null> {
  const stats = await stat(filePath)

  let header: SessionHeader | null = null
  let name: string | undefined
  let firstMessage: string | undefined
  let lastActivityTime: number | undefined

  const input = createReadStream(filePath, { encoding: FILE_ENCODING })
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      const entry = parseEntryLine(line)
      if (entry === null) continue

      if (header === null) {
        header = asHeader(entry)
        if (header === null) return null
        continue
      }

      // Latest wins, an empty name clearing it.
      if (entry.type === SESSION_ENTRY_TYPE_INFO) {
        name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined
      }
      if (entry.type !== SESSION_ENTRY_TYPE_MESSAGE) continue

      const activityTime = messageActivityTime(entry)
      if (activityTime !== undefined) lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime)

      if (firstMessage !== undefined) continue
      const message = entry.message
      if (!isMessageWithContent(message) || message.role !== ROLE_USER) continue
      const text = extractTextContent(message)
      if (text) firstMessage = text
    }
  } finally {
    reader.close()
    input.destroy()
  }

  if (header === null) return null

  const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : Number.NaN
  const modified =
    lastActivityTime !== undefined && lastActivityTime > 0
      ? new Date(lastActivityTime)
      : Number.isNaN(headerTime)
        ? stats.mtime
        : new Date(headerTime)

  return { path: filePath, id: header.id, cwd: header.cwd, name, firstMessage, modified }
}

/** Every parsed entry in file order, the header included, with malformed lines
 * skipped the way the metadata reader skips them. A file Pi has not written yet
 * reads as no entries; any other read failure propagates. */
export async function readSessionEntries(filePath: string): Promise<SessionFileEntry[]> {
  if (!existsSync(filePath)) return []

  const entries: SessionFileEntry[] = []
  const input = createReadStream(filePath, { encoding: FILE_ENCODING })
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      const entry = parseEntryLine(line)
      if (entry !== null) entries.push(entry)
    }
  } finally {
    reader.close()
    input.destroy()
  }
  return entries
}

function parseEntryLine(line: string): SessionFileEntry | null {
  if (!line.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  return parsed ? (parsed as SessionFileEntry) : null
}

function asHeader(entry: SessionFileEntry): SessionHeader | null {
  if (entry.type !== SESSION_ENTRY_TYPE_HEADER) return null
  if (typeof entry.id !== 'string') return null
  return { id: entry.id, cwd: typeof entry.cwd === 'string' ? entry.cwd : '', timestamp: entry.timestamp }
}

function messageActivityTime(entry: SessionFileEntry): number | undefined {
  const message = entry.message
  if (!isMessageWithContent(message)) return undefined
  if (message.role !== ROLE_USER && message.role !== ROLE_ASSISTANT) return undefined
  if (typeof message.timestamp === 'number') return message.timestamp

  const entryTime = typeof entry.timestamp === 'string' ? new Date(entry.timestamp).getTime() : Number.NaN
  return Number.isNaN(entryTime) ? undefined : entryTime
}

function isMessageWithContent(message: unknown): message is MessageWithContent {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { role?: unknown }).role === 'string' &&
    'content' in message
  )
}

function extractTextContent(message: MessageWithContent): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(TEXT_BLOCK_SEPARATOR)
}

function isTextBlock(block: unknown): block is { text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === CONTENT_BLOCK_TYPE_TEXT &&
    typeof (block as { text?: unknown }).text === 'string'
  )
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function listSessions(options: ListSessionsOptions): Promise<SessionFileInfo[]> {
  const cwd = options.cwd
  const files =
    cwd === undefined ? await scanSessionFiles(options.dirs) : await scanSessionFilesForCwd(options.dirs, cwd)

  const loaded = await mapWithConcurrency(files, SESSION_INFO_LOAD_CONCURRENCY, readSessionInfoOrNull)
  const sessions: SessionFileInfo[] = []
  for (const info of loaded) {
    // The per-cwd directory only narrows the scan: its name encoding is lossy.
    if (info !== null && (cwd === undefined || sessionCwdMatches(info.cwd, cwd))) sessions.push(info)
  }

  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime())
  return sessions
}

/** `null` when nothing matches; throws when the id matches more than one file. */
export async function findSessionFile(options: FindSessionFileOptions): Promise<string | null> {
  const cwd = options.cwd
  const files =
    cwd === undefined ? await scanSessionFiles(options.dirs) : await scanSessionFilesForCwd(options.dirs, cwd)

  const suffix = `${SESSION_ID_SEPARATOR}${options.id}${SESSION_FILE_EXTENSION}`
  const [match, ...rest] = files.filter((file) => basename(file).endsWith(suffix))
  if (match === undefined) return null
  if (rest.length > 0) {
    const candidates = [match, ...rest].join(CANDIDATE_PATH_SEPARATOR)
    throw new Error(`Session id "${options.id}" matches ${rest.length + 1} session files: ${candidates}`)
  }
  return match
}

// ── Fork ──────────────────────────────────────────────────────────────────────

/** Writes a fork of `parentPath` the way Pi's own fork writes one: a fresh
 * header under the target cwd's directory, then the parent's entries in file
 * order, so the fork inherits the whole tree including its name. Entries are
 * re-serialized from their parsed form, so key order survives while number
 * formatting and escapes normalize. */
export function writeForkFile(options: WriteForkFileOptions): ForkFile {
  const dirs = options.dirs
  const dir = dirs.mode === 'flat' ? dirs.dir : sessionDirForCwd(dirs.root, options.cwd)
  mkdirSync(dir, { recursive: true })

  const id = uuidv7()
  const timestamp = new Date().toISOString()
  const fileTimestamp = timestamp.replace(FILE_TIMESTAMP_UNSAFE, FILE_TIMESTAMP_REPLACEMENT)
  const path = join(dir, `${fileTimestamp}${SESSION_ID_SEPARATOR}${id}${SESSION_FILE_EXTENSION}`)
  const header = {
    type: SESSION_ENTRY_TYPE_HEADER,
    version: SESSION_FILE_VERSION,
    id,
    timestamp,
    cwd: resolve(options.cwd),
    parentSession: resolve(options.parentPath),
  }

  // One write: a per-entry append would hold the event loop, and with it every
  // other session's RPC traffic, for the length of a long parent.
  const body = options.entries
    .filter((entry) => entry.type !== SESSION_ENTRY_TYPE_HEADER)
    .map((entry) => serializeEntry(entry))
    .join('')
  writeFileSync(path, serializeEntry(header) + body, { encoding: FILE_ENCODING, flag: FORK_FILE_WRITE_FLAG })
  return { path, id }
}

/** The parent's entries up to its last settled turn. Pi appends the user entry as
 * a turn starts, so with a turn in flight everything from the last user message
 * on is that unfinished turn; this adapter is the only writer of its own live
 * sessions, so nothing else can have appended past it. The `system` entry Pi
 * writes just before that user entry stays, as in Pi's own fork. */
export function settledEntries(
  entries: readonly SessionFileEntry[],
  parentHasActiveTurn: boolean,
): readonly SessionFileEntry[] {
  if (!parentHasActiveTurn) return entries
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry !== undefined && isUserMessageEntry(entry)) return entries.slice(0, index)
  }
  return entries
}

/** True for `{ type: 'message', message: { role: 'user', content } }`. */
export function isUserMessageEntry(entry: SessionFileEntry): boolean {
  if (entry.type !== SESSION_ENTRY_TYPE_MESSAGE) return false
  const message = entry.message
  return isMessageWithContent(message) && message.role === ROLE_USER
}

// ── Breakpoint fork ───────────────────────────────────────────────────────────
//
// ACP names no message, so a client that wants to fork from an earlier prompt
// passes an id it minted itself. The sidecar remembers which Pi entry each id
// landed on, and the cut follows Pi's entry tree rather than file order: a
// session that has already been forked on the Pi side holds sibling branches
// whose entries sit between an ancestor and the named prompt.

/** `<stem>.acp.json` for `<stem>.jsonl`. Throws if `sessionPath` lacks the .jsonl suffix. */
export function messageMapPathFor(sessionPath: string): string {
  if (!sessionPath.endsWith(SESSION_FILE_EXTENSION)) {
    throw new Error(`Session path "${sessionPath}" does not end in ${SESSION_FILE_EXTENSION}`)
  }
  return `${sessionPath.slice(0, -SESSION_FILE_EXTENSION.length)}${MESSAGE_MAP_SUFFIX}`
}

/** ACP message id -> Pi entry id. `null` when the sidecar does not exist. A
 * malformed file or a version other than MESSAGE_MAP_VERSION throws (fail fast). */
export function readMessageMap(sidecarPath: string): Readonly<Record<string, string>> | null {
  if (!existsSync(sidecarPath)) return null

  const text = stripBom(readFileSync(sidecarPath, FILE_ENCODING))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Message map "${sidecarPath}" is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Message map "${sidecarPath}" is not a JSON object`)
  }

  const record = parsed as Record<string, unknown>
  const version = record[MESSAGE_MAP_KEY_VERSION]
  if (version !== MESSAGE_MAP_VERSION) {
    throw new Error(
      `Message map "${sidecarPath}" has ${MESSAGE_MAP_KEY_VERSION} ${String(version)}, expected ${MESSAGE_MAP_VERSION}`,
    )
  }

  const messages = record[MESSAGE_MAP_KEY_MESSAGES]
  if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
    throw new Error(`Message map "${sidecarPath}" has no ${MESSAGE_MAP_KEY_MESSAGES} object`)
  }
  for (const [messageId, entryId] of Object.entries(messages)) {
    if (typeof entryId !== 'string') {
      throw new Error(`Message map "${sidecarPath}" maps "${messageId}" to a non-string entry id`)
    }
  }
  return messages as Record<string, string>
}

/** Rewrites the whole sidecar in one sync write. Creates the parent dir if needed. */
export function writeMessageMap(sidecarPath: string, messages: Readonly<Record<string, string>>): void {
  mkdirSync(dirname(sidecarPath), { recursive: true })
  const body = JSON.stringify({ [MESSAGE_MAP_KEY_VERSION]: MESSAGE_MAP_VERSION, [MESSAGE_MAP_KEY_MESSAGES]: messages })
  writeFileSync(sidecarPath, `${body}${ENTRY_LINE_SEPARATOR}`, { encoding: FILE_ENCODING })
}

/** The cut for a breakpoint fork: the ancestors of `entryId` (its parent up to
 * the root) as the non-header entries in file order filtered to that set. The
 * last element is the named entry's parent, which Pi adopts as the leaf. Empty
 * when `entryId` is the root. Throws when `entryId` is not in `entries` or the
 * parent chain names an id the file does not hold (a programming error: the
 * caller checks presence and the user-message shape first). */
export function branchEntriesBefore(
  entries: readonly SessionFileEntry[],
  entryId: string,
): readonly SessionFileEntry[] {
  const nodes = entries.filter((entry) => entry.type !== SESSION_ENTRY_TYPE_HEADER)
  const byId = new Map<string, SessionFileEntry>()
  for (const entry of nodes) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }

  const named = byId.get(entryId)
  if (named === undefined) throw new Error(`Session entry "${entryId}" is not in the session file`)

  const ancestors = new Set<string>()
  let parentId = named.parentId
  while (typeof parentId === 'string') {
    if (ancestors.has(parentId)) throw new Error(`Session entry "${entryId}" has a cyclic parent chain at "${parentId}"`)
    const parent = byId.get(parentId)
    if (parent === undefined) {
      throw new Error(`Session entry "${entryId}" names parent "${parentId}", which is not in the session file`)
    }
    ancestors.add(parentId)
    parentId = parent.parentId
  }

  return nodes.filter((entry) => typeof entry.id === 'string' && ancestors.has(entry.id))
}

function serializeEntry(entry: unknown): string {
  return `${JSON.stringify(entry)}${ENTRY_LINE_SEPARATOR}`
}

function sessionCwdMatches(headerCwd: string, cwd: string): boolean {
  return headerCwd !== '' && resolve(headerCwd) === resolve(cwd)
}

/** Pi drops a file it cannot read from the list rather than failing the list. */
async function readSessionInfoOrNull(filePath: string): Promise<SessionFileInfo | null> {
  try {
    return await readSessionInfo(filePath)
  } catch {
    return null
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const pending = items.entries()
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) {
      results[index] = await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
