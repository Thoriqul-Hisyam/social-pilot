/** Self-check for db + crypto. Uses a temp DB; touches no network. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'sp-test-'))
process.env.DATABASE_PATH = join(dir, 'test.db')
process.env.ENCRYPTION_KEY = 'test-key-that-is-long-enough-for-scrypt-derivation'
process.env.SESSION_SECRET = 'another-test-secret-long-enough-for-hmac-sha256!!'

const { encrypt, decrypt, safeEqual } = await import('../lib/crypto')
const db = await import('../lib/db')

let n = 0
const check = (name: string, cond: boolean) => {
  if (!cond) { console.error(`FAIL: ${name}`); rmSync(dir, { recursive: true, force: true }); process.exit(1) }
  n++
}

// --- crypto ---
const secret = 'THAAAcGVuLXNlY3JldA'
const ct = encrypt(secret)
check('ciphertext differs from plaintext', ct !== secret && !ct.includes(secret))
check('roundtrip works', decrypt(ct) === secret)
check('nonce is random', encrypt(secret) !== encrypt(secret))
check('tamper is rejected', (() => {
  try { decrypt(ct.slice(0, -4) + 'AAAA'); return false } catch { return true }
})())
check('safeEqual true', safeEqual('abc', 'abc'))
check('safeEqual false', !safeEqual('abc', 'abd') && !safeEqual('abc', 'abcd'))

// --- accounts ---
const acc = db.upsertAccount({ platform: 'threads', external_id: '999', username: 'tester', access_token: secret })
check('account created', acc > 0)
check('token decrypts back', db.getAccountToken(acc)?.token === secret)

const raw = db.getDb().prepare('SELECT access_token FROM accounts WHERE id = ?').get(acc) as { access_token: string }
check('token stored encrypted at rest', !raw.access_token.includes(secret))

check('listAccounts never leaks token', !JSON.stringify(db.listAccounts()).includes(secret))

db.upsertAccount({ platform: 'threads', external_id: '999', username: 'renamed', access_token: secret })
check('upsert does not duplicate', db.listAccounts().length === 1)
check('upsert updates username', db.listAccounts()[0].username === 'renamed')

// --- posts + dedup ---
const past = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19)
const future = new Date(Date.now() + 3_600_000).toISOString().replace('T', ' ').slice(0, 19)

const p1 = db.queuePost({ account_id: acc, caption: 'first', source_url: 'https://a/1', scheduled_at: past })
check('post queued', p1 !== null)
check('duplicate source_url skipped', db.queuePost({ account_id: acc, caption: 'dup', source_url: 'https://a/1', scheduled_at: past }) === null)
check('null source_url allowed twice',
  db.queuePost({ account_id: acc, caption: 'x', scheduled_at: future }) !== null &&
  db.queuePost({ account_id: acc, caption: 'y', scheduled_at: future }) !== null)

// --- claim ---
const claimed = db.claimDuePost()
check('due post claimed', claimed?.id === p1)
check('claim marks publishing', claimed?.status === 'publishing')
check('claim is atomic — second call gets nothing', db.claimDuePost() === null)

// --- publish / retry ---
db.markPublished(claimed!.id, ['111', '222'])
const done = db.listPosts().find(p => p.id === p1)!
check('marked published', done.status === 'published')
check('external ids stored', done.external_ids === '["111","222"]')

const p2 = db.queuePost({ account_id: acc, caption: 'retry me', scheduled_at: past })!
db.claimDuePost()
db.markFailed(p2, 'boom', 3)
check('failure retries first', db.listPosts().find(p => p.id === p2)!.status === 'scheduled')
for (let i = 0; i < 3; i++) { db.claimDuePost(); db.markFailed(p2, 'boom', 3) }
check('failure gives up after maxAttempts', db.listPosts().find(p => p.id === p2)!.status === 'failed')

// --- disabled accounts are never published for ---
db.setAccountEnabled(acc, false)
check('disabled account hides token', db.getAccountToken(acc) === null)
db.queuePost({ account_id: acc, caption: 'should not run', scheduled_at: past })
check('disabled account posts not claimed', db.claimDuePost() === null)

const s = db.stats()
check('stats count accounts', s.accounts === 0)
check('stats count published', s.published === 1)

rmSync(dir, { recursive: true, force: true })
console.log(`OK — ${n} assertions passed (crypto, accounts, dedup, atomic claim, retry, disabled-account guard)`)
