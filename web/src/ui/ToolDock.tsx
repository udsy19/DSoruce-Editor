import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

/**
 * A single selectable tool in the dock. `id` is the EXACT tool id the editor
 * already understands (e.g. 'select', 'wall', 'cad:line', 'place:Desk') — the
 * dock never invents tools, it only groups the ones App passes in. `shortcut`
 * is a keyboard hint shown in mono (M2 owns the real key map; until it exports
 * one, App feeds the same letters the flat rail showed). `meta` is a secondary
 * descriptor (a place tool's size, 'CAD', a radius note); `swatch` tints the
 * place-tool color dot.
 */
export interface DockTool {
  id: string
  icon: string
  label: string
  shortcut?: string
  meta?: string
  swatch?: string
}

interface ToolDockProps {
  tools: DockTool[]
  active: string
  onPick: (id: string) => void
}

/** Presentational grouping — clusters existing tool ids into Rayon-style groups.
 *  This is NOT a second copy of the tool list: it only names which ids belong to
 *  which group; the icons/labels/shortcuts still come from App's CAD_RAIL/CATALOG
 *  via the passed `tools`. Any tool id not matched here falls into a trailing
 *  "More" group so nothing is ever silently dropped. */
const GROUPS: { key: string; label: string; icon: string; members: string[] }[] = [
  { key: 'select', label: 'Select', icon: 'select', members: ['select', 'cad:select'] },
  {
    key: 'draw',
    label: 'Draw',
    icon: 'line',
    members: ['wall', 'cad:line', 'cad:polyline', 'cad:rect', 'cad:circle', 'cad:arc'],
  },
  {
    key: 'place',
    label: 'Place',
    icon: 'desk',
    members: ['place:Desk', 'place:Chair', 'place:Table', 'place:MeetingRoom', 'place:FallCeiling'],
  },
  {
    key: 'measure',
    label: 'Measure',
    icon: 'dimension',
    members: ['cad:dimension', 'cad:text', 'cad:hatch'],
  },
  {
    key: 'build',
    label: 'Build',
    icon: 'door',
    members: ['cad:door', 'cad:window', 'cad:column'],
  },
  {
    key: 'modify',
    label: 'Modify',
    icon: 'move',
    members: ['cad:move', 'cad:copy', 'cad:rotate', 'cad:mirror', 'cad:scale', 'cad:trim', 'cad:extend', 'cad:fillet'],
  },
]

export function ToolDock({ tools, active, onPick }: ToolDockProps) {
  // Which group's flyout is currently revealed (hover OR click). Null = closed.
  const [open, setOpen] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const byId = new Map(tools.map((t) => [t.id, t]))
  // Build the ordered groups from whatever tools App handed us; collect anything
  // unmatched into a trailing catch-all so a new tool id never disappears.
  const claimed = new Set<string>()
  const groups = GROUPS.map((g) => {
    const members = g.members.map((id) => byId.get(id)).filter((t): t is DockTool => !!t)
    members.forEach((m) => claimed.add(m.id))
    return { ...g, members }
  }).filter((g) => g.members.length > 0)
  const leftovers = tools.filter((t) => !claimed.has(t.id))
  if (leftovers.length) {
    groups.push({ key: 'more', label: 'More', icon: 'generate', members: leftovers })
  }

  // Close on Escape and on any click outside the dock (covers touch + canvas).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDocDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDocDown)
    }
  }, [open])

  return (
    <div className="tool-dock" ref={rootRef} data-testid="tool-dock" role="toolbar" aria-label="Tools">
      {groups.map((g) => {
        const activeMember = g.members.find((m) => m.id === active)
        const isActive = !!activeMember
        const isOpen = open === g.key
        // The tile mirrors the active tool's own icon when this group holds it —
        // so the dock always shows what's live (Rayon behaviour).
        const tileIcon = activeMember?.icon ?? g.icon
        return (
          <div
            key={g.key}
            className="tdock-group"
            data-testid={`tool-group-${g.key}`}
            onMouseEnter={() => setOpen(g.key)}
            onMouseLeave={() => setOpen((k) => (k === g.key ? null : k))}
          >
            <button
              // Always reveal on click (hover may have opened it already, so a
              // toggle would immediately re-close it). Escape / click-outside /
              // hover-away / picking an item all close it.
              className={`tdock-tile${isActive ? ' on' : ''}${isOpen ? ' open' : ''}`}
              onClick={() => setOpen(g.key)}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-label={g.label}
            >
              <Icon name={tileIcon} />
              {activeMember?.swatch && (
                <span className="tdock-swatch" style={{ background: activeMember.swatch }} />
              )}
              <span className="tdock-caret" aria-hidden />
            </button>
            {isOpen && (
              <div className="tdock-flyout" role="menu" aria-label={g.label}>
                <div className="tdock-flyout-head">{g.label}</div>
                {g.members.map((t) => {
                  const on = t.id === active
                  return (
                    <div key={t.id} className="tdock-item-row" data-testid={`tool-item-${t.id}`}>
                      <button
                        className={`tdock-item${on ? ' on' : ''}`}
                        role="menuitem"
                        onClick={() => {
                          onPick(t.id)
                          setOpen(null)
                        }}
                        aria-pressed={on}
                        data-testid={t.id}
                      >
                        <span className="tdock-item-ico">
                          <Icon name={t.icon} size={17} />
                          {t.swatch && (
                            <span className="tdock-swatch" style={{ background: t.swatch }} />
                          )}
                        </span>
                        <span className="tdock-item-name">{t.label}</span>
                        {t.meta && <span className="tdock-item-meta">{t.meta}</span>}
                        {t.shortcut && <kbd className="tdock-item-key">{t.shortcut}</kbd>}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
