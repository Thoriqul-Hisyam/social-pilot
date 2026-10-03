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
  -- post_metrics as first shipped, before gone_at
  CREATE TABLE post_metrics (
    post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, quotes INTEGER, shares INTEGER,
    error TEXT, fetched_at TEXT NOT NULL
  );
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

// --- token refresh selection ---
const setExpiry = (days: number | null) =>
  db.getDb().prepare('UPDATE accounts SET token_expires_at = ?, token_checked_at = NULL WHERE id = ?')
    .run(days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(), acc)
const refreshDue = () => db.accountsDueForRefresh().some(a => a.id === acc)
setExpiry(null); check('unknown expiry is due for refresh', refreshDue())
setExpiry(58); check('a fresh token is not due', !refreshDue())
setExpiry(10); check('a token with 10 days left is due', refreshDue())
check('due account comes decrypted', db.accountsDueForRefresh()[0]?.token === secret)
db.markTokenChecked(acc); check('a token tried in the last 12h waits', !refreshDue())
db.getDb().prepare("UPDATE accounts SET token_checked_at = datetime('now', '-13 hours') WHERE id = ?").run(acc)
check('and is tried again after 12h', refreshDue())
db.updateAccountToken(acc, 'refreshed-token', new Date(Date.now() + 60 * 86_400_000).toISOString())
check('refreshed token decrypts back', db.getAccountToken(acc)?.token === 'refreshed-token')
const stored = db.getDb().prepare('SELECT access_token FROM accounts WHERE id = ?').get(acc) as { access_token: string }
check('refreshed token stored encrypted', !stored.access_token.includes('refreshed-token'))
check('a refreshed token is no longer due', !refreshDue())

// --- posts + dedup ---
const past = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19)
const future = new Date(Date.now() + 3_600_000).toISOString().replace('T', ' ').slice(0, 19)

const p1 = db.queuePost({ account_id: acc, caption: 'first', source_url: 'https://a/1', kind: 'news', scheduled_at: past })
check('post queued', p1 !== null)
check('duplicate source_url skipped', db.queuePost({ account_id: acc, caption: 'dup', source_url: 'https://a/1', kind: 'news', scheduled_at: past }) === null)
check('null source_url allowed twice',
  db.queuePost({ account_id: acc, caption: 'x', kind: 'affiliate', scheduled_at: future }) !== null &&
  db.queuePost({ account_id: acc, caption: 'y', kind: 'affiliate', scheduled_at: future }) !== null)
check('kind is stored as given', db.listPosts().find(p => p.id === p1)?.kind === 'news' && kindOf('x') === 'affiliate')
const manual = db.queuePost({ account_id: acc, caption: 'manual news', kind: 'news', scheduled_at: future })!
check('kind does not depend on a source url', db.listPosts().find(p => p.id === manual)?.kind === 'news')
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

const p2 = db.queuePost({ account_id: acc, caption: 'retry me', kind: 'news', scheduled_at: past })!
db.claimDuePost()
db.markFailed(p2, 'boom', 3)
check('failure retries first', db.listPosts().find(p => p.id === p2)!.status === 'scheduled')
const p2At = () => (db.getDb().prepare('SELECT scheduled_at FROM posts WHERE id = ?').get(p2) as { scheduled_at: string }).scheduled_at
check('first retry waits 10 minutes', p2At() > db.toSqlTime(Date.now() + 9 * 60_000) && p2At() <= db.toSqlTime(Date.now() + 10 * 60_000))
check('a post waiting to retry is not claimed', db.claimDuePost() === null)
const makeP2Due = () => db.getDb().prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?').run(past, p2)
makeP2Due(); db.claimDuePost(); db.markFailed(p2, 'boom', 3)
check('second retry waits 20 minutes', p2At() > db.toSqlTime(Date.now() + 19 * 60_000))
makeP2Due(); db.claimDuePost(); db.markFailed(p2, 'boom', 3)
check('failure gives up after maxAttempts', db.listPosts().find(p => p.id === p2)!.status === 'failed')

// Rows failed before setup and empty-image errors became retryable still carry retryable = 0.
const p3 = db.queuePost({ account_id: acc, caption: 'old error', kind: 'news', scheduled_at: past })!
for (const old of ['Error: R2 not configured: set R2_BUCKET', 'Error: unsupported image format (not an image) from cdn.antaranews.com: Threads takes JPEG or PNG only']) {
  db.claimDuePost()
  db.markFailed(p3, old, 1, false)
  check(`old error can be retried by hand: ${old}`, db.retryPost(p3).ok && db.listPosts().find(p => p.id === p3)!.status === 'scheduled')
}
db.claimDuePost()
db.markFailed(p3, 'Error: unsupported image format (webp)', 1, false)
check('content error stays permanent', !db.retryPost(p3).ok)

// --- a rejected token pauses the account's queue ---
const p4 = db.queuePost({ account_id: acc, caption: 'paused', kind: 'news', scheduled_at: past })!
check('post claimed before the pause', db.claimDuePost()?.id === p4)
db.releasePost(p4, 'menunggu akun dihubungkan ulang')
const p4Row = () => db.getDb().prepare('SELECT status, attempts, scheduled_at, error FROM posts WHERE id = ?').get(p4) as
  { status: string; attempts: number; scheduled_at: string; error: string | null }
check('released post keeps its slot, attempt not counted',
  p4Row().status === 'scheduled' && p4Row().attempts === 0 && p4Row().scheduled_at === past && !!p4Row().error)
check('first pause names the account', db.markTokenInvalid(acc) === 'renamed')
check('a second pause stays quiet', db.markTokenInvalid(acc) === null)
check('a paused account is not claimed', db.claimDuePost() === null)
setExpiry(null); check('a paused account is not refreshed', !refreshDue())
db.upsertAccount({ platform: 'threads', external_id: '999', username: 'renamed', access_token: secret })
check('reconnect lifts the pause', db.listAccounts()[0].token_invalid_at === null && db.claimDuePost()?.id === p4)
db.markFailed(p4, 'done with it', 1, false)
db.markTokenInvalid(acc)
db.updateAccountToken(acc, secret, new Date(Date.now() + 60 * 86_400_000).toISOString())
check('a refreshed token lifts the pause', db.listAccounts()[0].token_invalid_at === null)

// --- insights ---
const a1 = db.recordPublishedPost({ account_id: acc, caption: 'news A', kind: 'news', external_ids: ['n1', 'n1r'] })
const a2 = db.recordPublishedPost({ account_id: acc, caption: 'aff B', kind: 'affiliate', external_ids: ['a1'] })
const a3 = db.recordPublishedPost({ account_id: acc, caption: 'aff C', kind: 'affiliate', external_ids: ['a2'] })
const needIds = () => db.postsNeedingInsights(50).map(p => p.id)
check('never-read posts need insights, newest first', needIds().slice(0, 3).join() === [a3, a2, a1].join())
check('a chain is read at its root', db.postsNeedingInsights(50).find(p => p.id === a1)?.media_id === 'n1')
db.saveMetrics(a1, { views: 1000, likes: 50, replies: 5, reposts: 3, quotes: 1, shares: 1 })
db.saveMetrics(a2, { views: 200, likes: 2, replies: 0, reposts: 0, quotes: 0, shares: 0 })
db.saveMetricsError(a3, 'boom')
check('a fresh reading, good or failed, waits', !needIds().includes(a1) && !needIds().includes(a3))
db.getDb().prepare("UPDATE post_metrics SET fetched_at = datetime('now', '-13 hours') WHERE post_id = ?").run(a1)
check('a reading over 12h old is refreshed within the week', needIds().includes(a1))
db.getDb().prepare("UPDATE posts SET published_at = datetime('now', '-8 days') WHERE id = ?").run(a1)
check('after a week the last reading stands', !needIds().includes(a1))
db.getDb().prepare("UPDATE posts SET published_at = datetime('now', '-2 days') WHERE id = ?").run(a1)
db.getDb().prepare("UPDATE post_metrics SET fetched_at = datetime('now', '-4 hours') WHERE post_id IN (?, ?)").run(a1, a2)
check('a post under a day old is reread after 3 hours', needIds().includes(a2))
check('an older post waits 12 hours between readings', !needIds().includes(a1))
db.saveMetricsError(a1, 'later failure')
const ins = db.insightsSummary(7)
check('a failed reading keeps the metrics read before it', ins.by_kind.news?.views === 1000)
// p1 is a published news post that was never read
check('summary counts posts and readings per kind',
  ins.by_kind.news?.posts === 2 && ins.by_kind.news?.covered === 1 &&
  ins.by_kind.affiliate?.posts === 2 && ins.by_kind.affiliate?.covered === 1)
check('averages divide by readings', ins.by_kind.news?.avg_views === 1000 && ins.by_kind.affiliate?.avg_likes === 2)
check('engagement rate', ins.by_kind.news?.engagement_rate === 0.06)
check('top is ordered by views', ins.top.map(p => p.id).join() === [a1, a2].join())
check('bottom skips posts under a day old', ins.bottom.map(p => p.id).join() === String(a1))
check('errors count posts whose latest reading failed', ins.by_kind.news?.errors === 1 && ins.by_kind.affiliate?.errors === 1)
check('top per kind', ins.top_by_kind.news?.map(p => p.id).join() === String(a1) && ins.top_by_kind.affiliate?.map(p => p.id).join() === String(a2))
const affOnly = db.insightsSummary(7, 'affiliate')
check('insights kind filter', Object.keys(affOnly.by_kind).join() === 'affiliate' && Object.keys(affOnly.top_by_kind).join() === 'affiliate')
check('history rows carry metrics', db.pagePosts('history', { limit: 100 }).posts.find(p => p.id === a1)?.views === 1000)
// a3's reading failed; a failed reading is retried daily up to 30 days, past the week
const setA3 = (published: string, fetched: string) => {
  db.getDb().prepare("UPDATE posts SET published_at = datetime('now', ?) WHERE id = ?").run(published, a3)
  db.getDb().prepare("UPDATE post_metrics SET fetched_at = datetime('now', ?) WHERE post_id = ?").run(fetched, a3)
}
setA3('-10 days', '-25 hours')
check('a failed reading is retried daily past the week', needIds().includes(a3))
setA3('-10 days', '-2 hours')
check('a failed reading waits a day between retries', !needIds().includes(a3))
setA3('-31 days', '-25 hours')
check('a failed reading stands after 30 days', !needIds().includes(a3))
// a4 was read, then deleted on Threads
const a4 = db.recordPublishedPost({ account_id: acc, caption: 'news gone', kind: 'news', external_ids: ['g1'] })
db.saveMetrics(a4, { views: 5000, likes: 10, replies: 0, reposts: 0, quotes: 0, shares: 0 })
db.saveMetricsGone(a4, 'Threads API [insights 100/33]: Object does not exist')
db.getDb().prepare("UPDATE post_metrics SET fetched_at = datetime('now', '-2 days') WHERE post_id = ?").run(a4)
check('a post deleted on Threads is never read again', !needIds().includes(a4))
const gone = db.insightsSummary(7)
check('a deleted post is counted apart and left out of the numbers',
  gone.by_kind.news?.gone === 1 && gone.by_kind.news?.posts === 2 && gone.by_kind.news?.views === 1000 &&
  gone.by_kind.news?.errors === 1 && gone.by_kind.affiliate?.gone === 0)
check('a deleted post is not ranked', !gone.top.some(p => p.id === a4))
check('history marks a deleted post', !!db.pagePosts('history', { limit: 100 }).posts.find(p => p.id === a4)?.gone_at)
for (const id of [a1, a2, a3, a4]) db.deletePost(id)
check('metrics go with their post', (db.getDb().prepare('SELECT COUNT(*) n FROM post_metrics').get() as { n: number }).n === 0)

// --- disabled accounts are never published for ---
db.setAccountEnabled(acc, false)
check('disabled account hides token', db.getAccountToken(acc) === null)
setExpiry(null); check('disabled account is never refreshed', !refreshDue())
db.queuePost({ account_id: acc, caption: 'should not run', kind: 'news', scheduled_at: past })
check('disabled account posts not claimed', db.claimDuePost() === null)

// --- queue tail: a new batch lines up after pending slots, not on top of them ---
const now = Date.now()
const gap = 30 * 60_000
check('toSqlTime matches scheduled_at format', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(db.toSqlTime(now)))
// 'x' and 'y' wait at +60 min: more than one gap away, so not part of the train yet
check('tail stays at now across a long gap', db.queueTail(gap, now) === now)
db.queuePost({ account_id: acc, caption: 'train 1', kind: 'news', scheduled_at: db.toSqlTime(now + 20 * 60_000) })
db.queuePost({ account_id: acc, caption: 'train 2', kind: 'news', scheduled_at: db.toSqlTime(now + 45 * 60_000) })
const futureMs = Date.parse(`${future.replace(' ', 'T')}Z`)
check('tail follows the train to its last slot', db.queueTail(gap, now) === futureMs)
db.queuePost({ account_id: acc, caption: 'parked', kind: 'news', scheduled_at: db.toSqlTime(now + 3 * 86_400_000) })
check('a post parked days ahead does not move the tail', db.queueTail(gap, now) === futureMs)
const vid = db.queuePost({ account_id: acc, caption: 'video', video_url: 'https://v/1.mp4', kind: 'news', scheduled_at: future })!
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
console.log(`OK — ${n} assertions passed (crypto, kind migration, accounts, token refresh, dedup, atomic claim, retry backoff, token pause, insights, disabled-account guard, queue tail, pages)`)
