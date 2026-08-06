// Every value the TypeScript side deliberately MIRRORS from the Rust core, and
// a check that it still matches — by parsing the Rust source, so the test goes
// red on divergence instead of a comment quietly becoming false.
// Run from web/:  node src/coreParity.test.mjs
//
// WHY THIS EXISTS
// ---------------
// The single most expensive class of bug in this codebase is one fact with two
// owners. `OPEN_SHARE` was declared in Rust and twice in TS; one copy said 0.85
// and the other 0.90 with a comment claiming it mirrored Rust, so the same
// headcount produced a different building depending on which screen you entered
// through. Door depth was 0.15 in the generator and 0.15 in the drafting tool,
// authored independently. Those are now read across the wasm boundary and are
// gone from here.
//
// What remains is the residue: values TS genuinely cannot ask the core for at
// the moment it needs them — a canvas renderer that must draw before it can
// await anything, and a tool schema that has to be a literal for the model to
// read. A mirror is acceptable when it is UNAVOIDABLE and GUARDED. It is not
// acceptable when it is merely convenient, and a comment that says "mirrors X"
// is a CLAIM TO VERIFY, not documentation — `ai/engine.ts` carried
// `MIN_AREA_PER_WS = 6.0 // planning norm (see layout.rs)` for months against a
// constant that never existed in layout.rs, and warned users in the engine's
// name about a threshold the engine did not hold.
//
// ADDING A MIRROR? Register it here in the same change. A mirror with no row in
// this file is how all of the above started.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
/**
 * Read a core source file — and for `layout.rs`, its SUBMODULES too.
 *
 * main decomposed layout.rs into layout/{program,seed,grid,regions,jobs,place,
 * emit,packing,conform,score}.rs. This parity check was anchored to the
 * pre-split PATH, so it went looking for `pub enum SpaceKind` in an
 * orchestrator that no longer declares it. The mirror it guards did not move;
 * only the file did. Concatenating the submodules keeps the check anchored to
 * the VALUES it certifies rather than to a filename.
 */
const rust = (f) => {
  const base = join(repo, 'crates', 'ds-core', 'src')
  let out = readFileSync(join(base, f), 'utf8')
  if (f === 'layout.rs') {
    const dir = join(base, 'layout')
    if (existsSync(dir)) {
      for (const sub of readdirSync(dir).filter((n) => n.endsWith('.rs')).sort()) {
        out += '\n' + readFileSync(join(dir, sub), 'utf8')
      }
    }
  }
  return out
}
const ts = (f) => readFileSync(join(here, f), 'utf8')

let failures = 0
const check = (name, want, got) => {
  const ok = JSON.stringify(want) === JSON.stringify(got)
  if (!ok) {
    failures++
    console.error(`  ✗ ${name}\n      rust: ${JSON.stringify(want)}\n      ts:   ${JSON.stringify(got)}`)
  } else {
    console.log(`  ✓ ${name} = ${JSON.stringify(got)}`)
  }
}

/** Value of a `const NAME: f64 = <num>;` in a Rust source. Throws if absent —
 *  a renamed or deleted constant must fail loudly, not silently pass. */
function rustConst(src, file, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*:\\s*f64\\s*=\\s*([0-9.]+)\\s*;`))
  if (!m) throw new Error(`${file}: no const ${name} — it was renamed or removed; update its mirror`)
  return Number(m[1])
}

/** Value of a `const NAME = <num>` in a TS source (the mirror side). */
function tsConst(src, file, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`))
  if (!m) throw new Error(`${file}: no const ${name}`)
  return Number(m[1])
}

console.log('core parity — TS mirrors of Rust values')

// --- 1. Seat geometry: model.rs ←→ editor/symbols.ts -------------------------
// UNAVOIDABLE: `drawSymbol` runs inside a canvas frame. It cannot await a wasm
// call per glyph, and the seat COUNT it draws already comes from the model
// (`Component.seats`) — these two only place the dots the count implies, so the
// count and the placement must use the same pitch or the glyph shows N seats
// spread at the wrong spacing.
{
  const m = rust('model.rs')
  const s = ts('editor/symbols.ts')
  check('SEAT_PITCH_M', rustConst(m, 'model.rs', 'SEAT_PITCH_M'), tsConst(s, 'symbols.ts', 'SEAT_PITCH_M'))
  check('HEAD_SEAT_MIN_M', rustConst(m, 'model.rs', 'HEAD_SEAT_MIN_M'), tsConst(s, 'symbols.ts', 'HEAD_SEAT_MIN_M'))
}

// --- 1b. Daylight reach: layout/score.rs ←→ export/report.ts -----------------
//
// Both sides answer "is this desk daylit?" and they must answer it the same way,
// or the Rust sub-score the optimiser maximises and the KPI the client report
// prints describe different buildings. `score.rs` already carries the claim in
// prose — "matches the report's DAYLIGHT_RADIUS_M so the Rust sub-score and the
// exported KPI agree on which desks see a window" — and CLAUDE.md is explicit
// that **a `mirrors X` comment is a claim to verify, not documentation.**
//
// It was never registered here. Found during the Phase 0 audit as a live,
// unpinned mirror; this closes it.
{
  const sc = rust('layout/score.rs')
  // Moved report.ts -> kpis.ts by the C1 extraction. Following the constant is
  // the whole job of a parity guard: the one that DIDN'T follow OPEN_SHARE
  // crashed for two months while listed as passing.
  const rp = ts('export/kpis.ts')
  check(
    'DAYLIGHT_REACH_M (score.rs) ←→ DAYLIGHT_RADIUS_M (kpis.ts)',
    rustConst(sc, 'layout/score.rs', 'DAYLIGHT_REACH_M'),
    tsConst(rp, 'export/kpis.ts', 'DAYLIGHT_RADIUS_M'),
  )
}

// --- 2. SpaceKind: layout.rs ←→ the TS union + the AI tool enum ---------------
// UNAVOIDABLE for the schema: the room kinds a model may propose have to be
// literals inside the JSON schema it reads. A kind present in one list and not
// the other is silent — `clampDesignSpec` drops an unknown kind and the room the
// designer asked for just never appears.
{
  const body = rust('layout.rs').match(/pub enum SpaceKind \{([\s\S]*?)\n\}/)
  if (!body) throw new Error('layout.rs: could not find `pub enum SpaceKind`')
  const variants = body[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => /^[A-Z][A-Za-z0-9]*,$/.test(l))
    .map((l) => l.slice(0, -1))

  const arr = ts('ai/designer.ts').match(/const SPACE_KINDS: readonly SpaceKind\[\] = \[([\s\S]*?)\]/)
  if (!arr) throw new Error('designer.ts: could not find SPACE_KINDS')
  const kinds = [...arr[1].matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1])
  check('SPACE_KINDS (ai/designer.ts)', variants, kinds)

  // Stop at the first line that isn't a `| 'Member'` continuation — the next
  // declaration follows immediately, with no blank line to anchor on.
  const UNION_HOME = 'types/doc.ts' // moved out of the canvas by main's type extraction
  const union = ts(UNION_HOME).match(/export type SpaceKind =((?:\s*\|\s*'[A-Za-z0-9]+')+)/)
  if (!union) throw new Error(`${UNION_HOME}: could not find the SpaceKind union`)
  const members = [...union[1].matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1])
  check(`SpaceKind union (${UNION_HOME})`, variants, members)
}

if (failures > 0) {
  console.error(`\n${failures} mirror(s) have drifted from the core. Fix the TS side, or delete the mirror and read the value across the wasm boundary.`)
  process.exit(1)
}
console.log('core parity: all mirrors match')
