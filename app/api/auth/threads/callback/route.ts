import { NextRequest, NextResponse } from 'next/server'
import { upsertAccount } from '@/lib/db'
import { fetchProfile } from '@/lib/threads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const err = request.nextUrl.searchParams.get('error_description')

  if (err) {
    return new NextResponse(`Threads OAuth error: ${err}`, { status: 400 })
  }

  if (!code) {
    return new NextResponse('Missing OAuth code', { status: 400 })
  }

  const appId = process.env.META_THREADS_APP_ID
  const appSecret = process.env.META_THREADS_APP_SECRET
  const redirectUri = process.env.THREADS_REDIRECT_URI

  if (!appId || !appSecret || !redirectUri) {
    return NextResponse.json(
      { error: 'Threads app env vars not configured' },
      { status: 500 },
    )
  }

  const shortRes = await fetch(
    'https://graph.threads.net/oauth/access_token',
    {
      method: 'POST',
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
    },
  )

  const short = await shortRes.json()

  if (!shortRes.ok || !short.access_token) {
    return NextResponse.json(
      { step: 'short_token', details: short },
      { status: 400 },
    )
  }

  const debugProfileRes = await fetch(
    `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(short.access_token)}`,
  )

  const debugProfile = await debugProfileRes.json()

  console.error(
    'Short token profile test:',
    JSON.stringify({
      status: debugProfileRes.status,
      data: debugProfile,
    }),
  )

  const longRes = await fetch(
    'https://graph.threads.net/access_token?' +
      new URLSearchParams({
        grant_type: 'th_exchange_token',
        client_secret: appSecret,
        access_token: short.access_token,
      }),
  )

  const long = await longRes.json()

  console.error(
    'Threads token exchange:',
    JSON.stringify({
      shortStatus: shortRes.status,
      shortKeys: Object.keys(short),
      longStatus: longRes.status,
      longKeys: Object.keys(long),
      longError: long.error ?? null,
    }),
  )

  const token =
    longRes.ok && long.access_token
      ? long.access_token
      : short.access_token

  const expiresAt =
    longRes.ok && long.expires_in
      ? new Date(Date.now() + long.expires_in * 1000).toISOString()
      : null

  const profile = await fetchProfile(token)

  const id = upsertAccount({
    platform: 'threads',
    external_id: profile.id,
    username: profile.username,
    access_token: token,
    token_expires_at: expiresAt,
  })

  const publicOrigin = process.env.PUBLIC_APP_URL?.replace(/\/$/, '')

  if (!publicOrigin) {
    return NextResponse.json(
      { error: 'PUBLIC_APP_URL is not configured' },
      { status: 500 },
    )
  }

  const home = new URL('/', publicOrigin)
  home.searchParams.set(
    'connected',
    profile.username || String(id),
  )

  return NextResponse.redirect(home)
}
