// The rate card: coverage, core parity, and the invariants that keep a market
// rate from being mistaken for a quoted price. Run from web/:
//   node src/export/rateCard.test.mjs
//
// Three properties, and the reason each one is here:
//
//  1. COVERAGE. Every floor and ceiling finish `FINISH_SPEC` can produce has a
//     rate. A finish the card does not know prices at ₹0, and a ₹0 line on a
//     costed document is exactly the defect this work exists to remove — so a
//     new room type added to `finishSchedule.ts` must fail HERE, loudly, rather
//     than ship a silent hole in the Main Summary.
//
//  2. CORE PARITY. Four figures in `rateCard.ts` describe the same market as
//     `crates/ds-core/src/cost.rs`, which is what the app's headline indicative
//     cost is built from. CLAUDE.md's rule for an unavoidable mirror is to
//     parse the value out of the Rust source and fail on divergence — that is
//     what this does. The Rust file is the OWNER; this test reads it, never the
//     other way round.
//
//  3. NO INVENTED PRICES. The card must return null for a category it has no
//     defensible figure for, so the line stays "to be quoted" (ADR 0004).
//
// @covers: web/src/export/rateCard.ts
// @covers: crates/ds-core/src/cost.rs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')

const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

async function bundle(entry) {
  const out = path.join(os.tmpdir(), `rc-${path.basename(entry, '.ts')}-${process.pid}.mjs`)
  await build({
    entryPoints: [path.join(here, entry)],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

const rate = await bundle('rateCard.ts')
// Reached through its OWN entry point: the point of the coverage check is that
// two modules agree, so importing the copy `rateCard.ts` happens to bundle would
// be comparing a value with itself.
const { FINISH_SPEC } = await bundle('finishSchedule.ts')

let failures = 0
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (${got})`}`)
  if (!cond) failures++
}

// --- 1. coverage ------------------------------------------------------------
const specs = Object.values(FINISH_SPEC)
const missingFloor = [...new Set(specs.map((s) => s.floor))].filter((n) => !rate.FLOOR_RATE_INR[n])
const missingCeil = [...new Set(specs.map((s) => s.ceiling))].filter((n) => !rate.CEILING_RATE_INR[n])
check('every FINISH_SPEC floor finish has a rate', missingFloor.length === 0, missingFloor.join(' · '))
check('every FINISH_SPEC ceiling finish has a rate', missingCeil.length === 0, missingCeil.join(' · '))

const all = rate.allConstructionRates()
const zero = all.filter((r) => !(r.rate.inr > 0))
check('no construction rate is zero', zero.length === 0, zero.map((r) => r.name).join(' · '))
const unbased = all.filter((r) => !r.rate.basis || r.rate.basis.length < 30)
check(
  'every rate carries a basis a reader can check',
  unbased.length === 0,
  unbased.map((r) => r.name).join(' · '),
)
check('every construction rate reports a unit', all.every((r) => ['m^2', 'm', 'Number'].includes(r.rate.unit)))

// The two `Glass` entries — a wall type and a door type — must not collide.
check(
  'a category-scoped lookup separates the wall Glass from the door Glass',
  rate.constructionRate('Glass', 'Walls').inr !== rate.constructionRate('Glass', 'Doors').inr,
  `${rate.constructionRate('Glass', 'Walls').inr} vs ${rate.constructionRate('Glass', 'Doors').inr}`,
)

// --- 2. core parity ---------------------------------------------------------
// Parsed out of the Rust source. If `cost.rs` moves a rate, this fails and the
// two stop being able to drift silently.
const costRs = fs.readFileSync(path.join(ROOT, 'crates/ds-core/src/cost.rs'), 'utf8')

/** `const PARTITION_SOLID: (f64, f64) = (4_600.0, 35.0);` → 4600 */
function rustPair(name) {
  const m = costRs.match(new RegExp(`const\\s+${name}\\s*:\\s*\\(f64,\\s*f64\\)\\s*=\\s*\\(([\\d_.]+)`))
  return m ? Number(m[1].replace(/_/g, '')) : null
}
/** The ₹ literal on the line of `furniture_rate` carrying `comment`. */
function rustFurniture(afterMatch) {
  const m = costRs.match(new RegExp(`\\(([\\d_]+)\\.0,\\s*[\\d_.]+\\)\\s*//\\s*${afterMatch}`))
  return m ? Number(m[1].replace(/_/g, '')) : null
}

const B = rate.ELEMENT_BENCHMARK_INR
const parity = [
  ['PARTITION_SOLID', rustPair('PARTITION_SOLID'), B.partitionSolidPerM],
  ['PARTITION_GLASS', rustPair('PARTITION_GLASS'), B.partitionGlassPerM],
  ['DOOR', rustPair('DOOR'), B.doorPerLeaf],
  ['furniture_rate: seating', rustFurniture('task / soft seating'), B.seatingPerUnit],
  ['furniture_rate: workstation', rustFurniture('workstation'), B.deskOrTablePerUnit],
]
for (const [name, rust, ts] of parity) {
  check(`${name} matches crates/ds-core/src/cost.rs`, rust != null && rust === ts, `rust ${rust} · ts ${ts}`)
}

// The two door rates are a SPLIT of the blended benchmark, not two new numbers.
const glassDoor = rate.DOOR_RATE_INR.Glass.inr
const solidDoor = rate.DOOR_RATE_INR.Solid.inr
check(
  'the glass/solid door split averages back to the blended benchmark',
  (glassDoor + solidDoor) / 2 === B.doorPerLeaf,
  `(${glassDoor} + ${solidDoor})/2 = ${(glassDoor + solidDoor) / 2} vs ${B.doorPerLeaf}`,
)

// The wall/glass ₹/m² are DERIVED from the ₹/running-m benchmark, not restated.
const wantSolid = Math.round(B.partitionSolidPerM / rate.BENCHMARK_STOREY_M / 50) * 50
const wantGlass = Math.round(B.partitionGlassPerM / rate.BENCHMARK_STOREY_M / 50) * 50
check(
  'the Drywall ₹/m² is the solid benchmark ÷ the storey it assumes',
  rate.WALL_RATE_INR.Drywall.inr === wantSolid,
  `${rate.WALL_RATE_INR.Drywall.inr} vs ${wantSolid}`,
)
check(
  'the Glass Partition ₹/m² is the glazed benchmark ÷ the storey it assumes',
  rate.GLASS_PARTITION_RATE_INR['Glass Partition'].inr === wantGlass,
  `${rate.GLASS_PARTITION_RATE_INR['Glass Partition'].inr} vs ${wantGlass}`,
)

// --- 3. furniture: sized, bounded, and never invented -----------------------
const chair = rate.furnitureRate('Chair', 0.5, 0.5)
const desk = rate.furnitureRate('Desk', 1.4, 0.7)
check('a chair prices at the seating benchmark', chair?.inr === B.seatingPerUnit, chair?.inr)
check('a desk prices at the workstation benchmark', desk?.inr === B.deskOrTablePerUnit, desk?.inr)

const board = rate.furnitureRate('Table', 1.9, 2.9)
const side = rate.furnitureRate('Table', 0.6, 0.6)
check(
  'a boardroom table costs more than a side table (tables are sized, not flat-rated)',
  board.inr > side.inr * 5,
  `${board.inr} vs ${side.inr}`,
)
check('a desk-sized table lands on the workstation benchmark', rate.furnitureRate('Table', 1.4, 0.7).inr === 19_600, rate.furnitureRate('Table', 1.4, 0.7).inr)
check('a tiny table is floored, never priced near zero', side.inr >= 12_000, side.inr)
check(
  'every furniture rate states its basis',
  [chair, desk, board, side].every((r) => r.basis.length > 40),
)

// THE invariant that keeps a takeoff honest: no figure for a thing we cannot
// defend a figure for.
check('a door is not priced as furniture (it has its own leaf rate)', rate.furnitureRate('Door', 0.9, 0.1) === null)
check(
  'an unknown category returns null, so the line stays "to be quoted"',
  rate.furnitureRate('Aquarium', 2, 1) === null,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
