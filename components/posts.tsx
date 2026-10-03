'use client'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Copy, ExternalLink, Eye, Heart, Inbox, MessageCircle, Quote, Repeat2, RotateCcw, Search, Send, Share2, SquarePen, Trash2, X } from 'lucide-react'
import { partsFor } from '@/lib/text'
import { useApp } from './app'
import { PageHead } from './shell'
import { api, compact, dateTime, dayLabel, handle, jakartaDay, num, PLATFORM_LABEL, relative, time, type Account, type Kind, type Post } from './format'
import { Avatar, EmptyState, KindTag, Modal, PlatformBadge, Segmented, Skeleton, StatusPill, Thumb } from './ui'

type Tab = 'queue' | 'failed' | 'history'
const TABS: { id: Tab; label: string }[] = [{ id: 'queue', label: 'Antrean' }, { id: 'failed', label: 'Gagal' }, { id: 'history', label: 'Terbit' }]
const PAGE = 25

/** The URL holds the view, so a reload or a shared link opens the same list. */
function useQuery() {
  const params = useSearchParams()
  const set = (patch: Record<string, string | number | null>) => {
    const q = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) v === null || v === '' ? q.delete(k) : q.set(k, String(v))
    const s = q.toString()
    history.replaceState(null, '', s ? `?${s}` : location.pathname)
  }
  return [params, set] as const
}

/** A source link's site, or the link itself when it does not parse. */
const host = (url: string) => { try { return new URL(url).hostname } catch { return url } }

/** When a post belongs on the timeline: its slot while queued, its publish time after. */
const when = (p: Post) => p.status === 'published' || p.status === 'failed' ? p.published_at ?? p.scheduled_at : p.scheduled_at

/**
 * Posts as Buffer lays them out: channels down the left, the queue, failures and published posts
 * as tabs, each a timeline grouped by day. A row opens the post's details on the side.
 */
export function Posts() {
  const { accounts, activity, version, refresh, toast, confirm, compose } = useApp()
  const [query, setQuery] = useQuery()
  const tab = (['queue', 'failed', 'history'].includes(query.get('tab') ?? '') ? query.get('tab') : 'queue') as Tab
  const account = Number(query.get('account')) || null
  const kind = (query.get('kind') === 'news' || query.get('kind') === 'affiliate' ? query.get('kind') : '') as Kind | ''
  const q = query.get('q') ?? ''
  const page = Math.max(1, Number(query.get('page')) || 1)
  const [search, setSearch] = useState(q)
  const [posts, setPosts] = useState<Post[] | null>(null)
  const [totals, setTotals] = useState<Record<Tab, number> | null>(null)
  const [stale, setStale] = useState(false)
  const [open, setOpen] = useState<Post | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  // Typing settles for 300 ms before the search reaches the URL and the server.
  useEffect(() => {
    if (search === q) return
    const t = setTimeout(() => setQuery({ q: search.trim() || null, page: null }), 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    const n = ++seq.current
    const filters = `${kind ? `&kind=${kind}` : ''}${account ? `&account=${account}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`
    const list = (v: Tab, limit: number, p = 1) => api<{ posts: Post[]; total: number }>(`/api/posts?view=${v}&page=${p}&limit=${limit}${filters}`)
    setStale(true)
    Promise.all(TABS.map(t => t.id === tab ? list(t.id, PAGE, page) : list(t.id, 1))).then(rs => {
      if (n !== seq.current) return
      setTotals({ queue: rs[0].data.total ?? 0, failed: rs[1].data.total ?? 0, history: rs[2].data.total ?? 0 })
      setPosts(rs[TABS.findIndex(t => t.id === tab)].data.posts ?? [])
      setStale(false)
    })
  }, [tab, account, kind, q, page, version])

  const total = totals?.[tab] ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const per = new Map(activity?.accounts.map(a => [a.account_id, a]))
  const count = (id: number | null) => {
    if (tab === 'history') return null
    const field = tab === 'queue' ? 'queued' : 'failed'
    return id === null ? activity?.accounts.reduce((n, a) => n + a[field], 0) ?? null : per.get(id)?.[field] ?? null
  }

  async function remove(p: Post) {
    const name = PLATFORM_LABEL[p.platform] ?? p.platform
    const live = p.status === 'published' && !p.gone_at
    const ok = await confirm({
      title: live && p.platform !== 'instagram' ? `Hapus post di ${name}?` : 'Hapus post ini?',
      body: !live ? <p>Post dihapus dari SocialPilot.{p.status === 'failed' && ' Bagian chain Threads yang sudah sempat tayang ikut dihapus.'}</p>
        : p.platform === 'instagram' ? <p>Instagram tidak mengizinkan hapus lewat API. Post hanya dihapus dari SocialPilot; hapus manual di aplikasi Instagram.</p>
        : <p>Post dihapus di {name}{p.platform === 'threads' && ' beserta semua bagian chain-nya'}, lalu dari SocialPilot. Tindakan ini tidak bisa dibatalkan.</p>,
      confirm: 'Hapus', danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await api<{ error?: string; manual?: boolean; still_live?: string[]; platform_deleted?: number }>(`/api/posts/${p.id}`, { method: 'DELETE' })
      const d = r.data
      toast(!r.ok ? d.error || 'Gagal menghapus.'
        : d.manual ? `Post dihapus dari SocialPilot. Hapus manual di ${name}.`
        : d.still_live?.length ? `Post dihapus, tapi ${d.still_live.length} bagian masih tayang di Threads. Hapus manual: ${d.still_live.join(', ')}`
        : d.platform_deleted ? `Post dihapus di ${name}${d.platform_deleted > 1 ? ` (${d.platform_deleted} bagian)` : ''} dan dari SocialPilot.`
        : 'Post dihapus.', r.ok && !d.still_live?.length)
      if (r.ok) { setOpen(null); refresh() }
    } finally {
      setBusy(false)
    }
  }

  async function retry(p: Post) {
    setBusy(true)
    try {
      const r = await api<{ error?: string }>(`/api/posts/${p.id}/retry`, { method: 'POST' })
      toast(r.ok ? 'Post dijadwalkan ulang dan akan dicoba lagi.' : r.data.error || 'Tidak bisa diproses ulang.', r.ok)
      if (r.ok) { setOpen(null); refresh() }
    } finally {
      setBusy(false)
    }
  }

  const groups: [string, Post[]][] = []
  for (const p of posts ?? []) {
    const day = jakartaDay(when(p))
    const last = groups.at(-1)
    if (last?.[0] === day) last[1].push(p)
    else groups.push([day, [p]])
  }
  const scoped = accounts.find(a => a.id === account)

  return (
    <div className="page">
      <PageHead title="Konten" sub="Antrean, post gagal, dan riwayat terbit semua channel.">
        <button type="button" className="btn btn-primary" onClick={() => compose(account ?? undefined)}><SquarePen size={16} />Buat post</button>
      </PageHead>

      <div className="posts-layout">
        <nav className="channel-nav" aria-label="Channel">
          <div className="channel-nav-title">Channel</div>
          <ChannelLink label="Semua channel" on={!account} count={count(null)} onClick={() => setQuery({ account: null, page: null })} />
          {accounts.map(a => <ChannelLink key={a.id} account={a} on={account === a.id} count={count(a.id)} onClick={() => setQuery({ account: a.id, page: null })} />)}
        </nav>

        <section className="card posts-card">
          <div className="posts-toolbar">
            <div className="tabs" role="tablist" aria-label="Status post">
              {TABS.map(t => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : undefined} onClick={() => setQuery({ tab: t.id === 'queue' ? null : t.id, page: null })}>
                  {t.label}{totals && <span className={t.id === 'failed' && totals.failed ? 'count count-bad' : 'count'}>{num(totals[t.id])}</span>}
                </button>
              ))}
            </div>
            <div className="posts-filters">
              <label className="search">
                <Search size={15} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari caption…" aria-label="Cari caption" />
                {search && <button type="button" aria-label="Hapus pencarian" onClick={() => setSearch('')}><X size={14} /></button>}
              </label>
              <Segmented small label="Jenis post" value={kind} onChange={k => setQuery({ kind: k || null, page: null })}
                options={[{ value: '', label: 'Semua' }, { value: 'news', label: 'Berita' }, { value: 'affiliate', label: 'Affiliate' }]} />
            </div>
          </div>

          <div className={stale && posts ? 'timeline stale' : 'timeline'}>
            {posts === null ? <Skeleton rows={6} height={64} /> : posts.length === 0 ? (
              q ? <EmptyState icon={<Search size={20} />} title="Tidak ada yang cocok">Tidak ada post {TABS.find(t => t.id === tab)!.label.toLowerCase()} yang captionnya memuat “{q}”.</EmptyState>
              : tab === 'queue' ? <EmptyState icon={<Inbox size={20} />} title="Antrean kosong" action={<button type="button" className="btn btn-sm btn-primary" onClick={() => compose(account ?? undefined)}><SquarePen size={14} />Buat post</button>}>
                  {scoped ? `Tidak ada post terjadwal untuk ${handle(scoped)}.` : 'Post dari Hermes atau yang kamu buat akan muncul di sini.'}
                </EmptyState>
              : tab === 'failed' ? <EmptyState icon={<CircleCheck size={20} />} title="Tidak ada post gagal">Semua post terkirim dengan baik.</EmptyState>
              : <EmptyState icon={<Send size={20} />} title="Belum ada post terbit">Post yang sudah tayang akan tercatat di sini beserta performanya.</EmptyState>
            ) : groups.map(([day, list]) => (
              <div key={day} className="day">
                <div className="day-head"><b>{dayLabel(day, activity?.today)}</b><span>{num(list.length)} post</span></div>
                {list.map(p => <PostRow key={p.id} post={p} busy={busy} onOpen={() => setOpen(p)} onRetry={() => retry(p)} onDelete={() => remove(p)} />)}
              </div>
            ))}
          </div>

          {pages > 1 && (
            <div className="pager">
              <span>{num((page - 1) * PAGE + 1)}–{num(Math.min(page * PAGE, total))} dari {num(total)}</span>
              <div>
                <button type="button" className="icon-btn" disabled={page <= 1} onClick={() => setQuery({ page: page - 1 === 1 ? null : page - 1 })} aria-label="Halaman sebelumnya"><ChevronLeft size={17} /></button>
                <span className="pager-n">{page} / {pages}</span>
                <button type="button" className="icon-btn" disabled={page >= pages} onClick={() => setQuery({ page: page + 1 })} aria-label="Halaman berikutnya"><ChevronRight size={17} /></button>
              </div>
            </div>
          )}
        </section>
      </div>

      <Modal open={!!open} onClose={() => setOpen(null)} className="drawer" label="Detail post">
        {open && <PostDetail post={open} busy={busy} onClose={() => setOpen(null)} onRetry={() => retry(open)} onDelete={() => remove(open)} />}
      </Modal>
    </div>
  )
}

function ChannelLink({ account, label, on, count, onClick }: { account?: Account; label?: string; on: boolean; count: number | null; onClick: () => void }) {
  return (
    <button type="button" className={`channel-link${on ? ' on' : ''}${account && !account.enabled ? ' off' : ''}`} aria-pressed={on} onClick={onClick}>
      {account ? <Avatar account={account} size={30} /> : <span className="all-icon"><Inbox size={16} /></span>}
      <span className="channel-link-name">
        <b>{account ? handle(account) : label}</b>
        {account && <small>{account.enabled ? PLATFORM_LABEL[account.platform] : 'Nonaktif'}</small>}
      </span>
      {count !== null && count > 0 && <span className="count">{num(count)}</span>}
    </button>
  )
}

function PostRow({ post: p, busy, onOpen, onRetry, onDelete }: { post: Post; busy: boolean; onOpen: () => void; onRetry: () => void; onDelete: () => void }) {
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f() }
  return (
    <div className={`post-row status-row-${p.status}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
      <div className="post-time">
        <b>{time(when(p))}</b>
        {p.status === 'scheduled' && <small>{relative(p.scheduled_at)}</small>}
      </div>
      <Thumb image={p.image_url} video={p.video_url} size={56} />
      <div className="post-main">
        <p className="clamp-2">{p.caption}</p>
        <div className="post-meta">
          <span className="who"><PlatformBadge platform={p.platform} size={16} />{handle(p)}</span>
          <KindTag kind={p.kind} />
          {p.views != null && !p.gone_at && <span className="metric"><Eye size={13} />{compact(p.views)}<Heart size={13} />{num(p.likes ?? 0)}</span>}
          {p.gone_at && <span className="muted">dihapus di {PLATFORM_LABEL[p.platform]}</span>}
          {p.status === 'failed' && p.attempts > 0 && <span className="muted">{p.attempts}× dicoba</span>}
        </div>
        {p.error && p.status !== 'published' && <p className={p.status === 'failed' ? 'post-error' : 'post-note'}>{p.error}</p>}
      </div>
      <div className="post-side">
        {(p.status === 'publishing' || p.status === 'draft') && <StatusPill status={p.status} />}
        <div className="row-actions">
          {p.status === 'failed' && !!p.retryable && <button type="button" className="btn btn-sm" disabled={busy} onClick={stop(onRetry)}><RotateCcw size={14} />Coba lagi</button>}
          {p.status !== 'publishing' && <button type="button" className="icon-btn danger" disabled={busy} onClick={stop(onDelete)} aria-label="Hapus post" title="Hapus"><Trash2 size={16} /></button>}
        </div>
      </div>
    </div>
  )
}

/** Everything about one post: its media, full text as it goes out, times, numbers, and the reason it failed. */
function PostDetail({ post: p, busy, onClose, onRetry, onDelete }: { post: Post; busy: boolean; onClose: () => void; onRetry: () => void; onDelete: () => void }) {
  const [copied, setCopied] = useState(false)
  const parts = p.platform === 'threads' ? partsFor('threads', p.caption) : [p.caption]
  const ids: string[] = (() => { try { return JSON.parse(p.external_ids ?? '[]') } catch { return [] } })()
  const metrics = p.views != null ? [
    { icon: <Eye size={15} />, label: 'Views', v: p.views }, { icon: <Heart size={15} />, label: 'Likes', v: p.likes },
    { icon: <MessageCircle size={15} />, label: 'Balasan', v: p.replies }, { icon: <Repeat2 size={15} />, label: 'Repost', v: p.reposts },
    { icon: <Quote size={15} />, label: 'Kutipan', v: p.quotes }, { icon: <Share2 size={15} />, label: 'Share', v: p.shares },
  ] : []
  async function copy() {
    try { await navigator.clipboard.writeText(p.caption); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ }
  }
  return (
    <div className="detail">
      <div className="detail-head">
        <StatusPill status={p.status} />
        <span className="muted small">Post #{p.id}</span>
        <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="detail-body">
        {(p.image_url || p.video_url) && (
          <div className="detail-media">
            {p.video_url ? <video src={p.video_url} controls muted preload="metadata" /> : <img src={p.image_url!} alt="" referrerPolicy="no-referrer" />}
          </div>
        )}
        <div className="detail-who">
          <Avatar account={{ id: p.account_id, platform: p.platform, username: p.username }} size={36} />
          <div><b>{handle(p)}</b><small>{PLATFORM_LABEL[p.platform]}</small></div>
          <KindTag kind={p.kind} />
        </div>

        {p.status === 'failed' && p.error && <div className="callout callout-bad"><CircleAlert size={16} /><div><b>Alasan gagal</b><p>{p.error}</p></div></div>}
        {p.status !== 'failed' && p.status !== 'published' && p.error && <div className="callout callout-warn"><CircleAlert size={16} /><div><b>Catatan percobaan terakhir</b><p>{p.error}</p></div></div>}
        {p.gone_at && <div className="callout"><CircleAlert size={16} /><div><p>Post ini sudah dihapus di {PLATFORM_LABEL[p.platform]}, jadi tidak ikut dihitung di Analitik.</p></div></div>}

        <div className="detail-section">
          <div className="detail-label">
            Caption{parts.length > 1 && <span className="muted"> · terbit sebagai {parts.length} bagian berantai</span>}
            <button type="button" className="chip-btn" onClick={copy}><Copy size={13} />{copied ? 'Tersalin' : 'Salin'}</button>
          </div>
          {parts.map((part, i) => (
            <div key={i} className="detail-part">{parts.length > 1 && <span className="part-n">{i + 1}/{parts.length}</span>}<p>{part}</p></div>
          ))}
        </div>

        {metrics.length > 0 && (
          <div className="detail-section">
            <div className="detail-label">Performa <span className="muted">· dibaca berkala dari {PLATFORM_LABEL[p.platform]}</span></div>
            <div className="metric-grid">{metrics.map(m => <div key={m.label}>{m.icon}<b>{num(m.v ?? 0)}</b><span>{m.label}</span></div>)}</div>
          </div>
        )}

        <dl className="detail-list">
          <dt>Jadwal</dt><dd>{dateTime(p.scheduled_at)} WIB</dd>
          {p.published_at && <><dt>{p.status === 'published' ? 'Terbit' : 'Percobaan terakhir'}</dt><dd>{dateTime(p.published_at)} WIB</dd></>}
          {p.attempts > 0 && <><dt>Percobaan</dt><dd>{num(p.attempts)}×</dd></>}
          {p.source_url && <><dt>Sumber</dt><dd><a href={p.source_url} target="_blank" rel="noreferrer" className="link">{host(p.source_url)}<ExternalLink size={13} /></a></dd></>}
          {ids.length > 0 && <><dt>ID di platform</dt><dd className="mono">{ids.join(', ')}</dd></>}
        </dl>
      </div>
      <div className="detail-foot">
        {p.status !== 'publishing' && <button type="button" className="btn btn-ghost-danger" disabled={busy} onClick={onDelete}><Trash2 size={15} />Hapus</button>}
        {p.status === 'failed' && !!p.retryable && <button type="button" className="btn btn-primary" disabled={busy} onClick={onRetry}><RotateCcw size={15} />Coba lagi</button>}
      </div>
    </div>
  )
}
