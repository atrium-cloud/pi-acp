import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// Pi stays external: the adapter spawns its RPC entry as a subprocess and only
// ever imports its types, which esbuild erases. A value import would survive as
// a runtime external import and pull Pi into the adapter process, so the bundle
// is checked for one. The bare specifier string is allowed: `src/pi/launch.ts`
// resolves it to the entry path without importing it.
const OUTFILE = 'dist/index.js'
const PI_VALUE_IMPORT = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@earendil-works\/pi-coding-agent/

await build({
  entryPoints: ['src/index.ts'],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@earendil-works/pi-coding-agent'],
})

if (PI_VALUE_IMPORT.test(await readFile(OUTFILE, 'utf8'))) {
  throw new Error(`${OUTFILE} imports pi-coding-agent; upstream Pi code must stay out of the adapter process`)
}
