import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { encrypt, decrypt } from './crypto'

export type Platform = 'threads' | 'facebook'
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed'

export type Account = {
  id: number
  platform: Platform
  external_id: string
  username: string
  token_expires_at: string | null
  enabled: number
}

export type Post = {
  id: number
  account_id: number
  caption: string
  image_url: string | null
  source_url: string | null
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

    -- dedup: the same article never queues twice for the same account
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_dedup
      ON posts (account_id, source_url) WHERE source_url IS NOT NULL;
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
  `)
  // Keep existing installations compatible with the retry diagnostics.
  try { db.exec('ALTER TABLE posts ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1') } catch { /* already migrated */ }
  try { db.exec('ALTER TABLE posts ADD COLUMN claimed_at TEXT') } catch { /* already migrated */ }
  return db
}

// --- accounts ---------------------------------------------------------------

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
      enabled = 1
    RETURNING id
  `).get(a.platform, a.external_id, a.username, encrypt(a.access_token), a.token_expires_at ?? null) as { id: number }
  return row.id
}

export function listAccounts(): Account[] {
  return getDb().prepare(
    `SELECT id, platform, external_id, username, token_expires_at, enabled
     FROM accounts ORDER BY id`
  ).all() as Account[]
}

/** Decrypts on read. Never log or return this over HTTP. */
export function getAccountToken(id: number): { external_id: string; token: string } | null {
  const row = getDb().prepare(
    'SELECT external_id, access_token FROM accounts WHERE id = ? AND enabled = 1'
  ).get(id) as { external_id: string; access_token: string } | undefined
  return row ? { external_id: row.external_id, token: decrypt(row.access_token) } : null
}

export function setAccountEnabled(id: number, enabled: boolean) {
  getDb().prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

// --- posts ------------------------------------------------------------------

/** Returns the new post id, or null when source_url already queued for this account. */
export function queuePost(p: {
  account_id: number; caption: string; image_url?: string | null
  source_url?: string | null; scheduled_at: string
}): number | null {
  try {
    const row = getDb().prepare(`
      INSERT INTO posts (account_id, caption, image_url, source_url, scheduled_at, status)
      VALUES (?, ?, ?, ?, ?, 'scheduled') RETURNING id
    `).get(p.account_id, p.caption, p.image_url ?? null, p.source_url ?? null, p.scheduled_at) as { id: number }
    return row.id
  } catch (e) {
    if (String(e).includes('UNIQUE')) return null   // already queued — expected, not an error
    throw e
  }
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
        error = 'stuck while publishing (worker stopped mid-send); check Threads for parts that went out. ' || COALESCE(error, '')
    WHERE status = 'publishing'
      AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))
  `).run(`-${STALE_PUBLISHING_MIN} minutes`)
}

/**
 * Atomically claim the oldest due post so two workers can't publish it twice.
 * Returns null when nothing is due.
 */
export function claimDuePost(): Post | null {
  recoverStalePublishing()
  const row = getDb().prepare(`
    UPDATE posts SET status = 'publishing', attempts = attempts + 1, claimed_at = datetime('now')
    WHERE id = (
      SELECT p.id FROM posts p
      JOIN accounts a ON a.id = p.account_id AND a.enabled = 1
      WHERE p.status = 'scheduled' AND p.scheduled_at <= datetime('now')
      ORDER BY p.scheduled_at LIMIT 1
    )
    RETURNING *
  `).get() as Post | undefined
  return row ?? null
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
  source_url?: string | null; external_ids: string[]
}): number {
  const row = getDb().prepare(`
    INSERT INTO posts
      (account_id, caption, image_url, source_url, status, scheduled_at, published_at, external_ids)
    VALUES (?, ?, ?, ?, 'published', datetime('now'), datetime('now'), ?)
    RETURNING id
  `).get(
    p.account_id, p.caption, p.image_url ?? null, p.source_url ?? null,
    JSON.stringify(p.external_ids),
  ) as { id: number }
  return row.id
}

export function listPostsByStatus(status: PostStatus, limit = 50) {
  return getDb().prepare(`
    SELECT p.*, a.username, a.platform FROM posts p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.status = ?
    ORDER BY COALESCE(p.published_at, p.scheduled_at) DESC LIMIT ?
  `).all(status, limit) as (Post & { username: string; platform: string })[]
}

export function listQueue(limit = 50) {
  recoverStalePublishing()
  return getDb().prepare(`
    SELECT p.*, a.username, a.platform FROM posts p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.status IN ('draft', 'scheduled', 'publishing')
    ORDER BY p.scheduled_at ASC LIMIT ?
  `).all(limit) as (Post & { username: string; platform: string })[]
}

/** Failed posts go back to 'scheduled' for retry until MAX_ATTEMPTS. */
export function markFailed(id: number, error: string, maxAttempts = 3, retryable = true) {
  getDb().prepare(`
    UPDATE posts
    SET status = CASE WHEN attempts >= ? OR ? = 0 THEN 'failed' ELSE 'scheduled' END,
        error = ?, retryable = ?
    WHERE id = ?
  `).run(maxAttempts, retryable ? 1 : 0, error.slice(0, 1000), retryable ? 1 : 0, id)
}

/** Retries always start over from part 1; delete any partial thread on Threads first. */
export function retryPost(id: number): { ok: boolean; reason?: string } {
  const post = getDb().prepare('SELECT status, retryable, error FROM posts WHERE id = ?').get(id) as
    { status: PostStatus; retryable: number; error: string | null } | undefined
  if (!post) return { ok: false, reason: 'post not found' }
  if (post.status !== 'failed') return { ok: false, reason: 'post is not failed' }
  // Older broken chains were stored as permanent; they are retryable by hand.
  if (!post.retryable && !post.error?.includes('chain broke')) return { ok: false, reason: 'error is permanent and needs fixing first' }
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

export function listPosts(limit = 50): (Post & { username: string; platform: string })[] {
  return getDb().prepare(`
    SELECT p.*, a.username, a.platform FROM posts p
    JOIN accounts a ON a.id = p.account_id
    ORDER BY p.scheduled_at DESC LIMIT ?
  `).all(limit) as (Post & { username: string; platform: string })[]
}

export function stats() {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) n FROM posts GROUP BY status`
  ).all() as { status: string; n: number }[]
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
