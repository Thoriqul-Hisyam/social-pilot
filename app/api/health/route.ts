import { NextResponse } from 'next/server'
import { stats } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Unauthenticated on purpose: for uptime probes and container healthchecks. */
export async function GET() {
  try {
    const s = stats()
    return NextResponse.json({ ok: true, db: 'up', accounts: s.accounts, scheduled: s.scheduled })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 503 })
  }
}
