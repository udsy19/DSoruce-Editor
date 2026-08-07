/**
 * THE DIGITAL LIBRARY — the product bank, in the editor's inspector.
 *
 * Materio's premise is that a plan is a specification, not a drawing: every
 * object on it can name a real product you can buy. The bank already backed
 * ONE half of that — `ReimaginePanel` re-binds an element you have already
 * selected. This panel is the other half: browse the bank with nothing
 * selected, and STAMP a new element onto the plan from a catalogue row, bound
 * to that product from the moment it exists.
 *
 * Everything shown here is live: `searchBankLive` hits the real bank service
 * (`/api/bank/match`), so brands, supplier domains, thumbnails, ₹ prices and
 * the price PROVENANCE (basis · observation age) are the bank's, not ours. The
 * one thing the bank does not publish is dimensions — every observed row has
 * `size_mm: null` — so a placed item carries its shelf's standard footprint
 * from `BANK_FOOTPRINT`, and the card says which footprint that is rather than
 * implying the supplier specified it.
 *
 * Appearance lives in `styles.css` (`.bank-*`); state is class modifiers.
 */
import { useEffect, useMemo, useState } from 'react'
import type { EditorCanvas } from '../editor/EditorCanvas'
import type { DocComponent, DocZone, ZoneType } from '../types/doc'
import { pointInZoneShape, zoneArea, zoneBBox } from '../util/zoneGeom'
import {
  BANK_SHELVES,
  formatINR,
  priceProvenanceLine,
  searchBankLive,
  shelfFootprint,
  type BankProduct,
  type BankShelf,
} from '../materialBank/client'
import { Icon } from './icons'

/** What the panel hands back when a product is bound, so the App can mirror it
 *  into the takeoff bindings map. Structurally the subset `assignPanelProduct`
 *  reads — declared as a shape, not imported, so this panel stays free of App. */
export interface BoundProduct {
  id: string
  vendor: string
  price: number | null
  image?: string | null
  supplier?: string | null
}

/**
 * Which rooms an object of this category belongs in, best first.
 *
 * Used only to CHOOSE where to stamp — a desk lands in the open workspace, a
 * meeting table in a meeting room — so the demo does not drop furniture in a
 * corridor. It is a placement preference, not a rule: if no preferred room has
 * a free spot, the search widens to every non-ground room and then to the plate.
 */
const ROOM_AFFINITY: Record<string, ZoneType[]> = {
  Desk: ['Workspace', 'ClosedOffice'],
  Chair: ['Workspace', 'Meeting', 'ClosedOffice'],
  Table: ['Meeting', 'Collaboration', 'ClosedOffice'],
  Sofa: ['Collaboration', 'Amenity'],
  Storage: ['Workspace', 'Amenity', 'ClosedOffice'],
  Partition: ['Workspace', 'Collaboration'],
  Planter: ['Collaboration', 'Amenity', 'Workspace'],
}

const GROUND: ZoneType[] = ['Circulation', 'Unassigned']

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Axis-aligned bound of a placed component. Rotation is folded in by taking the
 *  larger extent on both axes — deliberately conservative: an over-wide bound
 *  can only make the search skip a tight spot, never overlap a real object. */
function bound(c: DocComponent): Rect {
  const s = Math.abs(Math.sin(c.rotation ?? 0)) > 0.3
  const w = s ? Math.max(c.w, c.h) : c.w
  const h = s ? Math.max(c.w, c.h) : c.h
  return { x: c.x - w / 2, y: c.y - h / 2, w, h }
}

const hits = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const CLEAR = 0.12 // m of breathing room kept around a stamped item
const STEP = 0.3 // m — placement scan resolution

/**
 * Find a free centre for a `w × h` object inside `zone`, or null.
 *
 * A deliberately local, world-metres scan rather than `export/sheetSet.placeNear`:
 * that function de-collides an ANNOTATION BOX on a sheet, in points, against a
 * candidate stack tuned to label offsets, and it must land somewhere even when
 * everything collides. This must refuse — a chair with nowhere to go should move
 * to the next room, not be forced on top of a desk. Different invariant, so a
 * separate implementation (no-bloat §1).
 */
function freeSpotIn(zone: DocZone, occ: Rect[], w: number, h: number): { x: number; y: number } | null {
  const bb = zoneBBox(zone.shape)
  const halfW = w / 2 + CLEAR
  const halfH = h / 2 + CLEAR
  if (bb.maxX - bb.minX < w + 2 * CLEAR || bb.maxY - bb.minY < h + 2 * CLEAR) return null
  // Only the occupancy that could possibly reach this room.
  const near = occ.filter(
    (r) => r.x < bb.maxX && bb.minX < r.x + r.w && r.y < bb.maxY && bb.minY < r.y + r.h,
  )
  for (let y = bb.minY + halfH; y <= bb.maxY - halfH; y += STEP) {
    for (let x = bb.minX + halfW; x <= bb.maxX - halfW; x += STEP) {
      // All four corners inside the room shape — a Poly room is not its bbox.
      if (
        !pointInZoneShape(zone.shape, x - halfW, y - halfH) ||
        !pointInZoneShape(zone.shape, x + halfW, y - halfH) ||
        !pointInZoneShape(zone.shape, x - halfW, y + halfH) ||
        !pointInZoneShape(zone.shape, x + halfW, y + halfH)
      )
        continue
      const box: Rect = { x: x - halfW, y: y - halfH, w: w + 2 * CLEAR, h: h + 2 * CLEAR }
      if (!near.some((r) => hits(box, r))) return { x, y }
    }
  }
  return null
}

interface PlaceResult {
  id: number
  room: string
}

/**
 * Stamp a bank product onto the plan and bind it, in one act.
 *
 * Order matters: `add_component` selects the new id (the core does that), which
 * would swap the inspector out from under this panel and end the browse. The
 * selection is cleared straight after, so the demo can place three items in a
 * row without the library disappearing. `assignProduct` commits, which is what
 * repaints the canvas and re-reads every metric — including the element count.
 */
function placeFromBank(
  ec: EditorCanvas,
  shelf: BankShelf,
  p: BankProduct,
): PlaceResult | null {
  const [w, h] = shelfFootprint(shelf)
  const state = ec.getState()
  const occ = (state.components ?? []).map(bound)
  const zones = (state.zones ?? []).filter((z) => !GROUND.includes(z.zone_type))
  const wanted = ROOM_AFFINITY[shelf.docCategory] ?? []
  // Preferred rooms first (in affinity order), then every other real room —
  // largest first inside each tier, because a big room is likeliest to have room.
  const byArea = (a: DocZone, b: DocZone) => zoneArea(b.shape) - zoneArea(a.shape)
  const tiers: DocZone[][] = wanted.map((t) => zones.filter((z) => z.zone_type === t).sort(byArea))
  tiers.push(zones.filter((z) => !wanted.includes(z.zone_type)).sort(byArea))

  for (const tier of tiers) {
    for (const z of tier) {
      const spot = freeSpotIn(z, occ, w, h)
      if (!spot) continue
      const id = ec.ed.add_component(shelf.docCategory, spot.x, spot.y, w, h)
      ec.ed.clear_selection()
      ec.assignProduct(id, p.id, p.name, p.price)
      return { id, room: z.label }
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */

export function BankPanel({
  ec,
  onBound,
}: {
  ec: EditorCanvas
  onBound: (p: BoundProduct) => void
}) {
  const [shelf, setShelf] = useState<BankShelf>(BANK_SHELVES[0])
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<BankProduct[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'live' | 'offline'>('loading')
  const [pricedOnly, setPricedOnly] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    const query = q.trim() || shelf.query
    const t = window.setTimeout(
      () => {
        searchBankLive(query, 24)
          .then((r) => {
            if (cancelled) return
            setRows(r)
            setStatus('live')
          })
          .catch(() => {
            if (cancelled) return
            setRows(null)
            setStatus('offline')
          })
      },
      q ? 250 : 0,
    )
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [q, shelf])

  // Priced rows first. This is a DISPLAY ORDER over what the bank returned —
  // no row is added, removed or repriced; an unpriced product still says so.
  const shown = useMemo(() => {
    const list = rows ?? []
    const kept = pricedOnly ? list.filter((p) => p.price != null) : list
    return [...kept].sort((a, b) => (a.price == null ? 1 : 0) - (b.price == null ? 1 : 0))
  }, [rows, pricedOnly])

  const pricedCount = (rows ?? []).filter((p) => p.price != null).length
  const [fw, fh] = shelfFootprint(shelf)

  const add = (p: BankProduct) => {
    const r = placeFromBank(ec, shelf, p)
    if (!r) {
      setNote({ ok: false, text: 'No free floor left in a suitable room — clear space and retry.' })
      return
    }
    onBound({ id: p.id, vendor: p.vendor, price: p.price, image: p.image, supplier: p.supplier })
    setNote({
      ok: true,
      text: `${p.name} placed in ${r.room} · ${ec.getMetrics().component_count} elements`,
    })
  }

  return (
    <div className="panel-body bank-panel" data-testid="bank-panel">
      <div className="panel-eyebrow">
        <Icon name="layers" size={14} /> Product bank
      </div>
      <p className="panel-lead">
        Pick a shelf, then <strong>Add</strong> to place that product on the plan — it lands in a
        matching room, already specified.
      </p>

      <div className="bank-shelves" role="tablist" aria-label="Bank shelves">
        {BANK_SHELVES.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={s.key === shelf.key}
            className={s.key === shelf.key ? 'bank-shelf is-active' : 'bank-shelf'}
            data-testid={`bank-shelf-${s.key}`}
            onClick={() => {
              setShelf(s)
              setNote(null)
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <input
        className="search"
        placeholder={`Search the bank — ${shelf.query}`}
        aria-label="Search the material bank"
        value={q}
        data-testid="bank-search"
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="bank-bar">
        <span className="bank-foot num">
          {fw.toFixed(2)} × {fh.toFixed(2)} m
        </span>
        <span className="bank-foot-note">standard footprint</span>
        <span className="bank-spring" />
        <button
          className={pricedOnly ? 'bank-filter is-active' : 'bank-filter'}
          aria-pressed={pricedOnly}
          data-testid="bank-priced-only"
          onClick={() => setPricedOnly((v) => !v)}
        >
          Priced only
        </button>
      </div>

      {note && (
        <div className={note.ok ? 'bank-note is-ok' : 'bank-note is-warn'} role="status" data-testid="bank-note">
          <Icon name={note.ok ? 'check' : 'warn'} size={14} />
          <span>{note.text}</span>
        </div>
      )}

      <div className="bank-grid">
        {status === 'loading' && shown.length === 0 && (
          <div className="inline-note">Searching the bank…</div>
        )}
        {status !== 'loading' && shown.length === 0 && (
          <div className="inline-note">No matches on this shelf.</div>
        )}
        {shown.map((p) => (
          <BankCard key={p.id} p={p} onAdd={() => add(p)} />
        ))}
      </div>

      {status === 'offline' ? (
        <div className="mock-note">Bank offline — reconnect to browse the live catalogue.</div>
      ) : (
        <div className="mock-note">
          Live material bank · <span className="num">{rows?.length ?? 0}</span> results ·{' '}
          <span className="num">{pricedCount}</span> with an observed ₹ price. Unpriced rows are
          spec-only suppliers and show an em dash, never a guess.
        </div>
      )}
    </div>
  )
}

function BankCard({ p, onAdd }: { p: BankProduct; onAdd: () => void }) {
  const prov = priceProvenanceLine(p.provenance)
  return (
    <div className="bank-card" data-testid="bank-card">
      {p.image ? (
        <img className="bank-thumb" src={p.image} alt="" loading="lazy" />
      ) : (
        <span className="bank-thumb is-empty" aria-hidden />
      )}
      <div className="bank-body">
        <div className="bank-name" title={p.name}>
          {p.name}
        </div>
        <div className="bank-vendor">
          {p.vendor}
          {p.supplier ? ` · ${p.supplier}` : ''}
        </div>
        <div className="bank-price-row">
          <span className={p.price == null ? 'bank-price num is-spec' : 'bank-price num'}>
            {formatINR(p.price)}
          </span>
          {prov ? (
            <span className="bank-prov">{prov}</span>
          ) : p.price == null ? (
            <span className="bank-prov">spec only</span>
          ) : null}
        </div>
      </div>
      <button className="bank-add" onClick={onAdd} data-testid="bank-add" title="Place on the plan">
        Add
      </button>
    </div>
  )
}
