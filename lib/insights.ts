import { getAccountToken, logEvent, postsNeedingInsights, saveMetrics, saveMetricsError, saveMetricsGone } from './db'
import { fetchPostInsights, isDeletedOnThreads, isInvalidToken, isMissingPermission } from './threads'
import { pauseForInvalidToken } from './tokens'

/**
 * Posts read per worker tick. 20 × 288 ticks = 5760 a day: ~100 new posts need
 * ~2000 (8 reads on day one, 2 a day for the week), and the rest clears the
 * backlog of never-read history in a few hours after a reconnect.
 */
const PER_TICK = 20
const HOUR_MS = 3_600_000

// Until the account is reconnected with threads_manage_insights, every read fails alike.
// Wait an hour between tries instead of spending a batch each tick, and say so once.
let blockedUntil = 0
// Per-post failures are stored on the post; the crew feed hears of them at most hourly.
let lastFailureNotice = 0

/**
 * Reads Threads insights for the posts that need them. Runs on each worker tick.
 * Sequential, so a missing permission costs one call, not a batch. Never throws.
 */
export async function collectInsights(limit = PER_TICK) {
  if (Date.now() < blockedUntil) return
  let due: ReturnType<typeof postsNeedingInsights>
  try { due = postsNeedingInsights(limit) } catch (e) { console.error(`insights: ${e}`); return }
  const tokens = new Map<number, string | null>()
  const failed: string[] = []
  const gone: string[] = []
  for (const p of due) {
    if (!tokens.has(p.account_id)) tokens.set(p.account_id, getAccountToken(p.account_id)?.token ?? null)
    const token = tokens.get(p.account_id)
    if (!token) continue
    try {
      saveMetrics(p.id, await fetchPostInsights(p.media_id, token))
    } catch (e) {
      if (isMissingPermission(e)) {
        blockedUntil = Date.now() + HOUR_MS
        logEvent({
          agent: 'publisher', to_agent: 'observer', kind: 'error',
          message: `Insight belum bisa dibaca: token akun belum membawa izin threads_manage_insights. Hubungkan ulang akun (Tambah akun Threads) dan setujui izin insight. ${e}`,
        })
        return
      }
      if (isInvalidToken(e)) { pauseForInvalidToken(p.account_id, e); tokens.set(p.account_id, null); continue }
      const deleted = isDeletedOnThreads(e)
      if (deleted) gone.push(`#${p.id}`)
      else failed.push(`#${p.id}: ${e}`)
      try { (deleted ? saveMetricsGone : saveMetricsError)(p.id, String(e)) } catch (e2) { console.error(`insights: post ${p.id}: ${e2}`) }
    }
  }
  // Each post is marked once, so this needs no throttle.
  if (gone.length) logEvent({
    agent: 'publisher', to_agent: 'observer', kind: 'info',
    message: `${gone.length} post sudah dihapus di Threads, tidak dibaca lagi dan tidak dihitung di Performa: ${gone.join(', ')}`,
  })
  if (failed.length && Date.now() - lastFailureNotice > HOUR_MS) {
    lastFailureNotice = Date.now()
    logEvent({
      agent: 'publisher', to_agent: 'observer', kind: 'error',
      message: `Insight ${failed.length} dari ${due.length} post gagal dibaca; dicoba lagi nanti. Contoh ${failed[0]}`,
    })
  }
}
