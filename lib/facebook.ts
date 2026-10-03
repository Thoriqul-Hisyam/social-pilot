import type { Adapter } from './platforms'
import { isGone } from './errors'
import { graphCaller, insightValue } from './meta'
import { FACEBOOK_JPEG, rehostJpeg } from './media'
import { partsFor } from './text'

/**
 * Facebook Pages through Facebook Login. One connect adds every Page the person
 * can post to, each as its own account. Page tokens made from a long-lived user
 * token do not expire, so nothing is refreshed; a reconnect replaces them.
 */
const GRAPH = 'https://graph.facebook.com/v25.0'
const call = graphCaller(GRAPH, 'Facebook')
const SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,read_insights'

/** Videos are stored with this prefix: their numbers come from other endpoints than a photo post's. */
const VIDEO = 'video:'

type Page = { id: string; name?: string; access_token?: string; tasks?: string[] }

export const facebook: Adapter = {
  label: 'Facebook',
  missingEnv: () => ['META_FACEBOOK_APP_ID', 'META_FACEBOOK_APP_SECRET'].filter(k => !process.env[k]),

  authorizeUrl({ state, redirectUri }) {
    const url = new URL('https://www.facebook.com/v25.0/dialog/oauth')
    url.searchParams.set('client_id', process.env.META_FACEBOOK_APP_ID ?? '')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('response_type', 'code')
    // Facebook Login for Business names its permissions in a configuration instead.
    if (process.env.FACEBOOK_CONFIG_ID) url.searchParams.set('config_id', process.env.FACEBOOK_CONFIG_ID)
    else url.searchParams.set('scope', SCOPES)
    return url.toString()
  },

  async connect({ code, redirectUri }) {
    const app = { client_id: process.env.META_FACEBOOK_APP_ID ?? '', client_secret: process.env.META_FACEBOOK_APP_SECRET ?? '' }
    const short = await call('/oauth/access_token', { ...app, redirect_uri: redirectUri, code }, 'GET')
    const long = await call('/oauth/access_token', { ...app, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token }, 'GET')
    const { data } = await call('/me/accounts', { fields: 'id,name,access_token,tasks', limit: '100', access_token: long.access_token }, 'GET')
    // Pages the person may only moderate or analyse cannot be posted to.
    const pages = ((data ?? []) as Page[]).filter(p => p.access_token && (!p.tasks || p.tasks.includes('CREATE_CONTENT')))
    if (!pages.length)
      throw new Error('Tidak ada Page Facebook yang bisa diposting akun ini. Pilih minimal satu Page saat menyetujui izin, dan pastikan peranmu di Page itu bisa membuat konten.')
    return pages.map(p => ({ external_id: p.id, username: p.name ?? p.id, access_token: p.access_token!, token_expires_at: null }))
  },

  /**
   * Photos publish in one call and return the Page post. Videos go up by URL
   * and finish processing on Facebook's side, so nothing waits for them here.
   * Neither is retried on the spot: the call itself publishes.
   */
  async publish(job, a) {
    const caption = partsFor('facebook', job.text)[0]
    if (!caption) throw new Error('empty post')
    if (job.videoUrl) {
      const { id } = await call(`/${a.external_id}/videos`, { file_url: job.videoUrl, description: caption, access_token: a.token })
      return [`${VIDEO}${id}`]
    }
    const url = await rehostJpeg(job.imageUrl!, 'facebook', FACEBOOK_JPEG)
    const res = await call(`/${a.external_id}/photos`, { url, caption, published: 'true', access_token: a.token })
    return [res.post_id ?? res.id]
  },

  /** A post that no longer exists counts as deleted. Meta documents this call unevenly, so a refusal comes back as an error to show. */
  async deletePosts(ids, token) {
    const live: string[] = [], errors: string[] = []
    for (const id of [...ids].reverse()) {
      try { await call(`/${id.startsWith(VIDEO) ? id.slice(VIDEO.length) : id}`, { access_token: token }, 'DELETE') }
      catch (e) { if (!isGone(e)) { live.unshift(id); errors.push(String(e)) } }
    }
    return { live, errors }
  },

  async fetchInsights(mediaId, a) {
    const token = { access_token: a.token }
    const counts = 'comments.summary(total_count).limit(0)'
    if (mediaId.startsWith(VIDEO)) {
      const id = mediaId.slice(VIDEO.length)
      const [ins, obj] = await Promise.all([
        call(`/${id}/video_insights`, { metric: 'total_video_views', ...token }, 'GET'),
        call(`/${id}`, { fields: `likes.summary(total_count).limit(0),${counts}`, ...token }, 'GET'),
      ])
      return {
        views: insightValue(ins.data, 'total_video_views'), likes: obj.likes?.summary?.total_count ?? 0,
        replies: obj.comments?.summary?.total_count ?? 0, reposts: 0, quotes: 0, shares: 0,
      }
    }
    // post_media_view replaced post_impressions in 2025.
    const [ins, obj] = await Promise.all([
      call(`/${mediaId}/insights`, { metric: 'post_media_view', ...token }, 'GET'),
      call(`/${mediaId}`, { fields: `shares,reactions.summary(total_count).limit(0),${counts}`, ...token }, 'GET'),
    ])
    return {
      views: insightValue(ins.data, 'post_media_view'), likes: obj.reactions?.summary?.total_count ?? 0,
      replies: obj.comments?.summary?.total_count ?? 0, reposts: 0, quotes: 0, shares: obj.shares?.count ?? 0,
    }
  },
}
