import { NextRequest, NextResponse } from 'next/server'
import { isPlatform, upsertAccount } from '@/lib/db'
import { ADAPTERS } from '@/lib/platforms'
import { OAUTH_STATE_COOKIE, hasValidOAuthState, hasValidSession, publicOrigin, redirectUriFor } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (message: string, status = 400) =>
  new NextResponse(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

/** Where the platform sends the browser back. Every account the code grants is stored; a reconnect replaces its token. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params
  const adapter = isPlatform(platform) ? ADAPTERS[platform] : undefined
  if (!adapter || !isPlatform(platform)) return fail(`platform ${platform} is not supported`, 404)

  const q = request.nextUrl.searchParams
  const err = q.get('error_description') ?? q.get('error_message') ?? q.get('error')
  if (err) return fail(`${adapter.label} OAuth error: ${err}`)

  const origin = publicOrigin()
  // The platform redirects the same browser back here, so the login cookie and the
  // state cookie from /authorize both arrive. Without them, this connect was not
  // started from this dashboard.
  if (!hasValidSession(request) || !hasValidOAuthState(request))
    return fail(
      'Sesi login atau state OAuth tidak cocok. Buka dashboard lewat ' +
      `${origin ?? 'domain PUBLIC_APP_URL'} (bukan localhost/IP), login, lalu klik "Hubungkan ${adapter.label}" lagi.`,
    )

  const code = q.get('code')
  if (!code) return fail('Missing OAuth code')
  const redirectUri = redirectUriFor(platform)
  const missing = adapter.missingEnv()
  if (missing.length || !redirectUri || !origin)
    return fail(`${adapter.label} belum dikonfigurasi: isi ${[...missing, ...(origin ? [] : ['PUBLIC_APP_URL'])].join(', ')}`, 500)

  let connected
  try {
    connected = await adapter.connect({ code, redirectUri })
  } catch (e) {
    console.error(`${adapter.label} connect failed:`, String(e))
    return fail(`${String(e).replace(/^Error: /, '')}`, 502)
  }
  const ids = connected.map(a => upsertAccount({ platform, ...a }))

  const home = new URL('/', origin)
  home.searchParams.set('connected', connected.map(a => a.username).filter(Boolean).join(', ') || ids.join(', '))
  const res = NextResponse.redirect(home)
  res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: `/api/auth/${platform}` })
  return res
}
