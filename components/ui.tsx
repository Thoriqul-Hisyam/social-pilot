'use client'
import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Clock3, ImageOff, LoaderCircle, Pencil, Play } from 'lucide-react'
import { initials, KIND_LABEL, PLATFORM_LABEL, STATUS_LABEL, type Kind, type Platform } from './format'
import type { PostStatus } from '@/lib/db'

/** Brand glyphs, drawn in currentColor: Threads from Simple Icons (CC0), Instagram and Facebook as outline marks. */
export function PlatformIcon({ platform, size = 16 }: { platform: Platform; size?: number }) {
  if (platform === 'threads') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z" />
    </svg>
  )
  if (platform === 'instagram') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5.5" /><circle cx="12" cy="12" r="4.2" /><circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  )
}

/** The platform's mark on its brand color. */
export const PlatformBadge = ({ platform, size = 22 }: { platform: Platform; size?: number }) => (
  <span className={`pf-badge pf-${platform}`} style={{ width: size, height: size }} title={PLATFORM_LABEL[platform]}>
    <PlatformIcon platform={platform} size={Math.round(size * 0.58)} />
  </span>
)

const TONES = 6
/** An account as a lettered circle with its platform's badge, the way Buffer shows channels. */
export function Avatar({ account, size = 36, badge = true }: { account: { id: number; platform: Platform; username: string }; size?: number; badge?: boolean }) {
  return (
    <span className={`avatar tone-${account.id % TONES}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden>
      {initials(account)}
      {badge && <PlatformBadge platform={account.platform} size={Math.max(14, Math.round(size * 0.46))} />}
    </span>
  )
}

/** A kind's dot carries its color; the label stays in ink. */
export const KindTag = ({ kind }: { kind: Kind }) => <span className={`kind kind-${kind}`}><i />{KIND_LABEL[kind]}</span>

const STATUS_ICON = { draft: Pencil, scheduled: Clock3, publishing: LoaderCircle, published: CircleCheck, failed: CircleAlert }
export function StatusPill({ status }: { status: PostStatus }) {
  const Icon = STATUS_ICON[status]
  return <span className={`status status-${status}`}><Icon size={13} className={status === 'publishing' ? 'spin' : undefined} />{STATUS_LABEL[status]}</span>
}

export const Switch = ({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
)

export type SegOption<T> = { value: T; label: React.ReactNode; icon?: React.ReactNode; title?: string; disabled?: boolean }
/** A row of mutually exclusive choices. */
export function Segmented<T extends string | number>({ value, options, onChange, label, small }: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div className={small ? 'seg seg-sm' : 'seg'} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : undefined}
          title={o.title} disabled={o.disabled} onClick={() => o.value !== value && onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A native modal <dialog>: Escape and a click on the backdrop close it, focus stays inside.
 * Its content mounts only while open, so nothing hidden keeps playing or fetching.
 * showModal() focuses the first control; an element marked data-autofocus takes focus instead.
 */
export function Modal({ open, onClose, className, label, children }: { open: boolean; onClose: () => void; className?: string; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className={`modal ${className ?? ''}`} aria-label={label}
      onCancel={e => { e.preventDefault(); onClose() }} onClose={() => open && onClose()}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      {open && children}
    </dialog>
  )
}

/** A button that opens a small list of actions; a click outside or Escape closes it. */
export function Menu({ trigger, label, className, align = 'end', children }: { trigger: React.ReactNode; label: string; className?: string; align?: 'start' | 'end'; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={className} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>{trigger}</button>
      {open && <div className={`menu menu-${align}`} role="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  )
}

export const EmptyState = ({ icon, title, children, action }: { icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) => (
  <div className="empty">
    <div className="empty-icon">{icon}</div>
    <b>{title}</b>
    {children && <p>{children}</p>}
    {action}
  </div>
)

export const Skeleton = ({ rows = 3, height = 56 }: { rows?: number; height?: number }) => (
  <div className="skeleton" aria-busy="true" aria-label="Memuat">
    {Array.from({ length: rows }, (_, i) => <span key={i} style={{ height }} />)}
  </div>
)

/**
 * A post's image, or a play tile for a video (loading every video's frames would be heavy).
 * News CDNs sometimes refuse hotlinks, so a broken image falls back to an icon.
 */
export function Thumb({ image, video, size = 56 }: { image: string | null; video: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [image])
  return (
    <span className={video ? 'thumb thumb-video' : 'thumb'} style={{ width: size, height: size }}>
      {video ? <Play size={Math.round(size * 0.34)} fill="currentColor" aria-label="Video" />
        : image && !broken ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : <ImageOff size={Math.round(size * 0.34)} aria-label="Gambar tidak tersedia" />}
    </span>
  )
}
