import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SCOPES = 'threads_basic,threads_content_publish,threads_manage_replies,threads_delete'

export async function GET() {
  const appId = process.env.META_THREADS_APP_ID
  const redirectUri = process.env.THREADS_REDIRECT_URI
  if (!appId || !redirectUri)
    return NextResponse.json(
      { error: 'META_THREADS_APP_ID and THREADS_REDIRECT_URI must be set' },
      { status: 500 },
    )

  const url = new URL('https://threads.net/oauth/authorize')
  url.searchParams.set('client_id', appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('response_type', 'code')
  return NextResponse.redirect(url)
}
