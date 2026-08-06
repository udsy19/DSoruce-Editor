// CAD validation harness — runs the REAL production import pipeline over a
// corpus of .dwg files, headlessly, and writes one JSON report per file.
//
// It reproduces exactly what App.tsx does on import + test-fit:
//   dwg2dxf (same binary the /api/dwg middleware shells out to)
//     → parseDrawing            (import/dxf.ts)
//     → healWalls               (import/heal.ts)
//     → derivePlate/extractPlate(import/plate.ts, import/testfit.ts)
//     → assessPlate             (import/plateQuality.ts)
//     → extractKeepouts / extractEntries / extractInteriorWalls (import/testfit.ts)
//     → normalizeFurniture      (import/normalize.ts)
//
// It reads NO producer-supplied summary of what the importer thinks it did:
// every number below is re-derived from the parsed geometry or the DXF bytes.
//
// Usage:  node cad-validation/harness/run.mjs [--only <substr>]

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const importDir = path.join(root, 'web/src/import')
const outDir = path.join(root, 'cad-validation/reports')
fs.mkdirSync(outDir, { recursive: true })

// ---------- bundle the production TS modules for node (same trick as dxf.test.mjs)
const webRequire = createRequire(path.join(root, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const bundle = async (entry) => {
  const outFile = path.join(os.tmpdir(), `cadval-${path.basename(entry, '.ts')}-${process.pid}.mjs`)
  await build({
    entryPoints: [path.join(importDir, entry)],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(outFile).href)
  fs.rmSync(outFile, { force: true })
  return mod
}

const { parseDrawing } = await bundle('dxf.ts')
const { healWalls } = await bundle('heal.ts')
const { derivePlate } = await bundle('plate.ts')
const testfit = await bundle('testfit.ts')
const { normalizeFurniture, inferCategory } = await bundle('normalize.ts')

// ---------- corpus
const CORPUS = JSON.parse(fs.readFileSync(path.join(here, 'corpus.json'), 'utf8'))
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null

// ---------- independent re-derivation helpers (no producer metadata)

/** Read the DXF header's own $INSUNITS + $EXTMIN/$EXTMAX straight from the
 *  bytes, so we can check the importer's unit inference against the file
 *  rather than against itself. */
function dxfHeaderFacts(dxfText) {
  const val = (name, code) => {
    const i = dxfText.indexOf(`\n${name}\n`)
    if (i < 0) return null
    const tail = dxfText.slice(i, i + 400).split('\n')
    for (let k = 1; k < tail.length - 1; k++) {
      if (tail[k].trim() === String(code)) return Number(tail[k + 1])
    }
    return null
  }
  const insunits = val('$INSUNITS', 70)
  const UNIT = {
    0: 'unitless', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 8: 'microinch',
    9: 'mil', 10: 'yd', 11: 'angstrom', 12: 'nm', 13: 'micron', 14: 'dm',
    15: 'dam', 16: 'hm', 17: 'gm', 18: 'au', 19: 'ly', 20: 'pc',
  }
  return {
    insunitsCode: insunits,
    insunitsLabel: insunits == null ? null : (UNIT[insunits] ?? `code-${insunits}`),
    extmin: [val('$EXTMIN', 10), val('$EXTMIN', 20)],
    extmax: [val('$EXTMAX', 10), val('$EXTMAX', 20)],
    // raw entity-section census straight from the group codes
    entityCounts: countDxfEntities(dxfText),
  }
}

function countDxfEntities(dxfText) {
  const lines = dxfText.split('\n')
  const counts = {}
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].trim() === '0') {
      const t = lines[i + 1].trim()
      if (/^[A-Z][A-Z0-9_]*$/.test(t)) counts[t] = (counts[t] || 0) + 1
    }
  }
  return counts
}

/** Polygon area from the ring itself — never read from PlateResult.areaM2. */
function ringArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return Math.abs(a) / 2
}

function pointInRing(p, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Re-derive furniture containment from the boundary + the furniture bboxes,
 *  instead of trusting PlateResult.coverage. */
function recomputeCoverage(plate, drawing) {
  if (!drawing.furniture.length) return null
  const ring = plate.boundary
  let inside = 0
  for (const f of drawing.furniture) {
    const cx = (f.bbox[0] + f.bbox[2]) / 2 - plate.offset.x
    const cy = (f.bbox[1] + f.bbox[3]) / 2 - plate.offset.y
    if (pointInRing([cx, cy], ring)) inside++
  }
  return inside / drawing.furniture.length
}

function entityStats(drawing) {
  const byCat = {}
  const byKind = {}
  let degenerate = 0
  let nonFinite = 0
  let huge = 0
  for (const e of drawing.entities) {
    byCat[e.category] = (byCat[e.category] || 0) + 1
    byKind[e.kind] = (byKind[e.kind] || 0) + 1
    if (e.pts) {
      if (e.pts.length < 2) degenerate++
      for (const [x, y] of e.pts) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) nonFinite++
        else if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) huge++
      }
    }
    if (e.kind === 'circle' || e.kind === 'arc') {
      if (!Number.isFinite(e.cx) || !Number.isFinite(e.cy) || !Number.isFinite(e.r)) nonFinite++
    }
  }
  return { byCat, byKind, degenerate, nonFinite, huge }
}

function bboxSpan(b) {
  return b ? [b[2] - b[0], b[3] - b[1]] : null
}

// ---------- per-file run
function runOne(entry) {
  const rec = {
    file: entry.label,
    src: entry.path,
    bytes: null,
    stages: {},
    errors: [],
    warnings: [],
  }
  const t0 = Date.now()
  try {
    rec.bytes = fs.statSync(entry.path).size
  } catch (e) {
    rec.errors.push({ stage: 'stat', message: String(e.message || e) })
    return rec
  }

  // --- stage 1: DWG → DXF (exactly what /api/dwg does)
  const dxfPath = path.join(os.tmpdir(), `cadval-${process.pid}-${Math.abs(hash(entry.label))}.dxf`)
  let dxfText = null
  const t1 = Date.now()
  try {
    if (entry.path.toLowerCase().endsWith('.dwg')) {
      let stderr = ''
      try {
        execFileSync('dwg2dxf', ['-o', dxfPath, entry.path], {
          stdio: ['ignore', 'ignore', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120000,
        })
      } catch (err) {
        stderr = String(err.stderr || '')
        throw new Error(`dwg2dxf failed: ${(err.message || '').slice(0, 300)} ${stderr.slice(0, 500)}`)
      }
      dxfText = fs.readFileSync(dxfPath, 'utf8')
    } else {
      dxfText = fs.readFileSync(entry.path, 'utf8')
    }
    rec.stages.convert = {
      ok: true,
      ms: Date.now() - t1,
      dxfBytes: Buffer.byteLength(dxfText),
    }
  } catch (e) {
    rec.stages.convert = { ok: false, ms: Date.now() - t1 }
    rec.errors.push({ stage: 'convert', message: String(e.message || e) })
    fs.rmSync(dxfPath, { force: true })
    rec.totalMs = Date.now() - t0
    return rec
  }
  fs.rmSync(dxfPath, { force: true })

  // independent facts from the DXF bytes
  try {
    rec.dxfFacts = dxfHeaderFacts(dxfText)
  } catch (e) {
    rec.warnings.push({ stage: 'dxfFacts', message: String(e.message || e) })
  }

  // --- stage 2: parseDrawing
  let drawing = null
  const t2 = Date.now()
  try {
    drawing = parseDrawing(dxfText)
    const st = entityStats(drawing)
    rec.stages.parse = {
      ok: true,
      ms: Date.now() - t2,
      units: drawing.units,
      bounds: drawing.bounds,
      spanM: bboxSpan(drawing.bounds),
      layers: drawing.layers.length,
      entities: drawing.entities.length,
      furniture: drawing.furniture.length,
      ...st,
    }
  } catch (e) {
    rec.stages.parse = { ok: false, ms: Date.now() - t2 }
    rec.errors.push({ stage: 'parse', message: String(e.message || e), stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') })
    rec.totalMs = Date.now() - t0
    return rec
  }

  // --- stage 3: healWalls
  let healed = null
  const t3 = Date.now()
  try {
    healed = healWalls(drawing)
    rec.stages.heal = {
      ok: true,
      ms: Date.now() - t3,
      entitiesBefore: drawing.entities.length,
      entitiesAfter: healed.entities.length,
      added: healed.entities.length - drawing.entities.length,
    }
  } catch (e) {
    rec.stages.heal = { ok: false, ms: Date.now() - t3 }
    rec.errors.push({ stage: 'heal', message: String(e.message || e) })
    healed = drawing
  }

  // --- stage 4: derivePlate (the shared derivation App.tsx + SpaceStep both use)
  let plate = null
  const t4 = Date.now()
  try {
    plate = derivePlate(drawing, null, true)
    if (!plate) {
      rec.stages.plate = { ok: false, ms: Date.now() - t4, reason: 'derivePlate returned null' }
      rec.errors.push({ stage: 'plate', message: 'No plate derived — App.tsx shows "No wall geometry found in this drawing to derive a floor plate from."' })
    } else {
      const independentArea = ringArea(plate.boundary)
      const independentCoverage = recomputeCoverage(plate, drawing)
      rec.stages.plate = {
        ok: true,
        ms: Date.now() - t4,
        method: plate.method,
        vertices: plate.boundary.length,
        reportedAreaM2: plate.areaM2,
        independentAreaM2: independentArea,
        areaAgrees: plate.areaM2 == null ? null : Math.abs(independentArea - plate.areaM2) < Math.max(1, plate.areaM2 * 0.01),
        reportedCoverage: plate.coverage,
        independentCoverage,
        coverageAgrees:
          independentCoverage == null || plate.coverage == null
            ? null
            : Math.abs(independentCoverage - plate.coverage) < 0.02,
        offset: plate.offset,
        provenance: plate.provenance ?? null,
        ringSpanM: (() => {
          const xs = plate.boundary.map((p) => p[0])
          const ys = plate.boundary.map((p) => p[1])
          return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
        })(),
      }
    }
  } catch (e) {
    rec.stages.plate = { ok: false, ms: Date.now() - t4 }
    rec.errors.push({ stage: 'plate', message: String(e.message || e), stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') })
  }

  // --- stage 5: downstream extracts (what testFitPlan pushes into the core)
  if (plate) {
    for (const [name, fn] of [
      ['keepouts', () => testfit.extractKeepouts(healed, plate)],
      ['entries', () => testfit.extractEntries(healed, plate)],
      ['interiorWalls', () => testfit.extractInteriorWalls(healed, plate)],
    ]) {
      const t = Date.now()
      try {
        const r = fn()
        rec.stages[name] = { ok: true, ms: Date.now() - t, count: r.length }
        if (name === 'entries' && r.length === 0) {
          rec.warnings.push({ stage: 'entries', message: 'No entry points — generator has no circulation anchor' })
        }
      } catch (e) {
        rec.stages[name] = { ok: false, ms: Date.now() - t }
        rec.errors.push({ stage: name, message: String(e.message || e) })
      }
    }
  }

  // --- stage 6: furniture normalization (the material-bank binding path)
  const t6 = Date.now()
  try {
    const cats = {}
    let unnamed = 0
    let zeroSize = 0
    const samples = []
    for (const f of drawing.furniture) {
      const n = normalizeFurniture(f)
      cats[n.category] = (cats[n.category] || 0) + 1
      if (!f.name || !f.name.trim()) unnamed++
      const w = f.bbox[2] - f.bbox[0]
      const h = f.bbox[3] - f.bbox[1]
      if (!(w > 0.01) || !(h > 0.01)) zeroSize++
      if (samples.length < 8) samples.push({ raw: f.raw, name: f.name, category: n.category, w: +w.toFixed(3), h: +h.toFixed(3) })
    }
    rec.stages.normalize = {
      ok: true,
      ms: Date.now() - t6,
      total: drawing.furniture.length,
      byCategory: cats,
      unnamed,
      zeroSize,
      samples,
    }
    if (zeroSize > 0) {
      rec.warnings.push({ stage: 'normalize', message: `${zeroSize} furniture blocks have a degenerate (≤1cm) bbox` })
    }
  } catch (e) {
    rec.stages.normalize = { ok: false, ms: Date.now() - t6 }
    rec.errors.push({ stage: 'normalize', message: String(e.message || e) })
  }

  rec.totalMs = Date.now() - t0
  return rec
}

function hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

// ---------- drive
const results = []
for (const entry of CORPUS) {
  if (only && !entry.label.includes(only)) continue
  process.stderr.write(`… ${entry.label}\n`)
  let rec
  try {
    rec = runOne(entry)
  } catch (e) {
    rec = { file: entry.label, src: entry.path, errors: [{ stage: 'harness', message: String(e.message || e), stack: (e.stack || '').split('\n').slice(0, 5).join(' | ') }], stages: {} }
  }
  results.push(rec)
  fs.writeFileSync(path.join(outDir, `${entry.label.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(rec, null, 2))
  const p = rec.stages.plate
  process.stderr.write(
    `   ${rec.errors.length ? 'ERR(' + rec.errors.map((e) => e.stage).join(',') + ')' : 'ok '} ` +
      `parse=${rec.stages.parse?.entities ?? '-'}e/${rec.stages.parse?.furniture ?? '-'}f ` +
      `units=${rec.stages.parse?.units ?? '-'} ` +
      `plate=${p?.ok ? `${p.method} ${Math.round(p.independentAreaM2)}m² cov=${p.independentCoverage == null ? 'n/a' : p.independentCoverage.toFixed(2)} conf=${p.provenance?.confidence ?? '-'}` : 'FAIL'} ` +
      `${rec.totalMs}ms\n`,
  )
}

fs.writeFileSync(path.join(outDir, '_all.json'), JSON.stringify(results, null, 2))
process.stderr.write(`\nWrote ${results.length} reports to ${outDir}\n`)
