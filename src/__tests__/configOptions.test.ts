import { describe, expect, it } from 'vitest'

import { CONFIG_ID_MODEL, CONFIG_ID_THOUGHT_LEVEL } from '../constants.js'
import { buildConfigOptions, encodeModelValue, resolveModelSelection, toModelChoices } from '../turn/configOptions.js'

const MODELS = [
  { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
  { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
]
const SHARED = [
  { provider: 'opencode-go', id: 'glm-5.3', name: 'GLM 5.3' },
  { provider: 'openrouter', id: 'glm-5.3', name: 'GLM 5.3' },
  { provider: 'cerebras', id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
]

describe('buildConfigOptions', () => {
  it('builds the full model + thought_level select set, models grouped by provider', () => {
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
          {
            group: 'openrouter',
            name: 'openrouter',
            options: [{ value: 'openrouter/deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' }],
          },
          {
            group: 'anthropic',
            name: 'anthropic',
            options: [{ value: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }],
          },
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

  it('leaves hidden providers out of the list and refuses their values', () => {
    const shared = toModelChoices(SHARED, new Set(['opencode-go']))
    const options = buildConfigOptions({
      models: shared,
      currentModel: { provider: 'openrouter', id: 'glm-5.3' },
      levels: [],
      currentLevel: 'off',
    })
    expect(options[0]).toMatchObject({
      currentValue: 'openrouter/glm-5.3',
      options: [
        { group: 'openrouter', options: [{ value: 'openrouter/glm-5.3' }] },
        { group: 'cerebras', options: [{ value: 'cerebras/gpt-oss-120b' }] },
      ],
    })
    expect(resolveModelSelection('opencode-go/glm-5.3', shared)).toBeUndefined()
  })

  it('reports a current model on a hidden provider as the current value, outside the options', () => {
    const options = buildConfigOptions({
      models: toModelChoices(SHARED, new Set(['opencode-go'])),
      currentModel: { provider: 'opencode-go', id: 'glm-5.3' },
      levels: [],
      currentLevel: 'off',
    })
    expect(options[0]).toMatchObject({
      currentValue: 'opencode-go/glm-5.3',
      options: [{ group: 'openrouter' }, { group: 'cerebras' }],
    })
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
  it('round-trips a provider-prefixed value back to provider + modelId, id slashes intact', () => {
    const value = encodeModelValue(MODELS[0]!)
    expect(value).toBe('openrouter/deepseek/deepseek-v4-flash-0731')
    expect(resolveModelSelection(value, MODELS)).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash-0731',
    })
  })

  it('round-trips each provider of an id shared across providers', () => {
    for (const model of SHARED) {
      const value = encodeModelValue(model)
      expect(value).toBe(`${model.provider}/${model.id}`)
      expect(resolveModelSelection(value, SHARED)).toEqual({ provider: model.provider, modelId: model.id })
    }
  })

  it('returns undefined for a value that matches no model', () => {
    expect(resolveModelSelection('nope/nope', MODELS)).toBeUndefined()
  })
})
