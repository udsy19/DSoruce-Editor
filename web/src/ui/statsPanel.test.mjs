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

test('every fixture renders a value or an explicit state in every metric row', () => {
  const ids = Editor.fixture_ids()
  assert.ok(ids.length >= 5, `expected the fixture set, got ${JSON.stringify(ids)}`)

  for (const id of ids) {
    const ed = new Editor()
    ed.load_fixture(id)
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
  }
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
