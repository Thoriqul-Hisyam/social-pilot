import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { OAUTH_STATE_COOKIE, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SCOPES = 'threads_basic,threads_content_publish,threads_manage_replies,threads_delete,threads_manage_insights'

/**
 * Only a logged-in dashboard user may start a connect. The random state goes
 * to Meta and into a short-lived cookie; the callback accepts the code only
 * when both match, so nobody can push their own account into this dashboard.
 */
export async function GET(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()

  const appId = process.env.META_THREADS_APP_ID
  const redirectUri = process.env.THREADS_REDIRECT_URI
  if (!appId || !redirectUri)
    return NextResponse.json(
      { error: 'META_THREADS_APP_ID and THREADS_REDIRECT_URI must be set' },
      { status: 500 },
    )

  const state = randomBytes(24).toString('base64url')
  const url = new URL('https://threads.net/oauth/authorize')
  url.searchParams.set('client_id', appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)

  const res = NextResponse.redirect(url)
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',   // lax, so the cookie comes back on Meta's top-level redirect
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth/threads',
    maxAge: 10 * 60,
  })
  return res
}
