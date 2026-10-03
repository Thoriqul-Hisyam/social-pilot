import type { AccountCredentials, Metrics, Platform, PostKind } from './db'
import { threads } from './threads'
import { instagram } from './instagram'
import { facebook } from './facebook'

/** An account an OAuth connect handed back, ready for upsertAccount. */
export type Connected = { external_id: string; username: string; access_token: string; token_expires_at: string | null }

/** A fresh access token and when it runs out. */
export type TokenSet = { token: string; expiresAt: string }

/** What to publish. Media URLs are the originals; each platform rehosts them its own way. */
export type PublishJob = { text: string; imageUrl?: string; videoUrl?: string; kind: PostKind }

/** Everything the queue, the worker and the connect flow need from one platform. */
export type Adapter = {
  label: string
  /** Env vars the platform still needs; empty when it can be connected. */
  missingEnv(): string[]
  /** Where the browser goes to approve the app. */
  authorizeUrl(o: { state: string; redirectUri: string }): string
  /** Trades the callback's code for the accounts it grants: one, or one per Facebook Page. */
  connect(o: { code: string; redirectUri: string }): Promise<Connected[]>
  /** Publishes and returns the platform's ids, root first. */
  publish(job: PublishJob, account: AccountCredentials): Promise<string[]>
  /** Lifetime numbers of one published post, by its root id. */
  fetchInsights(mediaId: string, account: AccountCredentials): Promise<Metrics>
  /** For 60-day tokens (Threads, Instagram): trade the token for a fresh one. */
  refreshLongLived?(token: string): Promise<TokenSet>
  /**
   * Deletes a published post, all its parts, last first. live lists the ids still
   * up, with the reasons in errors. Absent where the platform's API cannot delete (Instagram).
   */
  deletePosts?(ids: string[], token: string): Promise<{ live: string[]; errors: string[] }>
}

/** The platforms that can be connected. */
export const ADAPTERS: Record<Platform, Adapter> = { threads, instagram, facebook }

export const adapterFor = (platform: Platform): Adapter => {
  const a = ADAPTERS[platform]
  if (!a) throw new Error(`platform ${platform} is not supported`)
  return a
}

/** For the dashboard: every platform that can be connected and whether its env is complete. */
export const platformList = () =>
  (Object.entries(ADAPTERS) as [Platform, Adapter][]).map(([id, a]) => ({ id, label: a.label, missing: a.missingEnv() }))
