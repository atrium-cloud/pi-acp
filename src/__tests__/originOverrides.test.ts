import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ORIGIN_OVERRIDES_EXTENSION_FILENAME, UNDICI_GLOBAL_DISPATCHER_KEY } from '../constants.js'
import {
  materializeOriginOverridesExtension,
  originOverridesExtensionSource,
  originOverridesLogLine,
} from '../network/originOverrides.js'

interface DispatchOptions {
  readonly origin: string
  readonly path: string
  readonly method: string
  readonly headers: Record<string, string>
}
interface Dispatcher {
  dispatch(options: DispatchOptions, handler: unknown): boolean
  close(): Promise<void>
  destroy(): Promise<void>
}
type EventHandler = () => void
type ExtensionFactory = (pi: { on: (event: string, handler: EventHandler) => void }) => void
interface Handlers {
  readonly sessionStart: EventHandler
  readonly beforeProviderCall: EventHandler
}

const OVERRIDE_ORIGIN = 'http://127.0.0.1:3129'
const PORTED_OVERRIDE_ORIGIN = 'https://gateway.example.test'
const OVERRIDES = new Map([
  ['opencode.ai', OVERRIDE_ORIGIN],
  ['api.example.test:8443', PORTED_OVERRIDE_ORIGIN],
])
const DISPATCHER_KEY = Symbol.for(UNDICI_GLOBAL_DISPATCHER_KEY)
const globals = globalThis as unknown as Record<symbol, Dispatcher | undefined>

/** An inner dispatcher that records what reaches it. */
function recordingDispatcher(): Dispatcher & { readonly received: DispatchOptions[]; readonly calls: string[] } {
  const received: DispatchOptions[] = []
  const calls: string[] = []
  return {
    received,
    calls,
    dispatch: (options) => {
      received.push(options)
      return true
    },
    close: async () => {
      calls.push('close')
    },
    destroy: async () => {
      calls.push('destroy')
    },
  }
}

function request(origin: string): DispatchOptions {
  return { origin, path: '/zen/go/v1/messages?beta=true', method: 'POST', headers: { 'x-api-key': 'not-a-real-key' } }
}

function current(): Dispatcher {
  const dispatcher = globals[DISPATCHER_KEY]
  if (dispatcher === undefined) throw new Error('no global dispatcher installed')
  return dispatcher
}

let dir: string
let factory: ExtensionFactory
let savedDispatcher: Dispatcher | undefined

// Imported from a real file, the way Pi loads it, so the shipped source runs.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-acp-origin-overrides-'))
  const path = join(dir, ORIGIN_OVERRIDES_EXTENSION_FILENAME)
  writeFileSync(path, originOverridesExtensionSource(OVERRIDES), 'utf8')
  factory = ((await import(/* @vite-ignore */ pathToFileURL(path).href)) as { default: ExtensionFactory }).default
})

// Node's own undici may hold this slot as a non-configurable property, so it is
// only ever reassigned, never deleted.
beforeEach(() => {
  savedDispatcher = globals[DISPATCHER_KEY]
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  globals[DISPATCHER_KEY] = savedDispatcher
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Installs `inner` as Pi's dispatcher, loads the extension, and returns the
 * `session_start` and `before_provider_headers` handlers it registered. */
function load(inner: Dispatcher): Handlers {
  globals[DISPATCHER_KEY] = inner
  const registered = new Map<string, EventHandler>()
  factory({
    on: (event, handler) => {
      registered.set(event, handler)
    },
  })
  const sessionStart = registered.get('session_start')
  const beforeProviderCall = registered.get('before_provider_headers')
  if (sessionStart === undefined || beforeProviderCall === undefined) {
    throw new Error(`extension registered handlers for ${JSON.stringify([...registered.keys()])}`)
  }
  return { sessionStart, beforeProviderCall }
}

describe('the origin overrides extension', () => {
  it('sends a matched https request to the override origin with its own path, method and headers', () => {
    const inner = recordingDispatcher()
    load(inner)
    current().dispatch(request('https://opencode.ai'), {})
    expect(inner.received).toEqual([{ ...request('https://opencode.ai'), origin: OVERRIDE_ORIGIN }])
  })

  it('matches a non-443 port only against the host entry that carries it', () => {
    const inner = recordingDispatcher()
    load(inner)
    current().dispatch(request('https://api.example.test:8443'), {})
    current().dispatch(request('https://api.example.test'), {})
    current().dispatch(request('https://opencode.ai:443'), {})
    expect(inner.received.map((options) => options.origin)).toEqual([
      PORTED_OVERRIDE_ORIGIN,
      'https://api.example.test',
      OVERRIDE_ORIGIN,
    ])
  })

  it('passes an http request and an unmatched host through untouched', () => {
    const inner = recordingDispatcher()
    load(inner)
    const plain = request('http://opencode.ai')
    const unmatched = request('https://api.openai.com')
    current().dispatch(plain, {})
    current().dispatch(unmatched, {})
    expect(inner.received[0]).toBe(plain)
    expect(inner.received[1]).toBe(unmatched)
  })

  it('delegates close and destroy to the dispatcher it wraps', async () => {
    const inner = recordingDispatcher()
    load(inner)
    await current().close()
    await current().destroy()
    expect(inner.calls).toEqual(['close', 'destroy'])
  })

  it('wraps the dispatcher Pi installs after load at session_start, ahead of its catalog refresh', () => {
    const onLoad = recordingDispatcher()
    const { sessionStart } = load(onLoad)
    // What Pi's configureHttpDispatcher leaves in the slot through setGlobalDispatcher.
    const installed = recordingDispatcher()
    globals[DISPATCHER_KEY] = installed

    sessionStart()
    current().dispatch(request('https://opencode.ai'), {})

    expect(installed.received.map((options) => options.origin)).toEqual([OVERRIDE_ORIGIN])
    expect(onLoad.received).toEqual([])
  })

  it('wraps a dispatcher Pi installs after load before the next provider call, once', () => {
    const onLoad = recordingDispatcher()
    const { beforeProviderCall } = load(onLoad)
    const replacement = recordingDispatcher()
    globals[DISPATCHER_KEY] = replacement

    beforeProviderCall()
    const wrapper = current()
    beforeProviderCall()
    expect(current()).toBe(wrapper)

    wrapper.dispatch(request('https://opencode.ai'), {})
    expect(replacement.received.map((options) => options.origin)).toEqual([OVERRIDE_ORIGIN])
    expect(onLoad.received).toEqual([])
  })

  it('fails the load, naming the extension and the dispatcher, when none is installed', () => {
    globals[DISPATCHER_KEY] = undefined
    expect(() => factory({ on: () => {} })).toThrow(
      `origin overrides extension: no undici global dispatcher at Symbol.for("${UNDICI_GLOBAL_DISPATCHER_KEY}")`,
    )
  })

  it('logs one line at load naming the hosts, never the origins', () => {
    load(recordingDispatcher())
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(originOverridesLogLine([...OVERRIDES.keys()]))
    expect(originOverridesLogLine([...OVERRIDES.keys()])).not.toContain(OVERRIDE_ORIGIN)
  })
})

describe('materializeOriginOverridesExtension', () => {
  it('writes nothing when no override is configured', () => {
    expect(materializeOriginOverridesExtension(new Map())).toBeUndefined()
  })

  it('writes the extension source for the configured overrides', () => {
    const path = materializeOriginOverridesExtension(OVERRIDES)
    if (path === undefined) throw new Error('expected an extension path')
    expect(basename(path)).toBe(ORIGIN_OVERRIDES_EXTENSION_FILENAME)
    expect(readFileSync(path, 'utf8')).toBe(originOverridesExtensionSource(OVERRIDES))
    // The build purity guard greps the bundle for the dev-only Pi package.
    expect(originOverridesExtensionSource(OVERRIDES)).not.toContain('pi-coding-agent')
    rmSync(path, { force: true })
  })
})
