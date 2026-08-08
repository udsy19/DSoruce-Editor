// **MIGRATING IS NOT GUARDING** — the follow-automatically guard for every
// consumer that derives a set from the published GROUND fold.
// Run from web/:  node src/export/groundConsumers.test.mjs
//
// @covers: web/src/export/planGraphic.ts
// @covers: web/src/export/kpis.ts
// @covers: crates/ds-core/src/lib.rs  (published_zone_type / is_ground_zone / ground_zone_types)
//
// WHY THIS EXISTS
// ---------------
// Last round migrated ~25 hand-spelled `Circulation | Unassigned` sets onto the
// one fold. The adversary then narrowed each migrated consumer back to
// `Circulation`-only and ran every board. **Three of five stayed GREEN** —
// `planGraphic.ts`, `kpis.ts` and `conform.rs`. The migration was real and
// nothing on earth was checking it, so the next editor could undo it silently
// and the boards would applaud.
//
// A consumer that reads the right value today is not guarded. This is the guard.
//
// R20 — READ THE VALUE, NOT THE FORM
// ----------------------------------
// Both sides are obtained by EVALUATION, never by parsing source:
//   * the EXPECTED ground set comes from `Editor.ground_zone_types()`, which
//     runs every `ZoneType` through the core's `is_ground_zone`. It is the
//     predicate's own answer.
//   * the ACTUAL behaviour comes from CALLING the consumers — `planRoomList`
//     returns rooms, `computeAltKpis` returns numbers — and reading what they
//     produced.
// The regex this replaces was defeated by a prose comment and evaded by an `if`,
// both with semantics unchanged. Neither can touch a value.
//
// FOLLOW-AUTOMATICALLY, stated as the property
// --------------------------------------------
// Nothing here names `Circulation` or `Unassigned`. Grow the core's ground set
// and every expectation below grows with it; a consumer that did NOT follow is
// the one that reds. That is what makes the migration permanent rather than
// merely current.
//
// FALSIFICATIONS (recorded in the ledger, run in a disposable worktree):
//   * narrow `NON_ROOM_ZONES` to Circulation-only  -> RED (a ground room is scheduled)
//   * narrow `OPEN_ZONE_TYPES` to Circulation-only -> RED (a ground desk reads private)
//   * narrow the `shared:` mix set                 -> RED (ground area leaves shared)
//   * add a type to the core fold, consumers follow -> GREEN, and the expectation
//     moved with it (proved by asserting the expected set actually changed)

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wasmPath = path.join(here, '../wasm/ds_core_bg.wasm')
// A MISSING SUBJECT IS A FAILURE, NEVER A SKIP.
if (!fs.existsSync(wasmPath)) {
  console.error(`ground-consumers FAIL: no wasm at ${wasmPath} — run \`make wasm\``)
  process.exit(1)
}

const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const bundle = async (contents) => {
  const out = path.join(os.tmpdir(), `ds-gc-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({
    stdin: { contents, resolveDir: here, loader: 'ts' },
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const m = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return m
}



// `planGraphic.ts` builds canvas textures at module load, so a minimal DOM stub
// has to exist before it is imported. Only enough for `createElement('canvas')`
// to return something with a 2D-ish context — nothing here is under test, and
// `planRoomList` itself is pure over `DocState`.
// `planGraphic.ts` transitively reaches `three/furniture3d.ts`, which builds
// canvas textures at MODULE LOAD. A Proxy-backed 2D context answers whatever the
// texture painters call without this test having to enumerate them — the stub is
// scaffolding, not a subject, and `planRoomList` itself is pure over `DocState`.
const ctxStub = new Proxy(
  {},
  {
    get: (_t, k) => (k === 'canvas' ? { width: 1, height: 1 } : () => ctxStub),
    set: () => true,
  },
)
globalThis.document = globalThis.document ?? {
  createElement: () => ({ width: 1, height: 1, getContext: () => ctxStub, style: {} }),
}

// ONE BUNDLE for the core and both consumers.
//
// Bundling them separately gives each its own copy of the wasm module, and the
// uninitialised one throws `Cannot read properties of undefined (reading
// 'editor_from_snapshot')` — which looks exactly like a broken export and is the
// trap CLAUDE.md names: *verify through the app's own module graph, not a
// hand-rolled import of the same file*. One graph, one instance, one `initSync`.
const mod = await bundle(`
  export { Editor, initSync } from '../wasm/ds_core'
  export { planRoomList } from './planGraphic'
  export { computeAltKpis } from './kpis'
`)
mod.initSync({ module: fs.readFileSync(wasmPath) })
const { Editor, planRoomList, computeAltKpis } = mod

let failures = 0
let checks = 0
const ok = (label, cond, detail = '') => {
  checks++
  if (!cond) {
    failures++
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// The expected ground set — BY EVALUATION (R20)
// ---------------------------------------------------------------------------

const GROUND = new Set(Editor.ground_zone_types())
ok('the core publishes a ground set', GROUND.size > 0, `got ${JSON.stringify([...GROUND])}`)
// Non-vacuity: an empty or total ground set makes every assertion below pass for
// the wrong reason.
// THE TYPE SPACE, DERIVED FROM THE CORE — not a third authored copy.
//
// This was a hand-written eight-element array, and it was one of three: the
// wasm export iterated its own literal, `zone.rs`'s test module iterated
// another, and this was the third. A ninth ground variant was invisible to all
// of them while every board stayed green — the `authored domain` class.
// `Editor.zone_type_names()` publishes `ZoneType::ALL`, whose completeness is a
// compile error away.
const ALL_TYPES = Editor.zone_type_names()
ok('the core publishes its type space', ALL_TYPES.length >= 4, `${ALL_TYPES.length} types`)
ok(
  'every ground type is a member of the published type space',
  [...GROUND].every((t) => ALL_TYPES.includes(t)),
  `ground ${JSON.stringify([...GROUND])} vs types ${JSON.stringify(ALL_TYPES)} — ` +
    'the ground set names a type the type space does not, so one of them is authored',
)
ok(
  'the ground set is a proper non-empty subset of the type space',
  GROUND.size > 0 && GROUND.size < ALL_TYPES.length,
  `${GROUND.size} of ${ALL_TYPES.length}`,
)

// ---------------------------------------------------------------------------
// A synthetic document: one zone per ZoneType, laid in a row.
//
// **THE SYMMETRY IS BROKEN ON PURPOSE — every zone has a DISTINCT area and a
// DISTINCT desk count.** This fixture used to give every zone 16 m² and exactly
// one desk, and that uniformity silently downgraded three assertions below from
// membership tests to CARDINALITY tests: with all areas equal, `shared` is
// `|sharedTypes| x 16` and cannot say WHICH types were summed, so swapping
// `Core` for `Amenity` in the consumer's mix set PASSED. With one desk per zone
// the same was true of privacy — swapping `Workspace` for `Meeting` in the open
// set PASSED. A fixture whose members are interchangeable cannot distinguish a
// set from its size, however carefully the assertion is written.
//
//   zone i : 4 m wide x (2 + i) m tall  -> areas 8, 12, 16, 20 ... all distinct
//   zone i : (i + 1) desks              -> desk weights 1, 2, 3, 4 ... all distinct
//
// Both sequences are strictly increasing, so no subset of them sums to the same
// number as a different subset of the same size — which is precisely the
// property that lets the assertions below name a MEMBER rather than a count.
// The non-degeneracy is asserted, not assumed (see the two checks after this
// block): a future edit that flattens the areas again must be a red, not a
// silent return to measuring nothing.
// ---------------------------------------------------------------------------

const ZONE_W = 4
const zoneH = (i) => 2 + i
const deskCount = (i) => i + 1
const syntheticAreaOf = (i) => ZONE_W * zoneH(i)
const zones = ALL_TYPES.map((t, i) => ({
  id: 100 + i,
  zone_type: t,
  label: `Zone ${t}`,
  shape: { kind: 'Rect', x: i * ZONE_W + ZONE_W / 2, y: zoneH(i) / 2, w: ZONE_W, h: zoneH(i) },
  component_ids: [],
  origin: 'Drawn',
}))
// (i + 1) desks in zone i, stacked near its bottom edge so every one of them
// falls inside even the shortest zone (2 m tall, one desk).
const components = ALL_TYPES.flatMap((t, i) =>
  Array.from({ length: deskCount(i) }, (_, k) => ({
    id: 200 + i * 100 + k,
    category: 'Desk',
    x: i * ZONE_W + ZONE_W / 2,
    y: 0.4 + k * 0.15,
    w: 1.4,
    h: 0.7,
    rotation: 0,
    seats: 1,
    decision: 'Open',
    reference: false,
    label: 'Desk',
    mirror: false,
    price_inr: null,
    product_id: null,
  })),
)
const W = ALL_TYPES.length * ZONE_W
const H = Math.max(...ALL_TYPES.map((_, i) => zoneH(i)))
const walls = [
  [[0, 0], [W, 0]], [[W, 0], [W, H]], [[W, H], [0, H]], [[0, H], [0, 0]],
].map(([a, b], i) => ({
  id: 300 + i,
  a: { x: a[0], y: a[1] },
  b: { x: b[0], y: b[1] },
  thickness: 0.15,
  generated: false,
  glazing: false,
  height_m: null,
}))
const state = { zones, components, walls, keepouts: [], entries: [], anchors: [], selection: null, next_id: 999 }

// THE SYMMETRY BREAK IS ITSELF CHECKED. Every assertion below that names a
// member rather than a count depends on these two being true; if a later edit
// flattens the fixture, these reds say so instead of the membership checks
// quietly degrading into cardinality checks again — which is exactly how the
// previous version passed while measuring nothing.
ok(
  'the fixture gives every zone a DISTINCT area (membership is separable from cardinality)',
  new Set(ALL_TYPES.map((_, i) => syntheticAreaOf(i))).size === ALL_TYPES.length,
  `areas ${JSON.stringify(ALL_TYPES.map((_, i) => syntheticAreaOf(i)))} contain a duplicate — ` +
    'two interchangeable zones make an area sum unable to name which types it summed',
)
ok(
  'the fixture gives every zone a DISTINCT desk count',
  new Set(ALL_TYPES.map((_, i) => deskCount(i))).size === ALL_TYPES.length,
  `desk counts ${JSON.stringify(ALL_TYPES.map((_, i) => deskCount(i)))} contain a duplicate — ` +
    'equal weights make a desk ratio unable to name which zones were open',
)

// ---------------------------------------------------------------------------
// 1. planGraphic.planRoomList — a GROUND zone is never a schedulable room
// ---------------------------------------------------------------------------
//
// `NON_ROOM_ZONES` is GROUND + Core. The expectation is computed from the core's
// ground set, so it moves when the fold moves.

const rooms = planRoomList(state)
ok('planRoomList returns rooms at all', rooms.length > 0, `${rooms.length}`)

const listedTypes = new Set(
  rooms
    .map((r) => zones.find((z) => z.id === r.zoneId ?? z.id === r.id))
    .filter(Boolean)
    .map((z) => z.zone_type),
)
// Fall back to matching by label when the row shape differs, so a schema change
// cannot make this silently measure nothing.
const listedByLabel = new Set(
  ALL_TYPES.filter((t) => rooms.some((r) => JSON.stringify(r).includes(`Zone ${t}`))),
)
const listed = listedTypes.size > 0 ? listedTypes : listedByLabel
ok(
  'planRoomList: the room set is non-empty (the check is not vacuous)',
  listed.size > 0,
  `rows: ${JSON.stringify(rooms.slice(0, 2))}`,
)
for (const t of ALL_TYPES) {
  if (GROUND.has(t)) {
    ok(
      `planRoomList excludes GROUND type '${t}'`,
      !listed.has(t),
      'a ground zone was scheduled as a room — the consumer no longer follows the fold',
    )
  }
}

// THE MISSING UPPER BOUND. Everything above is one-sided: it asserts ground
// types are ABSENT and never that anything is PRESENT, so a consumer that
// scheduled no rooms at all — or widened `NON_ROOM_ZONES` to swallow real room
// types — satisfied every check. Measured on the previous version: widening
// `NON_ROOM_ZONES` by two genuine room types took the room list 6 -> 4 and
// PASSED. A set is pinned by both of its sides or by neither.
//
// `planGraphic` excludes GROUND + `Core` (a WC or riser is a real room but is
// not scheduled here), so the complement — every other published type — must
// appear. Derived from the core's fold, not spelled out, so it follows the
// domain.
for (const t of ALL_TYPES) {
  if (!GROUND.has(t) && t !== 'Core') {
    ok(
      `planRoomList INCLUDES non-ground room type '${t}'`,
      listed.has(t),
      `'${t}' is neither ground nor Core yet no row names it — the consumer is excluding ` +
        'more than the fold, which the ground-only assertions above cannot see',
    )
  }
}

// ---------------------------------------------------------------------------
// 2. kpis — ground is OPEN (privacy) and ground area is SHARED (space mix)
// ---------------------------------------------------------------------------
//
// Built through the real Editor so `computeAltKpis` gets the snapshot it expects.

const ed = new Editor()
for (const w of walls) ed.add_wall(w.a.x, w.a.y, w.b.x, w.b.y, w.thickness)
const addedZoneIds = []
for (const z of zones) {
  try {
    addedZoneIds.push(ed.add_zone(z.zone_type, z.shape.x, z.shape.y, z.shape.w, z.shape.h, z.label))
  } catch {
    /* a type the core refuses here is reported by the count check below */
  }
}
ok(
  'every synthetic zone landed in the core (the KPI population is complete)',
  addedZoneIds.length === ALL_TYPES.length,
  `${addedZoneIds.length} of ${ALL_TYPES.length} — an edit that did not land makes the KPI checks vacuous`,
)
for (const c of components) ed.add_component(c.category, c.x, c.y, c.w, c.h)

const snapshot = ed.snapshot()
const kpis = computeAltKpis({ id: 'gc', name: 'ground-consumers', snapshot })

// The space mix's `shared` bucket is GROUND + Core, read as a VALUE.
//
// EQUALITY, not `>=`. The first version asserted `shared >= groundArea` and would
// NOT have redded on the sabotage it exists to catch: narrowing the mix set to
// Circulation-only takes shared 48 -> 32 m², still >= the 32 m² of ground. A
// bound the defect satisfies is not a check.
//
// **AND EQUALITY WAS STILL NOT ENOUGH.** `wantShared` was `sharedTypes.size x 16`
// — with a uniform fixture, the size of the set and not its members. Swapping
// `Core` for `Amenity` in the consumer's mix leaves the count at 3 and the
// product at 48 m², and the assertion PASSED on a mix that had stopped billing
// Core. The expectation is now the SUM OF THE PARTICULAR ZONES' AREAS, which
// with the areas all distinct is unique to that exact membership.
const sharedTypes = new Set([...GROUND, 'Core'])
const wantShared = ALL_TYPES.reduce((s, t, i) => (sharedTypes.has(t) ? s + syntheticAreaOf(i) : s), 0)
ok(
  'kpis.spaceMix.shared is exactly the area of the GROUND + Core zones (by membership)',
  Math.abs((kpis.spaceMix?.shared ?? 0) - wantShared) < 1e-6,
  `shared ${kpis.spaceMix?.shared?.toFixed(2)} m², expected ${wantShared.toFixed(2)} m² for ` +
    `{${[...sharedTypes].join(',')}} = ${ALL_TYPES.filter((t) => sharedTypes.has(t)).map((t) => `${t}:${syntheticAreaOf(ALL_TYPES.indexOf(t))}`).join(' + ')}` +
    ' — the mix is summing a different set of types',
)

// Privacy: a desk standing in a GROUND zone is open-plan, never private.
//
// This was a BOUND over a uniform population — `privacy <= (|types| - |open|) /
// |types|` — which is the open set's SIZE and not its members. Swapping
// `Workspace` for `Meeting` in the consumer's open set holds the size at 3, so
// the ceiling never moved and the assertion PASSED while privacy was being
// computed over the wrong rooms.
//
// With (i + 1) desks in zone i the desks are weighted, so the ratio is unique to
// the exact set of zones the consumer treated as open — and the assertion is an
// EQUALITY against that ratio. The expectation is derived from the property
// (ground is open-plan, and so is the open workspace floor), never read from the
// consumer's own set.
const openTypes = new Set([...GROUND, 'Workspace'])
const totalDesks = ALL_TYPES.reduce((s, _t, i) => s + deskCount(i), 0)
const enclosedDesks = ALL_TYPES.reduce((s, t, i) => (openTypes.has(t) ? s : s + deskCount(i)), 0)
const wantPrivacyPct = (enclosedDesks / totalDesks) * 100
ok(
  'kpis.privacyPct is exactly the desk-weighted share outside the OPEN set (by membership)',
  Math.abs((kpis.privacyPct ?? 0) - wantPrivacyPct) < 1e-6,
  `privacy ${kpis.privacyPct?.toFixed(3)}%, expected ${wantPrivacyPct.toFixed(3)}% ` +
    `(${enclosedDesks}/${totalDesks} desks outside {${[...openTypes].join(',')}}) — ` +
    'the consumer is treating a different set of zones as open-plan',
)

// ---------------------------------------------------------------------------

if (failures === 0) {
  console.log(
    `ground-consumers PASS (${checks} checks) — ground=${JSON.stringify([...GROUND])}, ` +
      `${rooms.length} rooms, shared=${kpis.spaceMix?.shared?.toFixed(1)} m², privacy=${kpis.privacyPct?.toFixed(1)}%`,
  )
  process.exit(0)
}
console.log(`ground-consumers FAIL (${checks} checks, ${failures} failing)`)
process.exit(1)
