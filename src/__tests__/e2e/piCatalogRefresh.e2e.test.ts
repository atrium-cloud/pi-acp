/**
 * Live-Pi catalog refresh: the adapter's own refresh Pi stores exactly the
 * models the key may use, and a session's own startup refresh reads them from
 * the override origin rather than the vendor host.
 *
 * Hermetic, like the origin overrides case: the adapter inherits no host
 * environment (`hermeticHome`), so its only credential is an obviously fake key,
 * and a stand-in listener takes OpenRouter and Pi's catalog host through
 * `PI_ACP_ORIGIN_OVERRIDES`. Any other request goes to a proxy on a closed
 * loopback port and fails there. Skipped unless RUN_PI_E2E=true (see e2eGate.ts).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  CATALOG_REFRESH_STARTUP_DELAY_MS,
  CONFIG_ID_MODEL,
  ENV_ORIGIN_OVERRIDES,
  ENV_PI_AGENT_DIR,
  MODEL_VALUE_SEPARATOR,
} from '../../constants.js'
import { describeE2E, E2E_SETUP_TIMEOUT_MS } from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createSpawnedAgent } from './spawnedAgentFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER = 'openrouter'
const PROVIDER_HOST = 'openrouter.ai'
const CATALOG_HOST = 'pi.dev'
const PROVIDER_KEY_ENV = 'OPENROUTER_API_KEY'
const FAKE_KEY = 'pi-acp-e2e-not-a-real-key'

/** Two of Pi's built-in OpenRouter models: personalization keeps only built-in ids. */
const KEY_MODELS: readonly string[] = ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash']
const USER_MODELS_PATH = '/api/v1/models/user'
const CATALOG_PATH_PREFIX = '/api/models/providers/'
const USER_MODELS_BODY = JSON.stringify({ data: KEY_MODELS.map((id) => ({ id })) })
/** Pi's own answer for a provider with no newer catalog; Pi then keeps its built-in one. */
const NO_CATALOG_STATUS = 404
const UNEXPECTED_STATUS = 418
const OK_STATUS = 200
const GET = 'GET'

const MODELS_STORE_FILE = 'models-store.json'
const CHAT_MODEL_TYPE = 'chat'
const LOOPBACK_HOST = '127.0.0.1'
const LISTENER_URL_BASE = `http://${LOOPBACK_HOST}`
const AGENT_DIR_PREFIX = 'pi-acp-e2e-agent-'
const POLL_INTERVAL_MS = 500
/** The refresher's first run plus a Pi cold start and its refresh. */
const REFRESH_WAIT_MS = CATALOG_REFRESH_STARTUP_DELAY_MS + E2E_SETUP_TIMEOUT_MS
/** Inside the refresher's startup delay, so only a session's own Pi can have read the list. */
const SESSION_REFRESH_WAIT_MS = CATALOG_REFRESH_STARTUP_DELAY_MS / 2

interface ReceivedRequest {
  readonly method: string
  readonly pathname: string
  readonly headers: IncomingHttpHeaders
}

interface Listener {
  readonly origin: string
  readonly received: readonly ReceivedRequest[]
  close(): Promise<void>
}

interface StoredModel {
  readonly id: string
  readonly type?: string
}

async function startListener(): Promise<Listener> {
  const received: ReceivedRequest[] = []
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', LISTENER_URL_BASE).pathname
    received.push({ method: request.method ?? '', pathname, headers: request.headers })
    request.resume()
    if (pathname === USER_MODELS_PATH) {
      response.writeHead(OK_STATUS, { 'content-type': 'application/json' })
      response.end(USER_MODELS_BODY)
      return
    }
    response.writeHead(pathname.startsWith(CATALOG_PATH_PREFIX) ? NO_CATALOG_STATUS : UNEXPECTED_STATUS)
    response.end()
  })
  await new Promise<void>((resolveListen) => {
    server.listen(0, LOOPBACK_HOST, resolveListen)
  })
  const { port } = server.address() as AddressInfo
  return {
    origin: `${LISTENER_URL_BASE}:${port}`,
    received,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
      }),
  }
}

function userModelReads(listener: Listener): ReceivedRequest[] {
  return listener.received.filter((request) => request.method === GET && request.pathname === USER_MODELS_PATH)
}

/** The provider's chat model ids in Pi's saved catalog; throws until Pi has saved one. */
function storedChatModelIds(agentDir: string): string[] {
  const store = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), 'utf8')) as Record<
    string,
    { readonly checkedAt?: number; readonly models: readonly StoredModel[] } | undefined
  >
  const entry = store[PROVIDER]
  if (entry?.checkedAt === undefined) throw new Error(`no ${PROVIDER} entry saved yet`)
  return entry.models
    .filter((model) => model.type === undefined || model.type === CHAT_MODEL_TYPE)
    .map((model) => model.id)
    .sort()
}

/** The provider's model ids a session offers, with any disambiguating prefix dropped. */
function offeredModelIds(configOptions: readonly SessionConfigOption[] | null | undefined): string[] {
  const select = configOptions?.find((option) => option.id === CONFIG_ID_MODEL)
  if (select?.type !== 'select') throw new Error('model config option missing from session response')
  const prefix = `${PROVIDER}${MODEL_VALUE_SEPARATOR}`
  return select.options
    .flatMap((entry) => ('options' in entry && entry.group === PROVIDER ? entry.options : []))
    .map((option) => (option.value.startsWith(prefix) ? option.value.slice(prefix.length) : option.value))
    .sort()
}

describeE2E('pi catalog refresh', () => {
  // Nullable so a failed boot leaves the teardown with something to check.
  let listener: Listener | null = null
  let agent: SpawnedAgent | null = null
  let agentDir: string | null = null

  beforeEach(async () => {
    listener = await startListener()
    agentDir = mkdtempSync(join(tmpdir(), AGENT_DIR_PREFIX))
    agent = await createSpawnedAgent({
      // The scratch agent dir doubles as the home, so no credential file under the real home is read.
      hermeticHome: agentDir,
      env: {
        [ENV_PI_AGENT_DIR]: agentDir,
        [PROVIDER_KEY_ENV]: FAKE_KEY,
        [ENV_ORIGIN_OVERRIDES]: `${PROVIDER_HOST}=${listener.origin},${CATALOG_HOST}=${listener.origin}`,
      },
    })
  }, E2E_SETUP_TIMEOUT_MS)

  afterEach(async () => {
    await agent?.stop()
    await listener?.close()
    if (agentDir !== null) rmSync(agentDir, { recursive: true, force: true })
    agent = null
    listener = null
    agentDir = null
  }, E2E_SETUP_TIMEOUT_MS)

  it(
    "saves only the key's models a minute after start, and the next session/new offers only those",
    async () => {
      if (agent === null || listener === null || agentDir === null) throw new Error('e2e: the adapter never booted')
      const dir = agentDir

      // No session first: the refresher's Pi is the only one that can save the list.
      const stored = await vi.waitFor(() => storedChatModelIds(dir), { timeout: REFRESH_WAIT_MS, interval: POLL_INTERVAL_MS })
      expect(stored).toEqual([...KEY_MODELS].sort())
      expect(userModelReads(listener).map((request) => request.headers.authorization)).toEqual([`Bearer ${FAKE_KEY}`])

      const created = await agent.agent.request(acp.methods.agent.session.new, { cwd: agent.workspace, mcpServers: [] })
      expect(offeredModelIds(created.configOptions)).toEqual([...KEY_MODELS].sort())
    },
    REFRESH_WAIT_MS + E2E_SETUP_TIMEOUT_MS,
  )

  it(
    "sends a session's own startup read of the key's models to the override origin",
    async () => {
      if (agent === null || listener === null) throw new Error('e2e: the adapter never booted')
      const serving = listener

      await agent.agent.request(acp.methods.agent.session.new, { cwd: agent.workspace, mcpServers: [] })

      // Only this read is asserted: Pi's catalog fetch can start before `session_start` wraps the dispatcher.
      const reads = await vi.waitFor(
        () => {
          const found = userModelReads(serving)
          if (found.length === 0) throw new Error('no models/user read has reached the listener yet')
          return found
        },
        { timeout: SESSION_REFRESH_WAIT_MS, interval: POLL_INTERVAL_MS },
      )
      expect(reads[0]?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    },
    E2E_SETUP_TIMEOUT_MS,
  )
})
