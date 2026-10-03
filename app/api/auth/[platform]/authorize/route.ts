import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { isPlatform } from '@/lib/db'
import { ADAPTERS } from '@/lib/platforms'
import { OAUTH_STATE_COOKIE, hasValidSession, redirectUriFor, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Starts connecting an account of /api/auth/<platform>/authorize. Only a
 * logged-in dashboard user may start one. The random state goes to the
 * platform and into a short-lived cookie scoped to this platform's routes; the
 * callback accepts the code only when both match, so nobody can push their own
 * account into this dashboard.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  if (!hasValidSession(request)) return unauthorized()
  const { platform } = await ctx.params
  const adapter = isPlatform(platform) ? ADAPTERS[platform] : undefined
  if (!adapter || !isPlatform(platform)) return NextResponse.json({ error: `platform ${platform} is not supported` }, { status: 404 })

  const redirectUri = redirectUriFor(platform)
  const missing = [...adapter.missingEnv(), ...(redirectUri ? [] : ['PUBLIC_APP_URL'])]
  if (missing.length)
    return NextResponse.json({ error: `${adapter.label} belum dikonfigurasi: isi ${missing.join(', ')} di .env lalu restart app` }, { status: 500 })

  const state = randomBytes(24).toString('base64url')
  const res = NextResponse.redirect(adapter.authorizeUrl({ state, redirectUri: redirectUri! }))
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',   // lax, so the cookie comes back on the platform's top-level redirect
    secure: process.env.NODE_ENV === 'production',
    path: `/api/auth/${platform}`,
    maxAge: 10 * 60,
  })
  return res
}
