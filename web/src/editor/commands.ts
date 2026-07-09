// Command registry (M2 — command palette + real shortcuts).
//
// Rayon's "commands come to you": ONE registry is the single source for both the
// ⌘K palette and the one-letter keyboard shortcuts, so a tool can never drift
// between the two. Tool commands are DERIVED from the existing rail/catalog data
// (`buildCommands` takes them as arguments) — no second copy of the tool list.
//
// `run(ctx)` calls host callbacks passed in from App, so this module stays pure
// and UI-agnostic (no React, no DOM) — only `filterCommands` + `buildCommands`.
import type { EditorCanvas } from './EditorCanvas'
import type { CatItem } from './catalog'

/** Host callbacks a command drives — supplied by App's render scope. */
export interface CommandCtx {
  /** Activate a tool id ('select' | 'wall' | 'place:<cat>' | 'cad:<id>'). */
  setTool: (id: string) => void
  setMode: (m: '2d' | '3d' | 'import') => void
  ec: () => EditorCanvas | null
  save: () => void
  open: () => void
  /** Fire an existing UI affordance by its data-testid (opens the Export menu
   *  first for `export-*` items). Lets the palette trigger handlers owned by
   *  other components — the button IS the single source of that action. */
  fire: (testid: string) => void
}

export type CommandGroup = 'Tools' | 'View' | 'Actions'

export interface Command {
  id: string
  title: string
  /** Extra search terms (fuzzy-matched alongside the title). */
  keywords: string[]
  group: CommandGroup
  /** Display + (single letters) real key binding, e.g. 'V', '⌘S'. */
  shortcut?: string
  run: (ctx: CommandCtx) => void
}

/** Rail tool shape (a subset of App's CAD_RAIL entries — passed in, not copied). */
export interface RailTool {
  id: string
  icon: string
  label: string
  hint?: string
}

/** Single-letter tool bindings (Rayon-style). Presentation 'P' is served by
 *  EditorCanvas.onKey; App does not re-wire it (see App keydown effect). */
const TOOL_KEYS: Record<string, string> = {
  select: 'V',
  wall: 'W',
  'cad:line': 'L',
  'cad:rect': 'R',
  'cad:circle': 'C',
  'cad:arc': 'A',
  'cad:dimension': 'D',
  'cad:text': 'T',
  'cad:move': 'M',
}

/** Build the full registry from the live rail + catalog (single-sourced). */
export function buildCommands(rail: RailTool[], catalog: CatItem[]): Command[] {
  const tool = (
    id: string,
    title: string,
    keywords: string[],
    shortcut?: string,
  ): Command => ({ id: `tool:${id}`, title, keywords, group: 'Tools', shortcut, run: (c) => c.setTool(id) })

  const cmds: Command[] = [
    tool('select', 'Select', ['pointer', 'cursor', 'arrow', 'pick', 'move'], TOOL_KEYS.select),
    tool('wall', 'Wall', ['draw', 'partition', 'room', 'boundary'], TOOL_KEYS.wall),
  ]

  // CAD drafting tools — derived from the rail (skip its 'select': the doc
  // Select above is the primary one; cad:select is niche, reachable via the rail).
  for (const t of rail) {
    if (t.id === 'select') continue
    const id = `cad:${t.id}`
    const title = t.label.replace(/\s*\(.*\)\s*$/, '') // "Fillet ( [ / ] radius )" → "Fillet"
    cmds.push(tool(id, title, ['cad', 'draft', t.id], TOOL_KEYS[id]))
  }

  // Placeable furniture — derived from the catalog.
  for (const it of catalog) {
    cmds.push(
      tool(`place:${it.category}`, `Place ${it.label}`, [
        'furniture',
        'insert',
        'component',
        it.category.toLowerCase(),
      ]),
    )
  }

  // View / mode.
  cmds.push(
    { id: 'view:2d', title: '2D plan', keywords: ['view', 'plan', 'draft', 'edit'], group: 'View', run: (c) => c.setMode('2d') },
    { id: 'view:3d', title: '3D walkthrough', keywords: ['view', 'three', 'walk', 'model'], group: 'View', run: (c) => c.setMode('3d') },
    { id: 'view:plan', title: 'Imported plan', keywords: ['view', 'import', 'dwg', 'dxf', 'drawing'], group: 'View', run: (c) => c.setMode('import') },
    {
      id: 'view:presentation',
      title: 'Presentation (paper) mode',
      keywords: ['present', 'paper', 'sheet', 'publish'],
      group: 'View',
      shortcut: 'P',
      run: (c) => {
        const ec = c.ec()
        if (ec) ec.setPresentation(!ec.presentation)
      },
    },
  )

  // Actions.
  cmds.push(
    { id: 'action:generate', title: 'Generate test-fit', keywords: ['auto', 'layout', 'generate', 'ai', 'fit'], group: 'Actions', run: (c) => c.fire('generate') },
    { id: 'action:save', title: 'Save project', keywords: ['save', 'store', 'disk', 'dsource'], group: 'Actions', shortcut: '⌘S', run: (c) => c.save() },
    { id: 'action:open', title: 'Open project', keywords: ['open', 'load', 'file', 'dsource'], group: 'Actions', run: (c) => c.open() },
    { id: 'action:report', title: 'Export space-planning report', keywords: ['export', 'report', 'pdf', 'planning'], group: 'Actions', run: (c) => c.fire('export-report') },
    { id: 'action:takeoff', title: 'Export quantity takeoff', keywords: ['export', 'takeoff', 'excel', 'quantity', 'boq'], group: 'Actions', run: (c) => c.fire('export-takeoff') },
    {
      id: 'action:undo',
      title: 'Undo',
      keywords: ['undo', 'revert', 'back'],
      group: 'Actions',
      shortcut: '⌘Z',
      run: (c) => {
        const ec = c.ec()
        ec?.cad.store.undo()
        ec?.refresh()
      },
    },
  )

  return cmds
}

/** Lowercase single-letter → command map for App's global key handler. Excludes
 *  presentation ('P' is owned by EditorCanvas.onKey — re-wiring would toggle it
 *  twice). Multi-char shortcuts ('⌘S', '⌘Z') are display-only here. */
export function letterShortcuts(cmds: Command[]): Map<string, Command> {
  const m = new Map<string, Command>()
  for (const c of cmds) {
    const s = c.shortcut
    if (s && s.length === 1 && /[a-z]/i.test(s) && c.id !== 'view:presentation') {
      m.set(s.toLowerCase(), c)
    }
  }
  return m
}

/** Fuzzy score of `q` against `text` (higher = better), or null for no match.
 *  Substring hits beat subsequence hits; earlier + word-boundary hits rank up. */
function fuzzyScore(q: string, text: string): number | null {
  if (!q) return 0
  const idx = text.indexOf(q)
  if (idx >= 0) return 1000 - idx * 4 - (text.length - q.length)
  // Subsequence fallback: every char of q appears in order.
  let ti = 0
  let score = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (; ti < text.length; ti++) {
      if (text[ti] === ch) {
        found = ti
        ti++
        break
      }
    }
    if (found < 0) return null
    score += found > 0 && text[found - 1] === ' ' ? 6 : 1 // word-boundary bonus
  }
  return score
}

/** Rank commands by fuzzy relevance to `query` (title + keywords). Empty query
 *  returns the registry order untouched. */
export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return cmds
  const scored: { c: Command; s: number }[] = []
  for (const c of cmds) {
    let best = -Infinity
    for (const h of [c.title, ...c.keywords]) {
      const s = fuzzyScore(q, h.toLowerCase())
      if (s != null && s > best) best = s
    }
    if (best > -Infinity) scored.push({ c, s: best })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.map((x) => x.c)
}
