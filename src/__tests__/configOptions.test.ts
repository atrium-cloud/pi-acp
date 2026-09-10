import { describe, expect, it } from 'vitest'

import { CONFIG_ID_MODEL, CONFIG_ID_THOUGHT_LEVEL } from '../constants.js'
import { buildConfigOptions, encodeModelValue, resolveModelSelection } from '../turn/configOptions.js'

const MODELS = [
  { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
  { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
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
        currentValue: 'claude-sonnet-5',
        options: [
          {
            group: 'openrouter',
            name: 'openrouter',
            options: [{ value: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' }],
          },
          {
            group: 'anthropic',
            name: 'anthropic',
            options: [{ value: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
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

  it('prefixes the provider only when another provider offers the same id', () => {
    const shared = [
      { provider: 'opencode-go', id: 'glm-5.3', name: 'GLM 5.3' },
      { provider: 'openrouter', id: 'glm-5.3', name: 'GLM 5.3' },
      { provider: 'cerebras', id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
    ]
    const options = buildConfigOptions({
      models: shared,
      currentModel: { provider: 'opencode-go', id: 'glm-5.3' },
      levels: [],
      currentLevel: 'off',
    })
    expect(options[0]).toMatchObject({
      currentValue: 'opencode-go/glm-5.3',
      options: [
        { group: 'opencode-go', options: [{ value: 'opencode-go/glm-5.3' }] },
        { group: 'openrouter', options: [{ value: 'openrouter/glm-5.3' }] },
        { group: 'cerebras', options: [{ value: 'gpt-oss-120b' }] },
      ],
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
  it('round-trips a bare unique id back to provider + modelId, id slashes intact', () => {
    const value = encodeModelValue(MODELS[0]!, MODELS)
    expect(value).toBe('deepseek/deepseek-v4-flash-0731')
    expect(resolveModelSelection(value, MODELS)).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash-0731',
    })
  })

  it('round-trips a provider-prefixed value for an id shared across providers', () => {
    const shared = [
      { provider: 'opencode-go', id: 'glm-5.3', name: 'GLM 5.3' },
      { provider: 'openrouter', id: 'glm-5.3', name: 'GLM 5.3' },
    ]
    for (const model of shared) {
      const value = encodeModelValue(model, shared)
      expect(value).toBe(`${model.provider}/glm-5.3`)
      expect(resolveModelSelection(value, shared)).toEqual({ provider: model.provider, modelId: 'glm-5.3' })
    }
  })

  it('returns undefined for a value that matches no model', () => {
    expect(resolveModelSelection('nope/nope', MODELS)).toBeUndefined()
  })
})
