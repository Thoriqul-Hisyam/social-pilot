import { NextRequest, NextResponse } from 'next/server'
import { activity, isPlatform } from '@/lib/db'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Posts per Jakarta day and every account's queue, for the dashboard home and charts:
 * ?days=1-90 (default 14). ?platform=threads|instagram|facebook and ?account=<id>
 * narrow the days, as they narrow /api/insights; the accounts are always all of them.
 */
export async function GET(request: NextRequest) {
  if (!hasValidSession(request) && !hasValidApiKey(request)) return unauthorized()
  const q = new URL(request.url).searchParams
  const platform = q.get('platform') || null
  if (platform !== null && !isPlatform(platform))
    return NextResponse.json({ error: 'platform must be threads, instagram or facebook' }, { status: 400 })
  const account = q.get('account') ? Number(q.get('account')) : null
  if (account !== null && !Number.isInteger(account))
    return NextResponse.json({ error: 'account must be an account id' }, { status: 400 })
  const days = Math.min(Math.max(Math.floor(Number(q.get('days'))) || 14, 1), 90)
  return NextResponse.json(activity(days, platform, account))
}
