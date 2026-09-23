import { NextRequest, NextResponse } from 'next/server'
import { agentStates, listEvents, logEvent } from '@/lib/db'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!hasValidSession(request) && !hasValidApiKey(request)) return unauthorized()
  const limit = Math.min(Number(new URL(request.url).searchParams.get('limit') || 60), 100)
  return NextResponse.json({ agents: agentStates(), events: listEvents(limit) })
}

export async function POST(request: NextRequest) {
  if (!hasValidSession(request) && !hasValidApiKey(request)) return unauthorized()
  const body = await request.json().catch(() => null)
  if (!body || typeof body.agent !== 'string' || typeof body.message !== 'string')
    return NextResponse.json({ error: 'agent and message are required' }, { status: 400 })
  const id = logEvent({ agent: body.agent, message: body.message, to_agent: typeof body.toAgent === 'string' ? body.toAgent : null, kind: typeof body.kind === 'string' ? body.kind : 'info' })
  return NextResponse.json({ id }, { status: 201 })
}

export const POST_DISABLED = false

// Keep the route intentionally small: the worker/cron will be the writer once each role is wired.
void POST_DISABLED
