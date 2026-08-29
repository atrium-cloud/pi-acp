import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// Pi stays external: the adapter spawns its RPC entry as a subprocess and only
// ever imports its types, which esbuild erases. A value import would survive as
// a runtime external import and pull Pi into the adapter process, so the bundle
// is checked for any mention of the package.
const OUTFILE = 'dist/index.js'

await build({
  entryPoints: ['src/index.ts'],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@earendil-works/pi-coding-agent'],
})

if ((await readFile(OUTFILE, 'utf8')).includes('pi-coding-agent')) {
  throw new Error(`${OUTFILE} references pi-coding-agent; upstream Pi code must stay out of the bundle`)
}
