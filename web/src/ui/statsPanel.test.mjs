// THE STATISTICS PANEL CANNOT SHOW AN IMPOSSIBLE OR BLANK NUMBER.
//
// The reported defect was a panel reading "GEA 1 m² · NIA 138 m² · Efficiency
// 1159% · Area/WS 0.0 m²". Three separate failures met there: a plate trace that
// locked onto a scratch loop, two NIA owners in the core, and a THIRD owner in
// this panel (`zones.totalArea || m.net_internal_area`). The Rust battery
// (`crates/ds-core/src/metrics_tests.rs`) covers the first two. This covers the
// third, plus the rendering rule that no row may come out empty.
//
// WHAT THIS FILE RUNS AGAINST that the Rust battery cannot: the RELEASE wasm we
// ship (M1's `debug_assert!` did not exist there) and the serde_wasm_bindgen
// boundary the panel actually reads through. Same properties, a different build
// and a different surface.
//
// ---------------------------------------------------------------------------
// THE STANDARD EVERY ASSERTION BELOW IS HELD TO (R13, and the two failures that
// produced it — both found IN THIS FILE, one round apart).
//
//   An assertion earns its place only if there is a change to the SYSTEM UNDER
//   TEST that makes it fail. "No input in its domain can fail it" is not the
//   test on its own — an invariant is supposed to hold for every input; that is
//   what makes it an invariant. The question is whether the assertion is an
//   identity of ITS OWN ALGEBRA (in which case no implementation change can red
//   it either) or an identity of the CURRENT IMPLEMENTATION (in which case a
//   regression reds it, and the regression is exactly what we are guarding).
//
// Three assertions were deleted from this file for failing that test. They are
// recorded here by name, because both of the first two were deleted from the
// RUST twin first and this copy outlived the retraction — a fix landed at one
// call site while the class stayed live, which is the tell `gate-independence.md`
// names.
//
//   [D1] `const rowsNia = (row.area / row.pct_of_nia) * 100`, asserted equal to
//        `m.net_internal_area`, under a comment claiming it recovered the NIA
//        "without asking the core which number it used". The producer defines
//        `pct_of_nia := area / nia * 100`, so the expression substitutes to
//        `area ÷ (area/nia × 100) × 100 ≡ nia` — TRUE FOR EVERY AREAS VECTOR AND
//        EVERY IMPLEMENTATION OF `zone_rows` that computes a percentage at all.
//        It could not be reddened by any change to the subject: scaling every row
//        area by 3.0 left it green in the Rust twin. `metrics_tests.rs:363-388`
//        retracted it BY NAME and replaced it with the direct sum; this copy sat
//        verbatim for two rounds. It also carried a producer veto — `if (row)` —
//        so a `zone_rows` that emitted no positive `pct_of_nia` at all disabled
//        its own test.
//
//   [D2] `if (plate_state === 'traced' && Σ rows.area > gross_external_area)`,
//        guarding a `metrics_error` assertion. UNSATISFIABLE. `area_basis` scales
//        the areas so `Σ rows.area == nia` exactly, and for a traced plate
//        `nia = Σ.min(floor_area)` while `gross_external_area == floor_area` — so
//        `Σ rows.area ≤ gea` identically and the body never ran. Its epsilon was
//        the producer's own 1e-6. An unsatisfiable guard is D1's mirror image:
//        one asserts a truth nothing can break, the other asserts nothing at all.
//        (The same dead condition exists in the producer, `lib.rs:481-487` —
//        reported, not touched from here.)
//
//   [D3] `assert.ok(m.efficiency_pct <= 100)`. The producer's last act before
//        returning is an unconditional `efficiency_pct = efficiency_pct.min(100.0)`
//        (`lib.rs:480`). The assertion restates one producer line and can only be
//        reddened by deleting that line — never by the divergence it was added
//        for, which is precisely why it survived 102.469% shipping underneath it.
//        THE PROPERTY IT MEANT TO ASSERT IS THAT THE CAP EVENT SURFACES, and that
//        is now asserted off the ERROR SURFACE (`ERROR_SURFACE` below), where the
//        clamp cannot hide it.
//
// A fourth was deleted as strictly subsumed: `assert.match(SRC, /unresolved/)`
// sat immediately after `assert.match(SRC, /plate === 'unresolved'/)`. The second
// pattern contains the first, so no source file can fail one and pass the other.
//
// COUNTED, because the count is the kind of claim this file exists to distrust:
// 20 assertion sites before, 34 after. It went UP, and not because more of the
// panel is now watched — 12 of the 14 added are EDIT-LANDING and NON-VACUITY
// guards, which assert that the population the other assertions run over is the
// population the comments claim. Only two are new statements about the panel
// (the direct sum, and the efficiency the rows imply). The four removed were
// counted on every green board and measured nothing, and the file is stronger
// for their absence, not for the arithmetic.
// ---------------------------------------------------------------------------
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
  //
  // R10 AXES — falsified by varying the SHAPE of the declaration: the owner it
  // reads (`m.net_internal_area` → anything else reds the second assert) and the
  // precedence form (`zones.totalArea ||` reds the third).
  // IDENTITY: none. The subject is a source line; every conjunct names a
  // substring a rewrite of that line removes or adds. Nothing here is derived
  // from anything else here.
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

// ---------------------------------------------------------------------------
// THE ERROR SURFACE, FROZEN.
//
// `metrics_error` is the ONLY release-visible evidence that the basis was
// capped: `efficiency_pct` is clamped to 100 before it is returned, so a capped
// panel and an honest 100% panel are byte-identical in every NUMBER. D3 asserted
// the clamped number and therefore watched the one field the defect cannot
// reach. This watches the field it can.
//
// Ground truth is a FROZEN EXPECTATION, not a value read from the producer at
// test time: the exact set of (fixture · edit) states whose basis overflows at
// HEAD, captured from the document geometry these edits produce. It is
// TWO-SIDED — a state not listed must report NO error at all — so both
// "the error surface went silent" and "the error surface reports unconditionally"
// are red, and neither can be reached by weakening one side.
//
// This is the `golden_generate_output_is_frozen` contract (CLAUDE.md): if the
// core deliberately changes which states cap, RE-CAPTURE this set, never relax
// it. **DEPENDENCY, stated because it is live:** a parallel change to
// `crates/ds-core/src/{lib,quantity}.rs` may unify the area basis. If it does,
// this set is what will tell you which states moved.
//
// Captured at HEAD 27c6d5e. 13 capped / 22 clean, over 5 fixtures × (1 unedited
// + 6 edits).
const CAPPED = new Set([
  'F1 · retype every zone to Workspace',
  'F1 · retype every zone to Circulation',
  'F1 · retype every zone to Unassigned',
  'F1 · retype every zone to Workspace, then overlap them',
  'F2 · retype every zone to Workspace',
  'F2 · retype every zone to Circulation',
  'F2 · retype every zone to Unassigned',
  'F2 · retype every zone to Workspace, then overlap them',
  'F4 · retype every zone to Workspace',
  'F4 · retype every zone to Circulation',
  'F4 · retype every zone to Unassigned',
  'F4 · retype every zone to Workspace, then overlap them',
  'F5 · retype every zone to Workspace, then overlap them',
  // W4b: the field-reserve retry rehouses F5's eight dropped rooms INSIDE the
  // field zone (nested, de-overlapped by the basis) — so any blanket retype
  // now removes that de-overlap and genuinely overflows, exactly as
  // F1/F2/F4's plain retypes always have. F5 joins them on all three.
  'F5 · retype every zone to Workspace',
  'F5 · retype every zone to Circulation',
  'F5 · retype every zone to Unassigned',
])

/**
 * The overflow disclosure, anchored to the producer's wording AND to its
 * numbers, so a canned constant cannot satisfy it.
 * `lib.rs` `area_basis`: "zone areas do not tile the floor: Σ {sum:.3} m²
 * exceeds the traced floor {nia:.3} m² by {pct:.1}% (zones overlap). NIA,
 * usable area and efficiency are CAPPED to the floor, not measured."
 */
const OVERFLOW = new RegExp(
  '^zone areas do not tile the floor: \\u03a3 (\\d+\\.\\d+) m\\u00b2 exceeds the ' +
    'traced floor (\\d+\\.\\d+) m\\u00b2 by \\d+\\.\\d+% \\(zones overlap\\)\\. ' +
    'NIA, usable area and efficiency are CAPPED to the floor, not measured\\.$',
)

/** Zone types excluded from "usable" — BCO 2023 / RICS IPMS, per `usable_area`. */
const NOT_USABLE = new Set(['Circulation', 'Core', 'Unassigned'])

/**
 * Every metric row the panel prints, asserted on one `Editor` state.
 * `key` is `${fixture} · ${edit}` and MUST be present in the frozen expectation;
 * an unknown key is a failure, never a skip.
 */
function assertPanelIsRenderable(key, ed, tally) {
  const m = ed.metrics()
  const rows = ed.zone_stats()

  // ---- SHAPE. Every field the panel prints must be a real number (or, for the
  // plate, one of the three declared states). `undefined` renders as a blank
  // slot — the "Area/WS 0.0 m²" half of the screenshot was this.
  //
  // R10 AXES: the FIELD (five, each asserted separately) and the population
  // (every fixture × every edit, below).
  // IDENTITY: none — these are properties of the wasm boundary, not of the
  // arithmetic. A serde change that drops a field, an `Option<f64>` that
  // serialises to `undefined`, a NaN out of a degenerate plate, or a
  // `floor_area()` that goes negative once cores are subtracted from it (the
  // core change now queued) reds this and nothing else here would.
  for (const key2 of [
    'gross_external_area',
    'net_internal_area',
    'workstations',
    'area_per_workstation',
    'efficiency_pct',
  ]) {
    const v = m[key2]
    assert.equal(typeof v, 'number', `${key}: ${key2} is ${v}`)
    assert.ok(Number.isFinite(v), `${key}: ${key2} is ${v}`)
    assert.ok(v >= 0, `${key}: ${key2} is negative (${v})`)
  }
  assert.ok(
    ['traced', 'open', 'unresolved'].includes(m.plate_state),
    `${key}: plate_state is ${JSON.stringify(m.plate_state)} — the panel branches on ` +
      'this string and an unknown value falls through every branch',
  )
  tally.plateStates.add(m.plate_state)

  // A plan with seats must be able to say how much floor each one gets.
  //
  // R10 AXIS: workstation COUNT (0 vs >0 both occur in this population —
  // retyping every zone to Circulation takes it to 0).
  // IDENTITY: none. `area_per_workstation = nia / workstations`, and `nia` is
  // NOT enforced positive anywhere — a document with components but no zones has
  // `workstations > 0` and `nia == 0`, so this assertion has a reachable failing
  // input. (That state is not in this population; see the report.)
  if (m.workstations > 0) {
    tally.withWorkstations++
    assert.ok(
      m.area_per_workstation > 0,
      `${key}: ${m.workstations} workstations but area/WS is ${m.area_per_workstation}`,
    )
  }

  // ---- THE ZONES TAB'S ROWS SUM TO NIA. Asserted DIRECTLY, because the
  // inversion this replaces (D1) could not fail.
  //
  // R10 AXES: the AREAS VECTOR (a second owner in `zone_rows`, or any per-row
  // scaling), the CAP (13 of these states are capped and 22 are not), and the
  // PLATE STATE (traced / open / unresolved all occur here, and the plate state
  // decides whether the cap applies at all).
  // IDENTITY: an identity of the CURRENT IMPLEMENTATION, not of this expression.
  // `Σ row.area == nia` holds only because `zone_rows` and `compute_metrics`
  // read one `AreaBasis`. FALSIFIED, in a disposable worktree with the wasm
  // rebuilt: restoring the pre-fix two-owner form in `zone_rows`
  // (`effective_zone_areas` + `net_internal_area`, computed separately) gives
  // `F1 · retype every zone to Workspace: the Zones tab's 24 rows sum to 940.109
  // but the metrics panel says NIA 930.063` — a donut billing 101.08% of itself.
  // THE FILE THIS REPLACES PASSED 5/5 ON THAT SAME BUILD. Nothing about the
  // SHAPE of this assertion forces it true: `Σ rows` and `nia` arrive over the
  // boundary as unrelated numbers.
  //
  // NO EMPTINESS GUARD, deliberately. The Rust twin still wraps this in
  // `if !rows.is_empty()`, which the ledger flagged as a producer veto: an empty
  // `zone_rows` disables its own test. Empty is not a special case here — zero
  // rows must report NIA 0, and that is the assertion.
  const sumRows = rows.reduce((s, r) => s + r.area, 0)
  assert.ok(
    Math.abs(sumRows - m.net_internal_area) <= 1e-6 * Math.max(sumRows, 1),
    `${key}: the Zones tab's ${rows.length} rows sum to ${sumRows.toFixed(3)} but the ` +
      `metrics panel says NIA ${m.net_internal_area.toFixed(3)} — the donut's slices ` +
      'do not sum to its own total',
  )

  // ---- THE PANEL'S EFFICIENCY IS THE ONE ITS OWN ROWS IMPLY.
  //
  // `efficiency := usable / nia`, and `usable` is a SUBSET of the same basis the
  // rows carry — so recomputing it from the delivered rows and their delivered
  // zone types crosses the numerator/denominator seam M1 opened, on the one field
  // the `.min(100.0)` clamp otherwise sterilises.
  //
  // R10 AXES: the USABLE MEMBERSHIP (`NOT_USABLE` is restated from
  // `usable_area`'s filter, so moving a type on one side only reds) and the VALUE
  // (0% on the all-Circulation states, ~70% unedited, 100% on the all-Workspace
  // ones — three distinct regimes).
  // IDENTITY: none in this expression — the two sides come from two separate
  // wasm calls (`zone_stats()` and `metrics()`) and are joined only by a
  // membership predicate restated here. That restatement is a hand-copy and is
  // named as one: it is a claim about `usable_area`'s filter, verified by
  // sabotage rather than by this comment. FALSIFIED: excluding `ClosedOffice`
  // from `usable_area` on the producer side only gives `F1 · (unedited): the
  // Zones tab's rows imply efficiency 72.7626% (usable 654.710 / NIA 899.789)
  // but the metrics panel prints 69.4429%`, with the file this replaces 5/5
  // green on the same build.
  //
  // MEASURED NULL, recorded because it bounds what this assertion is for.
  // Re-creating M1 EXACTLY — `usable` summed off the raw basis while `nia` stays
  // capped — does NOT red this assertion. `zone_rows` still delivers the capped
  // areas, so this recomputation reads 100.000 and agrees with the clamped
  // 100.000 the panel prints. That regression is caught one assertion down, by
  // the error surface: it emits `efficiency 101.080% exceeds 100 (usable 940.109
  // / NIA 930.063, plate traced) — capped at 100%` joined onto the overflow
  // sentence, and the exact-match below reds on it. The file this replaces was
  // 5/5 green on that build with 101.080% live behind the clamp. So: the cap
  // EVENT is what catches M1; this assertion catches the membership and basis
  // divergences that never reach the producer's own backstop.
  //
  // OVERLAP, DECLARED (no-bloat): `export/foldParity.test.mjs:90-94` asserts the
  // same equality. It is not a duplicate and this is not a merge candidate — the
  // POPULATIONS are disjoint and the population is the point. foldParity runs on
  // `generate()`d documents at several seeds and never edits one; every state it
  // visits is uncapped, which is exactly the population M1 was invisible in. This
  // one runs on the five fixtures under six edits, 13 of whose 35 states are
  // capped. Same property, the half of the domain the other one cannot reach.
  const usable = rows
    .filter((r) => !NOT_USABLE.has(r.zone_type))
    .reduce((s, r) => s + r.area, 0)
  const rowsEff = m.net_internal_area > 0 ? (usable / m.net_internal_area) * 100 : 0
  if (rowsEff > 0) tally.withEfficiency++
  assert.ok(
    Math.abs(rowsEff - m.efficiency_pct) <= 1e-6 * Math.max(rowsEff, 1),
    `${key}: the Zones tab's rows imply efficiency ${rowsEff.toFixed(4)}% ` +
      `(usable ${usable.toFixed(3)} / NIA ${m.net_internal_area.toFixed(3)}) but the ` +
      `metrics panel prints ${m.efficiency_pct.toFixed(4)}% — the numerator and the ` +
      'denominator are not on one basis, which is M1',
  )

  // ---- THE ERROR SURFACE, EXACTLY.
  //
  // R10 AXES: the CAP (16 capped states and 19 clean ones, so both sides carry
  // load), the PLATE STATE (F3 is unresolved and therefore cannot cap however
  // far its zones overflow — 993.549 m² of zones on a 1594.938 m² bbox and no
  // error, correctly), and the EDIT (type, count, overlap and plate all vary the
  // membership).
  // IDENTITY: none. The expectation is frozen text compared against a string the
  // producer emits; silencing the surface reds the capped side, forcing it on
  // reds the clean side, and moving which states cap reds the set-equality
  // assertion in the caller.
  const expectCap = CAPPED.has(key)
  assert.ok(
    m.metrics_error === undefined ||
      m.metrics_error === null ||
      typeof m.metrics_error === 'string',
    `${key}: metrics_error must be absent or a sentence, got ${typeof m.metrics_error}`,
  )
  if (expectCap) {
    tally.capped++
    assert.equal(
      typeof m.metrics_error,
      'string',
      `${key}: the basis is capped here and metrics_error is ` +
        `${JSON.stringify(m.metrics_error)} — a cap the panel cannot report is a ` +
        'debug_assert with extra steps, and efficiency_pct is clamped to 100 so ' +
        'no NUMBER on this panel can tell you it happened',
    )
    const mm = OVERFLOW.exec(m.metrics_error)
    assert.ok(
      mm,
      `${key}: metrics_error does not read as the overflow disclosure — an extra ` +
        'error joined with " · " is itself a finding, not noise: ' +
        JSON.stringify(m.metrics_error),
    )
    // The disclosure must describe THIS panel's numbers, not a canned sentence.
    // `.3` formatting bounds the honest gap at 5e-4.
    //
    // IDENTITY: none. The sentence quotes the `nia` its own `AreaBasis` computed;
    // `m.net_internal_area` is the field the panel renders. Reverting to the
    // two-owner form — `net_internal_area` recomputed separately for the returned
    // metric — makes these two numbers different, which is the 1159% defect's
    // exact shape.
    const quotedNia = Number(mm[2])
    assert.ok(
      Math.abs(quotedNia - m.net_internal_area) < 1e-3,
      `${key}: the cap disclosure quotes a floor of ${quotedNia} but the panel ` +
        `renders NIA ${m.net_internal_area} — two NIA owners again`,
    )
  } else {
    tally.clean++
    assert.ok(
      m.metrics_error === undefined || m.metrics_error === null,
      `${key}: nothing overflows here, so the panel must report no error — got ` +
        JSON.stringify(m.metrics_error),
    )
  }
  return m
}

// THE EDITED POPULATION — the half that was missing.
//
// This file asserted `efficiency_pct <= 100` on five UNEDITED fixtures and
// passed while `102.469%` was four clicks away: load F4, retype every zone to
// Workspace. A guard's frame is part of the guard, and a frame drawn around the
// state the fixture ships in tests the fixture, not the product. Both
// populations, always.
//
// R10 AXES — this population varies: zone TYPE (retype ALL, not one), zone COUNT
// and OVERLAP (new zones laid over existing ones), plate STATE (a deleted plate
// wall drives it to open or unresolved), and the BUILD — it runs against the
// release wasm, where M1's `debug_assert!` did not exist.
//
// EVERY EDIT ASSERTS THAT IT LANDED. The previous forms silently degraded:
// `if (w) ed.set_wall(...)` turned the plate-state edit into a plain retype when
// no non-generated wall was found, and a `try {} catch {}` around `add_zone`
// swallowed every refusal, so the overlap axis could be claimed in a comment and
// exercised on nothing. An unlanded edit is a failure, never a skip.
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
  'retype every zone to Unassigned': (ed) => {
    const zones = ed.state().zones
    assert.ok(zones.length > 0, 'nothing to retype')
    for (const z of zones) ed.set_zone_type(z.id, 'Unassigned')
  },
  'lay overlapping Workspace zones over the plan': (ed) => {
    const before = ed.state().zones.length
    let landed = 0
    for (const z of ed.state().zones.slice(0, 6)) {
      if (z.shape.kind !== 'Rect') continue
      // Deliberately overlapping the zone it is copied from. `add_zone` refuses
      // an off-plate shape, so this stays inside the plate and the overlap is
      // with SIBLINGS — which is legal, and is the state under test.
      try {
        ed.add_zone('Workspace', z.shape.x, z.shape.y, z.shape.w, z.shape.h, 'overlap')
        landed++
      } catch {
        /* off-plate copies are refused by design; the in-bounds ones land */
      }
    }
    // Non-vacuity, per invocation. If every copy is refused the overlap axis is
    // untested and the R10 statement above becomes a claim about nothing.
    assert.ok(landed > 0, 'no overlapping zone landed — the overlap axis is not varied')
    assert.equal(
      ed.state().zones.length,
      before + landed,
      'add_zone reported success without adding a zone',
    )
  },
  'retype every zone to Workspace, then overlap them': (ed) => {
    EDITS['retype every zone to Workspace'](ed)
    EDITS['lay overlapping Workspace zones over the plan'](ed)
  },
  'delete a plate wall, then retype every zone to Workspace': (ed) => {
    const w = ed.state().walls.find((w) => !w.generated)
    // Was `if (w)`. Without a wall to collapse the plate never leaves `traced`
    // and the plate-STATE axis is silently unexercised.
    assert.ok(w, 'no non-generated wall — the plate-state axis cannot be varied')
    ed.set_wall(w.id, 0, 0, 0, 0)
    const after = ed.state().walls.find((x) => x.id === w.id)
    assert.ok(
      after && after.a.x === 0 && after.a.y === 0 && after.b.x === 0 && after.b.y === 0,
      `set_wall did not take: ${JSON.stringify(after)}`,
    )
    EDITS['retype every zone to Workspace'](ed)
  },
}

test('every fixture and every edited fixture renders a possible panel', () => {
  const ids = Editor.fixture_ids()
  assert.ok(ids.length >= 5, `expected the fixture set, got ${JSON.stringify(ids)}`)

  const tally = {
    capped: 0,
    clean: 0,
    withWorkstations: 0,
    withEfficiency: 0,
    plateStates: new Set(),
  }
  const observedCaps = new Set()
  const keys = []

  for (const id of ids) {
    for (const [what, edit] of [['(unedited)', null], ...Object.entries(EDITS)]) {
      const ed = new Editor()
      ed.load_fixture(id)
      if (edit) edit(ed)
      const key = `${id} · ${what}`
      keys.push(key)
      const m = assertPanelIsRenderable(key, ed, tally)
      if (m.metrics_error) observedCaps.add(key)
    }
  }

  // THE FROZEN SET, BOTH DIRECTIONS — and it catches the one drift the per-state
  // assertions structurally cannot: a key pinned in `CAPPED` that NO state
  // produces. A phantom key (a typo, or a fixture that was renamed) is never
  // visited, so no per-state assertion covers it and it would sit here forever
  // pinning nothing. It lands in `missing`.
  //
  // R10 AXES: membership in both directions (a state that stops capping → the
  // per-state check reds first, measured; a state that starts capping → likewise;
  // a phantom pin → only this reds, measured).
  // IDENTITY: none — the two sets are built from different things, one frozen in
  // this file and one accumulated from the producer.
  //
  // (`for (const k of CAPPED) assert(keys.includes(k))` was written here and
  // DELETED: `deepEqual` passing implies `CAPPED === observedCaps ⊆ keys`, so
  // that loop could not fail while this one passed. Strictly subsumed, same
  // reason as the `/unresolved/` match recorded in the header.)
  const missing = [...CAPPED].filter((k) => !observedCaps.has(k))
  const extra = [...observedCaps].filter((k) => !CAPPED.has(k))
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'the set of states whose basis is capped has moved. RE-CAPTURE it, do not ' +
      'relax it — and say which core change moved it.',
  )

  // NON-VACUITY, per axis this file claims to vary. Each of these was a real
  // failure mode: a population that reaches only one side of a two-sided check
  // tests one side of it.
  assert.ok(tally.capped >= 5, `only ${tally.capped} capped states — the cap side is thin`)
  assert.ok(tally.clean >= 5, `only ${tally.clean} clean states — the clean side is thin`)
  assert.ok(
    tally.withWorkstations > 0,
    'no state has workstations > 0 — the area/WS assertion never ran',
  )
  assert.ok(
    tally.withEfficiency > 0,
    'no state has a positive efficiency — the efficiency agreement is 0 == 0 everywhere',
  )
  assert.deepEqual(
    [...tally.plateStates].sort(),
    ['open', 'traced', 'unresolved'],
    'the plate-STATE axis is claimed in three R10 statements above; all three ' +
      'states must actually occur in this population',
  )
  console.log(
    `PANEL STATES: ${keys.length} (${tally.capped} capped, ${tally.clean} clean), ` +
      `plate ${[...tally.plateStates].sort().join('/')}`,
  )
})

test('the reported M1 state — F4 with every zone retyped to Workspace', () => {
  // R13's motivating divergence, kept as its own test because it is the exact
  // four clicks from the defect report and must be findable by name.
  const ed = new Editor()
  ed.load_fixture('F4')
  const before = ed.metrics()
  for (const z of ed.state().zones) ed.set_zone_type(z.id, 'Workspace')
  const after = ed.metrics()
  console.log(
    `M1: eff ${before.efficiency_pct.toFixed(3)}% -> ${after.efficiency_pct.toFixed(3)}%, ` +
      `GEA ${after.gross_external_area.toFixed(3)} NIA ${after.net_internal_area.toFixed(3)}`,
  )
  // NOT `after.efficiency_pct <= 100` (D3): the producer clamps, so that reads
  // 100 whether or not the defect is live. The cap EVENT is the evidence.
  //
  // R10 AXES: the error surface (silenced → red) and the wording (the cap
  // reported as some other sentence → red).
  // IDENTITY: none. `metrics_error` is `Option<String>`; `None` reds this.
  assert.equal(
    typeof after.metrics_error,
    'string',
    'the cap must be reported, not applied silently: ' + JSON.stringify(after.metrics_error),
  )
  assert.match(after.metrics_error, OVERFLOW, 'the cap must name the overflow')
  // And the panel must be able to render it.
  assert.match(
    SRC,
    /metrics_error/,
    'StatsPanel must read metrics_error — a release-visible error state nothing ' +
      'displays is a debug_assert with extra steps',
  )
})

test('an unresolved plate reaches the panel as a state, not as a number', () => {
  // R10 AXES: the fixture's plate resolution (F3's GEA collapse) and the panel's
  // branch set. IDENTITY: none — `plate_state` is a producer string compared
  // against a literal, and the source match names a substring a rewrite removes.
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
})
