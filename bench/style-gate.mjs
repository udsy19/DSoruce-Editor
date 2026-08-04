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
const GUARDED = [
  // 'web/src/editor/paint.ts',      // Phase 1 completion — 41 hex + 22 rgba remain
]
const PENDING = [
  ['web/src/editor/paint.ts', 'Phase 1 completion (walls/zones migrated; grid, labels, poche-hatch remain)'],
  ['web/src/editor/furniture.ts', 'Phase 2c — LOD rework touches every lineWidth here anyway'],
  ['web/src/import/PlacePalette.tsx', 'Phase 1 completion — 18 hex'],
  ['web/src/ui/LibraryPanel.tsx', 'Phase 1 completion — 68 hex'],
  ['web/src/three/Minimap.tsx', 'Phase 1 completion — 2 hex'],
]
/** The table itself and the stylesheet are where literals legitimately live. */
const HEX = /#[0-9a-fA-F]{3,8}\b/g
const RGBA = /\brgba?\(/g
const LINEWIDTH = /lineWidth\s*=\s*(?!.*strokePx)/g

let violations = 0
for (const rel of GUARDED) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    // Comments may cite measured values — the spec references are the point.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    if (code.trim().startsWith('*')) return
    for (const [re, what] of [[HEX, 'hex literal'], [RGBA, 'rgba() literal'], [LINEWIDTH, 'raw lineWidth']]) {
      re.lastIndex = 0
      const m = code.match(re)
      if (m) {
        console.log(`  ${rel}:${i + 1}  ${what}: ${m.join(', ')}`)
        violations += m.length
      }
    }
  })
}

if (violations > 0) {
  console.log(`\nSTYLE GATE FAIL: ${violations} literal(s) outside planStyle.ts/styles.css`)
  console.log('Move them into web/src/editor/planStyle.ts and read them from there.')
  process.exit(1)
}
console.log('style gate: OK — no style literals in the guarded render path')
if (PENDING.length) {
  console.log(`\nPENDING migration (${PENDING.length}) — not yet guarded:`)
  for (const [f, why] of PENDING) console.log(`  ${f}  <- ${why}`)
}
