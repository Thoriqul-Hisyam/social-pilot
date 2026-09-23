'use client'

import { useState } from 'react'
import { Zap } from 'lucide-react'

export default function Login() {
  const [password, setPassword] = useState('')
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
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark"><Zap size={20} fill="currentColor" /></div>
        <h1>Social<span>Pilot</span></h1>
        <p className="muted">Masuk untuk mengelola akun dan jadwal posting.</p>
        <input
          type="password"
          value={password}
          autoFocus
          placeholder="Password dashboard"
          onChange={e => setPassword(e.target.value)}
        />
        {error && <div className="login-error">{error}</div>}
        <button className="primary" disabled={busy || !password}>
          {busy ? 'Memeriksa…' : 'Masuk'}
        </button>
      </form>
    </main>
  )
}
