/**
 * Live-Pi idle teardown: a session idle past the timeout has its Pi subprocess
 * stopped, and the next request relaunches it on the same session. Its own
 * adapter boot, since the timeout is an adapter-wide setting. A relaunch logs a
 * `wake` startup timing line, which is how each case knows one happened.
 * Skipped unless RUN_PI_E2E=true (see e2eGate.ts).
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as acp from '@agentclientprotocol/sdk'
import type { McpServer, PromptResponse, RequestPermissionResponse, SessionConfigOption } from '@agentclientprotocol/sdk'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

import {
  AGENT_NAME,
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  ENV_IDLE_TIMEOUT_MS,
  ENV_PI_TIMING,
  MCP_TOOL_PREFIX,
  MCP_TOOL_SEPARATOR,
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PI_TIMING_ON,
} from '../../constants.js'
import { describeE2E, E2E_SETUP_TIMEOUT_MS, E2E_TURN_TIMEOUT_MS, pinnedModelValue } from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createSpawnedAgent, openPinnedSession } from './spawnedAgentFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Long enough that a slow round trip between a case's setup requests does not stop the session early. */
const IDLE_TIMEOUT_MS = 4_000
/** A wake awaits the stop, so the wait only has to pass the timeout; the margin covers timer lag. */
const IDLE_WAIT_MARGIN_MS = 1_000
const IDLE_WAIT_MS = IDLE_TIMEOUT_MS + IDLE_WAIT_MARGIN_MS

const TOOL_MARKER = 'pi-e2e-idle-tool'
const SECOND_TOOL_MARKER = 'pi-e2e-idle-tool-again'
const toolPrompt = (marker: string): string => `Use your bash tool to run \`echo ${marker}\` and tell me the output.`
const ECHO_MARKER = 'pi-e2e-idle-ok'
const ECHO_PROMPT = `Reply with exactly ${ECHO_MARKER} and nothing else.`
/** No line break, so Pi stores it as sent. */
const SESSION_NAME = 'pi-e2e-idle-named'

/** The bundled probe server (also driven by piExtensions.e2e.test.ts). */
const MCP_SERVER_NAME = 'probe'
const MCP_SHAPE_TOOL = `${MCP_TOOL_PREFIX}${MCP_SERVER_NAME}${MCP_TOOL_SEPARATOR}shape`
const MCP_MARKER = 'pi-e2e-idle-mcp'
const MCP_PROMPT = `Use the ${MCP_SHAPE_TOOL} tool with the payload {"a": "${MCP_MARKER}"} and tell me exactly what it returned.`
const PROBE_SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp-probe-server.mjs')
const NODE_COMMAND = 'node'

/** Only the session id and mode are read: the stderr scrub may rewrite the rest. */
const TIMING_LINE = new RegExp(`^\\[${AGENT_NAME}\\] \\[([^\\]]+)\\] startup timing \\{"mode":"(\\w+)"`)
const WAKE_MODE = 'wake'
/** stderr is its own pipe, so the line can trail the response it was logged before. */
const WAKE_LINE_WAIT_MS = 10_000
/** Room for a `config_option_update` sent ahead of a response to be dispatched
 * after it. Kept below the timeout so `expectPiKept` ends before the session can
 * stop again: a session-bound request added after the check would otherwise find
 * it stopped and wake it a second time. */
const LEVEL_ECHO_SETTLE_MS = IDLE_TIMEOUT_MS / 2
const POLL_INTERVAL_MS = 50

/** The idle wait, the wake's cold start inside the waking request, and the checks after it. */
const WAKE_CASE_OVERHEAD_MS = IDLE_WAIT_MS + E2E_SETUP_TIMEOUT_MS + LEVEL_ECHO_SETTLE_MS + WAKE_LINE_WAIT_MS
const ONE_TURN_CASE_TIMEOUT_MS = WAKE_CASE_OVERHEAD_MS + E2E_TURN_TIMEOUT_MS
const TWO_TURN_CASE_TIMEOUT_MS = WAKE_CASE_OVERHEAD_MS + 2 * E2E_TURN_TIMEOUT_MS

interface TimingLine {
  readonly sessionId: string
  readonly mode: string
}

/** A pinned session moved off the model's default thinking level, so a Pi that
 * came back on its defaults would show. */
interface LeveledSession {
  readonly sessionId: string
  /** The pinned model's option value, as the session reports it. */
  readonly model: string
  readonly level: string
}

describeE2E('pi live idle teardown', () => {
  let agent: SpawnedAgent | null = null

  beforeAll(async () => {
    agent = await createSpawnedAgent({
      env: { [ENV_IDLE_TIMEOUT_MS]: String(IDLE_TIMEOUT_MS), [ENV_PI_TIMING]: PI_TIMING_ON },
    })
  }, E2E_SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await agent?.stop()
  }, E2E_SETUP_TIMEOUT_MS)

  afterEach(() => {
    agent?.answerPermissions(null)
  })

  function live(): SpawnedAgent {
    if (agent === null) throw new Error('e2e: the adapter for this file never booted')
    return agent
  }

  async function promptText(sessionId: string, text: string): Promise<PromptResponse> {
    return await live().agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    })
  }

  async function setConfig(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const response = await live().agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    })
    return response.configOptions
  }

  async function openLeveledSession(): Promise<LeveledSession> {
    const agent = live()
    const created = await agent.agent.request(acp.methods.agent.session.new, { cwd: agent.workspace, mcpServers: [] })
    // Levels are per model, so the level choice comes from the pin's response.
    const pinned = await setConfig(created.sessionId, CONFIG_ID_MODEL, pinnedModelValue(created.configOptions))
    const level = otherThoughtLevel(pinned)
    const switched = await setConfig(created.sessionId, CONFIG_ID_THOUGHT_LEVEL, level)
    expect(selectOption(switched, CONFIG_ID_THOUGHT_LEVEL).currentValue).toBe(level)
    return { sessionId: created.sessionId, model: selectOption(pinned, CONFIG_ID_MODEL).currentValue, level }
  }

  /** Pi files a session at its first user message, so this tells which target a wake takes. */
  async function isFiled(sessionId: string): Promise<boolean> {
    const agent = live()
    const listed = await agent.agent.request(acp.methods.agent.session.list, { cwd: agent.workspace })
    return listed.sessions.some((entry) => entry.sessionId === sessionId)
  }

  function wakeCount(sessionId: string): number {
    return timingLines(live()).filter((line) => line.sessionId === sessionId && line.mode === WAKE_MODE).length
  }

  /** Waits past the idle timeout, checking that nothing has woken the session yet. */
  async function goIdle(sessionId: string): Promise<void> {
    await new Promise((settle) => setTimeout(settle, IDLE_WAIT_MS))
    expect(wakeCount(sessionId)).toBe(0)
  }

  async function expectWokenOnce(sessionId: string): Promise<void> {
    await vi.waitFor(
      () => {
        expect(wakeCount(sessionId)).toBe(1)
      },
      { timeout: WAKE_LINE_WAIT_MS, interval: POLL_INTERVAL_MS },
    )
  }

  /** Checks the woken Pi itself, sent straight after the waking request so no
   * second stop intervenes. A level set is answered from Pi's own `get_state`,
   * so the model in the response is the woken Pi's. Pi announces a level change
   * only when the level moves, so no `config_option_update` after re-setting the
   * same level means Pi already held it. */
  async function expectPiKept(session: LeveledSession): Promise<void> {
    const updatesBefore = configUpdateCount(session.sessionId)
    const options = await setConfig(session.sessionId, CONFIG_ID_THOUGHT_LEVEL, session.level)
    expect(selectOption(options, CONFIG_ID_MODEL).currentValue).toBe(session.model)
    expect(selectOption(options, CONFIG_ID_THOUGHT_LEVEL).currentValue).toBe(session.level)
    await new Promise((settle) => setTimeout(settle, LEVEL_ECHO_SETTLE_MS))
    expect(configUpdateCount(session.sessionId)).toBe(updatesBefore)
  }

  function configUpdateCount(sessionId: string): number {
    return live()
      .sessionUpdates(sessionId)
      .filter((update) => update.sessionUpdate === 'config_option_update').length
  }

  function answerWith(optionId: string): RequestPermissionResponse {
    return { outcome: { outcome: 'selected', optionId } }
  }

  function permissionRequestCount(sessionId: string): number {
    return live().permissionRequests.filter((request) => request.sessionId === sessionId).length
  }

  function completedToolUpdates(sessionId: string): string[] {
    return live()
      .sessionUpdates(sessionId)
      .filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
      .map((update) => JSON.stringify(update))
  }

  it(
    'wakes a filed session with its model, thinking level and allow_always grant',
    async () => {
      const agent = live()
      const session = await openLeveledSession()
      agent.answerPermissions(() => answerWith(PERMISSION_OPTION_ALLOW_ALWAYS))
      await promptText(session.sessionId, toolPrompt(TOOL_MARKER))
      const askedOnce = permissionRequestCount(session.sessionId)
      expect(askedOnce).toBeGreaterThan(0)
      expect(await isFiled(session.sessionId)).toBe(true)
      // Fail closed from here: the second tool runs only on the kept grant.
      agent.answerPermissions(null)

      await goIdle(session.sessionId)
      await promptText(session.sessionId, toolPrompt(SECOND_TOOL_MARKER))

      await expectPiKept(session)
      await expectWokenOnce(session.sessionId)
      expect(permissionRequestCount(session.sessionId)).toBe(askedOnce)
      // The first marker is a prefix of the second, never the reverse.
      expect(completedToolUpdates(session.sessionId).join('\n')).toContain(SECOND_TOOL_MARKER)
    },
    TWO_TURN_CASE_TIMEOUT_MS,
  )

  it(
    'wakes a never-prompted session with its model, thinking level and name',
    async () => {
      const agent = live()
      const session = await openLeveledSession()
      // A built-in: Pi runs no turn for it, so the session stays unfiled.
      expect((await promptText(session.sessionId, `/name ${SESSION_NAME}`)).stopReason).toBe('end_turn')
      expect(await isFiled(session.sessionId)).toBe(false)

      await goIdle(session.sessionId)
      expect((await promptText(session.sessionId, ECHO_PROMPT)).stopReason).toBe('end_turn')

      await expectPiKept(session)
      await expectWokenOnce(session.sessionId)
      // A nameless session would be titled from this prompt, so the listed title
      // is the name the woken Pi got back and filed.
      const listed = await agent.agent.request(acp.methods.agent.session.list, { cwd: agent.workspace })
      expect(listed.sessions.find((entry) => entry.sessionId === session.sessionId)?.title).toBe(SESSION_NAME)
    },
    ONE_TURN_CASE_TIMEOUT_MS,
  )

  it(
    'wakes an MCP session with its stdio server connected again',
    async () => {
      const agent = live()
      const servers: McpServer[] = [{ name: MCP_SERVER_NAME, command: NODE_COMMAND, args: [PROBE_SERVER], env: [] }]
      const sessionId = await openPinnedSession(agent, { mcpServers: servers })
      agent.answerPermissions(() => answerWith(PERMISSION_OPTION_ALLOW_ONCE))

      await goIdle(sessionId)
      await promptText(sessionId, MCP_PROMPT)

      await expectWokenOnce(sessionId)
      expect(completedToolUpdates(sessionId).join('\n')).toContain(MCP_MARKER)
    },
    ONE_TURN_CASE_TIMEOUT_MS,
  )
})

function selectOption(
  options: readonly SessionConfigOption[] | null | undefined,
  id: string,
): { currentValue: string; values: string[] } {
  const option = options?.find((candidate) => candidate.id === id)
  if (option === undefined || option.type !== 'select') {
    throw new Error(`e2e: the session advertises no "${id}" select`)
  }
  const values = option.options.flatMap((entry) =>
    'options' in entry ? entry.options.map((nested) => nested.value) : [entry.value],
  )
  return { currentValue: option.currentValue, values }
}

/** A level other than the current one; a one-level model cannot show a lost level, so it fails here. */
function otherThoughtLevel(options: readonly SessionConfigOption[]): string {
  const level = selectOption(options, CONFIG_ID_THOUGHT_LEVEL)
  const other = level.values.find((value) => value !== level.currentValue)
  if (other === undefined) {
    throw new Error(`e2e: the pinned model offers only one thinking level (${level.currentValue})`)
  }
  return other
}

function timingLines(agent: SpawnedAgent): TimingLine[] {
  return agent
    .logDump()
    .split('\n')
    .flatMap((line) => {
      const match = TIMING_LINE.exec(line)
      const sessionId = match?.[1]
      const mode = match?.[2]
      return sessionId === undefined || mode === undefined ? [] : [{ sessionId, mode }]
    })
}
