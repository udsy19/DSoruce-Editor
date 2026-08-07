// THE STATISTICS PANEL CANNOT SHOW AN IMPOSSIBLE OR BLANK NUMBER.
//
// The reported defect was a panel reading "GEA 1 m² · NIA 138 m² · Efficiency
// 1159% · Area/WS 0.0 m²". Three separate failures met there: a plate trace that
// locked onto a scratch loop, two NIA owners in the core, and a THIRD owner in
// this panel (`zones.totalArea || m.net_internal_area`). The Rust battery
// (`crates/ds-core/src/metrics_tests.rs`) covers the first two. This covers the
// third, plus the rendering rule that no row may come out empty.
//
// Independence: the fixtures come from the CORE (`Editor.load_fixture`), the
// numbers come from the core's own `metrics()`/`zone_stats()`, and the
// assertions are re-derived here from the panel's SOURCE — the JSX is parsed for
// which field each row reads — rather than from anything the panel reports about
// itself.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const wasmDir = path.join(ROOT, 'web/src/wasm')

const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

const SRC = fs.readFileSync(path.join(here, 'StatsPanel.tsx'), 'utf8')

test('the panel derives NIA from the core and nowhere else', () => {
  // The retired line was `const nia = zones.totalArea || m.net_internal_area`.
  // Any form that puts a TS-side sum FIRST re-creates the third owner.
  const line = SRC.split('\n').find((l) => /^\s*const nia =/.test(l))
  assert.ok(line, 'StatsPanel must declare `const nia`')
  assert.match(
    line,
    /m\.net_internal_area/,
    'NIA must come from the core metric',
  )
  assert.doesNotMatch(
    line,
    /zones\.totalArea\s*\|\|/,
    'a TS-side zone sum must not take precedence over the core NIA — that is the ' +
      'third owner that put NIA 138 beside GEA 1',
  )
})

/** Every metric row the panel prints, asserted on one `Editor` state. */
function assertPanelIsRenderable(id, ed) {
  const m = ed.metrics()
  const rows = ed.zone_stats()

  // Every field the panel prints must be a real number (or, for the plate,
  // one of the three declared states). `undefined` renders as a blank slot.
  for (const key of [
    'gross_external_area',
    'net_internal_area',
    'workstations',
    'area_per_workstation',
    'efficiency_pct',
  ]) {
    const v = m[key]
    assert.equal(typeof v, 'number', `${id}: ${key} is ${v}`)
    assert.ok(Number.isFinite(v), `${id}: ${key} is ${v}`)
    assert.ok(v >= 0, `${id}: ${key} is negative (${v})`)
  }
  assert.ok(
    ['traced', 'open', 'unresolved'].includes(m.plate_state),
    `${id}: plate_state is ${JSON.stringify(m.plate_state)} — the panel branches on ` +
      'this string and an unknown value falls through every branch',
  )

  // The reported symptom, asserted directly.
  assert.ok(m.efficiency_pct <= 100, `${id}: efficiency ${m.efficiency_pct}%`)
  if (m.workstations > 0) {
    assert.ok(
      m.area_per_workstation > 0,
      `${id}: ${m.workstations} workstations but area/WS is ${m.area_per_workstation}`,
    )
  }

  // A CAPPED metric must say so. Efficiency is now clamped in the core, so the
  // 102.469% can never again surface as a NUMBER — which is exactly what would
  // make an unreported cap invisible to the line above. Re-derived from the
  // Zones tab's own rows (`Σ area` against GEA), not from anything the metrics
  // object says about itself.
  const sumRows = rows.reduce((s, r) => s + r.area, 0)
  if (m.plate_state === 'traced' && sumRows > m.gross_external_area + 1e-6) {
    assert.ok(
      m.metrics_error,
      `${id}: the zone rows sum to ${sumRows.toFixed(3)} over a traced floor of ` +
        `${m.gross_external_area.toFixed(3)} and metrics_error is ` +
        `${JSON.stringify(m.metrics_error)}`,
    )
  }
  assert.ok(
    m.metrics_error === null ||
      m.metrics_error === undefined ||
      typeof m.metrics_error === 'string',
    `${id}: metrics_error must be null or a sentence, got ${typeof m.metrics_error}`,
  )

  // ONE NIA, checked across the boundary: the Zones tab's rows carry
  // `pct_of_nia = area / nia`, so inverting a row recovers the NIA they were
  // computed against without asking the core which number it used.
  const row = rows.find((r) => r.pct_of_nia > 1e-9 && r.area > 1e-9)
  if (row) {
    const rowsNia = (row.area / row.pct_of_nia) * 100
    assert.ok(
      Math.abs(rowsNia - m.net_internal_area) < 1e-6 * Math.max(rowsNia, 1),
      `${id}: the Zones tab says NIA ${rowsNia.toFixed(3)}, the metrics panel says ` +
        `${m.net_internal_area.toFixed(3)}`,
    )
  }
  return m
}

test('every fixture renders a value or an explicit state in every metric row', () => {
  const ids = Editor.fixture_ids()
  assert.ok(ids.length >= 5, `expected the fixture set, got ${JSON.stringify(ids)}`)

  for (const id of ids) {
    const ed = new Editor()
    ed.load_fixture(id)
    assertPanelIsRenderable(id, ed)
  }
})

// THE SAME ASSERTIONS ON THE EDITED POPULATION — the half that was missing.
//
// This file asserted `efficiency_pct <= 100` on five UNEDITED fixtures and
// passed while `102.469%` was four clicks away: load F4, retype every zone to
// Workspace. A guard's frame is part of the guard, and a frame drawn around the
// state the fixture ships in tests the fixture, not the product. Both
// populations, always.
//
// R10 AXES — this guard's falsification varies: zone TYPE (retype ALL, not one),
// zone COUNT and OVERLAP (a new zone laid over existing ones), plate STATE
// (a deleted plate wall drives it to `unresolved`), and the BUILD — it runs
// against the release wasm, where M1's `debug_assert!` did not exist.
const EDITS = {
  'retype every zone to Workspace': (ed) => {
    for (const z of ed.state().zones) ed.set_zone_type(z.id, 'Workspace')
  },
  'retype every zone to Circulation': (ed) => {
    for (const z of ed.state().zones) ed.set_zone_type(z.id, 'Circulation')
  },
  'retype every zone to Unassigned': (ed) => {
    for (const z of ed.state().zones) ed.set_zone_type(z.id, 'Unassigned')
  },
  'lay overlapping Workspace zones over the plan': (ed) => {
    for (const z of ed.state().zones.slice(0, 6)) {
      if (z.shape.kind !== 'Rect') continue
      // Deliberately overlapping the zone it is copied from. `add_zone` refuses
      // an off-plate shape, so this stays inside the plate and the overlap is
      // with SIBLINGS — which is legal, and is the state under test.
      try {
        ed.add_zone('Workspace', z.shape.x, z.shape.y, z.shape.w, z.shape.h, 'overlap')
      } catch {
        /* off-plate copies are refused by design; the in-bounds ones land */
      }
    }
  },
  'retype every zone to Workspace, then overlap them': (ed) => {
    EDITS['retype every zone to Workspace'](ed)
    EDITS['lay overlapping Workspace zones over the plan'](ed)
  },
  'delete a plate wall, then retype every zone to Workspace': (ed) => {
    const w = ed.state().walls.find((w) => !w.generated)
    if (w) ed.set_wall(w.id, 0, 0, 0, 0)
    EDITS['retype every zone to Workspace'](ed)
  },
}

test('every EDITED fixture also renders a possible number in every metric row', () => {
  const ids = Editor.fixture_ids()
  let capped = 0
  for (const id of ids) {
    for (const [what, edit] of Object.entries(EDITS)) {
      const ed = new Editor()
      ed.load_fixture(id)
      edit(ed)
      const m = assertPanelIsRenderable(`${id} · ${what}`, ed)
      if (m.metrics_error) capped++
    }
  }
  // Non-vacuity: these edits must actually reach the capped basis, or the
  // population is "edited" in name only and proves no more than the five
  // unedited fixtures did.
  assert.ok(
    capped > 0,
    'no edited state reached a capped basis — this population is not exercising ' +
      'the defect it was added for',
  )
  console.log(`EDITED PANEL STATES: ${ids.length * Object.keys(EDITS).length}, capped ${capped}`)
})

test('the reported M1 state — F4 with every zone retyped to Workspace', () => {
  const ed = new Editor()
  ed.load_fixture('F4')
  const before = ed.metrics()
  for (const z of ed.state().zones) ed.set_zone_type(z.id, 'Workspace')
  const after = ed.metrics()
  console.log(
    `M1: eff ${before.efficiency_pct.toFixed(3)}% -> ${after.efficiency_pct.toFixed(3)}%, ` +
      `GEA ${after.gross_external_area.toFixed(3)} NIA ${after.net_internal_area.toFixed(3)}`,
  )
  assert.ok(
    after.efficiency_pct <= 100,
    `efficiency ${after.efficiency_pct}% — M1, live again in the release wasm`,
  )
  assert.ok(
    after.metrics_error && /do not tile/.test(after.metrics_error),
    'the cap must be reported, not applied silently: ' + JSON.stringify(after.metrics_error),
  )
  // And the panel must be able to render it.
  assert.match(
    SRC,
    /metrics_error/,
    'StatsPanel must read metrics_error — a release-visible error state nothing ' +
      'displays is a debug_assert with extra steps',
  )
})

test('an unresolved plate reaches the panel as a state, not as a number', () => {
  const ed = new Editor()
  ed.load_fixture('F3')
  const m = ed.metrics()
  assert.equal(
    m.plate_state,
    'unresolved',
    'F3 is the GEA-collapse fixture; if it resolves, this test has stopped ' +
      'covering the defect it exists for',
  )
  // And the panel must have a branch for it. Emission is not visibility, but a
  // panel with no branch at all cannot possibly render one.
  assert.match(
    SRC,
    /plate === 'unresolved'/,
    'StatsPanel must branch on the unresolved plate state',
  )
  assert.match(SRC, /unresolved/, 'the row must name the state')
})
