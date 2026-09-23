import { NextRequest, NextResponse } from 'next/server'
import { deletePost, getAccountToken, liveIdsFromError } from '@/lib/db'
import { deleteThreadsPosts } from '@/lib/threads'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Deletes a queued or failed post. Parts of a broken chain that are still live
 * on Threads are deleted too (needs threads_delete); any that can't be come
 * back in still_live so they can be removed by hand.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()
  const id = Number((await context.params).id)
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'invalid post id' }, { status: 400 })

  const result = deletePost(id)
  if (!result.ok) return NextResponse.json({ deleted: false, error: result.reason }, { status: result.reason === 'post not found' ? 404 : 409 })

  const live = result.post.status === 'published' ? [] : liveIdsFromError(result.post.error)
  const account = live.length ? getAccountToken(result.post.account_id) : null
  const stillLive = !live.length ? [] : account ? await deleteThreadsPosts(live, account.token) : live
  return NextResponse.json({ deleted: true, post_id: id, threads_deleted: live.length - stillLive.length, still_live: stillLive })
}
