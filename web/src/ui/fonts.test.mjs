// Every font family the codebase NAMES must actually be loaded.
// Run from web/:  node src/ui/fonts.test.mjs
//
// WHY THIS EXISTS
// ---------------
// Two fonts were referenced for months and never loaded:
//   • 'IBM Plex Mono'  — ~38 sites (styles.css + every canvas renderer). Not in
//     package.json at all, so every dimension, area, coordinate and scale bar in
//     a DRAWING PRODUCT silently fell back to whatever mono the OS had — SF Mono
//     here, Consolas there — with different metrics, so numeric columns never
//     aligned the same way twice.
//   • 'Space Grotesk'  — 9 sites, same story, falling back to system-ui.
//
// Neither failed loudly. Nothing rendered blank; it just rendered *wrong*, on
// someone else's machine, forever. Two of these is a pattern, not bad luck — so
// this test asserts the invariant instead of trusting the next reviewer to spot
// a third.
//
// It is deliberately a static check (no browser): it compares the families NAMED
// anywhere in src/ against the families main.tsx actually IMPORTS, so it runs in
// CI and fails at commit time rather than in someone's browser.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..')

/** Families that are legitimately unloaded: generic CSS keywords and the
 *  system-stack fallbacks that exist precisely to be substituted. */
const GENERIC = new Set([
  'sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-monospace',
  'ui-serif', 'cursive', 'fantasy', 'inherit', 'initial', 'unset', 'revert',
  // Deliberate OS fallbacks inside a stack — never the first choice.
  'SFMono-Regular', 'Menlo', 'Consolas', 'Segoe UI', 'Helvetica', 'Helvetica Neue',
  'Arial', 'Roboto', 'Courier New', 'DejaVu Sans Mono',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'wasm' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|css)$/.test(p) && !p.endsWith('.test.mjs')) out.push(p)
  }
  return out
}

const files = walk(SRC)

// --- what the app LOADS: the @fontsource imports in main.tsx --------------
const mainTsx = readFileSync(join(SRC, 'main.tsx'), 'utf8')
const loaded = new Set()
for (const m of mainTsx.matchAll(/@fontsource\/([a-z0-9-]+)\//g)) {
  // '@fontsource/ibm-plex-mono' → 'ibm plex mono'
  loaded.add(m[1].replace(/-/g, ' '))
}

// --- what the app NAMES: any quoted family in a font / font-family value ---
// Matches CSS `font-family: 'X', …` / `font: 600 11px 'X', …` and the JS
// equivalents (ctx.font templates, fontFamily style props).
const named = new Map() // family -> Set(file)
const FONT_CTX = /(?:font-family|fontFamily|font)\s*[:=]\s*([^;\n}]+)/gi
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const ctx of src.matchAll(FONT_CTX)) {
    for (const q of ctx[1].matchAll(/['"]([A-Za-z][A-Za-z0-9 _-]{2,})['"]/g)) {
      const fam = q[1].trim()
      if (GENERIC.has(fam)) continue
      if (!named.has(fam)) named.set(fam, new Set())
      named.get(fam).add(relative(SRC, f))
    }
  }
}

let fail = 0
console.log(`loaded via @fontsource: ${[...loaded].join(', ') || '(none)'}`)
for (const [fam, where] of [...named].sort()) {
  const key = fam.toLowerCase()
  const ok = [...loaded].some((l) => l === key)
  if (ok) {
    console.log(`  ok    ${fam}  (${where.size} site${where.size === 1 ? '' : 's'})`)
  } else {
    fail++
    console.error(
      `  FAIL  "${fam}" is named in ${where.size} place(s) but never loaded.\n` +
        `        ${[...where].slice(0, 6).join(', ')}${where.size > 6 ? ', …' : ''}\n` +
        `        Either import it in main.tsx (@fontsource/${key.replace(/ /g, '-')})\n` +
        `        or stop naming it — a font that is named and not loaded renders in\n` +
        `        whatever the OS substitutes, differently on every machine.`,
    )
  }
}

console.log(fail === 0 ? 'fonts.test.mjs: ALL PASS' : `fonts.test.mjs: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
