import { NextRequest, NextResponse } from 'next/server'
import { upsertAccount } from '@/lib/db'
import { LONG_LIVED_SEC, fetchProfile } from '@/lib/threads'
import { OAUTH_STATE_COOKIE, hasValidOAuthState, hasValidSession, publicOrigin } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (message: string, status = 400) =>
  new NextResponse(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

export async function GET(request: NextRequest) {
  const err = request.nextUrl.searchParams.get('error_description')
  if (err) return fail(`Threads OAuth error: ${err}`)

  const origin = publicOrigin()
  // Meta redirects the same browser back here, so the login cookie and the state
  // cookie from /authorize both arrive. Without them, this connect was not started
  // from this dashboard.
  if (!hasValidSession(request) || !hasValidOAuthState(request))
    return fail(
      'Sesi login atau state OAuth tidak cocok. Buka dashboard lewat ' +
      `${origin ?? 'domain THREADS_REDIRECT_URI'} (bukan localhost/IP), login, lalu klik "Tambah akun Threads" lagi.`,
    )

  const code = request.nextUrl.searchParams.get('code')
  if (!code) return fail('Missing OAuth code')

  const appId = process.env.META_THREADS_APP_ID
  const appSecret = process.env.META_THREADS_APP_SECRET
  const redirectUri = process.env.THREADS_REDIRECT_URI
  if (!appId || !appSecret || !redirectUri || !origin)
    return fail('META_THREADS_APP_ID, META_THREADS_APP_SECRET and THREADS_REDIRECT_URI must be set', 500)

  const shortRes = await fetch('https://graph.threads.net/oauth/access_token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    }),
  })
  const short = await shortRes.json().catch(() => ({}))
  if (!shortRes.ok || !short.access_token)
    return fail(`Threads short token: ${short.error?.message ?? short.error_message ?? `HTTP ${shortRes.status}`}`)

  // A short token dies within an hour, so never store one: every later publish would fail.
  const longRes = await fetch('https://graph.threads.net/access_token?' + new URLSearchParams({
    grant_type: 'th_exchange_token',
    client_secret: appSecret,
    access_token: short.access_token,
  }))
  const long = await longRes.json().catch(() => ({}))
  if (!longRes.ok || !long.access_token) {
    console.error('Threads long-lived token exchange failed:', JSON.stringify({ status: longRes.status, error: long.error ?? null }))
    return fail(
      `Gagal menukar ke token 60 hari: ${long.error?.message ?? `HTTP ${longRes.status}`}. ` +
      'Akun tidak disimpan; periksa META_THREADS_APP_SECRET lalu hubungkan ulang.',
      502,
    )
  }

  const profile = await fetchProfile(long.access_token)
  const id = upsertAccount({
    platform: 'threads',
    external_id: profile.id,
    username: profile.username,
    access_token: long.access_token,
    token_expires_at: new Date(Date.now() + (Number(long.expires_in) || LONG_LIVED_SEC) * 1000).toISOString(),
  })

  const home = new URL('/', origin)
  home.searchParams.set('connected', profile.username || String(id))
  const res = NextResponse.redirect(home)
  res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: '/api/auth/threads' })
  return res
}
