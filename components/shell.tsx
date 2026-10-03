'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CalendarClock, ChartColumn, CircleAlert, CircleCheck, LayoutDashboard, LogOut, Plus, RefreshCw, SquarePen, UserRound, Users, X } from 'lucide-react'
import { api, handle, PLATFORM_LABEL, shortDateTime, time, type Account, type Activity, type Group, type PlatformInfo } from './format'
import { AppContext, type App, type ConfirmRequest } from './app'
import { BrandMark } from './brand'
import { Menu, Modal } from './ui'
import { Composer } from './composer'

type Toast = { id: number; ok: boolean; text: string }

const NAV = [
  { href: '/', label: 'Beranda', icon: LayoutDashboard },
  { href: '/posts', label: 'Konten', icon: CalendarClock },
  { href: '/analytics', label: 'Analitik', icon: ChartColumn },
  { href: '/accounts', label: 'Akun', icon: Users },
]
/** Accounts, groups and queues refresh this often while the tab is in view. */
const REFRESH_MS = 60_000

/**
 * Everything around the pages: the top bar (the user moved navigation out of a sidebar),
 * a bottom tab bar on phones, banners for paused queues, toasts, the confirm dialog and the
 * composer. It loads what every page shares, accounts, groups and queues, and keeps it fresh.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([])
  const [activity, setActivity] = useState<Activity | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [ask, setAsk] = useState<ConfirmRequest | null>(null)
  const [composing, setComposing] = useState<{ accountId?: number } | null>(null)
  const answer = useRef<(v: boolean) => void>(() => {})
  const first = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [a, act] = await Promise.all([
        api<{ accounts: Account[]; groups: Group[]; platforms: PlatformInfo[] }>('/api/accounts'),
        api<Activity>('/api/activity?days=14'),
      ])
      if (a.ok) { setAccounts(a.data.accounts ?? []); setGroups(a.data.groups ?? []); setPlatforms(a.data.platforms ?? []) }
      if (act.ok) setActivity(act.data)
      setUpdatedAt(Date.now())
      setLoaded(true)
      if (!first.current) setVersion(v => v + 1)
      first.current = false
    } finally {
      setLoading(false)
    }
  }, [])

  const toast = useCallback((text: string, ok = true) => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t.slice(-3), { id, ok, text }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ok ? 4500 : 9000)
  }, [])

  const confirm = useCallback((request: ConfirmRequest) => new Promise<boolean>(resolve => {
    answer.current = resolve
    setAsk(request)
  }), [])
  const settle = (v: boolean) => { answer.current(v); answer.current = () => {}; setAsk(null) }

  useEffect(() => { refresh() }, [refresh])
  // Refresh on a timer while visible, and at once when the tab comes back after a while.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') refresh() }
    const timer = setInterval(tick, REFRESH_MS)
    const back = () => { if (document.visibilityState === 'visible' && Date.now() - (updatedAt ?? 0) > REFRESH_MS) refresh() }
    document.addEventListener('visibilitychange', back)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', back) }
  }, [refresh, updatedAt])
  // The OAuth callback lands on /?connected=<names>.
  useEffect(() => {
    const url = new URL(location.href)
    const names = url.searchParams.get('connected')
    if (names === null) return
    toast(`Akun terhubung: ${names}`)
    url.searchParams.delete('connected')
    history.replaceState(null, '', url.pathname + url.search)
  }, [toast])

  const app: App = { accounts, groups, platforms, activity, loaded, loading, version, refresh, toast, confirm, compose: accountId => setComposing({ accountId }) }
  const paused = accounts.filter(a => a.token_invalid_at)
  const active = (href: string) => href === '/' ? path === '/' : path.startsWith(href)

  async function logout() {
    await fetch('/api/logout', { method: 'POST' })
    location.href = '/login'
  }

  return (
    <AppContext.Provider value={app}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand" aria-label="SocialPilot, beranda">
              <span className="brand-mark"><BrandMark size={21} /></span>
              <span className="brand-name">Social<b>Pilot</b></span>
            </Link>
            <nav className="nav" aria-label="Menu utama">
              {NAV.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className={active(href) ? 'on' : undefined} aria-current={active(href) ? 'page' : undefined}>
                  <Icon size={17} />{label}
                </Link>
              ))}
            </nav>
            <div className="topbar-actions">
              <button type="button" className="icon-btn" onClick={refresh} disabled={loading}
                title={updatedAt ? `Diperbarui ${time(new Date(updatedAt).toISOString())} WIB. Klik untuk memuat ulang` : 'Muat ulang'} aria-label="Muat ulang">
                <RefreshCw size={17} className={loading ? 'spin' : undefined} />
              </button>
              <button type="button" className="btn btn-primary compose-btn" onClick={() => setComposing({})}>
                <SquarePen size={16} /><span>Buat post</span>
              </button>
              <Menu label="Menu akun" className="icon-btn round" trigger={<UserRound size={17} />}>
                <Link href="/accounts" role="menuitem"><Users size={15} />Kelola akun</Link>
                <Link href="/accounts#hubungkan" role="menuitem"><Plus size={15} />Hubungkan akun</Link>
                <hr />
                <button type="button" role="menuitem" onClick={logout}><LogOut size={15} />Keluar</button>
              </Menu>
            </div>
          </div>
        </header>

        {paused.length > 0 && (
          <div className="banners">
            {paused.map(a => (
              <div className="banner banner-bad" key={a.id} role="alert">
                <CircleAlert size={17} />
                <span>Antrean <b>{handle(a)}</b> ({PLATFORM_LABEL[a.platform]}) dijeda sejak {shortDateTime(a.token_invalid_at!)} WIB karena {PLATFORM_LABEL[a.platform]} menolak tokennya.</span>
                <a className="btn btn-sm btn-danger" href={`/api/auth/${a.platform}/authorize`}>Hubungkan ulang</a>
              </div>
            ))}
          </div>
        )}

        <main className="main">{children}</main>

        <nav className="tabbar" aria-label="Menu utama">
          {NAV.slice(0, 2).map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={active(href) ? 'on' : undefined} aria-current={active(href) ? 'page' : undefined}><Icon size={20} />{label}</Link>
          ))}
          <button type="button" className="tabbar-compose" onClick={() => setComposing({})} aria-label="Buat post"><Plus size={24} /></button>
          {NAV.slice(2).map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={active(href) ? 'on' : undefined} aria-current={active(href) ? 'page' : undefined}><Icon size={20} />{label}</Link>
          ))}
        </nav>

        <div className="toasts" role="status" aria-live="polite">
          {toasts.map(t => (
            <div key={t.id} className={t.ok ? 'toast' : 'toast toast-bad'}>
              {t.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
              <span>{t.text}</span>
              <button type="button" className="toast-x" aria-label="Tutup" onClick={() => setToasts(x => x.filter(y => y.id !== t.id))}><X size={15} /></button>
            </div>
          ))}
        </div>

        <Modal open={!!ask} onClose={() => settle(false)} className="confirm" label={ask?.title ?? 'Konfirmasi'}>
          {ask && <>
            <h2>{ask.title}</h2>
            <div className="confirm-body">{ask.body}</div>
            <div className="confirm-foot">
              <button type="button" className="btn" onClick={() => settle(false)}>Batal</button>
              <button type="button" className={ask.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => settle(true)} data-autofocus>{ask.confirm}</button>
            </div>
          </>}
        </Modal>

        <Composer open={!!composing} preset={composing?.accountId} onClose={() => setComposing(null)} />
      </div>
    </AppContext.Provider>
  )
}

/** The title row every page opens with. */
export const PageHead = ({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
    {children && <div className="page-actions">{children}</div>}
  </div>
)
