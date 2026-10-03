import { NextRequest, NextResponse } from 'next/server'
import { listAccounts, listGroups, setAccountEnabled, setAccountRouting } from '@/lib/db'
import { platformList } from '@/lib/platforms'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Accounts and their groups, plus every platform that can be connected and the env it still lacks.
 * The API key may read it too (Hermes checks the routing); changes stay dashboard-only.
 */
export async function GET(request: NextRequest) {
  if (!hasValidSession(request) && !hasValidApiKey(request)) return unauthorized()
  // token columns are never selected — safe to return as-is
  return NextResponse.json({ accounts: listAccounts(), groups: listGroups(), platforms: platformList() })
}

/** {id, enabled?, auto_news?, auto_affiliate?}: any of the three booleans. Group membership is set on the group (/api/groups). */
export async function PATCH(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const { id, enabled, auto_news, auto_affiliate } = await request.json().catch(() => ({}))
  const flag = (v: unknown) => v === undefined || typeof v === 'boolean'
  if (typeof id !== 'number' || !flag(enabled) || !flag(auto_news) || !flag(auto_affiliate)
    || [enabled, auto_news, auto_affiliate].every(v => v === undefined))
    return NextResponse.json({ error: 'id (number) and at least one of enabled, auto_news, auto_affiliate (boolean) required' }, { status: 400 })
  if (enabled !== undefined) setAccountEnabled(id, enabled)
  if (auto_news !== undefined || auto_affiliate !== undefined) setAccountRouting(id, { auto_news, auto_affiliate })
  return NextResponse.json({ ok: true })
}
