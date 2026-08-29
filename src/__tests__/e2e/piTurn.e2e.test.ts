/**
 * Live-Pi turn behavior: the cases that cannot be observed against a scripted
 * subprocess because they depend on a real model, a real provider endpoint, and
 * a real session file on disk.
 *
 * Skipped unless RUN_PI_E2E=true (see e2eGate.ts); `bun run test:e2e` builds
 * first and sets it.
 */

import { rmSync } from 'node:fs'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import {
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
} from '../../constants.js'
import { describeE2E, E2E_BOOT_AND_TURN_TIMEOUT_MS, E2E_SETUP_TIMEOUT_MS, E2E_TURN_TIMEOUT_MS } from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createScratchPaths, createSpawnedAgent, openPinnedSession } from './spawnedAgentFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

/** A marker the model can reproduce exactly, so the assertion is about the turn
 * arriving intact rather than about model prose. */
const ECHO_MARKER = 'pi-e2e-ok'
const ECHO_PROMPT = `Reply with exactly ${ECHO_MARKER} and nothing else.`

/** Long enough that the cancel lands mid-turn rather than after it. */
const LONG_PROMPT = 'Count from 1 to 300, one number per line, with no other text.'

/** Drives the gate: `bash` is one of the mutating built-ins it intercepts. */
const TOOL_MARKER = 'pi-e2e-tool'
const TOOL_PROMPT = `Use your bash tool to run \`echo ${TOOL_MARKER}\` and tell me the output.`

/** `usage_update` is emitted, not awaited, at the end of a turn, so it can land
 * just after the prompt response. */
const USAGE_SETTLE_MS = 10_000
const POLL_INTERVAL_MS = 50

const CANCEL_SETTLE_MS = 2_000

describeE2E('pi live turns', () => {
  let fixture: SpawnedAgent | null = null
  /** Scratch this suite created itself (the two-process case); the fixture only
   * removes scratch it owns, so this is the other half. */
  let sharedScratchRoot: string | null = null

  afterEach(async () => {
    await fixture?.stop()
    fixture = null
    if (sharedScratchRoot !== null) {
      rmSync(sharedScratchRoot, { recursive: true, force: true })
      sharedScratchRoot = null
    }
  })

  it(
    'streams a turn from the pinned model, ends it with end_turn, and reports usage',
    async () => {
      fixture = await createSpawnedAgent()
      const agent = fixture
      const sessionId = await openPinnedSession(agent)

      const response = await agent.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: ECHO_PROMPT }],
      })

      expect(response.stopReason).toBe('end_turn')
      expect(agent.agentText(sessionId)).toContain(ECHO_MARKER)

      // Synthesized from Pi's post-turn context stats; Pi has no usage event of
      // its own, so this is the whole of the ACP usage surface.
      await vi.waitFor(
        () => {
          const usage = agent.updates.filter(
            (notification) =>
              notification.sessionId === sessionId && notification.update.sessionUpdate === 'usage_update',
          )
          expect(usage.length).toBeGreaterThan(0)
        },
        { timeout: USAGE_SETTLE_MS, interval: POLL_INTERVAL_MS },
      )
    },
    E2E_BOOT_AND_TURN_TIMEOUT_MS,
  )

  it(
    'reports a cancelled turn as cancelled, not as a clean end_turn',
    async () => {
      fixture = await createSpawnedAgent()
      const agent = fixture
      const sessionId = await openPinnedSession(agent)

      const pending = agent.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: LONG_PROMPT }],
      })
      // Attached up front: an early provider error would otherwise reject with no
      // handler and surface as an unhandled rejection rather than a test failure.
      const cancelled = expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      // Cancel only once the turn is actually streaming; a cancel before the
      // prompt ack would test the pre-start path instead.
      await agent.waitForText(sessionId, (text) => text.length > 0, E2E_TURN_TIMEOUT_MS)
      await agent.agent.notify(acp.methods.agent.session.cancel, { sessionId })

      await cancelled
      // The adapter keeps running: a cancel ends the turn, not the process.
      await new Promise((settle) => setTimeout(settle, CANCEL_SETTLE_MS))
      expect(agent.child.exitCode).toBeNull()
    },
    E2E_BOOT_AND_TURN_TIMEOUT_MS,
  )

  it(
    'routes a real tool call through the permission gate, which fails closed',
    async () => {
      fixture = await createSpawnedAgent()
      const agent = fixture
      const sessionId = await openPinnedSession(agent)

      // What the model says after a denial is its own business; the contract is
      // that the gate asked before the tool ran, and that the turn settled.
      await agent.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: TOOL_PROMPT }],
      })

      const requests = agent.permissionRequests.filter((request) => request.sessionId === sessionId)
      expect(requests.length).toBeGreaterThan(0)
      expect(requests[0]?.options.map((option) => option.optionId)).toEqual([
        PERMISSION_OPTION_ALLOW_ONCE,
        PERMISSION_OPTION_ALLOW_ALWAYS,
        PERMISSION_OPTION_REJECT_ONCE,
      ])
    },
    E2E_BOOT_AND_TURN_TIMEOUT_MS,
  )

  it(
    'replays real persisted history to a second adapter process',
    async () => {
      // The stored session lives in the scratch session store, so the reload has
      // to be a different adapter process against the SAME store: a load on the
      // process that created the session reuses the live subprocess and proves
      // nothing about persistence.
      const paths = createScratchPaths()
      sharedScratchRoot = paths.root
      const first = await createSpawnedAgent({ paths })
      let sessionId: string
      try {
        sessionId = await openPinnedSession(first)
        const response = await first.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: ECHO_PROMPT }],
        })
        expect(response.stopReason).toBe('end_turn')
      } finally {
        await first.stop()
      }

      fixture = await createSpawnedAgent({ paths })
      const agent = fixture
      await agent.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: paths.workspace,
        mcpServers: [],
      })

      // The replay precedes the response, so the transcript is already in hand.
      const replayed = agent.updates
        .filter((notification) => notification.sessionId === sessionId)
        .map((notification) => notification.update)
      expect(
        replayed.some(
          (update) =>
            update.sessionUpdate === 'user_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text.includes(ECHO_MARKER),
        ),
      ).toBe(true)

      const listed = await agent.agent.request(acp.methods.agent.session.list, { cwd: paths.workspace })
      expect(listed.sessions.map((session) => session.sessionId)).toContain(sessionId)
    },
    // Two adapter boots against one session store, plus the turn the first runs.
    2 * E2E_SETUP_TIMEOUT_MS + E2E_TURN_TIMEOUT_MS,
  )
})
