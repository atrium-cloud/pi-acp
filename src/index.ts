#!/usr/bin/env node

import { AGENT_NAME, AGENT_VERSION } from './constants.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`${AGENT_NAME} ${AGENT_VERSION}`)
    return
  }

  // Transport wiring lands with docs/todos.md section 1; until then the
  // adapter refuses to pretend it can serve ACP.
  throw new Error(`${AGENT_NAME}: the ACP transport is not implemented yet; only --version is supported`)
}

main().catch((error: unknown) => {
  console.error(`[${AGENT_NAME}] fatal: ${errorMessage(error)}`)
  process.exit(1)
})
