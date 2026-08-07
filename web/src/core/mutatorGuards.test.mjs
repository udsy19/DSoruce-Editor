// NO EDIT MAY PRODUCE A DOCUMENT THAT CANNOT BE REOPENED.
//
// The reported defect (adversary round, M2) was one call:
//
//   ed.resize_zone(id, NaN, NaN, NaN, NaN)   ->  Ok
//   NIA 899.789 -> 348.029, no error
//   state().zones[0].shape  ->  {"x":null,"y":null,"w":null,"h":null}
//   Editor.from_snapshot(ed.snapshot())  ->  invalid type: null, expected f64
//
// The `.dsource` saves and can never be reopened. The cause is not specific to
// `resize_zone`: every NaN comparison is false, so the `OutOfBounds` guard —
// written entirely in `<`/`>` — was structurally incapable of rejecting it. The
// audit found ALL SIXTEEN f64 mutators accepting non-finite input.
//
// WHY THIS FILE IS IN JS. `cargo test` cannot drive the `Editor` (wasm) layer's
// error paths at all: `JsValue::from_str` panics with "function not implemented
// on non-wasm32 targets". The Rust suite therefore covers the DOCUMENT layer
// (`no_zone_mutator_can_write_a_document_that_cannot_reopen`) and this covers the
// BOUNDARY — against the release wasm, which is the build the user runs and the
// build M1's `debug_assert!` did not exist in.
//
// R10 AXES — this guard's falsification varies:
//   · the MUTATOR — all sixteen, not the one that was reported;
//   · the VALUE — NaN, +Infinity and -Infinity, because a guard written as
//     `is_nan()` would pass a NaN-only probe and let ±∞ straight through;
//   · the LAYER — wasm boundary (`finite`), document (`zone_shape_admissible`),
//     and struct (`serde_json::to_value` over `Program`);
//   · the OUTCOME — not only "it threw", but "the document is unchanged AND
//     still round-trips through snapshot/from_snapshot". A mutator that throws
//     after writing is not guarded.
// An axis not listed here is an axis this test does not cover.

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

const NON_FINITE = [NaN, Infinity, -Infinity]

/** Every `&mut self` wasm method that takes an f64, driven with one value. */
const MUTATORS = {
  add_wall: (ed, v) => ed.add_wall(v, v, v, v, v),
  add_component: (ed, v) => ed.add_component('Desk', v, v, v, v),
  add_keepout: (ed, v) => ed.add_keepout(v, v, v, v, 'k'),
  add_entry: (ed, v) => ed.add_entry(v, v),
  add_anchor: (ed, v) => ed.add_anchor('Cabin', v, v),
  select_at: (ed, v) => ed.select_at(v, v),
  move_selected: (ed, v) => ed.move_selected(v, v),
  move_component: (ed, v) => ed.move_component(ed.state().components[0].id, v, v),
  set_component_rotation: (ed, v) => ed.set_component_rotation(ed.state().components[0].id, v),
  set_component_size: (ed, v) => ed.set_component_size(ed.state().components[0].id, v, v),
  // The one the coordinate-shaped audit missed and the source scan found: a
  // PRICE, not a position, and `Some(NaN)` makes the whole document unsaveable.
  assign_product: (ed, v) => ed.assign_product(ed.state().components[0].id, 'p1', 'Chair', v),
  split_zone: (ed, v) => ed.split_zone(ed.state().zones[0].id, 'Vertical', v),
  resize_zone: (ed, v) => ed.resize_zone(ed.state().zones[0].id, v, v, v, v),
  add_zone: (ed, v) => ed.add_zone('Workspace', v, v, v, v, 'z'),
  set_wall: (ed, v) => ed.set_wall(ed.state().walls[0].id, v, v, v, v),
  set_wall_height: (ed, v) => ed.set_wall_height(ed.state().walls[0].id, v),
}

/** Deep-walk a `state()` object for any number that is not finite. */
function nonFiniteIn(node, trail = '') {
  if (typeof node === 'number') return Number.isFinite(node) ? null : `${trail} = ${node}`
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = nonFiniteIn(node[i], `${trail}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const hit = nonFiniteIn(v, `${trail}.${k}`)
      if (hit) return hit
    }
    return null
  }
  return null
}

test('every f64 mutator refuses non-finite input and leaves the document intact', () => {
  const names = Object.keys(MUTATORS)
  assert.ok(names.length >= 16, `the audit covers sixteen mutators, listed ${names.length}`)

  for (const value of NON_FINITE) {
    for (const [name, call] of Object.entries(MUTATORS)) {
      const ed = new Editor()
      ed.load_fixture('F1')
      // Setup that is itself a legal mutation happens BEFORE the baseline, or
      // the "unchanged" assertion measures the setup instead of the mutator.
      const c0 = ed.state().components[0]
      ed.select_at(c0.x, c0.y)
      const before = ed.snapshot()

      let threw = null
      try {
        call(ed, value)
      } catch (e) {
        threw = String(e)
      }
      assert.ok(
        threw !== null,
        `${name}(${value}) returned Ok — this is exactly how resize_zone(NaN) ` +
          'wrote a document that could never be reopened',
      )

      // Threw is not enough: it must not have written first.
      const stray = nonFiniteIn(ed.state())
      assert.equal(stray, null, `${name}(${value}) left a non-finite value at${stray}`)
      assert.equal(
        ed.snapshot(),
        before,
        `${name}(${value}) was refused but still changed the document`,
      )

      // THE property, asserted end to end: the save reopens.
      Editor.from_snapshot(ed.snapshot())
    }
  }
})

test('generate refuses a program carrying a non-finite number', () => {
  for (const value of NON_FINITE) {
    const ed = new Editor()
    ed.load_fixture('F1')
    const before = ed.snapshot()
    let threw = null
    try {
      ed.generate({ desks: 10, meeting_rooms: 2, desk_w: value, desk_h: 0.8 }, BigInt(1), false)
    } catch (e) {
      threw = String(e)
    }
    assert.ok(threw !== null, `generate(desk_w = ${value}) returned Ok`)
    assert.equal(ed.snapshot(), before, `generate(desk_w = ${value}) mutated the document anyway`)
  }
})

// The guard must not have been bought by refusing ordinary input — the failure
// mode of every over-eager validator. Same sixteen mutators, legal values.
test('ordinary edits still go through', () => {
  const ed = new Editor()
  ed.load_fixture('F1')
  const st = ed.state()
  const z = st.zones.find((z) => z.shape.kind === 'Rect')
  assert.ok(z, 'F1 has a Rect zone')

  ed.add_wall(1, 1, 2, 1, 0.2)
  ed.add_component('Desk', 5, 5, 1.4, 0.7)
  ed.add_keepout(10, 10, 2, 2, 'core')
  ed.add_entry(1, 1)
  ed.add_anchor('Cabin', 5, 5)
  ed.select_at(st.components[0].x, st.components[0].y)
  ed.move_selected(0.1, 0.1)
  ed.move_component(st.components[0].id, 6, 6)
  ed.set_component_rotation(st.components[0].id, Math.PI / 2)
  ed.set_component_size(st.components[0].id, 1.6, 0.8)
  ed.assign_product(st.components[0].id, 'p1', 'Task Chair', 12000)
  ed.assign_product(st.components[1].id, 'p2', 'Spec-only', undefined)
  ed.resize_zone(z.id, z.shape.x, z.shape.y, z.shape.w * 0.9, z.shape.h * 0.9)
  ed.add_zone('Workspace', z.shape.x, z.shape.y, 2, 2, 'real')
  ed.set_wall(st.walls[0].id, st.walls[0].a.x, st.walls[0].a.y, st.walls[0].b.x, st.walls[0].b.y)
  ed.set_wall_height(st.walls[0].id, 1.2)
  ed.split_zone(z.id, 'Vertical', z.shape.x)

  assert.equal(nonFiniteIn(ed.state()), null)
  Editor.from_snapshot(ed.snapshot())
})

// M3 · the unguarded creator. `add_zone` had NO bounds check where `resize_zone`
// had one, so an off-plate zone billed `area 0 · capacity 6666` and took a
// plan's published capacity from 131 to 6797. Both writers now share one
// admissibility test; asserted as a PAIR, because a guard on one of two writers
// of the same invariant is the bypass, not the guard.
test('both zone writers refuse an off-plate shape', () => {
  const ed = new Editor()
  ed.load_fixture('F1')
  const capBefore = ed.zone_stats().reduce((s, r) => s + r.capacity, 0)
  const zid = ed.state().zones[0].id

  assert.throws(() => ed.add_zone('Workspace', 5000, 5000, 200, 200, 'off-plate'))
  assert.throws(() => ed.resize_zone(zid, 5000, 5000, 200, 200))

  assert.equal(
    ed.zone_stats().reduce((s, r) => s + r.capacity, 0),
    capBefore,
    'an off-plate zone changed the published capacity',
  )
})

// M4 · seven anchors is a real plan, and the retired `MIN_PLAN_ANCHORS < 8`
// gate skipped the containment check entirely below it — certifying a 1.2 m²
// scratch box as a 1200 m² building's floor, labelled "traced".
test('a seven-anchor plan cannot certify a scratch box as the floor', () => {
  const ed = new Editor()
  // 40 x 30 envelope with one wall deleted.
  ed.add_wall(0, 0, 40, 0, 0.2)
  ed.add_wall(40, 0, 40, 30, 0.2)
  ed.add_wall(40, 30, 0, 30, 0.2)
  // A 1.2 x 1.0 m scratch box — the only closed face.
  ed.add_wall(5, 5, 6.2, 5, 0.1)
  ed.add_wall(6.2, 5, 6.2, 6, 0.1)
  ed.add_wall(6.2, 6, 5, 6, 0.1)
  ed.add_wall(5, 6, 5, 5, 0.1)
  ed.add_zone('Workspace', 20, 10, 30, 16, 'Open Workspace')
  ed.add_zone('Meeting', 30, 24, 8, 6, 'Boardroom')
  for (let i = 0; i < 5; i++) ed.add_component('Desk', 10 + i * 2, 10, 1.4, 0.7)

  const st = ed.state()
  assert.equal(st.zones.length + st.components.length, 7, 'the case is 7 anchors')
  const m = ed.metrics()
  assert.equal(m.plate_state, 'unresolved', `plate_state ${m.plate_state}, GEA ${m.gross_external_area}`)
  assert.ok(m.gross_external_area > 100, `GEA ${m.gross_external_area} m²`)
})

// The other side of the same threshold: plenty of anchors, same structure. If
// only one of these two passed, the rule would still be reading the count.
test('a high-anchor plan with a spurious loop also refuses', () => {
  const ed = new Editor()
  ed.load_fixture('F3')
  assert.equal(ed.metrics().plate_state, 'unresolved')
})

// The zero-anchor wizard import — the ONLY case the retired count gate was
// justified by. The fraction covers it with no special case (0 >= 0.9 * 0), so
// behaviour is unchanged; pinned, because deleting a branch is how the case it
// named stops being tested.
test('a freshly imported plate with no plan still traces', () => {
  const ed = new Editor()
  ed.add_wall(0, 0, 40, 0, 0.2)
  ed.add_wall(40, 0, 40, 30, 0.2)
  ed.add_wall(40, 30, 0, 30, 0.2)
  ed.add_wall(0, 30, 0, 0, 0.2)
  const st = ed.state()
  assert.equal(st.zones.length + st.components.length, 0, 'the wizard case has no plan yet')
  const m = ed.metrics()
  assert.equal(m.plate_state, 'traced')
  assert.ok(Math.abs(m.gross_external_area - 1200) < 1, `GEA ${m.gross_external_area}`)
})
