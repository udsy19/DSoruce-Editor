// THE AREA A DELIVERABLE PRINTS IS THE AREA THE CORE MEASURED.
// Run from web/:  node src/export/publishedArea.test.mjs
//
// @covers: web/src/export/finishSchedule.ts
// @covers: web/src/export/sheetSet.ts
// @covers: web/src/util/publishedArea.ts
// @covers: web/src/util/zoneGeom.ts
// @covers: web/src/editor/stats.ts
// @covers: crates/ds-core/src/cost.rs
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// `util/zoneGeom.zoneArea(shape)` — raw shoelace/w·h, NO plate clip, NO
// de-overlap, NO cap — was a fourth, fifth, sixth and seventh owner of per-zone
// area, and four of its call sites PUBLISHED the number: sheet A.09's `AREA m²`
// column, the room label on every plan sheet, `services.ts`'s room record and
// the Statistics panel's enclosed-room premium. The core had already unified
// per-zone area behind `mod basis` — one private accessor, one production
// consumer — and the census that certified that unification was performed with
// `rustc`, which cannot see `web/src/export/`.
//
// Measured at HEAD, no sabotage, on the UNEDITED base fixtures:
//
//     F1 · zone 244 "Open Workspace (2)"   sheet 35.0 m²   core 8.0 m²
//     F1 · zone 245 "Open Workspace (3)"   sheet 17.0 m²   core 3.7 m²
//
// Same zone id, same name, same delivered pack, 4.4x apart. Nothing anywhere
// read the sheet's area column or the plan's room label, so the battery was
// 49/49 green throughout.
//
// ---------------------------------------------------------------------------
// INDEPENDENCE (.claude/rules/gate-independence.md)
// ---------------------------------------------------------------------------
// Two sides, two surfaces, and neither is the other's account of itself:
//
//   ARTIFACT  the `Page.ops` the sheet builders emit. These are the content-
//     stream ops `pdf.ts` serialises verbatim into the delivered PDF — the
//     drawing, not a summary of it. The gate recovers the glyph runs and parses
//     the numbers back out of the strings a reader sees.
//
//   GROUND TRUTH  `Editor.quantities().rooms[].areaM2` — the Rust core's
//     `area_basis`, reached through a DIFFERENT wasm export than anything the
//     export pipeline consumes. The gate never reads a number the sheet code
//     produced, and never reads `zoneGeom` at all.
//
// A missing input is a FAILURE, never a skip: an id in the artifact with no row
// in `quantities()`, or a scheduled zone with no row on the sheet, fails.
//
// R1 — BOTH POPULATIONS. Every fixture unedited, and every fixture under the
// four retype/overlap edits `statsPanel.test.mjs` uses. The unedited half alone
// would have caught this one; the edited half is what catches a cap.
//
// R10 AXES this falsification varies:
//   * VALUE      — the number printed (the 27.0 m² and 13.3 m² divergences).
//   * OWNER      — which function the publishing site reads (raw shape area vs
//                  the core basis); reverting one call site reds.
//   * POPULATION — unedited and edited; the cap only exists on the edited half.
//   * SURFACE    — three publishing surfaces (A.09 column, plan room label,
//                  panel enclosure premium), asserted separately, because a fix
//                  applied at one call site while the class stays live is the
//                  tell this repo has been bitten by four times.
//   * REACHABILITY — the source-scan half varies the IMPORT GRAPH: a new
//                  importer of the raw helper reds whether or not it publishes.
//
// NOT VARIED, and therefore not claimed: page rasterisation. The gate reads the
// ops rather than the rendered pixels, so a defect between `Page.ops` and ink on
// paper is out of its frame — that frame belongs to `scripts/gates/sheets/`.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const wasmDir = path.join(here, '../wasm')
if (!fs.existsSync(path.join(wasmDir, 'ds_core_bg.wasm'))) {
  console.log('SKIP: web/src/wasm not built (run `make wasm`)')
  process.exit(0)
}

const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

// --- the DOM host the sheet builders need ----------------------------------
// Two things in the bundle want a <canvas>, and NEITHER is what this gate
// measures: the title block's key plan (a raster) and `three/furniture3d`'s
// procedural textures, generated at module scope for the 3D section sheets.
// Both are satisfied by a no-op 2D context; every `p.text` op is arithmetic on
// `pdfDoc.textWidth` and never touches a canvas. Non-vacuity is asserted at the
// bottom (row counts, and every recovered id joining a real zone), so a shim
// that silently emptied a page would red rather than pass.
const stubCtx = () => ({
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  globalAlpha: 1,
  font: '',
  fillRect() {},
  strokeRect() {},
  clearRect() {},
  beginPath() {},
  closePath() {},
  moveTo() {},
  lineTo() {},
  arc() {},
  fill() {},
  stroke() {},
  save() {},
  restore() {},
  translate() {},
  rotate() {},
  scale() {},
  clip() {},
  setLineDash() {},
  drawImage() {},
  fillText() {},
  strokeText() {},
  measureText: () => ({ width: 0 }),
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  createPattern: () => null,
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {},
})
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    style: {},
    getContext: () => stubCtx(),
    toDataURL: () => 'data:image/jpeg;base64,',
    addEventListener() {},
  }),
}

// --- bundle the REAL export modules -----------------------------------------
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `ds-pa-${path.basename(entry, '.ts')}-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({ entryPoints: [path.join(here, '..', entry)], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}
const { finishScheduleSheets } = await bundle('export/finishSchedule.ts')
const { roomLabels } = await bundle('export/sheetSet.ts')
const { Page } = await bundle('export/sheet.ts')
const { buildElements } = await bundle('editor/stats.ts')

// --- scoreboard --------------------------------------------------------------
let checks = 0
let failures = 0
const fail = (msg) => {
  failures++
  console.log(`FAIL  ${msg}`)
}
const check = (ok, label) => {
  checks++
  if (!ok) fail(label)
}

// ===========================================================================
// R14 — THE OLD PATH CEASED TO EXIST, AND THIS IS THE PART THAT KEEPS IT GONE
// ===========================================================================
// Three mechanisms, in order of how early they fire:
//
//   1. THE NAME. `zoneGeom.zoneArea` no longer exists. Every publishing site
//      that used it now reads `util/publishedArea.ts`, and re-importing the old
//      name is `TS2305: Module '"../util/zoneGeom"' has no exported member
//      'zoneArea'` — the TypeScript analogue of the `E0425` the Rust module
//      boundary produces. Asserted below, both directions.
//
//   2. THE ALLOWLIST (this section). The raw helper still has to exist —
//      sorting rooms by size and `zoneAtPoint`'s tie-break legitimately need it,
//      and that last one is a MIRROR of `Document::zone_index_at`, which chooses
//      on `z.shape.area()`. So the surviving importers are enumerated, and a new
//      one is RED whether or not it publishes. Reintroducing the defect now
//      costs a call site AND a line here, and the line here is a written claim
//      that the new site only orders.
//
//   3. THE VALUE (the rest of this file). The allowlist cannot see a site that
//      RECOMPUTES `w * h` instead of importing anything — that is exactly the
//      route `cost.rs:185` took inside the core, invisible to a census of
//      symbols because it is a census of a quantity. Only the cross-surface
//      comparison catches it, and it is the sole mechanism on that route.
//      `web/src/util/areaCensus.test.mjs` is the instrument that closes it from
//      the source side in BOTH languages, by detecting the arithmetic rather
//      than the name.
// **REPOINTED AT THE SURVIVING MECHANISM.** Line A named the ordering helper
// `rawShapeAreaForOrderingOnly` — a magnitude with a warning in its name. Line B
// replaced it with `compareZoneExtent`, which returns an ORDERING, so no m²
// value exists to publish by accident. B's is strictly stronger and survives the
// merge; A's name is retired, and per increment 1's standard a retired mechanism
// loses its name rather than lingering beside the winner.
//
// The CHECK A built around it is what matters and is kept verbatim in shape: the
// helper's importers are an allowlist, a new one must justify itself as
// ordering-only, and the allowlist may not go vacuous. That guard fired on this
// merge — `no file imports rawShapeAreaForOrderingOnly — the allowlist is
// vacuous` — which is exactly how a test should report that its subject moved.
const RAW = 'compareZoneExtent'
const ORDERING_ONLY = {
  // `src/editor/paint.ts` LEFT this list in the merge, and its old entry read
  // "degenerate-polygon epsilon for the room-tag anchor … never printed".
  // Line B found that claim was false on one of the two sites: the epsilon's
  // value WAS then spent as `stat?.area ?? Math.abs(a2) / 2`, publishing a raw
  // area on the canvas whenever the core row was missing. B replaced both with
  // `isDegenerateZoneShape`, a PREDICATE that yields no magnitude at all.
  // A site that needs no number beats a site allowlisted to have one, so it
  // leaves the list rather than being re-justified.
  'src/export/qtoWorkbook.ts': 'picks the largest circulation zone for the plan thumbnail',
  'src/export/roomRenders.ts': 'filters + sorts rooms by size to choose render subjects',
  'src/export/walkthrough.ts': 'orders rooms by size for the camera path',
  'src/export/planGraphic.ts': 'picks the largest circulation zone to label',
  'src/export/takeoff.ts': "zoneAtPoint's smallest-zone tie-break — mirrors Document::zone_index_at",
}
{
  /** Source with comments removed — the scan is about a LIVE reference, and
   *  the retraction notes in `stats.ts` and `util/publishedArea.ts` quote the
   *  retired name on purpose. `://` is spared so a URL does not swallow the
   *  rest of its line. */
  const code = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((l) => {
        const i = l.replace(/:\/\//g, '_@_').indexOf('//')
        return i >= 0 ? l.slice(0, i) : l
      })
      .join('\n')
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'wasm' || e.name === 'node_modules') continue
        walk(p, out)
      } else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p)
    }
    return out
  }
  const srcDir = path.join(ROOT, 'web/src')
  const importers = []
  let declaresRaw = false
  for (const f of walk(srcDir)) {
    const rel = path.relative(path.join(ROOT, 'web'), f).split(path.sep).join('/')
    const body = code(fs.readFileSync(f, 'utf8'))
    if (rel === 'src/util/zoneGeom.ts') {
      declaresRaw = new RegExp(`export function ${RAW}\\b`).test(body)
      continue
    }
    // NAMES-IT-BUT-DOES-NOT-CALL-IT, and the exemption is TWO-SIDED: each file
    // must still carry no `import ... from '…zoneGeom'`, so the day one of them
    // starts actually importing the helper it rejoins the allowlist instead of
    // sitting behind a stale name-based skip.
    if (rel === 'src/export/publishedArea.test.mjs' || rel === 'src/util/areaCensus.test.mjs') {
      check(
        !/from\s*['"][^'"]*zoneGeom['"]/.test(body),
        `${rel} is exempt from the ${RAW} importer scan because it only NAMES the helper — but it now imports zoneGeom. Remove the exemption and declare it.`,
      )
      continue
    }
    if (new RegExp(`\\b${RAW}\\b`).test(body)) importers.push(rel)
    // Direction 2: the retired name must not come back, under any alias.
    check(
      !/\bzoneArea\b/.test(body.replace(/compareZoneExtent/g, '')),
      `${rel}: the retired name \`zoneArea\` is back. The published area is util/publishedArea.ts; the ordering-only raw shape is ${RAW}.`,
    )
  }
  // SUBJECT EXISTENCE is a FAILURE, never a skip: if the helper were renamed
  // again this whole section would otherwise pass on an empty population.
  check(declaresRaw, `util/zoneGeom.ts must declare \`export function ${RAW}\` — the allowlist below is about nothing otherwise`)
  const declared = Object.keys(ORDERING_ONLY).sort()
  const found = importers.sort()
  check(
    JSON.stringify(declared) === JSON.stringify(found),
    `the ${RAW} importers have moved.\n        declared: ${JSON.stringify(declared)}\n        on disk:  ${JSON.stringify(found)}\n        A NEW importer must be justified here as ORDERING-ONLY — a site that PUBLISHES the number belongs on util/publishedArea.ts.`,
  )
  check(found.length > 0, `no file imports ${RAW} — the allowlist is vacuous`)
}

const META = {
  project: 'Parity Probe',
  client: 'Gate',
  address: '—',
  studio: 'DSOURCE',
  revision: 'A',
  drawnBy: 'DS',
  approvedBy: 'UT',
}

/** Ground, never a scheduled room — the same predicate the sheets use. */
const isGround = (t) => t === 'Circulation' || t === 'Unassigned'

// ---------------------------------------------------------------------------
// THE POPULATION (R1) — every fixture, unedited and edited.
// ---------------------------------------------------------------------------
const EDITS = {
  'retype every zone to Workspace': (ed) => {
    const zones = ed.state().zones
    assert.ok(zones.length > 0, 'nothing to retype')
    for (const z of zones) ed.set_zone_type(z.id, 'Workspace')
  },
  'retype every zone to Circulation': (ed) => {
    const zones = ed.state().zones
    assert.ok(zones.length > 0, 'nothing to retype')
    for (const z of zones) ed.set_zone_type(z.id, 'Circulation')
  },
  'lay overlapping Workspace zones over the plan': (ed) => {
    const before = ed.state().zones.length
    let landed = 0
    for (const z of ed.state().zones.slice(0, 6)) {
      if (z.shape.kind !== 'Rect') continue
      try {
        ed.add_zone('Workspace', z.shape.x, z.shape.y, z.shape.w, z.shape.h, 'overlap')
        landed++
      } catch {
        /* off-plate copies are refused by design */
      }
    }
    assert.ok(landed > 0, 'no overlapping zone landed — the overlap axis is not varied')
    assert.equal(ed.state().zones.length, before + landed, 'add_zone reported success without adding a zone')
  },
  'retype every zone to Workspace, then overlap them': (ed) => {
    EDITS['retype every zone to Workspace'](ed)
    EDITS['lay overlapping Workspace zones over the plan'](ed)
  },
}

function* population() {
  for (const id of Editor.fixture_ids()) {
    for (const [what, edit] of [['(unedited)', null], ...Object.entries(EDITS)]) {
      const ed = new Editor()
      ed.load_fixture(id)
      if (edit) edit(ed)
      yield { key: `${id} · ${what}`, ed }
    }
  }
}

/** GROUND TRUTH: zone id → the core's basis area, m². Read from `quantities()`,
 *  the surface nothing in `web/src/export/` consumes. */
function coreAreas(ed) {
  const q = ed.quantities()
  const m = new Map()
  for (const r of q.rooms) m.set(r.roomId, r.areaM2)
  return m
}

/** The published-area map the export pipeline is handed — `zone_stats()`, the
 *  OTHER basis surface. Deliberately not the same export the ground truth uses. */
function publishedAreaEntries(ed) {
  return ed.zone_stats().map((r) => ({ id: r.id, area: r.area }))
}

// ---------------------------------------------------------------------------
// 1) SHEET A.09 — the `AREA m²` column.
// ---------------------------------------------------------------------------
// Recovery is positional and derived from the table's own geometry: within a
// row (one y baseline) the leftmost run is the `ID` cell and the rightmost
// numeric run is the `AREA` cell, because `AREA m²` is the last column and is
// right-aligned. The join to the core is by the printed ID.
function scheduleAreasFromOps(sheets) {
  const rows = new Map() // zone id -> printed area string
  for (const s of sheets) {
    const byY = new Map()
    for (const o of s.page.ops) {
      if (o.op !== 'text') continue
      const k = o.y.toFixed(2)
      if (!byY.has(k)) byY.set(k, [])
      byY.get(k).push(o)
    }
    for (const runs of byY.values()) {
      runs.sort((a, b) => a.x - b.x)
      const idRun = runs[0]
      if (!/^\d+$/.test(idRun.text)) continue // header band, notes, title block
      const numeric = runs.filter((r) => /^\d+(\.\d+)?$/.test(r.text))
      const areaRun = numeric[numeric.length - 1]
      if (!areaRun || areaRun === idRun) continue
      rows.set(Number(idRun.text), areaRun.text)
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// 2) THE PLAN ROOM LABEL — `roomLabels` draws each zone's name line(s) then its
//    area, in `state.zones` order, skipping ground. So the k-th area run belongs
//    to the k-th scheduled zone. Positional, no name matching, no abbreviation
//    sensitivity.
// ---------------------------------------------------------------------------
function labelAreasFromOps(page) {
  return page.ops
    .filter((o) => o.op === 'text' && /^\d+(\.\d+)? m²$/.test(o.text))
    .map((o) => o.text.replace(' m²', ''))
}

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------
let scheduledRows = 0
let labelRows = 0
let cappedStates = 0
let enclosedStates = 0

for (const { key, ed } of population()) {
  const state = ed.state()
  const core = coreAreas(ed)
  const entries = publishedAreaEntries(ed)
  const zoneAreas = new Map(entries.map((e) => [e.id, e.area]))
  const scheduled = state.zones.filter((z) => !isGround(z.zone_type))
  const expect = (id) => {
    const a = core.get(id)
    if (a === undefined) throw new Error(`${key}: zone ${id} has no row in quantities() — a missing input is a failure`)
    return a.toFixed(1)
  }
  if (ed.metrics().metrics_error) cappedStates++

  // --- A.09 --------------------------------------------------------------
  const sheets = finishScheduleSheets(state, { meta: META, startNo: 9, zoneAreas })
  const printed = scheduleAreasFromOps(sheets)
  check(printed.size === scheduled.length, `${key}: A.09 printed ${printed.size} rows for ${scheduled.length} scheduled zones`)
  for (const z of scheduled) {
    scheduledRows++
    const got = printed.get(z.id)
    if (got === undefined) {
      check(false, `${key}: zone ${z.id} "${z.label}" is scheduled but prints no A.09 row`)
      continue
    }
    check(got === expect(z.id), `${key}: A.09 zone ${z.id} "${z.label}" prints ${got} m², core basis ${expect(z.id)} m²`)
  }

  // --- the plan room label ------------------------------------------------
  const p = new Page()
  roomLabels(p, state, (x, y) => ({ x: 100 + x, y: 100 + y }), [], null, (d) => d(), zoneAreas)
  const labels = labelAreasFromOps(p)
  check(labels.length === scheduled.length, `${key}: plan drew ${labels.length} room-area labels for ${scheduled.length} scheduled zones`)
  for (let i = 0; i < Math.min(labels.length, scheduled.length); i++) {
    labelRows++
    const z = scheduled[i]
    check(labels[i] === expect(z.id), `${key}: plan label zone ${z.id} "${z.label}" prints ${labels[i]} m², core basis ${expect(z.id)} m²`)
  }

  // --- the Statistics panel's enclosed-room premium -----------------------
  // The quantity `buildElements` bills for `Room Fit-out` must be the core's
  // basis area of the enclosed zones — the same quantity `cost.rs`'s
  // `ENCLOSURE_PREMIUM` loop multiplies. `stats.ts:271-273` used to carry a
  // comment claiming "the two enclosure premiums agree"; it was false by 2.20%.
  const nia = ed.metrics().net_internal_area
  const enclosed = state.zones.filter((z) => z.zone_type === 'Meeting' || z.zone_type === 'ClosedOffice')
  const wantEnclosed = enclosed.reduce((s, z) => s + (core.get(z.id) ?? NaN), 0)
  const el = buildElements(state, nia, zoneAreas)
  const line = el.groups.find((g) => g.label === 'Room Fit-out')?.lines[0]
  if (enclosed.length > 0) {
    enclosedStates++
    check(!!line, `${key}: ${enclosed.length} enclosed zones but no Room Fit-out line`)
    if (line) check(Math.abs(line.qty - wantEnclosed) < 1e-6, `${key}: Room Fit-out bills ${line.qty.toFixed(4)} m², core basis ${wantEnclosed.toFixed(4)} m²`)
  } else {
    check(!line, `${key}: no enclosed zones but a Room Fit-out line was billed`)
  }
  ed.free()
}

// --- NON-VACUITY -------------------------------------------------------------
// Each of these is a population claim the assertions above depend on; a
// population that never reaches a side tests one side of a two-sided check.
check(scheduledRows > 100, `only ${scheduledRows} A.09 rows compared`)
check(labelRows > 100, `only ${labelRows} plan labels compared`)
check(cappedStates >= 5, `only ${cappedStates} capped states — the cap axis is thin`)
check(enclosedStates >= 5, `only ${enclosedStates} states with enclosed rooms — the premium axis is thin`)

console.log(
  `\n${checks - failures}/${checks} checks green  (${scheduledRows} schedule rows, ` +
    `${labelRows} plan labels, ${cappedStates} capped states, ${enclosedStates} states with enclosed rooms)`,
)
if (failures > 0) {
  console.log(`PUBLISHED-AREA PARITY FAIL — ${failures} failing`)
  process.exit(1)
}
console.log('PUBLISHED-AREA PARITY OK')
