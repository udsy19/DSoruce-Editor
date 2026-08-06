// Self-hosted fonts (no runtime network dependency).
//   Hanken Grotesk    — UI and body text.
//   Schibsted Grotesk — large display headlines only.
//   IBM Plex Mono     — NUMERICS ONLY: dimensions, areas, counts, prices,
//                       coordinates, scale read-outs.
//
// Plex Mono was referenced ~40 times across the CSS and the canvas renderers and
// was NEVER LOADED — every dimension in a drawing product fell back to whatever
// mono the OS happened to have (SF Mono, Consolas, DejaVu…), so the numbers
// looked different on every machine and the metrics rail didn't line up. Loading
// it is the substance of this typography pass, not a polish item.
//
// `latin-<weight>.css` (not `<weight>.css`) pulls ONE @font-face instead of five
// — the latin subset is digits + basic Latin + punctuation, which is all the
// numerics need. Weights are only those the app actually sets: 400 (values),
// 500 (minimap), 600 (emphasis/labels), 700 (marker pins).
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/hanken-grotesk/700.css'
import '@fontsource/schibsted-grotesk/500.css'
import '@fontsource/schibsted-grotesk/700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-700.css'

import { createRoot } from 'react-dom/client'
import { AppShell } from './shell/AppShell'
import './styles.css'

// Dev-time backstop for the same invariant `ui/fonts.test.mjs` enforces
// statically: a font that is NAMED but not LOADED renders in whatever the OS
// substitutes, on someone else's machine, silently. The test catches it at
// commit time by comparing named vs imported families; this catches the case a
// static scan can't see — a family that is imported but fails to fetch.
// ASK EACH FAMILY FOR A WEIGHT IT ACTUALLY SHIPS. `check('12px "X"')` implies
// weight 400, and the imports above deliberately load only the weights the app
// sets — Schibsted Grotesk is display-only, at 500 and 700. So the old form
// asked for a face that was never meant to exist and reported the family as
// "did not load" on EVERY dev page load, while `document.fonts` held its faces
// and `check('700 32px …')` was true. A guard that cries wolf on a correct tree
// is worse than none: it trains you to ignore the one time it is right.
if (import.meta.env.DEV) {
  void document.fonts.ready.then(() => {
    for (const family of ['Hanken Grotesk', 'Schibsted Grotesk', 'IBM Plex Mono']) {
      // The weights REGISTERED for this family, read back from the document
      // rather than restated here — a second hardcoded weight list would drift
      // from the imports above the moment one changes.
      const weights = [...document.fonts].filter((f) => f.family === family).map((f) => f.weight)
      if (weights.length === 0) {
        console.error(
          `[fonts] "${family}" has no @font-face at all — it is named but never ` +
            `imported. See src/ui/fonts.test.mjs.`,
        )
        continue
      }
      if (!weights.some((w) => document.fonts.check(`${w} 12px "${family}"`))) {
        console.error(
          `[fonts] "${family}" is imported (weights ${weights.join(', ')}) but did not ` +
            `load — text using it is rendering in an OS substitute. ` +
            `See src/ui/fonts.test.mjs.`,
        )
      }
    }
  })
}

createRoot(document.getElementById('root')!).render(<AppShell />)
