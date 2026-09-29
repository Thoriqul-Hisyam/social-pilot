/** Self-check for splitForThreads. No network, no publishing. */
import { splitForThreads, threadsPreview } from '../lib/threads'

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

console.log(`OK — ${n} assertions passed; long sample split into ${parts.length} parts, sizes ${parts.map(p => p.length).join(', ')}`)
