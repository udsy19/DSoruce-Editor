// Node test for geometry-anchored unit inference (dxf.ts `decideUnits`).
// Run from web/:  node src/import/units.test.mjs
//
// $INSUNITS is metadata the file asserts about ITSELF, and across the
// cad-validation/ corpus it is frequently wrong — drawings declaring
// millimetres whose doors are 0.855 units wide (metres; a 1 mm door as read)
// and drawings declaring inches whose doors are 1.125 units wide (metres
// again; a 29 mm door). Those imported 25x-1000x too small, which put every
// plate candidate under the 1 m^2 floor or produced a 2-7 m^2 "office".
//
// The importer now treats the header as a CANDIDATE and the geometry as the
// judge. Per .claude/rules/gate-independence.md, a gate for that must not read
// what the importer decided — so the core assertion here is the INDEPENDENCE
// DEMONSTRATION: sabotage the producer-supplied hint every way it can be
// sabotaged (rewrite it to each legal code, to garbage, delete it entirely) and
// assert the chosen scale is BYTE-IDENTICAL. An assertion that merely "still
// passes" proves nothing; identical output proves the header was never
// consulted once a physical anchor exists.
//
// Paired with a falsification: a drawing whose doors say metres but whose
// header says millimetres must come out as metres, not as the header claims.

// @covers: web/src/import/dxf.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-units-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'dxf.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { parseDrawing } = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })

let failed = 0
let checks = 0
const ok = (cond, label) => {
  checks++
  if (!cond) {
    failed++
    console.log(`FAIL: ${label}`)
  }
}

/**
 * A synthetic plan authored in METRES: a 20 x 12 m room outline plus four door
 * swing arcs of radius 0.9 (a legal 900 mm leaf). `insunits` is the header we
 * are about to lie with.
 *
 * The room is built from a wall-layer polyline so the extent anchor has
 * something to read too, and the doors sit on a DOOR layer so the door anchor
 * finds them.
 */
function metricPlanDxf(insunitsGroup) {
  const head = ['0', 'SECTION', '2', 'HEADER']
  if (insunitsGroup !== null) head.push('9', '$INSUNITS', '70', String(insunitsGroup))
  head.push('0', 'ENDSEC')

  const ents = ['0', 'SECTION', '2', 'ENTITIES']
  // 20 x 12 m room, as four wall lines.
  const corners = [[0, 0], [20, 0], [20, 12], [0, 12]]
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i]
    const [bx, by] = corners[(i + 1) % 4]
    ents.push('0', 'LINE', '8', 'WALL', '10', String(ax), '20', String(ay), '11', String(bx), '21', String(by))
  }
  // Four 0.9 m door swings — the physical anchor.
  for (let i = 0; i < 4; i++) {
    ents.push('0', 'ARC', '8', 'DOOR', '10', String(2 + i * 4), '20', '0', '40', '0.9', '50', '0', '51', '90')
  }
  ents.push('0', 'ENDSEC', '0', 'EOF')
  return [...head, ...ents].join('\n')
}

// ---------------------------------------------------------------------------
// 1. Falsification — the defect this gate exists to catch.
//    Header says millimetres; the doors say metres. Metres must win.
// ---------------------------------------------------------------------------
{
  const d = parseDrawing(metricPlanDxf(4)) // 4 = mm
  ok(d.units === 'm', `header mm + 0.9-unit doors -> units 'm' (got '${d.units}')`)
  ok(d.unitsSource === 'door-anchor', `override is attributed to the door anchor (got '${d.unitsSource}')`)
  const w = d.bounds[2] - d.bounds[0]
  ok(Math.abs(w - 20) < 0.01, `room reads 20 m wide, not 0.02 m (got ${w.toFixed(4)})`)
}

// Same, with the other observed lie: header says inches.
{
  const d = parseDrawing(metricPlanDxf(1)) // 1 = in
  ok(d.units === 'm', `header in + 0.9-unit doors -> units 'm' (got '${d.units}')`)
  const w = d.bounds[2] - d.bounds[0]
  ok(Math.abs(w - 20) < 0.01, `room reads 20 m wide, not 0.5 m (got ${w.toFixed(4)})`)
}

// ---------------------------------------------------------------------------
// 2. A CORRECT header must be kept, and attributed to the header.
//    A fix that moves an already-correct drawing is a regression.
// ---------------------------------------------------------------------------
{
  const d = parseDrawing(metricPlanDxf(6)) // 6 = m
  ok(d.units === 'm', `correct header 'm' is kept (got '${d.units}')`)
  ok(d.unitsSource === 'header', `kept header is attributed to the header (got '${d.unitsSource}')`)
}

// ---------------------------------------------------------------------------
// 3. THE INDEPENDENCE DEMONSTRATION.
//    Sabotage the producer-supplied hint every way it can be sabotaged and
//    require BYTE-IDENTICAL output. This is what proves the header has no
//    influence left once a physical anchor exists.
// ---------------------------------------------------------------------------
//
//    One field is deliberately EXCLUDED from the comparison: `unitsSource`,
//    whose entire job is to record which path resolved the scale, so it must
//    differ ('header' when the header happened to be right, 'door-anchor' when
//    it was overridden). Everything the drawing IS — units, bounds, every
//    entity coordinate — must not. Excluding it is not a weakening: the claim
//    under test is "the header cannot influence the geometry", and the
//    excluded field carries no geometry. It is asserted separately below.
{
  const geometryOf = (code) => {
    const { unitsSource, ...rest } = parseDrawing(metricPlanDxf(code))
    return JSON.stringify(rest)
  }
  const reference = geometryOf(6)
  const sabotage = [
    ['rewritten to inches', 1],
    ['rewritten to feet', 2],
    ['rewritten to millimetres', 4],
    ['rewritten to centimetres', 5],
    ['rewritten to unitless', 0],
    ['rewritten to an out-of-range code', 99],
    ['deleted entirely', null],
  ]
  for (const [label, code] of sabotage) {
    ok(geometryOf(code) === reference, `$INSUNITS ${label}: geometry is byte-identical`)
  }

  // And the excluded field is itself constrained: it may only ever say the
  // header was confirmed, or that an anchor overrode it. It must never come
  // back 'header-unverified' on a drawing that HAS an anchor, which would mean
  // the anchor silently did not run.
  for (const [label, code] of sabotage) {
    const src = parseDrawing(metricPlanDxf(code)).unitsSource
    ok(
      src === 'header' || src === 'door-anchor',
      `$INSUNITS ${label}: provenance is header|door-anchor, never unverified (got '${src}')`,
    )
  }
}

// ---------------------------------------------------------------------------
// 4. No anchor at all -> keep the header, but SAY it is unverified.
//    A missing input must be a named failure, never a silent pass.
// ---------------------------------------------------------------------------
{
  // Two short lines, no doors, extent far too small to be a building at any
  // unit — nothing here can confirm or refute the header.
  const dxf = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'WALL', '10', '0', '20', '0', '11', '0.4', '21', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n')
  const d = parseDrawing(dxf)
  ok(d.units === 'in', `no anchor -> header kept (got '${d.units}')`)
  ok(
    d.unitsSource === 'header-unverified',
    `no anchor -> marked unverified (got '${d.unitsSource}')`,
  )
}

// ---------------------------------------------------------------------------
// 5. Hinge/hardware arcs must not be mistaken for door leaves.
//    A drawing whose only DOOR-layer arcs are 4 mm details has no usable door
//    anchor; it must fall through to the extent, not scale off the hardware.
// ---------------------------------------------------------------------------
{
  const ents = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES']
  const corners = [[0, 0], [30, 0], [30, 18], [0, 18]]
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i]
    const [bx, by] = corners[(i + 1) % 4]
    ents.push('0', 'LINE', '8', 'WALL', '10', String(ax), '20', String(ay), '11', String(bx), '21', String(by))
  }
  for (let i = 0; i < 6; i++) {
    ents.push('0', 'ARC', '8', 'DOOR', '10', String(i), '20', '0', '40', '0.004', '50', '0', '51', '90')
  }
  ents.push('0', 'ENDSEC', '0', 'EOF')
  const d = parseDrawing(ents.join('\n'))
  ok(d.units === 'm', `hardware-only door arcs do not hijack the scale (got '${d.units}')`)
  const w = d.bounds[2] - d.bounds[0]
  ok(Math.abs(w - 30) < 0.01, `room still reads 30 m wide (got ${w.toFixed(4)})`)
}

// ---------------------------------------------------------------------------
// 6. Scale CONFIDENCE — the importer must know when it does not know.
//
//    Picking the best-supported unit is not the same as picking the right one.
//    A drawing can trace a perfect boundary at 30x the true size, place
//    furniture and score well, and every area / cost / m2-per-person figure
//    below it is wrong with no outward sign. So the importer re-measures the
//    FINISHED geometry and grades itself.
// ---------------------------------------------------------------------------
{
  // Doors are real 0.9 m leaves at the chosen scale -> corroborated.
  const good = parseDrawing(metricPlanDxf(6))
  ok(
    good.scaleConfidence?.confidence === 'high',
    `a plan whose doors are door-width is high confidence (got '${good.scaleConfidence?.confidence}')`,
  )
  ok(good.scaleConfidence?.reason === '', 'a high-confidence scale carries no caveat')

  // Nothing measurable at all -> must say so rather than imply certainty.
  const blind = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'WALL', '10', '0', '20', '0', '11', '0.4', '21', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n')
  const d = parseDrawing(blind)
  ok(
    d.scaleConfidence?.confidence === 'low',
    `a plan with nothing to measure is low confidence (got '${d.scaleConfidence?.confidence}')`,
  )
  ok(
    (d.scaleConfidence?.reason ?? '').length > 0,
    'a low-confidence scale explains itself, so the user can act on it',
  )
}

console.log(failed === 0 ? `PASS (${checks} checks)` : `FAIL (${checks} checks, ${failed} failing)`)
process.exit(failed === 0 ? 0 : 1)
