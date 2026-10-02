import { getAccountToken, logEvent, postsNeedingInsights, saveMetrics, saveMetricsError } from './db'
import { fetchPostInsights, isInvalidToken, isMissingPermission } from './threads'
import { pauseForInvalidToken } from './tokens'

/** Posts read per worker tick: 8 × 288 ticks a day covers ~100 new posts read twice daily for a week. */
const PER_TICK = 8
const PERMISSION_RETRY_MS = 3_600_000

// Until the account is reconnected with threads_manage_insights, every read fails alike.
// Wait an hour between tries instead of spending a batch each tick, and say so once.
let blockedUntil = 0

/**
 * Reads Threads insights for the posts that need them. Runs on each worker tick.
 * Sequential, so a missing permission costs one call, not a batch. Never throws.
 */
export async function collectInsights(limit = PER_TICK) {
  if (Date.now() < blockedUntil) return
  let due: ReturnType<typeof postsNeedingInsights>
  try { due = postsNeedingInsights(limit) } catch (e) { console.error(`insights: ${e}`); return }
  const tokens = new Map<number, string | null>()
  for (const p of due) {
    if (!tokens.has(p.account_id)) tokens.set(p.account_id, getAccountToken(p.account_id)?.token ?? null)
    const token = tokens.get(p.account_id)
    if (!token) continue
    try {
      saveMetrics(p.id, await fetchPostInsights(p.media_id, token))
    } catch (e) {
      if (isMissingPermission(e)) {
        blockedUntil = Date.now() + PERMISSION_RETRY_MS
        logEvent({
          agent: 'publisher', to_agent: 'observer', kind: 'error',
          message: `Insight belum bisa dibaca: izin threads_manage_insights belum diberikan. Tambahkan izinnya di app Meta, lalu hubungkan ulang akun. ${e}`,
        })
        return
      }
      if (isInvalidToken(e)) { pauseForInvalidToken(p.account_id, e); tokens.set(p.account_id, null); continue }
      try { saveMetricsError(p.id, String(e)) } catch (e2) { console.error(`insights: post ${p.id}: ${e2}`) }
    }
  }
}
