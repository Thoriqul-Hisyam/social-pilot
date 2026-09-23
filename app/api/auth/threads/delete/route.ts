import { NextResponse } from 'next/server'

// Meta pings this on a data deletion request. Must return a confirmation URL + code.
// ponytail: no real deletion queue — single-tenant, data lives only in .env.local.
// Add a real job + status page when multi-account storage lands.
export async function POST() {
  const base = (process.env.THREADS_REDIRECT_URI || '').replace('/api/auth/threads/callback', '')
  const code = Date.now().toString(36)
  return NextResponse.json({ url: `${base}/api/auth/threads/delete?code=${code}`, confirmation_code: code })
}

export async function GET() {
  return NextResponse.json({ status: 'deletion request received' })
}
