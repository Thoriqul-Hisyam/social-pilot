import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto'

const ALGO = 'aes-256-gcm'

let cachedKey: Buffer | null = null

/** 32-byte key derived from ENCRYPTION_KEY. Fails closed if unset in production. */
function key(): Buffer {
  if (cachedKey) return cachedKey
  const secret = process.env.ENCRYPTION_KEY
  if (!secret || secret.length < 32)
    throw new Error('ENCRYPTION_KEY must be set to a random string of at least 32 chars')
  cachedKey = scryptSync(secret, 'socialpilot.v1', 32)
  return cachedKey
}

/** Returns "iv.tag.ciphertext", all base64url. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.')
}

export function decrypt(payload: string): string {
  const [iv, tag, body] = payload.split('.').map(p => Buffer.from(p, 'base64url'))
  if (!iv || !tag || !body) throw new Error('malformed ciphertext')
  const decipher = createDecipheriv(ALGO, key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** Constant-time compare — use for API keys and session tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
