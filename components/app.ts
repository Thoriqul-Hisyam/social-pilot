'use client'
import { createContext, useContext } from 'react'
import type { Account, Activity, Group, PlatformInfo } from './format'

export type ConfirmRequest = { title: string; body: React.ReactNode; confirm: string; danger?: boolean }

/** What every page shares, loaded and kept fresh by <Shell>. */
export type App = {
  accounts: Account[]; groups: Group[]; platforms: PlatformInfo[]; activity: Activity | null
  /** False until the first load lands, so pages show skeletons instead of empty states. */
  loaded: boolean
  loading: boolean
  /** Goes up on every refresh after the first; pages refetch their own lists when it moves. */
  version: number
  refresh: () => Promise<void>
  toast: (text: string, ok?: boolean) => void
  /** A dialog in place of window.confirm; resolves true when the user agrees. */
  confirm: (request: ConfirmRequest) => Promise<boolean>
  /** Opens the composer, with that account picked when given. */
  compose: (accountId?: number) => void
}

export const AppContext = createContext<App | null>(null)

export function useApp() {
  const app = useContext(AppContext)
  if (!app) throw new Error('useApp needs <Shell>')
  return app
}
