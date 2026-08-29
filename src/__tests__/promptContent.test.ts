import type { ContentBlock } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { flattenPromptContent } from '../turn/promptContent.js'

describe('flattenPromptContent', () => {
  it('concatenates text blocks with a newline', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(flattenPromptContent(blocks)).toEqual({ message: 'first\nsecond', images: [] })
  })

  it('collects image blocks and keeps text as the message', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'YWJj', mimeType: 'image/png' },
    ]
    expect(flattenPromptContent(blocks)).toEqual({
      message: 'look at this',
      images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
    })
  })

  it('inlines a resource_link as a header line', () => {
    const blocks: ContentBlock[] = [{ type: 'resource_link', name: 'main.ts', uri: 'file:///repo/main.ts' }]
    expect(flattenPromptContent(blocks).message).toBe('main.ts (file:///repo/main.ts)')
  })

  it('inlines an embedded text resource with its uri', () => {
    const blocks: ContentBlock[] = [
      { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
    ]
    expect(flattenPromptContent(blocks).message).toBe('file:///a.txt:\nhello')
  })

  it('rejects audio content', () => {
    const blocks: ContentBlock[] = [{ type: 'audio', data: 'YWJj', mimeType: 'audio/wav' }]
    expect(() => flattenPromptContent(blocks)).toThrow(/audio/)
  })

  it('rejects a binary embedded resource', () => {
    const blocks: ContentBlock[] = [
      { type: 'resource', resource: { uri: 'file:///a.bin', blob: 'YWJj' } },
    ]
    expect(() => flattenPromptContent(blocks)).toThrow(/binary/)
  })
})
