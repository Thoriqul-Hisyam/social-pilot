import { NextResponse } from 'next/server'

// Meta pings this when a user removes the app. No body parsing needed for MVP.
// ponytail: skipped signed_request HMAC verify + token revocation.
// Add when more than one Threads account is connected.
export async function POST() {
  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ ok: true })
}
