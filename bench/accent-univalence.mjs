// ACCENT UNIVALENCE — the amber accent has one value, one name, and one meaning.
//
//   node bench/accent-univalence.mjs
//
// Ruling R3' (docs/design/merge-audit.md, campaign amendments): amber means
// "AI action" and only that — the act of generating. Choosing among generated
// options is navigation and is --accent blue.
//
// WHY THIS IS VALUE-BASED AND NOT NAME-BASED
// ------------------------------------------
// The existing style-gate keys on the NAMES `--accent-amber` / `ACCENT_AMBER`.
// A name-keyed sensor is structurally blind to a branch that uses neither — it
// cannot see a conflict expressed in a synonym. That blindness is the shared
// mechanism behind prediction P3 landing (a name the gate knew) and P5 being
// predicted to slip (a value the gate had no name for).
//
// So this matches the VALUE, in every encoding it can be written in. All four
// of these are the same colour, and Campaign 4's sweep only ever searched for
// the first:
//
//     #E8A13C            uppercase hex        (searched for)
//     #e8a13c            lowercase hex        (MISSED — 7 live sites)
//     rgba(232,161,60)   decimal triplet      (found late, 14 sites)
//     0xe8a13c           numeric literal      (MISSED — 4 live sites in three/)
//
// The lesson generalises past colour: a sensor keyed to a vocabulary is blind
// to synonyms, and the fix is to key it to the thing itself.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every way the amber accent can be spelled. */
const ENCODINGS = [
  { name: 'hex', re: /#e8a13c\b/gi },
  { name: 'decimal', re: /\b232\s*,\s*161\s*,\s*60\b/g },
  { name: 'numeric', re: /\b0xe8a13c\b/gi },
]

/**
 * The ONLY places the raw value may appear: the two declarations that define it,
 * which the style-gate's MIRRORS check already pins to each other.
 *
 * This is a declaration allowlist, not an exemption list. It names where the
 * value is DEFINED, never where it is used — so it cannot grow to accommodate a
 * new use site, which is exactly the pressure that turns a gate into a rubber
 * stamp (Face 12: a gate teaches the behaviour that passes it).
 */
const DECLARATIONS = [
  { file: 'web/src/styles.css', re: /^\s*--accent-amber(-rgb)?:/ },
  { file: 'web/src/editor/planStyle.ts', re: /^export const ACCENT_AMBER =/ },
]

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'wasm' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|css|mjs|html)$/.test(e.name)) out.push(p)
  }
  return out
}

let violations = 0
const strayValues = []
const deadFallbacks = []
const stringIdentifiers = []
const otherFallbacks = []

for (const file of walk(path.join(ROOT, 'web/src'))) {
  const rel = path.relative(ROOT, file)
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  // Block-comment state must be tracked ACROSS lines. Stripping only `//` and
  // single-line `/* */` leaves continuation lines looking like code, which
  // flagged this file's own explanatory comment about the value it documents.
  let inBlock = false
  lines.forEach((line, i) => {
    const opens = (line.match(/\/\*/g) || []).length
    const closes = (line.match(/\*\//g) || []).length
    const startedInBlock = inBlock
    inBlock = inBlock ? closes < opens + 1 : opens > closes
    if (startedInBlock) return
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/\/\*.*$/, '')
    if (code.trim().startsWith('*')) return

    // 1. The raw value outside its declaration.
    for (const { name, re } of ENCODINGS) {
      re.lastIndex = 0
      if (re.test(code)) {
        const declared = DECLARATIONS.some((d) => d.file === rel && d.re.test(code))
        if (!declared) strayValues.push({ rel, line: i + 1, enc: name, text: code.trim().slice(0, 78) })
      }
    }

    // 2. A var() fallback can never fire when :root defines the property, so it
    //    is dead code that DOCUMENTS AN INTENT THE TOKEN CONTRADICTS. Both
    //    branches independently found this family; neither should reintroduce it.
    const fb = code.match(/var\(\s*(--[a-z0-9-]+)\s*,\s*(#|rgb)/i)
    if (fb) {
      // R3'.5 rules the ACCENT family. Other tokens carry the same dead-fallback
      // defect, but widening a ruled check to an unruled scope is how a gate
      // starts failing for reasons nobody agreed to -- reported, not enforced.
      const entry = { rel, line: i + 1, text: code.trim().slice(0, 78) }
      if (/^--accent/.test(fb[1])) deadFallbacks.push(entry)
      else otherFallbacks.push(entry)
    }

    // 3. A bare identifier inside a quoted CSS string is not a colour — it is
    //    the literal text. Campaign 4's blanket `#E8A13C` -> `ACCENT_AMBER`
    //    replacement did this twice and shipped invalid CSS that no gate saw,
    //    because the result is neither a hex literal nor a named token.
    // Determined by QUOTE PARITY, not by a span match. `['a', ACCENT_AMBER,
    // 'b']` is a real identifier BETWEEN two strings; a span regex reads the gap
    // between them as a string and flags it. That was this check's own first
    // version -- anchoring to text that travels with the property rather than to
    // the property, i.e. the exact error it exists to catch, one level up.
    const idx = code.indexOf('ACCENT_AMBER')
    // `${ACCENT_AMBER}` inside a template literal is INTERPOLATION — the value
    // reaches the CSS. That is the fix for this defect, so flagging it would
    // punish the correction and leave the broken form as the only way to pass.
    if (idx > 0 && !/\$\{\s*$/.test(code.slice(0, idx))) {
      const before = code.slice(0, idx)
      const odd = (q) => (before.split(q).length - 1) % 2 === 1
      if (odd("'") || odd('"') || odd('`')) {
        stringIdentifiers.push({ rel, line: i + 1, text: code.trim().slice(0, 78) })
      }
    }
  })
}

const report = (title, rows, hint) => {
  if (!rows.length) return
  console.log(`\n${title} (${rows.length}):`)
  for (const r of rows) console.log(`  ${r.rel}:${r.line}  ${r.enc ? `[${r.enc}] ` : ''}${r.text}`)
  console.log(`  -> ${hint}`)
  violations += rows.length
}

report(
  'STRAY AMBER VALUE',
  strayValues,
  'use var(--accent-amber) / ACCENT_AMBER, or if this is not an AI action, it should not be amber at all (R3′).',
)
report(
  'DEAD var() FALLBACK',
  deadFallbacks,
  ':root defines the property, so the fallback can never fire. Delete it.',
)
report(
  'IDENTIFIER INSIDE A CSS STRING',
  stringIdentifiers,
  'this renders as literal text, not a colour. Interpolate it: `${ACCENT_AMBER}`.',
)

if (otherFallbacks.length) {
  console.log(
    `\nNOTE — ${otherFallbacks.length} dead var() fallback(s) on NON-accent tokens ` +
      `(--muted, --hairline, --surface, ...).\n  Same defect class, outside R3′'s ruled scope. ` +
      `Reported so it is visible, not enforced here.`,
  )
}

if (violations > 0) {
  console.log(`\nACCENT UNIVALENCE FAIL: ${violations} site(s).`)
  process.exit(1)
}
console.log('accent univalence OK — one value, one name; no dead fallbacks; no stringified identifiers')
