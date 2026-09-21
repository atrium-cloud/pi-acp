import { describe, expect, it } from 'vitest'

import {
  configOptionUpdate,
  sessionInfoUpdate,
  shellProgress,
  toolCallEnded,
  toolCallProgress,
  toolCallStarted,
  toolTitle,
  usageUpdate,
} from '../turn/mappers.js'

const CWD = '/repo'

describe('tool call mappers', () => {
  it('announces a path tool as an in_progress tool_call with a location', () => {
    expect(toolCallStarted({ toolCallId: 't1', toolName: 'read', args: { path: '/repo/a.ts' } }, CWD)).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read /repo/a.ts',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: '/repo/a.ts' },
      locations: [{ path: '/repo/a.ts' }],
    })
  })

  it('announces a shell call as a terminal entry titled by the verbatim command', () => {
    expect(toolCallStarted({ toolCallId: 't2', toolName: 'bash', args: { command: 'echo hi\nsecond' } }, CWD)).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'echo hi\nsecond',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'echo hi\nsecond' },
      content: [{ type: 'terminal', terminalId: 't2' }],
      _meta: { terminal_info: { terminal_id: 't2', cwd: CWD } },
    })
  })

  it('gives no terminal entry to a non-shell tool that happens to take a command', () => {
    const update = toolCallStarted({ toolCallId: 't2b', toolName: 'mcp_run', args: { command: 'x\ny' } }, CWD)
    expect(update).toMatchObject({ title: 'mcp_run: x', kind: 'other' })
    expect(update).not.toHaveProperty('content')
    expect(update).not.toHaveProperty('_meta')
  })

  it('titles a shell call by its tool name when the input has no command string', () => {
    expect(toolTitle('bash', {})).toBe('bash')
  })

  it('maps an unknown tool to kind other', () => {
    expect(toolCallStarted({ toolCallId: 't3', toolName: 'mytool', args: {} }, CWD)).toMatchObject({ kind: 'other' })
  })

  it('emits partial content as a tool_call_update, and nothing when empty', () => {
    expect(toolCallProgress('t2', { content: [{ type: 'text', text: 'partial out' }] })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      content: [{ type: 'content', content: { type: 'text', text: 'partial out' } }],
    })
    expect(toolCallProgress('t2', { content: [] })).toBeUndefined()
    expect(toolCallProgress('t2', undefined)).toBeUndefined()
  })

  it('completes a tool with its result text and raw output', () => {
    expect(
      toolCallEnded({ toolCallId: 't2', toolName: 'read', result: { content: [{ type: 'text', text: 'done' }] }, isError: false, args: { path: 'x' } }),
    ).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'done' }] },
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    })
  })

  it('marks an errored tool failed', () => {
    expect(
      toolCallEnded({ toolCallId: 't4', toolName: 'read', result: { content: [] }, isError: true, args: {} }),
    ).toMatchObject({ status: 'failed' })
  })

  it('renders an edit as one diff block per edit entry, from the cached input', () => {
    const update = toolCallEnded({
      toolCallId: 't5',
      toolName: 'edit',
      result: { content: [{ type: 'text', text: 'edited' }], details: { patch: 'IGNORED' } },
      isError: false,
      args: { path: '/repo/a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] },
    })
    expect(update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't5',
      status: 'completed',
      content: [
        { type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' },
        { type: 'diff', path: '/repo/a.ts', oldText: 'c', newText: 'd' },
      ],
    })
  })
})

describe('shell tool terminal mappers', () => {
  const ANSI_OUT = '[32mok[0m\n'
  const partial = (text: string) => ({ content: [{ type: 'text', text }] })

  it('streams the new tail of a cumulative snapshot as terminal_output_delta, ANSI intact', () => {
    const first = shellProgress('t1', partial(ANSI_OUT), '')
    expect(first.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      _meta: { terminal_output_delta: { terminal_id: 't1', data: ANSI_OUT } },
    })
    expect(first.text).toBe(ANSI_OUT)
    const second = shellProgress('t1', partial(`${ANSI_OUT}more\n`), first.text)
    expect(second.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      _meta: { terminal_output_delta: { terminal_id: 't1', data: 'more\n' } },
    })
    expect(second.text).toBe(`${ANSI_OUT}more\n`)
  })

  it('sends nothing for an empty or unchanged partial', () => {
    expect(shellProgress('t1', { content: [] }, '').update).toBeUndefined()
    expect(shellProgress('t1', undefined, '').update).toBeUndefined()
    expect(shellProgress('t1', partial('same'), 'same')).toEqual({ update: undefined, text: 'same' })
  })

  it('falls back to a terminal_output replace once the snapshot no longer extends the last one', () => {
    const progress = shellProgress('t1', partial('line3\nline4\n'), 'line1\nline2\nline3\n')
    expect(progress.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      _meta: { terminal_output: { terminal_id: 't1', data: 'line3\nline4\n' } },
    })
  })

  it('never puts a text content block on a shell progress update', () => {
    expect(shellProgress('t1', partial('out'), '').update).not.toHaveProperty('content')
  })

  it('ends a successful shell call with the output snapshot and exit 0, no content', () => {
    const result = { content: [{ type: 'text', text: ANSI_OUT }], details: undefined }
    const update = toolCallEnded({ toolCallId: 't1', toolName: 'bash', result, isError: false, args: { command: 'ls' } })
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: result,
      _meta: {
        terminal_output: { terminal_id: 't1', data: ANSI_OUT },
        terminal_exit: { terminal_id: 't1', exit_code: 0, signal: null },
      },
    })
    expect(update).not.toHaveProperty('content')
  })

  it('parses a nonzero exit from the status line Pi appends, drops it from the data, and fails the call', () => {
    const result = { content: [{ type: 'text', text: 'boom\n\nCommand exited with code 127' }] }
    expect(toolCallEnded({ toolCallId: 't2', toolName: 'bash', result, isError: true, args: {} })).toMatchObject({
      status: 'failed',
      _meta: {
        terminal_output: { terminal_id: 't2', data: 'boom' },
        terminal_exit: { terminal_id: 't2', exit_code: 127, signal: null },
      },
    })
  })

  it('reports exit 1 for a failure with no status line (denied, aborted, timed out)', () => {
    const result = { content: [{ type: 'text', text: 'Denied by the ACP client' }] }
    expect(toolCallEnded({ toolCallId: 't3', toolName: 'bash', result, isError: true, args: {} })).toMatchObject({
      status: 'failed',
      _meta: {
        terminal_output: { terminal_id: 't3', data: 'Denied by the ACP client' },
        terminal_exit: { terminal_id: 't3', exit_code: 1, signal: null },
      },
    })
  })

  it("sends empty data for Pi's empty-output placeholder, on success and on a nonzero exit", () => {
    const ok = { content: [{ type: 'text', text: '(no output)' }] }
    expect(toolCallEnded({ toolCallId: 't5', toolName: 'bash', result: ok, isError: false, args: {} })).toMatchObject({
      status: 'completed',
      _meta: { terminal_output: { terminal_id: 't5', data: '' }, terminal_exit: { terminal_id: 't5', exit_code: 0, signal: null } },
    })
    const failed = { content: [{ type: 'text', text: '(no output)\n\nCommand exited with code 3' }] }
    expect(toolCallEnded({ toolCallId: 't6', toolName: 'bash', result: failed, isError: true, args: {} })).toMatchObject({
      status: 'failed',
      _meta: { terminal_output: { terminal_id: 't6', data: '' }, terminal_exit: { terminal_id: 't6', exit_code: 3, signal: null } },
    })
  })

  it('keeps a truncation notice in the data and still parses the exit after it', () => {
    const text = 'tail\n\n[Showing lines 5-9 of 9. Full output: /tmp/x]\n\nCommand exited with code 4'
    expect(toolCallEnded({ toolCallId: 't7', toolName: 'bash', result: { content: [{ type: 'text', text }] }, isError: true, args: {} })).toMatchObject({
      _meta: {
        terminal_output: { terminal_id: 't7', data: 'tail\n\n[Showing lines 5-9 of 9. Full output: /tmp/x]' },
        terminal_exit: { terminal_id: 't7', exit_code: 4, signal: null },
      },
    })
  })

  it("treats the status line in a successful command's own output as data, not an exit", () => {
    const text = 'done\n\nCommand exited with code 3'
    expect(toolCallEnded({ toolCallId: 't8', toolName: 'bash', result: { content: [{ type: 'text', text }] }, isError: false, args: {} })).toMatchObject({
      status: 'completed',
      _meta: {
        terminal_output: { terminal_id: 't8', data: text },
        terminal_exit: { terminal_id: 't8', exit_code: 0, signal: null },
      },
    })
  })

  it('still sends terminal_exit when the result carries no output', () => {
    const update = toolCallEnded({ toolCallId: 't4', toolName: 'powershell', result: { content: [] }, isError: false, args: {} })
    expect(update).toMatchObject({
      status: 'completed',
      _meta: {
        terminal_output: { terminal_id: 't4', data: '' },
        terminal_exit: { terminal_id: 't4', exit_code: 0, signal: null },
      },
    })
    expect(update).not.toHaveProperty('content')
  })
})

describe('usage and session mappers', () => {
  it('builds a usage_update with an amount+currency cost', () => {
    expect(usageUpdate(1200, 200_000, 0.42)).toEqual({
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200_000,
      cost: { amount: 0.42, currency: 'USD' },
    })
  })

  it('builds session_info_update and config_option_update', () => {
    expect(sessionInfoUpdate('My Session')).toEqual({ sessionUpdate: 'session_info_update', title: 'My Session' })
    expect(configOptionUpdate([])).toEqual({ sessionUpdate: 'config_option_update', configOptions: [] })
  })
})
