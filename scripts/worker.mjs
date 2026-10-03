/** Local stand-in for deploy/socialpilot-worker.timer: POSTs /api/worker/tick
 *  every WORKER_INTERVAL_MIN minutes (default 5). A tick publishes at most one
 *  post per account, so the next one waits for the previous to finish — never overlaps. */
import { createRequire } from 'node:module'

createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd(), false)

const url = `http://127.0.0.1:${process.env.PORT || 3000}/api/worker/tick`
const interval = Number(process.env.WORKER_INTERVAL_MIN || 5) * 60_000
const key = process.env.API_KEY
if (!key) { console.error('[worker] API_KEY kosong di .env — worker tidak jalan'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const stamp = () => new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })

async function tick() {
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })
    const data = await res.json().catch(() => ({}))
    if (data.reason === 'nothing_due') return
    if (!data.results) return console.log(`[worker ${stamp()}] tick gagal: ${data.error ?? res.status}`)
    for (const r of data.results) {
      const where = r.platform ? ` ${r.platform}` : ''
      if (r.published) console.log(`[worker ${stamp()}] post #${r.id} terbit di${where} (${r.parts} bagian)`)
      else if (r.paused) console.log(`[worker ${stamp()}] post #${r.id} menunggu akun dihubungkan ulang`)
      else if (r.deferred_min) console.log(`[worker ${stamp()}] post #${r.id} ditunda ${r.deferred_min} menit: batas${where}`)
      else console.log(`[worker ${stamp()}] post #${r.id}${where} gagal: ${r.error ?? res.status}`)
    }
  } catch (e) {
    console.log(`[worker ${stamp()}] server belum bisa dihubungi: ${e.cause?.code ?? e.message}`)
  }
}

console.log(`[worker] tick tiap ${interval / 60_000} menit ke ${url}`)
await sleep(10_000) // let the server come up first
for (;;) {
  await tick()
  await sleep(interval)
}
