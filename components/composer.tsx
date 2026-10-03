'use client'
import { useEffect, useRef, useState } from 'react'
import { Bookmark, CalendarClock, Check, Clock3, Film, Globe, Heart, ImageIcon, Layers, Link2, MessageCircle, Newspaper, Repeat2, Send, Share2, ShoppingBag, ThumbsUp, X } from 'lucide-react'
import { INSTAGRAM_LIMIT, FACEBOOK_LIMIT, partsFor, previewFor } from '@/lib/text'
import { useApp } from './app'
import { api, handle, num, PLATFORM_LABEL, shortDateTime, type Account, type Kind, type Platform } from './format'
import { Avatar, Modal, PlatformBadge, PlatformIcon, Segmented } from './ui'

type Draft = { caption: string; media: string; mediaKind: 'image' | 'video'; kind: Kind; selected: number[]; when: 'queue' | 'at'; at: string }
const EMPTY: Draft = { caption: '', media: '', mediaKind: 'image', kind: 'news', selected: [], when: 'queue', at: '' }
const HTTPS = /^https:\/\/\S+$/
const VIDEO_URL = /\.(mp4|mov|m4v|webm)(\?|#|$)/i
const DRAFT_KEY = 'sp-composer-draft'

/** A datetime-local value for a moment, read in WIB. */
const wibInput = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16)
const wibIso = (local: string) => `${local}:00+07:00`

/**
 * The composer, after Buffer's and Sprout's: channels on top with one-click group picks,
 * the caption with a per-platform count, the media with its own preview, and on the right
 * the post as each selected platform will show it. The draft survives closing, and a reload.
 */
export function Composer({ open, preset, onClose }: { open: boolean; preset?: number; onClose: () => void }) {
  const { accounts, groups, toast, refresh } = useApp()
  const [d, setD] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Platform | null>(null)
  const [broken, setBroken] = useState(false)
  const restored = useRef(false)
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }))

  // localStorage may be missing or full; the draft then lives only in memory.
  useEffect(() => {
    try { const saved = localStorage.getItem(DRAFT_KEY); if (saved) setD({ ...EMPTY, ...JSON.parse(saved) }) } catch { /* no storage */ }
    restored.current = true
  }, [])
  useEffect(() => {
    if (!restored.current) return
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) } catch { /* no storage */ }
  }, [d])

  const usable = accounts.filter(a => a.enabled)
  // Opened from one account's view: start with that account. With a single account, there is nothing to pick.
  useEffect(() => {
    if (!open) return
    if (preset && usable.some(a => a.id === preset)) setD(x => ({ ...x, selected: [preset] }))
    else if (usable.length === 1) setD(x => x.selected.length ? x : { ...x, selected: [usable[0].id] })
  }, [open, preset])
  useEffect(() => setBroken(false), [d.media, d.mediaKind])

  const targets = usable.filter(a => d.selected.includes(a.id))
  const platforms = [...new Set(targets.map(a => a.platform))]
  const shown = tab && platforms.includes(tab) ? tab : platforms[0] ?? null
  const media = d.media.trim()
  const atMs = d.at ? Date.parse(wibIso(d.at)) : NaN
  const missing = !targets.length ? 'Pilih minimal satu channel'
    : !d.caption.trim() ? 'Tulis caption dulu'
    : !media ? 'Tambahkan URL gambar atau video'
    : !HTTPS.test(media) ? 'URL media harus diawali https://'
    : d.when === 'at' && !(atMs > Date.now()) ? 'Pilih waktu yang belum lewat'
    : null

  const toggle = (id: number) => set({ selected: d.selected.includes(id) ? d.selected.filter(x => x !== id) : [...d.selected, id] })
  const pickGroup = (ids: number[]) => set({ selected: usable.filter(a => ids.includes(a.id)).map(a => a.id) })
  const quickGroups = groups.filter(g => g.account_ids.some(id => usable.some(a => a.id === id)))

  async function submit(mode: 'now' | 'queue') {
    if (missing || busy || (mode === 'now' && targets.length !== 1)) return
    setBusy(true)
    const file = d.mediaKind === 'video' ? { videoUrl: media } : { imageUrl: media }
    try {
      if (mode === 'now') {
        const r = await api<{ published?: boolean; platform?: Platform; parts?: number; error?: string }>('/api/publish', { body: { text: d.caption, ...file, kind: d.kind, accountId: targets[0].id } })
        if (!r.ok || !r.data.published) throw new Error(r.data.error || 'Gagal menerbitkan')
        toast(`Terbit di ${PLATFORM_LABEL[r.data.platform!] ?? r.data.platform}${(r.data.parts ?? 1) > 1 ? ` dalam ${r.data.parts} bagian` : ''}.`)
      } else {
        const at = d.when === 'at' ? { scheduledAt: wibIso(d.at) } : {}
        const r = await api<{ queued?: number; skipped_duplicates?: string[]; error?: string }>('/api/posts', { body: { items: targets.map(a => ({ accountId: a.id, caption: d.caption, ...file, kind: d.kind, ...at })) } })
        if (!r.ok) throw new Error(r.data.error || 'Gagal menambahkan ke antrean')
        const skipped = r.data.skipped_duplicates?.length ? ' Sebagian dilewati karena sudah pernah diantrekan.' : ''
        toast(d.when === 'at' ? `${r.data.queued} post dijadwalkan ${shortDateTime(new Date(atMs).toISOString())} WIB.${skipped}` : `${r.data.queued} post masuk antrean.${skipped}`)
      }
      set({ caption: '', media: '', when: 'queue', at: '' })
      onClose()
      refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} className="composer" label="Buat post">
      <div className="composer-head">
        <h2>Buat post</h2>
        <span className="muted small">Draf tersimpan otomatis</span>
        <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={18} /></button>
      </div>

      <div className="composer-body" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit('queue') }}>
        <div className="composer-form">
          <section>
            <div className="field-label">Posting ke</div>
            {usable.length === 0 ? <p className="muted small">Belum ada akun aktif. Hubungkan atau aktifkan akun di halaman Akun.</p> : (
              <div className="channel-pick">
                {usable.map(a => {
                  const on = d.selected.includes(a.id)
                  return (
                    <button key={a.id} type="button" className={on ? 'channel-chip on' : 'channel-chip'} aria-pressed={on} onClick={() => toggle(a.id)} title={`${handle(a)} · ${PLATFORM_LABEL[a.platform]}`}>
                      <Avatar account={a} size={26} />
                      <span>{handle(a)}</span>
                      {on && <Check size={14} className="chip-check" />}
                    </button>
                  )
                })}
              </div>
            )}
            {usable.length > 1 && (
              <div className="quick-pick">
                <span>Pilih cepat:</span>
                <button type="button" onClick={() => pickGroup(usable.map(a => a.id))}>Semua</button>
                {quickGroups.map(g => <button type="button" key={g.id} onClick={() => pickGroup(g.account_ids)} title={`Anggota ${g.name}`}><Layers size={12} />{g.name}</button>)}
                {d.selected.length > 0 && <button type="button" onClick={() => set({ selected: [] })}>Kosongkan</button>}
              </div>
            )}
          </section>

          <section>
            <div className="field-label">Jenis post</div>
            <Segmented label="Jenis post" value={d.kind} onChange={kind => set({ kind })} options={[
              { value: 'news', label: 'Berita', icon: <Newspaper size={15} /> },
              { value: 'affiliate', label: 'Affiliate', icon: <ShoppingBag size={15} /> },
            ]} />
          </section>

          <section>
            <label className="field-label" htmlFor="caption">Caption</label>
            <textarea id="caption" className="caption" data-autofocus value={d.caption} onChange={e => set({ caption: e.target.value })}
              placeholder={d.kind === 'news' ? 'Tulis beritanya… Akhiri dengan "Sumber: https://…" supaya sumbernya tetap ada walau dipotong.' : 'Tulis caption produknya…'} />
            <CaptionMeta text={d.caption} platforms={platforms} />
          </section>

          <section>
            <div className="field-label">Media <span className="req">wajib</span></div>
            <div className="media-input">
              <Segmented small label="Jenis media" value={d.mediaKind} onChange={mediaKind => set({ mediaKind })} options={[
                { value: 'image', label: 'Gambar', icon: <ImageIcon size={14} /> },
                { value: 'video', label: 'Video', icon: <Film size={14} /> },
              ]} />
              <div className="input-icon">
                <Link2 size={15} />
                <input value={d.media} inputMode="url" placeholder={d.mediaKind === 'video' ? 'https://…/video.mp4' : 'https://…/gambar.jpg'}
                  onChange={e => set({ media: e.target.value, ...(VIDEO_URL.test(e.target.value) ? { mediaKind: 'video' as const } : {}) })} />
              </div>
            </div>
            {HTTPS.test(media) && (
              <div className="media-preview">
                {d.mediaKind === 'video' ? <video src={media} controls muted preload="metadata" />
                  : broken ? <p className="muted small">Pratinjau tidak bisa dimuat, mungkin diblokir situs asalnya. SocialPilot tetap akan mencoba mengambilnya saat posting.</p>
                  : <img src={media} alt="Pratinjau media" referrerPolicy="no-referrer" onError={() => setBroken(true)} />}
              </div>
            )}
          </section>
        </div>

        <aside className="composer-preview" aria-label="Pratinjau">
          <div className="preview-tabs" role="tablist" aria-label="Pratinjau per platform">
            {platforms.map(p => (
              <button key={p} type="button" role="tab" aria-selected={p === shown} className={p === shown ? 'on' : undefined} onClick={() => setTab(p)}>
                <PlatformIcon platform={p} size={14} />{PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
          {shown ? (
            <Preview platform={shown} account={targets.find(a => a.platform === shown)!} others={targets.filter(a => a.platform === shown).length - 1}
              text={d.caption} media={HTTPS.test(media) && !broken ? media : null} video={d.mediaKind === 'video'} />
          ) : (
            <div className="preview-empty">
              <div className="preview-empty-icons">{(['threads', 'instagram', 'facebook'] as Platform[]).map(p => <PlatformBadge key={p} platform={p} size={30} />)}</div>
              <p>Pilih channel untuk melihat pratinjau post di tiap platform.</p>
            </div>
          )}
        </aside>
      </div>

      <div className="composer-foot">
        <div className="when">
          <Segmented small label="Waktu terbit" value={d.when} onChange={when => set({ when, at: when === 'at' && !d.at ? wibInput(Date.now() + 3_600_000) : d.at })} options={[
            { value: 'queue', label: 'Antrean otomatis', icon: <Clock3 size={14} /> },
            { value: 'at', label: 'Atur waktu', icon: <CalendarClock size={14} /> },
          ]} />
          {d.when === 'at'
            ? <label className="when-at"><input type="datetime-local" value={d.at} min={wibInput(Date.now())} onChange={e => set({ at: e.target.value })} aria-label="Waktu terbit (WIB)" /><span>WIB</span></label>
            : <span className="muted small when-hint">Menyusul post terakhir tiap channel, berjeda acak 5–30 menit.</span>}
        </div>
        <div className="composer-actions">
          {missing && <span className="hint">{missing}</span>}
          <button type="button" className="btn" disabled={!!missing || busy || targets.length !== 1} onClick={() => submit('now')}
            title={targets.length > 1 ? 'Terbitkan sekarang hanya untuk satu channel; untuk beberapa channel pakai antrean' : 'Kirim saat ini juga'}>
            <Send size={15} />Terbitkan sekarang
          </button>
          <button type="button" className="btn btn-primary" disabled={!!missing || busy} onClick={() => submit('queue')} title="Ctrl + Enter">
            {busy ? 'Mengirim…' : d.when === 'at' ? 'Jadwalkan' : targets.length > 1 ? `Tambah ke ${targets.length} antrean` : 'Tambah ke antrean'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** Length per selected platform: a Threads chain's parts, the others' caps, and a warning where the tail gets cut. */
function CaptionMeta({ text, platforms }: { text: string; platforms: Platform[] }) {
  const length = text.trim().length
  return (
    <div className="caption-meta">
      <span>{num(text.length)} karakter</span>
      {platforms.map(p => {
        const v = previewFor(p, text)
        const label = p === 'threads' ? `${v.parts} bagian` : `${num(length)}/${num(p === 'instagram' ? INSTAGRAM_LIMIT : FACEBOOK_LIMIT)}`
        return (
          <span key={p} className={v.truncated ? 'meta-chip warn' : 'meta-chip'} title={v.truncated ? (p === 'threads' ? 'Terlalu panjang: dipotong supaya muat 7 bagian' : 'Terlalu panjang: ekornya dipotong') : undefined}>
            <PlatformIcon platform={p} size={12} />{label}{v.truncated && ' · dipotong'}
          </span>
        )
      })}
    </div>
  )
}

/** The post as its platform will show it: a reply chain on Threads, a square with caption on Instagram, a Page post on Facebook. */
function Preview({ platform, account, others, text, media, video }: { platform: Platform; account: Account; others: number; text: string; media: string | null; video: boolean }) {
  const [more, setMore] = useState(false)
  useEffect(() => setMore(false), [platform])
  const body = text.trim() ? partsFor(platform, text) : ['Caption kamu akan tampil di sini.']
  const name = platform === 'facebook' ? account.username : account.username || account.external_id
  const shot = media
    ? video ? <video className="pv-media" src={media} muted preload="metadata" /> : <img className="pv-media" src={media} alt="" referrerPolicy="no-referrer" />
    : <div className="pv-media pv-placeholder"><ImageIcon size={28} /></div>

  return (
    <div className={`pv pv-${platform}`}>
      {others > 0 && <p className="pv-note">dan {others} akun {PLATFORM_LABEL[platform]} lain dengan isi yang sama</p>}
      {platform === 'threads' && body.map((part, i) => (
        <div className="pv-th" key={i}>
          <div className="pv-th-rail"><Avatar account={account} size={34} badge={false} />{i < body.length - 1 && <i />}</div>
          <div className="pv-th-main">
            <div className="pv-th-head"><b>{name}</b><span>baru saja</span>{body.length > 1 && <span className="pv-part">{i + 1}/{body.length}</span>}</div>
            <p className={text.trim() ? undefined : 'pv-ghost'}>{part}</p>
            {i === 0 && shot}
            <div className="pv-actions"><Heart size={17} /><MessageCircle size={17} /><Repeat2 size={17} /><Send size={17} /></div>
          </div>
        </div>
      ))}
      {platform === 'instagram' && (
        <div className="pv-ig">
          <div className="pv-ig-head"><Avatar account={account} size={30} badge={false} /><b>{name}</b></div>
          {shot}
          <div className="pv-actions"><Heart size={20} /><MessageCircle size={20} /><Send size={20} /><Bookmark size={20} className="pv-push" /></div>
          <p className={more ? 'pv-cap' : 'pv-cap clamp-2'}><b>{name}</b> <span className={text.trim() ? undefined : 'pv-ghost'}>{body[0]}</span></p>
          {!more && body[0].length > 110 && <button type="button" className="pv-more" onClick={() => setMore(true)}>selengkapnya</button>}
        </div>
      )}
      {platform === 'facebook' && (
        <div className="pv-fb">
          <div className="pv-fb-head"><Avatar account={account} size={38} badge={false} /><div><b>{name}</b><span>Baru saja · <Globe size={11} /></span></div></div>
          <p className={more ? 'pv-cap' : 'pv-cap clamp-5'}><span className={text.trim() ? undefined : 'pv-ghost'}>{body[0]}</span></p>
          {!more && body[0].length > 400 && <button type="button" className="pv-more" onClick={() => setMore(true)}>Lihat selengkapnya</button>}
          {shot}
          <div className="pv-fb-actions"><span><ThumbsUp size={16} />Suka</span><span><MessageCircle size={16} />Komentari</span><span><Share2 size={16} />Bagikan</span></div>
        </div>
      )}
    </div>
  )
}
