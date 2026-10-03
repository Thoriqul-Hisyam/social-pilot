import type { Adapter, TokenSet } from './platforms'
import { isTransient, MetaApiError, NetworkError, sleep } from './errors'
import { graphCaller, insightValue } from './meta'
import { INSTAGRAM_JPEG, rehostJpeg } from './media'
import { partsFor } from './text'

/**
 * Instagram API with Instagram Login (graph.instagram.com): a professional
 * account (Business or Creator), no Facebook Page needed. One post per item:
 * captions are cut to 2,200 characters, images become JPEG within 4:5 to 1.91:1,
 * videos go out as Reels. Posts cannot be deleted through this API.
 */
const GRAPH = 'https://graph.instagram.com'
const call = graphCaller(`${GRAPH}/v25.0`, 'Instagram')
const SCOPES = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights'
const LONG_LIVED_SEC = 60 * 24 * 3600

const expiresIn = (sec: unknown) => new Date(Date.now() + (Number(sec) || LONG_LIVED_SEC) * 1000).toISOString()

/** Creating a container publishes nothing, so a blip there is safe to retry. */
async function createContainer(igId: string, token: string, params: Record<string, string>): Promise<string> {
  for (const wait of [5000, 15000]) {
    try { return (await call(`/${igId}/media`, { ...params, access_token: token })).id }
    catch (e) { if (!isTransient(e)) throw e; await sleep(wait) }
  }
  return (await call(`/${igId}/media`, { ...params, access_token: token })).id
}

/** Instagram fetches and processes the media first; publishing before FINISHED fails. */
async function waitForContainer(id: string, token: string, timeoutMs: number, everyMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let res
    try { res = await call(`/${id}`, { fields: 'status_code,status', access_token: token }, 'GET') }
    catch (e) {
      if (!(e instanceof NetworkError) || Date.now() > deadline) throw e
      await sleep(5000)
      continue
    }
    const { status_code, status } = res
    if (status_code === 'FINISHED' || status_code === 'PUBLISHED') return
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`Instagram container ${status_code}: ${status ?? 'no detail'}`)
    if (Date.now() > deadline) throw new Error(`Instagram container not ready after ${timeoutMs / 1000}s (status ${status_code})`)
    await sleep(everyMs)
  }
}

async function refresh(token: string): Promise<TokenSet> {
  const res = await fetch(`${GRAPH}/refresh_access_token?` + new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }))
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token)
    throw new MetaApiError(`Instagram token refresh: ${data.error?.message ?? `HTTP ${res.status}`}`, data.error?.code)
  return { token: data.access_token, expiresAt: expiresIn(data.expires_in) }
}

export const instagram: Adapter = {
  label: 'Instagram',
  missingEnv: () => ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'].filter(k => !process.env[k]),

  authorizeUrl({ state, redirectUri }) {
    const url = new URL('https://www.instagram.com/oauth/authorize')
    url.searchParams.set('client_id', process.env.INSTAGRAM_APP_ID ?? '')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPES)
    url.searchParams.set('state', state)
    return url.toString()
  },

  async connect({ code, redirectUri }) {
    const secret = process.env.INSTAGRAM_APP_SECRET ?? ''
    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: process.env.INSTAGRAM_APP_ID ?? '', client_secret: secret,
        grant_type: 'authorization_code', redirect_uri: redirectUri, code,
      }),
    })
    const shortBody = await shortRes.json().catch(() => ({}))
    // Answered either flat or wrapped in data[].
    const short = shortBody.data?.[0] ?? shortBody
    if (!shortRes.ok || !short.access_token)
      throw new Error(`Instagram short token: ${shortBody.error_message ?? shortBody.error?.message ?? `HTTP ${shortRes.status}`}`)

    const longRes = await fetch(`${GRAPH}/access_token?` + new URLSearchParams({
      grant_type: 'ig_exchange_token', client_secret: secret, access_token: short.access_token,
    }))
    const long = await longRes.json().catch(() => ({}))
    if (!longRes.ok || !long.access_token)
      throw new Error(`Gagal menukar ke token 60 hari Instagram: ${long.error?.message ?? `HTTP ${longRes.status}`}. Akun tidak disimpan; periksa INSTAGRAM_APP_SECRET lalu hubungkan ulang.`)

    // user_id is the professional account's id, the one publishing goes through.
    const me = await call('/me', { fields: 'user_id,username', access_token: long.access_token }, 'GET')
    return [{
      external_id: String(me.user_id ?? me.id ?? short.user_id),
      username: me.username ?? '',
      access_token: long.access_token,
      token_expires_at: expiresIn(long.expires_in),
    }]
  },

  async publish(job, a) {
    const caption = partsFor('instagram', job.text)[0]
    if (!caption) throw new Error('empty post')
    const video = !!job.videoUrl
    const params: Record<string, string> = video
      ? { media_type: 'REELS', video_url: job.videoUrl!, caption, share_to_feed: 'true' }
      : { image_url: await rehostJpeg(job.imageUrl!, 'instagram', INSTAGRAM_JPEG), caption }
    const id = await createContainer(a.external_id, a.token, params)
    // Meta suggests polling video once a minute for up to 5 minutes; images are ready in seconds.
    await waitForContainer(id, a.token, video ? 300000 : 60000, video ? 15000 : 2000)
    const publish = () => call(`/${a.external_id}/media_publish`, { creation_id: id, access_token: a.token })
    try {
      return [(await publish()).id]
    } catch (e) {
      // Only a blip is retried: the same container cannot be published twice.
      if (!isTransient(e)) throw e
      await sleep(10000)
      return [(await publish()).id]
    }
  },

  async fetchInsights(mediaId, a) {
    const { data } = await call(`/${mediaId}/insights`, { metric: 'views,likes,comments,shares', access_token: a.token }, 'GET')
    return {
      views: insightValue(data, 'views'), likes: insightValue(data, 'likes'), replies: insightValue(data, 'comments'),
      reposts: 0, quotes: 0, shares: insightValue(data, 'shares'),
    }
  },

  refreshLongLived: refresh,
}
