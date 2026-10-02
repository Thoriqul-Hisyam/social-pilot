/** Self-check for db + crypto. Uses a temp DB; touches no network. */
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'sp-test-'))
process.env.DATABASE_PATH = join(dir, 'test.db')
process.env.ENCRYPTION_KEY = 'test-key-that-is-long-enough-for-scrypt-derivation'
process.env.SESSION_SECRET = 'another-test-secret-long-enough-for-hmac-sha256!!'

// Start from an install that predates the later columns, so opening it runs every migration.
const old = new DatabaseSync(process.env.DATABASE_PATH)
old.exec(`
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, external_id TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '', access_token TEXT NOT NULL, token_expires_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (platform, external_id)
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    caption TEXT NOT NULL, image_url TEXT, source_url TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled', scheduled_at TEXT NOT NULL, published_at TEXT,
    external_ids TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_posts_dedup ON posts (account_id, source_url) WHERE source_url IS NOT NULL;
  INSERT INTO accounts (platform, external_id, username, access_token) VALUES ('threads', '999', 'tester', 'x');
  INSERT INTO posts (account_id, caption, source_url, status, scheduled_at) VALUES
    (1, 'old news', 'https://old/news', 'draft', '2026-01-01 00:00:00'),
    (1, 'old affiliate', NULL, 'draft', '2026-01-01 00:00:00');
`)
old.close()

const { encrypt, decrypt, safeEqual } = await import('../lib/crypto')
const db = await import('../lib/db')

// Close first: Windows refuses to delete an open SQLite file (EBUSY).
const cleanup = () => { db.getDb().close(); rmSync(dir, { recursive: true, force: true }) }

let n = 0
const check = (name: string, cond: boolean) => {
  if (!cond) { console.error(`FAIL: ${name}`); cleanup(); process.exit(1) }
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

// --- kind migration ---
const kindOf = (caption: string) =>
  (db.getDb().prepare('SELECT kind FROM posts WHERE caption = ?').get(caption) as { kind: string }).kind
check('old row with source becomes news', kindOf('old news') === 'news')
check('old row without source becomes affiliate', kindOf('old affiliate') === 'affiliate')
check('old dedup index replaced by the news-only one',
  !db.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_posts_dedup'").get() &&
  !!db.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_posts_dedup_news'").get())

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
check('kind defaults to news with a source', db.listPosts().find(p => p.id === p1)?.kind === 'news')
check('kind defaults to affiliate without one', kindOf('x') === 'affiliate')
const manual = db.queuePost({ account_id: acc, caption: 'manual news', kind: 'news', scheduled_at: future })!
check('explicit kind wins over the default', db.listPosts().find(p => p.id === manual)?.kind === 'news')
check('affiliate may repeat a source_url',
  db.queuePost({ account_id: acc, caption: 'aff 1', source_url: 'https://shop/1', kind: 'affiliate', scheduled_at: future }) !== null &&
  db.queuePost({ account_id: acc, caption: 'aff 2', source_url: 'https://shop/1', kind: 'affiliate', scheduled_at: future }) !== null)

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

// Rows failed before setup and empty-image errors became retryable still carry retryable = 0.
const p3 = db.queuePost({ account_id: acc, caption: 'old error', scheduled_at: past })!
for (const old of ['Error: R2 not configured: set R2_BUCKET', 'Error: unsupported image format (not an image) from cdn.antaranews.com: Threads takes JPEG or PNG only']) {
  db.claimDuePost()
  db.markFailed(p3, old, 1, false)
  check(`old error can be retried by hand: ${old}`, db.retryPost(p3).ok && db.listPosts().find(p => p.id === p3)!.status === 'scheduled')
}
db.claimDuePost()
db.markFailed(p3, 'Error: unsupported image format (webp)', 1, false)
check('content error stays permanent', !db.retryPost(p3).ok)

// --- disabled accounts are never published for ---
db.setAccountEnabled(acc, false)
check('disabled account hides token', db.getAccountToken(acc) === null)
db.queuePost({ account_id: acc, caption: 'should not run', scheduled_at: past })
check('disabled account posts not claimed', db.claimDuePost() === null)

// --- queue tail: a new batch lines up after pending slots, not on top of them ---
const now = Date.now()
const gap = 30 * 60_000
check('toSqlTime matches scheduled_at format', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(db.toSqlTime(now)))
// 'x' and 'y' wait at +60 min: more than one gap away, so not part of the train yet
check('tail stays at now across a long gap', db.queueTail(gap, now) === now)
db.queuePost({ account_id: acc, caption: 'train 1', scheduled_at: db.toSqlTime(now + 20 * 60_000) })
db.queuePost({ account_id: acc, caption: 'train 2', scheduled_at: db.toSqlTime(now + 45 * 60_000) })
const futureMs = Date.parse(`${future.replace(' ', 'T')}Z`)
check('tail follows the train to its last slot', db.queueTail(gap, now) === futureMs)
db.queuePost({ account_id: acc, caption: 'parked', scheduled_at: db.toSqlTime(now + 3 * 86_400_000) })
check('a post parked days ahead does not move the tail', db.queueTail(gap, now) === futureMs)
const vid = db.queuePost({ account_id: acc, caption: 'video', video_url: 'https://v/1.mp4', scheduled_at: future })!
check('video post stored', db.listPosts().find(p => p.id === vid)?.video_url === 'https://v/1.mp4')

// --- dashboard pages ---
const queueAll = db.pagePosts('queue', { limit: 100 })
check('page total counts the whole view', queueAll.total === queueAll.posts.length && queueAll.total > 4)
const page1 = db.pagePosts('queue', { limit: 2 }), page2 = db.pagePosts('queue', { limit: 2, offset: 2 })
check('page total ignores the page size', page1.total === queueAll.total)
check('pages follow on without overlap',
  page1.posts.concat(page2.posts).map(p => p.id).join() === queueAll.posts.slice(0, 4).map(p => p.id).join())
const affPage = db.pagePosts('queue', { kind: 'affiliate', limit: 100 })
check('kind filter keeps one kind', affPage.total > 0 && affPage.posts.every(p => p.kind === 'affiliate'))
check('kinds split the view', affPage.total + db.pagePosts('queue', { kind: 'news', limit: 100 }).total === queueAll.total)
check('stats follow kind', db.stats('news').scheduled + db.stats('affiliate').scheduled === db.stats().scheduled)

const s = db.stats()
check('stats count accounts', s.accounts === 0)
check('stats count published', s.published === 1)

cleanup()
console.log(`OK — ${n} assertions passed (crypto, kind migration, accounts, dedup, atomic claim, retry, disabled-account guard, queue tail, pages)`)
