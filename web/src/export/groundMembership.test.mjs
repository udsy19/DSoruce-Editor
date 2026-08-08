// GROUND **MEMBERSHIP** IS LOAD-BEARING — the mutation class the battery lacked.
// Run from web/:  node src/export/groundMembership.test.mjs
//
// @covers: web/src/export/planGraphic.ts   (planRoomList — the circulation anchor)
// @covers: web/src/export/takeoff.ts       (zoneAtPoint — ground never outranks a room)
//
// WHY THIS EXISTS, AND WHY IT IS NOT `groundConsumers.test.mjs`
// -------------------------------------------------------------
// `groundConsumers.test.mjs` asks *does each consumer read today's fold value*.
// This asks a different question: *is each ground type's MEMBERSHIP of the fold
// observable in what the consumer produces* — established by PERTURBING the
// document and requiring a behavioural delta. Different responsibility, so a
// separate file rather than an extension (`.claude/rules/no-bloat.md`).
//
// It exists because the battery could not see the defect it is named for.
// MEASURED, this session, before a line of it was written: narrowing
// `isGroundZone` inside `planGraphic.ts` to `t === 'Circulation'` — dropping
// `Unassigned` from the fold at both of that file's call sites — left
//
//     bash scripts/verify-all.sh --full   ->  VERIFY OK — 53/53 steps green
//
// **and the sabotage was not inert.** That distinction is the whole finding, and
// it was nearly missed: the seeded demo document contains ZERO `Unassigned`
// zones (measured: ClosedOffice 8, Amenity 7, Meeting 4, Collaboration 1,
// Circulation 2, Workspace 1, Core 1), so on the battery's own population the
// narrowed predicate and the real one AGREE ON EVERY ZONE PRESENT. A green board
// there would have been an inert sabotage, not a blind gate — a null
// indistinguishable from a guard that works. It was separated by building a
// document that *does* contain each ground type and showing the narrowed build
// answers differently (`MEMBERSHIP_OBSERVABLE=false` for `Unassigned`). Only then
// is 53/53 genuine blindness.
//
// The lesson generalises past `isGroundZone`: **a fold whose members never
// appear in any fixture is unguarded no matter how many consumers read it.** So
// this file derives the ground set from the core and MANUFACTURES a document per
// member, rather than hoping the generator emits one.
//
// R20 — READ THE VALUE, NOT THE FORM. Nothing here parses source. The ground set
// is `Editor.ground_zone_types()` (the predicate's own answer) and the observed
// behaviour is the consumers' return values. Nothing names `Circulation` or
// `Unassigned`: grow the core's fold and this file grows with it.
//
// R10 AXES — what the falsification varies:
//   * MEMBERSHIP (the point): drop ONE type from a consumer's ground predicate
//     while leaving the others. A cardinality check cannot see this; every
//     assertion below is per-type and names the type it lost.
//   * DIRECTION: each type is checked in BOTH states — as ground, and retyped to
//     a program type — and the two must DIFFER. A consumer that ignores the fold
//     entirely answers the same both ways and reds on the delta assertion, so a
//     narrowing cannot hide by making both sides equally wrong.
//   * NON-VACUITY: the fold must be a non-empty proper subset of the type space,
//     and every manufactured document is asserted to actually contain its zone.
//
// FALSIFICATION (run in a disposable worktree, recorded in the ledger):
//   narrow `isGroundZone` in planGraphic.ts to Circulation-only
//     -> ground-membership FAIL, naming `Unassigned` at planRoomList
//     -> the battery goes 53/53 green  ->  54/54 with this file, 1 red
//   narrow `isGroundZone` in takeoff.ts the same way
//     -> ground-membership FAIL, naming `Unassigned` at zoneAtPoint

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wasmPath = path.join(here, '../wasm/ds_core_bg.wasm')
// A MISSING SUBJECT IS A FAILURE, NEVER A SKIP.
if (!fs.existsSync(wasmPath)) {
  console.error(`ground-membership FAIL: no wasm at ${wasmPath} — run \`make wasm\``)
  process.exit(1)
}

const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

// `planGraphic.ts` transitively builds canvas textures at MODULE LOAD. A
// Proxy-backed 2D context answers whatever the texture painters call without
// this test enumerating them — scaffolding, not a subject. Both functions under
// test are pure over `DocState`.
const ctxStub = new Proxy(
  {},
  { get: (_t, k) => (k === 'canvas' ? { width: 1, height: 1 } : () => ctxStub), set: () => true },
)
globalThis.document = globalThis.document ?? {
  createElement: () => ({ width: 1, height: 1, getContext: () => ctxStub, style: {} }),
}

// ONE BUNDLE, one wasm instance — bundling separately gives each consumer its own
// uninitialised copy, which throws and looks exactly like a broken export
// (CLAUDE.md: verify through the app's own module graph).
const outFile = path.join(os.tmpdir(), `ds-gm-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
await build({
  stdin: {
    contents: `
      export { Editor, initSync } from '../wasm/ds_core'
      export { planRoomList, CIRCULATION_ROOM_ID } from './planGraphic'
      export { zoneAtPoint } from './takeoff'
    `,
    resolveDir: here,
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })
mod.initSync({ module: fs.readFileSync(wasmPath) })
const { Editor, planRoomList, CIRCULATION_ROOM_ID, zoneAtPoint } = mod

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
// The fold and the type space — BY EVALUATION (R20)
// ---------------------------------------------------------------------------

const GROUND = Editor.ground_zone_types()
const ALL_TYPES = Editor.zone_type_names()
const PROGRAM = ALL_TYPES.filter((t) => !GROUND.includes(t) && t !== 'Core')

ok('the core publishes a ground set', GROUND.length > 0, `got ${JSON.stringify(GROUND)}`)
ok(
  'the ground set is a proper non-empty subset of the type space',
  GROUND.length > 0 && GROUND.length < ALL_TYPES.length,
  `${GROUND.length} of ${ALL_TYPES.length} — a total or empty fold makes every delta below vacuous`,
)
// The retype target must be a type that is neither ground nor `Core` (which
// `planGraphic` also excludes from rooms) — otherwise "retyped to a program
// type" would not actually cross the boundary being measured.
ok(
  'the type space offers a non-ground, non-Core type to retype into',
  PROGRAM.length > 0,
  `program types ${JSON.stringify(PROGRAM)} — with none, the perturbation is not a perturbation`,
)
const FOIL = PROGRAM[0]

// ---------------------------------------------------------------------------
// 1. planGraphic.planRoomList — the aggregated circulation anchor
// ---------------------------------------------------------------------------
//
// `planRoomList` emits ONE row anchored on the largest ground zone. A document
// whose ONLY ground zone is of type G must therefore carry that row; retyping
// that same zone to a program type must remove it. A consumer that has dropped G
// from its fold produces NO row in either state — which the delta catches.

const planDoc = (t) => ({
  zones: [
    { id: 1, zone_type: t, label: 'the ground under test', shape: { kind: 'Rect', x: 5, y: 5, w: 8, h: 8 }, component_ids: [], origin: 'Drawn' },
    { id: 2, zone_type: FOIL, label: 'a room', shape: { kind: 'Rect', x: 15, y: 5, w: 4, h: 4 }, component_ids: [], origin: 'Drawn' },
  ],
  components: [], walls: [], keepouts: [], entries: [], anchors: [], selection: null, next_id: 99,
})
const hasCircRow = (rows) => rows.some((r) => r.id === CIRCULATION_ROOM_ID)

for (const g of GROUND) {
  const asGround = planRoomList(planDoc(g))
  const retyped = planRoomList(planDoc(FOIL))
  ok(
    `planRoomList: '${g}' anchors the circulation row`,
    hasCircRow(asGround),
    `a document whose only ground zone is '${g}' produced no '${CIRCULATION_ROOM_ID}' row — ` +
      `planGraphic's ground predicate no longer contains '${g}'`,
  )
  ok(
    `planRoomList: retyping the '${g}' zone to '${FOIL}' removes the circulation row`,
    !hasCircRow(retyped),
    `the row survived with no ground zone present — the anchor is not reading the fold at all, ` +
      'so the assertion above would pass for the wrong reason',
  )
}

// ---------------------------------------------------------------------------
// 2. takeoff.zoneAtPoint — ground never outranks a real room
// ---------------------------------------------------------------------------
//
// A point inside BOTH a small ground zone and a large program zone belongs to
// the ROOM: `zoneAtPoint` ranks by class first (a specific zone displaces
// circulation) and only then by smallest extent. The sizes are deliberately
// inverted — small ground inside large room — because with the ground zone
// LARGER, the size tie-break reaches the same answer by accident and the check
// would be a tautology (R16). Measured: with the sizes the other way round both
// the real and the narrowed predicate answer `Meeting`, and this check sees
// nothing.

const OVERLAP = { x: 10, y: 10 }
const takeoffZones = (t) => [
  { id: 1, zone_type: t, label: 'small ground', shape: { kind: 'Rect', x: OVERLAP.x, y: OVERLAP.y, w: 2, h: 2 }, component_ids: [], origin: 'Drawn' },
  { id: 2, zone_type: FOIL, label: 'large room', shape: { kind: 'Rect', x: OVERLAP.x, y: OVERLAP.y, w: 10, h: 10 }, component_ids: [], origin: 'Drawn' },
]

for (const g of GROUND) {
  const asGround = zoneAtPoint(OVERLAP.x, OVERLAP.y, takeoffZones(g))
  const retyped = zoneAtPoint(OVERLAP.x, OVERLAP.y, takeoffZones(FOIL))
  ok(
    `zoneAtPoint: a point in a small '${g}' zone inside a large '${FOIL}' resolves to the room`,
    asGround?.id === 2,
    `resolved to zone ${asGround?.id} ('${asGround?.zone_type}') — takeoff's ground predicate no ` +
      `longer contains '${g}', so the smallest-extent tie-break awarded the point to the ground zone`,
  )
  ok(
    `zoneAtPoint: retyping the '${g}' zone to '${FOIL}' moves the point onto the smaller zone`,
    retyped?.id === 1,
    `resolved to zone ${retyped?.id} — with both zones the same class the smaller must win, so ` +
      'the check above would pass however the fold was defined',
  )
}

// ---------------------------------------------------------------------------

if (failures === 0) {
  console.log(
    `ground-membership PASS (${checks} checks) — ground=${JSON.stringify(GROUND)}, ` +
      `each member observable in planRoomList + zoneAtPoint, foil='${FOIL}'`,
  )
  process.exit(0)
}
console.log(`ground-membership FAIL (${checks} checks, ${failures} failing)`)
process.exit(1)
