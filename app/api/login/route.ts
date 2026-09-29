import { NextRequest, NextResponse } from 'next/server'
import { checkPassword, createSession } from '@/lib/auth'

// ponytail: in-memory rate limit, resets on restart and is per-process.
// Fine for a single-node deploy; move to Redis if you ever run replicas.
const attempts = new Map<string, { n: number; until: number }>()
const MAX = 5
const WINDOW = 15 * 60 * 1000

function blocked(ip: string): boolean {
  const rec = attempts.get(ip)
  if (!rec) return false
  if (Date.now() > rec.until) { attempts.delete(ip); return false }
  return rec.n >= MAX
}

function record(ip: string) {
  const rec = attempts.get(ip)
  if (!rec || Date.now() > rec.until) attempts.set(ip, { n: 1, until: Date.now() + WINDOW })
  else rec.n++
}

/**
 * The client can send any X-Forwarded-For it likes; nginx and Cloudflare only
 * append the real address at the end. So key on the last hop, never the first.
 */
function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'local'
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  if (blocked(ip))
    return NextResponse.json({ error: 'too many attempts, try again later' }, { status: 429 })

  const { password } = await request.json().catch(() => ({ password: '' }))
  if (typeof password !== 'string' || !checkPassword(password)) {
    record(ip)
    return NextResponse.json({ error: 'wrong password' }, { status: 401 })
  }

  attempts.delete(ip)
  const session = createSession()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(session.name, session.value, session.options)
  return res
}
