import type { SessionConfigOption, SessionConfigSelectGroup } from '@agentclientprotocol/sdk'

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

/** Values over the whole list in one pass, so a string already handed to one
 * model is never handed to another. Deterministic for a given list order, and
 * every caller (build and resolve) computes over the same list. */
function computeModelValues(models: readonly ModelChoice[]): Map<ModelChoice, string> {
  const idCounts = new Map<string, number>()
  for (const model of models) idCounts.set(model.id, (idCounts.get(model.id) ?? 0) + 1)
  const taken = new Set<string>()
  const values = new Map<ModelChoice, string>()
  for (const model of models) {
    let value =
      idCounts.get(model.id) === 1 ? model.id : `${model.provider}${MODEL_VALUE_SEPARATOR}${model.id}`
    // Pathological guard: another model's value already claimed this string
    // (e.g. provider "deepseek" with id "x" vs a bare id "deepseek/x").
    while (taken.has(value)) value = `${model.provider}${MODEL_VALUE_SEPARATOR}${value}`
    taken.add(value)
    values.set(model, value)
  }
  return values
}

export function encodeModelValue(
  model: { readonly provider: string; readonly id: string },
  models: readonly ModelChoice[],
): string {
  for (const [candidate, value] of computeModelValues(models)) {
    if (candidate.provider === model.provider && candidate.id === model.id) return value
  }
  // Not in the list: nothing to disambiguate against, so the bare id it is.
  return model.id
}

/** The FULL config-option set (ACP config updates carry the whole set, never a
 * delta). A `select` needs a required `currentValue`, so an option is omitted
 * rather than synthesizing one: no current model, or no thinking levels.
 * Models are grouped by provider so the provider appears once as a header
 * rather than repeated in every value. */
export function buildConfigOptions(input: ConfigOptionsInput): SessionConfigOption[] {
  const options: SessionConfigOption[] = []

  if (input.currentModel !== undefined && input.models.length > 0) {
    const values = computeModelValues(input.models)
    const groups: SessionConfigSelectGroup[] = []
    for (const model of input.models) {
      let group = groups.find((candidate) => candidate.group === model.provider)
      if (group === undefined) {
        group = { group: model.provider, name: model.provider, options: [] }
        groups.push(group)
      }
      group.options.push({ value: values.get(model) ?? model.id, name: model.name })
    }
    options.push({
      type: 'select',
      id: CONFIG_ID_MODEL,
      name: CONFIG_NAME_MODEL,
      category: CONFIG_ID_MODEL,
      currentValue: encodeModelValue(input.currentModel, input.models),
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
  const values = computeModelValues(models)
  const model = models.find((candidate) => values.get(candidate) === value)
  return model === undefined ? undefined : { provider: model.provider, modelId: model.id }
}
