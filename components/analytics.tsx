'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { CircleAlert, Info, Newspaper, ShoppingBag } from 'lucide-react'
import { useApp } from './app'
import { PageHead } from './shell'
import { ActivityChart, Meter, RankList } from './charts'
import { api, compact, ENGAGEMENT_HINT, handle, KIND_LABEL, KINDS, num, pct, PLATFORM_LABEL, type Activity, type Insights, type Kind, type Platform } from './format'
import { Segmented, Skeleton } from './ui'

const PERIODS = [7, 30, 90] as const
type Period = (typeof PERIODS)[number]

/**
 * Performance per kind, Berita beside Affiliate, for one period and one slice of channels.
 * One filter row scopes everything under it, so the numbers always agree with each other.
 * Averages divide by the posts that have a reading; views mean different things per platform,
 * so a single platform or account is the fairer comparison.
 */
export function Analytics() {
  const { accounts, version } = useApp()
  const params = useSearchParams()
  const days = (PERIODS.find(p => p === Number(params.get('days'))) ?? 7) as Period
  const scope = params.get('scope') ?? ''
  const [insights, setInsights] = useState<Insights | null>(null)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [stale, setStale] = useState(false)
  const [rankKind, setRankKind] = useState<Kind>('news')

  const set = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) v ? q.set(k, v) : q.delete(k)
    const s = q.toString()
    history.replaceState(null, '', s ? `?${s}` : location.pathname)
  }

  useEffect(() => {
    const narrow = scope.startsWith('p:') ? `&platform=${scope.slice(2)}` : scope.startsWith('a:') ? `&account=${scope.slice(2)}` : ''
    let live = true
    setStale(true)
    Promise.all([api<Insights>(`/api/insights?days=${days}${narrow}`), api<Activity>(`/api/activity?days=${days}${narrow}`)]).then(([i, a]) => {
      if (!live) return
      setInsights(i.ok ? i.data : null)
      setActivity(a.ok ? a.data : null)
      setStale(false)
    })
    return () => { live = false }
  }, [days, scope, version])

  const connected = [...new Set(accounts.map(a => a.platform))] as Platform[]
  const sums = KINDS.map(k => insights?.by_kind[k])
  const errors = sums.reduce((n, s) => n + (s?.errors ?? 0), 0), gone = sums.reduce((n, s) => n + (s?.gone ?? 0), 0)
  const scopeName = scope.startsWith('p:') ? `semua akun ${PLATFORM_LABEL[scope.slice(2) as Platform]}`
    : scope.startsWith('a:') ? (() => { const a = accounts.find(x => x.id === Number(scope.slice(2))); return a ? `${handle(a)} · ${PLATFORM_LABEL[a.platform]}` : 'akun' })()
    : 'semua channel'

  return (
    <div className="page">
      <PageHead title="Analitik" sub={<>Performa post {days} hari terakhir, {scopeName}.</>} />

      <div className="filter-row">
        <Segmented label="Periode" value={days} onChange={d => set({ days: d === 7 ? null : String(d) })} options={PERIODS.map(p => ({ value: p, label: `${p} hari` }))} />
        <label className="select">
          <span className="sr-only">Channel</span>
          <select value={scope} onChange={e => set({ scope: e.target.value || null })}>
            <option value="">Semua channel</option>
            {connected.length > 1 && <optgroup label="Per platform">{connected.map(p => <option key={p} value={`p:${p}`}>{PLATFORM_LABEL[p]}</option>)}</optgroup>}
            <optgroup label="Per akun">{accounts.map(a => <option key={a.id} value={`a:${a.id}`}>{handle(a)} · {PLATFORM_LABEL[a.platform]}</option>)}</optgroup>
          </select>
        </label>
      </div>

      {(errors > 0 || gone > 0) && (
        <div className="notes">
          {errors > 0 && <p className="note note-warn"><CircleAlert size={15} /><span>{num(errors)} post gagal dibaca insight-nya terakhir kali dan akan dicoba lagi tiap jam. Detailnya ada di <a href="/api/agents?limit=100" target="_blank" rel="noreferrer">feed crew</a>.</span></p>}
          {gone > 0 && <p className="note"><Info size={15} />{num(gone)} post sudah dihapus di platformnya, jadi tidak ikut dihitung.</p>}
        </div>
      )}

      <div className={stale && insights ? 'kind-cards stale' : 'kind-cards'}>
        {KINDS.map((k, i) => {
          const s = sums[i]
          return (
            <section key={k} className={`card kind-card kind-card-${k}`}>
              <div className="kind-card-head">
                <span className={`kind-icon kind-icon-${k}`}>{k === 'news' ? <Newspaper size={17} /> : <ShoppingBag size={17} />}</span>
                <h2>{KIND_LABEL[k]}</h2>
                <span className="muted small">{num(s?.posts ?? 0)} post terbit</span>
              </div>
              {!insights ? <Skeleton rows={2} height={40} /> : s?.covered ? <>
                <div className="hero-num">{compact(s.avg_views)}</div>
                <div className="hero-label">rata-rata views per post</div>
                <div className="kind-stats">
                  <div><span>Likes per post</span><b>{num(s.avg_likes, 1)}</b></div>
                  <div><span title={ENGAGEMENT_HINT}>Engagement <Info size={12} /></span><b>{pct(s.engagement_rate)}</b></div>
                  <div><span>Sudah terbaca</span><b>{num(s.covered)}/{num(s.posts)}</b><Meter value={s.covered} max={s.posts} label={`${s.covered} dari ${s.posts} post terbaca`} /></div>
                </div>
              </> : <p className="muted kind-empty">{s?.posts ? 'Belum ada yang terbaca. Angka muncul setelah worker membaca insight-nya.' : 'Tidak ada post di periode ini.'}</p>}
            </section>
          )
        })}
      </div>

      <section className={stale && activity ? 'card stale' : 'card'}>
        <div className="card-head"><div><h2>Post terbit per hari</h2><p>{days} hari terakhir, {scopeName}</p></div></div>
        {activity ? <ActivityChart days={activity.days} height={days === 7 ? 170 : 200} /> : <Skeleton rows={1} height={200} />}
      </section>

      <section className={stale && insights ? 'card stale' : 'card'}>
        <div className="card-head">
          <div><h2>Peringkat post</h2><p>Berdasarkan views. Post di bawah satu hari belum masuk daftar terendah.</p></div>
          <Segmented small label="Jenis post" value={rankKind} onChange={setRankKind} options={KINDS.map(k => ({ value: k, label: KIND_LABEL[k] }))} />
        </div>
        {!insights ? <Skeleton rows={4} height={40} /> : (
          <div className="rank-cols">
            <div><h3>Teratas</h3><RankList kind={rankKind} items={insights.top_by_kind[rankKind] ?? []} empty={`Belum ada post ${KIND_LABEL[rankKind]} yang terbaca.`} /></div>
            <div><h3>Terendah</h3><RankList kind={rankKind} items={insights.bottom_by_kind[rankKind] ?? []} scale={insights.top_by_kind[rankKind]?.[0]?.views} empty={`Belum ada post ${KIND_LABEL[rankKind]} berumur lebih dari sehari.`} /></div>
          </div>
        )}
      </section>

      <p className="footnote"><Info size={13} />Angka dibaca worker dari tiap platform secara berkala, jadi bisa tertinggal sampai 12 jam. Engagement = {ENGAGEMENT_HINT.toLowerCase()}.</p>
    </div>
  )
}
