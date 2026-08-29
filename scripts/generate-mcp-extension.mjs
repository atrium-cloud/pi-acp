// Bundles the MCP extension into a single self-contained ESM string and writes
// it as a TypeScript module the adapter imports. Pi loads extensions with jiti
// from the temp file's own path, and the release bundle ships without any
// node_modules, so the bundle must resolve nothing at runtime but Node builtins.
//
// Run explicitly at the front of build, typecheck, test, and start: bun does
// not run npm pre-hooks.

import { writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'src/mcp/extension-entry.ts'
const OUTFILE = 'src/mcp/extension-bundle.generated.mjs'
const GENERATED_MODULE = resolve(ROOT, 'src/mcp/extensionSource.generated.ts')
const EXPORT_NAME = 'MCP_EXTENSION_SOURCE'
// cross-spawn is CJS and reaches the stdio transport; esbuild's ESM output stubs
// `require` with a thrower without this shim.
const BANNER = 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);'
const PI_PACKAGE_SCOPE = '@earendil-works'
const SCOPED_IMPORT = /from\s*"@/
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

const result = await build({
  entryPoints: [resolve(ROOT, ENTRY)],
  outfile: resolve(ROOT, OUTFILE),
  bundle: true,
  platform: 'node',
  format: 'esm',
  minify: true,
  banner: { js: BANNER },
  metafile: true,
  write: false,
})

const output = result.outputFiles?.[0]
if (output === undefined) throw new Error(`esbuild produced no output for ${ENTRY}`)
const code = output.text

// The load-bearing check: anything esbuild left unresolved would be looked up in
// a node_modules that does not exist next to the materialized extension.
for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  for (const imported of meta.imports) {
    if (BUILTINS.has(imported.path)) continue
    throw new Error(`${file} imports "${imported.path}" (${imported.kind}); the MCP extension must resolve nothing but Node builtins`)
  }
}
if (code.includes(PI_PACKAGE_SCOPE)) throw new Error(`${OUTFILE} mentions ${PI_PACKAGE_SCOPE}; upstream Pi code must stay out of the extension`)
if (SCOPED_IMPORT.test(code)) throw new Error(`${OUTFILE} still imports a scoped package; the extension must be self-contained`)

writeFileSync(
  GENERATED_MODULE,
  [
    `// Generated from ${ENTRY} by scripts/generate-mcp-extension.mjs. Do not edit.`,
    `export const ${EXPORT_NAME} = ${JSON.stringify(code)}`,
    '',
  ].join('\n'),
  'utf8',
)

process.stdout.write(`${relative(ROOT, GENERATED_MODULE)}: ${code.length} bytes\n`)
