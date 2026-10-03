/** Self-check for the platform adapters against a stubbed fetch. Uses a temp DB; nothing leaves the machine. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const dir = mkdtempSync(join(tmpdir(), 'sp-platforms-'))
Object.assign(process.env, {
  DATABASE_PATH: join(dir, 'test.db'),
  ENCRYPTION_KEY: 'test-key-that-is-long-enough-for-scrypt-derivation',
  SESSION_SECRET: 'another-test-secret-long-enough-for-hmac-sha256!!',
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'bucket', R2_PUBLIC_URL: 'https://media.test',
  INSTAGRAM_APP_ID: 'ig-app', INSTAGRAM_APP_SECRET: 'ig-secret',
  META_FACEBOOK_APP_ID: 'fb-app', META_FACEBOOK_APP_SECRET: 'fb-secret',
})

const text = await import('../lib/text')
const errors = await import('../lib/errors')
const media = await import('../lib/media')
const { ADAPTERS } = await import('../lib/platforms')
const db = await import('../lib/db')
const { publishClaimed } = await import('../lib/publish')

const cleanup = () => { db.getDb().close(); rmSync(dir, { recursive: true, force: true }) }
let n = 0
const check = (name: string, cond: boolean) => {
  if (!cond) { console.error(`FAIL: ${name}`); cleanup(); process.exit(1) }
  n++
}

// --- text per platform ---
const source = 'Sumber: https://news.example.com/2026/10/03/some-article-slug'
const news = `${'Kalimat berita yang cukup panjang untuk diuji. '.repeat(40)}\n\n${source}`
const triple = [news, news, news].join('\n\n')
const onIg = text.partsFor('instagram', triple)[0]
check('instagram gets one post', text.partsFor('instagram', triple).length === 1)
check('instagram caption fits 2200 and keeps the source', onIg.length <= 2200 && onIg.endsWith(source) && onIg.includes('…'))
check('instagram cut is on a word boundary', /\S…/.test(onIg) && !/\s…/.test(onIg))
check('short text is untouched', text.partsFor('instagram', '  halo  ')[0] === 'halo')
check('facebook keeps long text whole', text.partsFor('facebook', news)[0] === news.trim())
check('threads still chains', text.partsFor('threads', news).length > 1)
check('one giant word is cut by characters', text.shorten('x'.repeat(500), 100).length === 100)
check('preview flags an instagram cut', text.previewFor('instagram', triple).truncated && !text.previewFor('instagram', 'halo').truncated)
check('preview counts threads parts', text.previewFor('threads', news).parts === text.partsFor('threads', news).length)

// --- error classes ---
const meta = (code: number, sub?: number, msg = 'x') => new errors.MetaApiError(msg, code, sub)
check('meta 190 is an invalid token', errors.isInvalidToken(meta(190)))
check('meta 1 and 2 are transient', errors.isTransient(meta(1)) && errors.isTransient(meta(2)))
check('meta 100/33 is gone', errors.isGone(meta(100, 33)))
check('meta 10 and 2xx are permissions', errors.isMissingPermission(meta(10)) && errors.isMissingPermission(meta(230)))
check('instagram daily cap is a rate limit', errors.isRateLimited(meta(9, 2207042)) && errors.isRateLimited(meta(4)))
check('other codes are plain failures', !errors.isTransient(meta(100)) && !errors.isRateLimited(meta(9)))

// --- connect URLs ---
const igAuth = new URL(ADAPTERS.instagram.authorizeUrl({ state: 's', redirectUri: 'https://app.test/cb' }))
check('instagram authorize uses the instagram app id', igAuth.hostname === 'www.instagram.com' && igAuth.searchParams.get('client_id') === 'ig-app')
const fbScopes = new URL(ADAPTERS.facebook.authorizeUrl({ state: 's', redirectUri: 'https://app.test/cb' }))
check('facebook asks for page scopes without a configuration', fbScopes.searchParams.get('scope')!.includes('pages_manage_posts') && !fbScopes.searchParams.has('config_id'))
process.env.FACEBOOK_CONFIG_ID = 'cfg-1'
const fbConfig = new URL(ADAPTERS.facebook.authorizeUrl({ state: 's', redirectUri: 'https://app.test/cb' }))
check('facebook sends config_id instead of scopes when set', fbConfig.searchParams.get('config_id') === 'cfg-1' && !fbConfig.searchParams.has('scope'))
delete process.env.FACEBOOK_CONFIG_ID

// --- images ---
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toBuffer()
const dims = async (b: Uint8Array) => { const m = await sharp(b).metadata(); return { w: m.width!, h: m.height!, format: m.format } }
const tall = await dims(await media.toJpeg(await png(900, 1600), media.INSTAGRAM_JPEG))
check('a 9:16 image is padded to 4:5 for instagram', tall.format === 'jpeg' && Math.abs(tall.w / tall.h - 0.8) < 0.01)
const wide = await dims(await media.toJpeg(await png(3000, 1000), media.INSTAGRAM_JPEG))
check('a 3:1 image is padded to 1.91:1 and scaled to 1440', wide.w === 1440 && Math.abs(wide.w / wide.h - 1.91) < 0.01)
const small = await dims(await media.toJpeg(await png(100, 100), media.INSTAGRAM_JPEG))
check('a tiny image is scaled up to 320', small.w === 320 && small.h === 320)
const ok = await dims(await media.toJpeg(await png(1200, 800), media.INSTAGRAM_JPEG))
check('an image within the rules keeps its size', ok.w === 1200 && ok.h === 800)

// --- stubbed network: each call is answered by the first matching route ---
type Route = [RegExp, (req: { url: string; method: string; body: unknown; headers: Headers }) => Response | Promise<Response>]
const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
let routes: Route[] = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch, realTimeout = globalThis.setTimeout
globalThis.setTimeout = ((fn: () => void) => { fn(); return 0 }) as unknown as typeof setTimeout
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input)
  const req = { url, method: init.method ?? 'GET', body: init.body, headers: new Headers(init.headers) }
  calls.push(req)
  const route = routes.find(([re]) => re.test(url))
  if (!route) throw new Error(`unexpected fetch ${req.method} ${url}`)
  return route[1](req)
}) as typeof fetch
const pngBytes = await png(900, 1600)
const imageRoute: Route = [/^https:\/\/cdn\.test\//, () => new Response(new Uint8Array(pngBytes), { headers: { 'content-type': 'image/png' } })]
let uploaded: Uint8Array | null = null
const r2Route: Route = [/r2\.cloudflarestorage\.com/, async req => { uploaded = new Uint8Array(req.body as Uint8Array); return new Response('') }]
const form = (body: unknown) => Object.fromEntries(new URLSearchParams(String(body)))

// Instagram: image rehosted as a padded JPEG, container polled, then published
const igAcc = db.upsertAccount({ platform: 'instagram', external_id: 'ig-user', username: 'insta', access_token: 'ig-token',
  token_expires_at: new Date(Date.now() + 50 * 86_400_000).toISOString() })
let polls = 0
routes = [imageRoute, r2Route,
  [/graph\.instagram\.com\/v25\.0\/ig-user\/media$/, () => json({ id: 'container-1' })],
  [/graph\.instagram\.com\/v25\.0\/container-1\?/, () => json({ status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' })],
  [/graph\.instagram\.com\/v25\.0\/ig-user\/media_publish$/, () => json({ id: 'ig-media-1' })],
]
calls.length = 0
const igIds = await ADAPTERS.instagram.publish({ text: triple, imageUrl: 'https://cdn.test/a.png', kind: 'news' }, db.getAccountToken(igAcc)!)
check('instagram returns the media id', igIds.join() === 'ig-media-1')
const igCreate = form(calls.find(c => c.url.endsWith('/ig-user/media'))!.body)
check('instagram gets the R2 copy as JPEG', igCreate.image_url.startsWith('https://media.test/instagram/') && igCreate.image_url.endsWith('.jpg'))
check('instagram caption is cut to 2200', igCreate.caption.length <= 2200 && igCreate.caption.endsWith(source))
const igUp = await dims(uploaded!)
check('the uploaded copy meets instagram ratio rules', igUp.format === 'jpeg' && Math.abs(igUp.w / igUp.h - 0.8) < 0.01)
check('instagram waits for the container', polls === 2)
routes = [[/graph\.instagram\.com\/v25\.0\/ig-media-1\/insights/, () => json({ data: [
  { name: 'views', values: [{ value: 1200 }] }, { name: 'likes', values: [{ value: 30 }] },
  { name: 'comments', values: [{ value: 4 }] }, { name: 'shares', values: [{ value: 2 }] },
] })]]
const igIns = await ADAPTERS.instagram.fetchInsights('ig-media-1', db.getAccountToken(igAcc)!)
check('instagram insights map comments to replies', igIns.views === 1200 && igIns.replies === 4 && igIns.shares === 2 && igIns.reposts === 0)

// Facebook: connect keeps only Pages that can be posted to; photos publish in one call
routes = [
  [/graph\.facebook\.com\/v25\.0\/oauth\/access_token\?.*code=/, () => json({ access_token: 'short' })],
  [/graph\.facebook\.com\/v25\.0\/oauth\/access_token\?.*fb_exchange_token/, () => json({ access_token: 'long' })],
  [/graph\.facebook\.com\/v25\.0\/me\/accounts/, () => json({ data: [
    { id: 'p1', name: 'Berita Page', access_token: 'pt1', tasks: ['CREATE_CONTENT', 'ANALYZE'] },
    { id: 'p2', name: 'Moderated', access_token: 'pt2', tasks: ['MODERATE'] },
  ] })],
]
const pages = await ADAPTERS.facebook.connect({ code: 'c', redirectUri: 'https://app.test/cb' })
check('facebook connect adds postable pages with their own tokens', pages.length === 1 && pages[0].external_id === 'p1' && pages[0].access_token === 'pt1' && pages[0].token_expires_at === null)
const fbAcc = db.upsertAccount({ platform: 'facebook', ...pages[0] })
routes = [imageRoute, r2Route, [/graph\.facebook\.com\/v25\.0\/p1\/photos$/, () => json({ id: 'photo-1', post_id: 'p1_post-1' })]]
calls.length = 0
const fbIds = await ADAPTERS.facebook.publish({ text: news, imageUrl: 'https://cdn.test/a.png', kind: 'news' }, db.getAccountToken(fbAcc)!)
const fbBody = form(calls.find(c => c.url.endsWith('/p1/photos'))!.body)
check('facebook returns the page post id', fbIds.join() === 'p1_post-1')
check('facebook posts the whole caption with the R2 copy', fbBody.caption === news.trim() && fbBody.url.startsWith('https://media.test/facebook/') && fbBody.access_token === 'pt1')

// The worker: a platform limit puts the post back, a rejected token pauses only that account
const past = db.toSqlTime(Date.now() - 60_000)
const capped = db.queuePost({ account_id: igAcc, caption: 'capped', image_url: 'https://cdn.test/a.png', kind: 'affiliate', scheduled_at: past })!
const rejected = db.queuePost({ account_id: fbAcc, caption: 'rejected', image_url: 'https://cdn.test/a.png', kind: 'affiliate', scheduled_at: past })!
routes = [imageRoute, r2Route,
  [/graph\.instagram\.com\/v25\.0\/ig-user\/media$/, () => json({ error: { message: 'Application request limit reached', code: 9, error_subcode: 2207042 } }, 400)],
  [/graph\.facebook\.com\/v25\.0\/p1\/photos$/, () => json({ error: { message: 'Session has expired', code: 190, error_subcode: 463 } }, 400)],
]
const results = await Promise.all(db.claimDuePosts().map(publishClaimed))
const row = (id: number) => db.getDb().prepare('SELECT status, attempts, scheduled_at FROM posts WHERE id = ?').get(id) as { status: string; attempts: number; scheduled_at: string }
check('a capped post waits an hour without spending an attempt',
  results.find(r => r.id === capped)?.deferred_min === 60 && row(capped).status === 'scheduled' && row(capped).attempts === 0 && row(capped).scheduled_at > db.toSqlTime(Date.now() + 59 * 60_000))
check('a rejected token pauses its account only',
  results.find(r => r.id === rejected)?.paused === true && !!db.listAccounts().find(a => a.id === fbAcc)?.token_invalid_at &&
  !db.listAccounts().find(a => a.id === igAcc)?.token_invalid_at && row(rejected).status === 'scheduled')

globalThis.fetch = realFetch
globalThis.setTimeout = realTimeout
cleanup()
console.log(`OK — ${n} assertions passed (text per platform, error classes, connect URLs, image rules, Instagram, Facebook, worker limits)`)
