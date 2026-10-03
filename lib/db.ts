import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { encrypt, decrypt } from './crypto'

export const PLATFORMS = ['threads', 'instagram', 'facebook'] as const
export type Platform = (typeof PLATFORMS)[number]
export const isPlatform = (v: unknown): v is Platform => PLATFORMS.includes(v as Platform)
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed'
export type PostKind = 'news' | 'affiliate'
export const POST_KINDS: readonly PostKind[] = ['news', 'affiliate']

/** Every post must say which it is; nothing is classified by guesswork. */
export const isPostKind = (v: unknown): v is PostKind => v === 'news' || v === 'affiliate'

export type Account = {
  id: number
  platform: Platform
  external_id: string
  username: string
  token_expires_at: string | null
  /** Set when the platform rejected the token; the account's queue waits until a reconnect or refresh. */
  token_invalid_at: string | null
  enabled: number
  /** Whether posts sent without an account (Hermes) land here, per kind. */
  auto_news: number
  auto_affiliate: number
}

export type Post = {
  id: number
  account_id: number
  caption: string
  image_url: string | null
  video_url: string | null
  source_url: string | null
  kind: PostKind
  status: PostStatus
  scheduled_at: string
  published_at: string | null
  external_ids: string | null
  error: string | null
  retryable: number
  attempts: number
  claimed_at: string | null
}

const FILE = process.env.DATABASE_PATH || './data/socialpilot.db'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  mkdirSync(dirname(FILE), { recursive: true })
  db = new DatabaseSync(FILE)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      platform         TEXT NOT NULL,
      external_id      TEXT NOT NULL,
      username         TEXT NOT NULL DEFAULT '',
      access_token     TEXT NOT NULL,
      token_expires_at TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (platform, external_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      caption      TEXT NOT NULL,
      image_url    TEXT,
      source_url   TEXT,
      status       TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at TEXT NOT NULL,
      published_at TEXT,
      external_ids TEXT,
      error        TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_posts_due ON posts (status, scheduled_at);

    -- crew activity: every pipeline stage speaks here, addressed to the next agent
    CREATE TABLE IF NOT EXISTS agent_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT NOT NULL,
      to_agent   TEXT,
      kind       TEXT NOT NULL DEFAULT 'info',
      message    TEXT NOT NULL,
      post_id    INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_recent ON agent_events (created_at DESC);

    -- latest insights of a published post's root, read from its platform. NULL metrics = never read;
    -- error = the last read failed (the metrics from before it stay);
    -- gone_at = the platform said the post no longer exists, so it is never read again
    CREATE TABLE IF NOT EXISTS post_metrics (
      post_id    INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      views      INTEGER,
      likes      INTEGER,
      replies    INTEGER,
      reposts    INTEGER,
      quotes     INTEGER,
      shares     INTEGER,
      error      TEXT,
      fetched_at TEXT NOT NULL,
      gone_at    TEXT
    );
  `)
  // Keep existing installations compatible with the retry diagnostics.
  try { db.exec('ALTER TABLE posts ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1') } catch { /* already migrated */ }
  try { db.exec('ALTER TABLE posts ADD COLUMN claimed_at TEXT') } catch { /* already migrated */ }
  try { db.exec('ALTER TABLE posts ADD COLUMN video_url TEXT') } catch { /* already migrated */ }
  try { db.exec('ALTER TABLE accounts ADD COLUMN token_checked_at TEXT') } catch { /* already migrated */ }
  try { db.exec('ALTER TABLE accounts ADD COLUMN token_invalid_at TEXT') } catch { /* already migrated */ }
  try { db.exec('ALTER TABLE post_metrics ADD COLUMN gone_at TEXT') } catch { /* already migrated */ }
  // auto_* route posts that name no account. Existing accounts keep receiving everything.
  try { db.exec('ALTER TABLE accounts ADD COLUMN auto_news INTEGER NOT NULL DEFAULT 1') } catch { /* already migrated */ }
  try { db.exec('ALTER TABLE accounts ADD COLUMN auto_affiliate INTEGER NOT NULL DEFAULT 1') } catch { /* already migrated */ }
  // Rows from before the column: news always carried its article URL, affiliate never did.
  // Column and backfill land together, so a failed upgrade never leaves every row marked news.
  const cols = db.prepare('PRAGMA table_info(posts)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'kind')) {
    db.exec('BEGIN')
    try {
      db.exec("ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'news'")
      db.exec("UPDATE posts SET kind = 'affiliate' WHERE source_url IS NULL")
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  // dedup: the same article never queues twice for the same account.
  // Affiliate is exempt on purpose: a product may be posted again.
  db.exec(`
    DROP INDEX IF EXISTS idx_posts_dedup;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_dedup_news
      ON posts (account_id, source_url) WHERE kind = 'news' AND source_url IS NOT NULL;
  `)
  return db
}

// --- accounts ---------------------------------------------------------------

/** A reconnect replaces the token and lifts a pause, but keeps the account's routing. */
export function upsertAccount(a: {
  platform: Platform; external_id: string; username: string
  access_token: string; token_expires_at?: string | null
}): number {
  const row = getDb().prepare(`
    INSERT INTO accounts (platform, external_id, username, access_token, token_expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (platform, external_id) DO UPDATE SET
      username = excluded.username,
      access_token = excluded.access_token,
      token_expires_at = excluded.token_expires_at,
      token_invalid_at = NULL,
      token_checked_at = NULL,
      enabled = 1
    RETURNING id
  `).get(a.platform, a.external_id, a.username, encrypt(a.access_token), a.token_expires_at ?? null) as { id: number }
  return row.id
}

export function listAccounts(): Account[] {
  return getDb().prepare(
    `SELECT id, platform, external_id, username, token_expires_at, token_invalid_at, enabled, auto_news, auto_affiliate
     FROM accounts ORDER BY id`
  ).all() as Account[]
}

export type AccountCredentials = {
  id: number; platform: Platform; external_id: string; username: string
  token: string; token_expires_at: string | null
}

/** Decrypts on read. Never log or return this over HTTP. Null when missing or disabled. */
export function getAccountToken(id: number): AccountCredentials | null {
  const row = getDb().prepare(
    `SELECT id, platform, external_id, username, access_token, token_expires_at
     FROM accounts WHERE id = ? AND enabled = 1`
  ).get(id) as (Omit<AccountCredentials, 'token'> & { access_token: string }) | undefined
  if (!row) return null
  const { access_token, ...rest } = row
  return { ...rest, token: decrypt(access_token) }
}

export function setAccountEnabled(id: number, enabled: boolean) {
  getDb().prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

/** Which kinds land on this account when a post names no account. Unset fields stay. */
export function setAccountRouting(id: number, r: { auto_news?: boolean; auto_affiliate?: boolean }) {
  getDb().prepare(`
    UPDATE accounts SET auto_news = COALESCE(?, auto_news), auto_affiliate = COALESCE(?, auto_affiliate) WHERE id = ?
  `).run(r.auto_news == null ? null : Number(r.auto_news), r.auto_affiliate == null ? null : Number(r.auto_affiliate), id)
}

/** Enabled accounts that take posts of this kind when the post names no account. */
export function routeTargets(kind: PostKind): Account[] {
  return listAccounts().filter(a => a.enabled && (kind === 'news' ? a.auto_news : a.auto_affiliate))
}

/** A token is refreshed once it has under this many days left: about weekly, as a fresh one has 60. */
export const REFRESH_DAYS_LEFT = 53

/** Platforms whose 60-day token is traded for a fresh one before it runs out. */
export const LONG_LIVED_PLATFORMS: readonly Platform[] = ['threads', 'instagram']

/**
 * Enabled accounts whose token should be refreshed now, decrypted. One that
 * was tried in the last 12 hours waits, so a failing refresh is not retried every tick.
 * token_expires_at is ISO ('T', 'Z'), so it is compared through datetime().
 * Only 60-day tokens: Facebook Page tokens do not expire.
 */
export function accountsDueForRefresh(): { id: number; platform: Platform; username: string; token: string }[] {
  const rows = getDb().prepare(`
    SELECT id, platform, username, access_token FROM accounts
    WHERE enabled = 1 AND token_invalid_at IS NULL
      AND platform IN (${LONG_LIVED_PLATFORMS.map(() => '?').join(', ')})
      AND (token_expires_at IS NULL OR datetime(token_expires_at) < datetime('now', ?))
      AND (token_checked_at IS NULL OR token_checked_at < datetime('now', '-12 hours'))
  `).all(...LONG_LIVED_PLATFORMS, `+${REFRESH_DAYS_LEFT} days`) as { id: number; platform: Platform; username: string; access_token: string }[]
  return rows.map(r => ({ id: r.id, platform: r.platform, username: r.username, token: decrypt(r.access_token) }))
}

export function markTokenChecked(id: number) {
  getDb().prepare("UPDATE accounts SET token_checked_at = datetime('now') WHERE id = ?").run(id)
}

export function updateAccountToken(id: number, token: string, expiresAt: string) {
  getDb().prepare('UPDATE accounts SET access_token = ?, token_expires_at = ?, token_invalid_at = NULL WHERE id = ?')
    .run(encrypt(token), expiresAt, id)
}

/** Pauses the account's queue. Returns its username the first time, null if it was already paused. */
export function markTokenInvalid(id: number): string | null {
  const row = getDb().prepare(`
    UPDATE accounts SET token_invalid_at = datetime('now')
    WHERE id = ? AND token_invalid_at IS NULL RETURNING username
  `).get(id) as { username: string } | undefined
  return row ? row.username || String(id) : null
}

// --- posts ------------------------------------------------------------------

/** Returns the new post id, or null when this news source_url is already queued for this account. */
export function queuePost(p: {
  account_id: number; caption: string; image_url?: string | null
  video_url?: string | null
  source_url?: string | null; kind: PostKind; scheduled_at: string
}): number | null {
  try {
    const row = getDb().prepare(`
      INSERT INTO posts (account_id, caption, image_url, video_url, source_url, kind, scheduled_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled') RETURNING id
    `).get(
      p.account_id, p.caption, p.image_url ?? null, p.video_url ?? null, p.source_url ?? null,
      p.kind, p.scheduled_at,
    ) as { id: number }
    return row.id
  } catch (e) {
    if (String(e).includes('UNIQUE')) return null   // already queued — expected, not an error
    throw e
  }
}

/** Milliseconds to the 'YYYY-MM-DD HH:MM:SS' UTC form stored in scheduled_at. */
export function toSqlTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * End of an account's queue train: the last pending slot reachable from now
 * without a gap longer than maxGapMs. New batches line up after it instead of
 * on top of it. A lone post parked days ahead is not part of the train, so it
 * cannot push new batches back to its date. Each account keeps its own rhythm.
 */
export function queueTail(maxGapMs: number, accountId: number, now = Date.now()): number {
  const slots = getDb().prepare(`
    SELECT scheduled_at FROM posts
    WHERE account_id = ? AND status IN ('scheduled', 'publishing') AND scheduled_at > ?
    ORDER BY scheduled_at
  `).all(accountId, toSqlTime(now)) as { scheduled_at: string }[]
  let tail = now
  for (const { scheduled_at } of slots) {
    const t = Date.parse(`${scheduled_at.replace(' ', 'T')}Z`)
    if (Number.isNaN(t)) continue
    if (t - tail > maxGapMs) break
    tail = t
  }
  return tail
}

/** A full 7-part chain with retries finishes well within this; longer means the worker died. */
const STALE_PUBLISHING_MIN = 20

/**
 * A post left in 'publishing' by a worker that stopped mid-send (restart, crash)
 * would sit there forever. Fail it instead, so it can be deleted or retried by hand;
 * never auto-retry, since some parts may already be live.
 */
export function recoverStalePublishing() {
  getDb().prepare(`
    UPDATE posts
    SET status = 'failed', retryable = 1,
        error = 'stuck while publishing (worker stopped mid-send); check the platform for parts that went out. ' || COALESCE(error, '')
    WHERE status = 'publishing'
      AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))
  `).run(`-${STALE_PUBLISHING_MIN} minutes`)
}

/**
 * Atomically claim the oldest due post so two workers can't publish it twice,
 * skipping the accounts in `except`. Returns null when nothing is due.
 */
export function claimDuePost(except: number[] = []): Post | null {
  recoverStalePublishing()
  const row = getDb().prepare(`
    UPDATE posts SET status = 'publishing', attempts = attempts + 1, claimed_at = datetime('now')
    WHERE id = (
      SELECT p.id FROM posts p
      JOIN accounts a ON a.id = p.account_id AND a.enabled = 1 AND a.token_invalid_at IS NULL
      WHERE p.status = 'scheduled' AND p.scheduled_at <= datetime('now')
        AND p.account_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY p.scheduled_at LIMIT 1
    )
    RETURNING *
  `).get(JSON.stringify(except)) as Post | undefined
  return row ?? null
}

/**
 * The oldest due post of each account, claimed. Accounts publish side by side,
 * so one slow platform (video processing, a long chain) does not hold up the rest.
 */
export function claimDuePosts(): Post[] {
  const claimed: Post[] = []
  for (let p = claimDuePost(); p; p = claimDuePost(claimed.map(c => c.account_id))) claimed.push(p)
  return claimed
}

export function markPublished(id: number, externalIds: string[]) {
  getDb().prepare(`
    UPDATE posts SET status = 'published', published_at = datetime('now'),
                     external_ids = ?, error = NULL WHERE id = ?
  `).run(JSON.stringify(externalIds), id)
}

/** Record a post published directly, outside the scheduled queue. */
export function recordPublishedPost(p: {
  account_id: number; caption: string; image_url?: string | null
  video_url?: string | null
  source_url?: string | null; kind: PostKind; external_ids: string[]
}): number {
  const row = getDb().prepare(`
    INSERT INTO posts
      (account_id, caption, image_url, video_url, source_url, kind, status, scheduled_at, published_at, external_ids)
    VALUES (?, ?, ?, ?, ?, ?, 'published', datetime('now'), datetime('now'), ?)
    RETURNING id
  `).get(
    p.account_id, p.caption, p.image_url ?? null, p.video_url ?? null, p.source_url ?? null,
    p.kind, JSON.stringify(p.external_ids),
  ) as { id: number }
  return row.id
}

export type PostView = 'queue' | 'failed' | 'history' | 'all'
export type Metrics = { views: number; likes: number; replies: number; reposts: number; quotes: number; shares: number }
type ListedPost = Post & { username: string; platform: string; gone_at: string | null } & { [K in keyof Metrics]: number | null }

// p.id breaks ties, so a page boundary never repeats or skips posts sharing a timestamp.
const VIEWS: Record<PostView, { where: string; order: string }> = {
  queue: { where: "p.status IN ('draft', 'scheduled', 'publishing')", order: 'p.scheduled_at ASC, p.id ASC' },
  failed: { where: "p.status = 'failed'", order: 'COALESCE(p.published_at, p.scheduled_at) DESC, p.id DESC' },
  history: { where: "p.status = 'published'", order: 'COALESCE(p.published_at, p.scheduled_at) DESC, p.id DESC' },
  all: { where: '1 = 1', order: 'p.scheduled_at DESC, p.id DESC' },
}

/** One page of a dashboard list, of one kind or (kind null) all, plus the total for paging. */
export function pagePosts(view: PostView, o: { kind?: PostKind | null; limit?: number; offset?: number } = {}) {
  if (view === 'queue') recoverStalePublishing()
  const kind = o.kind ?? null
  const from = `
    FROM posts p JOIN accounts a ON a.id = p.account_id
    LEFT JOIN post_metrics m ON m.post_id = p.id
    WHERE ${VIEWS[view].where} AND (? IS NULL OR p.kind = ?)`
  const { n } = getDb().prepare(`SELECT COUNT(*) n ${from}`).get(kind, kind) as { n: number }
  const posts = getDb().prepare(`
    SELECT p.*, a.username, a.platform, m.views, m.likes, m.replies, m.reposts, m.quotes, m.shares, m.gone_at ${from}
    ORDER BY ${VIEWS[view].order} LIMIT ? OFFSET ?
  `).all(kind, kind, o.limit ?? 50, o.offset ?? 0) as ListedPost[]
  return { posts, total: n }
}

/**
 * Hands a claimed post back untouched, for a failure that was the account's, not
 * the post's: the attempt is not counted and it keeps its slot. error says why it waits.
 */
export function releasePost(id: number, error: string) {
  getDb().prepare(`
    UPDATE posts SET status = 'scheduled', attempts = MAX(attempts - 1, 0), claimed_at = NULL, error = ?
    WHERE id = ?
  `).run(error.slice(0, 1000), id)
}

/**
 * Hands a claimed post back to wait `minutes`, for a limit the platform will lift
 * (Instagram's daily publishing cap, a rate limit). The attempt is not counted.
 */
export function deferPost(id: number, minutes: number, error: string) {
  getDb().prepare(`
    UPDATE posts SET status = 'scheduled', attempts = MAX(attempts - 1, 0), claimed_at = NULL, error = ?,
                     scheduled_at = datetime('now', ?)
    WHERE id = ?
  `).run(error.slice(0, 1000), `+${minutes} minutes`, id)
}

/**
 * Failed posts go back to 'scheduled' for retry until MAX_ATTEMPTS, 10 minutes
 * later per attempt so far (10, then 20), so other due posts go out meanwhile.
 */
export function markFailed(id: number, error: string, maxAttempts = 3, retryable = true) {
  const r = retryable ? 1 : 0
  getDb().prepare(`
    UPDATE posts
    SET status = CASE WHEN attempts >= ? OR ? = 0 THEN 'failed' ELSE 'scheduled' END,
        scheduled_at = CASE WHEN attempts >= ? OR ? = 0 THEN scheduled_at
                       ELSE datetime('now', '+' || (attempts * 10) || ' minutes') END,
        error = ?, retryable = ?
    WHERE id = ?
  `).run(maxAttempts, r, maxAttempts, r, error.slice(0, 1000), r, id)
}

/** Retries always start over from part 1; delete any partial thread on Threads first. */
export function retryPost(id: number): { ok: boolean; reason?: string } {
  const post = getDb().prepare('SELECT status, retryable, error FROM posts WHERE id = ?').get(id) as
    { status: PostStatus; retryable: number; error: string | null } | undefined
  if (!post) return { ok: false, reason: 'post not found' }
  if (post.status !== 'failed') return { ok: false, reason: 'post is not failed' }
  // Older broken chains, setup errors and empty image downloads were stored as permanent; they are retryable by hand.
  if (!post.retryable && !/chain broke|missing Threads credentials|R2 not configured|\(not an image\)/.test(post.error ?? '')) return { ok: false, reason: 'error is permanent and needs fixing first' }
  getDb().prepare(`
    UPDATE posts SET status = 'scheduled', scheduled_at = datetime('now'), attempts = 0, retryable = 1
    WHERE id = ?
  `).run(id)
  return { ok: true }
}

/** Parts of a broken chain still live on Threads, as named in its error. */
export function liveIdsFromError(error: string | null): string[] {
  const m = error?.match(/(?:published|delete by hand): ([\d,]+);/)
  return m ? m[1].split(',').filter(Boolean) : []
}

/** Removes a post that is not mid-publish. Returns it so the caller can clean up Threads. */
export function deletePost(id: number): { ok: true; post: Post } | { ok: false; reason: string } {
  const post = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id) as Post | undefined
  if (!post) return { ok: false, reason: 'post not found' }
  if (post.status === 'publishing') return { ok: false, reason: 'post sedang dikirim, tunggu selesai' }
  getDb().prepare('DELETE FROM posts WHERE id = ?').run(id)
  return { ok: true, post }
}

export function listPosts(limit = 50): ListedPost[] {
  return pagePosts('all', { limit }).posts
}

/** Post counts of one kind, or (kind null) all. The account count ignores kind. */
export function stats(kind: PostKind | null = null) {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) n FROM posts WHERE ? IS NULL OR kind = ? GROUP BY status`
  ).all(kind, kind) as { status: string; n: number }[]
  const by = Object.fromEntries(rows.map(r => [r.status, r.n]))
  const accounts = getDb().prepare(
    'SELECT COUNT(*) n FROM accounts WHERE enabled = 1'
  ).get() as { n: number }
  return {
    scheduled: by.scheduled ?? 0,
    published: by.published ?? 0,
    failed: by.failed ?? 0,
    draft: by.draft ?? 0,
    accounts: accounts.n,
  }
}

// --- insights ---------------------------------------------------------------

/**
 * Published posts whose insights to read now, root media id first in external_ids.
 * Never-read posts come first, newest first (this also backfills older history once).
 * Then stale readings: every 3 hours in a post's first day, while its numbers still
 * climb, and every 12 hours until it is a week old. After that the last reading stands,
 * unless it failed: a failed reading is retried hourly while the post is under 30 days
 * old, the longest dashboard period. Posts deleted on their platform and accounts with a
 * rejected token are skipped, as are accounts in `except` (say, waiting out a missing permission).
 */
export function postsNeedingInsights(limit: number, except: number[] = []): { id: number; account_id: number; platform: Platform; media_id: string }[] {
  return getDb().prepare(`
    SELECT p.id, p.account_id, a.platform, json_extract(p.external_ids, '$[0]') media_id FROM posts p
    JOIN accounts a ON a.id = p.account_id AND a.enabled = 1 AND a.token_invalid_at IS NULL
    LEFT JOIN post_metrics m ON m.post_id = p.id
    WHERE p.status = 'published' AND json_extract(p.external_ids, '$[0]') IS NOT NULL AND m.gone_at IS NULL
      AND p.account_id NOT IN (SELECT value FROM json_each(?))
      AND (m.post_id IS NULL
        OR (p.published_at > datetime('now', '-1 day') AND m.fetched_at < datetime('now', '-3 hours'))
        OR (p.published_at > datetime('now', '-7 days') AND m.fetched_at < datetime('now', '-12 hours'))
        OR (m.error IS NOT NULL AND p.published_at > datetime('now', '-30 days') AND m.fetched_at < datetime('now', '-1 hour')))
    ORDER BY m.post_id IS NOT NULL, p.published_at DESC, p.id DESC
    LIMIT ?
  `).all(JSON.stringify(except), limit) as { id: number; account_id: number; platform: Platform; media_id: string }[]
}

export function saveMetrics(postId: number, m: Metrics) {
  getDb().prepare(`
    INSERT INTO post_metrics (post_id, views, likes, replies, reposts, quotes, shares, error, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
    ON CONFLICT (post_id) DO UPDATE SET
      views = excluded.views, likes = excluded.likes, replies = excluded.replies,
      reposts = excluded.reposts, quotes = excluded.quotes, shares = excluded.shares,
      error = NULL, fetched_at = excluded.fetched_at
  `).run(postId, m.views, m.likes, m.replies, m.reposts, m.quotes, m.shares)
}

/** A failed reading waits like a good one, and keeps the metrics read before it. */
export function saveMetricsError(postId: number, error: string) {
  getDb().prepare(`
    INSERT INTO post_metrics (post_id, error, fetched_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT (post_id) DO UPDATE SET error = excluded.error, fetched_at = excluded.fetched_at
  `).run(postId, error.slice(0, 500))
}

/** The post was deleted on its platform: stop reading it and leave it out of the numbers. */
export function saveMetricsGone(postId: number, error: string) {
  getDb().prepare(`
    INSERT INTO post_metrics (post_id, error, fetched_at, gone_at) VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT (post_id) DO UPDATE SET error = excluded.error, fetched_at = excluded.fetched_at, gone_at = excluded.gone_at
  `).run(postId, error.slice(0, 500))
}

export type KindSummary = Metrics & {
  posts: number; covered: number; errors: number; gone: number
  avg_views: number; avg_likes: number; engagement_rate: number
}
export type RankedPost = Metrics & { id: number; kind: PostKind; caption: string; published_at: string }

/**
 * Performance of posts published in the last `days`, per kind (or one kind).
 * covered counts the posts with a reading; averages divide by it, not by posts.
 * errors counts posts whose latest reading failed.
 * gone counts posts deleted on their platform; every other number leaves them out.
 * platform narrows it to one platform's accounts; views are not comparable across platforms.
 * engagement_rate = (likes + replies + reposts + quotes + shares) / views.
 * top/bottom rank across the kinds asked for; top_by_kind/bottom_by_kind rank each.
 * bottom skips posts under a day old, which have not had their audience yet.
 */
export function insightsSummary(days: number, kind: PostKind | null = null, platform: Platform | null = null) {
  const since = `-${days} days`
  const where = `p.status = 'published' AND p.published_at > datetime('now', ?) AND (? IS NULL OR p.kind = ?)
    AND (? IS NULL OR p.account_id IN (SELECT id FROM accounts WHERE platform = ?))`
  // m holds readings of posts still up, g marks the deleted ones.
  const rows = getDb().prepare(`
    SELECT p.kind, COUNT(*) - COUNT(g.post_id) posts, COUNT(g.post_id) gone, COUNT(m.views) covered, COUNT(m.error) errors,
      COALESCE(SUM(m.views), 0) views, COALESCE(SUM(m.likes), 0) likes, COALESCE(SUM(m.replies), 0) replies,
      COALESCE(SUM(m.reposts), 0) reposts, COALESCE(SUM(m.quotes), 0) quotes, COALESCE(SUM(m.shares), 0) shares
    FROM posts p
    LEFT JOIN post_metrics m ON m.post_id = p.id AND m.gone_at IS NULL
    LEFT JOIN post_metrics g ON g.post_id = p.id AND g.gone_at IS NOT NULL
    WHERE ${where} GROUP BY p.kind
  `).all(since, kind, kind, platform, platform) as (Metrics & { kind: PostKind; posts: number; covered: number; errors: number; gone: number })[]
  const by_kind: Partial<Record<PostKind, KindSummary>> = {}
  for (const { kind: k, ...r } of rows) {
    const engaged = r.likes + r.replies + r.reposts + r.quotes + r.shares
    by_kind[k] = {
      ...r,
      avg_views: r.covered ? Math.round(r.views / r.covered) : 0,
      avg_likes: r.covered ? Math.round(r.likes / r.covered * 10) / 10 : 0,
      engagement_rate: r.views ? Math.round(engaged / r.views * 10_000) / 10_000 : 0,
    }
  }
  const ranked = (k: PostKind | null, order: 'ASC' | 'DESC') => getDb().prepare(`
    SELECT p.id, p.kind, substr(p.caption, 1, 120) caption, p.published_at,
      m.views, m.likes, m.replies, m.reposts, m.quotes, m.shares
    FROM posts p JOIN post_metrics m ON m.post_id = p.id
    WHERE ${where} AND m.views IS NOT NULL AND m.gone_at IS NULL
      ${order === 'ASC' ? "AND p.published_at < datetime('now', '-1 day')" : ''}
    ORDER BY m.views ${order}, p.id DESC LIMIT 5
  `).all(since, k, k, platform, platform) as RankedPost[]
  const perKind = (order: 'ASC' | 'DESC') => Object.fromEntries(
    POST_KINDS.filter(k => !kind || k === kind).map(k => [k, ranked(k, order)]),
  ) as Partial<Record<PostKind, RankedPost[]>>
  return {
    days, kind, platform, by_kind,
    top: ranked(kind, 'DESC'),
    bottom: ranked(kind, 'ASC'),
    top_by_kind: perKind('DESC'),
    bottom_by_kind: perKind('ASC'),
  }
}

// --- crew ------------------------------------------------------------------

export type AgentEvent = {
  id: number; agent: string; to_agent: string | null
  kind: string; message: string; post_id: number | null; created_at: string
}

export function logEvent(e: {
  agent: string; message: string
  to_agent?: string | null; kind?: string; post_id?: number | null
}): number {
  const row = getDb().prepare(`
    INSERT INTO agent_events (agent, to_agent, kind, message, post_id)
    VALUES (?, ?, ?, ?, ?) RETURNING id
  `).get(e.agent, e.to_agent ?? null, e.kind ?? 'info', e.message.slice(0, 2000), e.post_id ?? null) as { id: number }
  return row.id
}

export function listEvents(limit = 60): AgentEvent[] {
  return getDb().prepare(
    'SELECT * FROM agent_events ORDER BY id DESC LIMIT ?'
  ).all(limit) as AgentEvent[]
}

/** Last thing each agent said, plus how long ago — drives the sprite status. */
export function agentStates(): { agent: string; kind: string; message: string; created_at: string }[] {
  return getDb().prepare(`
    SELECT e.agent, e.kind, e.message, e.created_at FROM agent_events e
    JOIN (SELECT agent, MAX(id) id FROM agent_events GROUP BY agent) last
      ON last.id = e.id
  `).all() as { agent: string; kind: string; message: string; created_at: string }[]
}
