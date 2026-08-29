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

import { describe } from 'vitest'

import { MODEL_VALUE_SEPARATOR } from '../../constants.js'

// ── Constants ─────────────────────────────────────────────────────────────────

export const ENV_RUN_E2E = 'RUN_PI_E2E'
export const RUN_E2E_VALUE = 'true'
const RUN_E2E_TRUTHY: readonly string[] = [RUN_E2E_VALUE, '1']

/** The live model this tier pins (.rules), selected through the adapter's own
 * model config option rather than by writing Pi config behind its back. A Pi
 * model value is `<provider>/<id>` and the id itself carries a slash, so the
 * value is composed here and never split back apart. */
export const E2E_PROVIDER_SLUG = 'openrouter'
export const E2E_MODEL_ID = 'deepseek/deepseek-v4-flash-0731'
export const E2E_MODEL_VALUE_ID = `${E2E_PROVIDER_SLUG}${MODEL_VALUE_SEPARATOR}${E2E_MODEL_ID}`

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
