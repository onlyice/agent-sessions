import { createContext } from 'react'

/**
 * Ids of Collapsible blocks that must stay open because they contain something
 * the user is being pointed at — a search match, or the text a sidebar hit
 * jumped to. A collapsed block clips its content, so a match inside one would
 * be invisible and match navigation would appear to stall on it.
 *
 * Only the blocks that actually contain a match are forced open: expanding the
 * whole transcript would reflow every message and throw away the reading
 * position on the first keystroke.
 */
export const CollapseContext = createContext<ReadonlySet<string>>(new Set<string>())

export const NO_FORCED_IDS: ReadonlySet<string> = new Set<string>()

/** Set equality, so an unchanged forced-open set keeps its identity and neither
 *  re-renders the transcript nor re-triggers the effects that depend on it. */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
