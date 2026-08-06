// Scale diagnosis — independent of dxf.ts.
//
// Re-derives, straight from the DXF bytes:
//   • the header's own $INSUNITS / $EXTMIN / $EXTMAX (CRLF-safe)
//   • the true extents of the drawing in SOURCE units, from LINE/LWPOLYLINE
//     vertex group codes (10/20/11/21), ignoring the header entirely
//   • the modal DIMENSION text, when present — a human-authored statement of
//     real-world size that no importer produced
// then asks which candidate unit makes the drawing a plausible building.
//
// Nothing here reads the importer's `Drawing.units` or `bounds`; the point is
// to have a ground truth to compare the importer against.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const CORPUS = JSON.parse(fs.readFileSync(path.join(here, 'corpus.json'), 'utf8'))

const UNIT = {
  0: 'unitless', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm',
  9: 'mil', 10: 'yd', 14: 'dm', 15: 'dam', 16: 'hm',
}
const SCALE = { in: 0.0254, ft: 0.3048, mm: 0.001, cm: 0.01, m: 1, dm: 0.1, yd: 0.9144 }

function headerVal(lines, name, code) {
  const i = lines.indexOf(name)
  if (i < 0) return null
  for (let k = i + 1; k < Math.min(i + 40, lines.length - 1); k++) {
    if (lines[k].trim() === String(code)) return Number(lines[k + 1])
    if (lines[k].trim() === '9') break // next header var
  }
  return null
}

/** True extents in SOURCE units, from entity vertex codes only. */
function geometryExtents(lines) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let n = 0
  let inEntities = false
  for (let i = 0; i + 1 < lines.length; i++) {
    const c = lines[i].trim()
    if (c === '2' && lines[i + 1].trim() === 'ENTITIES') inEntities = true
    if (!inEntities) continue
    if (c === '10' || c === '11') {
      const x = Number(lines[i + 1])
      // the paired Y is two lines on (code 20/21)
      const yc = lines[i + 2]?.trim()
      if ((yc === '20' || yc === '21') && Number.isFinite(x)) {
        const y = Number(lines[i + 3])
        if (Number.isFinite(y) && Math.abs(x) < 1e12 && Math.abs(y) < 1e12) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
          n++
        }
      }
    }
  }
  return n ? { minX, minY, maxX, maxY, n, w: maxX - minX, h: maxY - minY } : null
}

/** Dimension annotation text — a human's own statement of real size.
 *  Returns the numeric values found in DIMENSION override text / TEXT that
 *  looks like a dimension string. */
function dimensionTexts(lines) {
  const vals = []
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].trim() === '0' && lines[i + 1].trim() === 'DIMENSION') {
      for (let k = i; k < Math.min(i + 200, lines.length - 1); k++) {
        if (lines[k].trim() === '42') {
          const v = Number(lines[k + 1])
          if (Number.isFinite(v) && v > 0) vals.push(v)
          break
        }
        if (lines[k].trim() === '0' && k > i) break
      }
    }
  }
  return vals
}

function median(a) {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

const rows = []
for (const entry of CORPUS) {
  const row = { file: entry.label }
  const dxfPath = path.join(os.tmpdir(), `cadval-u-${process.pid}-${rows.length}.dxf`)
  let text
  try {
    if (entry.path.toLowerCase().endsWith('.dwg')) {
      execFileSync('dwg2dxf', ['-o', dxfPath, entry.path], {
        stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20, timeout: 120000,
      })
      text = fs.readFileSync(dxfPath, 'utf8')
    } else text = fs.readFileSync(entry.path, 'utf8')
  } catch (e) {
    row.error = `convert failed: ${String(e.message || e).slice(0, 120)}`
    rows.push(row)
    continue
  } finally {
    fs.rmSync(dxfPath, { force: true })
  }

  const lines = text.split(/\r?\n/)
  const insunits = headerVal(lines, '$INSUNITS', 70)
  row.insunits = insunits
  row.insunitsLabel = insunits == null ? 'ABSENT' : (UNIT[insunits] ?? `code-${insunits}`)
  // what dxf.ts will pick: $INSUNITS mapped, defaulting to inches
  row.importerUnit = row.insunitsLabel === 'ABSENT' || insunits === 0 ? 'in (DEFAULT)' : (UNIT[insunits] ?? 'in (DEFAULT)')

  const hMin = [headerVal(lines, '$EXTMIN', 10), headerVal(lines, '$EXTMIN', 20)]
  const hMax = [headerVal(lines, '$EXTMAX', 10), headerVal(lines, '$EXTMAX', 20)]
  row.headerExtents =
    hMin[0] != null && hMax[0] != null
      ? { w: +(hMax[0] - hMin[0]).toFixed(2), h: +(hMax[1] - hMin[1]).toFixed(2) }
      : null

  const g = geometryExtents(lines)
  row.geomExtentsSrcUnits = g ? { w: +g.w.toFixed(2), h: +g.h.toFixed(2), verts: g.n } : null
  row.dimMedian = median(dimensionTexts(lines))

  // which unit makes this a plausible building? (3 m .. 500 m on the long side)
  if (g) {
    const long = Math.max(g.w, g.h)
    row.candidates = {}
    for (const [u, s] of Object.entries(SCALE)) row.candidates[u] = +(long * s).toFixed(2)
    row.plausibleUnits = Object.entries(SCALE)
      .filter(([, s]) => long * s >= 3 && long * s <= 500)
      .map(([u]) => u)
    const chosen = row.importerUnit.startsWith('in') ? 'in' : row.importerUnit
    row.importerLongSideM = SCALE[chosen] ? +(long * SCALE[chosen]).toFixed(2) : null
    row.importerPlausible = row.plausibleUnits.includes(chosen)
  }
  rows.push(row)
}

fs.writeFileSync(path.join(root, 'cad-validation/reports/_units.json'), JSON.stringify(rows, null, 2))

const pad = (s, n) => String(s).slice(0, n).padEnd(n)
console.log(pad('file', 40), pad('$INSUNITS', 10), pad('importer', 12), pad('geom span (src units)', 22), pad('importer m', 11), pad('plausible', 14), 'verdict')
for (const r of rows) {
  if (r.error) { console.log(pad(r.file, 40), r.error); continue }
  const g = r.geomExtentsSrcUnits
  console.log(
    pad(r.file, 40), pad(r.insunitsLabel, 10), pad(r.importerUnit, 12),
    pad(g ? `${g.w} x ${g.h}` : '-', 22),
    pad(r.importerLongSideM ?? '-', 11),
    pad((r.plausibleUnits || []).join(',') || 'none', 14),
    r.importerPlausible ? 'OK' : 'MIS-SCALED',
  )
}
