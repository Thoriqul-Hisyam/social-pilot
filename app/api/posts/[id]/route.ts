import { NextRequest, NextResponse } from 'next/server'
import { deletePost, findPost, getAccountToken, liveIdsFromError } from '@/lib/db'
import { ADAPTERS } from '@/lib/platforms'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Deletes a post. A published one is deleted on its platform first, every part
 * of a Threads chain included, and its record only goes once that worked; on a
 * refusal it stays, with the reason in error. Instagram's API cannot delete, so
 * there only the record goes (manual: true). A post the platform already reports
 * deleted just loses its record.
 * A queued or failed post loses its record, and parts of a broken Threads chain
 * still live are deleted too; any that can't be come back in still_live.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()
  const id = Number((await context.params).id)
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'invalid post id' }, { status: 400 })

  const post = findPost(id)
  if (!post) return NextResponse.json({ deleted: false, error: 'post not found' }, { status: 404 })
  if (post.status === 'publishing') return NextResponse.json({ deleted: false, error: 'post sedang dikirim, tunggu selesai' }, { status: 409 })

  const account = getAccountToken(post.account_id)
  const adapter = account ? ADAPTERS[account.platform] : undefined

  if (post.status === 'published') {
    const ids: string[] = JSON.parse(post.external_ids ?? '[]')
    let platformDeleted = 0
    if (!post.gone_at && ids.length) {
      if (!account || !adapter) return NextResponse.json({ deleted: false, error: 'akun post ini nonaktif atau hilang; aktifkan dulu supaya post bisa dihapus di platformnya' }, { status: 409 })
      if (!adapter.deletePosts) {
        deletePost(id)
        return NextResponse.json({ deleted: true, post_id: id, platform_deleted: 0, manual: true })
      }
      const { live, errors } = await adapter.deletePosts(ids, account.token)
      if (live.length) return NextResponse.json({ deleted: false, error: `${adapter.label}: ${errors[0] ?? 'gagal menghapus'}`, still_live: live }, { status: 502 })
      platformDeleted = ids.length
    }
    deletePost(id)
    return NextResponse.json({ deleted: true, post_id: id, platform_deleted: platformDeleted })
  }

  const result = deletePost(id)
  if (!result.ok) return NextResponse.json({ deleted: false, error: result.reason }, { status: result.reason === 'post not found' ? 404 : 409 })
  const live = liveIdsFromError(post.error)
  const remove = live.length && account ? adapter?.deletePosts : undefined
  const stillLive = !live.length ? [] : remove ? (await remove(live, account!.token)).live : live
  return NextResponse.json({ deleted: true, post_id: id, platform_deleted: live.length - stillLive.length, still_live: stillLive })
}
