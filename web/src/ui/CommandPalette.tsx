import { useEffect, useMemo, useRef, useState } from 'react'
import { filterCommands, type Command, type CommandGroup } from '../editor/commands'

/** Group render order — matches the registry's Tools · View · Actions grouping. */
const GROUP_ORDER: CommandGroup[] = ['Tools', 'View', 'Actions']

/**
 * ⌘K command palette (M2). Fuzzy-filters the shared command registry as you
 * type, arrow-navigates the grouped results, Enter runs, Esc closes. The palette
 * OWNS nothing beyond selection — it calls `onRun(cmd)` and the host executes.
 *
 * Keystrokes typed here are `stopPropagation`'d so the window-level EditorCanvas
 * key handler never sees them (it would otherwise feed a live CAD tool).
 */
export function CommandPalette({
  commands,
  onRun,
  onClose,
}: {
  commands: Command[]
  onRun: (c: Command) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Flat (nav order) + grouped (render order) share one traversal so arrow keys
  // and the visual list can never disagree.
  const { ordered, groups } = useMemo(() => {
    const matched = filterCommands(commands, query)
    const byGroup = new Map<string, Command[]>()
    for (const c of matched) {
      const g = byGroup.get(c.group) ?? []
      g.push(c)
      byGroup.set(c.group, g)
    }
    const orderedOut: Command[] = []
    const groupsOut: { title: string; items: Command[] }[] = []
    const emit = (title: string) => {
      const items = byGroup.get(title)
      if (items && items.length) {
        groupsOut.push({ title, items })
        orderedOut.push(...items)
        byGroup.delete(title)
      }
    }
    GROUP_ORDER.forEach(emit)
    for (const [title] of byGroup) emit(title) // future-proof: unknown groups last
    return { ordered: orderedOut, groups: groupsOut }
  }, [commands, query])

  const count = ordered.length

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    setActive(0)
  }, [query])
  useEffect(() => {
    if (active >= count) setActive(Math.max(0, count - 1))
  }, [count, active])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (c?: Command) => {
    if (!c) return
    onRun(c)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Isolate the palette from the window-level editor/App key handlers.
    e.stopPropagation()
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(count - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(ordered[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let idx = -1
  return (
    <div className="cmdk-scrim" onMouseDown={onClose} data-testid="command-palette">
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <svg className="cmdk-search" width="15" height="15" viewBox="0 0 24 24" aria-hidden fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            data-testid="command-input"
            placeholder="Search commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search commands"
            role="combobox"
            aria-expanded
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="cmdk-hint">esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef} role="listbox" aria-label="Commands">
          {count === 0 && <div className="cmdk-empty">No commands match “{query.trim()}”.</div>}
          {groups.map((g) => (
            <div className="cmdk-group" key={g.title}>
              <div className="cmdk-group-title">{g.title}</div>
              {g.items.map((c) => {
                idx++
                const on = idx === active
                const my = idx
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={on ? 'cmdk-item on' : 'cmdk-item'}
                    data-testid="command-item"
                    data-active={on}
                    data-cmd={c.id}
                    onMouseMove={() => setActive(my)}
                    onClick={() => run(c)}
                  >
                    <span className="cmdk-item-title">{c.title}</span>
                    {c.shortcut && <span className="cmdk-item-key num">{c.shortcut}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
