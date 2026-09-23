import { NextRequest, NextResponse } from 'next/server'
import { retryPost } from '@/lib/db'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()
  const id = Number((await context.params).id)
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'invalid post id' }, { status: 400 })

  const result = retryPost(id)
  if (!result.ok) return NextResponse.json({ retried: false, error: result.reason }, { status: result.reason === 'post not found' ? 404 : 409 })
  return NextResponse.json({ retried: true, post_id: id, message: 'post dijadwalkan ulang sekarang' })
}