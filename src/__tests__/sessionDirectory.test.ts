import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_PI_AGENT_DIR_SEGMENTS,
  ENV_PI_AGENT_DIR,
  ENV_PI_SESSION_DIR,
  PI_SESSIONS_DIR_NAME,
  PI_SETTINGS_FILE_NAME,
} from '../constants.js'
import type { SessionDirs } from '../session/sessionDirectory.js'
import {
  findSessionFile,
  listSessions,
  readSessionInfo,
  resolveSessionDirs,
  sessionDirForCwd,
} from '../session/sessionDirectory.js'

const TEMP_PREFIX = 'pi-acp-session-dir-'
const HEADER_TIME = '2026-01-01T00:00:00.000Z'
const FILE_TIMESTAMP = '2026-01-01T00-00-00-000Z'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── Fixtures (Pi's documented session file format) ────────────────────────────

/** `null` omits the field; `undefined` would collapse into the default. */
function header(id: string, cwd?: string, timestamp: string | null = HEADER_TIME): unknown {
  return {
    type: 'session',
    version: 3,
    id,
    ...(timestamp === null ? {} : { timestamp }),
    ...(cwd === undefined ? {} : { cwd }),
  }
}

function sessionInfo(name: string | undefined): unknown {
  return { type: 'session_info', id: 'info', parentId: null, timestamp: HEADER_TIME, ...(name === undefined ? {} : { name }) }
}

function message(role: string, content: unknown, timestamps: { message?: number; entry?: string } = {}): unknown {
  return {
    type: 'message',
    id: 'entry',
    parentId: null,
    timestamp: timestamps.entry ?? HEADER_TIME,
    message: { role, content, ...(timestamps.message === undefined ? {} : { timestamp: timestamps.message }) },
  }
}

/** Raw strings are written verbatim so malformed lines can be exercised. */
function writeSession(dir: string, id: string, lines: readonly unknown[], trailingNewline = true): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${FILE_TIMESTAMP}_${id}.jsonl`)
  const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
  writeFileSync(path, trailingNewline ? `${body}\n` : body)
  return path
}

function perCwd(sessionsRoot: string): SessionDirs {
  return { mode: 'perCwd', root: sessionsRoot }
}

function flat(dir: string): SessionDirs {
  return { mode: 'flat', dir }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sessionDirForCwd', () => {
  it('encodes a unix cwd', () => {
    expect(sessionDirForCwd('/store', '/home/user/project')).toBe('/store/--home-user-project--')
  })

  it('encodes a windows cwd, replacing the drive colon and every backslash', () => {
    expect(sessionDirForCwd('/store', 'C:\\Users\\dev\\app')).toBe('/store/--C--Users-dev-app--')
  })
})

describe('resolveSessionDirs', () => {
  it('defaults to <home>/.pi/agent/sessions', () => {
    expect(resolveSessionDirs({}, root)).toEqual(perCwd(join(root, ...DEFAULT_PI_AGENT_DIR_SEGMENTS, PI_SESSIONS_DIR_NAME)))
  })

  it('honors PI_CODING_AGENT_DIR, expanding a tilde', () => {
    expect(resolveSessionDirs({ [ENV_PI_AGENT_DIR]: join(root, 'agent') }, root)).toEqual(
      perCwd(join(root, 'agent', PI_SESSIONS_DIR_NAME)),
    )
    expect(resolveSessionDirs({ [ENV_PI_AGENT_DIR]: '~/agent' }, root)).toEqual(perCwd(join(root, 'agent', PI_SESSIONS_DIR_NAME)))
  })

  it('treats PI_CODING_AGENT_SESSION_DIR as one flat directory', () => {
    expect(resolveSessionDirs({ [ENV_PI_SESSION_DIR]: '~/all-sessions' }, root)).toEqual(flat(join(root, 'all-sessions')))
  })

  it('falls back to the settings.json sessionDir, and the env var wins over it', () => {
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, PI_SETTINGS_FILE_NAME), JSON.stringify({ sessionDir: '~/from-settings' }))

    const env = { [ENV_PI_AGENT_DIR]: agentDir }
    expect(resolveSessionDirs(env, root)).toEqual(flat(join(root, 'from-settings')))
    expect(resolveSessionDirs({ ...env, [ENV_PI_SESSION_DIR]: join(root, 'from-env') }, root)).toEqual(
      flat(join(root, 'from-env')),
    )
  })

  it('ignores a malformed or non-string sessionDir the way Pi ignores unreadable settings', () => {
    const agentDir = join(root, 'agent')
    const sessionsRoot = join(agentDir, PI_SESSIONS_DIR_NAME)
    const settingsPath = join(agentDir, PI_SETTINGS_FILE_NAME)
    mkdirSync(agentDir, { recursive: true })
    const env = { [ENV_PI_AGENT_DIR]: agentDir }

    writeFileSync(settingsPath, '{ not json')
    expect(resolveSessionDirs(env, root)).toEqual(perCwd(sessionsRoot))

    writeFileSync(settingsPath, JSON.stringify({ sessionDir: 42 }))
    expect(resolveSessionDirs(env, root)).toEqual(perCwd(sessionsRoot))

    writeFileSync(settingsPath, JSON.stringify({ sessionDir: '' }))
    expect(resolveSessionDirs(env, root)).toEqual(perCwd(sessionsRoot))
  })
})

describe('readSessionInfo', () => {
  it('takes the name from the latest session_info entry, and an empty name clears it', async () => {
    const named = writeSession(root, 'named', [header('named', '/w'), sessionInfo('first'), sessionInfo('second')])
    const cleared = writeSession(root, 'cleared', [header('cleared', '/w'), sessionInfo('first'), sessionInfo('   ')])
    // Pi reads `entry.name?.trim() || undefined`, so a nameless entry clears too.
    const nameless = writeSession(root, 'nameless', [header('nameless', '/w'), sessionInfo('first'), sessionInfo(undefined)])

    expect((await readSessionInfo(named))?.name).toBe('second')
    expect((await readSessionInfo(cleared))?.name).toBeUndefined()
    expect((await readSessionInfo(nameless))?.name).toBeUndefined()
  })

  it('takes firstMessage from the first user message, joining its text blocks', async () => {
    const path = writeSession(root, 'first', [
      header('first', '/w'),
      message('assistant', [{ type: 'text', text: 'assistant first' }]),
      message('user', [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
        { type: 'text', text: 'world' },
      ]),
      message('user', 'later'),
    ])

    expect((await readSessionInfo(path))?.firstMessage).toBe('hello world')
  })

  it('leaves firstMessage undefined with no user text (no placeholder)', async () => {
    const path = writeSession(root, 'empty', [header('empty', '/w'), message('assistant', 'hi')])
    expect((await readSessionInfo(path))?.firstMessage).toBeUndefined()
  })

  it('skips malformed and blank lines', async () => {
    const path = writeSession(root, 'malformed', [
      header('malformed', '/w'),
      '{ broken',
      '',
      sessionInfo('kept'),
      'null',
      message('user', 'hi'),
    ])

    const info = await readSessionInfo(path)
    expect(info?.name).toBe('kept')
    expect(info?.firstMessage).toBe('hi')
  })

  it('returns null when the first parsed entry is not a session header with a string id', async () => {
    const noHeader = writeSession(root, 'noheader', [message('user', 'hi'), header('noheader', '/w')])
    const badId = writeSession(root, 'badid', [{ type: 'session', version: 3, id: 7, cwd: '/w' }])
    const empty = writeSession(root, 'blank', [''])

    expect(await readSessionInfo(noHeader)).toBeNull()
    expect(await readSessionInfo(badId)).toBeNull()
    expect(await readSessionInfo(empty)).toBeNull()
  })

  it('prefers the latest message activity, then the header timestamp, then the file mtime', async () => {
    const activity = writeSession(root, 'activity', [
      header('activity', '/w'),
      message('user', 'a', { message: 2_000 }),
      message('assistant', 'b', { message: 5_000 }),
      message('user', 'c', { message: 3_000 }),
    ])
    expect((await readSessionInfo(activity))?.modified.getTime()).toBe(5_000)

    // A message with no numeric timestamp falls back to its entry timestamp.
    const entryTime = '2026-02-02T02:02:02.000Z'
    const fromEntry = writeSession(root, 'entrytime', [header('entrytime', '/w'), message('user', 'a', { entry: entryTime })])
    expect((await readSessionInfo(fromEntry))?.modified.toISOString()).toBe(entryTime)

    // toolResult is neither user nor assistant, so it contributes no activity.
    const headerOnly = writeSession(root, 'headeronly', [
      header('headeronly', '/w'),
      message('toolResult', 'output', { message: 9_000 }),
    ])
    expect((await readSessionInfo(headerOnly))?.modified.toISOString()).toBe(HEADER_TIME)

    const mtime = new Date('2026-03-04T05:06:07.000Z')
    const noTimes = writeSession(root, 'notimes', [header('notimes', '/w', null)])
    utimesSync(noTimes, mtime, mtime)
    expect((await readSessionInfo(noTimes))?.modified.getTime()).toBe(mtime.getTime())
  })

  // Pi's own reader appends the missing newline as it reads; the adapter never writes.
  it('reads a file missing its trailing newline and leaves it byte-identical', async () => {
    const cwd = '/workspace/unterminated'
    const dir = join(root, 'flat')
    const path = writeSession(dir, 'unterminated', [header('unterminated', cwd), message('user', 'hi')], false)
    const before = readFileSync(path)

    expect((await readSessionInfo(path))?.firstMessage).toBe('hi')
    expect((await listSessions({ dirs: flat(dir), cwd })).map((session) => session.id)).toEqual(['unterminated'])
    expect(readFileSync(path).equals(before)).toBe(true)
  })
})

describe('listSessions', () => {
  it('filters a lossy directory-name collision on the header cwd', async () => {
    const dashed = '/workspace/beta-gamma'
    const nested = '/workspace/beta/gamma'
    const dir = sessionDirForCwd(root, nested)
    expect(sessionDirForCwd(root, dashed)).toBe(dir)

    writeSession(dir, 'dashed', [header('dashed', dashed)])
    writeSession(dir, 'nested', [header('nested', nested)])

    const sessions = await listSessions({ dirs: perCwd(root), cwd: nested })
    expect(sessions.map((session) => session.id)).toEqual(['nested'])
  })

  it('sorts by modified descending across every per-cwd directory when no cwd is given', async () => {
    const alpha = '/workspace/alpha'
    const beta = '/workspace/beta'
    writeSession(sessionDirForCwd(root, alpha), 'old', [header('old', alpha), message('user', 'a', { message: 1_000 })])
    writeSession(sessionDirForCwd(root, alpha), 'new', [header('new', alpha), message('user', 'b', { message: 9_000 })])
    writeSession(sessionDirForCwd(root, beta), 'mid', [header('mid', beta), message('user', 'c', { message: 5_000 })])

    const sessions = await listSessions({ dirs: perCwd(root) })
    expect(sessions.map((session) => session.id)).toEqual(['new', 'mid', 'old'])
  })

  it('loads more files than the concurrency cap', async () => {
    const cwd = '/workspace/many'
    const dir = sessionDirForCwd(root, cwd)
    const count = 25
    for (let index = 0; index < count; index++) {
      writeSession(dir, `s${index}`, [header(`s${index}`, cwd), message('user', 'x', { message: index + 1 })])
    }

    const sessions = await listSessions({ dirs: perCwd(root), cwd })
    expect(sessions).toHaveLength(count)
    expect(sessions[0]?.id).toBe(`s${count - 1}`)
  })

  it('scans a flat directory and filters it by header cwd, never matching a cwd-less header', async () => {
    const dir = join(root, 'all')
    const mine = '/workspace/mine'
    writeSession(dir, 'mine', [header('mine', mine)])
    writeSession(dir, 'other', [header('other', '/workspace/other')])
    writeSession(dir, 'cwdless', [header('cwdless', undefined)])

    expect((await listSessions({ dirs: flat(dir) })).map((session) => session.id).sort()).toEqual([
      'cwdless',
      'mine',
      'other',
    ])
    expect((await listSessions({ dirs: flat(dir), cwd: mine })).map((session) => session.id)).toEqual(['mine'])
    expect(await listSessions({ dirs: flat(dir), cwd: process.cwd() })).toEqual([])
  })

  it('follows a symlinked per-cwd directory', async () => {
    const sessionsRoot = join(root, PI_SESSIONS_DIR_NAME)
    const cwd = '/workspace/linked'
    const target = join(root, 'elsewhere')
    writeSession(target, 'linked', [header('linked', cwd)])
    mkdirSync(sessionsRoot, { recursive: true })
    symlinkSync(target, sessionDirForCwd(sessionsRoot, cwd))

    expect((await listSessions({ dirs: perCwd(sessionsRoot) })).map((session) => session.id)).toEqual(['linked'])
  })

  it('skips header-less files and returns nothing for a missing directory', async () => {
    const cwd = '/workspace/skips'
    const dir = sessionDirForCwd(root, cwd)
    writeSession(dir, 'good', [header('good', cwd)])
    writeSession(dir, 'headerless', [message('user', 'orphan')])

    expect((await listSessions({ dirs: perCwd(root), cwd })).map((session) => session.id)).toEqual(['good'])
    expect(await listSessions({ dirs: perCwd(join(root, 'absent')) })).toEqual([])
    expect(await listSessions({ dirs: flat(join(root, 'absent')), cwd })).toEqual([])
  })
})

describe('findSessionFile', () => {
  it('matches the whole id suffix, so an id containing underscores resolves', async () => {
    const cwd = '/workspace/ids'
    const dir = sessionDirForCwd(root, cwd)
    const path = writeSession(dir, 'my_session_id', [header('my_session_id', cwd)])
    writeSession(dir, 'session_id', [header('session_id', cwd)])

    expect(await findSessionFile({ dirs: perCwd(root), id: 'my_session_id', cwd })).toBe(path)
    expect(await findSessionFile({ dirs: perCwd(root), id: 'my_session_id' })).toBe(path)
    expect(await findSessionFile({ dirs: perCwd(root), id: 'absent', cwd })).toBeNull()
  })

  it('throws listing every candidate when one id matches files in two directories', async () => {
    const first = '/workspace/first'
    const second = '/workspace/second'
    const firstPath = writeSession(sessionDirForCwd(root, first), 'dup', [header('dup', first)])
    const secondPath = writeSession(sessionDirForCwd(root, second), 'dup', [header('dup', second)])

    await expect(findSessionFile({ dirs: perCwd(root), id: 'dup' })).rejects.toThrow(/matches 2 session files/)
    const error = await findSessionFile({ dirs: perCwd(root), id: 'dup' }).catch((thrown: Error) => thrown)
    expect(String(error)).toContain(firstPath)
    expect(String(error)).toContain(secondPath)

    // A cwd narrows the scan to one directory, so the same id is unambiguous.
    expect(await findSessionFile({ dirs: perCwd(root), id: 'dup', cwd: first })).toBe(firstPath)
  })
})
