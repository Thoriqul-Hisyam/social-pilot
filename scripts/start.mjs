/** Starts the standalone build from the project root.
 *  server.js chdirs into .next/standalone, so relative paths and .env files
 *  would resolve there (a fresh empty DB, no secrets). Pin both to the root first.
 *  --with-worker also runs scripts/worker.mjs alongside (npm start does; systemd
 *  doesn't, since socialpilot-worker.timer already ticks there). */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const root = process.cwd()
createRequire(import.meta.url)('@next/env').loadEnvConfig(root, false)
process.env.DATABASE_PATH = resolve(root, process.env.DATABASE_PATH || './data/socialpilot.db')

if (process.argv.includes('--with-worker')) {
  const worker = spawn(process.execPath, [resolve(root, 'scripts/worker.mjs')], { cwd: root, stdio: 'inherit' })
  process.on('exit', () => worker.kill())
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0))
}

await import(pathToFileURL(resolve(root, '.next/standalone/server.js')).href)
