'use client'
import { useState } from 'react'
import { CircleAlert, Table2 } from 'lucide-react'
import { compact, KIND_LABEL, num, type DayActivity, type Kind, type RankedPost } from './format'

const dayFmt = new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'short' })
const longFmt = new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
const at = (day: string) => new Date(`${day}T00:00:00Z`)

/** A step of 1, 2 or 5 times a power of ten, so about four gridlines land on round numbers. */
function niceStep(max: number) {
  const raw = Math.max(max, 1) / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map(m => m * pow).find(s => s >= raw)!
}

/**
 * Posts published per day, Berita and Affiliate stacked, one column per day.
 * Columns cap at 24px with a 2px surface gap between segments and a rounded top only;
 * hover or focus shows the day's numbers, failures included, and the table view holds them all.
 */
export function ActivityChart({ days, height = 190 }: { days: DayActivity[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const totals = days.map(d => d.news + d.affiliate)
  const step = niceStep(Math.max(...totals, 0))
  const top = Math.max(step, Math.ceil(Math.max(...totals, 0) / step) * step)
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  const every = Math.ceil(days.length / 8)
  const sum = (k: Kind) => days.reduce((n, d) => n + d[k], 0)
  const failed = days.reduce((n, d) => n + d.failed, 0)
  const h = hover === null ? null : days[hover]
  // Near either edge the tooltip hangs inward from its column, so it never leaves the card.
  const edge = hover === null ? '' : hover < days.length * 0.2 ? 'left' : hover >= days.length * 0.8 ? 'right' : ''
  const tipX = hover === null ? 0 : ((hover + (edge === 'left' ? 0 : edge === 'right' ? 1 : 0.5)) / days.length) * 100

  return (
    <div className="chart">
      <div className="chart-top">
        <div className="legend">
          {(['news', 'affiliate'] as Kind[]).map(k => <span key={k}><i className={`swatch swatch-${k}`} />{KIND_LABEL[k]} <b>{num(sum(k))}</b></span>)}
          {failed > 0 && <span className="legend-bad"><CircleAlert size={13} />Gagal <b>{num(failed)}</b></span>}
        </div>
        <button type="button" className={table ? 'chip-btn on' : 'chip-btn'} aria-pressed={table} onClick={() => setTable(t => !t)}><Table2 size={14} />Tabel</button>
      </div>

      {table ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Tanggal</th><th>Berita</th><th>Affiliate</th><th>Total</th><th>Gagal</th></tr></thead>
            <tbody>{[...days].reverse().map(d => (
              <tr key={d.day}><td>{longFmt.format(at(d.day))}</td><td>{num(d.news)}</td><td>{num(d.affiliate)}</td><td>{num(d.news + d.affiliate)}</td><td>{num(d.failed)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="plot" style={{ height }} onMouseLeave={() => setHover(null)}>
          <div className="y-axis">{ticks.map(t => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{compact(t)}</span>)}</div>
          <div className="plot-area">
            {ticks.map(t => <i key={t} className={t === 0 ? 'grid base' : 'grid'} style={{ bottom: `${(t / top) * 100}%` }} />)}
            <div className="cols">
              {days.map((d, i) => {
                const total = d.news + d.affiliate
                return (
                  <button key={d.day} type="button" className={hover === i ? 'col on' : 'col'} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    aria-label={`${longFmt.format(at(d.day))}: ${d.news} berita, ${d.affiliate} affiliate, ${d.failed} gagal`}>
                    <span className="stack" style={{ height: `${(total / top) * 100}%` }}>
                      {d.news > 0 && <span className="seg-news" style={{ flexGrow: d.news }} />}
                      {d.affiliate > 0 && <span className="seg-affiliate" style={{ flexGrow: d.affiliate }} />}
                    </span>
                    <span className="x-label">{i % every === (days.length - 1) % every ? dayFmt.format(at(d.day)) : ''}</span>
                  </button>
                )
              })}
            </div>
            {h && (
              <div className={edge ? `tip tip-${edge}` : 'tip'} style={{ left: `${tipX}%` }} role="tooltip">
                <div className="tip-title">{longFmt.format(at(h.day))}</div>
                <div className="tip-row"><i className="key key-news" /><b>{num(h.news)}</b> Berita</div>
                <div className="tip-row"><i className="key key-affiliate" /><b>{num(h.affiliate)}</b> Affiliate</div>
                {h.failed > 0 && <div className="tip-row tip-bad"><CircleAlert size={12} /><b>{num(h.failed)}</b> Gagal</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Posts ranked by views: one bar per post in its kind's color, longest = most views,
 * with the value at the bar's tip. scale sets the full-length value, so two lists can share one scale. The caption is cut to one line; its full text is the row's title.
 */
export function RankList({ items, kind, empty, scale }: { items: RankedPost[]; kind: Kind; empty: string; scale?: number }) {
  if (!items.length) return <p className="muted small rank-empty">{empty}</p>
  const max = Math.max(scale ?? 0, ...items.map(p => p.views), 1)
  return (
    <ol className="rank">
      {items.map((p, i) => (
        <li key={p.id} title={p.caption}>
          <span className="rank-n">{i + 1}</span>
          <div className="rank-main">
            <span className="rank-cap">{p.caption}</span>
            <span className="rank-bar"><i className={`bar-${kind}`} style={{ width: `${Math.max(2, (p.views / max) * 100)}%` }} /></span>
          </div>
          <span className="rank-val"><b>{compact(p.views)}</b><small>{num(p.likes)} likes</small></span>
        </li>
      ))}
    </ol>
  )
}

/** A ratio against its whole: the unfilled track is a lighter step of the fill's own hue. */
export const Meter = ({ value, max, label }: { value: number; max: number; label: string }) => (
  <span className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
    <i style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
  </span>
)

/** One headline number: label, value, and a line of context under it. */
export const Stat = ({ label, value, sub, icon, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon: React.ReactNode; tone?: 'bad' | 'warn' | 'good' }) => (
  <div className={tone ? `stat stat-${tone}` : 'stat'}>
    <div className="stat-head"><span className="stat-icon">{icon}</span>{label}</div>
    <div className="stat-value">{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
)
