// THE ZONE WASHES MUST SIT IN THE REFERENCE'S SATURATION / LIGHTNESS BAND.
//
// `research/qbiq-plan-style-spec.json` `/palette/zone_fill_targets` is the
// measured contract, extracted from the reference report's own vector fills:
//
//     saturation 85–100 %  (mean 86.2, one muted service colour allowed)
//     lightness  80–92  %  (mean 85.7)
//
// DSource's palette was measured against it and **seven of eight zones failed
// saturation**, most of them by 30 points: Workspace at S 55, Meeting at S 50,
// Core at S 53, ClosedOffice at S 61. That is not a subtle divergence — it is
// half the chroma the reference uses, which is why the plan read grey and muddy
// where the reference reads as crisp pastel rooms on white. Nothing in the
// drawing had to change for that; only the fills did.
//
// INDEPENDENCE (`.claude/rules/gate-independence.md`): the band comes from the
// SPEC FILE, an external anchor, and the values come from parsing
// `planStyle.ts`'s source. Neither side is produced by the renderer under test,
// and the gate does not calibrate on the palette it is judging — which is the
// mistake that would let a drifting palette certify its own drift.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')

const spec = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'research/qbiq-plan-style-spec.json'), 'utf8'),
)
const targets = spec?.palette?.zone_fill_targets
const SRC = fs.readFileSync(path.join(here, 'planStyle.ts'), 'utf8')

/** GROUND is not a program wash. Circulation and unassigned floor are the
 *  surface the plan sits on — neutral by ruling, and unfilled on paper — so the
 *  reference's programme-colour contract does not apply to them. */
const GROUND = new Set(['Circulation', 'Unassigned'])

function hsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  return { s: s * 100, l: l * 100 }
}

function zoneFills() {
  const block = /export const ZONE[^=]*=\s*\{([\s\S]*?)\n\}/.exec(SRC)
  assert.ok(block, 'planStyle.ts must declare a ZONE table')
  const out = []
  const re = /(\w+):\s*\{\s*fill:\s*'(#[0-9a-fA-F]{6})'/g
  let m
  while ((m = re.exec(block[1]))) out.push({ name: m[1], fill: m[2] })
  return out
}

test('the spec still carries the band this gate is anchored to', () => {
  assert.ok(targets, 'zone_fill_targets missing from qbiq-plan-style-spec.json')
  assert.ok(Array.isArray(targets.saturation_pct?.range), 'no saturation range')
  assert.ok(Array.isArray(targets.lightness_pct?.range), 'no lightness range')
})

test('every programme zone wash sits in the reference band', () => {
  const zones = zoneFills()
  // Non-vacuity: a regex that stopped matching would report a clean sweep over
  // an empty list. The palette has never had fewer than six programme zones.
  const programme = zones.filter((z) => !GROUND.has(z.name))
  assert.ok(
    programme.length >= 6,
    `only parsed ${programme.length} programme zones — the instrument is broken, not the palette`,
  )

  const [sLo, sHi] = targets.saturation_pct.range
  const [lLo, lHi] = targets.lightness_pct.range
  const bad = []
  for (const z of programme) {
    const { s, l } = hsl(z.fill)
    if (s < sLo || s > sHi) bad.push(`${z.name} ${z.fill} S=${s.toFixed(1)} (band ${sLo}–${sHi})`)
    if (l < lLo || l > lHi) bad.push(`${z.name} ${z.fill} L=${l.toFixed(1)} (band ${lLo}–${lHi})`)
  }
  assert.deepEqual(bad, [], `zone washes outside the reference band:\n  ${bad.join('\n  ')}`)
})

test('ground stays neutral — the programme contract does not apply to it', () => {
  for (const z of zoneFills().filter((x) => GROUND.has(x.name))) {
    const { s } = hsl(z.fill)
    assert.ok(
      s < 10,
      `${z.name} is ${z.fill} (S=${s.toFixed(1)}) — ground is the surface the plan sits on, ` +
        'not a programme colour',
    )
  }
})
