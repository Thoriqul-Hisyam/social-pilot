import type { AccountActivity, AccountGroup, DayActivity, KindSummary, Platform, PostKind, PostStatus, RankedPost } from '@/lib/db'

/** The dashboard's view of the API. Account mirrors listAccounts, which never selects a token. */
export type Kind = PostKind
export type Mode = AccountGroup['mode']
export type GroupKind = AccountGroup['kind']
export type Group = AccountGroup
export type Account = {
  id: number; platform: Platform; external_id: string; username: string
  token_expires_at: string | null; token_invalid_at: string | null
  enabled: number; auto_news: number; auto_affiliate: number
}
export type PlatformInfo = { id: Platform; label: string; missing: string[] }
export type Post = {
  id: number; account_id: number; caption: string; kind: Kind; status: PostStatus
  scheduled_at: string; published_at: string | null; error: string | null; retryable: number; attempts: number
  image_url: string | null; video_url: string | null; source_url: string | null; external_ids: string | null
  username: string; platform: Platform; gone_at: string | null
  views: number | null; likes: number | null; replies: number | null; reposts: number | null; quotes: number | null; shares: number | null
}
export type Activity = { today: string; days: DayActivity[]; accounts: AccountActivity[] }
export type Insights = {
  days: number
  by_kind: Partial<Record<Kind, KindSummary>>
  top: RankedPost[]
  top_by_kind: Partial<Record<Kind, RankedPost[]>>
  bottom_by_kind: Partial<Record<Kind, RankedPost[]>>
}
export type { DayActivity, AccountActivity, KindSummary, Platform, RankedPost }

export const KINDS: Kind[] = ['news', 'affiliate']
export const KIND_LABEL: Record<Kind, string> = { news: 'Berita', affiliate: 'Affiliate' }
export const GROUP_KIND_LABEL: Record<GroupKind, string> = { news: 'Berita', affiliate: 'Affiliate', all: 'Semua jenis' }
export const MODE_LABEL: Record<Mode, string> = { same: 'Bersamaan', split: 'Bergantian' }
export const PLATFORM_LABEL: Record<Platform, string> = { threads: 'Threads', instagram: 'Instagram', facebook: 'Facebook' }
export const STATUS_LABEL: Record<PostStatus, string> = {
  draft: 'Draf', scheduled: 'Terjadwal', publishing: 'Sedang dikirim', published: 'Terbit', failed: 'Gagal',
}
/** "(likes + replies + reposts + quotes + shares) / views", in words. */
export const ENGAGEMENT_HINT = 'Interaksi (likes, balasan, repost, kutipan, share) dibagi views'

/** Pages go by name; people by @handle. */
export const handle = (a: { platform: Platform; username: string; external_id?: string }) =>
  a.platform === 'facebook' ? a.username || a.external_id || '' : `@${a.username || a.external_id}`

/** Two letters for an avatar: a Page's initials, or a handle's first two characters. */
export function initials(a: { platform: Platform; username: string }) {
  const name = a.username.trim()
  if (a.platform === 'facebook') {
    const words = name.split(/\s+/).filter(Boolean)
    return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?'
  }
  return name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?'
}

const ID = 'id-ID', TZ = 'Asia/Jakarta'
export const num = (v: number, digits = 0) => new Intl.NumberFormat(ID, { maximumFractionDigits: digits }).format(v)
export const compact = (v: number) => new Intl.NumberFormat(ID, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
export const pct = (v: number) => new Intl.NumberFormat(ID, { style: 'percent', maximumFractionDigits: 1 }).format(v)

/** Stored times are UTC 'YYYY-MM-DD HH:MM:SS'; ISO strings pass through. */
export const toDate = (v: string) => new Date(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`)

const timeFmt = new Intl.DateTimeFormat(ID, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
const dayFmt = new Intl.DateTimeFormat(ID, { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' })
const shortFmt = new Intl.DateTimeFormat(ID, { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const fullFmt = new Intl.DateTimeFormat(ID, { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short', hour12: false })
const dateFmt = new Intl.DateTimeFormat(ID, { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })
const dayShortFmt = new Intl.DateTimeFormat(ID, { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })

/** 14.20, in WIB. */
export const time = (v: string) => timeFmt.format(toDate(v))
/** Sab, 4 Okt 14.20, in WIB. */
export const shortDateTime = (v: string) => shortFmt.format(toDate(v))
/** 4 Okt 2026 14.20, in WIB. */
export const dateTime = (v: string | null) => (v ? fullFmt.format(toDate(v)) : '-')
/** 29 Nov 2026. */
export const date = (v: string) => dateFmt.format(toDate(v))
/** Sab, 4 Okt. */
export const dayShort = (v: string) => dayShortFmt.format(toDate(v))

/** The Jakarta calendar day of a time, 'YYYY-MM-DD'; Jakarta keeps no daylight saving. */
export const jakartaDay = (v: string | Date) =>
  new Date((typeof v === 'string' ? toDate(v) : v).getTime() + 7 * 3_600_000).toISOString().slice(0, 10)

/** Hari ini, Besok, Kemarin, or Sabtu, 4 Okt. */
export function dayLabel(day: string, today = jakartaDay(new Date())) {
  const diff = Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000)
  const named = diff === 0 ? 'Hari ini' : diff === 1 ? 'Besok' : diff === -1 ? 'Kemarin' : null
  const full = dayFmt.format(new Date(`${day}T05:00:00Z`))
  return named ? `${named} · ${full}` : full
}

const rtf = new Intl.RelativeTimeFormat('id', { numeric: 'auto' })
/** dalam 12 menit, 3 jam yang lalu. */
export function relative(v: string, now = Date.now()) {
  const s = (toDate(v).getTime() - now) / 1000
  const abs = Math.abs(s)
  if (abs < 45) return s >= 0 ? 'sebentar lagi' : 'baru saja'
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86_400), 'day')
}

/** Selamat pagi/siang/sore/malam by the hour in Jakarta. */
export function greeting(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat(ID, { timeZone: TZ, hour: 'numeric', hour12: false }).format(now))
  return h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam'
}

/** Whole days until a token runs out; null when unknown. */
export const daysLeft = (expires: string | null) =>
  expires ? Math.floor((toDate(expires).getTime() - Date.now()) / 86_400_000) : null

/**
 * An account's token, as one line and a level. Threads and Instagram tokens live 60 days
 * and refresh themselves weekly; warn a week ahead anyway, and treat an unknown expiry as a
 * warning. Facebook Page tokens do not expire.
 */
export function tokenState(a: Account): { level: 'ok' | 'warn' | 'bad'; text: string } {
  if (a.token_invalid_at) return { level: 'bad', text: `Token ditolak ${PLATFORM_LABEL[a.platform]} sejak ${shortDateTime(a.token_invalid_at)}` }
  if (a.platform === 'facebook') return { level: 'ok', text: 'Token Page tidak kedaluwarsa' }
  const left = daysLeft(a.token_expires_at)
  if (left === null) return { level: 'warn', text: 'Masa berlaku token tidak diketahui' }
  if (left < 0) return { level: 'bad', text: 'Token sudah kedaluwarsa' }
  return { level: left < 7 ? 'warn' : 'ok', text: `Token berlaku s/d ${date(a.token_expires_at!)} (${left} hari lagi)` }
}

/** fetch for the dashboard: JSON both ways, and a lapsed session goes back to the login page. */
export async function api<T = Record<string, unknown>>(url: string, init?: { method?: string; body?: object }): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(url, init?.body
    ? { method: init.method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
    : { method: init?.method ?? 'GET' })
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`
    return new Promise(() => {})
  }
  return { ok: res.ok, data: await res.json().catch(() => ({})) as T }
}
