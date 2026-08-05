// Plan Library panel (docs/design/plan-library.md §4/§6) — purely
// presentational, like LayersPanel: no IndexedDB, no wasm. The host owns
// persistence and maps callbacks onto persist/plans + persist/history.
// History thumbnails are hover-lazy: the App supplies `renderHistoryThumb`
// (wasm scratch clone) and this panel only calls it on hover, caching per
// entry for the session.
import { useEffect, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
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
  /** Trigger a manual cloud sync (persist/sync.ts). Absent ⇒ no sync UI. */
  onSync?: () => void
  /** Result of the last sync run, for the status line. */
  syncState?: { at: string; pushed: number; pulled: number; error?: string } | null
  /** A sync is in flight (drives the button's disabled/"Syncing…" state). */
  syncing?: boolean
}


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

/** One-line cloud-sync status for the library header. */
function syncStatusText(
  syncing: boolean | undefined,
  s: LibraryPanelProps['syncState'],
): string {
  if (syncing) return 'Syncing…'
  if (!s) return 'Not synced yet'
  if (s.error) return 'Sync failed — will retry'
  const moved = s.pushed + s.pulled
  const detail = moved > 0 ? ` · ↑${s.pushed} ↓${s.pulled}` : ''
  return `Synced ${timeAgo(s.at)}${detail}`
}

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
  onSync,
  syncState,
  syncing,
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
          className={`lib-row${indented ? ' is-indented' : ''}${
            selected.includes(p.id) ? ' is-selected' : ''
          }`}
          onMouseLeave={() => setConfirming((c) => (c === p.id ? null : c))}
        >
          <input
            type="checkbox"
            className="lib-check"
            checked={selected.includes(p.id)}
            aria-label={`Select ${p.name} for compare`}
            onChange={() => toggleSelect(p.id)}
          />
          <button
            type="button"
            className="lib-thumb-btn"
            title={`Open ${p.name}`}
            aria-label={`Open ${p.name}`}
            onClick={() => onLoad(p)}
          >
            <img src={p.thumb} alt="" className="lib-thumb-img" draggable={false} />
          </button>
          <div className="lib-main">
            {isEditing ? (
              <input
                className="lib-name-input"
                value={editing.draft}
                autoFocus
                aria-label={`Rename ${p.name}`}
                onChange={(ev) => setEditing({ id: p.id, draft: ev.target.value })}
                onBlur={commitRename}
                onKeyDown={renameKey}
              />
            ) : (
              <span className="lib-name-row">
                {p.floor && <span className="lib-floor-tag">{p.floor.label} · </span>}
                <span
                  className="lib-name"
                  title={`${p.name} — double-click to rename`}
                  onDoubleClick={() => setEditing({ id: p.id, draft: p.name })}
                >
                  {p.name}
                </span>
                <button
                  type="button"
                  className="lib-tiny-btn"
                  title={`Rename ${p.name}`}
                  aria-label={`Rename ${p.name}`}
                  onClick={() => setEditing({ id: p.id, draft: p.name })}
                >
                  <PencilIcon />
                </button>
              </span>
            )}
            <span className="lib-metric num">
              {Math.round(p.metrics.workstations)} ws · {Math.round(p.metrics.efficiencyPct)}% ·{' '}
              {formatINR(p.metrics.indicativeCost)}
            </span>
            <span className="lib-ago num">{timeAgo(p.updatedAt)}</span>
          </div>
          {confirming === p.id ? (
            <button
              type="button"
              className="lib-confirm-btn"
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
                  className="lib-tiny-btn"
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
                  className="lib-tiny-btn"
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
                className="lib-tiny-btn"
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
            className={`lib-assign-form${indented ? ' is-indented' : ''}`}
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
              className="lib-assign-input"
              list="library-project-names"
              placeholder="Project name"
              aria-label="Project name"
              autoFocus
              value={assigning.name}
              onChange={(ev) => setAssigning({ ...assigning, name: ev.target.value })}
            />
            <input
              data-testid="assign-floor"
              className="lib-assign-floor"
              placeholder="L1"
              aria-label="Floor label"
              value={assigning.floor}
              onChange={(ev) => setAssigning({ ...assigning, floor: ev.target.value })}
            />
            <button
              type="submit"
              data-testid="assign-commit"
              className="lib-assign-btn"
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
    <div data-testid="library-panel" className="lib">
      {/* — Floor switcher: the open plan's project, one chip per floor — */}
      {currentGroup && currentPlan && (
        <div data-testid="floor-switcher" className="lib-switcher">
          <span className="lib-switcher-name" title={currentGroup.projectName}>
            {currentGroup.projectName}
          </span>
          <span className="lib-switcher-floors">
            {currentGroup.floors.map((f) => {
              const isCurrent = f.id === currentPlan.id
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`lib-floor-chip${isCurrent ? ' is-on' : ''}`}
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
      <form className="lib-save-form" onSubmit={submitSave}>
        <input
          className="lib-save-input"
          value={saveName}
          aria-label="Plan name"
          onChange={(ev) => setSaveName(ev.target.value)}
        />
        <button type="submit" data-testid="library-save" className="lib-save-btn">
          Save current plan
        </button>
      </form>

      {/* — Cloud sync (design §5): last-synced state + manual sync — */}
      {onSync && (
        <div className="lib-sync-row">
          <span
            data-testid="library-sync-status"
            className={`lib-sync-status${syncState?.error ? ' is-error' : ''}`}
            title={syncState?.error ?? 'Plans sync to your account across devices'}
          >
            <CloudIcon />
            {syncStatusText(syncing, syncState)}
          </span>
          <button
            type="button"
            data-testid="library-sync"
            className="lib-sync-btn"
            disabled={!!syncing}
            title="Sync saved plans with your account"
            onClick={onSync}
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      )}

      {/* — Saved plans — */}
      <div className="lib-eyebrow-row">
        <span className="lib-eyebrow">Saved plans</span>
        <button
          type="button"
          data-testid="library-compare"
          className={`lib-compare ${selected.length === 2 ? 'is-on' : 'is-off'}`}
          disabled={selected.length !== 2}
          title={selected.length === 2 ? 'Compare the two checked plans' : 'Check exactly two plans to compare'}
          onClick={compare}
        >
          Compare{selected.length > 0 && <span className="lib-compare-count num"> {selected.length}/2</span>}
        </button>
      </div>

      {ordered.length === 0 && (
        <p className="lib-lead">Nothing saved yet. Save the current plan to keep it across sessions.</p>
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
          <div data-testid="project-header" className="lib-project-header">
            <span className="lib-project-name" title={g.projectName}>
              {g.projectName}
            </span>
            <span className="lib-project-count num">
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
        className="lib-history-toggle"
        aria-expanded={historyOpen}
        onClick={() => setHistoryOpen((o) => !o)}
      >
        <span className={`lib-caret${historyOpen ? '' : ' is-collapsed'}`}>
          <Icon name="caret" size={13} />
        </span>
        <span className="lib-eyebrow">History</span>
        <span className="lib-history-count num">{entries.length}</span>
      </button>

      {historyOpen && (
        <>
          <p className="lib-lead">
            Restoring rewinds; save to library first to keep the current state forever.
          </p>
          {entries.length === 0 && (
            <p className="lib-lead">No checkpoints yet — history records your edits automatically.</p>
          )}
          {entries.map((e) => {
            const thumb = hoveredAt === e.at ? thumbs[e.at] : null
            return (
              <div
                key={e.at}
                className="lib-history-row"
                onMouseEnter={() => hoverEntry(e)}
                onMouseLeave={() => setHoveredAt((h) => (h === e.at ? null : h))}
              >
                <div className="lib-history-line">
                  <span className="lib-history-label">
                    <span className="lib-mono-bit num">{hhmm(e.at)}</span>
                    {' · '}
                    {e.reason}
                    {' · '}
                    <span className="lib-mono-bit num">{e.program.desks} ws</span>
                  </span>
                  <button
                    type="button"
                    data-testid="library-restore"
                    className="lib-restore-btn"
                    title={`Restore the ${hhmm(e.at)} checkpoint`}
                    onClick={() => onRestore(e)}
                  >
                    Restore
                  </button>
                </div>
                {thumb && <img src={thumb} alt="" className="lib-history-thumb" draggable={false} />}
              </div>
            )
          })}
        </>
      )}

      {storageNote && <div className="lib-storage-foot num">{storageNote}</div>}
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

function CloudIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="lib-cloud-icon">
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 9.2 4 4 0 0 0 7 17h10.5Z" />
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

