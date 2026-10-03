import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PUBLIC = [
  '/login',
  '/api/login',
  '/api/health',                     // uptime probes and container healthchecks
  '/api/auth/threads/deauthorize',   // called server-to-server by Meta
  '/api/auth/threads/delete',        // called server-to-server by Meta
]

/** The browser returns here from Meta; the route checks session + OAuth state itself. */
const OAUTH_CALLBACK = /^\/api\/auth\/[a-z]+\/callback$/

/**
 * Everything is private by default, including starting an OAuth connect.
 * Meta's server-to-server callbacks stay public because Meta cannot carry our
 * session cookie; the OAuth callbacks verify session and state themselves.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PUBLIC.some(p => pathname.startsWith(p)) || OAUTH_CALLBACK.test(pathname)) return NextResponse.next()

  // Bearer key for the cron poster — verified properly inside the route.
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return NextResponse.next()

  const cookie = request.cookies.get('sp_session')?.value
  if (cookie) return NextResponse.next()   // signature verified in the route via hasValidSession

  if (pathname.startsWith('/api/'))
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const login = request.nextUrl.clone()
  login.pathname = '/login'
  login.search = `?next=${encodeURIComponent(pathname)}`
  return NextResponse.redirect(login)
}

export const config = {
  // Never auth-protect Next internals. In dev this includes HMR WebSocket;
  // returning JSON 401 there breaks the WebSocket handshake and Cloudflared logs
  // "malformed HTTP response \\"Unauthorized\\"".
  matcher: ['/((?!_next|favicon.ico).*)'],
}
