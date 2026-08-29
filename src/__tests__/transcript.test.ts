import * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PERMISSION_DENIED_REASON,
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  PROTOCOL_VERSION,
  USAGE_COST_CURRENCY,
} from '../constants.js'
import { encodeSentinelTitle } from '../permissions/gate.js'
import type { RpcExtensionUIRequest } from '../pi/types.js'
import { type AcpTestFixture, createAcpTestFixture, TEST_SESSION_ID } from './acpTestFixture.js'
import type { FakePiSpec } from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const CWD = '/workspace/project'
const INIT_REQUEST = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }
const HELLO_PROMPT = [{ type: 'text' as const, text: 'hi' }]
const UI_REQUEST_ID = 'ui-1'

const READ_TOOL_CALL_ID = 'tc-read'
const READ_PATH = '/workspace/project/readme.md'
const READ_ARGS = { path: READ_PATH }
const READ_RESULT = { content: [{ type: 'text', text: '# Readme' }] }
const MESSAGE_TEXT = 'Reading the file'
const THINKING_TEXT = 'which file to open'

const EDIT_TOOL_CALL_ID = 'tc-edit'
const EDIT_PATH = '/workspace/project/app.ts'
const EDIT_ARGS = { path: EDIT_PATH, edits: [{ oldText: 'before', newText: 'after' }] }
const EDIT_RESULT = { content: [{ type: 'text', text: 'edited' }] }
const DENIED_RESULT = { content: [{ type: 'text', text: PERMISSION_DENIED_REASON }] }

/** The fake's DEFAULT_STATS, which every fixture without a `stats` override
 * answers `get_session_stats` with. */
const EXPECTED_USAGE = { used: 1234, size: 200_000, cost: { amount: 0.05, currency: USAGE_COST_CURRENCY } }

const MAX_WAIT_TICKS = 100

type Emit = Parameters<NonNullable<FakePiSpec['onPrompt']>>[0]

// ── Helpers ───────────────────────────────────────────────────────────────────

let fixture: AcpTestFixture | null = null

afterEach(async () => {
  await fixture?.close()
  fixture = null
})

/** Initializes, opens a session, and lets the deferred command announcement land,
 * so a test starts from a transcript holding exactly that announcement. */
async function startSession(spec: Partial<FakePiSpec>): Promise<AcpTestFixture> {
  fixture = createAcpTestFixture(spec)
  await fixture.client.request(acp.methods.agent.initialize, INIT_REQUEST)
  const created = await fixture.client.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] })
  expect(created.sessionId).toBe(TEST_SESSION_ID)
  await fixture.flushAnnouncements()
  return fixture
}

function prompt(scenario: AcpTestFixture): Promise<acp.PromptResponse> {
  return scenario.client.request(acp.methods.agent.session.prompt, {
    sessionId: TEST_SESSION_ID,
    prompt: HELLO_PROMPT,
  })
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_WAIT_TICKS; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${description}`)
}

function sentAnyOf(scenario: AcpTestFixture, commandType: string): boolean {
  return scenario.fake.calls.some((call) => call['type'] === commandType)
}

function sawUpdate(scenario: AcpTestFixture, sessionUpdate: string): boolean {
  return scenario.transcript().some((entry) => {
    const params = entry.params as acp.SessionNotification | undefined
    return params?.update.sessionUpdate === sessionUpdate
  })
}

function notification(update: unknown): { kind: string; method: string; params: unknown } {
  return {
    kind: 'notification',
    method: acp.methods.client.session.update,
    params: { sessionId: TEST_SESSION_ID, update },
  }
}

const COMMANDS_ANNOUNCEMENT = notification({
  sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'review', description: 'Review code' }],
})

const USAGE_NOTIFICATION = notification({ sessionUpdate: 'usage_update', ...EXPECTED_USAGE })

function sentinelSelect(payload: { toolCallId: string; toolName: string }): RpcExtensionUIRequest {
  return {
    type: 'extension_ui_request',
    id: UI_REQUEST_ID,
    method: 'select',
    title: encodeSentinelTitle(payload),
    options: [PERMISSION_OPTION_ALLOW_ONCE, PERMISSION_OPTION_ALLOW_ALWAYS, PERMISSION_OPTION_REJECT_ONCE],
  } as RpcExtensionUIRequest
}

// ── A read-only turn ──────────────────────────────────────────────────────────

const readTurn = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({
    type: 'message_update',
    usage: {},
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: MESSAGE_TEXT },
  } as never)
  emit({
    type: 'message_update',
    usage: {},
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: THINKING_TEXT },
  } as never)
  emit({ type: 'tool_execution_start', toolCallId: READ_TOOL_CALL_ID, toolName: 'read', args: READ_ARGS } as never)
  emit({
    type: 'tool_execution_end',
    toolCallId: READ_TOOL_CALL_ID,
    toolName: 'read',
    result: READ_RESULT,
    isError: false,
  } as never)
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  emit({ type: 'agent_settled' } as never)
}

describe('a streamed turn', () => {
  it('records the ordered updates a read-only turn produces', async () => {
    const scenario = await startSession({ onPrompt: readTurn })

    const response = await prompt(scenario)
    await scenario.flushAnnouncements()

    expect(response).toEqual({ stopReason: 'end_turn' })
    expect(scenario.transcript()).toEqual([
      COMMANDS_ANNOUNCEMENT,
      notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: MESSAGE_TEXT } }),
      notification({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: THINKING_TEXT } }),
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: READ_TOOL_CALL_ID,
        title: `read ${READ_PATH}`,
        kind: 'read',
        status: 'in_progress',
        rawInput: READ_ARGS,
        locations: [{ path: READ_PATH }],
      }),
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: READ_TOOL_CALL_ID,
        status: 'completed',
        rawOutput: READ_RESULT,
        content: [{ type: 'content', content: { type: 'text', text: '# Readme' } }],
      }),
      USAGE_NOTIFICATION,
    ])
    // The nameless session is titled from the prompt's first line.
    expect(scenario.fake.calls.find((call) => call['type'] === 'set_session_name')).toMatchObject({ name: 'hi' })
  })
})

// ── A mutating turn that trips the permission gate ────────────────────────────

/** Announces the edit and then stops: the sentinel arrives while the turn is
 * still open, exactly as Pi's `tool_call` hook fires it. */
const editTurn = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({ type: 'tool_execution_start', toolCallId: EDIT_TOOL_CALL_ID, toolName: 'edit', args: EDIT_ARGS } as never)
}

const EDIT_ANNOUNCEMENT = notification({
  sessionUpdate: 'tool_call',
  toolCallId: EDIT_TOOL_CALL_ID,
  title: `edit ${EDIT_PATH}`,
  kind: 'edit',
  status: 'in_progress',
  rawInput: EDIT_ARGS,
  locations: [{ path: EDIT_PATH }],
})

const PERMISSION_REQUEST = {
  kind: 'request',
  method: acp.methods.client.session.requestPermission,
  params: {
    sessionId: TEST_SESSION_ID,
    toolCall: { toolCallId: EDIT_TOOL_CALL_ID, title: `edit ${EDIT_PATH}`, kind: 'edit', rawInput: EDIT_ARGS },
    options: [
      { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
      { optionId: PERMISSION_OPTION_ALLOW_ALWAYS, name: 'Allow always', kind: 'allow_always' },
      { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject', kind: 'reject_once' },
    ],
  },
}

/** Prompts, waits for the edit to be announced, and answers the gate's sentinel. */
async function runGatedEdit(scenario: AcpTestFixture): Promise<{
  turn: Promise<acp.PromptResponse>
  uiResponse: unknown
}> {
  const turn = prompt(scenario)
  await waitFor(() => sawUpdate(scenario, 'tool_call'), 'the edit tool call to be announced')
  const uiResponse = await scenario.fake.requestUi(
    sentinelSelect({ toolCallId: EDIT_TOOL_CALL_ID, toolName: 'edit' }),
  )
  return { turn, uiResponse }
}

function finishTurn(scenario: AcpTestFixture, result: unknown, isError: boolean): void {
  scenario.fake.emit({
    type: 'tool_execution_end',
    toolCallId: EDIT_TOOL_CALL_ID,
    toolName: 'edit',
    result,
    isError,
  } as never)
  scenario.fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  scenario.fake.emit({ type: 'agent_settled' } as never)
}

describe('a gated mutating turn', () => {
  it('denies the tool when no answer is scripted, and Pi sees the cancellation', async () => {
    const scenario = await startSession({ onPrompt: editTurn })

    const { turn, uiResponse } = await runGatedEdit(scenario)

    // A cancelled outcome is not an option id, so the gate is answered with a
    // cancellation rather than an echoed `reject_once`; both read as deny.
    expect(uiResponse).toEqual({ type: 'extension_ui_response', id: UI_REQUEST_ID, cancelled: true })

    finishTurn(scenario, DENIED_RESULT, true)
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([
      COMMANDS_ANNOUNCEMENT,
      EDIT_ANNOUNCEMENT,
      PERMISSION_REQUEST,
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: EDIT_TOOL_CALL_ID,
        status: 'failed',
        rawOutput: DENIED_RESULT,
        content: [{ type: 'content', content: { type: 'text', text: PERMISSION_DENIED_REASON } }],
      }),
      USAGE_NOTIFICATION,
    ])
  })

  it('echoes a scripted allow_once back to Pi and reports the edit as a diff', async () => {
    const scenario = await startSession({ onPrompt: editTurn })
    scenario.setPermissionResponse({ outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE } })

    const { turn, uiResponse } = await runGatedEdit(scenario)

    expect(uiResponse).toEqual({
      type: 'extension_ui_response',
      id: UI_REQUEST_ID,
      value: PERMISSION_OPTION_ALLOW_ONCE,
    })

    finishTurn(scenario, EDIT_RESULT, false)
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([
      COMMANDS_ANNOUNCEMENT,
      EDIT_ANNOUNCEMENT,
      PERMISSION_REQUEST,
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: EDIT_TOOL_CALL_ID,
        status: 'completed',
        rawOutput: EDIT_RESULT,
        content: [{ type: 'diff', path: EDIT_PATH, oldText: 'before', newText: 'after' }],
      }),
      USAGE_NOTIFICATION,
    ])
  })
})

// ── A cancelled turn ──────────────────────────────────────────────────────────

describe('session/cancel mid-turn', () => {
  it('resolves the prompt as cancelled and sends abort to Pi', async () => {
    const scenario = await startSession({ onPrompt: (emit) => emit({ type: 'agent_start' } as never) })

    const turn = prompt(scenario)
    await waitFor(() => sentAnyOf(scenario, 'prompt'), 'the prompt to reach Pi')
    await scenario.client.notify(acp.methods.agent.session.cancel, { sessionId: TEST_SESSION_ID })
    await waitFor(() => sentAnyOf(scenario, 'abort'), 'the abort to reach Pi')
    scenario.fake.emit({ type: 'agent_settled' } as never)

    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    await scenario.flushAnnouncements()

    // The turn ran, so it is still titled and metered; nothing streamed.
    expect(scenario.transcript()).toEqual([COMMANDS_ANNOUNCEMENT, USAGE_NOTIFICATION])
  })
})
