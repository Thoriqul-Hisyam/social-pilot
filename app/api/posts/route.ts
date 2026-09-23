import { NextRequest, NextResponse } from 'next/server'
import { listPosts, listQueue, listPostsByStatus, queuePost, stats, listAccounts } from '@/lib/db'
import { hasValidApiKey, hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_GAP_MIN = 5
const MAX_GAP_MIN = 30

/** Every post needs an image. Accepts imageUrl or image_url; must be public https. */
const imageOf = (it: Record<string, unknown>) => {
  const v = it.imageUrl ?? it.image_url
  return typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim()) ? v.trim() : null
}

export async function GET(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const view = new URL(request.url).searchParams.get('view')
  if (view === 'queue') return NextResponse.json({ posts: listQueue(100), stats: stats() })
  if (view === 'failed') return NextResponse.json({ posts: listPostsByStatus('failed', 100), stats: stats() })
  if (view === 'history') return NextResponse.json({ posts: listPostsByStatus('published', 100), stats: stats() })
  return NextResponse.json({ posts: listPosts(100), stats: stats() })
}

/**
 * Queue one or many posts. Each item is staggered by a random 5-30 min gap
 * after the latest pending slot, so a batch never fires all at once.
 * Duplicate source_url for the same account is skipped, not an error.
 */
export async function POST(request: NextRequest) {
  if (!hasValidApiKey(request) && !hasValidSession(request)) return unauthorized()

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })

  const items: unknown[] = Array.isArray(body.items) ? body.items : [body]
  if (items.length === 0 || items.length > 50)
    return NextResponse.json({ error: 'items must be 1-50 entries' }, { status: 400 })

  const enabled = listAccounts().filter(a => a.enabled)
  const defaultAccount = enabled.length === 1 ? enabled[0].id : null

  // Reject the whole batch up front, so nothing is half-queued and no post slips through without an image.
  const noImage = items.flatMap((raw, i) => imageOf(raw as Record<string, unknown>) ? [] : [i])
  if (noImage.length)
    return NextResponse.json({
      error: 'imageUrl (public https) is required for every item',
      items_without_image: noImage,
    }, { status: 400 })

  let cursor = Date.now()
  const queued: number[] = []
  const skipped: string[] = []

  for (const raw of items) {
    const it = raw as Record<string, unknown>
    const caption = typeof it.caption === 'string' ? it.caption.trim() : ''
    if (!caption) return NextResponse.json({ error: 'caption required for every item' }, { status: 400 })

    const accountId = typeof it.accountId === 'number' ? it.accountId : defaultAccount
    if (accountId === null)
      return NextResponse.json({ error: 'accountId required when multiple accounts exist' }, { status: 400 })

    // Allow caller to override scheduled_at (e.g. migration script with already-due articles).
    // Format: ISO string or 'YYYY-MM-DD HH:MM:SS'. If not set, stagger 5-30 min from cursor.
    const customScheduled = typeof it.scheduledAt === 'string' ? it.scheduledAt : null
    if (customScheduled) {
      const id = queuePost({
        account_id: accountId,
        caption,
        image_url: imageOf(it),
        source_url: typeof it.sourceUrl === 'string' ? it.sourceUrl : null,
        scheduled_at: customScheduled.replace('T', ' ').slice(0, 19),
      })
      if (id === null) skipped.push(String(it.sourceUrl ?? caption.slice(0, 40)))
      else queued.push(id)
      continue
    }

    cursor += (MIN_GAP_MIN + Math.random() * (MAX_GAP_MIN - MIN_GAP_MIN)) * 60_000
    const id = queuePost({
      account_id: accountId,
      caption,
      image_url: imageOf(it),
      source_url: typeof it.sourceUrl === 'string' ? it.sourceUrl : null,
      scheduled_at: new Date(cursor).toISOString().replace('T', ' ').slice(0, 19),
    })
    if (id === null) skipped.push(String(it.sourceUrl ?? caption.slice(0, 40)))
    else queued.push(id)
  }

  return NextResponse.json({ queued: queued.length, ids: queued, skipped_duplicates: skipped })
}
