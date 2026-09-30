import { NextRequest, NextResponse } from 'next/server'
import { claimDuePost, getAccountToken, logEvent, markFailed, markPublished } from '@/lib/db'
import { ChainBrokenError, publishToThreads } from '@/lib/threads'
import { rehostImage } from '@/lib/media'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Publishes at most one due post per call. Call it on a short cron
 * (every 5 min); the random gaps live in the scheduled_at column, so the
 * tick itself stays dumb and safe to run often.
 *
 * Returns {published:false, reason:'nothing_due'} when idle — callers should
 * treat that as success and stay silent.
 */
export async function POST(request: NextRequest) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()

  const post = claimDuePost()
  if (!post) return NextResponse.json({ published: false, reason: 'nothing_due' })
  logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'working', message: `Mengirim post #${post.id} ke Threads.`, post_id: post.id })

  const account = getAccountToken(post.account_id)
  if (!account) {
    const error = 'account missing or disabled'
    markFailed(post.id, error, 3, false)
    logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'error', message: `Post #${post.id} gagal: akun hilang atau nonaktif.`, post_id: post.id })
    return NextResponse.json({ published: false, post_id: post.id, error, retryable: false, can_retry: false }, { status: 409 })
  }

  try {
    const ids = await publishToThreads({
      text: post.caption,
      imageUrl: post.image_url ? await rehostImage(post.image_url) : undefined,
      videoUrl: post.video_url ?? undefined,
      userId: account.external_id,
      token: account.token,
    })
    markPublished(post.id, ids)
    logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'done', message: `Post #${post.id} terbit di Threads (${ids.length} bagian).`, post_id: post.id })
    return NextResponse.json({ published: true, id: post.id, post_ids: ids, parts: ids.length })
  } catch (e) {
    const error = String(e)
    // A broken chain is deleted again, so it can retry from the root. If some parts
    // could not be deleted, fail at once: a retry would repost them. Retry by hand after deleting.
    const stuck = e instanceof ChainBrokenError && e.liveIds.length > 0
    // Setup errors do not pass with time, so fail at once, but keep them retryable by hand for after the fix.
    const setup = ['missing Threads credentials', 'R2 not configured']
    const permanent = ['empty post', 'image or video required', 'not both', 'unsupported image format', 'image too large']
    const retryable = !permanent.some(p => error.includes(p))
    const needsSetup = setup.some(p => error.includes(p))
    markFailed(post.id, error, stuck || needsSetup || !retryable ? 1 : 3, retryable)
    const willRetry = retryable && !stuck && !needsSetup && post.attempts < 3
    logEvent({ agent: 'publisher', to_agent: 'observer', kind: 'error', message: `Post #${post.id} gagal${willRetry ? ', dicoba lagi' : ''}: ${error}`, post_id: post.id })
    return NextResponse.json({ published: false, id: post.id, error, retryable, can_retry: willRetry, attempts: post.attempts }, { status: 502 })
  }
}
