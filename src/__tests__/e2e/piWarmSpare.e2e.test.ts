/**
 * Live-Pi warm spare: a settled prompt starts a spare Pi, and the next matching
 * `session/new` takes it instead of starting one. Its own adapter boot, since
 * the spare is an adapter-wide setting. Skipped unless RUN_PI_E2E=true (see
 * e2eGate.ts).
 */

import * as acp from '@agentclientprotocol/sdk'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

import { AGENT_NAME, ENV_PI_TIMING, ENV_WARM_SPARE_MAX_AGE_MS, PI_TIMING_ON } from '../../constants.js'
import { describeE2E, E2E_BOOT_AND_TURN_TIMEOUT_MS, E2E_SETUP_TIMEOUT_MS } from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createSpawnedAgent, openPinnedSession } from './spawnedAgentFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Long enough that the spare cannot expire inside the case. */
const SPARE_MAX_AGE_MS = '600000'
const ECHO_MARKER = 'pi-e2e-spare-ok'
const ECHO_PROMPT = `Reply with exactly ${ECHO_MARKER} and nothing else.`
/** Only the session id and mode are read: the stderr scrub may rewrite the rest. */
const TIMING_LINE = new RegExp(`^\\[${AGENT_NAME}\\] \\[([^\\]]+)\\] startup timing \\{"mode":"(\\w+)"`)
const POLL_INTERVAL_MS = 50

interface TimingLine {
  readonly sessionId: string
  readonly mode: string
}

describeE2E('pi live warm spare', () => {
  let agent: SpawnedAgent | null = null

  beforeAll(async () => {
    agent = await createSpawnedAgent({
      env: { [ENV_WARM_SPARE_MAX_AGE_MS]: SPARE_MAX_AGE_MS, [ENV_PI_TIMING]: PI_TIMING_ON },
    })
  }, E2E_SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await agent?.stop()
  }, E2E_SETUP_TIMEOUT_MS)

  function live(): SpawnedAgent {
    if (agent === null) throw new Error('e2e: the adapter for this file never booted')
    return agent
  }

  async function promptOn(sessionId: string, text: string): Promise<PromptResponse> {
    return await live().agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    })
  }

  it(
    'takes the spare a settled prompt started for the next session/new in the same cwd',
    async () => {
      const agent = live()
      const first = await agent.agent.request(acp.methods.agent.session.new, { cwd: agent.workspace, mcpServers: [] })
      // A built-in settles without a model call, and any settled prompt refills.
      expect((await promptOn(first.sessionId, '/session')).stopReason).toBe('end_turn')
      const spare = await vi.waitFor(
        () => {
          const line = timingLines(agent).find((candidate) => candidate.mode === 'spare')
          if (line === undefined) throw new Error('no spare has started yet')
          return line
        },
        { timeout: E2E_SETUP_TIMEOUT_MS, interval: POLL_INTERVAL_MS },
      )

      const takenId = await openPinnedSession(agent)

      expect(takenId).toBe(spare.sessionId)
      expect(takenId).not.toBe(first.sessionId)
      expect(timingLines(agent).filter((line) => line.mode === 'take')).toEqual([{ sessionId: takenId, mode: 'take' }])
      expect((await promptOn(takenId, ECHO_PROMPT)).stopReason).toBe('end_turn')
      expect(agent.agentText(takenId)).toContain(ECHO_MARKER)
    },
    E2E_BOOT_AND_TURN_TIMEOUT_MS,
  )
})

function timingLines(agent: SpawnedAgent): TimingLine[] {
  return agent
    .logDump()
    .split('\n')
    .flatMap((line) => {
      const match = TIMING_LINE.exec(line)
      const sessionId = match?.[1]
      const mode = match?.[2]
      return sessionId === undefined || mode === undefined ? [] : [{ sessionId, mode }]
    })
}
