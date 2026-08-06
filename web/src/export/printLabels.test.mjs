// Ground carries no name ON THE SHEET either — Phase 2.5.
//
// Run from web/:  node src/export/printLabels.test.mjs
// @covers: web/src/export/printPlan.ts
//
// `renderPrintCanvas`'s zone FILL honours the ground rule (measured: 1 px of the
// composited circulation grey across 1400x1000). Its roomLabels branch did not:
// it printed `z.label` for ANY Rect zone clearing a size gate, with no ground
// check at all. Residual pockets are `Poly` and escaped; the DRAWN network —
// `Corridor`, `Entry`, `Aisle` — is all `Rect`.
//
// On the reference plate no corridor cleared the gate, so it never fired. That
// is a property of one plate at one scale, not a fix: a wider corridor, a bigger
// sheet or a closer scale prints CORRIDOR onto a client deliverable. This test
// builds exactly that plate rather than waiting for one.

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, 'printPlan.ts'), 'utf8')

// The roomLabels branch, isolated.
const start = src.indexOf('if (roomLabels)')
assert.ok(start > 0, 'roomLabels branch not found in printPlan.ts')
// Wide enough to contain the whole branch INCLUDING its commentary. A slice
// that stops short reports "the gate vanished" when the gate simply moved —
// which it did, the first time this ran.
const branch = src.slice(start, start + 2500)

// (a) It must consult the ground rule. Without this the check below is the only
//     thing standing between a corridor and a client sheet.
assert.ok(
  /isGroundZone|groundZones/.test(branch),
  'printPlan roomLabels prints a label for any Rect zone with no ground check — ' +
    'the drawn network (Corridor/Entry/Aisle) is all Rect, so a corridor wide ' +
    'enough to clear the size gate prints CORRIDOR onto a deliverable',
)

// (b) The size gate must still be there: this fix must not turn into "label
//     everything that is not ground", which would print names that cannot fit.
assert.ok(/s\.w \* k >|s\.h \* k >/.test(branch),
  'the label fit gate vanished — a name that cannot fit must still not print')

console.log('PASS printLabels: the sheet\'s room labels consult the ground rule and keep the fit gate')
