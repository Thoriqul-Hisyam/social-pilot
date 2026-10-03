/**
 * What a failed platform call means for the queue, whatever the platform:
 * invalid_token pauses the account, transient is retried on the spot,
 * gone means the post was deleted there, permission waits for a reconnect,
 * rate_limit puts the post back for later.
 */
export type ErrorReason = 'invalid_token' | 'transient' | 'gone' | 'permission' | 'rate_limit'

/** An error answer from a platform's API. code and subcode are the platform's, when it sent them. */
export class PlatformApiError extends Error {
  readonly code?: number
  readonly subcode?: number
  readonly reason?: ErrorReason
  constructor(message: string, code?: number, subcode?: number, reason?: ErrorReason) {
    super(message)
    this.code = code
    this.subcode = subcode
    this.reason = reason
  }
}

/** Meta's Graph API codes, shared by Threads, Instagram and Facebook. */
export function metaReason(code: number | undefined, subcode: number | undefined, message: string): ErrorReason | undefined {
  if (code === 190) return 'invalid_token'
  if (code === 1 || code === 2 || code === -1 || code === -2) return 'transient'
  if (code === 10 || (code != null && code >= 200 && code <= 299)) return 'permission'
  if (code === 100 && (subcode === 33 || /does not exist/i.test(message))) return 'gone'
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001 || code === 80002 || (code === 9 && subcode === 2207042))
    return 'rate_limit'
  return undefined
}

/** An error answer from Threads, Instagram or Facebook, classified by its code. */
export class MetaApiError extends PlatformApiError {
  constructor(message: string, code?: number, subcode?: number) {
    super(message, code, subcode, metaReason(code, subcode, message))
  }
}

/** No answer at all: DNS, a dropped connection, a timeout. Says nothing about the post. */
export class NetworkError extends Error {}

/** Node's "fetch failed" keeps the actual reason (ECONNRESET, ENOTFOUND, ...) in cause. */
export function networkError(label: string, e: unknown): NetworkError {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause
  return new NetworkError(`${label}: fetch failed (${cause?.code ?? cause?.message ?? String(e)})`)
}

const reasonOf = (e: unknown) => e instanceof PlatformApiError ? e.reason : undefined

/** Meta code 190: the token is expired, revoked or malformed. Every call fails until a reconnect. */
export const isInvalidToken = (e: unknown) => reasonOf(e) === 'invalid_token'

/** Platform-side blips that often pass on a retry, as do dropped connections. */
export const isTransient = (e: unknown) => e instanceof NetworkError || reasonOf(e) === 'transient'

/** The app or token lacks a permission, for example the insights scope. */
export const isMissingPermission = (e: unknown) => reasonOf(e) === 'permission'

/** The post no longer exists on the platform: it was deleted there. */
export const isGone = (e: unknown) => reasonOf(e) === 'gone'

/** Too many calls or posts for now; the same call passes later. */
export const isRateLimited = (e: unknown) => reasonOf(e) === 'rate_limit'

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
