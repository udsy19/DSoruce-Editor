import { useState } from 'react'
import { EditorCanvas } from '../editor/EditorCanvas'
import {
  buildZones,
  buildElements,
  ZONE_META,
  intFmt,
  inr,
  inrShort,
  type ZoneGroup,
  type ElementBreakdown,
} from '../editor/stats'
import { Icon } from './icons'
import { Donut } from './Donut'

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

// ---- Areas: donut + legend rollup by room type ----
function AreasTab({ zones, nia }: { zones: ReturnType<typeof buildZones>; nia: number }) {
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
    </>
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
      <span className="chip-meta">
        <span className="chip-val">{value}</span>
        <span className="chip-label">{label}</span>
      </span>
    </div>
  )
}

function MetricRow({ label, value, unit }: { label: string; value: string | number; unit: string }) {
  return (
    <div className="metric-row">
      <span className="label">{label}</span>
      <span className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </span>
    </div>
  )
}
