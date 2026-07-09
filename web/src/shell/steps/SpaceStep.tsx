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
import { extractPlate, extractKeepouts } from '../../import/testfit'
import { bankCategoryForItem } from '../../materialBank/office'
import { getProject, updateDraft, type SpaceReadoutsSummary } from '../../persist/projects'
import { Icon } from '../../ui/icons'
import type { Drawing } from '../../import/types'

const SF_PER_M2 = 10.7639

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
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const readouts = useMemo(() => (drawing ? computeReadouts(drawing) : null), [drawing])

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
      const r = computeReadouts(d)
      await updateDraft(projectId, { drawing: d, readouts: toSummary(r) })
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
            <DrawingView drawing={drawing} />
          </div>

          <div className="space-detail">
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
