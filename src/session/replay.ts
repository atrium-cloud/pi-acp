import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk/unstable'

import type { RpcResponse } from '../pi/types.js'
import { ChunkMessageIds, forkCursorUpdate } from '../turn/cursors.js'
import { toolCallEnded, toolCallStarted } from '../turn/mappers.js'

/** One entry of the active-branch, post-compaction history `get_messages` returns. */
export type ReplayMessage = Extract<RpcResponse, { command: 'get_messages'; success: true }>['data']['messages'][number]

type UserContent = Extract<ReplayMessage, { role: 'user' }>['content']
type ToolResultMessage = Extract<ReplayMessage, { role: 'toolResult' }>

/** What a replay for a client that handles `cursor_update` adds: message ids,
 * and a fork cursor before each user message. */
export interface ReplayIds {
  /** The Pi entry that stores exactly this user message, if one does. */
  readonly userEntryId: (message: ReplayMessage) => string | undefined
  readonly mintMessageId: () => string
}

/** Replays a stored transcript as the `session/update`s a live turn would have
 * sent. History keeps messages, not events, so only what a message preserves is
 * reproducible: no deltas (each block is one whole chunk) and no mid-run tool
 * progress. A replayed shell call is the same terminal entry the live turn sent,
 * rooted at the session cwd. */
export function replayUpdates(messages: readonly ReplayMessage[], cwd: string, ids?: ReplayIds): SessionUpdate[] {
  const resultIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'toolResult') resultIds.add(message.toolCallId)
  }

  const updates: SessionUpdate[] = []
  // The tool input, cached by id for the end update: an edit's diff is built from
  // its input and the toolResult message carries only the output.
  const toolCallArgs = new Map<string, unknown>()
  const chunkIds = ids === undefined ? undefined : new ChunkMessageIds(ids.mintMessageId)

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const entryId = ids?.userEntryId(message)
        const blocks = userContentBlocks(message.content)
        for (const content of blocks) {
          updates.push({ sessionUpdate: 'user_message_chunk', content, ...(entryId === undefined ? {} : { messageId: entryId }) })
        }
        if (entryId !== undefined && blocks.length > 0) {
          updates.push(forkCursorUpdate(entryId, { type: 'user_message', messageId: entryId }, 'before'))
        }
        break
      }
      case 'assistant':
        chunkIds?.startMessage()
        for (const block of message.content) {
          switch (block.type) {
            case 'text':
              updates.push(agentChunk('agent_message_chunk', block.text, chunkIds))
              break
            case 'thinking':
              updates.push(agentChunk('agent_thought_chunk', block.thinking, chunkIds))
              break
            case 'toolCall':
              toolCallArgs.set(block.id, block.arguments)
              // A call whose result the history doesn't hold never finished, and ACP
              // has no terminal state for that, so the call is left out entirely.
              if (resultIds.has(block.id)) {
                updates.push(toolCallStarted({ toolCallId: block.id, toolName: block.name, args: block.arguments }, cwd))
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
      // Pi-side history entries with no ACP session update: the prompt and tool
      // state, a `!` bash run, an extension-injected message, and the two
      // summary markers.
      case 'system':
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

function agentChunk(
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
  chunkIds: ChunkMessageIds | undefined,
): SessionUpdate {
  const messageId = chunkIds?.idFor(sessionUpdate)
  return { sessionUpdate, content: { type: 'text', text }, ...(messageId === undefined ? {} : { messageId }) }
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
  }
}
