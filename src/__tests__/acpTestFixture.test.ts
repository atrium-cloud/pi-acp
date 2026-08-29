import { existsSync } from 'node:fs'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
} from '../constants.js'
import { type AcpTestFixture, createAcpTestFixture, TEST_SESSION_ID } from './acpTestFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TOOL_CALL_ID = 'tool-1'
const PERMISSION_OPTIONS = [
  { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' as const },
  { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject', kind: 'reject_once' as const },
]
const CHUNK_TEXT = 'hello'

let fixture: AcpTestFixture | null = null

function openFixture(): AcpTestFixture {
  fixture = createAcpTestFixture()
  return fixture
}

afterEach(async () => {
  await fixture?.close()
  fixture = null
})

function requestPermission(scenario: AcpTestFixture): Promise<acp.RequestPermissionResponse> {
  return scenario.agent.request(acp.methods.client.session.requestPermission, {
    sessionId: TEST_SESSION_ID,
    toolCall: { toolCallId: TOOL_CALL_ID },
    options: PERMISSION_OPTIONS,
  })
}

describe('recording acp client', () => {
  it('denies a permission request no test answered', async () => {
    const scenario = openFixture()

    const response = await requestPermission(scenario)

    expect(response.outcome).toEqual({ outcome: 'cancelled' })
  })

  it('honors a scripted permission answer', async () => {
    const scenario = openFixture()
    scenario.setPermissionResponse({ outcome: { outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE } })

    const response = await requestPermission(scenario)

    expect(response.outcome).toEqual({ outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE })
  })

  it('leaves the request pending while the scripted answer never settles', async () => {
    const scenario = openFixture()
    scenario.setPermissionResponse(new Promise<acp.RequestPermissionResponse>(() => {}))

    // The close in afterEach rejects it; observed here so the rejection is never
    // left dangling.
    const pending = requestPermission(scenario).then(
      () => 'answered',
      () => 'rejected',
    )
    await scenario.flushAnnouncements()

    expect(await Promise.race([pending, Promise.resolve('waiting')])).toBe('waiting')
    expect(scenario.transcript()).toHaveLength(1)
  })
})

describe('transcript', () => {
  it('records client-bound messages in arrival order', async () => {
    const scenario = openFixture()

    await scenario.agent.notify(acp.methods.client.session.update, {
      sessionId: TEST_SESSION_ID,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: CHUNK_TEXT } },
    })
    await requestPermission(scenario)

    expect(scenario.transcript()).toEqual([
      {
        kind: 'notification',
        method: acp.methods.client.session.update,
        params: {
          sessionId: TEST_SESSION_ID,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: CHUNK_TEXT } },
        },
      },
      {
        kind: 'request',
        method: acp.methods.client.session.requestPermission,
        params: { sessionId: TEST_SESSION_ID, toolCall: { toolCallId: TOOL_CALL_ID }, options: PERMISSION_OPTIONS },
      },
    ])
  })

  it('anonymizes fields by name and by dotted path', async () => {
    const scenario = openFixture()

    await scenario.agent.notify(acp.methods.client.session.update, {
      sessionId: TEST_SESSION_ID,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: CHUNK_TEXT } },
    })

    expect(scenario.transcript(['sessionId'])[0]?.params).toEqual({
      sessionId: 'sessionId',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: CHUNK_TEXT } },
    })
    // The dotted path reaches one nested field; the bare name would also match a
    // `text` anywhere else in the payload.
    expect(scenario.transcript(['update.content.text'])[0]?.params).toEqual({
      sessionId: TEST_SESSION_ID,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'text' } },
    })
    // Anonymization is applied on read, so the recorded params are untouched.
    expect(scenario.transcript()[0]?.params).toMatchObject({ sessionId: TEST_SESSION_ID })
  })

  it('clears the recorded messages', async () => {
    const scenario = openFixture()
    await scenario.agent.notify(acp.methods.client.session.update, {
      sessionId: TEST_SESSION_ID,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: CHUNK_TEXT } },
    })

    scenario.clearTranscript()

    expect(scenario.transcript()).toEqual([])
  })
})

describe('close', () => {
  it('removes the temp session root', async () => {
    const scenario = openFixture()
    const root = scenario.sessionRoot
    expect(existsSync(root)).toBe(true)

    await scenario.close()
    fixture = null

    expect(existsSync(root)).toBe(false)
  })
})
