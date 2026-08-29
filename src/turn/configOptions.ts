import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import {
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  CONFIG_NAME_MODEL,
  CONFIG_NAME_THOUGHT_LEVEL,
  MODEL_VALUE_SEPARATOR,
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
}

export function encodeModelValue(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}${MODEL_VALUE_SEPARATOR}${model.id}`
}

/** The FULL config-option set (ACP config updates carry the whole set, never a
 * delta). A `select` needs a required `currentValue`, so an option is omitted
 * rather than synthesizing one: no current model, or no thinking levels. */
export function buildConfigOptions(input: ConfigOptionsInput): SessionConfigOption[] {
  const options: SessionConfigOption[] = []

  if (input.currentModel !== undefined && input.models.length > 0) {
    options.push({
      type: 'select',
      id: CONFIG_ID_MODEL,
      name: CONFIG_NAME_MODEL,
      category: CONFIG_ID_MODEL,
      currentValue: encodeModelValue(input.currentModel),
      options: input.models.map((model) => ({ value: encodeModelValue(model), name: model.name })),
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
