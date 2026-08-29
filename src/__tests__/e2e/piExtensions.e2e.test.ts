/**
 * Live-Pi extension seams: the permission gate's three outcomes, prompt content
 * that is not plain text, the built-in MCP client over stdio, and extension
 * commands.
 *
 * One adapter boot serves the whole file; every case opens its own session, so
 * the gate's per-session `allow_always` memory (which lives in the extension
 * inside each session's own Pi subprocess) never leaks between cases. Skipped
 * unless RUN_PI_E2E=true (see e2eGate.ts).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import * as acp from '@agentclientprotocol/sdk'
import type { McpServer, PromptResponse, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'

import {
  DEFAULT_PI_AGENT_DIR_SEGMENTS,
  ENV_PI_AGENT_DIR,
  EXTENSION_COMMAND_QUIET_MS,
  MCP_TOOL_PREFIX,
  MCP_TOOL_SEPARATOR,
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
} from '../../constants.js'
import { describeE2E, E2E_SETUP_TIMEOUT_MS, E2E_TURN_TIMEOUT_MS } from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createSpawnedAgent, openPinnedSession } from './spawnedAgentFixture.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TOOL_MARKER = 'pi-e2e-tool'
const SECOND_TOOL_MARKER = 'pi-e2e-tool-again'
const toolPrompt = (marker: string): string => `Use your bash tool to run \`echo ${marker}\` and tell me the output.`
/** Bounds a model that would otherwise retry a denied tool in a loop. */
const REJECT_TOOL_PROMPT = `${toolPrompt(TOOL_MARKER)} If the tool fails, do not retry; reply FAILED.`

const IMAGE_PROMPT = 'Describe what you were sent in one word.'
const RESOURCE_MARKER = 'pi-e2e-first-line'
const RESOURCE_URI = 'file:///pi-e2e/note.txt'
const RESOURCE_TEXT = `${RESOURCE_MARKER}\na second line that is not the first`
const RESOURCE_PROMPT = 'What is the first line of the attached file? Reply with just that line.'

/** The bundled probe server (also driven by the snapshot-tier MCP tests). */
const MCP_SERVER_NAME = 'probe'
const MCP_SHAPE_TOOL = `${MCP_TOOL_PREFIX}${MCP_SERVER_NAME}${MCP_TOOL_SEPARATOR}shape`
const MCP_MARKER = 'pi-e2e-mcp'
const MCP_PROMPT = `Use the ${MCP_SHAPE_TOOL} tool with the payload {"a": "${MCP_MARKER}"} and tell me exactly what it returned.`
const PROBE_SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp-probe-server.mjs')
const NODE_COMMAND = 'node'

/** The probe command is installed as a GLOBAL Pi extension, in the host agent
 * dir this tier already authenticates against. Pi's other discovery location,
 * project-local `<cwd>/.pi/extensions`, cannot serve: a non-interactive mode
 * such as `--mode rpc` never asks about trust, so with no saved decision for the
 * directory in `<agent-dir>/trust.json` it follows the global
 * `defaultProjectTrust` setting, whose default `ask` (like `never`) ignores
 * project resources; only `always`, or a `--approve` the adapter does not pass,
 * would load them. The file is transient — a pid-unique name, written for this
 * one case and removed in a finally — but it is a real write into the
 * developer's Pi install, and while it exists every Pi session on this machine
 * advertises the command. */
const PI_EXTENSIONS_DIR_NAME = 'extensions'
const HOME_PREFIX = '~'
const EXTENSION_FILE_NAME = `pi-acp-e2e-probe-${process.pid}.ts`
const EXTENSION_COMMAND_NAME = 'e2eprobe'
const EXTENSION_SOURCE = [
  `export default function (pi) {`,
  `  pi.registerCommand(${JSON.stringify(EXTENSION_COMMAND_NAME)}, {`,
  `    description: 'pi-acp e2e probe command',`,
  `    handler: async () => {},`,
  `  })`,
  `}`,
  '',
].join('\n')
/** A slash command Pi does not know runs as an ordinary prompt, so it carries
 * something the model can answer. */
const UNKNOWN_COMMAND_PROMPT = '/unknowncmd reply with the word ready'

/** A 1x1 truecolor PNG, encoded here rather than pasted as bytes: an image the
 * provider rejects would poison the session it is sent to. */
const CRC32_POLYNOMIAL = 0xedb88320
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_HEADER_BYTES = 13
const PNG_BIT_DEPTH = 8
const PNG_COLOR_TYPE_RGB = 2
/** Filter byte plus one mid-grey pixel. */
const PNG_PIXEL: readonly number[] = [0x00, 0x7f, 0x7f, 0x7f]
const PNG_MIME_TYPE = 'image/png'

const TWO_TURN_TIMEOUT_MS = 2 * E2E_TURN_TIMEOUT_MS
/** The command turn waits out the quiet window before it resolves. */
const EXTENSION_COMMAND_TIMEOUT_MS = 2 * E2E_TURN_TIMEOUT_MS + EXTENSION_COMMAND_QUIET_MS

describeE2E('pi live extension seams', () => {
  // Nullable so a failed boot leaves the teardown with something to check: the
  // real failure should not be buried under a TypeError from afterAll.
  let agent: SpawnedAgent | null = null

  beforeAll(async () => {
    agent = await createSpawnedAgent()
  }, E2E_SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await agent?.stop()
  }, E2E_SETUP_TIMEOUT_MS)

  afterEach(() => {
    agent?.answerPermissions(null)
  })

  /** The booted adapter, or a loud failure naming the boot as the cause. */
  function live(): SpawnedAgent {
    if (agent === null) throw new Error('e2e: the adapter for this file never booted')
    return agent
  }

  async function promptOn(sessionId: string, blocks: acp.ContentBlock[]): Promise<PromptResponse> {
    return await live().agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks })
  }

  async function promptText(sessionId: string, text: string): Promise<PromptResponse> {
    return await promptOn(sessionId, [{ type: 'text', text }])
  }

  function answerWith(optionId: string): RequestPermissionResponse {
    return { outcome: { outcome: 'selected', optionId } }
  }

  function permissionRequestCount(sessionId: string): number {
    return live().permissionRequests.filter((request) => request.sessionId === sessionId).length
  }

  function toolUpdates(sessionId: string, status: 'completed' | 'failed'): string[] {
    return live()
      .sessionUpdates(sessionId)
      .filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === status)
      .map((update) => JSON.stringify(update))
  }

  it(
    'runs a tool the client allows once, and reports it completed',
    async () => {
      const agent = live()
      const sessionId = await openPinnedSession(agent)
      agent.answerPermissions(() => answerWith(PERMISSION_OPTION_ALLOW_ONCE))

      await promptText(sessionId, toolPrompt(TOOL_MARKER))

      expect(permissionRequestCount(sessionId)).toBeGreaterThan(0)
      const completed = toolUpdates(sessionId, 'completed')
      expect(completed.length).toBeGreaterThan(0)
      // The output reaches the client either in the tool row or in the reply.
      expect(completed.join('\n').includes(TOOL_MARKER) || agent.agentText(sessionId).includes(TOOL_MARKER)).toBe(true)
    },
    E2E_TURN_TIMEOUT_MS,
  )

  it(
    'asks once for allow_always and runs the same tool again without asking',
    async () => {
      const agent = live()
      const sessionId = await openPinnedSession(agent)
      agent.answerPermissions(() => answerWith(PERMISSION_OPTION_ALLOW_ALWAYS))

      await promptText(sessionId, toolPrompt(TOOL_MARKER))
      const askedOnce = permissionRequestCount(sessionId)
      const completedOnce = toolUpdates(sessionId, 'completed').length
      expect(askedOnce).toBeGreaterThan(0)

      await promptText(sessionId, toolPrompt(SECOND_TOOL_MARKER))

      // The second turn really ran the tool, and the gate stayed silent for it.
      expect(toolUpdates(sessionId, 'completed').length).toBeGreaterThan(completedOnce)
      expect(permissionRequestCount(sessionId)).toBe(askedOnce)
    },
    TWO_TURN_TIMEOUT_MS,
  )

  it(
    'reports a tool the client rejects as failed',
    async () => {
      const agent = live()
      const sessionId = await openPinnedSession(agent)
      agent.answerPermissions(() => answerWith(PERMISSION_OPTION_REJECT_ONCE))

      await promptText(sessionId, REJECT_TOOL_PROMPT)

      expect(permissionRequestCount(sessionId)).toBeGreaterThan(0)
      expect(toolUpdates(sessionId, 'failed').length).toBeGreaterThan(0)
    },
    E2E_TURN_TIMEOUT_MS,
  )

  it(
    'accepts an image block in a prompt',
    async () => {
      // Its own session: a provider that refuses the image fails this case
      // rather than leaving a rejected image in a transcript other cases share.
      const agent = live()
      const sessionId = await openPinnedSession(agent)

      const response = await promptOn(sessionId, [
        { type: 'image', data: onePixelPng(), mimeType: PNG_MIME_TYPE },
        { type: 'text', text: IMAGE_PROMPT },
      ])

      expect(response.stopReason).toBe('end_turn')
      expect(agent.agentText(sessionId).length).toBeGreaterThan(0)
    },
    E2E_TURN_TIMEOUT_MS,
  )

  it(
    'inlines an embedded text resource so the model can read it',
    async () => {
      const agent = live()
      const sessionId = await openPinnedSession(agent)

      const response = await promptOn(sessionId, [
        { type: 'resource', resource: { uri: RESOURCE_URI, text: RESOURCE_TEXT } },
        { type: 'text', text: RESOURCE_PROMPT },
      ])

      expect(response.stopReason).toBe('end_turn')
      expect(agent.agentText(sessionId)).toContain(RESOURCE_MARKER)
    },
    E2E_TURN_TIMEOUT_MS,
  )

  it(
    'registers an MCP stdio server and gates its tool like a built-in',
    async () => {
      const agent = live()
      const servers: McpServer[] = [
        { name: MCP_SERVER_NAME, command: NODE_COMMAND, args: [PROBE_SERVER], env: [] },
      ]
      const sessionId = await openPinnedSession(agent, { mcpServers: servers })
      agent.answerPermissions(() => answerWith(PERMISSION_OPTION_ALLOW_ONCE))

      await promptText(sessionId, MCP_PROMPT)

      const gated = agent.permissionRequests.filter(
        (request) => request.sessionId === sessionId && (request.toolCall.title ?? '').includes(MCP_SHAPE_TOOL),
      )
      expect(gated.length).toBeGreaterThan(0)
      const completed = toolUpdates(sessionId, 'completed')
      expect(completed.join('\n')).toContain(MCP_MARKER)
    },
    E2E_TURN_TIMEOUT_MS,
  )

  // Last in the file: while this case runs, the probe command is advertised to
  // every session Pi starts on this machine.
  it(
    'advertises a global extension command and settles its prompt without a turn',
    async () => {
      const agent = live()
      const extensionDir = hostExtensionsDir()
      // Only the file is removed afterwards; an extensions dir created here is
      // Pi's own layout and is left in place.
      mkdirSync(extensionDir, { recursive: true })
      const extensionPath = join(extensionDir, EXTENSION_FILE_NAME)
      writeFileSync(extensionPath, EXTENSION_SOURCE, 'utf8')

      try {
        const sessionId = await openPinnedSession(agent)
        await agent.waitForUpdate(
          sessionId,
          (update) =>
            update.sessionUpdate === 'available_commands_update' &&
            update.availableCommands.some((command) => command.name === EXTENSION_COMMAND_NAME),
          E2E_TURN_TIMEOUT_MS,
        )

        // An extension command that starts no turn resolves off the quiet
        // window, with nothing streamed.
        const textBefore = agent.agentText(sessionId).length
        const command = await promptText(sessionId, `/${EXTENSION_COMMAND_NAME}`)
        expect(command.stopReason).toBe('end_turn')
        expect(agent.agentText(sessionId).slice(textBefore)).toBe('')

        // A slash command Pi does not know is just prompt text.
        const unknown = await promptText(sessionId, UNKNOWN_COMMAND_PROMPT)
        expect(unknown.stopReason).toBe('end_turn')
        expect(agent.agentText(sessionId).length).toBeGreaterThan(textBefore)
      } finally {
        rmSync(extensionPath, { force: true })
      }
    },
    EXTENSION_COMMAND_TIMEOUT_MS,
  )
})

/** Pi's global extension directory, under the same agent dir the tier's Pi
 * resolves its credentials from. */
function hostExtensionsDir(): string {
  const configured = process.env[ENV_PI_AGENT_DIR]
  const agentDir =
    configured === undefined || configured === ''
      ? join(homedir(), ...DEFAULT_PI_AGENT_DIR_SEGMENTS)
      : expandHome(configured)
  return join(agentDir, PI_EXTENSIONS_DIR_NAME)
}

/** Pi expands a leading `~` in this variable, so a literal `~` directory must
 * not be created next to the test run instead. */
function expandHome(value: string): string {
  if (value === HOME_PREFIX) return homedir()
  if (value.startsWith(`${HOME_PREFIX}/`)) return join(homedir(), value.slice(HOME_PREFIX.length + 1))
  return value
}

/** Base64 of a 1x1 truecolor PNG built here, so the bytes are a real image. */
function onePixelPng(): string {
  const header = Buffer.alloc(PNG_HEADER_BYTES)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = PNG_BIT_DEPTH
  header[9] = PNG_COLOR_TYPE_RGB
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from(PNG_PIXEL))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, checksum])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? (crc >>> 1) ^ CRC32_POLYNOMIAL : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
