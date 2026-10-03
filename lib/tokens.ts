import { accountsDueForRefresh, getAccountToken, logEvent, markTokenChecked, markTokenInvalid, updateAccountToken, type Platform } from './db'
import { isInvalidToken } from './errors'
import { ADAPTERS } from './platforms'

const label = (platform: Platform) => ADAPTERS[platform]?.label ?? platform

/**
 * The platform rejected the account's token (Meta code 190). Its queue
 * waits instead of burning every post's attempts; a reconnect or a successful
 * refresh resumes it. Logs once per pause.
 */
export function pauseForInvalidToken(accountId: number, error: unknown) {
  const name = markTokenInvalid(accountId)
  if (!name) return
  const platform = getAccountToken(accountId)?.platform
  logEvent({
    agent: 'publisher', to_agent: 'observer', kind: 'error',
    message: `Token @${name} ditolak ${platform ? label(platform) : 'platform'}; antrean akun ini dijeda sampai akun dihubungkan ulang. ${error}`,
  })
}

/**
 * Keeps every enabled 60-day token (Threads, Instagram) alive without a reconnect.
 * Runs on each worker tick; accountsDueForRefresh limits it to about one call per account a week.
 * Never throws: a failed refresh must not stop publishing while the old token still works.
 */
export async function refreshDueTokens() {
  let due: ReturnType<typeof accountsDueForRefresh>
  try { due = accountsDueForRefresh() } catch (e) { console.error(`token refresh: ${e}`); return }
  for (const a of due) {
    const name = `@${a.username || a.id} (${label(a.platform)})`
    try {
      markTokenChecked(a.id)
      const refresh = ADAPTERS[a.platform]?.refreshLongLived
      if (!refresh) continue
      const { token, expiresAt } = await refresh(a.token)
      updateAccountToken(a.id, token, expiresAt)
      logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'done', message: `Token ${name} diperpanjang s/d ${expiresAt.slice(0, 10)}.` })
    } catch (e) {
      if (isInvalidToken(e)) pauseForInvalidToken(a.id, e)
      else logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'error', message: `Token ${name} gagal diperpanjang: ${e}. Dicoba lagi 12 jam lagi; hubungkan ulang akun kalau terus gagal.` })
    }
  }
}
