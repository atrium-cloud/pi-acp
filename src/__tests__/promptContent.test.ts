import type { ContentBlock } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { flattenPromptContent } from '../turn/promptContent.js'

describe('flattenPromptContent', () => {
  it('concatenates text blocks with a newline', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(flattenPromptContent(blocks)).toEqual({ message: 'first\nsecond', images: [], firstText: 'first' })
  })

  it('reports the first text block even when a resource precedes it', () => {
    const blocks: ContentBlock[] = [
      { type: 'resource', resource: { uri: 'file:///repo/notes.md', text: 'notes' } },
      { type: 'text', text: 'Summarize this' },
    ]
    expect(flattenPromptContent(blocks)).toEqual({
      message: 'file:///repo/notes.md:\nnotes\nSummarize this',
      images: [],
      firstText: 'Summarize this',
    })
  })

  it('collects image blocks and keeps text as the message', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'YWJj', mimeType: 'image/png' },
    ]
    expect(flattenPromptContent(blocks)).toEqual({
      message: 'look at this',
      images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
      firstText: 'look at this',
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

  it('rejects an empty prompt with no content', () => {
    expect(() => flattenPromptContent([])).toThrow(/no content/)
  })

  it('keeps an image-only prompt even with no text', () => {
    const blocks: ContentBlock[] = [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }]
    expect(flattenPromptContent(blocks)).toEqual({
      message: '',
      images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
      firstText: '',
    })
  })
})
