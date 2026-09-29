const API = 'https://graph.threads.net/v1.0'
const LIMIT = 500

export type PublishInput = { text: string; imageUrl?: string; videoUrl?: string; userId: string; token: string }

/**
 * A reply chain that stopped mid-way. Its published parts were deleted again;
 * liveIds are the ones that could not be, root first (empty = nothing left on Threads).
 */
export class ChainBrokenError extends Error {
  readonly liveIds: string[]
  constructor(liveIds: string[], part: number, total: number, cause: unknown) {
    const left = liveIds.length ? `still live, delete by hand: ${liveIds.join(',')}` : 'published parts deleted'
    super(`chain broke at part ${part}/${total}; ${left}; cause: ${cause}`)
    this.liveIds = liveIds
  }
}

/** An error answer from the Graph API. code is Meta's error code, when it sent one. */
export class ThreadsApiError extends Error {
  readonly code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Step name for errors, without the user id: "/123/threads_publish" -> "threads_publish". */
const step = (path: string) => path.split('/').filter(Boolean).pop() ?? path

async function call(path: string, params: Record<string, string>, method: 'GET' | 'POST' | 'DELETE' = 'POST') {
  const res = method === 'POST'
    ? await fetch(`${API}${path}`, { method, body: new URLSearchParams(params) })
    : await fetch(`${API}${path}?${new URLSearchParams(params)}`, { method })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = data?.error ?? {}
    const code = [err.code, err.error_subcode].filter(v => v != null).join('/')
    const msg = err.error_user_msg ?? err.message ?? `HTTP ${res.status}`
    // Meta support asks for fbtrace_id; code 1 carries no other detail.
    const trace = err.fbtrace_id ? ` (fbtrace_id ${err.fbtrace_id})` : ''
    throw new ThreadsApiError(`Threads API [${step(path)}${code ? ` ${code}` : ''}]: ${msg}${trace}`, err.code)
  }
  return data
}

/** Codes 1 (unknown) and 2 (service) are Meta-side blips that often pass on a retry. */
const isTransient = (e: unknown) => e instanceof ThreadsApiError && (e.code === 1 || e.code === 2)

async function createContainer(userId: string, token: string, params: Record<string, string>): Promise<string> {
  for (const wait of [5000, 15000]) {
    try {
      return (await call(`/${userId}/threads`, { ...params, access_token: token })).id
    } catch (e) {
      if (!isTransient(e)) throw e
      await sleep(wait)
    }
  }
  return (await call(`/${userId}/threads`, { ...params, access_token: token })).id
}

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

/**
 * Waits until a container is ready. Publishing one still IN_PROGRESS fails
 * with "The requested resource does not exist", even for plain text.
 */
async function waitForContainer(id: string, token: string, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { status, error_message } = await call(`/${id}`, { fields: 'status,error_message', access_token: token }, 'GET')
    if (status === 'FINISHED' || status === 'PUBLISHED') return
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Threads container ${status}: ${error_message ?? 'no detail'}`)
    if (Date.now() > deadline) throw new Error(`Threads container not ready after ${timeoutMs / 1000}s (status ${status})`)
    await sleep(2000)
  }
}

async function createAndPublish(userId: string, token: string, params: Record<string, string>): Promise<string> {
  const containerId = await createContainer(userId, token, params)
  // Video transcoding takes far longer than an image fetch.
  await waitForContainer(containerId, token, params.media_type === 'VIDEO' ? 300000 : 60000)
  const publish = () => call(`/${userId}/threads_publish`, { creation_id: containerId, access_token: token })
  try {
    return (await publish()).id
  } catch {
    // Retry the same container: a fresh one would just hit the same race.
    await sleep(10000)
    return (await publish()).id
  }
}

/** Deletes published parts, last reply first. Needs threads_delete. Returns the ids still live. */
export async function deleteThreadsPosts(ids: string[], token: string): Promise<string[]> {
  const live: string[] = []
  for (const id of [...ids].reverse()) {
    try { await call(`/${id}`, { access_token: token }, 'DELETE') }
    catch (e) { console.error(`Threads rollback: ${id}: ${e}`); live.unshift(id) }
  }
  return live
}

/**
 * Publish text to Threads. Text over 500 chars continues as a self-reply
 * chain: root -> reply -> reply. Returns every post id, root first.
 *
 * Replies require the threads_manage_replies scope. If the chain breaks
 * mid-way, the parts already published are deleted so no half thread stays up;
 * a ChainBrokenError names any that could not be deleted.
 */
export async function publishToThreads({ text, imageUrl, videoUrl, userId, token }: PublishInput): Promise<string[]> {
  if (!userId || !token) throw new Error('missing Threads credentials')
  if (!text.trim()) throw new Error('empty post')
  // Every post must carry media; never let one go out as text only.
  if (!imageUrl && !videoUrl) throw new Error('image or video required')
  if (imageUrl && videoUrl) throw new Error('pass either imageUrl or videoUrl, not both')

  const media: Record<string, string> = videoUrl
    ? { media_type: 'VIDEO', video_url: videoUrl }
    : { media_type: 'IMAGE', image_url: imageUrl! }

  const parts = splitForThreads(text)
  const ids: string[] = []

  for (let i = 0; i < parts.length; i++) {
    const params = {
      ...(i === 0 ? media : { media_type: 'TEXT' }),
      text: parts[i],
      ...(i > 0 ? { reply_to_id: ids[i - 1] } : {}),
    }
    try {
      ids.push(await createAndPublish(userId, token, params))
    } catch (e) {
      if (i === 0) throw e
      // The parent post is often not queryable yet; wait longer and retry once.
      await sleep(15000)
      try {
        ids.push(await createAndPublish(userId, token, params))
      } catch (e2) {
        throw new ChainBrokenError(await deleteThreadsPosts(ids, token), i + 1, parts.length, e2)
      }
    }
    // Rapid self-replies look like spam and can get the parent hidden; pace them out.
    if (i < parts.length - 1) await sleep(10000)
  }
  return ids
}

/** Reads the profile behind a token — used to name an account after OAuth. */
export async function fetchProfile(token: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${API}/me?fields=id,username&access_token=${encodeURIComponent(token)}`)
  const data = await res.json()

  if (!res.ok) {
    console.error('Threads profile response:', JSON.stringify({
      status: res.status,
      data,
    }))
    throw new Error(`Threads profile: ${data?.error?.message ?? res.status}`)
  }

  return { id: data.id, username: data.username ?? '' }
}

