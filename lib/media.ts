import { createHash, createHmac } from 'node:crypto'

/**
 * Threads does not take image bytes: it fetches image_url itself. News CDNs
 * often answer Meta's fetcher with 403 (bot protection, hotlink rules), and
 * Threads then fails with code 1 "An unknown error has occurred". So we fetch
 * the image the way a browser would, check it is something Threads accepts,
 * and hand Threads a copy on our own R2 bucket instead.
 */

const MAX_BYTES = 8 * 1024 * 1024 // Threads image limit
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

type R2Config = { accountId: string; accessKeyId: string; secret: string; bucket: string; publicUrl: string }

function r2Config(): R2Config {
  const cfg = {
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secret: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_BUCKET ?? '',
    publicUrl: (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, ''),
  }
  const missing = Object.entries({
    R2_ACCOUNT_ID: cfg.accountId, R2_ACCESS_KEY_ID: cfg.accessKeyId, R2_SECRET_ACCESS_KEY: cfg.secret,
    R2_BUCKET: cfg.bucket, R2_PUBLIC_URL: cfg.publicUrl,
  }).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new Error(`R2 not configured: set ${missing.join(', ')}`)
  return cfg
}

/** Only JPEG and PNG are accepted by Threads. Sniffs bytes: CDNs often label WebP as image/jpeg. */
export function sniffImage(b: Uint8Array): { type: string; ext: string } | { unsupported: string } {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image/png', ext: 'png' }
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { unsupported: 'webp' }
  if (ascii(4, 8) === 'ftyp') return { unsupported: ascii(8, 12).trim() || 'heif/avif' }
  if (ascii(0, 3) === 'GIF') return { unsupported: 'gif' }
  return { unsupported: 'not an image' }
}

async function downloadImage(url: string): Promise<{ body: Uint8Array<ArrayBuffer>; type: string; ext: string }> {
  const src = new URL(url)
  if (src.protocol !== 'https:' && src.protocol !== 'http:') throw new Error(`image download failed: ${src.protocol} URL`)
  const res = await fetch(src, {
    headers: {
      'User-Agent': BROWSER_UA,
      // Ask for formats Threads takes, so CDNs that negotiate do not send WebP/AVIF.
      Accept: 'image/jpeg,image/png;q=0.9,image/*;q=0.5',
      Referer: `${src.origin}/`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok || !res.body) throw new Error(`image download failed: HTTP ${res.status} from ${src.hostname}`)
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(`image too large: over ${MAX_BYTES / 1024 / 1024} MB`)

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new Error(`image too large: over ${MAX_BYTES / 1024 / 1024} MB`)
    }
    chunks.push(value)
  }
  const body = Buffer.concat(chunks)
  const kind = sniffImage(body)
  // cdn.antaranews.com answers a missing file with 200 and an empty body. That is a bad URL or a
  // CDN hiccup, not a format Threads rejects, so it fails as a (retryable) download error.
  if ('unsupported' in kind && kind.unsupported === 'not an image') {
    const got = body.length ? `${body.length} bytes of ${res.headers.get('content-type') ?? 'unknown type'}` : 'an empty body'
    throw new Error(`image download failed: ${src.hostname} sent ${got}, not an image. Does the file exist? ${url}`)
  }
  if ('unsupported' in kind) throw new Error(`unsupported image format (${kind.unsupported}) from ${src.hostname}: Threads takes JPEG or PNG only`)
  return { body, ...kind }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/**
 * AWS Signature V4 Authorization header. R2 speaks the S3 API with region "auto".
 * headers must include host, x-amz-date and x-amz-content-sha256; path must be URI-encoded.
 */
export function signV4(o: {
  method: string; path: string; headers: Record<string, string>; payloadHash: string
  accessKeyId: string; secret: string; region: string; service?: string
}): string {
  const service = o.service ?? 's3'
  const amzDate = o.headers['x-amz-date']
  const scope = `${amzDate.slice(0, 8)}/${o.region}/${service}/aws4_request`
  const names = Object.keys(o.headers).map(k => k.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]))
  const signed = names.join(';')
  const canonical = [o.method, o.path, '', ...names.map(k => `${k}:${lower[k]}`), '', signed, o.payloadHash].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')

  let key: Buffer = hmac(`AWS4${o.secret}`, amzDate.slice(0, 8))
  for (const part of [o.region, service, 'aws4_request']) key = hmac(key, part)
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
}

async function putObject(cfg: R2Config, key: string, body: Uint8Array<ArrayBuffer>, type: string) {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`
  const path = `/${encodeURIComponent(cfg.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
  const payloadHash = sha256(body)
  const headers: Record<string, string> = {
    host,
    'content-type': type,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
  }
  const authorization = signV4({ method: 'PUT', path, headers, payloadHash, accessKeyId: cfg.accessKeyId, secret: cfg.secret, region: 'auto' })
  // fetch sets Host from the URL itself; it is only listed above for signing.
  const { host: _, ...sent } = headers
  const res = await fetch(`https://${host}${path}`, {
    method: 'PUT',
    headers: { ...sent, authorization },
    body,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).match(/<Code>([^<]+)<\/Code>/)?.[1] ?? ''
    throw new Error(`R2 upload failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
  }
}

/**
 * Copies an image to R2 and returns its public URL for Threads to fetch.
 * Keys are content hashes, so a retry of the same post reuses the same object.
 */
export async function rehostImage(url: string): Promise<string> {
  const cfg = r2Config()
  const { body, type, ext } = await downloadImage(url)
  const key = `threads/${sha256(body)}.${ext}`
  await putObject(cfg, key, body, type)
  return `${cfg.publicUrl}/${key}`
}
