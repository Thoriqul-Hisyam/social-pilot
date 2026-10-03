import { isGone, isTransient, MetaApiError, NetworkError, sleep } from './errors'
import { graphCaller, insightValue } from './meta'
import { splitForThreads } from './text'
import { rehostImage } from './media'
import type { Adapter } from './platforms'

// Older imports keep working: the text rules and error classes moved to shared modules.
export { splitForThreads, threadsPreview } from './text'
export { isInvalidToken, isMissingPermission, NetworkError } from './errors'
export { isGone as isDeletedOnThreads } from './errors'
/** An error answer from the Threads Graph API, classified by Meta's code. */
export { MetaApiError as ThreadsApiError } from './errors'

const API = 'https://graph.threads.net/v1.0'
const call = graphCaller(API, 'Threads')

export type PublishInput = { text: string; imageUrl?: string; videoUrl?: string; userId: string; token: string }

/**
 * A reply chain that stopped mid-way. Its published parts were deleted again;
 * liveIds are the ones that could not be, root first (empty = nothing left on Threads).
 */
export class ChainBrokenError extends Error {
  readonly liveIds: string[]
  constructor(liveIds: string[], part: number, total: number, cause: unknown) {
    const left = liveIds.length ? `still live, delete by hand: ${liveIds.join(',')}` : 'published parts deleted'
    super(`chain broke at part ${part}/${total}; ${left}; cause: ${cause}`)
    this.liveIds = liveIds
  }
}

async function createContainer(userId: string, token: string, params: Record<string, string>): Promise<string> {
  for (const wait of [5000, 15000]) {
    try {
      return (await call(`/${userId}/threads`, { ...params, access_token: token })).id
    } catch (e) {
      if (!isTransient(e)) throw e
      await sleep(wait)
    }
  }
  return (await call(`/${userId}/threads`, { ...params, access_token: token })).id
}

/**
 * Waits until a container is ready. Publishing one still IN_PROGRESS fails
 * with "The requested resource does not exist", even for plain text.
 * A dropped connection only costs a poll; the deadline still holds.
 */
async function waitForContainer(id: string, token: string, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let res
    try { res = await call(`/${id}`, { fields: 'status,error_message', access_token: token }, 'GET') }
    catch (e) {
      if (!(e instanceof NetworkError) || Date.now() > deadline) throw e
      await sleep(5000)
      continue
    }
    const { status, error_message } = res
    if (status === 'FINISHED' || status === 'PUBLISHED') return
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Threads container ${status}: ${error_message ?? 'no detail'}`)
    if (Date.now() > deadline) throw new Error(`Threads container not ready after ${timeoutMs / 1000}s (status ${status})`)
    await sleep(2000)
  }
}

async function createAndPublish(userId: string, token: string, params: Record<string, string>): Promise<string> {
  const containerId = await createContainer(userId, token, params)
  // Video transcoding takes far longer than an image fetch.
  await waitForContainer(containerId, token, params.media_type === 'VIDEO' ? 300000 : 60000)
  const publish = () => call(`/${userId}/threads_publish`, { creation_id: containerId, access_token: token })
  try {
    return (await publish()).id
  } catch {
    // Retry the same container: a fresh one would just hit the same race.
    await sleep(10000)
    return (await publish()).id
  }
}

/**
 * Deletes published parts, last reply first. Needs threads_delete. Returns the ids
 * still live; a part that no longer exists counts as deleted, so a retry finishes
 * what an earlier attempt started. Each failure's reason goes into `errors`.
 */
export async function deleteThreadsPosts(ids: string[], token: string, errors: string[] = []): Promise<string[]> {
  const live: string[] = []
  for (const id of [...ids].reverse()) {
    try { await call(`/${id}`, { access_token: token }, 'DELETE') }
    catch (e) {
      if (isGone(e)) continue
      console.error(`Threads delete: ${id}: ${e}`)
      errors.push(String(e))
      live.unshift(id)
    }
  }
  return live
}

/**
 * Publish text to Threads. Text over 500 chars continues as a self-reply
 * chain: root -> reply -> reply. Returns every post id, root first.
 *
 * Replies require the threads_manage_replies scope. If the chain breaks
 * mid-way, the parts already published are deleted so no half thread stays up;
 * a ChainBrokenError names any that could not be deleted.
 */
export async function publishToThreads({ text, imageUrl, videoUrl, userId, token }: PublishInput): Promise<string[]> {
  if (!userId || !token) throw new Error('missing Threads credentials')
  if (!text.trim()) throw new Error('empty post')
  // Every post must carry media; never let one go out as text only.
  if (!imageUrl && !videoUrl) throw new Error('image or video required')
  if (imageUrl && videoUrl) throw new Error('pass either imageUrl or videoUrl, not both')

  const media: Record<string, string> = videoUrl
    ? { media_type: 'VIDEO', video_url: videoUrl }
    : { media_type: 'IMAGE', image_url: imageUrl! }

  const parts = splitForThreads(text)
  const ids: string[] = []

  for (let i = 0; i < parts.length; i++) {
    const params = {
      ...(i === 0 ? media : { media_type: 'TEXT' }),
      text: parts[i],
      ...(i > 0 ? { reply_to_id: ids[i - 1] } : {}),
    }
    try {
      ids.push(await createAndPublish(userId, token, params))
    } catch (e) {
      if (i === 0) throw e
      // The parent post is often not queryable yet; wait longer and retry once.
      await sleep(15000)
      try {
        ids.push(await createAndPublish(userId, token, params))
      } catch (e2) {
        throw new ChainBrokenError(await deleteThreadsPosts(ids, token), i + 1, parts.length, e2)
      }
    }
    // Rapid self-replies look like spam and can get the parent hidden; pace them out.
    if (i < parts.length - 1) await sleep(10000)
  }
  return ids
}

const METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'] as const
export type PostInsights = Record<(typeof METRICS)[number], number>

/**
 * Lifetime insights of one post. Needs threads_manage_insights. For a reply
 * chain, pass the root: Threads does not roll replies' numbers into it.
 * A metric Threads leaves out reads as 0.
 */
export async function fetchPostInsights(mediaId: string, token: string): Promise<PostInsights> {
  const { data } = await call(`/${mediaId}/insights`, { metric: METRICS.join(','), access_token: token }, 'GET')
  return Object.fromEntries(METRICS.map(n => [n, insightValue(data, n)])) as PostInsights
}

/** Documented lifetime of a long-lived Threads token, used if Meta omits expires_in. */
export const LONG_LIVED_SEC = 60 * 24 * 3600

/**
 * Trades a long-lived token for a fresh one, valid 60 days from now. Meta only
 * refreshes a token that is at least 24 hours old and not yet expired.
 */
export async function refreshLongLivedToken(token: string): Promise<{ token: string; expiresAt: string }> {
  const res = await fetch('https://graph.threads.net/refresh_access_token?' + new URLSearchParams({
    grant_type: 'th_refresh_token',
    access_token: token,
  }))
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token)
    throw new MetaApiError(`Threads token refresh: ${data.error?.message ?? `HTTP ${res.status}`}`, data.error?.code)
  return {
    token: data.access_token,
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || LONG_LIVED_SEC) * 1000).toISOString(),
  }
}

/** Reads the profile behind a token — used to name an account after OAuth. */
export async function fetchProfile(token: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${API}/me?fields=id,username&access_token=${encodeURIComponent(token)}`)
  const data = await res.json()

  if (!res.ok) {
    console.error('Threads profile response:', JSON.stringify({
      status: res.status,
      data,
    }))
    throw new Error(`Threads profile: ${data?.error?.message ?? res.status}`)
  }

  return { id: data.id, username: data.username ?? '' }
}

const SCOPES = 'threads_basic,threads_content_publish,threads_manage_replies,threads_delete,threads_manage_insights'

/** Threads: 500 characters a post, longer text as a self-reply chain, 60-day tokens refreshed weekly. */
export const threads: Adapter = {
  label: 'Threads',
  missingEnv: () => ['META_THREADS_APP_ID', 'META_THREADS_APP_SECRET', 'THREADS_REDIRECT_URI'].filter(k => !process.env[k]),

  authorizeUrl({ state, redirectUri }) {
    const url = new URL('https://threads.net/oauth/authorize')
    url.searchParams.set('client_id', process.env.META_THREADS_APP_ID ?? '')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', SCOPES)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    return url.toString()
  },

  async connect({ code, redirectUri }) {
    const appSecret = process.env.META_THREADS_APP_SECRET ?? ''
    const shortRes = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: process.env.META_THREADS_APP_ID ?? '',
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
    })
    const short = await shortRes.json().catch(() => ({}))
    if (!shortRes.ok || !short.access_token)
      throw new Error(`Threads short token: ${short.error?.message ?? short.error_message ?? `HTTP ${shortRes.status}`}`)

    // A short token dies within an hour, so never store one: every later publish would fail.
    const longRes = await fetch('https://graph.threads.net/access_token?' + new URLSearchParams({
      grant_type: 'th_exchange_token',
      client_secret: appSecret,
      access_token: short.access_token,
    }))
    const long = await longRes.json().catch(() => ({}))
    if (!longRes.ok || !long.access_token) {
      console.error('Threads long-lived token exchange failed:', JSON.stringify({ status: longRes.status, error: long.error ?? null }))
      throw new Error(
        `Gagal menukar ke token 60 hari: ${long.error?.message ?? `HTTP ${longRes.status}`}. ` +
        'Akun tidak disimpan; periksa META_THREADS_APP_SECRET lalu hubungkan ulang.',
      )
    }

    const profile = await fetchProfile(long.access_token)
    return [{
      external_id: profile.id,
      username: profile.username,
      access_token: long.access_token,
      token_expires_at: new Date(Date.now() + (Number(long.expires_in) || LONG_LIVED_SEC) * 1000).toISOString(),
    }]
  },

  async publish(job, a) {
    return publishToThreads({
      text: job.text,
      imageUrl: job.imageUrl ? await rehostImage(job.imageUrl) : undefined,
      videoUrl: job.videoUrl,
      userId: a.external_id,
      token: a.token,
    })
  },

  fetchInsights: (mediaId, a) => fetchPostInsights(mediaId, a.token),
  refreshLongLived: refreshLongLivedToken,
  async deletePosts(ids, token) {
    const errors: string[] = []
    return { live: await deleteThreadsPosts(ids, token, errors), errors }
  },
}
