import { accountsDueForRefresh, logEvent, markTokenChecked, markTokenInvalid, updateAccountToken } from './db'
import { isInvalidToken, refreshLongLivedToken } from './threads'

/**
 * Threads rejected the account's token (code 190). Its queue waits instead of
 * burning every post's attempts; a reconnect or a successful refresh resumes it.
 * Logs once per pause.
 */
export function pauseForInvalidToken(accountId: number, error: unknown) {
  const name = markTokenInvalid(accountId)
  if (name) logEvent({
    agent: 'publisher', to_agent: 'observer', kind: 'error',
    message: `Token @${name} ditolak Threads; antrean akun ini dijeda sampai akun dihubungkan ulang. ${error}`,
  })
}

/**
 * Keeps every enabled account's token alive without a reconnect. Runs on each
 * worker tick; accountsDueForRefresh limits it to about one call per account a week.
 * Never throws: a failed refresh must not stop publishing while the old token still works.
 */
export async function refreshDueTokens() {
  let due: ReturnType<typeof accountsDueForRefresh>
  try { due = accountsDueForRefresh() } catch (e) { console.error(`token refresh: ${e}`); return }
  for (const a of due) {
    const name = `@${a.username || a.id}`
    try {
      markTokenChecked(a.id)
      const { token, expiresAt } = await refreshLongLivedToken(a.token)
      updateAccountToken(a.id, token, expiresAt)
      logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'done', message: `Token ${name} diperpanjang s/d ${expiresAt.slice(0, 10)}.` })
    } catch (e) {
      if (isInvalidToken(e)) pauseForInvalidToken(a.id, e)
      else logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'error', message: `Token ${name} gagal diperpanjang: ${e}. Dicoba lagi 12 jam lagi; hubungkan ulang akun kalau terus gagal.` })
    }
  }
}
