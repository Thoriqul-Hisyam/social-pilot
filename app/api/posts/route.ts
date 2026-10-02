import { NextRequest, NextResponse } from 'next/server'
import { isPostKind, pagePosts, queuePost, queueTail, stats, listAccounts, toSqlTime } from '@/lib/db'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_GAP_MIN = 5
const MAX_GAP_MIN = 30

const httpsUrl = (v: unknown) =>
  typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim()) ? v.trim() : null

/**
 * Every post needs exactly one public https image or video.
 * Accepts camelCase or snake_case keys. Null when missing, invalid, or both.
 */
const mediaOf = (it: Record<string, unknown>) => {
  const img = it.imageUrl ?? it.image_url
  const vid = it.videoUrl ?? it.video_url
  if (img && vid) return null
  const image_url = img ? httpsUrl(img) : null
  const video_url = vid ? httpsUrl(vid) : null
  return image_url || video_url ? { image_url, video_url } : null
}

/** scheduledAt to stored UTC form. A value without a zone is UTC, as before. Null when unparseable. */
const scheduledOf = (v: string) => {
  const s = v.trim().replace(' ', 'T')
  const t = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : `${s}Z`)
  return Number.isNaN(t) ? null : toSqlTime(t)
}

const MAX_PAGE_SIZE = 100

/**
 * ?view=queue|failed|history (else all), ?kind=news|affiliate (else both),
 * ?page from 1 and ?limit up to 100. Stats follow the kind filter.
 */
export async function GET(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const q = new URL(request.url).searchParams
  const kind = q.get('kind') || null
  if (kind !== null && !isPostKind(kind))
    return NextResponse.json({ error: 'kind must be news or affiliate' }, { status: 400 })
  const view = q.get('view')
  const limit = Math.min(Math.max(Math.floor(Number(q.get('limit'))) || MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const page = Math.max(Math.floor(Number(q.get('page'))) || 1, 1)
  const { posts, total } = pagePosts(
    view === 'queue' || view === 'failed' || view === 'history' ? view : 'all',
    { kind, limit, offset: (page - 1) * limit },
  )
  return NextResponse.json({ posts, total, page, limit, stats: stats(kind) })
}

/**
 * Queue one or many posts. Each item is staggered by a random 5-30 min gap
 * after the latest pending slot, so a batch never fires all at once.
 * kind is news or affiliate; without it, an item with sourceUrl is news.
 * Duplicate news sourceUrl for the same account is skipped, not an error;
 * affiliate may repeat.
 */
export async function POST(request: NextRequest) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })

  const items: unknown[] = Array.isArray(body.items) ? body.items : [body]
  if (items.length === 0 || items.length > 50)
    return NextResponse.json({ error: 'items must be 1-50 entries' }, { status: 400 })

  const accounts = listAccounts()
  const enabled = accounts.filter(a => a.enabled)
  const defaultAccount = enabled.length === 1 ? enabled[0].id : null

  // Validate the whole batch up front, so nothing is half-queued and no post slips through without media.
  const noMedia = items.flatMap((raw, i) => mediaOf(raw as Record<string, unknown>) ? [] : [i])
  if (noMedia.length)
    return NextResponse.json({
      error: 'every item needs exactly one public https imageUrl or videoUrl',
      items_without_media: noMedia,
    }, { status: 400 })

  const posts = []
  for (const raw of items) {
    const it = raw as Record<string, unknown>
    const caption = typeof it.caption === 'string' ? it.caption.trim() : ''
    if (!caption) return NextResponse.json({ error: 'caption required for every item' }, { status: 400 })

    const accountId = typeof it.accountId === 'number' ? it.accountId : defaultAccount
    if (accountId === null)
      return NextResponse.json({ error: 'accountId required when multiple accounts exist' }, { status: 400 })
    if (!accounts.some(a => a.id === accountId))
      return NextResponse.json({ error: `account ${accountId} not found` }, { status: 400 })

    // Caller may pin scheduled_at (e.g. a migration script with already-due articles):
    // ISO string or 'YYYY-MM-DD HH:MM:SS'. Otherwise it is staggered below.
    const pinned = typeof it.scheduledAt === 'string' && it.scheduledAt.trim() ? it.scheduledAt : null
    const scheduledAt = pinned ? scheduledOf(pinned) : null
    if (pinned && !scheduledAt)
      return NextResponse.json({ error: `scheduledAt is not a valid date: ${pinned}` }, { status: 400 })

    if (it.kind != null && !isPostKind(it.kind))
      return NextResponse.json({ error: `kind must be news or affiliate, got ${JSON.stringify(it.kind)}` }, { status: 400 })

    posts.push({
      account_id: accountId,
      caption,
      ...mediaOf(it)!,
      source_url: typeof it.sourceUrl === 'string' ? it.sourceUrl : null,
      kind: isPostKind(it.kind) ? it.kind : undefined,
      scheduledAt,
      label: String(it.sourceUrl ?? caption.slice(0, 40)),
    })
  }

  let cursor = queueTail(MAX_GAP_MIN * 60_000)
  const queued: number[] = []
  const skipped: string[] = []

  for (const { scheduledAt, label, ...post } of posts) {
    if (!scheduledAt) cursor += (MIN_GAP_MIN + Math.random() * (MAX_GAP_MIN - MIN_GAP_MIN)) * 60_000
    const id = queuePost({ ...post, scheduled_at: scheduledAt ?? toSqlTime(cursor) })
    if (id === null) skipped.push(label)
    else queued.push(id)
  }

  return NextResponse.json({ queued: queued.length, ids: queued, skipped_duplicates: skipped })
}
