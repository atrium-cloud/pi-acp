/**
 * Live-Pi session lifecycle: config options, resume, close, delete and fork
 * against a real Pi and a real session store on disk.
 *
 * One adapter boot serves the whole file — every case opens its own session, so
 * nothing but process startup is shared — and each case still asserts the real
 * protocol responses. Skipped unless RUN_PI_E2E=true (see e2eGate.ts).
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { PromptResponse, SessionConfigOption } from '@agentclientprotocol/sdk'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'

import {
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  JSONRPC_INVALID_PARAMS,
  PERMISSION_OPTION_ALLOW_ONCE,
} from '../../constants.js'
import { describeE2E, E2E_MODEL_VALUE_ID, E2E_SETUP_TIMEOUT_MS, E2E_TURN_TIMEOUT_MS } from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createSpawnedAgent, openPinnedSession } from './spawnedAgentFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

/** A marker the model can reproduce exactly, so an assertion is about the turn
 * arriving intact rather than about model prose. */
const ECHO_MARKER = 'pi-e2e-ok'
const ECHO_PROMPT = `Reply with exactly ${ECHO_MARKER} and nothing else.`
/** Answerable only from the resumed transcript, which is the point. */
const RECALL_PROMPT = 'What marker did I ask you to reply with? Reply with just that marker.'

/** Long enough that a cancel or a close lands mid-turn rather than after it. */
const LONG_PROMPT = 'Count from 1 to 300, one number per line, with no other text.'

/** The in-flight turn a fork must exclude; the marker appears in the prompt
 * text, so the fork's replayed user messages either carry it or they do not. */
const SLEEP_MARKER = 'pi-e2e-sleeping'
const SLEEP_PROMPT = `Use your bash tool to run \`sleep 30 && echo ${SLEEP_MARKER}\` and tell me the output.`

/** `acp.RequestError.resourceNotFound`; the SDK exports no code constant. */
const JSONRPC_RESOURCE_NOT_FOUND = -32_002

const SCRATCH_PREFIX = 'pi-acp-e2e-cwd-'
const NO_SESSION_ID = 'pi-e2e-no-such-session'

/** A case that runs several turns on one already-booted adapter. */
const TWO_TURN_TIMEOUT_MS = 2 * E2E_TURN_TIMEOUT_MS
const THREE_TURN_TIMEOUT_MS = 3 * E2E_TURN_TIMEOUT_MS

describeE2E('pi live session lifecycle', () => {
  // Nullable so a failed boot leaves the teardown with something to check: the
  // real failure should not be buried under a TypeError from afterAll.
  let agent: SpawnedAgent | null = null
  /** A second real directory, for forking and for the cwd-mismatch refusal. */
  let otherWorkspace: string | null = null

  beforeAll(async () => {
    agent = await createSpawnedAgent()
    // Resolved for the same reason the fixture resolves its own scratch: the
    // fork's header cwd is compared to this string without following symlinks.
    otherWorkspace = realpathSync(mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)))
  }, E2E_SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await agent?.stop()
    if (otherWorkspace !== null) rmSync(otherWorkspace, { recursive: true, force: true })
  }, E2E_SETUP_TIMEOUT_MS)

  afterEach(() => {
    // A scripted answer must not outlive the case that scripted it.
    agent?.answerPermissions(null)
  })

  /** The booted adapter, or a loud failure naming the boot as the cause. */
  function live(): SpawnedAgent {
    if (agent === null) throw new Error('e2e: the adapter for this file never booted')
    return agent
  }

  function otherCwd(): string {
    if (otherWorkspace === null) throw new Error('e2e: the second workspace was never created')
    return otherWorkspace
  }

  async function promptOn(sessionId: string, text: string): Promise<PromptResponse> {
    return await live().agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    })
  }

  function selectOption(
    options: SessionConfigOption[] | undefined,
    id: string,
  ): { currentValue: string; values: string[] } {
    const option = options?.find((candidate) => candidate.id === id)
    if (option === undefined || option.type !== 'select') {
      throw new Error(`e2e: the session advertises no "${id}" select to switch within`)
    }
    const values = option.options.flatMap((entry) =>
      'options' in entry ? entry.options.map((nested) => nested.value) : [entry.value],
    )
    return { currentValue: option.currentValue, values }
  }

  /** A thinking level other than the current one. A one-level model would make a
   * "switch" that stayed put report success without crossing anything, so that
   * fails here rather than passing vacuously. */
  function otherThoughtLevel(options: SessionConfigOption[] | undefined): string {
    const level = selectOption(options, CONFIG_ID_THOUGHT_LEVEL)
    const other = level.values.find((value) => value !== level.currentValue)
    if (other === undefined) {
      throw new Error(`e2e: the pinned model offers only one thinking level (${level.currentValue})`)
    }
    return other
  }

  it(
    'applies a thought_level switch and runs a turn on the switched session',
    async () => {
      const agent = live()
      const created = await agent.agent.request(acp.methods.agent.session.new, {
        cwd: agent.workspace,
        mcpServers: [],
      })
      // The model set returns the full option set re-read for that model, and
      // levels are per model, so the level choice comes from this response.
      const pinned = await agent.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: CONFIG_ID_MODEL,
        value: E2E_MODEL_VALUE_ID,
      })
      const level = otherThoughtLevel(pinned.configOptions)

      const switched = await agent.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: CONFIG_ID_THOUGHT_LEVEL,
        value: level,
      })

      expect(selectOption(switched.configOptions, CONFIG_ID_THOUGHT_LEVEL).currentValue).toBe(level)
      const response = await promptOn(created.sessionId, ECHO_PROMPT)
      expect(response.stopReason).toBe('end_turn')
    },
    E2E_TURN_TIMEOUT_MS,
  )

  it(
    'resumes a closed session with its context, and refuses to resume it into another cwd',
    async () => {
      const agent = live()
      const sessionId = await openPinnedSession(agent)
      expect((await promptOn(sessionId, ECHO_PROMPT)).stopReason).toBe('end_turn')
      await agent.agent.request(acp.methods.agent.session.close, { sessionId })

      const resumed = await agent.agent.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd: agent.workspace,
        mcpServers: [],
      })
      expect(resumed.configOptions).toBeDefined()

      // Only the text this turn adds proves continuity: the first turn's own
      // reply already carries the marker.
      const textBefore = agent.agentText(sessionId).length
      expect((await promptOn(sessionId, RECALL_PROMPT)).stopReason).toBe('end_turn')
      expect(agent.agentText(sessionId).slice(textBefore)).toContain(ECHO_MARKER)

      // Closed again, so the refusal comes from the stored header cwd rather
      // than from the live session's own cwd.
      await agent.agent.request(acp.methods.agent.session.close, { sessionId })
      await expect(
        agent.agent.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd: otherCwd(),
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
    },
    TWO_TURN_TIMEOUT_MS,
  )

  it(
    'rejects closing an unknown session, and resolves a streaming turn as cancelled on close',
    async () => {
      const agent = live()
      await expect(
        agent.agent.request(acp.methods.agent.session.close, { sessionId: NO_SESSION_ID }),
      ).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })

      const sessionId = await openPinnedSession(agent)
      const pending = promptOn(sessionId, LONG_PROMPT)
      // Attached up front: an early provider error would otherwise reject with
      // no handler and surface as an unhandled rejection.
      const cancelled = expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      await agent.waitForText(sessionId, (text) => text.length > 0, E2E_TURN_TIMEOUT_MS)

      await agent.agent.request(acp.methods.agent.session.close, { sessionId })
      await cancelled
    },
    E2E_TURN_TIMEOUT_MS,
  )

  it(
    'deletes a stored session and then reports it missing to list, resume and delete',
    async () => {
      const agent = live()
      const sessionId = await openPinnedSession(agent)
      // Pi creates the file on the first assistant message, so the turn is what
      // makes this session deletable at all.
      expect((await promptOn(sessionId, ECHO_PROMPT)).stopReason).toBe('end_turn')

      await expect(agent.agent.request(acp.methods.agent.session.delete, { sessionId })).resolves.toEqual({})

      const listed = await agent.agent.request(acp.methods.agent.session.list, { cwd: agent.workspace })
      expect(listed.sessions.map((session) => session.sessionId)).not.toContain(sessionId)
      await expect(
        agent.agent.request(acp.methods.agent.session.resume, { sessionId, cwd: agent.workspace, mcpServers: [] }),
      ).rejects.toMatchObject({ code: JSONRPC_RESOURCE_NOT_FOUND })
      await expect(agent.agent.request(acp.methods.agent.session.delete, { sessionId })).rejects.toMatchObject({
        code: JSONRPC_RESOURCE_NOT_FOUND,
      })
    },
    E2E_TURN_TIMEOUT_MS,
  )

  it(
    'forks a session into another cwd as a live session, leaving the parent promptable',
    async () => {
      const agent = live()
      const otherWorkspace = otherCwd()
      const parentId = await openPinnedSession(agent)
      expect((await promptOn(parentId, ECHO_PROMPT)).stopReason).toBe('end_turn')

      const forked = await agent.agent.request(acp.methods.agent.session.fork, {
        sessionId: parentId,
        cwd: otherWorkspace,
      })
      expect(forked.sessionId).not.toBe(parentId)
      expect(forked.configOptions).toBeDefined()

      // `session/list` filters on the stored header cwd, so being listed here at
      // all is the assertion that the fork landed under the other cwd; the title
      // is the one Pi derived for the parent from its first prompt.
      const listed = await agent.agent.request(acp.methods.agent.session.list, { cwd: otherWorkspace })
      const entry = listed.sessions.find((session) => session.sessionId === forked.sessionId)
      expect(entry).toBeDefined()
      expect(entry?.title).toContain(ECHO_MARKER)

      await agent.agent.request(acp.methods.agent.session.load, {
        sessionId: forked.sessionId,
        cwd: otherWorkspace,
        mcpServers: [],
      })
      expect(userMessageText(agent, forked.sessionId)).toContain(ECHO_MARKER)

      // Both sessions are live and independent afterwards.
      expect((await promptOn(forked.sessionId, ECHO_PROMPT)).stopReason).toBe('end_turn')
      expect((await promptOn(parentId, ECHO_PROMPT)).stopReason).toBe('end_turn')
    },
    THREE_TURN_TIMEOUT_MS,
  )

  it(
    'forks a parent that is mid tool turn from its last settled turn',
    async () => {
      const agent = live()
      const parentId = await openPinnedSession(agent)
      expect((await promptOn(parentId, ECHO_PROMPT)).stopReason).toBe('end_turn')

      agent.answerPermissions(() => ({ outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE } }))
      const pending = promptOn(parentId, SLEEP_PROMPT)
      const cancelled = expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      // The tool is running, so Pi has already appended this turn's user entry.
      await agent.waitForUpdate(parentId, (update) => update.sessionUpdate === 'tool_call', E2E_TURN_TIMEOUT_MS)

      const forked = await agent.agent.request(acp.methods.agent.session.fork, {
        sessionId: parentId,
        cwd: agent.workspace,
      })
      // Nothing waits out the sleep: the point was made when the fork was taken.
      await agent.agent.notify(acp.methods.agent.session.cancel, { sessionId: parentId })
      await cancelled

      await agent.agent.request(acp.methods.agent.session.load, {
        sessionId: forked.sessionId,
        cwd: agent.workspace,
        mcpServers: [],
      })
      const replayed = userMessageText(agent, forked.sessionId)
      expect(replayed).toContain(ECHO_MARKER)
      expect(replayed).not.toContain(SLEEP_MARKER)
    },
    TWO_TURN_TIMEOUT_MS,
  )

  it(
    'cancels a turn through the prompt request cancellation signal',
    async () => {
      const agent = live()
      const sessionId = await openPinnedSession(agent)
      const cancellation = new AbortController()
      const pending = agent.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId, prompt: [{ type: 'text', text: LONG_PROMPT }] },
        { cancellationSignal: cancellation.signal },
      )
      const cancelled = expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      await agent.waitForText(sessionId, (text) => text.length > 0, E2E_TURN_TIMEOUT_MS)

      // `$/cancel_request` on the prompt, not `session/cancel`; both converge on
      // the same abort path in the adapter.
      cancellation.abort()
      await cancelled
      expect(agent.child.exitCode).toBeNull()
    },
    E2E_TURN_TIMEOUT_MS,
  )
})

/** The replayed user messages for one session, joined. */
function userMessageText(agent: SpawnedAgent, sessionId: string): string {
  return agent
    .sessionUpdates(sessionId)
    .filter((update) => update.sessionUpdate === 'user_message_chunk')
    .map((update) => (update.content.type === 'text' ? update.content.text : ''))
    .join('\n')
}
