'use client'

import { useState } from 'react'
import { BarChart3, CircleAlert, CircleCheck, Eye, EyeOff, Layers, Zap } from 'lucide-react'
import { PlatformBadge } from '@/components/ui'
import { BrandMark } from '@/components/brand'

export default function Login() {
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      const next = new URLSearchParams(location.search).get('next') || '/'
      location.href = next
    } else {
      setError((await res.json().catch(() => ({}))).error || 'login gagal')
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <section className="login-art" aria-hidden>
        <div className="brand"><span className="brand-mark"><BrandMark size={21} /></span><span className="brand-name">Social<b>Pilot</b></span></div>
        <div>
          <h2>Satu tempat untuk semua channel kamu.</h2>
          <p>Antrean otomatis dari Hermes, post manual kapan saja, dan performa tiap jenis konten.</p>
          <ul className="login-points">
            <li><span><Zap size={16} /></span>Antrean berjalan 24/7 dengan jeda acak per akun</li>
            <li><span><Layers size={16} /></span>Grup akun: posting bersamaan atau bergantian</li>
            <li><span><BarChart3 size={16} /></span>Views dan engagement Berita vs Affiliate</li>
          </ul>
        </div>
        <div className="login-float">
          <div className="login-float-head">
            <PlatformBadge platform="threads" size={30} />
            <div><b>@channelkamu</b><small>Terjadwal · 14.20 WIB</small></div>
          </div>
          <p>Ringkasan berita teknologi hari ini, dirangkum otomatis dan siap tayang di semua channel…</p>
          <div className="login-float-foot"><PlatformBadge platform="instagram" size={18} /><PlatformBadge platform="facebook" size={18} /><span className="status status-published"><CircleCheck size={13} />Terbit</span></div>
        </div>
      </section>

      <section className="login-pane">
        <form className="login-card" onSubmit={submit}>
          <div className="brand"><span className="brand-mark"><BrandMark size={21} /></span><span className="brand-name">Social<b>Pilot</b></span></div>
          <h1>Masuk</h1>
          <p>Masukkan password dashboard untuk mengelola akun dan jadwal posting.</p>
          <label className="sr-only" htmlFor="password">Password</label>
          <div className="pw">
            <input id="password" className="input" type={show ? 'text' : 'password'} value={password} autoFocus autoComplete="current-password"
              placeholder="Password dashboard" onChange={e => setPassword(e.target.value)} />
            <button type="button" className="icon-btn" onClick={() => setShow(s => !s)} aria-label={show ? 'Sembunyikan password' : 'Tampilkan password'}>
              {show ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {error && <div className="login-error" role="alert"><CircleAlert size={16} />{error}</div>}
          <button className="btn btn-primary" disabled={busy || !password}>{busy ? 'Memeriksa…' : 'Masuk'}</button>
          <p className="login-note">Sesi tersimpan di browser ini.</p>
        </form>
      </section>
    </main>
  )
}
