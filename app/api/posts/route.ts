import { NextRequest, NextResponse } from 'next/server'
import { type Account, groupsFor, isPostKind, listAccounts, newsQueuedIn, pagePosts, type PostKind, queuePost, queueTail, routeTargets, stats, toSqlTime } from '@/lib/db'
import { pickAccounts } from '@/lib/routing'
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
 * ?account=<id> (else every account), ?page from 1 and ?limit up to 100.
 * Stats follow the kind and account filters.
 */
export async function GET(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const q = new URL(request.url).searchParams
  const kind = q.get('kind') || null
  if (kind !== null && !isPostKind(kind))
    return NextResponse.json({ error: 'kind must be news or affiliate' }, { status: 400 })
  const account = q.get('account') ? Number(q.get('account')) : null
  if (account !== null && !Number.isInteger(account))
    return NextResponse.json({ error: 'account must be an account id' }, { status: 400 })
  const view = q.get('view')
  const limit = Math.min(Math.max(Math.floor(Number(q.get('limit'))) || MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const page = Math.max(Math.floor(Number(q.get('page'))) || 1, 1)
  const { posts, total } = pagePosts(
    view === 'queue' || view === 'failed' || view === 'history' ? view : 'all',
    { kind, accountId: account, limit, offset: (page - 1) * limit },
  )
  return NextResponse.json({ posts, total, page, limit, stats: stats(kind, account) })
}

type Item = {
  index: number; caption: string; captions: Record<string, unknown>; kind: PostKind
  media: { image_url: string | null; video_url: string | null }; source_url: string | null
  scheduledAt: string | null; label: string; account: Account | null
}

/**
 * Queue one or many posts. An item with accountId goes to that account. One
 * without goes to the enabled accounts that take its kind (auto_news,
 * auto_affiliate), as the groups of that kind allow (lib/routing.ts): a same
 * group's members post it together, a split group's members never both do.
 * An item no account takes is reported in no_target.
 * Each account keeps its own rhythm: its posts are staggered by a random
 * 5-30 min gap after its latest pending slot, so a batch never fires all at once.
 * Every item needs kind "news" or "affiliate"; one without rejects the batch.
 * captions: {instagram: "...", facebook: "..."} optionally replaces caption on those platforms.
 * Duplicate news sourceUrl for the same account is skipped, not an error, and a
 * split group never posts the same article twice; affiliate may repeat.
 */
export async function POST(request: NextRequest) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })

  const items: unknown[] = Array.isArray(body.items) ? body.items : [body]
  if (items.length === 0 || items.length > 50)
    return NextResponse.json({ error: 'items must be 1-50 entries' }, { status: 400 })

  const accounts = listAccounts()

  // Validate the whole batch up front, so nothing is half-queued and no post slips through without media or kind.
  const noMedia = items.flatMap((raw, i) => mediaOf(raw as Record<string, unknown>) ? [] : [i])
  if (noMedia.length)
    return NextResponse.json({
      error: 'every item needs exactly one public https imageUrl or videoUrl',
      items_without_media: noMedia,
    }, { status: 400 })
  const badKind = items.flatMap((raw, i) => {
    const kind = (raw as Record<string, unknown> | null)?.kind
    return isPostKind(kind) ? [] : [{ item: i, kind: kind ?? null }]
  })
  if (badKind.length)
    return NextResponse.json({
      error: 'every item needs kind "news" or "affiliate", lowercase',
      items_with_invalid_kind: badKind,
    }, { status: 400 })

  const valid: Item[] = []
  for (const [index, raw] of items.entries()) {
    const it = raw as Record<string, unknown>
    const caption = typeof it.caption === 'string' ? it.caption.trim() : ''
    if (!caption) return NextResponse.json({ error: 'caption required for every item' }, { status: 400 })

    let account: Account | null = null
    if (it.accountId != null) {
      account = accounts.find(a => a.id === it.accountId) ?? null
      if (!account) return NextResponse.json({ error: `account ${it.accountId} not found` }, { status: 400 })
    }

    // Caller may pin scheduled_at (e.g. a migration script with already-due articles):
    // ISO string or 'YYYY-MM-DD HH:MM:SS'. Otherwise it is staggered below.
    const pinned = typeof it.scheduledAt === 'string' && it.scheduledAt.trim() ? it.scheduledAt : null
    const scheduledAt = pinned ? scheduledOf(pinned) : null
    if (pinned && !scheduledAt)
      return NextResponse.json({ error: `scheduledAt is not a valid date: ${pinned}` }, { status: 400 })

    valid.push({
      index, caption, kind: it.kind as PostKind, media: mediaOf(it)!, account, scheduledAt,
      captions: it.captions && typeof it.captions === 'object' ? it.captions as Record<string, unknown> : {},
      source_url: typeof it.sourceUrl === 'string' ? it.sourceUrl : null,
      label: String(it.sourceUrl ?? caption.slice(0, 40)),
    })
  }

  // Where each account's next slot goes from; it moves on with every post queued on it.
  const cursors = new Map<number, number>()
  const tail = (id: number) => {
    if (!cursors.has(id)) cursors.set(id, queueTail(MAX_GAP_MIN * 60_000, id))
    return cursors.get(id)!
  }
  const queued: number[] = []
  const noTarget: number[] = []
  // Labels stay as before, one per item, even when only some of its accounts had it already.
  const skipped = new Set<string>()

  const queueOn = (it: Item, account: Account) => {
    let at = it.scheduledAt
    if (!at) {
      const cursor = tail(account.id) + (MIN_GAP_MIN + Math.random() * (MAX_GAP_MIN - MIN_GAP_MIN)) * 60_000
      cursors.set(account.id, cursor)
      at = toSqlTime(cursor)
    }
    const own = it.captions[account.platform]
    const id = queuePost({
      account_id: account.id, caption: typeof own === 'string' && own.trim() ? own.trim() : it.caption,
      ...it.media, source_url: it.source_url, kind: it.kind, scheduled_at: at,
    })
    if (id === null) skipped.add(it.label)
    else queued.push(id)
  }

  for (const it of valid) {
    if (it.account) { queueOn(it, it.account); continue }
    const targets = routeTargets(it.kind)
    if (!targets.length) { noTarget.push(it.index); continue }
    const url = it.kind === 'news' ? it.source_url : null
    const picked = pickAccounts(targets.map(a => a.id), groupsFor(it.kind), tail, id => !!url && newsQueuedIn([id], url))
    for (const a of targets) if (picked.includes(a.id)) queueOn(it, a)
  }

  return NextResponse.json({ queued: queued.length, ids: queued, skipped_duplicates: [...skipped], no_target: noTarget })
}
