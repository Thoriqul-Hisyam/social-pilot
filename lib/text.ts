import type { Platform } from './db'

/**
 * How post text fits each platform. Pure, so the composer runs it in the browser too.
 */

/** Threads caps a post at 500 characters; longer text continues as a self-reply chain. */
export const THREADS_LIMIT = 500
const LIMIT = THREADS_LIMIT

/**
 * Split text into <=LIMIT chunks, preferring paragraph then sentence breaks.
 * Never splits mid-word. A single over-long word is hard-cut as a last resort.
 */
function pack(text: string, limit: number): string[] {
  const out: string[] = []
  let buf = ''

  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = '' }
  const fits = (a: string, b: string, sep: string) => (a ? a.length + sep.length : 0) + b.length <= limit
  const add = (piece: string, sep: string) => {
    if (fits(buf, piece, sep)) buf += (buf ? sep : '') + piece
    else { flush(); buf = piece }
  }

  for (const para of text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
    if (para.length <= limit) { add(para, '\n\n'); continue }

    for (const sentence of para.match(/[^.!?]+[.!?]*\s*/g) ?? [para]) {
      const s = sentence.trim()
      if (!s) continue
      if (s.length <= limit) { add(s, ' '); continue }

      flush()
      let line = ''
      for (const word of s.split(/\s+/)) {
        if (word.length > limit) {
          if (line) { out.push(line); line = '' }
          for (let i = 0; i < word.length; i += limit) out.push(word.slice(i, i + limit))
          continue
        }
        if (fits(line, word, ' ')) line += (line ? ' ' : '') + word
        else { out.push(line); line = word }
      }
      buf = line
    }
  }
  flush()
  return out
}

/**
 * Keep reply chains readable: Threads hard-caps 500 chars, so long source copy
 * is cut to at most maxParts. Preserves the opening context and the source URL
 * at the end; short posts remain untouched.
 */
export function splitForThreads(text: string, limit = LIMIT, maxParts = 7): string[] {
  const out = pack(text, limit)
  if (out.length <= maxParts) return out.length ? out : ['']

  // Paragraphs rarely fill a part exactly, so a cut that fits by length can
  // still pack into too many parts. Shrink the cut until it fits.
  const source = text.match(/(?:Sumber|Source):\s*https?:\/\/\S+/i)?.[0]
  for (let cap = (limit - 20) * maxParts; cap > limit; cap -= 100) {
    const compact = text.trim().slice(0, cap)
    const body = source && !compact.includes(source)
      ? `${compact.slice(0, cap - source.length - 2).trim()}\n\n${source}`
      : compact
    const parts = pack(body, limit)
    if (parts.length <= maxParts) return parts
  }
  return out.slice(0, maxParts)
}

/**
 * What the composer shows before sending: how many posts the text becomes,
 * and whether splitForThreads will cut its tail to stay within maxParts.
 * Pure, so it runs in the browser too.
 */
export function threadsPreview(text: string, limit = LIMIT, maxParts = 7): { parts: number; truncated: boolean } {
  return { parts: splitForThreads(text, limit, maxParts).length, truncated: pack(text, limit).length > maxParts }
}


/** The "Sumber: <url>" line news posts end with; a cut keeps it. */
const SOURCE = /(?:Sumber|Source):\s*https?:\/\/\S+/i

/**
 * Text cut to one post of at most `limit` characters: whole words, then "…",
 * then the "Sumber:" line if the text had one. Text that fits is returned
 * trimmed and otherwise unchanged.
 */
export function shorten(text: string, limit: number): string {
  const t = text.trim()
  if (t.length <= limit) return t
  const found = t.match(SOURCE)?.[0]
  // A source that leaves no room for the text is dropped rather than posted alone.
  const source = found && limit - `…\n\n${found}`.length >= 40 ? found : undefined
  const tail = source ? `…\n\n${source}` : '…'
  const body = source ? t.replace(source, '').trim() : t
  const room = limit - tail.length
  let out = ''
  for (const piece of body.split(/(\s+)/)) {
    if ((out + piece).length > room) break
    out += piece
  }
  out = out.trimEnd()
  // One giant first word: cut it by characters instead.
  return (out || body.slice(0, room)) + tail
}

export const INSTAGRAM_LIMIT = 2200
export const FACEBOOK_LIMIT = 63206

/** The posts a text becomes on a platform: a reply chain on Threads, one post elsewhere. */
export function partsFor(platform: Platform, text: string): string[] {
  switch (platform) {
    case 'threads': return splitForThreads(text)
    case 'instagram': return [shorten(text, INSTAGRAM_LIMIT)]
    case 'facebook': return [shorten(text, FACEBOOK_LIMIT)]
    default: return [text.trim()]
  }
}

/** For the composer: how many posts the text becomes there, and whether its tail is cut. */
export function previewFor(platform: Platform, text: string): { parts: number; truncated: boolean } {
  switch (platform) {
    case 'threads': return threadsPreview(text)
    case 'instagram': return { parts: 1, truncated: text.trim().length > INSTAGRAM_LIMIT }
    case 'facebook': return { parts: 1, truncated: text.trim().length > FACEBOOK_LIMIT }
    default: return { parts: 1, truncated: false }
  }
}
