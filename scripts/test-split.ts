/** Self-check for splitForThreads and error classification. No network, no publishing. */
import {
  fetchPostInsights, isDeletedOnThreads, isMissingPermission, NetworkError, publishToThreads,
  splitForThreads, threadsPreview, ThreadsApiError,
} from '../lib/threads'

const L = 500
let n = 0
const check = (name: string, cond: boolean) => {
  if (!cond) { console.error(`FAIL: ${name}`); process.exit(1) }
  n++
}
const allFit = (p: string[]) => p.every(x => x.length <= L && x.length > 0)

// short text stays one post
const short = 'Halo dunia.\n\nIni pendek.'
check('short -> 1 part', splitForThreads(short).length === 1)
check('short preserved', splitForThreads(short)[0] === short)

// long text splits, every part within limit, nothing lost
const para = 'Kalimat panjang tentang keamanan AI agent di desktop. '.repeat(12)
const long = [para, para, para].join('\n\n')
const parts = splitForThreads(long)
check('long -> multiple parts', parts.length > 1)
check('all parts within limit', allFit(parts))
const words = (s: string) => s.split(/\s+/).filter(Boolean)
check('no words lost', words(parts.join(' ')).length === words(long).length)
check('no mid-word split', parts.every(p => !p.startsWith(' ') && !p.endsWith(' ')))

// a single sentence longer than the limit still splits on word boundaries
const oneSentence = 'kata '.repeat(300).trim()
const s2 = splitForThreads(oneSentence)
check('long sentence splits', s2.length > 1)
check('long sentence parts fit', allFit(s2))
check('long sentence keeps words', words(s2.join(' ')).length === words(oneSentence).length)

// pathological single token gets hard-cut rather than exceeding the limit
const giant = 'x'.repeat(1234)
const s3 = splitForThreads(giant)
check('giant token parts fit', allFit(s3))
check('giant token chars kept', s3.join('').length === giant.length)

// boundary: exactly at the limit stays one part
const exact = 'a'.repeat(L)
check('exact limit -> 1 part', splitForThreads(exact).length === 1)
check('limit+1 -> 2 parts', splitForThreads('a'.repeat(L + 1)).length === 2)

// composer preview agrees with the real split and flags a cut tail
check('preview short', threadsPreview(short).parts === 1 && !threadsPreview(short).truncated)
check('preview long matches split', threadsPreview(long).parts === parts.length && !threadsPreview(long).truncated)
const huge = 'Kalimat yang cukup panjang untuk mengisi bagian demi bagian. '.repeat(90)
check('preview flags truncation', threadsPreview(huge).truncated)
check('preview never exceeds 7 parts', threadsPreview(huge).parts <= 7 && threadsPreview(huge).parts === splitForThreads(huge).length)
check('preview empty', threadsPreview('').parts === 1 && !threadsPreview('').truncated)

// insight errors: only "does not exist" marks a post deleted on Threads
const apiErr = (msg: string, code?: number, sub?: number) => new ThreadsApiError(`Threads API [insights]: ${msg}`, code, sub)
check('100/33 is a deleted post', isDeletedOnThreads(apiErr('Unsupported get request.', 100, 33)))
check('100 without subcode reads the message', isDeletedOnThreads(apiErr("Object with ID '1' does not exist", 100)))
check('other code 100 errors are not deletions', !isDeletedOnThreads(apiErr('Invalid parameter', 100)))
check('a missing permission is not a deletion', !isDeletedOnThreads(apiErr('does not exist', 10)) && isMissingPermission(apiErr('x', 10)))
check('a plain error is not a deletion', !isDeletedOnThreads(new Error('does not exist')))

// dropped connections: named with their cause, and ridden out where a retry is safe.
// fetch is stubbed and sleeps are instant, so nothing leaves the machine or waits.
const realFetch = globalThis.fetch, realTimeout = globalThis.setTimeout
const drop = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }))
const answer = (body: object) => () => Promise.resolve(new Response(JSON.stringify(body)))
globalThis.setTimeout = ((fn: () => void) => { fn(); return 0 }) as unknown as typeof setTimeout
globalThis.fetch = drop as unknown as typeof fetch
const offline = await fetchPostInsights('1', 't').catch((e: unknown) => e)
check('a dropped connection is a NetworkError naming its cause',
  offline instanceof NetworkError && offline.message === 'Threads API [insights]: fetch failed (ECONNRESET)')
// create fails, create, poll fails, poll FINISHED, publish
const script = [drop, answer({ id: 'c1' }), drop, answer({ status: 'FINISHED' }), answer({ id: 'p1' })]
globalThis.fetch = (() => script.shift()!()) as unknown as typeof fetch
const published = await publishToThreads({ text: 'halo', imageUrl: 'https://x/a.jpg', userId: 'u', token: 't' }).catch((e: unknown) => e)
check('publishing rides out dropped connections', Array.isArray(published) && published.join() === 'p1' && script.length === 0)
globalThis.fetch = realFetch
globalThis.setTimeout = realTimeout

console.log(`OK — ${n} assertions passed; long sample split into ${parts.length} parts, sizes ${parts.map(p => p.length).join(', ')}`)
