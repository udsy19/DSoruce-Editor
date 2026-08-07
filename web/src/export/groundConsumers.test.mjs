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
// A synthetic document: one 4x4 m zone per ZoneType, laid in a row, each with
// one Desk at its centre. Pure data — no generator involvement, so the
// population under test is exactly the type space and nothing else.
// ---------------------------------------------------------------------------

const ZONE_W = 4
const zones = ALL_TYPES.map((t, i) => ({
  id: 100 + i,
  zone_type: t,
  label: `Zone ${t}`,
  shape: { kind: 'Rect', x: i * ZONE_W + ZONE_W / 2, y: ZONE_W / 2, w: ZONE_W, h: ZONE_W },
  component_ids: [],
  origin: 'Drawn',
}))
const components = ALL_TYPES.map((t, i) => ({
  id: 200 + i,
  category: 'Desk',
  x: i * ZONE_W + ZONE_W / 2,
  y: ZONE_W / 2,
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
}))
const W = ALL_TYPES.length * ZONE_W
const walls = [
  [[0, 0], [W, 0]], [[W, 0], [W, ZONE_W]], [[W, ZONE_W], [0, ZONE_W]], [[0, ZONE_W], [0, 0]],
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

// The space mix's `shared` bucket is GROUND + Core. Every ground zone here is
// 16 m², so shared must be at least the ground zones' area — read as a VALUE.
// EQUALITY, not `>=`. The first version of this asserted `shared >= groundArea`
// and would NOT have redded on the very sabotage it exists to catch: narrowing
// the mix set to Circulation-only takes shared 48 -> 32 m², still >= the 32 m² of
// ground. A bound that the defect satisfies is not a check — R19's demonstration
// standard applied to my own assertion.
const sharedTypes = new Set([...GROUND, 'Core'])
const wantShared = sharedTypes.size * ZONE_W * ZONE_W
ok(
  'kpis.spaceMix.shared is exactly the GROUND + Core area',
  Math.abs((kpis.spaceMix?.shared ?? 0) - wantShared) < 1e-6,
  `shared ${kpis.spaceMix?.shared?.toFixed(2)} m², expected ${wantShared.toFixed(2)} m² ` +
    `for {${[...sharedTypes].join(',')}} — the mix no longer follows the fold`,
)

// Privacy: a desk standing in a GROUND zone is open-plan, never private. With
// one desk per type, privacy% can never exceed the non-open share.
const openTypes = new Set([...GROUND, 'Workspace'])
const maxPrivatePct = ((ALL_TYPES.length - openTypes.size) / ALL_TYPES.length) * 100
ok(
  'kpis.privacyPct counts desks in GROUND zones as OPEN',
  (kpis.privacyPct ?? 0) <= maxPrivatePct + 1e-6,
  `privacy ${kpis.privacyPct?.toFixed(1)}% > ${maxPrivatePct.toFixed(1)}% — ` +
    'a desk standing on ground was counted as enclosed',
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
