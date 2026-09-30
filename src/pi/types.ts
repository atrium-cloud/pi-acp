// The one non-test module in src/ that names the dev-only Pi package. Top-level
// `import type` only (an inline `import { type X }` emits a live import esbuild
// would bundle); build.mjs fails if `dist/index.js` mentions pi-coding-agent.
import type { RpcResponse } from '@earendil-works/pi-coding-agent'

export type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  JsonAgentSessionEvent,
  SessionStats,
} from '@earendil-works/pi-coding-agent'

/** Pi's `PromptDisposition`, which the package root does not re-export. */
export type PromptDisposition = Extract<RpcResponse, { command: 'prompt'; success: true }>['data']['disposition']
