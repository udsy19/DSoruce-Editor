// THE AREA A DELIVERABLE PRINTS IS THE AREA THE CORE MEASURED — and (F2) THE
// SEAT COUNT IT PRINTS IS THE SEAT COUNT THAT AREA SUPPORTS.
// Run from web/:  node src/export/publishedArea.test.mjs
//
// @covers: web/src/export/finishSchedule.ts
// @covers: web/src/export/sheetSet.ts
// @covers: web/src/util/publishedArea.ts
// @covers: web/src/util/zoneGeom.ts
// @covers: web/src/editor/stats.ts
// @covers: crates/ds-core/src/cost.rs
// @covers: crates/ds-core/src/zone.rs        — the seat-rate spec (F2)
// @covers: crates/ds-core/src/lib.rs         — `zone_stats()` seat rows (F2)
// @covers: crates/ds-core/src/quantity.rs    — `quantities()` seat rows (F2)
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
//      `scripts/gates/area-census.mjs` is the instrument that closes it from
//      the source side in BOTH languages, by detecting the arithmetic rather
//      than the name.
//
//      **THIS LINE WAS WRONG AND IS CORRECTED (F3).** It named
//      `web/src/util/areaCensus.test.mjs`, which is Line A's census — RETIRED
//      in the merge in favour of Line B's `scripts/gates/area-census.mjs` and
//      absent from this tree. The merge repointed mechanism 2 (the note eight
//      lines below) and missed mechanism 3 in the same edit, so this file spent
//      the merge citing a file that does not exist. The two are the same
//      instrument doing the same job — a total detector of area ARITHMETIC in
//      both languages, reconciled against a register — and the survivor is
//      wired into the battery at `scripts/verify-all.sh:158` rather than
//      globbed as a `*.test.mjs`, which is the only difference that matters to
//      a reader looking for it.
//
//      VERIFIED HERE, not inherited: `web/src/util/areaCensus.test.mjs` does
//      not exist; `area-census.mjs`'s register carries no `paint.ts` entry
//      because there is no longer a site there to register — `paint.ts:20`
//      imports `isDegenerateZoneShape`, a PREDICATE, and both room-tag branches
//      (`:574` Poly, `:661` Rect) `continue` when the core row is missing
//      instead of falling back to `?? Math.abs(a2) / 2` / `?? s.w * s.h`. The
//      coverage is real; only the record was wrong.
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
    // NAMES-IT-BUT-DOES-NOT-CALL-IT, and the exemption is TWO-SIDED: this file
    // must still carry no `import ... from '…zoneGeom'`, so the day it starts
    // actually importing the helper it rejoins the allowlist instead of sitting
    // behind a stale name-based skip.
    //
    // `src/util/areaCensus.test.mjs` was a second exemption here and is DELETED
    // (F3): that file is Line A's retired census and is not in this tree, so the
    // disjunct could never match. A dead exemption is worse than none — it is a
    // standing licence for a path nobody is watching. Measured: removing it
    // moves no check count, because an exemption for a file that does not exist
    // never ran its check.
    if (rel === 'src/export/publishedArea.test.mjs') {
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

// ===========================================================================
// F2 — THE SEAT COUNT A ROW PUBLISHES IS THE SEAT COUNT ITS PUBLISHED AREA
//      SUPPORTS
// ===========================================================================
// THE DEFECT. The area half of this file was written because sheet A.09 billed
// F1's zone 244 at 35.0 m² while the core measured 8.0 m². The seat half exists
// because the SAME ROW published `area 8.0 m² · 5 pax` — five 6 m² workstations
// inside eight square metres — from `Zone::capacity()`, which measured the RAW
// shape while `area` came from the basis. Two numbers on one row, from two
// different areas, contradicting each other in the reader's hand.
//
// It was fixed by making the area an ARGUMENT (`capacity_from_area(area)`) so a
// published surface cannot get the raw one by accident. NOTHING GUARDED THE FIX
// FROM THIS SIDE OF THE FENCE. Measured, in a disposable worktree: reverting the
// two published call sites — `lib.rs:1221` (`zone_rows`) and `quantity.rs:539`
// (`quantities`) — to `seat_estimate_for_ordering()` restores the headline
// defect verbatim on BOTH surfaces —
//
//     F1 zone 244 "Open Workspace (2)"   8.0000 m²  1 pax  ->  5 pax
//     F1 zone 245 "Open Workspace (3)"   3.6800 m²  0 pax  ->  2 pax
//
// — verbatim: re-run on the MERGED tree it reds 145/3755, exit 1, naming 244 and
// 245 with their numbers on all five fixtures. Zone 245 is a second instance no
// report of the original defect names, and F5 carries it too (17.9000 m² 2 -> 5,
// and 3.6800 m² 0 -> 2).
//
// **THE "NOTHING GUARDED IT" HALF IS RETRACTED, AND THE RETRACTION IS THE
// MERGE'S DOING (F6).** This block used to close: "leaves `cargo test -p ds-core`
// at **200 passed, 0 failed**" — i.e. this file was the sole detector. Re-measured
// on the merged tree under the identical sabotage: **200 passed, 5 FAILED** —
//     metrics_tests::the_published_seat_count_reads_the_area_the_row_bills
//     metrics_tests::every_conjunct_is_declared_graded_and_reached
//     metrics_tests::metrics_can_never_be_impossible
//     metrics_tests::every_fixture_reports_possible_metrics
//     metrics_tests::retyping_every_zone_cannot_produce_an_impossible_efficiency
// §2 brought a Rust-side guard for exactly this quantity (conjunct
// `M26.capacity.is_the_seat_count_the_billed_area_supports`, graded GUARD), so
// the two lines converged on one defect from opposite sides of the wasm boundary
// and this gate is now the SECOND detector, not the only one. Both are kept: the
// Rust conjunct grades the core's arithmetic, this grades the number that leaves
// through `#[wasm_bindgen]` and reaches a client's hand, and neither subsumes the
// other. The old sentence is left visible here rather than deleted, because "the
// only thing that catches X" is precisely the kind of claim that rots silently.
//
// WHERE THE NUMBER GOES, and why no board catches it. `capacity` is not an
// internal figure:
//   * `web/src/editor/paint.ts:580` (Poly tag) and `:673` (Rect tag) print it on
//     the canvas as `"8.0 m² · 5 pax"` — the room tag on every plan.
//   * `web/src/export/kpis.ts:175` sums it over Meeting + Collaboration into
//     `meetingSeats` -> `seats` -> the Density KPI (sqf/person, m²/person) on the
//     alternatives comparison.
//   * `web/src/App.tsx:1713` writes it as the `capacity` column of the exported
//     plan CSV.
// And no gate on either board grades the VALUE. G3's quantity truth
// (`scripts/gates/g3-quantity-truth.py`) checks rooms, walls, doors and areas —
// its Inventory loop reads `Room ID`, `Area (m2)`, `Area (sqf)` and nothing
// else. The sheet board has no `capacity`/`pax` reference at all. The only
// pre-existing JS assertion touching it is `core/mutatorGuards.test.mjs:187`,
// which compares Σ capacity BEFORE against Σ capacity AFTER an off-plate zone —
// a delta invariant that is satisfied by any two equal wrong numbers.
// `qtoWorkbook.ts:69` declares `QtyRoom.capacity` but writes `headcount` into
// the workbook, so the value reaches the type and not the cell — stated
// precisely because "it reaches the workbook" would be the easy thing to write.
//
// INDEPENDENCE (.claude/rules/gate-independence.md, R2). The expected seat count
// is derived from the rate SPEC — the table (`zone::m2_per_seat`) and the
// arithmetic (`Zone::capacity_from_area`) parsed out of
// `crates/ds-core/src/zone.rs` as text — and never by calling the function the
// producer calls. The producer here is the compiled wasm; the sabotage above
// changes which area that binary hands the rate table and changes nothing in the
// source text this block reads, which is exactly why it reds.
//
// CORRECTION, recorded rather than quietly adapted to (F6). An earlier report of
// this mission stated that **"`zone::m2_per_seat` does not exist in this tree"**.
// That was TRUE WHEN WRITTEN and is FALSE NOW: §2 introduced it as the standalone
// rate table, and it is `zone.rs:393` on this merge. The parse above was repointed
// at it for that reason, not because the earlier report was mistaken.
//
// THE BLIND SPOT, stated rather than discovered later: one rate table, read by
// the producer and by this gate. Change `Workspace => 6.0` to `5.0` and both
// sides move together and this stays green. That is the same null this mission
// already recorded for `zone::m2_per_seat`. What the two-sided read DOES catch
// is the whole class the defect belongs to — a published seat count computed
// from a different area than the published area beside it. Closing the rate null
// needs a third, external anchor (a code figure), which is not in this file's
// remit.
//
// WHAT IS MIRRORED AND WHAT IS RE-DERIVED. `zone_rows` has three arms —
// furniture wins, then the plate-spanning zone, then the area rule. The ARM
// STRUCTURE is read from `lib.rs` by a human and mirrored here; every NUMBER is
// re-derived from `state()` (component `seats`, `reference`, `category`), which
// is core state, not the producer's account of itself. NULL, reported: over the
// full population the two-arm form (furniture, else the rate) explains 645 of
// 645 rows exactly, so the plate-spanning arm is either never taken or never
// distinguishable here; it is asserted against, not exempted, and a future
// document that makes it differ will red and should be read, not silenced.
// `quantities()` has ONE arm and is asserted unconditionally.
//
// R16 GRADE: **CHECK**, on both surfaces — it reds on a real reintroduced
// defect, not merely on a hypothetical. The sabotage round below broke each part
// of the mechanism in turn, including the enabling ones, and reports its nulls.
//
// **RE-RUN IN FULL ON THE MERGED TREE (F6)**, because §2 moved this gate's
// subject and a sabotage table inherited across a refactor is a claim about the
// previous release. Counts are /3755 here, not /3752: +2 are the linkage checks
// the two-anchor split made necessary, +1 is `src/cloud/tenancy.ts`, a file the
// merge added to the retired-name scan's population.
//
//   the defect, both published call sites reverted  RED 145/3755, exit 1,
//     (rebuilt wasm in the disposable copy;           naming 244 and 245 with
//      md5 0f8914b6 -> 2679f46b, verified)            their numbers on 5 fixtures
//   `.max(0.0)` dropped from the Rust formula        RED 1/3755 — the formula pin
//                                                   is STILL the only thing that
//                                                   sees it after the refactor,
//                                                   so it is load-bearing
//   a ninth ZoneType with no rate                    RED 1/3755 (domain reconcile)
//   `m2_per_seat` reads a DIFFERENT table from       RED 1/3755 (linkage) — new,
//     the one `capacity_from_area` calls               and only reachable once the
//                                                     spec lived in two items
//   `None` stops meaning zero seats                  RED 1/3755 (linkage) — new
//     (`else { return 0 }` -> `return 1 }`)
//   `m2_per_seat` renamed                            THROWS — a missing input is a
//                                                   failure, not an empty table
//
//   NULL, and it cost a fix: the FIRST run of the rename sabotage came back
//   **3755/3755 GREEN**. `rustItemBody` anchored with `indexOf` on the bare name,
//   so `m2_per_seat_RENAMED` still contained the anchor and the parse happily read
//   the renamed function. The pre-§2 code had the same prefix hazard
//   (`indexOf('pub fn capacity_from_area')`) and nothing had ever exercised it.
//   Anchors now end in `(` and the helper refuses one that does not; re-run, the
//   rename throws. A sabotage that comes back green is the most useful result in
//   the table.
//
//   NULL, unresolved and NOT this file's to close: a "restore" that did not
//   restore. `rsync -a` put the pristine `crates/` back with its ORIGINAL mtimes,
//   older than the sabotage edit, so `wasm-pack` skipped the rebuild and the
//   sabotaged binary survived a restore that reported success — 145 failures that
//   would have been attributed to the next sabotage in line. Caught only by
//   md5-ing the artifact. Any future round here must verify the RESTORE bit the
//   same way it verifies the sabotage bit.
//   the gate's `Chair` exclusion dropped            RED 235/3752
//   the gate's furniture arm dropped entirely       RED 202/3752
//   population narrowed to F1 unedited              RED 10/3752 — all six seat
//                                                   non-vacuity floors fire
//   every row's published `zone_type` overwritten   seat verdicts BYTE-IDENTICAL
//     to 'Amenity'                                    (only the type-parity
//                                                      checks red) — the proof
//                                                      that the rate is keyed off
//                                                      the DOCUMENT, not the row
//
//   NULL — dropping ONLY the `!c.reference` filter from the gate's furniture
//   re-derivation leaves it **3752/3752 green**. No reference component with
//   `seats > 0` sits in any zone's `component_ids` anywhere in this population,
//   so that clause is mirrored from `lib.rs` and graded by nothing. Recorded
//   rather than removed: it is the correct filter, it is simply inert here.
//
//   OBSERVED, and left standing deliberately: a GROUND zone that contains
//   seating furniture publishes a NON-ZERO seat count, because the furniture arm
//   is evaluated before the type is consulted. 49 rows here do it, and THREE are
//   on unedited fixtures, so it is not an artefact of the retype edit —
//
//     F4 zone  87 Circulation "Meeting Room 1"  28.92 m² -> 6 pax
//     F5 zone  78 Circulation "Reception"       12.80 m² -> 4 pax
//     F5 zone 281 Unassigned  "Unassigned"     110.21 m² -> 1 pax
//
//   — the last of which seats a person in floor the generator declared waste.
//   `zone::tests::capacity_seats_nobody_exactly_where_the_usable_partition_does`
//   proves only that the RATE TABLE returns 0 for ground; it says nothing about
//   the published row, and the two are NOT the same claim. Whether furniture
//   should out-rank the ground partition is a product question this gate has no
//   standing to settle, so it pins today's answer and names it here instead of
//   quietly encoding it.

// --- the rate spec, read from the SPEC and never from the producer ----------
const zoneSrc = fs.readFileSync(path.join(ROOT, 'crates/ds-core/src/zone.rs'), 'utf8')
const stripLineComments = (s) => s.replace(/\/\/[^\n]*/g, '')

/** The source text of a Rust item, from its declaration line to the first line
 *  that is exactly its closing brace at `indent`. A declaration that is not
 *  there is a FAILURE — never an empty body, which would make every seat
 *  assertion below vacuously true about a table with no rows.
 *
 *  **`decl` MUST END IN `(`, and the sabotage round is why.** The first draft
 *  anchored on the bare name, inheriting the prefix-match the pre-§2 parse had
 *  (`indexOf('pub fn capacity_from_area')`). Renaming `m2_per_seat` to
 *  `m2_per_seat_RENAMED` then left the gate **3755/3755 GREEN**, because the new
 *  name still CONTAINS the old one and the parse read the renamed function's
 *  table as though nothing had moved. Measured, not reasoned about — the null
 *  that produced this line. The open paren makes the anchor an identifier
 *  boundary, so a rename is the throw the "missing input is a FAILURE" arm
 *  promises. */
const rustItemBody = (decl, indent) => {
  if (!decl.endsWith('(')) throw new Error(`rustItemBody anchor \`${decl}\` must end in \`(\` or it prefix-matches a renamed item`)
  const at = zoneSrc.indexOf(decl)
  if (at < 0) {
    throw new Error(
      `zone.rs no longer declares \`${decl}\` — part of the rate spec this gate reads as text is gone, and a missing input is a failure`,
    )
  }
  const close = `\n${' '.repeat(indent)}}\n`
  const end = zoneSrc.indexOf(close, at)
  if (end < 0) throw new Error(`could not find the end of \`${decl}\` in zone.rs`)
  return stripLineComments(zoneSrc.slice(at, end))
}

/** The variant domain, from the ONE authoring point (`zone_domain!`). A ninth
 *  variant lands here, so the completeness check below cannot go stale. */
const ZONE_DOMAIN = (() => {
  const at = zoneSrc.indexOf('\nzone_domain! {')
  if (at < 0) throw new Error('zone.rs no longer invokes `zone_domain!` — the variant domain this gate reconciles against is gone, and a missing input is a failure')
  const end = zoneSrc.indexOf('\n}\n', at)
  if (end < 0) throw new Error('could not find the end of the `zone_domain!` invocation in zone.rs')
  const body = stripLineComments(zoneSrc.slice(at, end))
  return new Set([...body.matchAll(/^\s*(\w+)\s*:\s*(?:ground|service|program)\s*,/gm)].map((m) => m[1]))
})()

/** The rate table + the seats-nobody arm + the arithmetic.
 *
 *  **TWO ANCHORS SINCE §2, and this gate's subject moved under it (F6).** When
 *  this gate was written the table was inlined in `capacity_from_area`, and one
 *  `indexOf('pub fn capacity_from_area')` reached the whole spec. §2 extracted
 *  the table into a standalone `pub(crate) fn m2_per_seat(ZoneType) ->
 *  Option<f64>`, leaving the method as a lookup plus the formula. The old parse
 *  then found no arms and the gate DID THE RIGHT THING — it reported
 *  `parsed no ZoneType::X => <rate> arms … the seat ground truth is about
 *  nothing` and threw on the first published `ClosedOffice` row, rather than
 *  grading 3752 checks against an empty table. That red is the
 *  "a missing input is a FAILURE, never a skip" arm firing, and it is why this
 *  repair is a repoint rather than a rewrite.
 *
 *  So: the TABLE and the seats-nobody set come from `m2_per_seat`; the
 *  ARITHMETIC comes from `capacity_from_area`. Splitting the spec across two
 *  items adds a third thing to check that did not exist before — the LINKAGE,
 *  asserted below, because a gate reading a rate table the producer no longer
 *  consults is measuring a dead file. */
const RATE_SPEC = (() => {
  // The TABLE — `m2_per_seat`, a free function at column 0.
  const table = rustItemBody('pub(crate) fn m2_per_seat(', 0)
  const rate = new Map()
  for (const m of table.matchAll(/ZoneType::(\w+)\s*=>\s*([0-9]+(?:\.[0-9]+)?)\s*,/g)) rate.set(m[1], Number(m[2]))
  // `None` IS the seats-nobody case — `m2_per_seat`'s doc comment says so in as
  // many words ("`None` means the type seats nobody"). The old spelling of this
  // same arm, when the table was inlined, was `=> return 0`.
  const noneArm = table.match(/((?:ZoneType::\w+\s*\|\s*)+ZoneType::\w+|ZoneType::\w+)\s*=>\s*return\s+None\s*,/)
  const seatsNobody = new Set(noneArm ? [...noneArm[1].matchAll(/ZoneType::(\w+)/g)].map((m) => m[1]) : [])
  // The ARITHMETIC — a method at column 4 inside `impl Zone`.
  const method = rustItemBody('pub fn capacity_from_area(', 4)
  return {
    rate,
    seatsNobody,
    table: table.replace(/\s+/g, ' ').trim(),
    text: method.replace(/\s+/g, ' ').trim(),
  }
})()

// The ARITHMETIC is half the spec. Pinning only the table would let `floor`
// become `round` — +1 seat on most rooms — with this gate green, because the
// gate would still be computing the old formula and calling it ground truth.
const RATE_FORMULA = '(area / per).floor().max(0.0) as u32'
check(
  RATE_SPEC.text.includes(RATE_FORMULA),
  `zone.rs's capacity_from_area no longer ends in \`${RATE_FORMULA}\`. This gate recomputes that expression in JS as its ground truth; if the Rust arithmetic changed, the ground truth is stale and every seat assertion below is measuring the previous release.`,
)
// THE LINKAGE (new with the two-anchor split). The table above is ground truth
// only while the method the producer calls is the method that reads it. If
// `capacity_from_area` grew its own rates back, or reached a different table,
// this gate would be grading the wrong file and every value would still agree
// with itself. Both halves are pinned: WHICH table, and what `None` means.
const RATE_OWNER = 'm2_per_seat(self.zone_type)'
check(
  RATE_SPEC.text.includes(RATE_OWNER),
  `capacity_from_area no longer reads \`${RATE_OWNER}\`. The rate table this gate parses out of \`m2_per_seat\` is only ground truth while it is the table the producer consults; a method with its own rates would leave this gate grading a file nothing calls.`,
)
const RATE_NONE_IS_ZERO = 'else { return 0 }'
check(
  RATE_SPEC.text.includes(RATE_NONE_IS_ZERO),
  `capacity_from_area no longer spells \`${RATE_NONE_IS_ZERO}\` for the \`None\` rate. \`seatsSupportedBy\` below encodes None -> 0 seats; if the Rust turned None into a default rate, or a panic, this gate's zero arm is a different rule from the producer's.`,
)
check(RATE_SPEC.rate.size > 0, 'parsed no `ZoneType::X => <rate>` arms out of m2_per_seat — the seat ground truth is about nothing')
check(RATE_SPEC.seatsNobody.size > 0, 'parsed no `=> return None` arm out of m2_per_seat — the seats-nobody half of the spec is about nothing')
{
  const both = [...RATE_SPEC.rate.keys()].filter((t) => RATE_SPEC.seatsNobody.has(t))
  check(both.length === 0, `these zone types were parsed into BOTH the rate table and the seats-nobody arm, so the parse is wrong: ${both.join(', ')}`)
  const covered = new Set([...RATE_SPEC.rate.keys(), ...RATE_SPEC.seatsNobody])
  const missing = [...ZONE_DOMAIN].filter((t) => !covered.has(t))
  const extra = [...covered].filter((t) => !ZONE_DOMAIN.has(t))
  check(
    missing.length === 0 && extra.length === 0,
    `the parsed rate spec and the zone_domain! variant list disagree.\n        in the domain, no rate: ${JSON.stringify(missing)}\n        rated, not in the domain: ${JSON.stringify(extra)}\n        A new ZoneType must be given a rate in \`m2_per_seat\` (or joined its \`return None\` arm) AND be visible to this parse.`,
  )
  check(ZONE_DOMAIN.size >= 8, `zone_domain! parsed only ${ZONE_DOMAIN.size} variants — the parse has come loose from the file`)
}

/** GROUND TRUTH for a seat count: the rate spec applied to a published area.
 *  A type the spec does not name is a FAILURE, never a skip. */
const seatsSupportedBy = (zoneType, areaM2) => {
  if (RATE_SPEC.seatsNobody.has(zoneType)) return 0
  const per = RATE_SPEC.rate.get(zoneType)
  if (per === undefined) {
    throw new Error(`zone type "${zoneType}" appears on a published row but zone.rs's rate spec gives it neither a rate nor a seats-nobody arm — a missing input is a failure`)
  }
  return Math.max(0, Math.floor(areaM2 / per))
}

/** Σ seats of the furniture actually standing in a zone — re-derived from
 *  `state()`, the document, and not from the row being graded. Mirrors the
 *  FILTER `lib.rs::zone_rows` applies (non-reference, `Chair` excluded because a
 *  chair is seating FOR a table that already reports those seats). */
const furnitureSeatsIn = (zone, componentById) =>
  zone.component_ids
    .map((cid) => componentById.get(cid))
    .filter((c) => c && !c.reference && c.category !== 'Chair')
    .reduce((s, c) => s + (c.seats ?? 0), 0)

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
// F2 population counters — each is a claim the seat assertions depend on.
let seatRowsQ = 0
let seatRowsS = 0
let seatRowsRated = 0 // non-ground rows whose seat count came from the area rule
let seatRowsFurnished = 0 // rows where standing furniture overrode the rule
let seatRowsGround = 0 // rows the seats-nobody arm covers
let seatRowsNonZero = 0 // rows publishing a seat count > 0

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

  // --- the seat count on both published surfaces (F2) ----------------------
  // Read straight off the two wasm exports a client-facing number comes from.
  // Neither is compared to the other; each is compared to the rate spec.
  {
    const componentById = new Map(state.components.map((c) => [c.id, c]))
    const zoneById = new Map(state.zones.map((z) => [z.id, z]))
    const per = (t) => (RATE_SPEC.seatsNobody.has(t) ? 'seats nobody' : `${RATE_SPEC.rate.get(t)} m²/seat`)

    // WHICH RATE APPLIES IS THE DOCUMENT'S ANSWER, NOT THE ROW'S. The rate is
    // keyed by zone type, so a row that reported its own type would be choosing
    // the yardstick it is measured against — the shape of every producer-
    // metadata failure this repo has logged. `docType` reads `state()`; the
    // row's published type is then asserted against it separately, so a
    // divergence is NAMED rather than quietly followed.
    const docType = (id) => {
      const z = zoneById.get(id)
      if (!z) throw new Error(`${key}: a published row names zone ${id}, which state() has no zone for — a missing input is a failure`)
      return z.zone_type
    }

    // `quantities().rooms[].capacity` — ONE arm, so this is unconditional.
    for (const r of ed.quantities().rooms) {
      seatRowsQ++
      const t = docType(r.roomId)
      check(
        r.zoneType === t,
        `${key}: quantities() zone ${r.roomId} "${r.name}" publishes type ${r.zoneType} but the document says ${t} — the row is not describing the zone it names.`,
      )
      const want = seatsSupportedBy(t, r.areaM2)
      check(
        r.capacity === want,
        `${key}: quantities() zone ${r.roomId} "${r.name}" bills ${r.capacity} pax on ${r.areaM2.toFixed(4)} m² — ${t} at ${per(t)} supports ${want}. A published seat count must be the seat count the published area of that same row supports.`,
      )
    }

    // `zone_stats().capacity` — furniture wins, else the area rule.
    for (const r of ed.zone_stats()) {
      seatRowsS++
      if (r.capacity > 0) seatRowsNonZero++
      const z = zoneById.get(r.id)
      if (!z) {
        check(false, `${key}: zone_stats() row ${r.id} has no zone in state() — a missing input is a failure`)
        continue
      }
      const t = docType(r.id)
      check(
        r.zone_type === t,
        `${key}: zone_stats() zone ${r.id} "${r.label}" publishes type ${r.zone_type} but the document says ${t} — the row is not describing the zone it names. (\`zone_stats()\` is the UNFOLDED surface; the Unassigned->Circulation fold belongs to \`zone_stats_published()\`.)`,
      )
      const furnished = furnitureSeatsIn(z, componentById)
      if (furnished > 0) {
        seatRowsFurnished++
        check(
          r.capacity === furnished,
          `${key}: zone_stats() zone ${r.id} "${r.label}" bills ${r.capacity} pax, but the ${furnished} seats its own furniture provides is what a furnished room seats. Furniture wins over the area rule (lib.rs::zone_rows).`,
        )
        continue
      }
      if (RATE_SPEC.seatsNobody.has(t)) seatRowsGround++
      else seatRowsRated++
      const want = seatsSupportedBy(t, r.area)
      check(
        r.capacity === want,
        `${key}: zone_stats() zone ${r.id} "${r.label}" bills ${r.capacity} pax on ${r.area.toFixed(4)} m² — ${t} at ${per(t)} supports ${want}. An unfurnished room's seat count is its published area's seat count; a different answer means the row read a different area than the one it prints.`,
      )
    }
  }

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
// F2. Each arm has to be REACHED. A population that never furnishes a room, or
// never leaves one unfurnished, grades one arm of a two-arm rule; a population
// whose every seat count is 0 is satisfied by a producer that publishes 0.
check(seatRowsQ > 100, `only ${seatRowsQ} quantities() seat rows compared`)
check(seatRowsS > 100, `only ${seatRowsS} zone_stats() seat rows compared`)
check(seatRowsRated > 100, `only ${seatRowsRated} unfurnished rated rows — the area-rule arm, the one the defect lived on, is thin`)
check(seatRowsFurnished > 50, `only ${seatRowsFurnished} furniture-override rows — the furniture arm is thin`)
check(seatRowsGround > 50, `only ${seatRowsGround} seats-nobody rows — the zero arm is thin`)
check(seatRowsNonZero > 100, `only ${seatRowsNonZero} rows publish a non-zero seat count — an all-zero population is green for a producer that publishes nothing`)

console.log(
  `\n${checks - failures}/${checks} checks green  (${scheduledRows} schedule rows, ` +
    `${labelRows} plan labels, ${cappedStates} capped states, ${enclosedStates} states with enclosed rooms, ` +
    `${seatRowsQ}+${seatRowsS} seat rows: ${seatRowsRated} rated / ${seatRowsFurnished} furnished / ${seatRowsGround} seats-nobody, ${seatRowsNonZero} non-zero)`,
)
if (failures > 0) {
  console.log(`PUBLISHED-AREA PARITY FAIL — ${failures} failing`)
  process.exit(1)
}
console.log('PUBLISHED-AREA PARITY OK')
