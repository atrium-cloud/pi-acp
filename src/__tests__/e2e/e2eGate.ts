/**
 * The env gate for the live-Pi tier. These suites spawn the BUILT adapter
 * against the host's real Pi and spend real provider tokens, so they never run
 * under the default `bun run test`: every suite registers through `describeE2E`,
 * which skips unless `RUN_PI_E2E=true` (the `test:e2e` script sets it).
 *
 * The tier carries no credential of its own. Pi has no non-interactive way to
 * hand a stored credential to a scratch agent dir, so the host's own Pi install
 * — its auth store and model list — is what a live run authenticates against;
 * only the session store is redirected to scratch (spawnedAgentFixture.ts).
 * Setup failure therefore surfaces as the model pin being refused, which is the
 * loud signal that this machine's Pi is not authorized for the pinned provider.
 */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { describe } from 'vitest'

import { CONFIG_ID_MODEL } from '../../constants.js'

// ── Constants ─────────────────────────────────────────────────────────────────

export const ENV_RUN_E2E = 'RUN_PI_E2E'
export const RUN_E2E_VALUE = 'true'
const RUN_E2E_TRUTHY: readonly string[] = [RUN_E2E_VALUE, '1']

/** The live model this tier pins (.rules), selected through the adapter's own
 * model config option rather than by writing Pi config behind its back. A model
 * value is the bare id unless another provider offers the same id, so the exact
 * string depends on the host's model list and must be read back from the
 * adapter's own option set. */
export const E2E_PROVIDER_SLUG = 'openrouter'
export const E2E_MODEL_ID = 'deepseek/deepseek-v4-flash-0731'

/** Finds the pinned model's value in a returned config-option set: the bare id,
 * or the provider-prefixed form inside the pinned provider's group when the id
 * is shared. Throws when the host's Pi does not offer the pinned model. */
export function pinnedModelValue(configOptions: readonly SessionConfigOption[] | null | undefined): string {
  const select = configOptions?.find((option) => option.id === CONFIG_ID_MODEL)
  if (select?.type !== 'select') throw new Error('model config option missing from session response')
  for (const entry of select.options) {
    // A bare id proves the pinned provider only inside its own group: another
    // provider offering the same id uniquely would carry the same bare value.
    if (!('options' in entry) || entry.group !== E2E_PROVIDER_SLUG) continue
    for (const option of entry.options) {
      if (option.value === E2E_MODEL_ID || option.value.endsWith(`/${E2E_MODEL_ID}`)) return option.value
    }
  }
  throw new Error(`pinned model ${E2E_PROVIDER_SLUG}/${E2E_MODEL_ID} not offered by the host's Pi`)
}

/** One live turn: a provider round-trip on an already warm subprocess. */
export const E2E_TURN_TIMEOUT_MS = 180_000
/** Pi's cold start, which loads the adapter's extensions and reads the host
 * agent dir before it answers the readiness read. */
export const E2E_SETUP_TIMEOUT_MS = 240_000
/** Every case boots its own adapter, so a one-turn case budgets both. */
export const E2E_BOOT_AND_TURN_TIMEOUT_MS = E2E_SETUP_TIMEOUT_MS + E2E_TURN_TIMEOUT_MS

const RUN_PI_E2E = RUN_E2E_TRUTHY.includes(process.env[ENV_RUN_E2E]?.trim().toLowerCase() ?? '')

/** `describe` for the live tier: registered always, executed only when gated in,
 * so the default suite reports these as skipped rather than missing. */
export const describeE2E = describe.skipIf(!RUN_PI_E2E)
