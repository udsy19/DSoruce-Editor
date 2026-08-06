// The qbiq LEFT SUMMARY STRIP, on screen.
//
// The reference's per-alternative page carries a rail down the left: the floor's
// measurements, headcount, open spaces, offices, conference rooms, the average
// density per person, and — at the bottom — Daylight / Privacy / Efficiency as
// ratio bars. This is that rail as a component, so the same numbers appear on
// the candidate detail and in presentation without a second derivation.
//
// EVERY VALUE COMES FROM `AltKpis` (export/kpis.ts), which is the one derivation
// the PDF report also uses. Nothing here computes a metric; it formats one. That
// is the whole reason C1 extracted the module first.

import type React from 'react'
import type { AltKpis } from '../export/kpis'

/** The three benchmarked ratios, in the reference's own order. */
const BARS = [
  { key: 'daylightPct', label: 'Daylight' },
  { key: 'privacyPct', label: 'Privacy' },
  { key: 'efficiencyPct', label: 'Efficiency' },
] as const

/**
 * Mean of one ratio across the current candidate batch — the "average" tick.
 *
 * RECOMPUTED PER BATCH, never a constant. A benchmark tick that does not move
 * when the batch changes is a decoration: it would tell the user their plan
 * beats a number nobody measured. Regenerating produces a new set and a new
 * mean, which is the only reading under which "above average" means anything.
 */
export function batchMean(kpis: readonly AltKpis[], key: (typeof BARS)[number]['key']): number | null {
  if (kpis.length < 2) return null // a mean of one is that one — no benchmark
  const vals = kpis.map((k) => k[key]).filter((v) => Number.isFinite(v))
  if (vals.length === 0) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

export interface MetricsCardProps {
  kpis: AltKpis
  /** The whole batch, for the average tick. Omit for a single plan. */
  batch?: readonly AltKpis[]
  compact?: boolean
}

/**
 * `net area · seats · open space · offices · conf rooms · density`, then the
 * three ratio bars.
 */
export function MetricsCard({ kpis, batch, compact }: MetricsCardProps) {
  const rows: Array<[string, string]> = [
    ['Net area', `${Math.round(kpis.niaM2).toLocaleString('en-IN')} m²`],
    ['Seats', String(kpis.seats)],
    ['Open space', String(kpis.openSpaceSeats)],
    ['Offices', String(kpis.offices)],
    ['Conf rooms', String(kpis.confRooms)],
    // Density is per SEAT; with no seats there is no density to state, and
    // printing 0 would read as "very dense" rather than "undefined".
    ['Density', kpis.seats > 0 ? `${kpis.densityM2.toFixed(1)} m²/person` : '—'],
  ]
  return (
    <aside className={`metrics-card${compact ? ' is-compact' : ''}`} data-testid="metrics-card">
      <dl className="metrics-card-figures">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="num">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="metrics-card-bars">
        {BARS.map(({ key, label }) => {
          const v = Math.max(0, Math.min(100, kpis[key]))
          const mean = batch ? batchMean(batch, key) : null
          return (
            <div className="metrics-bar" key={key} data-testid={`metrics-bar-${key}`}>
              <div className="metrics-bar-head">
                <span>{label}</span>
                <span className="num">{Math.round(v)}%</span>
              </div>
              <div className="metrics-bar-track">
                {/* Dynamic values ride CSS CUSTOM PROPERTIES, not an inline
                    style dictionary: appearance stays in styles.css (the
                    standing rule), and only the datum crosses the boundary. */}
                <div className="metrics-bar-fill" style={{ ["--v" as string]: `${v}%` } as React.CSSProperties} />
                {mean != null && (
                  <div
                    className="metrics-bar-tick"
                    style={{ ["--at" as string]: `${Math.max(0, Math.min(100, mean))}%` } as React.CSSProperties}
                    title={`Average across these alternatives: ${Math.round(mean)}%`}
                    data-testid={`metrics-tick-${key}`}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
