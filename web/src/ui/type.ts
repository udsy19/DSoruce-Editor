// Typography constants for code that can't read a CSS variable cheaply — canvas
// `ctx.font` strings and the handful of inline styles that survive.
//
// The stacks live ONCE here (and once in `styles.css` as `--font-mono` /
// `--font-ui`, which these mirror deliberately: the CSS token serves stylesheets,
// these serve `ctx.font`). They used to be written out by hand at ~30 call sites
// against a font that was never loaded — see `main.tsx` for why that mattered.

/** NUMERICS ONLY: dimensions, areas, counts, prices, coordinates, scale bars. */
export const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
/** UI and body text. */
export const UI = "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif"
/** Large display headlines only. */
export const DISPLAY = "'Schibsted Grotesk', 'Hanken Grotesk', ui-sans-serif, sans-serif"

/** A `ctx.font` shorthand in the numeric face, e.g. `mono(600, 11)`. */
export const mono = (weight: number | string, px: number): string => `${weight} ${px}px ${MONO}`
/** A `ctx.font` shorthand in the UI face. */
export const ui = (weight: number | string, px: number): string => `${weight} ${px}px ${UI}`
