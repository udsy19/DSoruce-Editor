// Program step — design: docs/design/workflow.md §3.4 (Slice 5).
//
// "State the brief": two-tier program authoring (qbiq Concept vs Detailed) that
// edits ONE `ProgramSpec` (program/spec.ts) and resolves it to the core
// `Program`. Concept fills the room counts fast (a Small/Mid/Large template or a
// headcount + enclosed-office % slider); Detailed exposes every room count and
// the per-group Window/Core/Flexible placement, plus desk type + size. A live
// summary shows enclosed rooms, seats, and occupied vs usable area.
//
// The spec is prefilled from the Space step's detected area (via the draft) and
// persisted back onto ProjectDraft.spec on every change, so a reload resumes and
// the shell's Next can read it. Advancing (owned by WizardChrome) sets the
// resolved Program on the editor via the controller, then routes to Generate.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DESK_SIZES,
  GROUP_LABELS,
  ROOM_DEFS,
  TEMPLATES,
  defaultSpec,
  deriveCounts,
  specFromHeadcount,
  specTotals,
  deskFootprint,
  type DeskSizeKey,
  type DeskType,
  type PlacementGroup,
  type ProgramSpec,
  type RoomGroup,
} from '../../program/spec'
import type { Placement, SpaceKind } from '../../editor/EditorCanvas'
import { getProject, updateDraft } from '../../persist/projects'
import { DrawingView } from '../../import/DrawingView'
import type { DrawingCanvas } from '../../import/DrawingCanvas'
import type { Drawing } from '../../import/types'
import type { Pt } from '../../import/testfit'
import { ANCHOR_KINDS, anchorKindLabel, type AnchorPin } from '../../program/anchors'
import { Icon } from '../../ui/icons'

const SF_PER_M2 = 10.7639
const PLACEMENTS: Placement[] = ['Window', 'Core', 'Flexible']
const GROUP_ORDER: RoomGroup[] = ['offices', 'team', 'conference', 'collaboration', 'amenities']
const hasPlacement = (g: RoomGroup): g is PlacementGroup =>
  g === 'offices' || g === 'team' || g === 'conference'

const fmt = (n: number) => Math.round(n).toLocaleString('en-IN')

export function ProgramStep({
  projectId,
  onReadyChange,
}: {
  projectId: string
  onReadyChange?: (ready: boolean) => void
}) {
  const [spec, setSpec] = useState<ProgramSpec | null>(null)
  const [usableM2, setUsableM2] = useState<number | null>(null)
  const hydratedRef = useRef(false)
  const readyRef = useRef(onReadyChange)
  readyRef.current = onReadyChange

  // S6 anchor pins (workflow.md §3.5) — placed on the imported plan preview.
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [areaPolygon, setAreaPolygon] = useState<Pt[] | null>(null)
  const [anchors, setAnchors] = useState<AnchorPin[]>([])
  const [anchorTool, setAnchorTool] = useState(false)
  const [anchorKind, setAnchorKind] = useState<SpaceKind>('Reception')
  const dcRef = useRef<DrawingCanvas | null>(null)
  // Live mirror so the (once-bound) canvas drop callback reads the current kind.
  const anchorKindLive = useRef(anchorKind)
  anchorKindLive.current = anchorKind

  // Resume / prefill: draft.spec if present, else derived from the detected area.
  useEffect(() => {
    let alive = true
    void getProject(projectId).then((rec) => {
      if (!alive) return
      const area = rec?.draft?.readouts?.usableAreaM2 ?? null
      setUsableM2(area)
      const s = rec?.draft?.spec ?? defaultSpec(area)
      setSpec(s)
      if (!rec?.draft?.spec) void updateDraft(projectId, { spec: s })
      if (rec?.draft?.drawing) setDrawing(rec.draft.drawing)
      if (rec?.draft?.areaPolygon) setAreaPolygon(rec.draft.areaPolygon)
      if (rec?.draft?.anchors) setAnchors(rec.draft.anchors)
      hydratedRef.current = true
      readyRef.current?.(true)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  // Persist on every change so the shell's Next reads the latest spec.
  useEffect(() => {
    if (!hydratedRef.current || !spec) return
    void updateDraft(projectId, { spec })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec])

  // Persist anchors so the shell's Next pushes the latest pins into the document.
  useEffect(() => {
    if (!hydratedRef.current) return
    void updateDraft(projectId, { anchors })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors])

  // Reflect the placed pins (+ the armed ghost's kind) on the preview canvas.
  useEffect(() => {
    dcRef.current?.setAnchors(anchors.map((a) => ({ x: a.x, y: a.y, label: anchorKindLabel(a.kind) })))
  }, [anchors])
  useEffect(() => {
    if (anchorTool) dcRef.current?.beginAnchorPlace(anchorKindLabel(anchorKind))
  }, [anchorTool, anchorKind])

  const totals = useMemo(() => (spec ? specTotals(spec) : null), [spec])
  const occupiedM2 = useMemo(() => {
    if (!spec || !totals) return 0
    const desk = deskFootprint(spec.deskSize)
    const desks = Math.max(1, Math.round(spec.headcount * 0.85))
    return totals.roomArea + desks * desk.w * desk.d
  }, [spec, totals])

  if (!spec) return <div className="program-step" data-testid="program-step" />

  const patch = (p: Partial<ProgramSpec>) => setSpec((s) => (s ? { ...s, ...p } : s))
  const applyTemplate = (headcount: number, enclosedPct: number) =>
    setSpec((s) =>
      s ? specFromHeadcount(headcount, enclosedPct, { mode: 'concept', deskType: s.deskType, deskSize: s.deskSize }) : s,
    )
  const setHeadcount = (headcount: number) =>
    setSpec((s) => (s ? { ...s, headcount, counts: deriveCounts(headcount, s.enclosedPct) } : s))
  const setEnclosed = (enclosedPct: number) =>
    setSpec((s) => (s ? { ...s, enclosedPct, counts: deriveCounts(s.headcount, enclosedPct) } : s))
  const bump = (kind: string, delta: number) =>
    setSpec((s) =>
      s ? { ...s, counts: { ...s.counts, [kind]: Math.max(0, (s.counts[kind as keyof typeof s.counts] ?? 0) + delta) } } : s,
    )
  const setPlacement = (group: PlacementGroup, placement: Placement) =>
    setSpec((s) => (s ? { ...s, placements: { ...s.placements, [group]: placement } } : s))

  // Anchor-pin handlers (workflow.md §3.5). A pin forces its room onto the plan
  // and bumps the count: it is placed FIRST by the generator, consuming one of
  // its kind's requested rooms (or adding one if none was requested).
  const handleAnchorCanvas = (c: DrawingCanvas | null) => {
    dcRef.current = c
    // No per-step dev seam — see SpaceStep: `window.__dc` resolves to the visible
    // canvas, which is this one while the user is on the Program step.
    if (!c) return
    c.onAnchorDrop = (x, y) => {
      setAnchors((prev) => [...prev, { id: crypto.randomUUID(), kind: anchorKindLive.current, x, y }])
    }
    c.setAnchors(anchors.map((a) => ({ x: a.x, y: a.y, label: anchorKindLabel(a.kind) })))
    if (areaPolygon) c.setArea(areaPolygon)
  }
  const toggleAnchorTool = () => {
    if (anchorTool) {
      dcRef.current?.cancelTool()
      setAnchorTool(false)
      return
    }
    setAnchorTool(true)
    dcRef.current?.beginAnchorPlace(anchorKindLabel(anchorKind))
  }
  const deleteAnchor = (id: string) => setAnchors((prev) => prev.filter((a) => a.id !== id))

  const usableSf = usableM2 != null ? usableM2 * SF_PER_M2 : null
  const occupiedSf = occupiedM2 * SF_PER_M2
  const pctUsed = usableSf && usableSf > 0 ? Math.min(100, (occupiedSf / usableSf) * 100) : 0
  // Pinned rooms bump the visible room tally (all anchor kinds except open
  // Collab are enclosed). The generator's max(requested, pinned) is authoritative.
  const pinnedEnclosed = anchors.filter((a) => a.kind !== 'Collab').length

  return (
    <div className="program-step" data-testid="program-step">
      {/* Concept | Detailed */}
      <div className="program-mode" role="tablist" aria-label="Program detail">
        <button
          type="button"
          role="tab"
          aria-selected={spec.mode === 'concept'}
          className={`program-mode-tab${spec.mode === 'concept' ? ' on' : ''}`}
          data-testid="program-mode-concept"
          onClick={() => patch({ mode: 'concept' })}
        >
          Concept
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={spec.mode === 'detailed'}
          className={`program-mode-tab${spec.mode === 'detailed' ? ' on' : ''}`}
          data-testid="program-mode-detailed"
          onClick={() => patch({ mode: 'detailed' })}
        >
          Detailed
        </button>
      </div>

      {/* PROGRAM BUILDER FIRST — it is this step's primary control and what the
          guide strip tells the user to do. Anchor pins (a tertiary refinement)
          follow it. They used to sit ABOVE it, pushing the templates and the
          headcount ~475px below the fold, so the step opened on a control nobody
          had been told to use. */}
      <div className="program-body">
        <div className="program-main">
          {spec.mode === 'concept' ? (
            <ConceptPanel
              spec={spec}
              onTemplate={applyTemplate}
              onHeadcount={setHeadcount}
              onEnclosed={setEnclosed}
            />
          ) : (
            <DetailedPanel spec={spec} onBump={bump} onPlacement={setPlacement} />
          )}

          {/* Desk type + size — shared by both modes. */}
          <section className="program-section">
            <div className="panel-eyebrow">Workstation</div>
            <div className="program-desk-row">
              <div className="program-field">
                <span className="program-field-label">Desk type</span>
                <div className="program-chips" data-testid="program-desk-type">
                  {(['workstation', 'bench'] as DeskType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`program-chip${spec.deskType === t ? ' on' : ''}`}
                      data-testid={`program-desk-type-${t}`}
                      aria-pressed={spec.deskType === t}
                      onClick={() => patch({ deskType: t })}
                    >
                      {t === 'workstation' ? 'Workstations' : 'Benching'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="program-field">
                <span className="program-field-label">Desk size</span>
                <div className="program-chips num" data-testid="program-desk-size">
                  {DESK_SIZES.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={`program-chip${spec.deskSize === s.key ? ' on' : ''}`}
                      data-testid={`program-desk-size-${s.key}`}
                      aria-pressed={spec.deskSize === s.key}
                      onClick={() => patch({ deskSize: s.key as DeskSizeKey })}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Live summary. */}
        <aside className="program-summary" data-testid="program-summary">
          <div className="panel-eyebrow">Program summary</div>
          <div className="program-summary-metrics">
            <div className="program-summary-metric">
              <span className="program-summary-value num" data-testid="program-summary-enclosed">
                {(totals?.enclosedRooms ?? 0) + pinnedEnclosed}
              </span>
              <span className="program-summary-label">
                enclosed rooms{pinnedEnclosed > 0 ? ` · ${pinnedEnclosed} pinned` : ''}
              </span>
            </div>
            <div className="program-summary-metric">
              <span className="program-summary-value num">
                {Math.max(1, Math.round(spec.headcount * 0.85))}
              </span>
              <span className="program-summary-label">desks</span>
            </div>
            <div className="program-summary-metric">
              <span className="program-summary-value num">{totals?.seats ?? 0}</span>
              <span className="program-summary-label">room seats</span>
            </div>
          </div>

          <div className="program-usage">
            <div className="program-usage-bar">
              <span className="program-usage-fill" style={{ width: `${pctUsed}%` }} />
            </div>
            <div className="program-usage-label num">
              {usableSf != null ? (
                <>
                  {fmt(occupiedSf)} of {fmt(usableSf)} sf used
                </>
              ) : (
                <>{fmt(occupiedM2)} m² programmed</>
              )}
            </div>
          </div>
          <p className="program-summary-note">
            Offices, meetings and desks are placed by the generator; circulation is added around
            them, so occupied area stays well below usable.
          </p>
        </aside>
      </div>

      {/* Anchor pins (workflow.md §3.5): pick a room type, click the plan to
          force that room onto the spot — it bumps the count. A refinement on top
          of the program above, so it sits below it. */}
      {drawing && (
        <section className="program-anchors" data-testid="program-anchors">
          <div className="program-anchors-head">
            <div>
              <div className="panel-eyebrow">Anchor pins · place rooms on the plan</div>
              <p className="program-summary-note">
                Optional. Pin a room type, then click the plan to force it onto that spot — the pin
                bumps its count and the generator places it first. Pins clear if you re-upload the
                plate.
              </p>
            </div>
            <div className="program-anchor-controls">
              <select
                className="program-anchor-kind num"
                data-testid="program-anchor-kind"
                value={anchorKind}
                onChange={(e) => setAnchorKind(e.target.value as SpaceKind)}
                aria-label="Room type to pin"
              >
                {ANCHOR_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`program-anchor-tool${anchorTool ? ' on' : ''}`}
                data-testid="program-anchor-tool"
                aria-pressed={anchorTool}
                onClick={toggleAnchorTool}
              >
                <Icon name="pin" size={13} /> {anchorTool ? 'Placing…' : 'Pin on plan'}
              </button>
            </div>
          </div>
          {anchorTool && (
            <p className="space-tool-hint" data-testid="program-anchor-hint">
              Click the plan to drop a <strong>{anchorKindLabel(anchorKind)}</strong> pin. Esc to stop.
            </p>
          )}
          <div className="program-anchor-plan">
            <DrawingView drawing={drawing} onCanvas={handleAnchorCanvas} />
          </div>
          {anchors.length > 0 && (
            <ul className="program-anchors-list" data-testid="program-anchors-list">
              {anchors.map((a) => (
                <li key={a.id} className="program-anchor-row" data-testid="anchor-pin">
                  <span className="program-anchor-diamond" aria-hidden />
                  <span className="program-anchor-row-kind">{anchorKindLabel(a.kind)}</span>
                  <span className="program-anchor-row-pos num">
                    {a.x.toFixed(1)}, {a.y.toFixed(1)} m
                  </span>
                  <button
                    type="button"
                    className="program-anchor-del"
                    data-testid="anchor-pin-del"
                    aria-label={`Remove ${anchorKindLabel(a.kind)} pin`}
                    onClick={() => deleteAnchor(a.id)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function ConceptPanel({
  spec,
  onTemplate,
  onHeadcount,
  onEnclosed,
}: {
  spec: ProgramSpec
  onTemplate: (headcount: number, enclosedPct: number) => void
  onHeadcount: (n: number) => void
  onEnclosed: (p: number) => void
}) {
  return (
    <div className="program-concept">
      <section className="program-section">
        <div className="panel-eyebrow">Start from a template</div>
        <div className="program-templates">
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`program-template${spec.headcount === t.headcount ? ' on' : ''}`}
              data-testid={`program-template-${t.key}`}
              onClick={() => onTemplate(t.headcount, t.enclosedPct)}
            >
              <span className="program-template-name">{t.label}</span>
              <span className="program-template-sub num">~{t.headcount} seats</span>
            </button>
          ))}
        </div>
      </section>

      <section className="program-section">
        <div className="panel-eyebrow">Or generate from a headcount</div>
        <div className="program-field">
          <span className="program-field-label">People</span>
          <input
            type="number"
            className="program-headcount num"
            data-testid="program-headcount"
            min={1}
            max={400}
            value={spec.headcount}
            onChange={(e) => onHeadcount(Math.max(1, Math.min(400, Math.round(+e.target.value || 1))))}
          />
        </div>
        <label className="program-field">
          <span className="program-field-label">
            Enclosed offices <span className="num">{spec.enclosedPct}%</span>
          </span>
          <input
            type="range"
            className="program-slider"
            data-testid="program-enclosed"
            min={0}
            max={60}
            step={5}
            value={spec.enclosedPct}
            onChange={(e) => onEnclosed(+e.target.value)}
          />
        </label>
        <p className="program-summary-note">
          Switch to <strong>Detailed</strong> to tune every room count and its Window / Core
          placement.
        </p>
      </section>
    </div>
  )
}

function DetailedPanel({
  spec,
  onBump,
  onPlacement,
}: {
  spec: ProgramSpec
  onBump: (kind: string, delta: number) => void
  onPlacement: (group: PlacementGroup, p: Placement) => void
}) {
  return (
    <div className="program-detailed">
      {GROUP_ORDER.map((group) => {
        const defs = ROOM_DEFS.filter((d) => d.group === group)
        return (
          <section key={group} className="program-section program-group" data-testid={`program-group-${group}`}>
            <div className="program-group-head">
              <div className="panel-eyebrow">{GROUP_LABELS[group]}</div>
              {hasPlacement(group) && (
                <div className="program-placement" data-testid={`program-placement-${group}`} role="group" aria-label={`${GROUP_LABELS[group]} placement`}>
                  {PLACEMENTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`program-placement-chip${spec.placements[group] === p ? ' on' : ''}`}
                      data-testid={`program-placement-${group}-${p}`}
                      aria-pressed={spec.placements[group] === p}
                      onClick={() => onPlacement(group, p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ul className="program-rooms">
              {defs.map((def) => {
                const count = spec.counts[def.kind] ?? 0
                return (
                  <li key={def.kind} className="program-room-row" data-testid={`program-room-${def.kind}`}>
                    <span className="program-room-label">
                      {def.label}
                      <span className="program-room-size num">
                        {def.w.toFixed(1)}×{def.d.toFixed(1)} m
                      </span>
                    </span>
                    <span className="program-stepper">
                      <button
                        type="button"
                        className="program-step-btn"
                        data-testid={`program-room-${def.kind}-dec`}
                        aria-label={`Fewer ${def.label}`}
                        disabled={count <= 0}
                        onClick={() => onBump(def.kind, -1)}
                      >
                        −
                      </button>
                      <span className="program-room-count num" data-testid={`program-room-${def.kind}-count`}>
                        {count}
                      </span>
                      <button
                        type="button"
                        className="program-step-btn"
                        data-testid={`program-room-${def.kind}-inc`}
                        aria-label={`More ${def.label}`}
                        onClick={() => onBump(def.kind, +1)}
                      >
                        +
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
