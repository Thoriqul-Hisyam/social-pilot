import { NextRequest, NextResponse } from 'next/server'
import { claimDuePosts } from '@/lib/db'
import { publishClaimed } from '@/lib/publish'
import { refreshDueTokens } from '@/lib/tokens'
import { collectInsights } from '@/lib/insights'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Publishes at most one due post per account per call, accounts side by side.
 * Call it on a short cron (every 5 min); the random gaps live in the
 * scheduled_at column, so the tick itself stays dumb and safe to run often.
 *
 * Returns {published:false, reason:'nothing_due'} when idle — callers should
 * treat that as success and stay silent. Otherwise results holds one entry
 * per post, and the status is 502 if any of them failed.
 *
 * Token refresh and insight reading ride on the same cron, before the queue,
 * so they run even when nothing is due.
 */
export async function POST(request: NextRequest) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()

  await refreshDueTokens()
  await collectInsights()
  const posts = claimDuePosts()
  if (!posts.length) return NextResponse.json({ published: false, reason: 'nothing_due' })

  const results = await Promise.all(posts.map(publishClaimed))
  const failed = results.some(r => !r.published && !r.paused && !r.deferred_min)
  return NextResponse.json({ published: results.some(r => r.published), results }, { status: failed ? 502 : 200 })
}
