// The PlateExtractor contract every candidate implements.
//
// The whole point of the bake-off is that swapping implementations is a config
// change, never a call-site change: `VITE_IMPL_PLATE=baseline|dxffix|...` picks
// one, and nothing in web/src/ knows which it got. Candidates therefore may NOT
// import from each other, and may NOT reach into app state — a candidate gets a
// `Drawing` and returns a `PlateResult`, nothing more.

import type { Drawing } from '../../../web/src/import/types'
import type { PlateResult } from '../../../web/src/import/testfit'

export type { PlateResult }

/** Portability class — scored, not an afterthought (see bench/README.md). */
export type PortabilityClass =
  /** A: algorithm reimplemented in Rust/TS, no new runtime. */
  | 'A-port'
  /** B: runs behind /api/* via deploy/apiCore.ts; MUST degrade like /api/dwg on Vercel. */
  | 'B-service'
  /** C: we take the technique, not the code (e.g. AGPL sources). */
  | 'C-reference'

export interface PlateExtractorMeta {
  id: string
  /** One line: what this candidate actually does differently. */
  summary: string
  portability: PortabilityClass
  /** SPDX id of the upstream project this derives from, or 'original'. */
  license: string
  /** Upstream project, if any. */
  upstream?: string
}

export interface PlateExtractor {
  meta: PlateExtractorMeta
  /**
   * Derive the floor-plate boundary. Returning null means "no plate found" and
   * scores as a total miss — it is never a free pass.
   *
   * MUST be deterministic: the same Drawing must produce an identical result
   * across runs and processes (the harness asserts this).
   */
  extract(drawing: Drawing): PlateResult | null
}
