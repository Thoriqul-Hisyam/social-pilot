import { NextRequest, NextResponse } from 'next/server'
import { createGroup, deleteGroup, isGroupKind, isGroupMode, listGroups, updateGroup } from '@/lib/db'
import { hasValidSession, unauthorized } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Checks the fields a group may carry; null when they are fine. */
function invalid(g: { name?: unknown; mode?: unknown; kind?: unknown; account_ids?: unknown }, nameRequired: boolean): string | null {
  if ((nameRequired || g.name !== undefined) && (typeof g.name !== 'string' || !g.name.trim() || g.name.trim().length > 60))
    return 'name must be 1-60 characters'
  if (g.mode !== undefined && !isGroupMode(g.mode)) return 'mode must be same or split'
  if (g.kind !== undefined && !isGroupKind(g.kind)) return 'kind must be news, affiliate or all'
  if (g.account_ids !== undefined && !(Array.isArray(g.account_ids) && g.account_ids.every(Number.isInteger)))
    return 'account_ids must be a list of account ids'
  return null
}

/**
 * {name, mode?, kind?, account_ids?}: a new group. mode "same" (members post an item
 * together, the default) or "split" (at most one member posts it); kind "news",
 * "affiliate" or "all" (the default). Dashboard only.
 */
export async function POST(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const body = await request.json().catch(() => ({}))
  const error = invalid(body, true)
  if (error) return NextResponse.json({ error }, { status: 400 })
  const id = createGroup({ name: body.name.trim(), mode: body.mode, kind: body.kind, account_ids: body.account_ids })
  return NextResponse.json({ id, groups: listGroups() }, { status: 201 })
}

/** {id, name?, mode?, kind?, account_ids?}: account_ids replaces the members. */
export async function PATCH(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const body = await request.json().catch(() => ({}))
  if (typeof body.id !== 'number') return NextResponse.json({ error: 'id (number) required' }, { status: 400 })
  const error = invalid(body, false)
  if (error) return NextResponse.json({ error }, { status: 400 })
  updateGroup(body.id, { name: body.name?.trim(), mode: body.mode, kind: body.kind, account_ids: body.account_ids })
  return NextResponse.json({ ok: true })
}

/** ?id=<group>: its accounts stay. */
export async function DELETE(request: NextRequest) {
  if (!hasValidSession(request)) return unauthorized()
  const id = Number(new URL(request.url).searchParams.get('id'))
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'id required' }, { status: 400 })
  deleteGroup(id)
  return NextResponse.json({ ok: true })
}
