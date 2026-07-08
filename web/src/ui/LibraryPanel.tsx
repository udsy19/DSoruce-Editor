// Plan Library panel (docs/design/plan-library.md §4/§6) — purely
// presentational, like LayersPanel: no IndexedDB, no wasm. The host owns
// persistence and maps callbacks onto persist/plans + persist/history.
// History thumbnails are hover-lazy: the App supplies `renderHistoryThumb`
// (wasm scratch clone) and this panel only calls it on hover, caching per
// entry for the session.
import { useEffect, useState } from 'react'
import type { CSSProperties, FormEvent, KeyboardEvent, ReactNode } from 'react'
import { groupPlans, type SavedPlan } from '../persist/plans'
import type { HistoryEntry } from '../persist/history'
import { formatINR } from '../materialBank/client'
import { Icon } from './icons'

export interface LibraryPanelProps {
  plans: SavedPlan[]
  /** Open a saved plan in the editor (applyProject-shaped in the host). */
  onLoad: (p: SavedPlan) => void
  /** Exactly two check-selected plans, in check order. */
  onCompare: (a: SavedPlan, b: SavedPlan) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  /** Park the live document as a named SavedPlan. */
  onSaveCurrent: (name: string) => void
  history: HistoryEntry[]
  onRestore: (e: HistoryEntry) => void
  /** Hover-lazy history thumb (design §4): return a dataURL via a wasm
   *  scratch clone, or null for "no thumb". Never called unless hovered. */
  renderHistoryThumb?: (e: HistoryEntry) => string | null
  /** Download a saved plan as a portable `.dsource` file (design §6 M5). */
  onExport?: (p: SavedPlan) => void
  /**
   * Attach a plan to a project as a floor (docs/design/multi-floor.md). The
   * HOST resolves `projectName` → an existing projectId (case-insensitive) or
   * mints one via `resolveProject` in persist/plans — this panel never touches
   * persistence. Absent ⇒ the "Add to project…" affordance is hidden.
   */
  onAssign?: (planId: string, projectName: string, floorLabel: string) => void
  /** The SavedPlan currently open in the session, if any — drives the floor
   *  switcher when that plan belongs to a project. */
  current?: { planId?: string }
}

const MONO = "'IBM Plex Mono', ui-monospace, monospace"

const defaultPlanName = () =>
  `Plan ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`

/** Compact relative timestamp for plan rows ("4m ago", "2h ago", "3d ago"). */
function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })

export function LibraryPanel({
  plans,
  onLoad,
  onCompare,
  onDelete,
  onRename,
  onSaveCurrent,
  history,
  onRestore,
  renderHistoryThumb,
  onExport,
  onAssign,
  current,
}: LibraryPanelProps) {
  const [saveName, setSaveName] = useState(defaultPlanName)
  /** Check-selected plan ids, in check order (first checked = compare side A). */
  const [selected, setSelected] = useState<string[]>([])
  /** Plan id whose delete button is in its "confirm" state. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Plan id being renamed inline + its draft text. */
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  /** Plan id whose "Add to project…" form is open + its field drafts. */
  const [assigning, setAssigning] = useState<{ id: string; name: string; floor: string } | null>(
    null,
  )
  const [historyOpen, setHistoryOpen] = useState(false)
  const storageNote = useStorageNote()
  /** Hovered history entry + per-entry thumb cache (null = "renders nothing"). */
  const [hoveredAt, setHoveredAt] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({})

  const ordered = [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const entries = [...history].sort((a, b) => b.at - a.at)
  // Project grouping is DERIVED from the records (multi-floor design): real
  // projects first, ungrouped plans as a trailing flat section.
  const groups = groupPlans(ordered)
  const projects = groups.filter((g) => g.projectId !== '')
  const ungrouped = groups.find((g) => g.projectId === '')?.floors ?? []
  const currentPlan = current?.planId ? plans.find((p) => p.id === current.planId) : undefined
  const currentGroup = currentPlan?.projectId
    ? projects.find((g) => g.projectId === currentPlan.projectId)
    : undefined

  function submitSave(ev: FormEvent) {
    ev.preventDefault()
    onSaveCurrent(saveName.trim() || defaultPlanName())
    setSaveName(defaultPlanName())
  }

  function toggleSelect(id: string) {
    setSelected((sel) => (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]))
  }

  function compare() {
    const [a, b] = selected.map((id) => plans.find((p) => p.id === id))
    if (a && b) onCompare(a, b)
  }

  function commitRename() {
    if (!editing) return
    const name = editing.draft.trim()
    const plan = plans.find((p) => p.id === editing.id)
    if (name && plan && name !== plan.name) onRename(editing.id, name)
    setEditing(null)
  }

  function renameKey(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter') commitRename()
    else if (ev.key === 'Escape') setEditing(null)
  }

  function commitAssign() {
    if (!assigning || !onAssign) return
    const name = assigning.name.trim()
    if (!name) return
    onAssign(assigning.id, name, assigning.floor.trim() || 'L1')
    setAssigning(null)
  }

  function hoverEntry(e: HistoryEntry) {
    setHoveredAt(e.at)
    if (renderHistoryThumb && !(e.at in thumbs)) {
      const url = renderHistoryThumb(e)
      setThumbs((t) => ({ ...t, [e.at]: url }))
    }
  }

  /** One plan row (+ its inline assign form). `indented` = floor of a project. */
  function renderRow(p: SavedPlan, indented: boolean): ReactNode {
    const isEditing = editing?.id === p.id
    return (
      <div key={p.id}>
        <div
          data-testid="library-row"
          style={{
            ...S.row,
            ...(indented ? S.rowIndent : {}),
            background: selected.includes(p.id) ? 'var(--accent-soft, #fdf3e3)' : 'transparent',
          }}
          onMouseLeave={() => setConfirming((c) => (c === p.id ? null : c))}
        >
          <input
            type="checkbox"
            style={S.check}
            checked={selected.includes(p.id)}
            aria-label={`Select ${p.name} for compare`}
            onChange={() => toggleSelect(p.id)}
          />
          <button
            type="button"
            style={S.thumbBtn}
            title={`Open ${p.name}`}
            aria-label={`Open ${p.name}`}
            onClick={() => onLoad(p)}
          >
            <img src={p.thumb} alt="" style={S.thumbImg} draggable={false} />
          </button>
          <div style={S.main}>
            {isEditing ? (
              <input
                style={S.nameInput}
                value={editing.draft}
                autoFocus
                aria-label={`Rename ${p.name}`}
                onChange={(ev) => setEditing({ id: p.id, draft: ev.target.value })}
                onBlur={commitRename}
                onKeyDown={renameKey}
              />
            ) : (
              <span style={S.nameRow}>
                {p.floor && <span style={S.floorTag}>{p.floor.label} · </span>}
                <span
                  style={S.name}
                  title={`${p.name} — double-click to rename`}
                  onDoubleClick={() => setEditing({ id: p.id, draft: p.name })}
                >
                  {p.name}
                </span>
                <button
                  type="button"
                  style={S.tinyBtn}
                  title={`Rename ${p.name}`}
                  aria-label={`Rename ${p.name}`}
                  onClick={() => setEditing({ id: p.id, draft: p.name })}
                >
                  <PencilIcon />
                </button>
              </span>
            )}
            <span style={S.metricLine}>
              {Math.round(p.metrics.workstations)} ws · {Math.round(p.metrics.efficiencyPct)}% ·{' '}
              {formatINR(p.metrics.indicativeCost)}
            </span>
            <span style={S.ago}>{timeAgo(p.updatedAt)}</span>
          </div>
          {confirming === p.id ? (
            <button
              type="button"
              style={S.confirmBtn}
              title={`Permanently delete ${p.name}`}
              onClick={() => {
                setConfirming(null)
                onDelete(p.id)
              }}
            >
              Delete?
            </button>
          ) : (
            <>
              {onAssign && (
                <button
                  type="button"
                  style={S.tinyBtn}
                  title={`Add ${p.name} to a project…`}
                  aria-label={`Add ${p.name} to a project`}
                  data-testid="library-assign"
                  onClick={() =>
                    setAssigning((a) =>
                      a?.id === p.id
                        ? null
                        : { id: p.id, name: p.projectName ?? '', floor: p.floor?.label ?? '' },
                    )
                  }
                >
                  <FolderPlusIcon />
                </button>
              )}
              {onExport && (
                <button
                  type="button"
                  style={S.tinyBtn}
                  title={`Download ${p.name} as .dsource`}
                  aria-label={`Download ${p.name} as .dsource`}
                  data-testid="library-export"
                  onClick={() => onExport(p)}
                >
                  <DownloadIcon />
                </button>
              )}
              <button
                type="button"
                style={S.tinyBtn}
                title={`Delete ${p.name}`}
                aria-label={`Delete ${p.name}`}
                onClick={() => setConfirming(p.id)}
              >
                <TrashIcon />
              </button>
            </>
          )}
        </div>
        {assigning?.id === p.id && (
          <form
            data-testid="assign-form"
            style={{ ...S.assignForm, ...(indented ? S.rowIndent : {}) }}
            onSubmit={(ev) => {
              ev.preventDefault()
              commitAssign()
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') setAssigning(null)
            }}
          >
            <input
              data-testid="assign-name"
              style={S.assignInput}
              list="library-project-names"
              placeholder="Project name"
              aria-label="Project name"
              autoFocus
              value={assigning.name}
              onChange={(ev) => setAssigning({ ...assigning, name: ev.target.value })}
            />
            <input
              data-testid="assign-floor"
              style={S.assignFloorInput}
              placeholder="L1"
              aria-label="Floor label"
              value={assigning.floor}
              onChange={(ev) => setAssigning({ ...assigning, floor: ev.target.value })}
            />
            <button
              type="submit"
              data-testid="assign-commit"
              style={{ ...S.assignBtn, opacity: assigning.name.trim() ? 1 : 0.5 }}
              disabled={!assigning.name.trim()}
              title="Add this plan to the project as a floor"
            >
              Add
            </button>
          </form>
        )}
      </div>
    )
  }

  return (
    <div data-testid="library-panel" style={S.root}>
      {/* — Floor switcher: the open plan's project, one chip per floor — */}
      {currentGroup && currentPlan && (
        <div data-testid="floor-switcher" style={S.switcher}>
          <span style={S.switcherName} title={currentGroup.projectName}>
            {currentGroup.projectName}
          </span>
          <span style={S.switcherFloors}>
            {currentGroup.floors.map((f) => {
              const isCurrent = f.id === currentPlan.id
              return (
                <button
                  key={f.id}
                  type="button"
                  style={{ ...S.floorChip, ...(isCurrent ? S.floorChipOn : {}) }}
                  title={isCurrent ? `${f.name} (open)` : `Open ${f.name}`}
                  aria-pressed={isCurrent}
                  onClick={() => {
                    if (!isCurrent) onLoad(f)
                  }}
                >
                  {f.floor?.label ?? f.name}
                </button>
              )
            })}
          </span>
        </div>
      )}

      {/* — Save current plan — */}
      <form style={S.saveForm} onSubmit={submitSave}>
        <input
          style={S.saveInput}
          value={saveName}
          aria-label="Plan name"
          onChange={(ev) => setSaveName(ev.target.value)}
        />
        <button type="submit" data-testid="library-save" style={S.saveBtn}>
          Save current plan
        </button>
      </form>

      {/* — Saved plans — */}
      <div style={S.eyebrowRow}>
        <span style={S.eyebrow}>Saved plans</span>
        <button
          type="button"
          data-testid="library-compare"
          style={{
            ...S.compareBtn,
            ...(selected.length === 2 ? S.compareOn : S.compareOff),
          }}
          disabled={selected.length !== 2}
          title={selected.length === 2 ? 'Compare the two checked plans' : 'Check exactly two plans to compare'}
          onClick={compare}
        >
          Compare{selected.length > 0 && <span style={S.compareCount}> {selected.length}/2</span>}
        </button>
      </div>

      {ordered.length === 0 && (
        <p style={S.lead}>Nothing saved yet. Save the current plan to keep it across sessions.</p>
      )}

      {/* Existing project names as suggestions for the assign form. */}
      {onAssign && projects.length > 0 && (
        <datalist id="library-project-names">
          {projects.map((g) => (
            <option key={g.projectId} value={g.projectName} />
          ))}
        </datalist>
      )}

      {/* — Projects: header + floors (sorted by index), then ungrouped flat — */}
      {projects.map((g) => (
        <div key={g.projectId} data-testid="project-group">
          <div data-testid="project-header" style={S.projectHeader}>
            <span style={S.projectName} title={g.projectName}>
              {g.projectName}
            </span>
            <span style={S.projectCount}>
              {g.floors.length} floor{g.floors.length === 1 ? '' : 's'}
            </span>
          </div>
          {g.floors.map((p) => renderRow(p, true))}
        </div>
      ))}
      {ungrouped.map((p) => renderRow(p, false))}

      {/* — History (autosave ring, design §4) — */}
      <button
        type="button"
        data-testid="library-history-toggle"
        style={S.historyToggle}
        aria-expanded={historyOpen}
        onClick={() => setHistoryOpen((o) => !o)}
      >
        <span style={{ ...S.caret, transform: historyOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
          <Icon name="caret" size={13} />
        </span>
        <span style={S.eyebrow}>History</span>
        <span style={S.historyCount}>{entries.length}</span>
      </button>

      {historyOpen && (
        <>
          <p style={S.lead}>
            Restoring rewinds; save to library first to keep the current state forever.
          </p>
          {entries.length === 0 && (
            <p style={S.lead}>No checkpoints yet — history records your edits automatically.</p>
          )}
          {entries.map((e) => {
            const thumb = hoveredAt === e.at ? thumbs[e.at] : null
            return (
              <div
                key={e.at}
                style={S.historyRow}
                onMouseEnter={() => hoverEntry(e)}
                onMouseLeave={() => setHoveredAt((h) => (h === e.at ? null : h))}
              >
                <div style={S.historyLine}>
                  <span style={S.historyLabel}>
                    <span style={S.monoBit}>{hhmm(e.at)}</span>
                    {' · '}
                    {e.reason}
                    {' · '}
                    <span style={S.monoBit}>{e.program.desks} ws</span>
                  </span>
                  <button
                    type="button"
                    data-testid="library-restore"
                    style={S.restoreBtn}
                    title={`Restore the ${hhmm(e.at)} checkpoint`}
                    onClick={() => onRestore(e)}
                  >
                    Restore
                  </button>
                </div>
                {thumb && <img src={thumb} alt="" style={S.historyThumb} draggable={false} />}
              </div>
            )
          })}
        </>
      )}

      {storageNote && <div style={S.storageFoot}>{storageNote}</div>}
    </div>
  )
}

/** `navigator.storage.estimate()` → "2.1 MB of 120 GB used" (design §2/M5). */
function useStorageNote(): string | null {
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!navigator.storage?.estimate) return
    void navigator.storage.estimate().then((est) => {
      if (est.usage == null || est.quota == null) return
      const fmt = (b: number) =>
        b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`
      setNote(`${fmt(est.usage)} of ${fmt(est.quota)} local storage used`)
    })
  }, [])
  return note
}

function PencilIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  )
}

function FolderPlusIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  )
}

const S: Record<string, CSSProperties> = {
  root: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    color: 'var(--text, #1a1d21)',
    display: 'flex',
    flexDirection: 'column',
  },
  saveForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    paddingBottom: 14,
    borderBottom: '1px solid var(--hairline, #e6e8ec)',
    marginBottom: 12,
  },
  saveInput: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 12.5,
    padding: '6px 9px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 6,
    background: 'var(--surface-2, #fbfcfd)',
    color: 'var(--text, #1a1d21)',
    outline: 'none',
    minWidth: 0,
  },
  saveBtn: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 12.5,
    fontWeight: 600,
    padding: '7px 10px',
    border: '1px solid var(--accent, #E8A13C)',
    borderRadius: 6,
    background: 'var(--accent, #E8A13C)',
    color: 'var(--accent-ink, #ffffff)',
    cursor: 'pointer',
  },
  eyebrowRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--eyebrow, #6e7a84)',
  },
  compareBtn: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 11.5,
    fontWeight: 600,
    padding: '3px 9px',
    borderRadius: 6,
    border: '1px solid var(--hairline-strong, #d7dbe0)',
  },
  compareOn: {
    background: 'var(--accent-soft, #fdf3e3)',
    borderColor: 'var(--accent, #E8A13C)',
    color: 'var(--accent, #E8A13C)',
    cursor: 'pointer',
  },
  compareOff: {
    background: 'var(--surface, #ffffff)',
    color: 'var(--muted, #5c6670)',
    opacity: 0.6,
    cursor: 'default',
  },
  compareCount: {
    fontFamily: MONO,
    fontWeight: 600,
  },
  lead: {
    margin: '0 0 10px',
    fontSize: 12.5,
    lineHeight: 1.5,
    color: 'var(--muted, #5c6670)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 4px',
    borderRadius: 8,
    borderBottom: '1px solid var(--hairline, #e6e8ec)',
  },
  /** Floors sit indented beneath their project header. */
  rowIndent: {
    marginLeft: 14,
  },
  projectHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '10px 4px 4px',
  },
  projectName: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.02em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text, #1a1d21)',
  },
  projectCount: {
    marginLeft: 'auto',
    fontFamily: MONO,
    fontSize: 10,
    color: 'var(--muted, #9aa2ad)',
    whiteSpace: 'nowrap',
  },
  floorTag: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--accent, #E8A13C)',
    whiteSpace: 'nowrap',
    flex: 'none',
  },
  assignForm: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 4px 8px 26px',
    borderBottom: '1px solid var(--hairline, #e6e8ec)',
  },
  assignInput: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 12,
    flex: 1,
    minWidth: 0,
    padding: '4px 7px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 5,
    background: 'var(--surface-2, #fbfcfd)',
    color: 'var(--text, #1a1d21)',
    outline: 'none',
  },
  assignFloorInput: {
    fontFamily: MONO,
    fontSize: 11.5,
    width: 44,
    flex: 'none',
    padding: '4px 6px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 5,
    background: 'var(--surface-2, #fbfcfd)',
    color: 'var(--text, #1a1d21)',
    outline: 'none',
  },
  assignBtn: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 11.5,
    fontWeight: 600,
    flex: 'none',
    padding: '4px 10px',
    border: '1px solid var(--accent, #E8A13C)',
    borderRadius: 5,
    background: 'var(--accent, #E8A13C)',
    color: 'var(--accent-ink, #ffffff)',
    cursor: 'pointer',
  },
  switcher: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '2px 0 12px',
    marginBottom: 12,
    borderBottom: '1px solid var(--hairline, #e6e8ec)',
  },
  switcherName: {
    fontSize: 12,
    fontWeight: 700,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text, #1a1d21)',
  },
  switcherFloors: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    flex: 'none',
  },
  floorChip: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 7px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 5,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text-2, #3a4048)',
    cursor: 'pointer',
  },
  floorChipOn: {
    borderColor: 'var(--accent, #E8A13C)',
    background: 'var(--accent-soft, #fdf3e3)',
    color: 'var(--accent, #E8A13C)',
    cursor: 'default',
  },
  check: {
    accentColor: 'var(--accent, #E8A13C)',
    flex: 'none',
    margin: 0,
    cursor: 'pointer',
  },
  thumbBtn: {
    flex: 'none',
    padding: 0,
    border: '1px solid var(--hairline, #e6e8ec)',
    borderRadius: 5,
    background: '#f2f4f7',
    cursor: 'pointer',
    overflow: 'hidden',
    lineHeight: 0,
  },
  thumbImg: {
    display: 'block',
    width: 52,
    height: 38,
    objectFit: 'cover',
  },
  main: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  name: {
    fontSize: 13,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'text',
  },
  nameInput: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 12.5,
    fontWeight: 600,
    padding: '2px 6px',
    border: '1px solid var(--accent, #E8A13C)',
    borderRadius: 5,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text, #1a1d21)',
    outline: 'none',
    minWidth: 0,
  },
  metricLine: {
    fontFamily: MONO,
    fontSize: 10.5,
    color: 'var(--text-2, #3a4048)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  ago: {
    fontFamily: MONO,
    fontSize: 10,
    color: 'var(--muted, #9aa2ad)',
  },
  tinyBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    flex: 'none',
    border: 'none',
    background: 'transparent',
    borderRadius: 5,
    cursor: 'pointer',
    padding: 0,
    color: 'var(--muted, #5c6670)',
  },
  confirmBtn: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 11,
    fontWeight: 600,
    flex: 'none',
    padding: '3px 8px',
    border: '1px solid #c94f38',
    borderRadius: 5,
    background: 'rgba(201, 79, 56, 0.08)',
    color: '#c94f38',
    cursor: 'pointer',
  },
  historyToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    marginTop: 16,
    padding: '8px 0 8px',
    border: 'none',
    borderTop: '1px solid var(--hairline, #e6e8ec)',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  },
  caret: {
    display: 'inline-flex',
    color: 'var(--muted, #5c6670)',
    transition: 'transform 0.12s',
  },
  historyCount: {
    marginLeft: 'auto',
    fontFamily: MONO,
    fontSize: 11,
    color: 'var(--muted, #5c6670)',
  },
  historyRow: {
    padding: '4px 2px',
    borderBottom: '1px solid var(--hairline, #e6e8ec)',
  },
  historyLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  historyLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: 'var(--text-2, #3a4048)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  monoBit: {
    fontFamily: MONO,
    fontSize: 11.5,
  },
  restoreBtn: {
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
    fontSize: 11,
    fontWeight: 600,
    flex: 'none',
    padding: '2px 8px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 5,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text-2, #3a4048)',
    cursor: 'pointer',
  },
  storageFoot: {
    marginTop: 14,
    paddingTop: 8,
    borderTop: '1px solid var(--hairline, #e5e8ec)',
    fontFamily: MONO,
    fontSize: 10.5,
    color: 'var(--muted, #6b7280)',
  },
  historyThumb: {
    display: 'block',
    width: 120,
    height: 'auto',
    marginTop: 5,
    borderRadius: 4,
    border: '1px solid var(--hairline, #e6e8ec)',
    background: '#f2f4f7',
  },
}
