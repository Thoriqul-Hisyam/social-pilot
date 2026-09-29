import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'node:crypto'
import { safeEqual } from './crypto'

const COOKIE = 'sp_session'
const MAX_AGE = 60 * 60 * 24 * 7 // 7 days

function sign(value: string): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32)
    throw new Error('SESSION_SECRET must be set to a random string of at least 32 chars')
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function createSession(): { name: string; value: string; options: object } {
  const payload = `${Date.now() + MAX_AGE * 1000}`
  return {
    name: COOKIE,
    value: `${payload}.${sign(payload)}`,
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: MAX_AGE,
    },
  }
}

export function hasValidSession(request: NextRequest): boolean {
  const raw = request.cookies.get(COOKIE)?.value
  if (!raw) return false
  const [payload, mac] = raw.split('.')
  if (!payload || !mac) return false
  try {
    if (!safeEqual(mac, sign(payload))) return false
    return Number(payload) > Date.now()
  } catch {
    return false
  }
}

export function checkPassword(input: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD
  if (!expected || expected.length < 8) return false
  try {
    return safeEqual(input, expected)
  } catch {
    return false
  }
}

/**
 * Machine-to-machine auth for the cron poster.
 * Header: Authorization: Bearer <API_KEY>
 */
export function hasValidApiKey(request: NextRequest): boolean {
  const expected = process.env.API_KEY
  if (!expected || expected.length < 16) return false
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  try {
    return safeEqual(token, expected)
  } catch {
    return false
  }
}

export function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

// --- Threads OAuth ------------------------------------------------------------

export const OAUTH_STATE_COOKIE = 'sp_oauth_state'

/** The callback's ?state must match the cookie set when this browser started the connect. */
export function hasValidOAuthState(request: NextRequest): boolean {
  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value
  const got = request.nextUrl.searchParams.get('state')
  if (!expected || !got) return false
  return safeEqual(got, expected)
}

/** Public https origin of the app: PUBLIC_APP_URL, else the origin of THREADS_REDIRECT_URI. */
export function publicOrigin(): string | null {
  const explicit = process.env.PUBLIC_APP_URL?.replace(/\/$/, '')
  if (explicit) return explicit
  try {
    return new URL(process.env.THREADS_REDIRECT_URI ?? '').origin
  } catch {
    return null
  }
}
