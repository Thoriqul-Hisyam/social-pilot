'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CalendarClock, CircleAlert, CircleCheck, Eye, Inbox, KeyRound, Plug, Send, TriangleAlert, Trophy } from 'lucide-react'
import { useApp } from './app'
import { PageHead } from './shell'
import { ActivityChart, Stat } from './charts'
import { BrandMark } from './brand'
import { api, compact, dayShort, daysLeft, greeting, handle, jakartaDay, KIND_LABEL, num, pct, PLATFORM_LABEL, relative, shortDateTime, time, tokenState, type Account, type Insights, type Post } from './format'
import { Avatar, EmptyState, KindTag, PlatformBadge, Skeleton, Thumb } from './ui'

type Issue = { key: string; level: 'bad' | 'warn'; text: React.ReactNode; action?: React.ReactNode }

/**
 * The home page answers "is everything running?" at a glance: what needs attention,
 * today's numbers, the last two weeks, what goes out next, and each channel's state.
 */
export function Home() {
  const { accounts, activity, platforms, loaded, version, compose } = useApp()
  const [next, setNext] = useState<Post[] | null>(null)
  const [insights, setInsights] = useState<Insights | null>(null)
  // The clock only runs in the browser: a prerendered greeting would disagree with it on hydration.
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    api<{ posts: Post[] }>('/api/posts?view=queue&limit=5').then(r => setNext(r.data.posts ?? []))
    api<Insights>('/api/insights?days=7').then(r => setInsights(r.ok ? r.data : null))
  }, [version])

  if (loaded && accounts.length === 0) return <Welcome platforms={platforms.filter(p => !p.missing.length).map(p => p.id)} />

  const per = new Map(activity?.accounts.map(a => [a.account_id, a]))
  const queued = activity?.accounts.reduce((n, a) => n + a.queued, 0) ?? 0
  const failed = activity?.accounts.reduce((n, a) => n + a.failed, 0) ?? 0
  const days = activity?.days ?? []
  const today = days.at(-1), yesterday = days.at(-2)
  const ends = accounts.filter(a => a.enabled).map(a => per.get(a.id)?.queue_ends_at).filter(Boolean).sort() as string[]
  const kinds = Object.values(insights?.by_kind ?? {})
  const covered = kinds.reduce((n, s) => n + s.covered, 0), views = kinds.reduce((n, s) => n + s.views, 0)
  const engaged = kinds.reduce((n, s) => n + s.likes + s.replies + s.reposts + s.quotes + s.shares, 0)

  const issues: Issue[] = []
  for (const a of accounts) {
    if (!a.enabled) continue
    const t = tokenState(a)
    if (t.level !== 'ok' && !a.token_invalid_at) issues.push({ key: `t${a.id}`, level: t.level, text: <><b>{handle(a)}</b> ({PLATFORM_LABEL[a.platform]}): {t.text}.</>, action: <a className="btn btn-sm" href={`/api/auth/${a.platform}/authorize`}>Hubungkan ulang</a> })
    if (a.token_invalid_at) issues.push({ key: `p${a.id}`, level: 'bad', text: <>Antrean <b>{handle(a)}</b> dijeda: token ditolak {PLATFORM_LABEL[a.platform]}.</>, action: <a className="btn btn-sm btn-danger" href={`/api/auth/${a.platform}/authorize`}>Hubungkan ulang</a> })
    else if (activity && !per.get(a.id)?.queued) issues.push({ key: `q${a.id}`, level: 'warn', text: <>Antrean <b>{handle(a)}</b> ({PLATFORM_LABEL[a.platform]}) kosong. Tidak ada post yang akan terbit di sana.</>, action: <button type="button" className="btn btn-sm" onClick={() => compose(a.id)}>Buat post</button> })
  }
  if (failed > 0) issues.push({ key: 'failed', level: 'bad', text: <><b>{num(failed)} post</b> gagal terbit dan menunggu keputusanmu.</>, action: <Link className="btn btn-sm" href="/posts?tab=failed">Tinjau</Link> })

  return (
    <div className="page">
      <PageHead title={now ? greeting(now) : 'Beranda'} sub={<>Ringkasan publikasi semua channel{now && <> · {shortDateTime(now.toISOString())} WIB</>}</>}>
        {loaded && (issues.length
          ? <span className="health health-warn"><TriangleAlert size={15} />{issues.length} hal perlu perhatian</span>
          : <span className="health health-ok"><CircleCheck size={15} />Semua berjalan normal</span>)}
      </PageHead>

      {issues.length > 0 && (
        <section className="card issues" aria-label="Perlu perhatian">
          {issues.map(i => (
            <div key={i.key} className={`issue issue-${i.level}`}>
              {i.level === 'bad' ? <CircleAlert size={17} /> : <TriangleAlert size={17} />}
              <span>{i.text}</span>
              {i.action}
            </div>
          ))}
        </section>
      )}

      <div className="stats">
        <Stat icon={<Send size={15} />} label="Terbit hari ini" value={loaded ? num((today?.news ?? 0) + (today?.affiliate ?? 0)) : '–'}
          sub={yesterday ? `Kemarin ${num(yesterday.news + yesterday.affiliate)} post` : undefined} />
        <Stat icon={<CalendarClock size={15} />} label="Dalam antrean" value={loaded ? num(queued) : '–'}
          sub={ends.length ? `Terakhir terjadwal ${shortDateTime(ends[ends.length - 1])}` : 'Belum ada yang terjadwal'} />
        <Stat icon={<CircleAlert size={15} />} label="Gagal terbit" value={loaded ? num(failed) : '–'} tone={failed ? 'bad' : undefined}
          sub={failed ? <Link href="/posts?tab=failed">Tinjau sekarang <ArrowRight size={13} /></Link> : 'Tidak ada masalah'} />
        <Stat icon={<Eye size={15} />} label="Rata-rata views · 7 hari" value={insights ? (covered ? compact(Math.round(views / covered)) : '–') : '–'}
          sub={covered ? `Engagement ${pct(views ? engaged / views : 0)} dari ${num(covered)} post` : 'Belum ada post yang terbaca'} />
      </div>

      <div className="home-grid">
        <div className="home-col">
          <section className="card home-chart">
            <div className="card-head">
              <div><h2>Aktivitas publikasi</h2><p>Post terbit per hari, 14 hari terakhir</p></div>
              <Link href="/analytics" className="link">Analitik <ArrowRight size={14} /></Link>
            </div>
            {activity ? <ActivityChart days={days} /> : <Skeleton rows={1} height={190} />}
          </section>

          <section className="card home-channels">
            <div className="card-head">
              <div><h2>Channel</h2><p>Status tiap akun yang terhubung</p></div>
              <Link href="/accounts" className="link">Kelola <ArrowRight size={14} /></Link>
            </div>
            {!loaded ? <Skeleton rows={3} height={52} /> : (
              <div className="channels">
                {accounts.map(a => <ChannelRow key={a.id} account={a} queued={per.get(a.id)?.queued ?? 0} next={per.get(a.id)?.next_at ?? null} last={per.get(a.id)?.published_at ?? null} today={per.get(a.id)?.published_24h ?? 0} />)}
              </div>
            )}
          </section>
        </div>

        <div className="home-col">
          <section className="card home-next">
            <div className="card-head">
              <div><h2>Berikutnya</h2><p>Post yang akan terbit</p></div>
              <Link href="/posts" className="link">Antrean <ArrowRight size={14} /></Link>
            </div>
            {next === null ? <Skeleton rows={4} height={44} /> : next.length === 0 ? (
              <EmptyState icon={<Inbox size={20} />} title="Antrean kosong" action={<button type="button" className="btn btn-sm" onClick={() => compose()}>Buat post</button>}>
                Post dari Hermes atau yang kamu buat akan muncul di sini.
              </EmptyState>
            ) : (
              <ol className="upnext">
                {next.map(p => (
                  <li key={p.id}>
                    <div className="upnext-time"><b>{time(p.scheduled_at)}</b><span>{jakartaDay(p.scheduled_at) === activity?.today ? relative(p.scheduled_at) : dayShort(p.scheduled_at)}</span></div>
                    <Thumb image={p.image_url} video={p.video_url} size={40} />
                    <div className="upnext-main">
                      <span className="clamp-1">{p.caption}</span>
                      <small><PlatformBadge platform={p.platform} size={15} />{handle(p)} · {KIND_LABEL[p.kind]}</small>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card home-best">
            <div className="card-head">
              <div><h2>Post terbaik</h2><p>Views terbanyak, 7 hari terakhir</p></div>
            </div>
            {insights === null ? <Skeleton rows={3} height={44} /> : insights.top.length === 0 ? (
              <EmptyState icon={<Trophy size={20} />} title="Belum ada data">Angka muncul setelah worker membaca insight post yang terbit.</EmptyState>
            ) : (
              <ol className="best">
                {insights.top.slice(0, 4).map((p, i) => (
                  <li key={p.id} title={p.caption}>
                    <span className={`best-n n${i + 1}`}>{i + 1}</span>
                    <div><span className="clamp-2">{p.caption}</span><small><KindTag kind={p.kind} /> · {compact(p.views)} views · {num(p.likes)} likes</small></div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function ChannelRow({ account: a, queued, next, last, today }: { account: Account; queued: number; next: string | null; last: string | null; today: number }) {
  const t = tokenState(a)
  const [label, tone] = !a.enabled ? ['Nonaktif', 'off'] : a.token_invalid_at ? ['Dijeda', 'bad'] : !queued ? ['Antrean kosong', 'warn'] : t.level === 'warn' ? ['Token perlu dicek', 'warn'] : ['Berjalan', 'ok']
  const left = daysLeft(a.token_expires_at)
  return (
    <div className={a.enabled ? 'channel' : 'channel off'}>
      <Avatar account={a} size={38} />
      <div className="channel-main">
        <b>{handle(a)}</b>
        <small>{PLATFORM_LABEL[a.platform]}{a.platform !== 'facebook' && left !== null && left >= 0 ? <> · <KeyRound size={11} /> {left} hari</> : null}</small>
      </div>
      <div className="channel-num"><b>{num(queued)}</b><small>antrean</small></div>
      <div className="channel-num"><b>{num(today)}</b><small>terbit 24 jam</small></div>
      <div className="channel-when">
        <small>{next ? <>Berikutnya {relative(next)}</> : 'Tidak ada jadwal'}</small>
        <small>{last ? <>Terakhir {relative(last)}</> : 'Belum pernah terbit'}</small>
      </div>
      <span className={`dot-label dot-${tone}`}><i />{label}</span>
    </div>
  )
}

/** A fresh install: nothing to show yet, so show how to start. */
function Welcome({ platforms }: { platforms: string[] }) {
  return (
    <div className="page">
      <section className="welcome">
        <span className="brand-mark big"><BrandMark size={36} /></span>
        <h1>Selamat datang di SocialPilot</h1>
        <p>Hubungkan akun pertamamu. Setelah itu post dari Hermes masuk antrean otomatis, dan kamu bisa menulis post sendiri kapan saja.</p>
        <div className="welcome-actions">
          {(['threads', 'instagram', 'facebook'] as const).map(p => platforms.includes(p)
            ? <a key={p} className="connect-tile" href={`/api/auth/${p}/authorize`}><PlatformBadge platform={p} size={34} /><b>{PLATFORM_LABEL[p]}</b><span>Hubungkan <ArrowRight size={13} /></span></a>
            : <span key={p} className="connect-tile off"><PlatformBadge platform={p} size={34} /><b>{PLATFORM_LABEL[p]}</b><span><Plug size={13} /> Belum diatur</span></span>)}
        </div>
      </section>
    </div>
  )
}
