import { NextRequest } from 'next/server'
import { publishNow } from '@/lib/publish'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Publishes at once to any connected account: {text, imageUrl|videoUrl, kind, accountId}. */
export async function POST(request: NextRequest) {
  return publishNow(request)
}
