import { getAccountToken, logEvent, postsNeedingInsights, saveMetrics, saveMetricsError, saveMetricsGone, type AccountCredentials } from './db'
import { isGone, isInvalidToken, isMissingPermission, isRateLimited, NetworkError } from './errors'
import { ADAPTERS } from './platforms'
import { pauseForInvalidToken } from './tokens'

/**
 * Posts read per worker tick. 20 × 288 ticks = 5760 a day: ~100 new posts need
 * ~2000 (8 reads on day one, 2 a day for the week), and the rest clears the
 * backlog of never-read history in a few hours after a reconnect.
 */
const PER_TICK = 20
const HOUR_MS = 3_600_000

// An account whose token lacks the insights permission fails every read alike, as does
// one over its rate limit. It waits an hour instead of spending a batch each tick.
const blockedUntil = new Map<number, number>()
// Per-post failures are stored on the post; the crew feed hears of them at most hourly.
let lastFailureNotice = 0
// A dropped connection is the server's, not the post's: nothing is stored, the next tick tries again.
let lastOfflineNotice = 0

/**
 * Reads insights for the posts that need them, from each post's platform. Runs on
 * each worker tick. Sequential, so a missing permission or a dropped connection
 * costs one call, not a batch. Never throws.
 */
export async function collectInsights(limit = PER_TICK) {
  const now = Date.now()
  for (const [id, until] of blockedUntil) if (until <= now) blockedUntil.delete(id)
  let due: ReturnType<typeof postsNeedingInsights>
  try { due = postsNeedingInsights(limit, [...blockedUntil.keys()]) } catch (e) { console.error(`insights: ${e}`); return }
  const accounts = new Map<number, AccountCredentials | null>()
  const failed: string[] = []
  const gone: string[] = []
  let offline: unknown = null
  for (const p of due) {
    const adapter = ADAPTERS[p.platform]
    if (!adapter || blockedUntil.has(p.account_id)) continue
    try {
      if (!accounts.has(p.account_id)) accounts.set(p.account_id, getAccountToken(p.account_id))
      const account = accounts.get(p.account_id)
      if (!account) continue
      saveMetrics(p.id, await adapter.fetchInsights(p.media_id, account))
    } catch (e) {
      if (isMissingPermission(e) || isRateLimited(e)) {
        blockedUntil.set(p.account_id, Date.now() + HOUR_MS)
        if (isMissingPermission(e)) logEvent({
          agent: 'publisher', to_agent: 'observer', kind: 'error',
          message: `Insight ${adapter.label} belum bisa dibaca: token akun belum membawa izin insight. Hubungkan ulang akun dan setujui izin insight. ${e}`,
        })
        continue
      }
      if (isInvalidToken(e)) { pauseForInvalidToken(p.account_id, e); accounts.set(p.account_id, null); continue }
      if (e instanceof NetworkError) { offline = e; break }
      const deleted = isGone(e)
      if (deleted) gone.push(`#${p.id}`)
      else failed.push(`#${p.id}: ${e}`)
      try { (deleted ? saveMetricsGone : saveMetricsError)(p.id, String(e)) } catch (e2) { console.error(`insights: post ${p.id}: ${e2}`) }
    }
  }
  // Each post is marked once, so this needs no throttle.
  if (gone.length) logEvent({
    agent: 'publisher', to_agent: 'observer', kind: 'info',
    message: `${gone.length} post sudah dihapus di platformnya, tidak dibaca lagi dan tidak dihitung di Performa: ${gone.join(', ')}`,
  })
  if (failed.length && Date.now() - lastFailureNotice > HOUR_MS) {
    lastFailureNotice = Date.now()
    logEvent({
      agent: 'publisher', to_agent: 'observer', kind: 'error',
      message: `Insight ${failed.length} dari ${due.length} post gagal dibaca; dicoba lagi nanti. Contoh ${failed[0]}`,
    })
  }
  if (offline && Date.now() - lastOfflineNotice > HOUR_MS) {
    lastOfflineNotice = Date.now()
    logEvent({
      agent: 'publisher', to_agent: 'observer', kind: 'error',
      message: `Insight berhenti sementara: server tidak tersambung ke platform. Tidak ada post yang dihitung gagal; dicoba lagi tiap tick. ${offline}`,
    })
  }
}
