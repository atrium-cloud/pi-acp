import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'

import type { RpcResponse } from '../pi/types.js'
import { toolCallEnded, toolCallStarted } from '../turn/mappers.js'

/** One entry of the active-branch, post-compaction history `get_messages` returns. */
export type ReplayMessage = Extract<RpcResponse, { command: 'get_messages'; success: true }>['data']['messages'][number]

type UserContent = Extract<ReplayMessage, { role: 'user' }>['content']
type ToolResultMessage = Extract<ReplayMessage, { role: 'toolResult' }>

/** Replays a stored transcript as the `session/update`s a live turn would have
 * sent. History keeps messages, not events, so only what a message preserves is
 * reproducible: no deltas (each block is one whole chunk) and no mid-run tool
 * progress. */
export function replayUpdates(messages: readonly ReplayMessage[]): SessionUpdate[] {
  const resultIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'toolResult') resultIds.add(message.toolCallId)
  }

  const updates: SessionUpdate[] = []
  // The tool input, cached by id for the end update: an edit's diff is built from
  // its input and the toolResult message carries only the output.
  const toolCallArgs = new Map<string, unknown>()

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        for (const content of userContentBlocks(message.content)) {
          updates.push({ sessionUpdate: 'user_message_chunk', content })
        }
        break
      case 'assistant':
        for (const block of message.content) {
          switch (block.type) {
            case 'text':
              updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } })
              break
            case 'thinking':
              updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking } })
              break
            case 'toolCall':
              toolCallArgs.set(block.id, block.arguments)
              // A call whose result the history doesn't hold never finished, and ACP
              // has no terminal state for that, so the call is left out entirely.
              if (resultIds.has(block.id)) {
                updates.push(toolCallStarted({ toolCallId: block.id, toolName: block.name, args: block.arguments }))
              }
              break
            default:
              break
          }
        }
        break
      case 'toolResult': {
        // A result whose call fell before the compaction cut was never announced;
        // an update for an unknown id is a protocol error on the client side.
        if (!toolCallArgs.has(message.toolCallId)) break
        updates.push(
          toolCallEnded({
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            result: toolResultPayload(message),
            isError: message.isError,
            args: toolCallArgs.get(message.toolCallId),
          }),
        )
        toolCallArgs.delete(message.toolCallId)
        break
      }
      // Pi-side history entries with no ACP session update: a `!` bash run, an
      // extension-injected message, and the two summary markers.
      case 'bashExecution':
      case 'custom':
      case 'branchSummary':
      case 'compactionSummary':
        break
      default: {
        const unhandled: never = message
        void unhandled
        break
      }
    }
  }

  return updates
}

function userContentBlocks(content: UserContent): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  const blocks: ContentBlock[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: block.text })
        break
      case 'image':
        blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        break
      default:
        break
    }
  }
  return blocks
}

/** Live `tool_execution_end` carries the tool's own result object; persistence
 * flattens it into the message. Rebuilt here so a replayed `rawOutput` matches
 * the live one — except `terminate`, which is never persisted. */
function toolResultPayload(message: ToolResultMessage): unknown {
  return {
    content: message.content,
    ...(message.details !== undefined ? { details: message.details } : {}),
    ...(message.usage !== undefined ? { usage: message.usage } : {}),
    ...(message.addedToolNames !== undefined ? { addedToolNames: message.addedToolNames } : {}),
  }
}
