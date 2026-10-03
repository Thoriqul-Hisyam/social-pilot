/**
 * Which accounts get an item that names no account, given the account groups.
 * Pure, so the whole rule is testable without a database.
 *
 * A "same" group ties its members together: they get an item all or none.
 * A "split" group lets at most one of its members get it, so they post different items.
 * An account may sit in many groups. Tied accounts form a unit; units are taken
 * in order, each one unless a split group it shares already went to an earlier unit:
 * first units that already hold the item (news queued there before, so a split
 * group never posts it twice), then the unit whose busiest member's queue ends soonest.
 * Accounts in no group are units of one and never conflict, so they always get it.
 */
export type RouteGroup = { mode: 'same' | 'split'; account_ids: number[] }

export function pickAccounts(
  candidates: number[],
  groups: RouteGroup[],
  ready: (accountId: number) => number,
  holds: (accountId: number) => boolean = () => false,
): number[] {
  const inPlay = new Set(candidates)
  const members = groups.map(g => ({ mode: g.mode, ids: g.account_ids.filter(id => inPlay.has(id)) }))

  // Units: accounts tied by same groups, merged transitively.
  const parent = new Map(candidates.map(id => [id, id]))
  const root = (id: number): number => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(id, r)
    return r
  }
  for (const g of members) if (g.mode === 'same') for (const id of g.ids.slice(1)) parent.set(root(id), root(g.ids[0]))
  const units = new Map<number, number[]>()
  for (const id of candidates) units.set(root(id), [...(units.get(root(id)) ?? []), id])

  // Each unit's split groups, and the order units are considered in.
  const splits = members.flatMap((g, i) => g.mode === 'split' && g.ids.length > 1 ? [{ i, ids: new Set(g.ids) }] : [])
  const order = [...units.values()].map(ids => ({
    ids,
    splits: splits.filter(s => ids.some(id => s.ids.has(id))).map(s => s.i),
    held: ids.some(holds),
    ready: Math.max(...ids.map(ready)),
    first: Math.min(...ids),
  })).sort((a, b) => Number(b.held) - Number(a.held) || a.ready - b.ready || a.first - b.first)

  const taken = new Set<number>()
  const picked: number[] = []
  for (const u of order) {
    if (u.splits.some(i => taken.has(i))) continue
    for (const i of u.splits) taken.add(i)
    picked.push(...u.ids)
  }
  return picked.sort((a, b) => a - b)
}
