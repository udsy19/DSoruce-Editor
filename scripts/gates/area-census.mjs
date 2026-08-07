#!/usr/bin/env node
// THE CROSS-LANGUAGE AREA CENSUS (R17).
//
//   node scripts/gates/area-census.mjs            # gate: red on an unregistered site
//   node scripts/gates/area-census.mjs --list     # print every site it can see
//
// WHY THIS FILE EXISTS, stated as the failure it closes.
//
// R14 made per-zone area have one owner and claimed the compiler had enumerated
// its consumers: "The compiler enumerated the consumers: one production site."
// That sentence was true **of one crate**. The instrument was `rustc`, and
// `rustc` cannot see `web/src/export/`. More owners lived there, two of them
// printing onto shipped sheets: sheet A.09 billed `Open Workspace (2)` at
// 35.0 m² while the workbook billed the same zone at 8.0 m² — 4.4x apart, on an
// unedited fixture, under a 49/49 green board, because nothing anywhere read the
// sheet's area column.
//
// The follow-up census was then run with `grep zoneArea`, and reported SEVEN
// owners. This instrument, run on the same tree, found TEN — because three of
// them name nothing a symbol search can match: an inlined shoelace in the 3D
// viewer's zone readout (`three/Scene3D.tsx`), and two `?? s.w * s.h` fallbacks
// inside the canvas painter, one of them introduced as a degeneracy test and
// then spent as an area. A census of a QUANTITY is not a census of a SYMBOL,
// and the difference was three live publishers.
//
// A census is only as wide as the instrument that performs it. This one sees
// both languages, and it states its own scope below rather than leaving a reader
// to assume it is total.
//
// ── WHAT IT DETECTS ─────────────────────────────────────────────────────────
//
// Every site that derives a floor area from GEOMETRY — a call to an area
// primitive, or the arithmetic that is one (shoelace kernel, w*h on a shape).
// The detector is deliberately DUMB AND TOTAL: it does not decide whether a site
// is legitimate. Every site it finds must appear in the REGISTER below with a
// classification and a reason, and every register entry must still match a site
// on disk. A new call to `.area()` anywhere in ds-core, or any expression in
// web/ that computes m² from a shape, is red until somebody classifies it.
//
// That inversion is the point. A grep tells you what exists today; a register
// reconciled against a total detector tells you when the population changes.
//
// ── SCOPE OF THIS INSTRUMENT (R17: a negative claim carries its scope) ───────
//
// SEES:
//   * Rust: crates/ds-core/src/**/*.rs — every `.area()` / `.area_on(` call,
//     test regions included (counted, auto-classified, reported separately).
//   * JS/TS: every *.ts/*.tsx/*.mjs/*.js in the repo except node_modules,
//     target/, dist/, web/src/wasm (generated), and graphify-out.
//
// DOES NOT SEE, and these are the seams a future recompute would use:
//   * Python (scripts/gates/*.py, research/*.py). Gates read artifacts; a gate
//     computing an area from geometry would be a gate-independence violation
//     first and is out of this instrument's remit.
//   * Dynamically-constructed member access — `z['sh'+'ape']`, a computed
//     property name, `eval`. A recompute written that way is invisible here.
//   * Area arriving as a constant, or through a numeric round-trip (a string
//     parsed back to a number).
//   * Rust crates other than ds-core, and the deploy/ + api/ TypeScript is IN
//     scope by the JS glob above but has no zone geometry today.
//
// The complement to those blind spots is `scripts/gates/area-identity.mjs`,
// which does not read source at all: it re-derives every published area from the
// core and compares it against the delivered surfaces. A recompute this file
// cannot see still has to produce the right number there.
//
// ── FALSIFICATION (R3) ──────────────────────────────────────────────────────
//
// Recorded in docs/audits/LOOP-LEDGER.md. Run in a disposable worktree, never
// against the real tree (.claude/rules/gate-independence.md):
//   1. add `const a = z.shape.w * z.shape.h` to any web/ export module  -> RED
//   2. add a `.area()` call to a new Rust production fn                 -> RED
//   3. delete a registered site without deleting its register entry     -> RED
//   4. re-export an m²-returning helper from util/zoneGeom.ts           -> RED

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

let failures = 0
let checks = 0
const fail = (msg) => {
  failures++
  console.log(`  FAIL  ${msg}`)
}
const ok = () => {
  checks++
}
const check = (cond, msg) => (cond ? ok() : fail(msg))

// ---------------------------------------------------------------------------
// THE REGISTER — every production site that derives an area from geometry.
// ---------------------------------------------------------------------------
//
// Key: `<repo-relative file>::<enclosing fn>`. Line numbers churn; a function
// name does not. `count` is how many detector hits that function may contain —
// stated so a second, unnoticed recompute inside an already-registered function
// is red rather than absorbed.
//
// KINDS
//   'owner'    — THE definition of the quantity. There is exactly one per
//                quantity per language, and web/ has none: web/ receives values.
//   'ordering' — the magnitude is consumed ONLY to order or select, never
//                published and never compared against a threshold in m².
//                Registered with the ordering it implements.
//   'geometry' — an area of something that is NOT a zone: a candidate `Rect`
//                during generation, an imported plate outline, a component's
//                footprint, a cross product serving as a determinant. A
//                different quantity with a different owner.
//   'estimate' — a generation-time figure, computed while the zones are still
//                being built and legitimately overlap. There is no settled
//                basis to read at that point, and moving these would change
//                generator output. Each passes its raw area AT THE CALL SITE so
//                the choice is visible, and none reaches a published room
//                quantity — the layout objective publishes only a 0-100 score.
//
// A 'recompute' kind does not exist on purpose: that is what this gate rejects.
// Nor does 'derived' any more. `Zone::capacity` was the one entry that needed
// it — a published seat count measured off the raw shape while the area printed
// beside it came from the basis, so F1's `Open Workspace (2)` shipped
// `area: 8.0, capacity: 5`. It now takes the area as a parameter and computes
// nothing, which is why it no longer appears in this census at all.
const REGISTER = [
  // ---- Rust: the one owner -------------------------------------------------
  {
    key: 'crates/ds-core/src/lib.rs::effective_zone_areas',
    kind: 'owner',
    count: 1,
    why: 'THE per-zone area basis. Private to `mod basis`; `area_basis` is its only caller (R14).',
  },
  {
    key: 'crates/ds-core/src/zone.rs::area_on',
    kind: 'owner',
    count: 2,
    why: 'The primitive: ZoneShape::area_on clips to the plate, Zone::area_on delegates. The basis is its only production caller.',
  },
  {
    key: 'crates/ds-core/src/zone.rs::area',
    kind: 'owner',
    count: 1,
    why: 'Zone::area, the UNCLIPPED primitive. Every production caller is an ordering or a generation-time estimate; nothing published reads it.',
  },

  {
    key: 'crates/ds-core/src/zone.rs::seat_estimate_for_ordering',
    kind: 'ordering',
    count: 1,
    why: "Line A's named wrapper for the RAW-area seat estimate — generator heuristics and orderings only. Its whole point is that the call site says which area it used; published seat counts take `capacity_from_area(basis)` instead.",
  },

  // ---- Rust: ordering, never published ------------------------------------
  {
    key: 'crates/ds-core/src/document.rs::zone_index_at',
    kind: 'ordering',
    count: 1,
    why: 'Smallest containing zone wins. The magnitude never leaves the function; web/`compareZoneExtent` mirrors this exact ordering.',
  },
  {
    key: 'crates/ds-core/src/document.rs::merge_zones',
    kind: 'ordering',
    count: 2,
    why: 'The larger of two merged zones donates its ZoneType. The magnitude never leaves the function. INVISIBLE TO THE FIRST DETECTOR — see rustTestRanges.',
  },
  {
    key: 'crates/ds-core/src/layout/conform.rs::conform_zones_to_plate',
    kind: 'ordering',
    count: 2,
    why: 'Largest-area-first traversal so a smaller inner zone overwrites the cell. Ordering, mid-generation, on zones still being built.',
  },
  {
    key: 'crates/ds-core/src/layout/regions.rs::allocate_rooms',
    kind: 'ordering',
    count: 2,
    why: 'Smallest-first region order during allocation. `geometry::Rect`, not a zone.',
  },

  // ---- Rust: a different quantity -----------------------------------------
  {
    key: 'crates/ds-core/src/geometry.rs::decompose_plate',
    kind: 'geometry',
    count: 1,
    why: 'Candidate `Rect` area while decomposing the plate — a generator intermediate. No Zone exists.',
  },
  {
    key: 'crates/ds-core/src/layout/program.rs::derive',
    kind: 'geometry',
    count: 1,
    why: 'Sigma of REQUESTED room areas from the SpaceProgram (what to build), not from placed geometry.',
  },
  {
    key: 'crates/ds-core/src/layout/program.rs::area_per_person',
    kind: 'geometry',
    count: 1,
    why: 'Sigma of REQUESTED room areas — the density sanity metric on the program, before placement.',
  },

  // ---- Rust: generation-time estimates. DELIBERATELY not on the basis. -----
  //
  // These run DURING `generate`, on documents whose zones are still being
  // constructed and legitimately overlap; there is no settled basis to read,
  // and moving them would change generator output — a generator decision, not a
  // reporting one, and out of scope for the round that closed the reporting
  // side. They are stated rather than silently exempt, and each one now passes
  // its raw area AT THE CALL SITE (`z.capacity_from_area(z.area())`), so the
  // choice is visible in the source instead of hidden inside a method that
  // decided for every caller.
  {
    key: 'crates/ds-core/src/layout.rs::generate',
    kind: 'estimate',
    count: 5,
    why: 'Region `Rect` areas for wing/field selection + the residue diagnostic + the desk-field capacity estimate. All mid-generation.',
  },
  {
    key: 'crates/ds-core/src/layout/conform.rs::fill_untyped_as_circulation',
    kind: 'estimate',
    count: 1,
    why: 'MIN_AREA floor that drops sliver residuals during conform. A threshold on a zone that is still provisional.',
  },

  // ---- TypeScript: web/ owns no area. It receives `ZoneAreas`. ------------
  {
    key: 'web/src/util/zoneGeom.ts::shapeExtent',
    kind: 'ordering',
    count: 4,
    why: 'THE only shape-size arithmetic in web/. PRIVATE to zoneGeom.ts and reachable only through `compareZoneExtent`, which returns an ordering — so no magnitude in m2 exists to print.',
  },
  {
    key: 'web/src/util/zoneGeom.ts::zoneCenter',
    kind: 'geometry',
    count: 1,
    why: 'Polygon centroid; the cross-product is the centroid weight, not an area.',
  },
  {
    key: 'web/src/import/testfit.ts::signedArea',
    kind: 'geometry',
    count: 1,
    why: 'Area of an IMPORTED DWG/DXF outline while extracting the plate. Runs before any zone exists; this is plate geometry, owned by the import pipeline.',
  },
  {
    key: 'web/src/shell/steps/SpaceStep.tsx::computeReadouts',
    kind: 'geometry',
    count: 1,
    why: 'Keep-out ("core") rectangles read off an imported drawing, at import time. No Document, no zones, no basis to read.',
  },
  {
    key: 'web/src/export/ifc.ts::quantify',
    kind: 'geometry',
    count: 2,
    why: 'IFCQUANTITYAREA/VOLUME of a COMPONENT footprint (furniture w x h). A different quantity from a room area, owned by the component.',
  },
  {
    key: 'web/src/ui/ObjectInspector.tsx::ComponentProps',
    kind: 'geometry',
    count: 1,
    why: 'The selected COMPONENT footprint in the inspector. Component, not zone.',
  },
  {
    key: 'web/src/App.tsx::ReimaginePanel',
    kind: 'geometry',
    count: 1,
    why: 'The selected COMPONENT footprint in the reimagine panel. Component, not zone.',
  },
  {
    key: 'web/src/cad/editTools.ts::lineLineIntersect',
    kind: 'geometry',
    count: 1,
    why: 'A 2-D cross product used as a determinant for line intersection. Matches the shoelace fingerprint and is not an area.',
  },
  {
    key: 'web/src/cad/snap.ts::segSegIntersect',
    kind: 'geometry',
    count: 3,
    why: 'Cross products as determinants for segment intersection and its parameters. Not areas.',
  },
]

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** Every file under `dir` matching `exts`, skipping generated/vendored trees. */
function walk(dir, exts, skip) {
  const out = []
  const rec = (d) => {
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      const rel = path.relative(REPO, p)
      if (skip.some((s) => rel === s || rel.startsWith(s + path.sep))) continue
      if (e.isDirectory()) rec(p)
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
    }
  }
  rec(dir)
  return out
}

/** Enclosing `fn NAME` / `function NAME` / `const NAME = (` for a 0-based line.
 *
 *  A hit at column 0 in JS/TS is module scope by definition — an import, or a
 *  top-level `const`. Walking backwards from there finds the previous function
 *  and files the site under a name that does not contain it, which is how
 *  `const zoneArea = zoneShapeArea` first got attributed to `todayLabel`. */
function enclosingFn(lines, idx, lang) {
  if (lang !== 'rs' && !/^\s/.test(lines[idx])) return '<top-level>'
  const re =
    lang === 'rs'
      ? /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/
      : /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>)/
  for (let i = idx; i >= 0; i--) {
    const m = re.exec(lines[i])
    if (m) return m[1] ?? m[2] ?? '?'
  }
  return '<top-level>'
}

/** Source with line comments and string/char literals blanked, so brace
 *  counting is not thrown by `format!("… {x:.3} …")` or a `'}'` literal. */
function blankLiterals(line) {
  let out = ''
  let i = 0
  let inStr = false
  while (i < line.length) {
    const c = line[i]
    if (!inStr && c === '/' && line[i + 1] === '/') break
    if (!inStr && c === '"') {
      inStr = true
      out += ' '
      i++
      continue
    }
    if (inStr) {
      if (c === '\\') {
        i += 2
        out += '  '
        continue
      }
      if (c === '"') inStr = false
      out += ' '
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Line indices (0-based, inclusive) covered by a `#[cfg(test)]` / `#[test]`
 * item, found by BRACE MATCHING forward from the attribute.
 *
 * The first version of this walked BACKWARDS from each hit looking for the
 * nearest `#[cfg(test)]`, stopping at a column-0 `fn`/`impl`/`mod`. That is
 * wrong, and it was wrong in the direction that hides work: an attribute
 * applies to the ONE item after it, so a `#[cfg(test)]` helper sitting inside a
 * long `impl` block made every later line in that block read as test context.
 * Measured on this tree — `document.rs:318` is a `#[cfg(test)]` method inside
 * `impl Document`, and it silently swallowed `merge_zones`'s two PRODUCTION
 * area sites 146 lines further down. The census reported a clean population
 * that was missing them.
 *
 * A census whose detector under-reports is the failure this file exists to
 * stop, one level up. Recorded rather than quietly fixed, because "the
 * instrument grows, it does not gain an exemption" only means something if the
 * growth is visible.
 */
function rustTestRanges(lines) {
  const ranges = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[(test|cfg\(test\))\]/.test(lines[i])) continue
    // Find the item's opening brace, then match to its close.
    let depth = 0
    let started = false
    let j = i
    for (; j < lines.length; j++) {
      const l = blankLiterals(lines[j])
      for (const ch of l) {
        if (ch === '{') {
          depth++
          started = true
        } else if (ch === '}') depth--
      }
      if (started && depth <= 0) break
      // A `#[cfg(test)] use ...;` or const has no brace — it ends at the `;`.
      if (!started && /;\s*$/.test(l) && j > i) break
    }
    ranges.push([i, Math.min(j, lines.length - 1)])
  }
  return ranges
}

/** True when line `idx` sits inside a `#[cfg(test)]` region or a test file. */
function isRustTestContext(file, ranges, idx) {
  const base = path.basename(file)
  if (base === 'tests.rs' || base === 'metrics_tests.rs' || base.endsWith('_tests.rs')) return true
  return ranges.some(([a, b]) => idx >= a && idx <= b)
}

const RUST_HIT = /\.area(?:_on)?\s*\(/g

function censusRust() {
  const files = walk(path.join(REPO, 'crates/ds-core/src'), ['.rs'], [])
  const prod = new Map() // key -> {count, lines[]}
  let tests = 0
  for (const f of files) {
    const rel = path.relative(REPO, f)
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    const testRanges = rustTestRanges(lines)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      RUST_HIT.lastIndex = 0
      let n = 0
      while (RUST_HIT.exec(line)) n++
      if (!n) continue
      if (isRustTestContext(f, testRanges, i)) {
        tests += n
        continue
      }
      const key = `${rel}::${enclosingFn(lines, i, 'rs')}`
      const e = prod.get(key) ?? { count: 0, lines: [] }
      e.count += n
      e.lines.push(`${rel}:${i + 1}  ${line.trim()}`)
      prod.set(key, e)
    }
  }
  return { prod, tests }
}

// JS/TS detectors. Each is a NAMED shape so a red message says which one fired.
//
// The shoelace detector was FIRST written as "any `a*b - c*d`" and that version
// is worth recording, because its failure is the one this whole file is about.
// It fired on all 21 two-dimensional ROTATIONS in the tree (`lx*cos - ly*sin`)
// — a false-positive flood that would have forced 21 rotations into the
// register, and a register nobody can read is a register nobody audits. The
// discriminator is that a shoelace cross-product's four operands are all
// COORDINATES: `x0*y1 - x1*y0`, `p0.x*p1.y - p1.x*p0.y`, `a[0]*b[1] - b[0]*a[1]`.
// `cos`/`sin`/`r0`/`fx` are not, so every rotation drops out and every genuine
// shoelace stays. Falsified both ways: see the ledger.
const COORD = String.raw`(?:[A-Za-z_$][\w$]*\s*\.\s*[xy]\b|[A-Za-z_$][\w$]*\s*\[\s*[01]\s*\]|[xy]\d*\b|[A-Za-z_$]*[XY]\d*\b)`
const JS_HITS = [
  // The shoelace kernel: a cross-product of two POINTS, in any naming.
  { name: 'shoelace', re: new RegExp(`${COORD}\\s*\\*\\s*${COORD}\\s*-\\s*${COORD}\\s*\\*\\s*${COORD}`, 'g') },
  // Rect area off a shape-like binding: `s.w * s.h`, `z.shape.w * z.shape.h`.
  { name: 'rect-product', re: /\.\s*w\s*\*\s*[A-Za-z_$][\w$.?]*\.\s*h\b|\.\s*in_w\s*\*\s*[A-Za-z_$][\w$.?]*\.\s*in_h\b/g },
  // Any surviving name that claims to be a zone area.
  { name: 'zone-area-symbol', re: /\bzone(?:Shape)?Area\b|\bshapeArea\b|\bpolyArea\b/g },
]

const JS_SKIP = [
  'node_modules',
  'target',
  'dist',
  'graphify-out',
  'web/node_modules',
  'web/dist',
  'web/src/wasm',
  'out',
  'samples',
  'web/.dev-plans',
]

function censusJs() {
  const files = [
    ...walk(REPO, ['.ts', '.tsx', '.mjs', '.js'], JS_SKIP),
  ].filter((f) => !f.endsWith('.d.ts'))
  const prod = new Map()
  let tests = 0
  for (const f of files) {
    const rel = path.relative(REPO, f)
    const isTest = /\.test\.mjs$/.test(rel) || rel.startsWith('scripts/gates/') || rel.startsWith('bench/')
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      let n = 0
      const which = []
      for (const d of JS_HITS) {
        d.re.lastIndex = 0
        let m = 0
        while (d.re.exec(line)) m++
        if (m) {
          n += m
          which.push(d.name)
        }
      }
      if (!n) continue
      if (isTest) {
        tests += n
        continue
      }
      const key = `${rel}::${enclosingFn(lines, i, 'ts')}`
      const e = prod.get(key) ?? { count: 0, lines: [] }
      e.count += n
      e.lines.push(`${rel}:${i + 1}  [${which.join(',')}] ${line.trim()}`)
      prod.set(key, e)
    }
  }
  return { prod, tests }
}

// ---------------------------------------------------------------------------
// The structural assertion: web/ has no m²-returning helper at all.
// ---------------------------------------------------------------------------
//
// The register can only say a site is an ordering. This says the SHAPE of the
// module makes a magnitude unavailable: `zoneGeom.ts` may export no function
// whose name mentions area, and its one size export must return an ordering.
function assertNoAreaHelperInWeb() {
  const p = path.join(REPO, 'web/src/util/zoneGeom.ts')
  check(fs.existsSync(p), 'web/src/util/zoneGeom.ts is missing — the subject of this check does not exist')
  if (!fs.existsSync(p)) return
  const src = fs.readFileSync(p, 'utf8')
  const exported = [...src.matchAll(/^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  check(exported.length > 0, 'zoneGeom.ts exports nothing — the export scan matched no symbols, so this check is vacuous')
  for (const name of exported) {
    check(
      !/area/i.test(name),
      `web/src/util/zoneGeom.ts exports \`${name}\` — a helper whose name claims an area. web/ receives areas from the core; it does not compute them.`,
    )
  }
  // And nothing anywhere in web/ may import an area-named member from it.
  const files = walk(path.join(REPO, 'web/src'), ['.ts', '.tsx'], [])
  for (const f of files) {
    const src2 = fs.readFileSync(f, 'utf8')
    for (const m of src2.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*zoneGeom['"]/g)) {
      for (const spec of m[1].split(',')) {
        const imported = spec.trim().split(/\s+as\s+/)[0].trim()
        if (!imported) continue
        check(
          !/area/i.test(imported),
          `${path.relative(REPO, f)} imports \`${imported}\` from zoneGeom — an area-named import.`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reconciliation: detector <-> register, both directions.
// ---------------------------------------------------------------------------

function reconcile(label, found) {
  const reg = new Map(REGISTER.map((r) => [r.key, r]))
  for (const [key, e] of [...found.entries()].sort()) {
    const r = reg.get(key)
    if (!r) {
      fail(
        `UNREGISTERED ${label} area site — ${key} (${e.count} hit${e.count === 1 ? '' : 's'})\n` +
          e.lines.map((l) => `          ${l}`).join('\n') +
          `\n        Classify it in scripts/gates/area-census.mjs REGISTER, or route it through the core basis.`,
      )
      continue
    }
    check(
      e.count === r.count,
      `${key} has ${e.count} area site(s), the register declares ${r.count}. A site was added or removed inside an already-classified function.\n` +
        e.lines.map((l) => `          ${l}`).join('\n'),
    )
  }
}

function reconcileRegisterAgainstDisk(allFound) {
  for (const r of REGISTER) {
    check(
      allFound.has(r.key),
      `STALE REGISTER ENTRY — ${r.key} is classified '${r.kind}' but the detector finds no area site there. Delete the entry, or the register is describing a tree that no longer exists.`,
    )
  }
}

// ---------------------------------------------------------------------------

const rust = censusRust()
const js = censusJs()
const all = new Map([...rust.prod, ...js.prod])

if (process.argv.includes('--list')) {
  console.log('# Rust production sites')
  for (const [k, e] of [...rust.prod.entries()].sort()) {
    const r = REGISTER.find((x) => x.key === k)
    console.log(`  ${(r?.kind ?? 'UNREGISTERED').padEnd(10)} ${k} (${e.count})`)
    for (const l of e.lines) console.log(`             ${l}`)
  }
  console.log(`  (+ ${rust.tests} hits in test context)`)
  console.log('# JS/TS production sites')
  for (const [k, e] of [...js.prod.entries()].sort()) {
    const r = REGISTER.find((x) => x.key === k)
    console.log(`  ${(r?.kind ?? 'UNREGISTERED').padEnd(10)} ${k} (${e.count})`)
    for (const l of e.lines) console.log(`             ${l}`)
  }
  console.log(`  (+ ${js.tests} hits in test/gate/bench context)`)
  process.exit(0)
}

console.log('area-census — one area definition, both languages (R17)')
reconcile('Rust', rust.prod)
reconcile('JS/TS', js.prod)
reconcileRegisterAgainstDisk(all)
assertNoAreaHelperInWeb()

// Non-vacuity: a detector that matches nothing reconciles perfectly and proves
// nothing. The population it walks must be non-trivial and must contain the
// owner it exists to protect.
check(all.size >= 10, `the census found only ${all.size} production sites — the detector is not reaching the tree`)
check(
  all.has('crates/ds-core/src/lib.rs::effective_zone_areas'),
  'the census cannot see the area basis itself — the detector is not reaching crates/ds-core/src/lib.rs',
)

const scope =
  `scope: Rust crates/ds-core/src (${rust.prod.size} production fns, ${rust.tests} test hits) · ` +
  `JS/TS repo-wide minus node_modules|target|dist|wasm (${js.prod.size} production fns, ${js.tests} test/gate hits)`
console.log(`  ${scope}`)
if (failures === 0) {
  console.log(`area-census PASS (${checks} checks)`)
  process.exit(0)
}
console.log(`area-census FAIL (${checks} checks, ${failures} failing)`)
process.exit(1)
