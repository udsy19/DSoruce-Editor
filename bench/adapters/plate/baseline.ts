// The incumbent, wrapped unchanged: web/src/import/testfit.ts `extractPlate`
// (coverage-scored loop tracer with a grid-contour and hull fallback ladder).
//
// This adapter deliberately adds NOTHING — no pre-clean, no repair. It is the
// bar every candidate has to clear, so any improvement measured against it is
// attributable to the candidate and not to harness scaffolding.

import { extractPlate } from '../../../web/src/import/testfit'
import type { Drawing } from '../../../web/src/import/types'
import type { PlateExtractor, PlateResult } from './types'

export const baseline: PlateExtractor = {
  meta: {
    id: 'baseline',
    summary: 'Current hull/loop tracer in import/testfit.ts, unmodified.',
    portability: 'A-port',
    license: 'original',
  },
  extract(drawing: Drawing): PlateResult | null {
    return extractPlate(drawing)
  },
}

export default baseline
