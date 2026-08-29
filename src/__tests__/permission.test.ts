import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PERMISSION_REQUEST_TIMEOUT_MS } from '../constants.js'
import { encodeSentinelTitle } from '../permissions/gate.js'
import { establishSession } from '../session/sessionSetup.js'
import type { SessionConnection } from '../session/SessionConnection.js'
import type { RpcExtensionUIRequest } from '../pi/types.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const ABS_CWD = '/tmp/pi-acp-session'
const MCP_EXTENSION_PATH = '/tmp/mcp-extension.mjs'
const GO = { message: 'go', images: [], firstText: 'go' }

function baseSpec(onPrompt?: FakePiSpec['onPrompt']): FakePiSpec {
  return {
    state: { sessionId: 'sess-1', thinkingLevel: 'low', model: { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } },
    models: [{ provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
    levels: ['low'],
    commands: [],
    ...(onPrompt ? { onPrompt } : {}),
  }
}

type RequestImpl = (method: string, params: unknown, options?: { cancellationSignal?: AbortSignal }) => Promise<unknown>

interface Connected {
  fake: ReturnType<typeof makeFakePiClient>
  connection: SessionConnection
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
}

async function connect(spec: FakePiSpec, requestImpl: RequestImpl): Promise<Connected> {
  const fake = makeFakePiClient(spec)
  const notify = vi.fn(async () => {})
  const request = vi.fn(requestImpl)
  const notifier = { notify, request } as unknown as AgentContext
  const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, {
    launch: LAUNCH,
    rpcTimeoutMs: 1_000,
    notifier,
    mcpExtensionPath: MCP_EXTENSION_PATH,
    createPiClient: fake.createPiClient,
  })
  return { fake, connection: established.connection, request, notify }
}

/** A turn with one tool call already announced by Pi (start precedes the hook). */
async function connectMidTool(
  requestImpl: RequestImpl,
  tool: { toolCallId: string; toolName: string; args: unknown },
): Promise<Connected & { finishTurn: () => Promise<void> }> {
  const connected = await connect(baseSpec((emit) => emit({ type: 'agent_start' } as never)), requestImpl)
  const { fake, connection } = connected
  const turn = connection.runPrompt(GO, new AbortController().signal)
  await Promise.resolve()
  fake.emit({ type: 'tool_execution_start', ...tool } as never)
  const finishTurn = async (): Promise<void> => {
    fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
    fake.emit({ type: 'agent_settled' } as never)
    await turn
  }
  return { ...connected, finishTurn }
}

const selected = (optionId: string): RequestImpl => async () => ({ outcome: { outcome: 'selected', optionId } })
const cancelledOutcome: RequestImpl = async () => ({ outcome: { outcome: 'cancelled' } })

function sentinelSelect(payload: { toolCallId: string; toolName: string }): RpcExtensionUIRequest {
  return {
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: encodeSentinelTitle(payload),
    options: ['allow_once', 'allow_always', 'reject_once'],
  } as RpcExtensionUIRequest
}

describe('permission handler', () => {
  it('maps a sentinel select to request_permission with the cached input and echoes the selected option', async () => {
    const { connection, request, finishTurn } = await connectMidTool(selected('allow_once'), { toolCallId: 'tc1', toolName: 'edit', args: { path: '/a' } })
    const response = await connection.handleExtensionUiRequest(sentinelSelect({ toolCallId: 'tc1', toolName: 'edit' }))
    expect(response).toEqual({ type: 'extension_ui_response', id: 'ui-1', value: 'allow_once' })
    expect(request).toHaveBeenCalledWith(
      acp.methods.client.session.requestPermission,
      expect.objectContaining({
        sessionId: 'sess-1',
        toolCall: expect.objectContaining({ toolCallId: 'tc1', title: 'edit /a', kind: 'edit', rawInput: { path: '/a' } }),
        options: expect.arrayContaining([expect.objectContaining({ optionId: 'allow_always', kind: 'allow_always' })]),
      }),
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    )
    await finishTurn()
  })

  it('fails closed when the client cancels the permission', async () => {
    const { connection, finishTurn } = await connectMidTool(cancelledOutcome, { toolCallId: 'tc2', toolName: 'write', args: {} })
    const response = await connection.handleExtensionUiRequest(sentinelSelect({ toolCallId: 'tc2', toolName: 'write' }))
    expect(response).toEqual({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })
    await finishTurn()
  })

  it('fails closed when the permission request errors', async () => {
    const { connection, finishTurn } = await connectMidTool(async () => { throw new Error('client gone') }, { toolCallId: 'tc3', toolName: 'bash', args: { command: 'x' } })
    const response = await connection.handleExtensionUiRequest(sentinelSelect({ toolCallId: 'tc3', toolName: 'bash' }))
    expect(response).toMatchObject({ cancelled: true })
    await finishTurn()
  })

  it('denies a sentinel for an unannounced tool call without asking the client', async () => {
    const { connection, request, finishTurn } = await connectMidTool(selected('allow_once'), { toolCallId: 'tc-real', toolName: 'edit', args: { path: '/a' } })
    const response = await connection.handleExtensionUiRequest(sentinelSelect({ toolCallId: 'tc-forged', toolName: 'bash' }))
    expect(response).toMatchObject({ cancelled: true })
    expect(request).not.toHaveBeenCalled()
    await finishTurn()
  })

  it('denies a sentinel when no turn is active', async () => {
    const { connection, request } = await connect(baseSpec(), selected('allow_once'))
    const response = await connection.handleExtensionUiRequest(sentinelSelect({ toolCallId: 'tc-idle', toolName: 'edit' }))
    expect(response).toMatchObject({ cancelled: true })
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels a non-sentinel select without asking for permission', async () => {
    const { connection, request } = await connect(baseSpec(), selected('allow_once'))
    const response = await connection.handleExtensionUiRequest({ type: 'extension_ui_request', id: 'ui-9', method: 'select', title: 'Pick a branch', options: ['main', 'dev'] } as RpcExtensionUIRequest)
    expect(response).toEqual({ type: 'extension_ui_response', id: 'ui-9', cancelled: true })
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels a non-select dialog (confirm/input/editor) without asking', async () => {
    const { connection, request } = await connect(baseSpec(), selected('allow_once'))
    const response = await connection.handleExtensionUiRequest({ type: 'extension_ui_request', id: 'ui-e', method: 'editor', title: 'edit', prefill: '' } as RpcExtensionUIRequest)
    expect(response).toMatchObject({ id: 'ui-e', cancelled: true })
    expect(request).not.toHaveBeenCalled()
  })

  it('reports a denied tool as failed from the tool_execution_end Pi emits for a blocked call', async () => {
    const { fake, connection, notify, finishTurn } = await connectMidTool(selected('reject_once'), { toolCallId: 'tc-deny', toolName: 'edit', args: { path: '/a' } })
    await connection.handleExtensionUiRequest(sentinelSelect({ toolCallId: 'tc-deny', toolName: 'edit' }))
    fake.emit({ type: 'tool_execution_end', toolCallId: 'tc-deny', toolName: 'edit', result: { content: [{ type: 'text', text: 'Denied by the ACP client' }] }, isError: true } as never)
    expect(notify).toHaveBeenCalledWith(
      acp.methods.client.session.update,
      expect.objectContaining({
        update: expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-deny',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'Denied by the ACP client' } }],
        }),
      }),
    )
    await finishTurn()
  })

  it('routes a sentinel through the transport hook (createPiClient wiring)', async () => {
    const { fake, request, finishTurn } = await connectMidTool(selected('allow_once'), { toolCallId: 'tc-live', toolName: 'edit', args: { path: '/z', edits: [] } })
    const response = await fake.requestUi(sentinelSelect({ toolCallId: 'tc-live', toolName: 'edit' }))
    expect(response).toMatchObject({ value: 'allow_once' })
    expect(request).toHaveBeenCalledWith(
      acp.methods.client.session.requestPermission,
      expect.objectContaining({ toolCall: expect.objectContaining({ toolCallId: 'tc-live', rawInput: { path: '/z', edits: [] } }) }),
      expect.anything(),
    )
    await finishTurn()
  })
})

describe('permission timeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('denies and sends $/cancel_request (aborts the cancellation signal) when the client never answers', async () => {
    let signal: AbortSignal | undefined
    const never: RequestImpl = (_method, _params, options) => {
      signal = options?.cancellationSignal
      return new Promise(() => {})
    }
    const { connection, finishTurn } = await connectMidTool(never, { toolCallId: 'tc-slow', toolName: 'bash', args: { command: 'x' } })
    const pending = connection.handleExtensionUiRequest(sentinelSelect({ toolCallId: 'tc-slow', toolName: 'bash' }))
    await vi.advanceTimersByTimeAsync(PERMISSION_REQUEST_TIMEOUT_MS)
    expect(await pending).toMatchObject({ cancelled: true })
    expect(signal?.aborted).toBe(true)
    await finishTurn()
  })
})
