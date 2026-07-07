import { useState } from 'react'
import { EditorCanvas, ZoneType } from '../editor/EditorCanvas'
import { Icon } from './icons'
import { Donut } from './Donut'

const ZONE: Record<ZoneType, { fill: string; label: string }> = {
  Circulation: { fill: '#dcebfb', label: 'Circulation' },
  Workspace: { fill: '#fbf3d6', label: 'Workspace' },
  Meeting: { fill: '#e9e3f7', label: 'Meeting' },
  Collaboration: { fill: '#def1e2', label: 'Collaboration' },
  Core: { fill: '#eceef1', label: 'Core / Service' },
  ClosedOffice: { fill: '#fce6d6', label: 'Closed Office' },
  Amenity: { fill: '#d9f0ef', label: 'Amenity' },
}
const ZONE_ORDER: ZoneType[] = [
  'Workspace',
  'Meeting',
  'Collaboration',
  'ClosedOffice',
  'Amenity',
  'Circulation',
  'Core',
]

const int = (n: number) => Math.round(n).toLocaleString('en-US')

export function StatsPanel({ ec }: { ec: EditorCanvas }) {
  const [tab, setTab] = useState<'Statistics' | 'Regulations'>('Statistics')
  const [sub, setSub] = useState<'Areas' | 'Zones' | 'CO2' | 'Costs'>('Areas')

  const m = ec.getMetrics()
  const zoneStats = ec.getZoneStats()
  const nia = m.net_internal_area ?? 0

  // group zone areas by type for the donut + legend (slices sum to ~100 by tiling)
  const byType = new Map<ZoneType, number>()
  for (const z of zoneStats) byType.set(z.zone_type, (byType.get(z.zone_type) ?? 0) + z.area)
  const groups = ZONE_ORDER.filter((t) => byType.has(t)).map((t) => {
    const area = byType.get(t) ?? 0
    return { type: t, area, pct: nia > 0 ? (area / nia) * 100 : 0 }
  })
  const segments = groups.map((g) => ({ color: ZONE[g.type].fill, pct: g.pct }))

  const center =
    sub === 'CO2'
      ? int(m.indicative_carbon ?? 0)
      : sub === 'Costs'
        ? `$${int(m.indicative_cost ?? 0)}`
        : int(nia)
  const centerUnit = sub === 'CO2' ? 'kgCO₂e' : sub === 'Costs' ? 'fit-out' : 'm² NIA'

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
            <ChipTile kind="people" icon="people" value={int(m.workstations ?? 0)} label="Workstations" />
            <ChipTile kind="carbon" icon="leaf" value={int(m.indicative_carbon ?? 0)} label="kgCO₂e" />
            <ChipTile kind="cost" icon="dollar" value={`$${int(m.indicative_cost ?? 0)}`} label="Fit-out" />
          </div>

          <MetricRow label="Gross External Area" value={int(m.gross_external_area ?? 0)} unit="m²" />
          <MetricRow label="Net Internal Area" value={int(nia)} unit="m²" />
          <MetricRow label="Workstations" value={int(m.workstations ?? 0)} unit="pax" />
          <MetricRow
            label="Area / Workstation"
            value={(m.area_per_workstation ?? 0).toFixed(1)}
            unit="m²"
          />
          <MetricRow label="Efficiency" value={(m.efficiency_pct ?? 0).toFixed(0)} unit="%" />
          <MetricRow label="Carbon Footprint" value={int(m.indicative_carbon ?? 0)} unit="kgCO₂e" />
          <MetricRow label="Total Cost" value={`$${int(m.indicative_cost ?? 0)}`} unit="" />

          <div className="subtabs">
            {(['Areas', 'Zones', 'CO2', 'Costs'] as const).map((s) => (
              <button key={s} className={sub === s ? 'subtab on' : 'subtab'} onClick={() => setSub(s)}>
                {s === 'CO2' ? 'CO₂' : s}
              </button>
            ))}
          </div>

          {groups.length === 0 ? (
            <p className="panel-lead">Generate a test-fit to see the zone breakdown.</p>
          ) : (
            <>
              <Donut segments={segments} center={center} unit={centerUnit} />
              <div className="legend">
                {groups.map((g) => (
                  <div className="legend-row" key={g.type}>
                    <span className="legend-sq" style={{ background: ZONE[g.type].fill }} />
                    <span className="legend-name">{ZONE[g.type].label}</span>
                    <span className="legend-pct">{g.pct.toFixed(0)}%</span>
                    <span className="legend-area">{int(g.area)} m²</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function ChipTile({
  kind,
  icon,
  value,
  label,
}: {
  kind: string
  icon: string
  value: string
  label: string
}) {
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
