// EXPORT PARITY — does the sheet draw the same plan the paper canvas does?
//
//   node bench/export-parity.mjs
//
// STRUCTURAL equivalence, not pixel equivalence. The two renderers legitimately
// differ in resolution, anti-aliasing and page scale; what they must NOT differ
// on is the GRAMMAR — which colours a zone kind gets, which zones are ground,
// which weights the ladder assigns, and what identifies a room.
//
// Source-based rather than render-based, deliberately. A pixel diff between a
// 187-dpi sheet raster and a screen canvas would be dominated by AA and scale,
// and tuning a tolerance until it passes is how a parity check becomes a
// rubber stamp. These assertions are about whether both paths READ THE SAME
// TABLE, which is the property that actually keeps them in step.

let DEFERRED_LIST = []
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const table = read('web/src/editor/planStyle.ts')
const pdf = read('web/src/export/pdf.ts')
const paint = read('web/src/editor/paint.ts')

let fails = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`)
  if (!ok) fails++
}

console.log('export parity — paper-profile canvas vs PDF sheet\n')

// 1. One palette. The export must not restate zone colours.
const zoneBlock = table.match(/export const ZONE: Record<[^>]*> = \{([\s\S]*?)\n\}/)
const assertedHexes = [...(zoneBlock?.[1] ?? '').matchAll(/#[0-9a-fA-F]{6}/g)].map((m) =>
  m[0].toLowerCase(),
)
const copied = assertedHexes.filter((h) => pdf.toLowerCase().includes(h))
check(
  'export restates no zone colour',
  copied.length === 0,
  `pdf.ts contains ${copied.join(', ')} — it must read ZONE, not repeat it`,
)
check(
  'export derives PRINT_ZONE_FILL from ZONE',
  /PRINT_ZONE_FILL[\s\S]{0,200}Object\.entries\(ZONE\)/.test(pdf),
  'PRINT_ZONE_FILL should be built from the table',
)

// 2. Ground zones. Circulation is unfilled on paper; the sheet must agree.
// SPECIFIC to the fill loop. An earlier version matched
// `groundZones.includes(z.zone_type)` anywhere in the file — which the ZONE KEY
// loop also contains, so deleting the fill guard still passed. A parity check
// that passes when the parity is broken is worse than none: it certifies the
// bug. Anchor the assertion to the code path it is about.
const fillLoop = pdf.match(/if \(zoneFill\) \{[\s\S]*?\n {2}\}/)
check(
  'sheet honours groundZones (circulation unfilled)',
  !!fillLoop && /groundZones\.includes\(z\.zone_type\)\) continue/.test(fillLoop[0]),
  'the sheet fills every zone, including ground — the canvas does not',
)
check(
  'canvas honours groundZones',
  /groundZones\.includes\(z\.zone_type\)/.test(paint),
  'paint.ts should skip ground zones too',
)

// 3. Weights. Both paths take tiers from the ladder.
check(
  'sheet takes wall weight from the ladder',
  /strokePx\('wall'/.test(pdf),
  'the sheet hardcodes wall weights instead of reading strokePx',
)
check(
  'sheet scales the ladder uniformly (ratios preserved)',
  /PRINT_WEIGHT_SCALE/.test(pdf),
  'a per-tier print adjustment would corrupt the measured ratios',
)

// 3b. Wall FORM. A wall is a thickness polygon with both faces stroked, not a
//     fat centreline. The sheet drew one stroke at scaled thickness while the
//     canvas drew a double line, so the same document read as a different
//     drawing depending on which renderer produced it.
// Anchored to the GEOMETRY (a half-thickness perpendicular offset), not to
// formatting. A regex over exact whitespace fails on a prettier run and tells
// you nothing about the drawing.
const wallSection = pdf.slice(pdf.indexOf('TWO-FACE WALLS'))
check(
  'sheet draws two-face walls, not a centreline stroke',
  /const hw = \(w\.thickness/.test(wallSection) && /closePath/.test(wallSection),
  'the sheet strokes a single line per wall; the canvas strokes the thickness polygon',
)
check(
  'sheet carries the wall fill (hatch) from the profile',
  /wallFill\.kind === 'hatch'/.test(pdf),
  'the Rayon hatch stops at the screen and never reaches paper',
)

// 4. Identification. On paper the legend is the only identification, so the
//    sheet must carry one, and it must derive from the document.
check(
  'sheet prints a zone key',
  /ZONE KEY/.test(pdf),
  'the paper profile prints almost no room names — without a key the sheet is unreadable',
)
check(
  'the zone key derives from the document, not a fixed list',
  /for \(const z of state\.zones[\s\S]{0,320}zoneKinds\.push/.test(pdf),
  'a hardcoded key would show swatches for zones the plan does not contain',
)
check(
  'the zone key omits ground zones',
  /groundZones\.includes\(z\.zone_type\)\) continue \/\/ ground has no swatch/.test(pdf),
  'circulation has no fill on the sheet, so a swatch for it would explain nothing',
)

// 4b. PAPER INVARIANT (Ruling R5.2): amber never appears in deliverable output,
//     in any encoding. Amber's two meanings are AI action and live selection;
//     both are CHROME, and chrome vanishes on paper. The sheet belongs to the
//     qbiq palette under R1.
//
//     Value-based, like accent-univalence, and for the same reason: a check
//     keyed to the token NAMES would pass a sheet that hardcoded the value.
{
  const DELIVERABLES = [
    'web/src/export/pdf.ts',
    'web/src/export/sheet.ts',
    'web/src/export/report.ts',
    'web/src/export/sheetSet.ts',
    'web/src/export/servicesSheets.ts',
  ]
  /**
   * DEFERRED — an ENUMERATED allowlist, not a skipped file.
   *
   * These exact lines carry amber on paper and violate R5.2 today. R1 assigns
   * deliverable colour to the qbiq palette, which arrives with the export
   * branch in Phase 2, so inventing hues here would be choosing silently.
   *
   * The structure matters more than the contents: the files are still SCANNED,
   * and anything that is not one of these exact lines hard-fails NOW. A
   * deferral that merely printed would be a warning, and warnings rot — this
   * one cannot absorb a third violation. Phase 2 exit requires this list empty.
   */
  const DEFERRED = {
    'web/src/export/sheet.ts': [
      "import { ACCENT_AMBER, hexToRgba, hexToRgb01 } from '../editor/planStyle'",
      'export const ACCENT: Rgb = hex2rgb(ACCENT_AMBER)',
      'ctx.fillStyle = hexToRgba(ACCENT_AMBER, 0.5)',
    ],
    'web/src/export/report.ts': [
      "import { ACCENT_AMBER } from '../editor/planStyle'",
      "const ALT_COLORS = ['#7b74d4', ACCENT_AMBER, '#3f9c95', '#c4607a', '#5b8def']",
    ],
  }
  const AMBER = [/#e8a13c\b/i, /\b232\s*,\s*161\s*,\s*60\b/, /\b0xe8a13c\b/i,
                 /ACCENT_AMBER/, /SELECTION_ACCENT/, /--accent-amber/, /--accent-selection/]
  const stillDeferred = []
  for (const rel of DELIVERABLES) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    const allowed = DEFERRED[rel] ?? []
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    const hits = []
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '')
      if (code.trim().startsWith('*')) return
      if (!AMBER.some((re) => re.test(code))) return
      const t = code.trim()
      if (allowed.includes(t)) stillDeferred.push(`${rel}:${i + 1}`)
      else hits.push(`${rel}:${i + 1}  ${t.slice(0, 62)}`)
    })
    check(
      `paper invariant — no NEW amber in ${path.basename(rel)}`,
      hits.length === 0,
      hits.join('\n          '),
    )
  }
  DEFERRED_LIST = stillDeferred
  const total = Object.values(DEFERRED).reduce((n, a) => n + a.length, 0)
  if (stillDeferred.length !== total) {
    console.log(
      `  note  deferral list has ${total} entries but ${stillDeferred.length} matched — ` +
        `shrink DEFERRED in bench/export-parity.mjs if a site was fixed.`,
    )
  }
}

// 5. Colour math has one home.
check(
  'no second hex->rgb implementation',
  !/function hex2rgb\(hex: string\): Rgb \{[\s\S]{0,80}parseInt/.test(read('web/src/export/sheet.ts')),
  'sheet.ts should delegate to planStyle rather than reimplement the conversion',
)

console.log()
if (fails > 0) {
  console.log(`EXPORT PARITY FAIL: ${fails} check(s) — canvas and sheet can disagree.`)
  process.exit(1)
}
console.log('export parity OK — both paths read one table for colour, ground, weight and key')
if (DEFERRED_LIST.length) {
  console.log(
    `\nDEFERRED (${DEFERRED_LIST.length}) — R5.2 amber-on-paper, allowlisted by exact line:\n` +
      DEFERRED_LIST.map((d) => `  ${d}`).join('\n') +
      `\n  Resolve on qbiqPalette in Phase 2. PHASE 2 EXIT REQUIRES THIS LIST EMPTY.\n` +
      `  Any OTHER amber in a deliverable fails now — these files are scanned, not skipped.`,
  )
}
