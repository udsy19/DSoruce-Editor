import { useState } from 'react'
import { EditorCanvas, ZoneType, Metrics, ZoneStat } from '../editor/EditorCanvas'
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
        <RegulationsPanel m={m} zoneStats={zoneStats} nia={nia} />
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

/* ----------------------------- Regulations ------------------------------- */

type CheckStatus = 'pass' | 'warn' | 'fail' | 'na'
interface RegCheck {
  code: string
  label: string
  value: string
  target: string
  status: CheckStatus
  note: string
}

/**
 * IBC/ADA-style plan checks derived purely from the metrics + zone stats the
 * core already exposes (getMetrics / getZoneStats). Heuristics — indicative, not
 * a stamped code review — but grounded in real thresholds so the panel is useful.
 */
function buildChecks(m: Metrics, zoneStats: ZoneStat[], nia: number): RegCheck[] {
  const workstations = m.workstations ?? 0
  const circArea = zoneStats
    .filter((z) => z.zone_type === 'Circulation')
    .reduce((s, z) => s + z.area, 0)
  const circShare = nia > 0 ? (circArea / nia) * 100 : 0
  const seated = zoneStats.reduce((s, z) => s + z.seated, 0)
  const occLoad = Math.max(seated, workstations)
  const areaPer = m.area_per_workstation ?? 0
  const eff = m.efficiency_pct ?? 0

  const band = (v: number, lo: number, hi: number): CheckStatus =>
    v >= lo && v <= hi ? 'pass' : 'warn'

  return [
    {
      code: 'IBC 1004',
      label: 'Occupant load & egress',
      value: `${occLoad} occ`,
      target: '≤ 49 for single exit',
      status: occLoad === 0 ? 'na' : occLoad <= 49 ? 'pass' : 'warn',
      note:
        occLoad === 0
          ? 'Add workstations or a test-fit to evaluate egress.'
          : occLoad <= 49
            ? 'Within single-exit occupant load for Business use.'
            : 'Over 49 occupants — two remote exits required (IBC 1006.2.1).',
    },
    {
      code: 'Space std.',
      label: 'Area per workstation',
      value: areaPer > 0 ? `${areaPer.toFixed(1)} m²` : '—',
      target: '≥ 8 m² (BCO typical)',
      status: areaPer === 0 ? 'na' : areaPer >= 8 ? 'pass' : areaPer >= 4.6 ? 'warn' : 'fail',
      note:
        areaPer === 0
          ? 'No workstations placed yet.'
          : areaPer >= 8
            ? 'Comfortable density for open-plan workspace.'
            : areaPer >= 4.6
              ? 'Dense — below the 8 m² planning guide but workable.'
              : 'Very tight — under ~4.6 m² per person.',
    },
    {
      code: 'ADA / egress',
      label: 'Circulation provision',
      value: nia > 0 ? `${circShare.toFixed(0)}%` : '—',
      target: '20–40% of NIA',
      status:
        circArea === 0 ? 'na' : circShare >= 18 && circShare <= 45 ? 'pass' : 'warn',
      note:
        circArea === 0
          ? 'No circulation zone — generate a test-fit.'
          : circShare < 18
            ? 'Low circulation share — corridors/aisles may run tight for accessible routes.'
            : circShare > 45
              ? 'High circulation share — usable area is being lost to routes.'
              : 'Healthy circulation share for accessible routes.',
    },
    {
      code: 'Fit metric',
      label: 'Space efficiency (NIA/GEA)',
      value: eff > 0 ? `${eff.toFixed(0)}%` : '—',
      target: '80–90% target',
      status: eff === 0 ? 'na' : band(eff, 75, 92),
      note:
        eff === 0
          ? 'Draw a boundary and generate to measure efficiency.'
          : eff < 75
            ? 'Below target — a lot of gross area is core/structure.'
            : eff > 92
              ? 'Unusually high — confirm the wall/core allowance is realistic.'
              : 'Efficient net-to-gross ratio.',
    },
    {
      code: 'Precondition',
      label: 'Floor plate enclosed',
      value: m.wall_count > 0 ? `${m.wall_count} walls` : 'open',
      target: 'closed boundary',
      status: m.wall_count > 0 ? 'pass' : 'fail',
      note:
        m.wall_count > 0
          ? 'A wall boundary exists — clearance checks can run.'
          : 'No boundary — draw walls (or import a plan) before code checks.',
    },
  ]
}

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: 'check',
  warn: 'warn',
  fail: 'cross',
  na: 'dash',
}

function RegulationsPanel({ m, zoneStats, nia }: { m: Metrics; zoneStats: ZoneStat[]; nia: number }) {
  const checks = buildChecks(m, zoneStats, nia)
  const active = checks.filter((c) => c.status !== 'na')
  const pass = active.filter((c) => c.status === 'pass').length
  const warn = active.filter((c) => c.status === 'warn').length
  const fail = active.filter((c) => c.status === 'fail').length

  return (
    <>
      <p className="panel-lead">
        Indicative IBC / ADA-style checks derived from the live plan. Not a stamped code review — a
        planning-stage guide; full code checks are on the roadmap.
      </p>

      <div className="reg-summary" role="status">
        <span className="reg-pill pass">{pass} pass</span>
        {warn > 0 && <span className="reg-pill warn">{warn} warn</span>}
        {fail > 0 && <span className="reg-pill fail">{fail} fail</span>}
      </div>

      <div className="reg-list">
        {checks.map((c) => (
          <div className={`reg-row ${c.status}`} key={c.label}>
            <span className={`reg-icon ${c.status}`} aria-hidden>
              <Icon name={STATUS_ICON[c.status]} size={13} />
            </span>
            <div className="reg-main">
              <div className="reg-head">
                <span className="reg-label">{c.label}</span>
                <span className="reg-value num">{c.value}</span>
              </div>
              <div className="reg-note">{c.note}</div>
              <div className="reg-meta">
                <span className="reg-code">{c.code}</span>
                <span className="reg-target num">{c.target}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
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
