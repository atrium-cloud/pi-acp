import {
  AGENT_NAME,
  ORIGIN_OVERRIDES_EXTENSION_FILENAME,
  ORIGIN_OVERRIDES_MATCHED_PROTOCOL,
  UNDICI_GLOBAL_DISPATCHER_KEY,
} from '../constants.js'
import { materializeExtension } from '../pi/extensionFile.js'

export const originOverridesLogLine = (hosts: readonly string[]): string =>
  `[${AGENT_NAME}] origin overrides: ${hosts.length} host(s): ${hosts.join(', ')}`

// The extension wraps the undici global dispatcher Pi's provider SDKs fetch
// through, rewriting only a matched request's origin. Pi installs a fresh
// dispatcher after extensions load, so the wrap is re-asserted before every
// provider call. The resolved table is baked in; the extension reads no env.
export function originOverridesExtensionSource(overrides: ReadonlyMap<string, string>): string {
  const missingDispatcher = `${AGENT_NAME} origin overrides extension: no undici global dispatcher at Symbol.for(${JSON.stringify(UNDICI_GLOBAL_DISPATCHER_KEY)})`
  return [
    `const OVERRIDES = new Map(${JSON.stringify([...overrides])})`,
    `const MATCHED_PROTOCOL = ${JSON.stringify(ORIGIN_OVERRIDES_MATCHED_PROTOCOL)}`,
    `const DISPATCHER_KEY = Symbol.for(${JSON.stringify(UNDICI_GLOBAL_DISPATCHER_KEY)})`,
    `const INNER = Symbol('originOverridesInner')`,
    `function overrideFor(origin) {`,
    `  const url = new URL(String(origin))`,
    `  return url.protocol === MATCHED_PROTOCOL ? OVERRIDES.get(url.host) : undefined`,
    `}`,
    `function ensureWrapped() {`,
    `  const inner = globalThis[DISPATCHER_KEY]`,
    `  if (inner === undefined) throw new Error(${JSON.stringify(missingDispatcher)})`,
    `  if (inner[INNER] !== undefined) return`,
    `  globalThis[DISPATCHER_KEY] = {`,
    `    [INNER]: inner,`,
    `    dispatch(options, handler) {`,
    `      const origin = overrideFor(options.origin)`,
    `      return inner.dispatch(origin === undefined ? options : { ...options, origin }, handler)`,
    `    },`,
    `    close: (...args) => inner.close(...args),`,
    `    destroy: (...args) => inner.destroy(...args),`,
    `  }`,
    `}`,
    `export default function (pi) {`,
    // A throw here fails the extension load, and Pi's RPC mode exits on that.
    `  ensureWrapped()`,
    `  console.error(${JSON.stringify(originOverridesLogLine([...overrides.keys()]))})`,
    // Pi reports a throw from this handler as an extension error and still
    // sends the request, so the load-time check is the one that stops Pi.
    `  pi.on('before_provider_headers', ensureWrapped)`,
    `}`,
    '',
  ].join('\n')
}

/** Writes the extension only when there is something to override. */
export function materializeOriginOverridesExtension(overrides: ReadonlyMap<string, string>): string | undefined {
  if (overrides.size === 0) return undefined
  return materializeExtension(ORIGIN_OVERRIDES_EXTENSION_FILENAME, originOverridesExtensionSource(overrides))
}
