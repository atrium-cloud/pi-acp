/**
 * Live-Pi origin overrides: with `PI_ACP_ORIGIN_OVERRIDES` naming a provider's
 * host, each model's requests reach a stand-in local listener on that model's
 * own vendor path, carrying that wire's own auth header.
 *
 * Hermetic, unlike the rest of the tier: a scratch Pi agent dir and an obviously
 * fake key, so no provider is contacted and no tokens are spent. Each turn fails
 * on the listener's answer; only what the listener received is asserted.
 * Skipped unless RUN_PI_E2E=true (see e2eGate.ts).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { CONFIG_ID_MODEL, ENV_ORIGIN_OVERRIDES, ENV_PI_AGENT_DIR } from '../../constants.js'
import { describeE2E, E2E_SETUP_TIMEOUT_MS, E2E_TURN_TIMEOUT_MS, modelValue } from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createSpawnedAgent } from './spawnedAgentFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const OVERRIDDEN_HOST = 'opencode.ai'
const PROVIDER = 'opencode-go'
const PROVIDER_KEY_ENV = 'OPENCODE_API_KEY'
const FAKE_KEY = 'pi-acp-e2e-not-a-real-key'

/** One model per wire, both served from the overridden host under different paths. */
const CHAT_MODEL = 'deepseek-v4.1-flash'
const ANTHROPIC_MODEL = 'claude-haiku-5-5'
const CHAT_PATH_SUFFIX = '/v1/chat/completions'
const ANTHROPIC_PATH_SUFFIX = '/v1/messages'
/** What a provider-wide base URL override made of the Anthropic path. */
const DOUBLED_VERSION_SEGMENT = '/v1/v1/'

const LOOPBACK_HOST = '127.0.0.1'
const LISTENER_URL_BASE = `http://${LOOPBACK_HOST}`
/** Distinctive and outside every SDK's retry set, so each turn fails at once. */
const LISTENER_STATUS = 418
const LISTENER_BODY = JSON.stringify({ error: { message: 'pi-acp e2e stand-in listener' } })
const POST = 'POST'
const AGENT_DIR_PREFIX = 'pi-acp-e2e-agent-'
const PROMPT = 'Reply with the word ready.'

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

async function startListener(): Promise<Listener> {
  const received: ReceivedRequest[] = []
  const server: Server = createServer((request, response) => {
    received.push({
      method: request.method ?? '',
      pathname: new URL(request.url ?? '/', LISTENER_URL_BASE).pathname,
      headers: request.headers,
    })
    request.resume()
    response.writeHead(LISTENER_STATUS, { 'content-type': 'application/json' })
    response.end(LISTENER_BODY)
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

describeE2E('pi origin overrides', () => {
  // Nullable so a failed boot leaves the teardown with something to check.
  let listener: Listener | null = null
  let agent: SpawnedAgent | null = null
  let agentDir: string | null = null

  beforeAll(async () => {
    listener = await startListener()
    agentDir = mkdtempSync(join(tmpdir(), AGENT_DIR_PREFIX))
    agent = await createSpawnedAgent({
      env: {
        [ENV_PI_AGENT_DIR]: agentDir,
        [PROVIDER_KEY_ENV]: FAKE_KEY,
        [ENV_ORIGIN_OVERRIDES]: `${OVERRIDDEN_HOST}=${listener.origin}`,
      },
    })
  }, E2E_SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await agent?.stop()
    await listener?.close()
    if (agentDir !== null) rmSync(agentDir, { recursive: true, force: true })
  }, E2E_SETUP_TIMEOUT_MS)

  it(
    'sends a chat-wire and an Anthropic-wire model to the override origin on their own vendor paths',
    async () => {
      if (agent === null || listener === null) throw new Error('e2e: the adapter for this file never booted')
      const created = await agent.agent.request(acp.methods.agent.session.new, { cwd: agent.workspace, mcpServers: [] })

      for (const model of [CHAT_MODEL, ANTHROPIC_MODEL]) {
        await agent.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: created.sessionId,
          configId: CONFIG_ID_MODEL,
          value: modelValue(created.configOptions, PROVIDER, model),
        })
        await expect(
          agent.agent.request(acp.methods.agent.session.prompt, {
            sessionId: created.sessionId,
            prompt: [{ type: 'text', text: PROMPT }],
          }),
        ).rejects.toThrow()
      }

      const posts = listener.received.filter((request) => request.method === POST)
      const chat = posts.find((request) => request.pathname.endsWith(CHAT_PATH_SUFFIX))
      const anthropic = posts.find((request) => request.pathname.endsWith(ANTHROPIC_PATH_SUFFIX))
      expect(chat?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
      expect(anthropic?.headers['x-api-key']).toBe(FAKE_KEY)
      expect(posts.filter((request) => request.pathname.includes(DOUBLED_VERSION_SEGMENT))).toEqual([])
    },
    2 * E2E_TURN_TIMEOUT_MS,
  )
})
