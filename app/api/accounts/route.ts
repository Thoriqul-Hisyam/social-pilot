import { NextRequest, NextResponse } from 'next/server'
import { listAccounts, setAccountEnabled } from '@/lib/db'
import { hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  // token column is never selected — safe to return as-is
  return NextResponse.json({ accounts: listAccounts() })
}

export async function PATCH(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const { id, enabled } = await request.json().catch(() => ({}))
  if (typeof id !== 'number' || typeof enabled !== 'boolean')
    return NextResponse.json({ error: 'id (number) and enabled (boolean) required' }, { status: 400 })
  setAccountEnabled(id, enabled)
  return NextResponse.json({ ok: true })
}
