import { describe, expect, it } from 'vitest'

import { CONFIG_ID_MODEL, CONFIG_ID_THOUGHT_LEVEL } from '../constants.js'
import { buildConfigOptions, encodeModelValue, resolveModelSelection } from '../turn/configOptions.js'

const MODELS = [
  { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
  { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
]

describe('buildConfigOptions', () => {
  it('builds the full model + thought_level select set', () => {
    const options = buildConfigOptions({
      models: MODELS,
      currentModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
      levels: ['off', 'low', 'high'],
      currentLevel: 'low',
    })
    expect(options).toEqual([
      {
        type: 'select',
        id: CONFIG_ID_MODEL,
        name: 'Model',
        category: CONFIG_ID_MODEL,
        currentValue: 'anthropic/claude-sonnet-5',
        options: [
          { value: 'openrouter/deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
          { value: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
        ],
      },
      {
        type: 'select',
        id: CONFIG_ID_THOUGHT_LEVEL,
        name: 'Thinking level',
        category: CONFIG_ID_THOUGHT_LEVEL,
        currentValue: 'low',
        options: [
          { value: 'off', name: 'off' },
          { value: 'low', name: 'low' },
          { value: 'high', name: 'high' },
        ],
      },
    ])
  })

  it('omits the model option when no model is resolved', () => {
    const options = buildConfigOptions({ models: MODELS, currentModel: undefined, levels: ['low'], currentLevel: 'low' })
    expect(options.map((option) => option.id)).toEqual([CONFIG_ID_THOUGHT_LEVEL])
  })

  it('omits the thought_level option when no levels are available', () => {
    const options = buildConfigOptions({
      models: MODELS,
      currentModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
      levels: [],
      currentLevel: 'off',
    })
    expect(options.map((option) => option.id)).toEqual([CONFIG_ID_MODEL])
  })
})

describe('resolveModelSelection', () => {
  it('round-trips an encoded value back to provider + modelId, id slashes intact', () => {
    const value = encodeModelValue(MODELS[0]!)
    expect(value).toBe('openrouter/deepseek/deepseek-v4-flash-0731')
    expect(resolveModelSelection(value, MODELS)).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash-0731',
    })
  })

  it('returns undefined for a value that matches no model', () => {
    expect(resolveModelSelection('nope/nope', MODELS)).toBeUndefined()
  })
})
