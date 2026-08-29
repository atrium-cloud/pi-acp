import { existsSync, readFileSync, rmSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { MCP_TOOL_PREFIX } from '../constants.js'
import {
  buildPermissionOptions,
  decodeSentinelTitle,
  encodeSentinelTitle,
  materializeGate,
  PERMISSION_GATE_SOURCE,
} from '../permissions/gate.js'

interface GateEvent {
  toolName: string
  toolCallId: string
  input: unknown
}
interface GateCtx {
  hasUI: boolean
  ui: { select: (title: string, options: string[]) => Promise<string | undefined> }
}
type GateResult = { block?: boolean; reason?: string } | undefined
type GateHandler = (event: GateEvent, ctx: GateCtx) => Promise<GateResult>

// Loads the actual materialized gate source and returns its tool_call handler, so
// the default-deny logic is exercised, not a reimplementation.
function loadGateHandler(): GateHandler {
  const body = PERMISSION_GATE_SOURCE.replace('export default function', 'return function')
  const makeFactory = new Function(body) as () => (pi: { on: (event: string, handler: GateHandler) => void }) => void
  let handler: GateHandler | undefined
  makeFactory()({ on: (event, registered) => { if (event === 'tool_call') handler = registered } })
  if (handler === undefined) throw new Error('gate registered no tool_call handler')
  return handler
}

function ctxSelecting(answer: string | undefined): GateCtx & { titles: string[] } {
  const titles: string[] = []
  return { hasUI: true, titles, ui: { select: async (title) => { titles.push(title); return answer } } }
}

describe('sentinel encode/decode', () => {
  it('round-trips a payload', () => {
    const payload = { toolCallId: 'tc1', toolName: 'edit' }
    expect(decodeSentinelTitle(encodeSentinelTitle(payload))).toEqual(payload)
  })

  it('drops any extra fields so a forged title cannot smuggle an input', () => {
    expect(decodeSentinelTitle('pi-acp-permission:{"toolCallId":"tc1","toolName":"edit","input":{"path":"/x"}}')).toEqual({ toolCallId: 'tc1', toolName: 'edit' })
  })

  it('rejects a non-sentinel title', () => {
    expect(decodeSentinelTitle('Just a normal dialog title')).toBeNull()
  })

  it('rejects a sentinel with malformed json or missing fields', () => {
    expect(decodeSentinelTitle('pi-acp-permission:not json')).toBeNull()
    expect(decodeSentinelTitle('pi-acp-permission:{"toolName":"edit"}')).toBeNull()
  })
})

describe('permission options', () => {
  it('offers allow_once, allow_always, reject_once with matching kinds', () => {
    expect(buildPermissionOptions()).toEqual([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ])
  })
})

describe('gate source behavior (default-deny)', () => {
  const mutating: GateEvent = { toolName: 'edit', toolCallId: 't', input: { path: '/a' } }

  it('allows a non-mutating tool without asking', async () => {
    const handler = loadGateHandler()
    const ctx = ctxSelecting('reject_once')
    expect(await handler({ toolName: 'read', toolCallId: 't', input: {} }, ctx)).toBeUndefined()
    expect(ctx.titles).toHaveLength(0)
  })

  it('allows a mutating tool on allow_once and allow_always', async () => {
    expect(await loadGateHandler()(mutating, ctxSelecting('allow_once'))).toBeUndefined()
    expect(await loadGateHandler()(mutating, ctxSelecting('allow_always'))).toBeUndefined()
  })

  it('blocks on reject, on cancel (undefined), and on any foreign value', async () => {
    for (const answer of ['reject_once', undefined, 'yes-please']) {
      expect(await loadGateHandler()(mutating, ctxSelecting(answer))).toMatchObject({ block: true })
    }
  })

  it('blocks a mutating tool when there is no UI', async () => {
    const handler = loadGateHandler()
    const result = await handler(mutating, { hasUI: false } as unknown as GateCtx)
    expect(result).toMatchObject({ block: true })
  })

  it('asks for every MCP tool, which is third-party code the adapter cannot classify', async () => {
    expect(PERMISSION_GATE_SOURCE).toContain(JSON.stringify(MCP_TOOL_PREFIX))
    const handler = loadGateHandler()
    const ctx = ctxSelecting('allow_once')
    expect(await handler({ toolName: 'mcp__probe__echo', toolCallId: 't', input: {} }, ctx)).toBeUndefined()
    expect(ctx.titles).toHaveLength(1)
    expect(decodeSentinelTitle(ctx.titles[0] ?? '')).toEqual({ toolCallId: 't', toolName: 'mcp__probe__echo' })
  })

  it('blocks a rejected MCP tool', async () => {
    const mcpCall: GateEvent = { toolName: 'mcp__probe__echo', toolCallId: 't', input: {} }
    expect(await loadGateHandler()(mcpCall, ctxSelecting('reject_once'))).toMatchObject({ block: true })
  })

  it('remembers allow_always per tool and stops asking', async () => {
    const handler = loadGateHandler()
    let asks = 0
    const ctx: GateCtx = { hasUI: true, ui: { select: async () => { asks += 1; return 'allow_always' } } }
    await handler({ toolName: 'bash', toolCallId: 't1', input: { command: 'x' } }, ctx)
    await handler({ toolName: 'bash', toolCallId: 't2', input: { command: 'y' } }, ctx)
    expect(asks).toBe(1)
  })

  it('carries a decodable ids-only sentinel in the select title (the input stays off the wire)', async () => {
    const handler = loadGateHandler()
    const ctx = ctxSelecting('allow_once')
    await handler({ toolName: 'write', toolCallId: 'tc7', input: { path: '/z', content: 'c'.repeat(10_000) } }, ctx)
    expect(decodeSentinelTitle(ctx.titles[0] ?? '')).toEqual({ toolCallId: 'tc7', toolName: 'write' })
    expect(ctx.titles[0]?.length).toBeLessThan(200)
  })
})

describe('materializeGate', () => {
  it('writes a gate file whose contents match the source', () => {
    const path = materializeGate()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(PERMISSION_GATE_SOURCE)
    // The bundled source must never name the dev-only Pi package.
    expect(PERMISSION_GATE_SOURCE).not.toContain('pi-coding-agent')
    rmSync(path, { force: true })
  })
})
