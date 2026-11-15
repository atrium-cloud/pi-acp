import type { SessionConfigOption, SessionConfigSelectGroup } from '@agentclientprotocol/sdk/unstable'

import {
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  CONFIG_NAME_MODEL,
  CONFIG_NAME_THOUGHT_LEVEL,
  MODEL_VALUE_SEPARATOR,
  type ProviderModels,
} from '../constants.js'

export interface ModelChoice {
  readonly provider: string
  readonly id: string
  readonly name: string
}

export interface ConfigOptionsInput {
  readonly models: readonly ModelChoice[]
  /** From `RpcSessionState.model`, absent until a model is resolved. */
  readonly currentModel: { readonly provider: string; readonly id: string } | undefined
  readonly levels: readonly string[]
  readonly currentLevel: string
  /** From `PI_ACP_PROVIDER_MODELS`; absent narrows nothing. */
  readonly providerModels?: ProviderModels | undefined
}

/** The adapter's model list from Pi's `get_available_models`, without the
 * models of hidden providers. Every list the session works with comes from here. */
export function toModelChoices(
  models: readonly ModelChoice[],
  hiddenProviders: ReadonlySet<string> | undefined,
): ModelChoice[] {
  return models
    .filter((model) => hiddenProviders?.has(model.provider) !== true)
    .map(({ provider, id, name }) => ({ provider, id, name }))
}

export function encodeModelValue(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}${MODEL_VALUE_SEPARATOR}${model.id}`
}

/** The FULL config-option set (ACP config updates carry the whole set, never a
 * delta). A `select` needs a required `currentValue`, so an option is omitted
 * rather than synthesizing one: no current model, no model listed, or no
 * thinking levels. Models are grouped by provider, and a current model outside
 * the list is still reported as the current value. A provider in `providerModels`
 * offers only those ids and the current model; a set still resolves against `models`. */
export function buildConfigOptions(input: ConfigOptionsInput): SessionConfigOption[] {
  const options: SessionConfigOption[] = []
  const current = input.currentModel
  const advertised = input.models.filter((model) => {
    const probed = input.providerModels?.get(model.provider)
    if (probed === undefined || probed.has(model.id)) return true
    return current !== undefined && current.provider === model.provider && current.id === model.id
  })

  if (current !== undefined && advertised.length > 0) {
    const groups: SessionConfigSelectGroup[] = []
    for (const model of advertised) {
      let group = groups.find((candidate) => candidate.group === model.provider)
      if (group === undefined) {
        group = { group: model.provider, name: model.provider, options: [] }
        groups.push(group)
      }
      group.options.push({ value: encodeModelValue(model), name: model.name })
    }
    options.push({
      type: 'select',
      id: CONFIG_ID_MODEL,
      name: CONFIG_NAME_MODEL,
      category: CONFIG_ID_MODEL,
      currentValue: encodeModelValue(current),
      options: groups,
    })
  }

  if (input.levels.length > 0) {
    options.push({
      type: 'select',
      id: CONFIG_ID_THOUGHT_LEVEL,
      name: CONFIG_NAME_THOUGHT_LEVEL,
      category: CONFIG_ID_THOUGHT_LEVEL,
      currentValue: input.currentLevel,
      options: input.levels.map((level) => ({ value: level, name: level })),
    })
  }

  return options
}

/** Resolves an ACP model value back to its Pi `{ provider, modelId }` by
 * matching the whole encoded string. */
export function resolveModelSelection(
  value: string,
  models: readonly ModelChoice[],
): { provider: string; modelId: string } | undefined {
  const model = models.find((candidate) => encodeModelValue(candidate) === value)
  return model === undefined ? undefined : { provider: model.provider, modelId: model.id }
}
