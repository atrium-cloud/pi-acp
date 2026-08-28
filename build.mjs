import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// The Pi package is a type-only devDependency; a release bundle must never
// reference it.
const OUTFILE = 'dist/index.js'
const FORBIDDEN_BUNDLE_REFERENCES = ['pi-coding-agent']

await build({
  entryPoints: ['src/index.ts'],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
})

const bundled = await readFile(OUTFILE, 'utf8')
for (const reference of FORBIDDEN_BUNDLE_REFERENCES) {
  if (bundled.includes(reference)) {
    throw new Error(`${OUTFILE} references ${reference}; upstream Pi code must stay out of the bundle`)
  }
}
