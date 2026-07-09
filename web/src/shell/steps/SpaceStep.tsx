// Space step — design: docs/design/workflow.md §0/§3 (Slice 1).
//
// "Drop the floor plate": a CAD-only (DXF/DWG, decided v1 — no PDF/image)
// dropzone that drives the ALREADY-MOUNTED editor through the EditorController's
// importFile (the exact same DWG→DXF→parse path a direct import uses, so a
// wizard project reaches identical editor state), then shows the parsed plan
// plus detected readouts:
//   • usable area (m² AND sf)          — from the traced plate (best-effort boundary)
//   • bill of components               — reuse buildCategoryGroups → CategoryPlan
//   • labelled rooms                   — enclosed service cores + the plate (best-effort)
//   • detected program                 — furniture-category buckets (best-effort)
// Numbers are exact; boundaries/room labels are best-effort and say so.
//
// The parsed Drawing + a compact readouts summary are persisted onto the
// ProjectRecord.draft so a reload resumes (the editor is re-hydrated via
// loadDrawing). Advancing (Next) is owned by WizardChrome in the shell; this
// step reports readiness up via onReadyChange.

import { useEffect, useMemo, useRef, useState } from 'react'
import { DrawingView } from '../../import/DrawingView'
import { CategoryPlan, type CategoryPlanGroup } from '../../ui/CategoryPlan'
import { buildCategoryGroups, type EditorController } from '../../App'
import { extractPlate, extractKeepouts, type Pt } from '../../import/testfit'
import { restrictDrawing } from '../../import/area'
import { healWalls } from '../../import/heal'
import { ROOM_TYPES, nextRoomRef, type RoomMarker, type RoomType } from '../../import/markers'
import { bankCategoryForItem } from '../../materialBank/office'
import { getProject, updateDraft, type SpaceReadoutsSummary } from '../../persist/projects'
import { Icon } from '../../ui/icons'
import type { DrawingCanvas } from '../../import/DrawingCanvas'
import type { Drawing } from '../../import/types'

const SF_PER_M2 = 10.7639
/** Heal gap (m) persisted with the toggle — the healWalls default (a hairline
 *  partition break, below a door leaf). The Space step exposes on/off only. */
const HEAL_GAP_M = 0.25

interface DetectedRoom {
  label: string
  areaM2: number
  kind: 'floor' | 'core'
}

interface Readouts {
  usableAreaM2: number | null
  usableAreaSf: number | null
  plateMethod?: 'loop' | 'hull' | 'wrap'
  plateCoverage?: number
  bom: CategoryPlanGroup[]
  rooms: DetectedRoom[]
  program: { offices: number; conference: number; collab: number; amenities: number }
}

/** Best-effort program buckets from furniture categories (see bankCategoryForItem).
 *  Only true furniture blocks count — glazing mullions / casework / doors are
 *  building fabric, not program, and would otherwise swamp the amenities tally. */
function programBuckets(drawing: Drawing) {
  const b = { offices: 0, conference: 0, collab: 0, amenities: 0 }
  for (const f of drawing.furniture) {
    if (f.category !== 'furniture') continue
    switch (bankCategoryForItem(f)) {
      case 'desk':
      case 'workstation-bench':
        b.offices++
        break
      case 'meeting-table':
        b.conference++
        break
      case 'lounge':
      case 'side-table':
        b.collab++
        break
      case 'storage':
      case 'planter':
      case 'stool':
      case 'partition':
        b.amenities++
        break
    }
  }
  return b
}

/** Derive the full Space-step readouts from a parsed drawing. Pure (no wasm). */
function computeReadouts(drawing: Drawing): Readouts {
  const plate = extractPlate(drawing)
  const bom = buildCategoryGroups(drawing, new Map())
  const rooms: DetectedRoom[] = []

  if (plate) {
    rooms.push({ label: 'Usable floor plate', areaM2: plate.areaM2, kind: 'floor' })
    // Enclosed furniture-free rooms = service cores; try to borrow a nearby
    // CAD text label, else fall back to the generic "Core N".
    const texts = drawing.entities.filter(
      (e) => e.kind === 'text' && e.text && e.tx != null && e.ty != null,
    )
    for (const k of extractKeepouts(drawing, plate)) {
      const cx = k.x + plate.offset.x
      const cy = k.y + plate.offset.y
      const hit = texts.find(
        (t) => Math.abs((t.tx as number) - cx) <= k.w / 2 && Math.abs((t.ty as number) - cy) <= k.h / 2,
      )
      rooms.push({ label: hit?.text?.trim() || k.label, areaM2: k.w * k.h, kind: 'core' })
    }
  }

  return {
    usableAreaM2: plate ? plate.areaM2 : null,
    usableAreaSf: plate ? plate.areaM2 * SF_PER_M2 : null,
    plateMethod: plate?.method,
    plateCoverage: plate?.coverage,
    bom,
    rooms,
    program: programBuckets(drawing),
  }
}

function toSummary(r: Readouts): SpaceReadoutsSummary {
  return {
    usableAreaM2: r.usableAreaM2,
    usableAreaSf: r.usableAreaSf,
    plateMethod: r.plateMethod,
    plateCoverage: r.plateCoverage,
    componentCount: r.bom.reduce((s, g) => s + g.count, 0),
    roomCount: r.rooms.length,
    program: r.program,
    computedAt: new Date().toISOString(),
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-IN')

export function SpaceStep({
  projectId,
  controller,
  onReadyChange,
}: {
  projectId: string
  controller: React.RefObject<EditorController | null>
  onReadyChange?: (ready: boolean) => void
}) {
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // S2 area-select + S3 room markers (workflow.md §3.1/§3.2), on the preview canvas.
  const dcRef = useRef<DrawingCanvas | null>(null)
  const [areaPolygon, setAreaPolygon] = useState<Pt[] | null>(null)
  const [markers, setMarkers] = useState<RoomMarker[]>([])
  // S4 wall-heal (workflow.md §3.3): default ON (matches the reference). When on,
  // near-miss partition gaps are bridged before readouts + test-fit.
  const [healOn, setHealOn] = useState(true)
  const [activeTool, setActiveTool] = useState<'none' | 'area' | 'marker'>('none')
  const [markerType, setMarkerType] = useState<RoomType>('IT-Storage')
  const [markerRef, setMarkerRef] = useState('501')
  // Live mirrors so the (once-bound) canvas drop callback reads current values.
  const markerTypeLive = useRef(markerType)
  markerTypeLive.current = markerType
  const markerRefLive = useRef(markerRef)
  markerRefLive.current = markerRef
  const hydratedRef = useRef(false)

  const readyRef = useRef(onReadyChange)
  readyRef.current = onReadyChange

  // Resume: rehydrate the persisted draft into this step AND the live editor.
  useEffect(() => {
    let alive = true
    void getProject(projectId).then((rec) => {
      if (!alive) return
      const d = rec?.draft?.drawing ?? null
      if (d) {
        setDrawing(d)
        controller.current?.loadDrawing(d)
        readyRef.current?.(true)
      }
      if (rec?.draft?.areaPolygon) setAreaPolygon(rec.draft.areaPolygon)
      if (rec?.draft?.markers) setMarkers(rec.draft.markers)
      if (rec?.draft?.heal) setHealOn(rec.draft.heal.on)
      hydratedRef.current = true
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Readouts recompute over the RESTRICTED drawing when an area is selected —
  // furniture/entities outside the polygon drop out (usable m² falls).
  const restricted = useMemo(
    () => (drawing && areaPolygon ? restrictDrawing(drawing, areaPolygon) : drawing),
    [drawing, areaPolygon],
  )
  // S4 heal (workflow.md §3.3): bridge near-miss gaps so more rooms close cleanly
  // in the readouts (identity when off / nothing to heal — cheap to toggle).
  const healed = useMemo(
    () => (restricted && healOn ? healWalls(restricted) : restricted),
    [restricted, healOn],
  )
  const readouts = useMemo(() => (healed ? computeReadouts(healed) : null), [healed])

  // Persist area + markers + heal (and the recomputed readouts) once hydrated.
  useEffect(() => {
    if (!hydratedRef.current || !drawing) return
    void updateDraft(projectId, {
      areaPolygon: areaPolygon ?? undefined,
      markers,
      heal: { on: healOn, gapM: HEAL_GAP_M },
      ...(readouts ? { readouts: toSummary(readouts) } : {}),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaPolygon, markers, healOn])

  // Keep the "next ref" suggestion ahead of the placed markers.
  useEffect(() => {
    setMarkerRef(nextRoomRef(markers))
  }, [markers])

  // Push persisted area/markers onto the preview canvas whenever they change.
  useEffect(() => {
    dcRef.current?.setArea(areaPolygon)
  }, [areaPolygon])
  useEffect(() => {
    dcRef.current?.setMarkers(markers)
  }, [markers])

  // Re-arm the marker tool when its type/ref changes (ghost shows the next ref).
  useEffect(() => {
    if (activeTool === 'marker') dcRef.current?.beginMarkerPlace(markerType, markerRef)
  }, [activeTool, markerType, markerRef])

  // Grab the preview canvas + wire the tool callbacks (once, at mount).
  const handleCanvas = (c: DrawingCanvas | null) => {
    dcRef.current = c
    // Dev/E2E seam for the Space-step preview canvas (mirrors App's __dc/__ec).
    if (import.meta.env.DEV) (window as unknown as { __spacedc: DrawingCanvas | null }).__spacedc = c
    if (!c) return
    c.onAreaChange = (poly) => {
      setAreaPolygon(poly)
      setActiveTool('none') // committing/clearing disarms the tool
    }
    c.onMarkerDrop = (x, y) => {
      setMarkers((prev) => [
        ...prev,
        { id: crypto.randomUUID(), ref: markerRefLive.current, type: markerTypeLive.current, x, y },
      ])
    }
    c.setArea(areaPolygon)
    c.setMarkers(markers)
  }

  const toggleAreaTool = () => {
    if (activeTool === 'area') {
      dcRef.current?.cancelTool()
      setActiveTool('none')
      return
    }
    setActiveTool('area')
    dcRef.current?.beginArea()
  }
  const clearArea = () => {
    dcRef.current?.clearArea()
    setAreaPolygon(null)
    setActiveTool('none')
  }
  const toggleMarkerTool = () => {
    if (activeTool === 'marker') {
      dcRef.current?.cancelTool()
      setActiveTool('none')
      return
    }
    setActiveTool('marker')
    dcRef.current?.beginMarkerPlace(markerType, markerRef)
  }
  const deleteMarker = (id: string) => setMarkers((prev) => prev.filter((m) => m.id !== id))
  const editMarkerRef = (id: string, ref: string) =>
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, ref } : m)))
  const editMarkerType = (id: string, type: RoomType) =>
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, type } : m)))

  const accept = (file: File | undefined) => {
    if (!file || busy) return
    const name = file.name.toLowerCase()
    if (!name.endsWith('.dxf') && !name.endsWith('.dwg')) {
      setErr('CAD only for now — upload a .dxf or .dwg floor plan.')
      return
    }
    setBusy(true)
    setErr(null)
    void (async () => {
      const d = await controller.current?.importFile(file)
      if (!d) {
        setErr('Could not read that file. Check it is a valid DXF/DWG drawing.')
        setBusy(false)
        return
      }
      setDrawing(d)
      // A fresh upload supersedes any prior sub-area / markers. Use identity-
      // preserving resets: emitting a NEW [] here would fire the persist effect
      // concurrently with the awaited drawing write below and clobber it.
      setAreaPolygon((cur) => (cur === null ? cur : null))
      setMarkers((cur) => (cur.length === 0 ? cur : []))
      setActiveTool('none')
      const r = computeReadouts(d)
      // Also drop any §3.5 anchor pins — they were pinned to the OLD plate.
      await updateDraft(projectId, {
        drawing: d,
        readouts: toSummary(r),
        areaPolygon: undefined,
        markers: [],
        anchors: [],
      })
      hydratedRef.current = true
      readyRef.current?.(true)
      setBusy(false)
    })()
  }

  return (
    <div className="space-step" data-testid="space-step">
      <label
        className={`space-drop${dragOver ? ' over' : ''}${drawing ? ' compact' : ''}`}
        data-testid="space-upload"
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          accept(e.dataTransfer.files?.[0])
        }}
      >
        <span className="space-drop-glyph" aria-hidden>
          <Icon name="upload" size={drawing ? 16 : 26} />
        </span>
        <span className="space-drop-copy">
          <span className="space-drop-lead">
            {busy ? 'Reading drawing…' : drawing ? 'Replace floor plan' : 'Drop a CAD floor plan'}
          </span>
          <span className="space-drop-sub">DXF or DWG · the plate is traced from the linework</span>
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".dxf,.dwg"
          data-testid="space-upload-input"
          style={{ display: 'none' }}
          onChange={(e) => accept(e.target.files?.[0])}
        />
      </label>

      {err && (
        <div className="space-err" role="alert" data-testid="space-error">
          <Icon name="warn" size={14} /> {err}
        </div>
      )}

      {drawing && readouts && (
        <div className="space-readouts" data-testid="space-readouts">
          <div className="space-preview">
            <div className="space-tools" role="toolbar" aria-label="Plan tools">
              <button
                type="button"
                className={`space-tool${activeTool === 'area' ? ' on' : ''}`}
                data-testid="space-area-tool"
                aria-pressed={activeTool === 'area'}
                onClick={toggleAreaTool}
              >
                <Icon name="marquee" size={13} /> {areaPolygon ? 'Edit area' : 'Select area'}
              </button>
              {areaPolygon && (
                <button
                  type="button"
                  className="space-tool ghost"
                  data-testid="space-area-clear"
                  onClick={clearArea}
                >
                  <Icon name="close" size={12} /> Clear
                </button>
              )}
              <span className="space-tool-sep" aria-hidden />
              <button
                type="button"
                className={`space-tool${activeTool === 'marker' ? ' on' : ''}`}
                data-testid="space-marker-tool"
                aria-pressed={activeTool === 'marker'}
                onClick={toggleMarkerTool}
              >
                <Icon name="pin" size={13} /> Drop marker
              </button>
              {activeTool === 'marker' && (
                <>
                  <select
                    className="space-marker-select num"
                    data-testid="space-marker-type"
                    value={markerType}
                    onChange={(e) => setMarkerType(e.target.value as RoomType)}
                  >
                    {ROOM_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <input
                    className="space-marker-ref num"
                    data-testid="space-marker-ref"
                    value={markerRef}
                    onChange={(e) => setMarkerRef(e.target.value)}
                    aria-label="Room reference number"
                    size={5}
                  />
                </>
              )}
              <span className="space-tool-sep" aria-hidden />
              {/* S4 wall-heal (workflow.md §3.3): a heal / as-drawn segmented
                  toggle. Heal bridges near-miss partition gaps so more rooms
                  close cleanly in the readouts below and at test-fit. */}
              <div
                className="space-heal"
                role="group"
                aria-label="Walls"
                data-testid="space-heal-toggle"
              >
                <span className="space-heal-label">Walls</span>
                <button
                  type="button"
                  className={`space-tool${healOn ? ' on' : ''}`}
                  data-testid="space-heal-on"
                  aria-pressed={healOn}
                  onClick={() => setHealOn(true)}
                  title="Bridge near-miss partition gaps so rooms close cleanly"
                >
                  <Icon name="check" size={12} /> Heal gaps
                </button>
                <button
                  type="button"
                  className={`space-tool${!healOn ? ' on' : ''}`}
                  data-testid="space-heal-off"
                  aria-pressed={!healOn}
                  onClick={() => setHealOn(false)}
                  title="Use the linework exactly as drawn"
                >
                  As drawn
                </button>
              </div>
            </div>
            {activeTool === 'area' && (
              <p className="space-tool-hint" data-testid="space-area-hint">
                Click to lay the boundary — snaps to nearby walls. Click the first point (or
                double-click / Enter) to close, Esc to cancel.
              </p>
            )}
            {activeTool === 'marker' && (
              <p className="space-tool-hint">
                Pick a room type + number, then click the plan to drop a labelled pin.
              </p>
            )}
            <DrawingView drawing={drawing} onCanvas={handleCanvas} />
          </div>

          <div className="space-detail">
            {areaPolygon && (
              <div className="area-restricted-note" data-testid="area-restricted-note" role="status">
                <Icon name="marquee" size={13} /> Restricted to the selected area — readouts below cover
                the sub-area only.
              </div>
            )}
            <div className="space-metrics">
              <div className="space-metric">
                <span className="space-metric-label">Usable area</span>
                <span className="space-metric-value num">
                  {readouts.usableAreaM2 != null ? fmt(readouts.usableAreaM2) : '—'}
                  <span className="unit"> m²</span>
                </span>
                <span className="space-metric-sub num">
                  {readouts.usableAreaSf != null ? `${fmt(readouts.usableAreaSf)} sf` : 'no plate traced'}
                </span>
              </div>
              <div className="space-metric">
                <span className="space-metric-label">Components</span>
                <span className="space-metric-value num">
                  {fmt(readouts.bom.reduce((s, g) => s + g.count, 0))}
                </span>
                <span className="space-metric-sub">{readouts.bom.length} categories</span>
              </div>
              <div className="space-metric">
                <span className="space-metric-label">Rooms</span>
                <span className="space-metric-value num">{readouts.rooms.length}</span>
                <span className="space-metric-sub">detected</span>
              </div>
            </div>

            <p className="space-caveat">
              Counts are exact. The boundary and room labels are best-effort where the walls don't
              fully close
              {readouts.plateMethod ? ` (traced by ${readouts.plateMethod}` : ''}
              {readouts.plateMethod && readouts.plateCoverage != null
                ? `, ${Math.round(readouts.plateCoverage * 100)}% furniture coverage).`
                : readouts.plateMethod
                  ? ').'
                  : '.'}
            </p>

            <section className="space-section">
              <div className="panel-eyebrow">Detected program</div>
              <ul className="space-program">
                <li>
                  <span>Offices / desks</span>
                  <span className="num">{readouts.program.offices}</span>
                </li>
                <li>
                  <span>Conference</span>
                  <span className="num">{readouts.program.conference}</span>
                </li>
                <li>
                  <span>Collaboration</span>
                  <span className="num">{readouts.program.collab}</span>
                </li>
                <li>
                  <span>Amenities</span>
                  <span className="num">{readouts.program.amenities}</span>
                </li>
              </ul>
            </section>

            <section className="space-section" data-testid="space-markers">
              <div className="panel-eyebrow">
                Room markers{markers.length > 0 ? ` · ${markers.length}` : ''}
              </div>
              {markers.length === 0 ? (
                <p className="space-empty-note">
                  Drop markers where detection lacks context (IT room, pantry, mother's room) and give
                  each a reference number to carry into the AI + takeoff.
                </p>
              ) : (
                <ul className="space-markers-list" data-testid="space-markers-list">
                  {markers.map((m) => (
                    <li key={m.id} className="space-marker-row" data-testid="marker-pin">
                      <span className="space-marker-pin num" aria-hidden>
                        {m.ref.slice(0, 4)}
                      </span>
                      <input
                        className="space-marker-row-ref num"
                        data-testid="marker-pin-ref"
                        value={m.ref}
                        onChange={(e) => editMarkerRef(m.id, e.target.value)}
                        aria-label="Room reference"
                        size={5}
                      />
                      <select
                        className="space-marker-row-type"
                        data-testid="marker-pin-type"
                        value={m.type}
                        onChange={(e) => editMarkerType(m.id, e.target.value as RoomType)}
                      >
                        {ROOM_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="space-marker-del"
                        data-testid="marker-pin-del"
                        aria-label={`Delete marker ${m.ref}`}
                        onClick={() => deleteMarker(m.id)}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-section" data-testid="space-rooms">
              <div className="panel-eyebrow">Labelled rooms · best-effort</div>
              {readouts.rooms.length === 0 ? (
                <p className="space-empty-note">No enclosed rooms detected — the walls may not close.</p>
              ) : (
                <ul className="space-rooms-list">
                  {readouts.rooms.map((r, i) => (
                    <li key={`${r.label}-${i}`} className={`space-room ${r.kind}`}>
                      <span className="space-room-label">{r.label}</span>
                      <span className="space-room-area num">{fmt(r.areaM2)} m²</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-section" data-testid="space-bom">
              <CategoryPlan groups={readouts.bom} />
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
