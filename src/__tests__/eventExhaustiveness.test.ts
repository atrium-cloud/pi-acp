import { describe, expect, it } from 'vitest'

import type { JsonAgentSessionEvent } from '../pi/types.js'

// tsc is the assertion here, not vitest: when a Pi bump adds an event type the
// `never` assignment stops compiling, so `bun run typecheck` fails instead of
// the adapter silently dropping frames. A `default` case or a `break` would
// disable it. `extension_error` is deliberately absent — Pi emits that frame on
// stdout but it is not part of `JsonAgentSessionEvent`.
function eventKind(event: JsonAgentSessionEvent): string {
  switch (event.type) {
    case 'agent_start':
      return event.type
    case 'agent_end':
      return event.type
    case 'agent_settled':
      return event.type
    case 'turn_start':
      return event.type
    case 'turn_end':
      return event.type
    case 'message_start':
      return event.type
    case 'message_update':
      return event.type
    case 'message_end':
      return event.type
    case 'tool_execution_start':
      return event.type
    case 'tool_execution_update':
      return event.type
    case 'tool_execution_end':
      return event.type
    case 'queue_update':
      return event.type
    case 'compaction_start':
      return event.type
    case 'compaction_end':
      return event.type
    case 'entry_appended':
      return event.type
    case 'session_info_changed':
      return event.type
    case 'thinking_level_changed':
      return event.type
    case 'auto_retry_start':
      return event.type
    case 'auto_retry_end':
      return event.type
    case 'summarization_retry_scheduled':
      return event.type
    case 'summarization_retry_attempt_start':
      return event.type
    case 'summarization_retry_finished':
      return event.type
    case 'bash_execution_update':
      return event.type
  }
  const unhandled: never = event
  throw new Error(`Pi RPC transport: unhandled Pi session event ${JSON.stringify(unhandled)}`)
}

describe('Pi session event coverage', () => {
  it('classifies an event the adapter already knows', () => {
    expect(eventKind({ type: 'agent_settled' })).toBe('agent_settled')
    expect(eventKind({ type: 'session_info_changed', name: 'demo' })).toBe('session_info_changed')
  })
})
