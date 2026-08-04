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

createRoot(document.getElementById('root')!).render(<AppShell />)
