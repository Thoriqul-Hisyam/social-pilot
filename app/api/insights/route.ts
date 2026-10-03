import { NextRequest, NextResponse } from 'next/server'
import { insightsSummary, isPlatform, isPostKind } from '@/lib/db'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Post performance for the dashboard and the crew: ?days=1-90 (default 7),
 * ?kind=news|affiliate (default both), ?platform=threads|instagram|facebook
 * (default all), ?account=<id> (default all). Numbers come from the worker's insight readings, so they lag
 * the platforms by up to 12 hours.
 */
export async function GET(request: NextRequest) {
  if (!hasValidSession(request) && !hasValidApiKey(request)) return unauthorized()
  const q = new URL(request.url).searchParams
  const kind = q.get('kind') || null
  if (kind !== null && !isPostKind(kind))
    return NextResponse.json({ error: 'kind must be news or affiliate' }, { status: 400 })
  const platform = q.get('platform') || null
  if (platform !== null && !isPlatform(platform))
    return NextResponse.json({ error: 'platform must be threads, instagram or facebook' }, { status: 400 })
  const account = q.get('account') ? Number(q.get('account')) : null
  if (account !== null && !Number.isInteger(account))
    return NextResponse.json({ error: 'account must be an account id' }, { status: 400 })
  const days = Math.min(Math.max(Math.floor(Number(q.get('days'))) || 7, 1), 90)
  return NextResponse.json(insightsSummary(days, kind, platform, account))
}
