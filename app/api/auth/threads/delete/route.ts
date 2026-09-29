import { NextResponse } from 'next/server'
import { publicOrigin } from '@/lib/auth'

// Meta pings this on a data deletion request. Must return a confirmation URL + code.
// ponytail: no real deletion queue — single-tenant, data lives only in .env.local.
// Add a real job + status page when multi-account storage lands.
export async function POST() {
  const code = Date.now().toString(36)
  return NextResponse.json({ url: `${publicOrigin() ?? ''}/api/auth/threads/delete?code=${code}`, confirmation_code: code })
}

export async function GET() {
  return NextResponse.json({ status: 'deletion request received' })
}
