import { useState } from 'react'
import { EditorCanvas } from '../editor/EditorCanvas'
import {
  buildZones,
  buildElements,
  buildAreaSplit,
  ZONE_META,
  intFmt,
  inr,
  inrShort,
  type ZoneGroup,
  type ElementBreakdown,
} from '../editor/stats'
import { Icon } from './icons'
import { Donut } from './Donut'
import { legendEntries } from '../editor/planStyle'

export function StatsPanel({ ec }: { ec: EditorCanvas }) {
  const [tab, setTab] = useState<'Statistics' | 'Regulations'>('Statistics')
  const [sub, setSub] = useState<'Areas' | 'Zones' | 'CO2' | 'Costs'>('Areas')

  const m = ec.getMetrics()
  const zoneStats = ec.getZoneStats()
  const zones = buildZones(zoneStats)
  const nia = zones.totalArea || m.net_internal_area || 0
  const elements = buildElements(ec.getState(), nia)

  const hasFit = zones.groups.length > 0

  return (
    <div className="panel-body">
      <div className="stat-tabs">
        <button className={tab === 'Statistics' ? 'stat-tab on' : 'stat-tab'} onClick={() => setTab('Statistics')}>
          Statistics
        </button>
        <button className={tab === 'Regulations' ? 'stat-tab on' : 'stat-tab'} onClick={() => setTab('Regulations')}>
          Regulations
        </button>
      </div>

      {tab === 'Regulations' ? (
        <p className="panel-lead">
          Clearance, egress and occupancy checks run on the live plan. Min corridor and circulation
          quality come from the core evaluator; full code checks are on the roadmap.
        </p>
      ) : (
        <>
          <div className="chip-row">
            <ChipTile kind="efficiency" icon="bolt" value={`${Math.round(m.efficiency_pct ?? 0)}%`} label="Efficiency" />
            {/* Pax == Workstations by construction: zones.totalPax sums the same
                non-reference workspace `seated` desks the core's m.workstations counts
                (see stats.ts zonePax + Rust workstation_count), so this chip and the
                Workstations row below always show the identical number. */}
            <ChipTile kind="people" icon="people" value={intFmt(zones.totalPax)} label="Pax" />
            <ChipTile kind="carbon" icon="leaf" value={intFmt(elements.totalCo2)} label="kgCO₂e" />
            <ChipTile kind="cost" icon="dollar" value={inrShort(elements.totalCost)} label="Fit-out" />
          </div>

          <MetricRow label="Gross External Area" value={intFmt(m.gross_external_area ?? 0)} unit="m²" />
          <MetricRow label="Net Internal Area" value={intFmt(nia)} unit="m²" />
          <MetricRow label="Workstations" value={intFmt(m.workstations ?? 0)} unit="pax" />
          <MetricRow label="Area / Workstation" value={(m.area_per_workstation ?? 0).toFixed(1)} unit="m²" />
          <MetricRow label="Efficiency" value={(m.efficiency_pct ?? 0).toFixed(0)} unit="%" />
          <MetricRow label="Carbon Footprint" value={intFmt(elements.totalCo2)} unit="kgCO₂e" />
          <MetricRow label="Total Cost" value={inr(elements.totalCost)} unit="" />

          {hasFit && <PlanLegend ec={ec} />}

          <div className="subtabs">
            {(['Areas', 'Zones', 'CO2', 'Costs'] as const).map((s) => (
              <button key={s} className={sub === s ? 'subtab on' : 'subtab'} onClick={() => setSub(s)}>
                {s === 'CO2' ? 'CO₂' : s}
              </button>
            ))}
          </div>

          {!hasFit ? (
            <p className="panel-lead">Generate a test-fit to see the full breakdown.</p>
          ) : sub === 'Areas' ? (
            <AreasTab zones={zones} nia={nia} />
          ) : sub === 'Zones' ? (
            <ZonesTab zones={zones} />
          ) : (
            <ElementsTab elements={elements} mode={sub} />
          )}
        </>
      )}
    </div>
  )
}

/**
 * PLAN LEGEND — the swatch key for the drawing itself.
 *
 * Required by the reference grammar (spec `required_new_feature`): the plan
 * carries no in-room identification on paper output, so the colours must be
 * decodable from a key beside it. It is also the mitigation for 2e's SEMANTIC
 * FLIP — blue now means workspace where it used to mean circulation — which is
 * why it sits here, visible with the plan, rather than inside the Areas subtab
 * where the existing donut rollup lives. A key you have to go looking for does
 * not make a changed colour safe to read.
 *
 * DERIVED, never listed: `legendEntries` walks the document's actual zones, so
 * a plan with no meeting rooms shows no meeting swatch, and a zone kind added
 * to the model appears here with no change to this component. The swatch colour
 * is the same `ZONE` entry the canvas fills with — one palette, not two lists
 * that agree today.
 */
function PlanLegend({ ec }: { ec: EditorCanvas }) {
  const entries = legendEntries(ec.getState().zones ?? [])
  if (entries.length === 0) return null
  return (
    <>
      <div className="panel-eyebrow gap">Plan key</div>
      <div className="legend plan-legend">
        {entries.map((e) => (
          <div className="legend-row" key={e.kind}>
            <span
              className="legend-sq"
              style={{ background: e.fill, borderColor: e.line }}
            />
            <span className="legend-name">{ZONE_META[e.kind].label}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// ---- Areas: donut + legend rollup by room type + usable/circulation/core split ----
function AreasTab({ zones, nia }: { zones: ReturnType<typeof buildZones>; nia: number }) {
  const split = buildAreaSplit(zones)
  const hasWorkspace = zones.groups.some((g) => g.type === 'Workspace')
  return (
    <>
      <Donut segments={zones.segments} center={intFmt(nia)} unit="m² NIA" />
      <div className="legend">
        {zones.groups.map((g) => (
          <div className="legend-row" key={g.type}>
            <span className="legend-sq" style={{ background: g.fill }} />
            <span className="legend-name">{g.label}</span>
            <span className="legend-pct">{g.areaPct.toFixed(0)}%</span>
            <span className="legend-area">{intFmt(g.area)} m²</span>
          </div>
        ))}
      </div>
      <div className="bd-total">
        <span className="bd-total-label">Net Internal Area</span>
        <span className="bd-total-val">{intFmt(nia)} m²</span>
      </div>

      {/* Honest usable-vs-circulation-vs-core rollup (Laiout parity). Usable is
          the efficiency numerator — the three rows sum to NIA. */}
      <div className="split-block">
        <SplitRow label="Usable" hint="workstations · offices · meeting · collab · amenity" area={split.usable} pct={split.usablePct} tone="usable" />
        <SplitRow label="Circulation" hint="corridors · aisles" area={split.circulation} pct={split.circulationPct} tone="circ" />
        <SplitRow label="Core / Service" hint="WC · stairs · lifts · MEP" area={split.core} pct={split.corePct} tone="core" />
      </div>
      {/* This note has to track how the generator actually attributes floor.
          It used to end "only enclosed corridors count as Circulation", which
          stopped being true when open space became per-desk bands: the plan now
          emits drawn Aisle zones for the field floor no desk bank covers — 10 of
          them, 166 m² on the real plate, against 2 and 4.5 m² before. The note
          also already contradicted the Circulation row's own hint one line
          above, which reads "corridors · aisles". A panel that disagrees with
          itself about what it is measuring teaches the reader to distrust all
          of it. */}
      {hasWorkspace && (
        <p className="split-note">
          Open Workspace covers the desks and the aisles between them. Floor further than one
          workstation clearance from any desk is measured as Circulation, whether it is an
          enclosed corridor or open aisle.
        </p>
      )}
    </>
  )
}

function SplitRow({ label, hint, area, pct, tone }: { label: string; hint: string; area: number; pct: number; tone: string }) {
  return (
    <div className="split-row">
      <span className={`split-dot ${tone}`} />
      <span className="split-label">
        {label}
        <span className="split-hint">{hint}</span>
      </span>
      <span className="split-pct">{pct.toFixed(0)}%</span>
      <span className="split-area">{intFmt(area)} m²</span>
    </div>
  )
}

// ---- Zones: grouped table Count · Pax · Area · Area% ----
function ZonesTab({ zones }: { zones: ReturnType<typeof buildZones> }) {
  return (
    <div className="bd-table">
      <div className="bd-head zones">
        <span>Room type</span>
        <span className="r">Count</span>
        <span className="r">Pax</span>
        <span className="r">Area</span>
        <span className="r">%</span>
      </div>
      {zones.groups.map((g) => (
        <ZoneGroupRows key={g.type} g={g} />
      ))}
      <div className="bd-foot zones">
        <span>Total</span>
        <span className="r">{intFmt(zones.totalCount)}</span>
        <span className="r">{intFmt(zones.totalPax)}</span>
        <span className="r">{intFmt(zones.totalArea)}</span>
        <span className="r">100%</span>
      </div>
    </div>
  )
}

function ZoneGroupRows({ g }: { g: ZoneGroup }) {
  const showSub = g.rows.length > 1
  return (
    <>
      <div className="bd-row group zones">
        <span className="bd-name">
          <span className="bd-swatch" style={{ background: g.fill }} />
          {g.label}
        </span>
        <span className="r">{intFmt(g.count)}</span>
        <span className="r">{intFmt(g.pax)}</span>
        <span className="r">{intFmt(g.area)}</span>
        <span className="r">{g.areaPct.toFixed(0)}%</span>
      </div>
      {showSub &&
        g.rows.map((row) => (
          <div className="bd-row sub zones" key={row.cls}>
            <span className="bd-name sub">{sizeLabel(row.cls)}</span>
            <span className="r">{intFmt(row.count)}</span>
            <span className="r">{intFmt(row.pax)}</span>
            <span className="r">{intFmt(row.area)}</span>
            <span className="r">{row.areaPct.toFixed(0)}%</span>
          </div>
        ))}
    </>
  )
}

const sizeLabel = (cls: string) =>
  ({ S: 'Small', M: 'Medium', L: 'Large', XL: 'X-Large' })[cls] ?? cls

// ---- CO2 / Costs: donut + per-element table ----
function ElementsTab({ elements, mode }: { elements: ElementBreakdown; mode: 'CO2' | 'Costs' }) {
  const isCost = mode === 'Costs'
  const segments = isCost ? elements.costSegments : elements.co2Segments
  const total = isCost ? elements.totalCost : elements.totalCo2
  const fmt = (n: number) => (isCost ? inr(n) : intFmt(n))
  const center = isCost ? inrShort(total) : intFmt(total)
  const unit = isCost ? 'fit-out' : 'kgCO₂e'

  return (
    <>
      <Donut segments={segments} center={center} unit={unit} />
      <div className="bd-table">
        {elements.groups.map((g) => (
          <div key={g.label}>
            <div className="bd-row group">
              <span className="bd-name">
                <span className="bd-swatch" style={{ background: g.color }} />
                {g.label}
              </span>
              <span className="bd-val">{fmt(isCost ? g.cost : g.co2)}</span>
            </div>
            {g.lines.map((l) => (
              <div className="bd-row sub" key={l.label}>
                <span className="bd-name sub">{l.label}</span>
                <span className="bd-qty">
                  {l.unit === 'm' ? l.qty.toFixed(1) : intFmt(l.qty)} {l.unit}
                </span>
                <span className="bd-val">{fmt(isCost ? l.cost : l.co2)}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="bd-foot">
          <span>Total</span>
          <span className="bd-val">
            {fmt(total)}
            {!isCost && <span className="bd-unit"> kgCO₂e</span>}
          </span>
        </div>
      </div>
    </>
  )
}

function ChipTile({ kind, icon, value, label }: { kind: string; icon: string; value: string; label: string }) {
  return (
    <div className="chip-tile">
      <span className={`chip ${kind}`}>
        <Icon name={icon} size={17} />
      </span>
      {/* `.num` — every one of these is a measured quantity (a %, a headcount,
          kgCO₂e, ₹), and CLAUDE.md puts quantitative data in the numeric face.
          They were in the UI face with only tabular-nums, so the tiles read as
          labels rather than as instrument readings. */}
      <span className="chip-meta">
        <span className="chip-val num">{value}</span>
        <span className="chip-label">{label}</span>
      </span>
    </div>
  )
}

function MetricRow({ label, value, unit }: { label: string; value: string | number; unit: string }) {
  return (
    <div className="metric-row">
      <span className="label">{label}</span>
      <span className="value num">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </span>
    </div>
  )
}
