import * as acp from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@agentclientprotocol/sdk'

import { JSONRPC_INVALID_PARAMS, PROMPT_BLOCK_SEPARATOR } from '../constants.js'

/** Pi's `ImageContent`, declared structurally so no Pi type is imported here. */
export interface PromptImage {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

export interface FlattenedPrompt {
  readonly message: string
  readonly images: PromptImage[]
  /** The first `text` block verbatim ('' when there is none); the session title
   * derives from it so an inlined resource header never becomes the name. */
  readonly firstText: string
}

/** ACP prompt `ContentBlock[]` → Pi's flat `{ message, images }`. Text is joined;
 * a `resource_link` and a text `resource` are inlined as a header line so Pi sees
 * the path. `audio` and binary (`blob`) resources are unadvertised and rejected. */
export function flattenPromptContent(blocks: readonly ContentBlock[]): FlattenedPrompt {
  const segments: string[] = []
  const images: PromptImage[] = []
  let firstText: string | undefined

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        segments.push(block.text)
        firstText ??= block.text
        break
      case 'image':
        images.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        break
      case 'resource_link':
        segments.push(`${block.name} (${block.uri})`)
        break
      case 'resource':
        segments.push(inlineResource(block.resource))
        break
      case 'audio':
        throw invalidParams('audio content is not supported')
      default: {
        const unhandled: never = block
        throw invalidParams(`unsupported content block ${JSON.stringify(unhandled)}`)
      }
    }
  }

  const message = segments.join(PROMPT_BLOCK_SEPARATOR)
  if (message === '' && images.length === 0) throw invalidParams('the prompt has no content')
  return { message, images, firstText: firstText ?? '' }
}

function inlineResource(resource: { uri: string; text?: string; blob?: string }): string {
  if (typeof resource.text === 'string') return `${resource.uri}:\n${resource.text}`
  throw invalidParams('binary embedded resources are not supported')
}

function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
