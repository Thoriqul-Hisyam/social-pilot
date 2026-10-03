import { NextRequest, NextResponse } from 'next/server'
import {
  deferPost, getAccountToken, isPostKind, listAccounts, logEvent, markFailed, markPublished, recordPublishedPost, releasePost,
  type Platform, type Post,
} from './db'
import { hasValidApiKey, hasValidSession, unauthorized } from './auth'
import { isInvalidToken, isRateLimited } from './errors'
import { ADAPTERS, adapterFor } from './platforms'
import { ChainBrokenError } from './threads'
import { pauseForInvalidToken } from './tokens'

export type TickResult = {
  published: boolean; id: number; platform?: string; post_ids?: string[]; parts?: number
  error?: string; retryable?: boolean; can_retry?: boolean; attempts?: number; paused?: boolean; deferred_min?: number
}

/** Setup errors do not pass with time, so they fail at once, but stay retryable by hand for after the fix. */
const SETUP = ['missing Threads credentials', 'R2 not configured', 'Cannot find module']
/** Content the platform will never take; retrying cannot help. */
const PERMANENT = ['empty post', 'image or video required', 'not both', 'unsupported image format', 'image too large']
/** How long a post waits out a platform limit (Instagram's daily cap, a rate limit). */
const LIMIT_WAIT_MIN = 60

/**
 * Publishes one claimed post to its account's platform and settles it:
 * published, failed (retried 10 then 20 minutes later), held while the token
 * is rejected, or put back while a platform limit lasts.
 */
export async function publishClaimed(post: Post): Promise<TickResult> {
  const say = (kind: string, message: string) => logEvent({ agent: 'publisher', to_agent: 'observer', kind, message, post_id: post.id })
  let platform = '?'
  try {
    const account = getAccountToken(post.account_id)
    if (!account) {
      const error = 'account missing or disabled'
      markFailed(post.id, error, 3, false)
      say('error', `Post #${post.id} gagal: akun hilang atau nonaktif.`)
      return { published: false, id: post.id, error, retryable: false, can_retry: false }
    }
    const adapter = adapterFor(account.platform)
    platform = adapter.label
    say('working', `Mengirim post #${post.id} ke ${platform} (@${account.username || account.external_id}).`)
    const ids = await adapter.publish({
      text: post.caption, imageUrl: post.image_url ?? undefined, videoUrl: post.video_url ?? undefined, kind: post.kind,
    }, account)
    markPublished(post.id, ids)
    say('done', `Post #${post.id} terbit di ${platform}${ids.length > 1 ? ` (${ids.length} bagian)` : ''}.`)
    return { published: true, id: post.id, platform, post_ids: ids, parts: ids.length }
  } catch (e) {
    const error = String(e)
    // A rejected token fails every post alike: hold the queue rather than burn their attempts.
    if (isInvalidToken(e)) {
      releasePost(post.id, `menunggu akun dihubungkan ulang: ${error}`)
      pauseForInvalidToken(post.account_id, e)
      return { published: false, id: post.id, platform, error, paused: true }
    }
    if (isRateLimited(e)) {
      deferPost(post.id, LIMIT_WAIT_MIN, `menunggu batas ${platform} pulih: ${error}`)
      say('error', `Post #${post.id} ditunda ${LIMIT_WAIT_MIN} menit: batas ${platform} tercapai. ${error}`)
      return { published: false, id: post.id, platform, error, deferred_min: LIMIT_WAIT_MIN }
    }
    // A broken chain is deleted again, so it can retry from the root. If some parts
    // could not be deleted, fail at once: a retry would repost them. Retry by hand after deleting.
    const stuck = e instanceof ChainBrokenError && e.liveIds.length > 0
    const retryable = !PERMANENT.some(p => error.includes(p))
    const needsSetup = SETUP.some(p => error.includes(p))
    markFailed(post.id, error, stuck || needsSetup || !retryable ? 1 : 3, retryable)
    const willRetry = retryable && !stuck && !needsSetup && post.attempts < 3
    say('error', `Post #${post.id} gagal di ${platform}${willRetry ? ', dicoba lagi' : ''}: ${error}`)
    return { published: false, id: post.id, platform, error, retryable, can_retry: willRetry, attempts: post.attempts }
  }
}

/** Labels for the platforms that can publish, for messages outside the queue. */
export const platformLabel = (platform: string) => ADAPTERS[platform as keyof typeof ADAPTERS]?.label ?? platform

const MAX_CAPTION = 5000

/**
 * POST body {text, imageUrl|videoUrl, kind, accountId}: publishes at once,
 * outside the queue, and records the post as published. Without accountId it
 * goes to the only enabled account, of `onlyPlatform` when given.
 */
export async function publishNow(request: NextRequest, onlyPlatform?: Platform) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })

  const { text, imageUrl, videoUrl, accountId, kind } = body
  if (typeof text !== 'string' || !text.trim()) return NextResponse.json({ error: 'text is required' }, { status: 400 })
  if (text.length > MAX_CAPTION) return NextResponse.json({ error: `text exceeds ${MAX_CAPTION} chars` }, { status: 400 })
  const img = typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null
  const vid = typeof videoUrl === 'string' && videoUrl.trim() ? videoUrl.trim() : null
  if (!img && !vid) return NextResponse.json({ error: 'imageUrl or videoUrl is required: every post needs media' }, { status: 400 })
  if (img && vid) return NextResponse.json({ error: 'pass either imageUrl or videoUrl, not both' }, { status: 400 })
  if (!isPostKind(kind)) return NextResponse.json({ error: 'kind is required: "news" or "affiliate", lowercase' }, { status: 400 })
  if (!/^https:\/\//.test((img ?? vid)!)) return NextResponse.json({ error: 'media URL must be a public https URL' }, { status: 400 })

  let id = typeof accountId === 'number' ? accountId : null
  if (id === null) {
    const name = onlyPlatform ? platformLabel(onlyPlatform) : 'enabled'
    const enabled = listAccounts().filter(a => a.enabled && (!onlyPlatform || a.platform === onlyPlatform))
    if (enabled.length === 0) return NextResponse.json({ error: `no ${name} account connected` }, { status: 400 })
    if (enabled.length > 1) return NextResponse.json({ error: 'accountId required: multiple accounts connected' }, { status: 400 })
    id = enabled[0].id
  }

  try {
    const account = getAccountToken(id)
    if (!account) return NextResponse.json({ error: `account ${id} not found or disabled` }, { status: 404 })
    if (onlyPlatform && account.platform !== onlyPlatform)
      return NextResponse.json({ error: `account ${id} is not a ${platformLabel(onlyPlatform)} account` }, { status: 400 })
    const ids = await adapterFor(account.platform).publish({ text, imageUrl: img ?? undefined, videoUrl: vid ?? undefined, kind }, account)
    const recordId = recordPublishedPost({ account_id: id, caption: text, image_url: img, video_url: vid, kind, external_ids: ids })
    return NextResponse.json({ published: true, id: recordId, platform: account.platform, post_id: ids[0], post_ids: ids, parts: ids.length })
  } catch (e) {
    if (isInvalidToken(e)) pauseForInvalidToken(id, e)
    return NextResponse.json({ published: false, error: String(e) }, { status: 502 })
  }
}
