// Space-planning STRATEGIES for the autonomous test-fit search (M7). Kept in a
// tiny, dependency-free module (no wasm / three imports) so it can be unit-
// tested in node and imported anywhere without pulling the whole editor. The
// Rust side (`layout::Strategy`) is the source of truth for what each strategy
// DOES; this file is the TS mirror + the human-facing labels the gallery shows.

/** A space-planning strategy the autonomous search optimises for (mirrors Rust
 *  `layout::Strategy`). The gallery's A/B/C run one per strategy so the three
 *  are strategically distinct — a real trade-off, not seed-noise:
 *   - `Open` — maximise open workstations, minimal enclosed rooms (densest).
 *   - `Balanced` — the professional derived mix (the default).
 *   - `Cellular` — privacy-forward: more enclosed offices + focus, fewer desks. */
export type Strategy = 'Open' | 'Balanced' | 'Cellular'

/** The three strategies, in the order the gallery presents them as A / B / C. */
export const STRATEGIES: Strategy[] = ['Open', 'Balanced', 'Cellular']

/** Disjoint seed-range stride per strategy, so a candidate's global seed
 *  (`strategyIndex·STRIDE + s`) is unique for gallery keys while `(strategy,
 *  seed)` still reproduces the exact plan deterministically. */
export const STRATEGY_SEED_STRIDE = 100_000

/**
 * Normalize a Regenerate seed cursor into a window offset WITHIN a strategy's
 * stride band. The UI advances the cursor every Regenerate press so consecutive
 * presses search a different seed window (real variety); this wraps it so the
 * searched seeds (`offset+1 .. offset+maxIter`) never spill past the stride and
 * collide with the next strategy. Deterministic: the same cursor + maxIter
 * always yields the same window. Windows a full `maxIter` apart are disjoint, so
 * distinct cursors (spaced ≥ maxIter) explore distinct seed sets.
 */
export function seedWindowOffset(seedOffset: number, maxIter: number): number {
  return Math.max(0, Math.floor(seedOffset)) % Math.max(1, STRATEGY_SEED_STRIDE - maxIter - 1)
}

/** Human-facing label for each strategy (gallery / report). */
export const STRATEGY_LABEL: Record<Strategy, string> = {
  Open: 'Open',
  Balanced: 'Balanced',
  Cellular: 'Cellular',
}

/** One-line rationale for each strategy (gallery card subtitle). */
export const STRATEGY_BLURB: Record<Strategy, string> = {
  Open: 'Maximises open workstations — minimal enclosed rooms, densest seat count.',
  Balanced: 'The professional derived mix of open desks and enclosed support rooms.',
  Cellular: 'Privacy-forward — more enclosed offices and focus rooms, fewer open desks.',
}
