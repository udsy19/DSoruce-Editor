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
]

// Values that MUST exist in both the TS table and the stylesheet, because
// canvas cannot read a CSS variable cheaply. Duplication here is allowed only
// because it is declared and checked. 14 dead `--zone-*` properties shadowed
// the TS zone palette with nothing enforcing agreement; this is that lesson.
const MIRRORS = [['ACCENT_AMBER', '--accent-amber']]
const PENDING = [
  // Minimap is EXEMPT from the lineWidth rule, not pending on it. It is the one
  // canvas here that draws in DEVICE px: it never calls setTransform(dpr) and
  // scales every coordinate by dpr itself. strokePx returns CSS px, so routing
  // it through the ladder would introduce the exact INVERSE of the bug fixed in
  // e89654b -- half-weight strokes on retina. Declared, not overlooked.
  ['web/src/three/Minimap.tsx', 'EXEMPT (lineWidth) — draws in device px by construction, not CSS px'],
  ['web/src/editor/furniture.ts', 'Phase 2c — LOD rework touches every lineWidth here anyway'],
]
/** The table itself and the stylesheet are where literals legitimately live. */
const HEX = /#[0-9a-fA-F]{3,8}\b/g
// A literal is a CONSTANT. `rgba(${r}, ${g}, ${b}, ${a})` inside a template is
// a colour CONSTRUCTOR building from variables — flagging it would push code to
// obfuscate the string rather than move a value, which is the opposite of the
// point. Require the first argument to be a digit.
const RGBA = /\brgba?\(\s*\d/g
// A width must come from the table: a ladder tier (strokePx) for marks in the
// drawing, or a named CHROME width for editing affordances. Anything else is a
// magic number.
const LINEWIDTH = /lineWidth\s*=\s*(?!.*(strokePx|CHROME\.|widthPx))/g

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
