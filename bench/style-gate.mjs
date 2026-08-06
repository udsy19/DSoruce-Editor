// CI gate: no style literals in the plan render path outside the style table.
//
// The plan-visual-grammar campaign's premise is that style is DATA on one table
// (`web/src/editor/planStyle.ts` + CSS custom properties). A hex literal or a
// hand-set lineWidth in a renderer is a second source, and a second source is
// how canvas and export drift apart.
//
// Run: node bench/style-gate.mjs   (exit 1 on violation)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Files that draw the plan and must read every mark from the table.
//
// STAGED, and the staging is visible on purpose: a gate that silently excludes
// what has not been migrated is a gate that certifies nothing. GUARDED grows as
// each phase lands; PENDING names what is still unmigrated and which phase owns
// it, so nothing is quietly exempt.
// Each entry is [file, rules]. Rules are scoped per file because the phases
// land in a fixed order: Phase 1 makes COLOUR data, Phase 2b makes WIDTH data.
// Guarding colour in a file whose widths are still literal is not a loophole —
// it certifies exactly what has been migrated, and the PENDING block below
// states the rest. Guarding both early would force 2b's work into 1's commit.
const RULES_ALL = ['hex', 'rgba', 'lineWidth']
const GUARDED = [
  ['web/src/editor/paint.ts', RULES_ALL],
  ['web/src/import/PlacePalette.tsx', RULES_ALL],
  ['web/src/ui/LibraryPanel.tsx', RULES_ALL],
  ['web/src/three/Minimap.tsx', ['hex', 'rgba']],
  // furniture.ts was deleted by the ui-fixes merge (R2: symbols.ts owns symbol
  // geometry). The guard moves to its successor — a rule pointed at a deleted
  // path is a rule watching nothing.
  ['web/src/editor/symbols.ts', RULES_ALL],
  // Joined the guarded list as part of fixing it (standing policy): a file found
  // carrying a zone->colour mapping gets guarded, not just corrected.
  // pdf.ts was split under R1: pdfDoc.ts is the palette-free byte writer,
  // printPlan.ts owns PRINT_ZONE_FILL and the print inks, pdf.ts keeps the sheet
  // chrome and the two actions. The guard follows the PALETTE, not the filename.
  // All three stay guarded — a colour appearing in the writer or the chrome is
  // just as wrong, and leaving them unguarded would make the split a way OUT.
  ['web/src/export/printPlan.ts', ['hex', 'rgba']],
  ['web/src/export/pdfDoc.ts', ['hex', 'rgba']],
  ['web/src/export/pdf.ts', ['hex', 'rgba']],
]

// Values that MUST exist in both the TS table and the stylesheet, because
// canvas cannot read a CSS variable cheaply. Duplication here is allowed only
// because it is declared and checked. 14 dead `--zone-*` properties shadowed
// the TS zone palette with nothing enforcing agreement; this is that lesson.
const MIRRORS = [['ACCENT_AMBER', '--accent-amber']]

/**
 * DERIVED COPIES — a CSS custom property restating an existing colour in a
 * DIFFERENT ENCODING, which must equal the decimal expansion of its source.
 *
 * `rgba()` cannot take a hex, so `--accent-amber-rgb: 232, 161, 60` has to exist
 * as its own declaration; that is unavoidable. What was avoidable is that
 * NOTHING PINNED IT. MIRRORS covers `ACCENT_AMBER <-> --accent-amber` and stops
 * there, so the decimal copy was a second, unchecked source for the same value —
 * and seven live sites hang off it through `--accent-selection-rgb`. Rebranding
 * `--accent-amber` alone would have left every one of them on the old amber,
 * silently: ledger face 10, the second source, inside the campaign built to
 * eliminate it. accent-univalence.mjs even ASSERTED this pair was pinned "by the
 * style-gate's MIRRORS check" — a comment describing a check that did not exist.
 *
 * Found by an adversarial audit of a board that was already 12/12 green.
 */
const DERIVED_RGB = [['--accent-amber', '--accent-amber-rgb']]
const PENDING = [
  // Minimap is EXEMPT from the lineWidth rule, not pending on it. It is the one
  // canvas here that draws in DEVICE px: it never calls setTransform(dpr) and
  // scales every coordinate by dpr itself. strokePx returns CSS px, so routing
  // it through the ladder would introduce the exact INVERSE of the bug fixed in
  // e89654b -- half-weight strokes on retina. Declared, not overlooked.
  // TRIGGER FOR REVISITING: a THIRD canvas space. Two are tolerable as a
  // declared pair; three means the space is a property worth modelling, not an
  // exception worth listing. At that point normalize -- make the space explicit
  // at the boundary and convert -- rather than exempting again.
  ['web/src/three/Minimap.tsx', 'EXEMPT (lineWidth) — draws in device px by construction, not CSS px'],
]
/** The table itself and the stylesheet are where literals legitimately live. */
const HEX = /#[0-9a-fA-F]{3,8}\b/g
// A literal is a CONSTANT. `rgba(${r}, ${g}, ${b}, ${a})` inside a template is
// a colour CONSTRUCTOR building from variables — flagging it would push code to
// obfuscate the string rather than move a value, which is the opposite of the
// point. Require the first argument to be a digit.
const RGBA = /\brgba?\(\s*\d/g
// A width must come from the table: a ladder tier (strokePx) for marks in the
// drawing, or a named CHROME width for editing affordances.
//
// The rule targets a MAGIC NUMBER specifically -- an assignment whose right side
// STARTS with a numeric literal (`= 1.35`, `= 2 * dpr`). An assignment from an
// identifier (`= lw`, `= lw * 0.7`) is a width already derived from the table
// upstream, and flagging it only teaches people to inline a variable to get
// past the gate. Naming the value is the behaviour we want; the rule should not
// punish it.
const LINEWIDTH = /lineWidth\s*=\s*[0-9.]+/g

let violations = 0
for (const [rel, rules] of GUARDED) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    // Comments may cite measured values — the spec references are the point.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    if (code.trim().startsWith('*')) return
    const checks = [['hex', HEX, 'hex literal'], ['rgba', RGBA, 'rgba() literal'], ['lineWidth', LINEWIDTH, 'raw lineWidth']]
    for (const [id, re, what] of checks) {
      if (!rules.includes(id)) continue
      re.lastIndex = 0
      const m = code.match(re)
      if (m) {
        console.log(`  ${rel}:${i + 1}  ${what}: ${m.join(', ')}`)
        violations += m.length
      }
    }
  })
}

// DPR contract: the editor canvas is already `setTransform(dpr,0,0,dpr,0,0)`
// and toScreen() returns CSS px, so strokePx must NOT multiply by DPR itself.
// It did once, drawing every tier at 2x weight on retina. That survived review
// because the ladder is judged on RATIOS and a uniform error preserves them --
// so the only thing that can catch it is a rule about the code, not a look at
// the output. There is no TS test runner in this repo; the gate is where an
// invariant like this can live.
{
  const tbl = fs.readFileSync(path.join(ROOT, 'web/src/editor/planStyle.ts'), 'utf8')
  const fn = tbl.match(/export function strokePx\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)
  if (!fn) {
    console.log('  DPR CONTRACT: strokePx not found in planStyle.ts')
    violations++
  } else if (/\bdpr\b|devicePixelRatio/.test(fn[1])) {
    console.log('  DPR CONTRACT: strokePx multiplies by DPR; the ctx transform already does')
    violations++
  }
  for (const rel of ['web/src/editor/paint.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    if (/strokePx\([^)]*,[^)]*,[^)]*\)/.test(src)) {
      console.log(`  DPR CONTRACT: ${rel} still passes a third (dpr) argument to strokePx`)
      violations++
    }
  }
}

// PALETTE UNIQUENESS — the asserted values may live in exactly ONE file.
//
// The per-file gate cannot catch the likely recurrence, and that gap is the
// reason this exists: someone copies the current palette into a NEW panel next
// quarter, and the new file is not on the guarded list yet, so nothing fires.
// This check is repo-wide and value-based instead of file-based.
//
// It would NOT have caught stats.ZONE_META, which held the OLD hexes -- that
// one was found by reading the code. It closes the forward path. The standing
// policy covers the rest: any file discovered carrying a zone->colour mapping
// joins GUARDED as part of fixing it.
{
  const TABLE = 'web/src/editor/planStyle.ts'
  const tableSrc = fs.readFileSync(path.join(ROOT, TABLE), 'utf8')
  // Every asserted-or-derived palette value, read from the table itself so the
  // list cannot go stale relative to what ships.
  const zoneBlock = tableSrc.match(/export const ZONE: Record<[^>]*> = \{([\s\S]*?)\n\}/)
  const values = zoneBlock ? [...zoneBlock[1].matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase()) : []
  const unique = [...new Set(values)]
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'wasm' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx|css|mjs)$/.test(e.name)) out.push(p)
    }
    return out
  }
  for (const file of walk(path.join(ROOT, 'web/src'))) {
    const rel = path.relative(ROOT, file)
    if (rel === TABLE) continue
    const src = fs.readFileSync(file, 'utf8').toLowerCase()
    const hits = unique.filter((h) => src.includes(h))
    if (hits.length) {
      console.log(`  PALETTE COPY: ${rel} contains asserted zone value(s) ${hits.join(', ')}`)
      console.log(`    The palette lives in ${TABLE}. Import ZONE; do not restate its values.`)
      violations += hits.length
    }
  }
}

// ---------------------------------------------------------------------------
// GROUND-ZONE FILL CHECK (2.8): nothing reads a ground zone's palette fill
// ---------------------------------------------------------------------------
//
// `ZONE.Circulation` and `ZONE.Unassigned` still HOLD values — a ground zone
// falls back to them if it is ever drawn as figure (selected, hovered), and the
// thumbnail/legend code needs the record to exist. But reaching for
// `.fill` on either one, outside the ground logic in the style table itself, is
// how a surface starts painting the floor again: it is exactly what
// `renderThumb` did for the life of the candidate gallery.
//
// The rule is therefore narrow and specific: a `.fill` read off a GROUND entry
// of the palette, anywhere but the table. Reading `ZONE.Workspace.fill` is fine.
// Reading `ZONE[z.zone_type]` is fine — that is the polymorphic path every
// renderer uses, and the ground decision happens before it.
{
  const TABLE = 'web/src/editor/planStyle.ts'
  const GROUND_FILL = /ZONE\.(Circulation|Unassigned)\.fill/g
  const walk2 = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'wasm' || e.name.startsWith('.')) continue
      const p2 = path.join(dir, e.name)
      if (e.isDirectory()) walk2(p2, out)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p2)
    }
    return out
  }
  for (const file of walk2(path.join(ROOT, 'web/src'))) {
    const rel = path.relative(ROOT, file)
    if (rel === TABLE) continue
    const src = fs.readFileSync(file, 'utf8')
    const hits = [...src.matchAll(GROUND_FILL)].map((m) => m[0])
    if (hits.length) {
      console.log(`  GROUND FILL: ${rel} reads ${[...new Set(hits)].join(', ')}`)
      console.log('    Ground is not painted from the palette. Route through the')
      console.log(`    groundZones logic in ${TABLE}; the entry exists only as the`)
      console.log('    fallback for a ground zone drawn as figure (selection/hover).')
      violations += hits.length
    }
  }
}

// Mirror check: a declared TS/CSS pair that disagrees is worse than two
// literals, because it renders as one value while reading as another.
const tableSrc = fs.readFileSync(path.join(ROOT, 'web/src/editor/planStyle.ts'), 'utf8')
const cssSrc = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8')
for (const [tsName, cssVar] of MIRRORS) {
  const ts = tableSrc.match(new RegExp(`${tsName}\\s*=\\s*'(#[0-9a-fA-F]{3,8})'`))
  const css = cssSrc.match(new RegExp(`\\${cssVar}:\\s*(#[0-9a-fA-F]{3,8})`))
  if (!ts || !css) {
    console.log(`  MIRROR MISSING: ${tsName} <-> ${cssVar}`)
    violations++
  } else if (ts[1].toLowerCase() !== css[1].toLowerCase()) {
    console.log(`  MIRROR DRIFT: ${tsName}=${ts[1]} but ${cssVar}=${css[1]}`)
    violations++
  }
}

for (const [hexVar, rgbVar] of DERIVED_RGB) {
  const cssAll = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8')
  const hex = cssAll.match(new RegExp(`\\${hexVar}:\\s*#([0-9a-fA-F]{6})`))
  const rgb = cssAll.match(new RegExp(`\\${rgbVar}:\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)`))
  if (!hex || !rgb) {
    console.log(`  DERIVED MISSING: ${hexVar} <-> ${rgbVar}`)
    violations++
    continue
  }
  const want = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16))
  const got = [1, 2, 3].map((i) => Number(rgb[i]))
  if (want.join() !== got.join()) {
    console.log(
      `  DERIVED DRIFT: ${rgbVar} is ${got.join(', ')} but ${hexVar} = #${hex[1]} expands to ${want.join(', ')}`,
    )
    violations++
  }
}

if (violations > 0) {
  console.log(`\nSTYLE GATE FAIL: ${violations} literal(s) outside planStyle.ts/styles.css`)
  console.log('Move them into web/src/editor/planStyle.ts and read them from there.')
  process.exit(1)
}
console.log('style gate: OK — no style literals in the guarded render path')
for (const [rel, rules] of GUARDED) {
  if (rules.length < RULES_ALL.length) {
    console.log(`  note: ${rel} guarded for [${rules.join(', ')}] only`)
  }
}
if (PENDING.length) {
  console.log(`\nPENDING migration (${PENDING.length}) — not yet guarded:`)
  for (const [f, why] of PENDING) console.log(`  ${f}  <- ${why}`)
}
