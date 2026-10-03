'use client'
import { useEffect, useState } from 'react'
import { ArrowRight, Check, Copy, KeyRound, Layers, Newspaper, Pencil, Plus, Shuffle, ShoppingBag, Trash2 } from 'lucide-react'
import { useApp } from './app'
import { PageHead } from './shell'
import { api, GROUP_KIND_LABEL, handle, KIND_LABEL, KINDS, MODE_LABEL, num, PLATFORM_LABEL, tokenState, type Account, type Group, type GroupKind, type Kind, type Mode, type Platform } from './format'
import { Avatar, EmptyState, KindTag, PlatformBadge, Segmented, Skeleton, Switch } from './ui'

type AccountChange = { enabled?: boolean; auto_news?: boolean; auto_affiliate?: boolean }
type GroupChange = { name?: string; mode?: Mode; kind?: GroupKind; account_ids?: number[] }

const PLATFORM_HINT: Record<Platform, string> = {
  threads: 'Profil Threads. Post panjang jadi balasan berantai.',
  instagram: 'Akun Business atau Creator, tanpa perlu Page.',
  facebook: 'Facebook Page. Tiap Page jadi satu channel.',
}

/**
 * Channels and the rules that feed them. Each account says which kinds it takes from Hermes;
 * groups say how accounts share an item (lib/routing.ts). Switches apply at once and show
 * their new state before the server answers.
 */
export function Accounts() {
  const app = useApp()
  const { platforms, activity, loaded, refresh, toast, confirm } = app
  const [accounts, setAccounts] = useState<Account[]>(app.accounts)
  const [groups, setGroups] = useState<Group[]>(app.groups)
  useEffect(() => setAccounts(app.accounts), [app.accounts])
  useEffect(() => setGroups(app.groups), [app.groups])

  async function patch(a: Account, change: AccountChange) {
    setAccounts(list => list.map(x => x.id === a.id ? { ...x, ...Object.fromEntries(Object.entries(change).map(([k, v]) => [k, v ? 1 : 0])) } : x))
    const r = await api<{ error?: string }>('/api/accounts', { method: 'PATCH', body: { id: a.id, ...change } })
    if (!r.ok) toast(r.data.error || 'Gagal menyimpan.', false)
    refresh()
  }
  async function regroup(g: Group, change: GroupChange) {
    setGroups(list => list.map(x => x.id === g.id ? { ...x, ...change } : x))
    const r = await api<{ error?: string }>('/api/groups', { method: 'PATCH', body: { id: g.id, ...change } })
    if (!r.ok) toast(r.data.error || 'Gagal menyimpan grup.', false)
    refresh()
  }
  async function create(name: string) {
    const r = await api<{ error?: string }>('/api/groups', { body: { name } })
    if (!r.ok) toast(r.data.error || 'Gagal membuat grup.', false)
    else toast(`${name} dibuat. Atur jenis, cara bagi, dan anggotanya.`)
    refresh()
    return r.ok
  }
  async function drop(g: Group) {
    if (!await confirm({ title: `Hapus grup ${g.name}?`, body: <p>Akun anggotanya tetap ada dan tetap menerima post sesuai pengaturan masing-masing.</p>, confirm: 'Hapus grup', danger: true })) return
    setGroups(list => list.filter(x => x.id !== g.id))
    await api(`/api/groups?id=${g.id}`, { method: 'DELETE' })
    refresh()
  }

  const per = new Map(activity?.accounts.map(a => [a.account_id, a]))

  return (
    <div className="page">
      <PageHead title="Akun & rute" sub="Channel yang terhubung, jenis post yang diterima tiap akun dari Hermes, dan grup pembaginya.">
        <a href="#hubungkan" className="btn"><Plus size={16} />Hubungkan akun</a>
      </PageHead>

      <h2 className="section-title">Channel <span>{num(accounts.length)}</span></h2>
      {!loaded ? <Skeleton rows={2} height={120} /> : accounts.length === 0 ? (
        <EmptyState icon={<Plus size={20} />} title="Belum ada channel">Hubungkan akun Threads, Instagram, atau Facebook Page di bawah.</EmptyState>
      ) : (
        <div className="acct-grid">
          {accounts.map(a => <AccountCard key={a.id} account={a} queued={per.get(a.id)?.queued ?? 0} groups={groups.filter(g => g.account_ids.includes(a.id))} onPatch={change => patch(a, change)} />)}
        </div>
      )}

      {accounts.length > 0 && <>
        <h2 className="section-title">Alur otomatis</h2>
        <p className="section-sub">Post dari Hermes yang tidak menyebut akun tujuan dikirim ke akun yang menerima jenisnya. Grup mengatur pembagiannya.</p>
        <div className="flow-grid">{KINDS.map(k => <Flow key={k} kind={k} accounts={accounts} groups={groups} />)}</div>

        <h2 className="section-title">Grup <span>{num(groups.length)}</span></h2>
        <div className="group-grid">
          {groups.map(g => <GroupCard key={g.id} group={g} accounts={accounts} onChange={change => regroup(g, change)} onDelete={() => drop(g)} />)}
          {accounts.length > 1 && <NewGroup onCreate={create} />}
        </div>
      </>}

      <h2 className="section-title" id="hubungkan">Hubungkan channel</h2>
      <p className="section-sub">Menghubungkan akun yang sama lagi akan memperbarui tokennya.</p>
      <div className="connect-grid">
        {platforms.map(p => p.missing.length ? (
          <div key={p.id} className="connect-card off">
            <PlatformBadge platform={p.id} size={40} />
            <div><b>{p.label}</b><small>Belum diatur: isi {p.missing.join(', ')} di .env</small></div>
          </div>
        ) : (
          <a key={p.id} className="connect-card" href={`/api/auth/${p.id}/authorize`}>
            <PlatformBadge platform={p.id} size={40} />
            <div><b>{p.label}</b><small>{PLATFORM_HINT[p.id]}</small></div>
            <span className="connect-go">Hubungkan <ArrowRight size={14} /></span>
          </a>
        ))}
      </div>
    </div>
  )
}

function AccountCard({ account: a, queued, groups, onPatch }: { account: Account; queued: number; groups: Group[]; onPatch: (c: AccountChange) => void }) {
  const t = tokenState(a)
  const [label, tone] = !a.enabled ? ['Nonaktif', 'off'] : a.token_invalid_at ? ['Dijeda', 'bad'] : ['Aktif', 'ok']
  const auto = (k: Kind) => !!(k === 'news' ? a.auto_news : a.auto_affiliate)
  return (
    <section className={a.enabled ? 'card acct-card' : 'card acct-card off'}>
      <div className="acct-head">
        <Avatar account={a} size={44} />
        <div className="acct-name"><b>{handle(a)}</b><small>{PLATFORM_LABEL[a.platform]} · {num(queued)} di antrean</small></div>
        <span className={`dot-label dot-${tone}`}><i />{label}</span>
      </div>
      <div className={`token token-${t.level}`}>
        <KeyRound size={14} /><span>{t.text}</span>
        {(t.level !== 'ok' || a.platform !== 'facebook') && <a href={`/api/auth/${a.platform}/authorize`} className={t.level === 'ok' ? 'link' : 'btn btn-sm btn-danger'}>Hubungkan ulang</a>}
      </div>
      <div className="acct-routes">
        <div className="field-label">Terima otomatis dari Hermes</div>
        {KINDS.map(k => (
          <div className="switch-row" key={k}>
            <span>{k === 'news' ? <Newspaper size={15} /> : <ShoppingBag size={15} />}{KIND_LABEL[k]}</span>
            <Switch checked={auto(k)} onChange={v => onPatch({ [`auto_${k}`]: v })} label={`Terima post ${KIND_LABEL[k]} otomatis`} disabled={!a.enabled} />
          </div>
        ))}
        {groups.length > 0 && <div className="acct-groups"><Layers size={13} />{groups.map(g => <span key={g.id} className="tag">{g.name}</span>)}</div>}
      </div>
      <div className="acct-foot">
        <div><b>Akun aktif</b><small>{a.enabled ? 'Antrean berjalan dan menerima post.' : 'Antrean berhenti; Hermes tidak mengirim ke sini.'}</small></div>
        <Switch checked={!!a.enabled} onChange={v => onPatch({ enabled: v })} label="Akun aktif" />
      </div>
    </section>
  )
}

/** For one kind: which accounts take it, and the groups that shape where it goes. */
function Flow({ kind, accounts, groups }: { kind: Kind; accounts: Account[]; groups: Group[] }) {
  const takers = accounts.filter(a => a.enabled && (kind === 'news' ? a.auto_news : a.auto_affiliate))
  const rules = groups.filter(g => g.kind === 'all' || g.kind === kind).map(g => ({ g, members: takers.filter(a => g.account_ids.includes(a.id)) })).filter(r => r.members.length > 1)
  const grouped = new Set(rules.flatMap(r => r.members.map(a => a.id)))
  const alone = takers.filter(a => !grouped.has(a.id))
  return (
    <section className="card flow">
      <div className="flow-head"><KindTag kind={kind} /><span className="muted small">{takers.length ? `${num(takers.length)} akun menerima` : 'Tidak ada akun yang menerima'}</span></div>
      {takers.length === 0 ? <p className="muted small">Post {KIND_LABEL[kind]} tanpa akun tujuan tidak diposting ke mana pun. Nyalakan “{KIND_LABEL[kind]}” di salah satu akun.</p> : <>
        {rules.map(({ g, members }) => (
          <div className="flow-rule" key={g.id}>
            <span className={`mode-tag mode-${g.mode}`}>{g.mode === 'same' ? <Copy size={12} /> : <Shuffle size={12} />}{MODE_LABEL[g.mode]}</span>
            <div className="flow-members">{members.map((a, i) => <span key={a.id} className="flow-acct">{i > 0 && <em>{g.mode === 'same' ? '+' : 'atau'}</em>}<Avatar account={a} size={22} />{handle(a)}</span>)}</div>
            <small className="muted">{g.name}</small>
          </div>
        ))}
        {alone.length > 0 && (
          <div className="flow-rule">
            <span className="mode-tag"><Check size={12} />Selalu</span>
            <div className="flow-members">{alone.map(a => <span key={a.id} className="flow-acct"><Avatar account={a} size={22} />{handle(a)}</span>)}</div>
            <small className="muted">tanpa grup</small>
          </div>
        )}
      </>}
    </section>
  )
}

function GroupCard({ group: g, accounts, onChange, onDelete }: { group: Group; accounts: Account[]; onChange: (c: GroupChange) => void; onDelete: () => void }) {
  const [name, setName] = useState<string | null>(null)
  const what = g.kind === 'all' ? 'post' : `post ${KIND_LABEL[g.kind]}`
  const members = accounts.filter(a => g.account_ids.includes(a.id))
  const save = () => { const v = name?.trim(); if (v && v !== g.name) onChange({ name: v }); setName(null) }
  return (
    <section className="card group-card">
      <div className="group-head">
        <span className="group-icon"><Layers size={16} /></span>
        {name === null ? <h3>{g.name}</h3> : (
          <input className="group-name" value={name} autoFocus maxLength={60} aria-label="Nama grup" onChange={e => setName(e.target.value)} onBlur={save}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setName(null) }} />
        )}
        <button type="button" className="icon-btn" aria-label="Ganti nama" title="Ganti nama" onClick={() => setName(g.name)}><Pencil size={15} /></button>
        <button type="button" className="icon-btn danger" aria-label="Hapus grup" title="Hapus grup" onClick={onDelete}><Trash2 size={15} /></button>
      </div>

      <div className="field-label">Berlaku untuk</div>
      <Segmented small label="Jenis post grup" value={g.kind} onChange={kind => onChange({ kind })}
        options={(['news', 'affiliate', 'all'] as GroupKind[]).map(k => ({ value: k, label: GROUP_KIND_LABEL[k] }))} />

      <div className="field-label">Cara membagi</div>
      <div className="mode-cards" role="radiogroup" aria-label="Cara membagi">
        {(['same', 'split'] as Mode[]).map(m => (
          <button key={m} type="button" role="radio" aria-checked={g.mode === m} className={g.mode === m ? 'mode-card on' : 'mode-card'} onClick={() => g.mode !== m && onChange({ mode: m })}>
            <span className="mode-card-title">{m === 'same' ? <Copy size={15} /> : <Shuffle size={15} />}{MODE_LABEL[m]}{g.mode === m && <Check size={15} className="mode-check" />}</span>
            <span>{m === 'same' ? `Semua anggota memposting ${what} yang sama, bersamaan.` : `Tiap ${what} hanya ke satu anggota, yang antreannya paling cepat kosong.`}</span>
          </button>
        ))}
      </div>

      <div className="field-label">Anggota <span className="muted">· {num(members.length)} akun</span></div>
      <div className="member-pick">
        {accounts.map(a => {
          const on = g.account_ids.includes(a.id)
          return (
            <button key={a.id} type="button" aria-pressed={on} className={on ? 'channel-chip on' : 'channel-chip'} onClick={() => onChange({ account_ids: on ? g.account_ids.filter(id => id !== a.id) : [...g.account_ids, a.id] })}>
              <Avatar account={a} size={24} /><span>{handle(a)}</span>{on && <Check size={14} className="chip-check" />}
            </button>
          )
        })}
      </div>
      <p className="group-note">Anggota yang tidak menerima jenis itu (switch Berita/Affiliate di kartunya) dilewati.{members.length < 2 && ' Grup baru berpengaruh dengan minimal 2 anggota.'}</p>
    </section>
  )
}

function NewGroup({ onCreate }: { onCreate: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name?.trim()) return
    setBusy(true)
    if (await onCreate(name.trim())) setName(null)
    setBusy(false)
  }
  if (name === null) return <button type="button" className="card new-group" onClick={() => setName('')}><Plus size={20} /><b>Grup baru</b><span>Atur akun yang posting bersamaan atau bergantian.</span></button>
  return (
    <form className="card new-group-form" onSubmit={submit}>
      <label className="field-label" htmlFor="new-group">Nama grup</label>
      <input id="new-group" className="input" value={name} autoFocus maxLength={60} placeholder='misalnya "Grup Berita"' onChange={e => setName(e.target.value)} />
      <div className="new-group-actions">
        <button type="button" className="btn" onClick={() => setName(null)}>Batal</button>
        <button className="btn btn-primary" disabled={busy || !name.trim()}>Buat grup</button>
      </div>
    </form>
  )
}
