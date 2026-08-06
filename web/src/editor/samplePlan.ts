// The sample test-fit — what the deliverable-pack action exports when nothing
// is open yet.
//
// The plate, the core, the entry, the brief and the seed all come from
// `samplePlan.json`, which `scripts/lib/demo-doc.mjs` reads too: the plan a
// visitor gets from one click is byte-for-byte the plan every gate measures.
// (One definition, two readers — a TS bundle and a plain Node script — which is
// why it is JSON rather than a constant in either.)

import type { EditorCanvas } from './EditorCanvas'
import type { Program } from '../types/program'
import spec from './samplePlan.json'

export const SAMPLE_PLAN = spec

/** Floor-plate polygon, world metres. */
export const SAMPLE_PLATE = spec.plate as [number, number][]

/** The brief the sample plan is generated against. */
export const SAMPLE_PROGRAM = spec.program as unknown as Program

/**
 * Seed an EMPTY editor with the sample plate + core + entry and run one
 * deterministic test-fit on it. Mutates the document through the core (the
 * source of truth) exactly as the wizard's own path does — no second generator.
 *
 * Returns the plate so the caller can hand it to the renderers (which otherwise
 * trace it back out of the walls).
 */
export function seedSamplePlan(ec: EditorCanvas): [number, number][] {
  const t = spec.wallThickness
  for (let i = 0; i < SAMPLE_PLATE.length; i++) {
    const a = SAMPLE_PLATE[i]
    const b = SAMPLE_PLATE[(i + 1) % SAMPLE_PLATE.length]
    ec.ed.add_wall(a[0], a[1], b[0], b[1], t)
  }
  ec.ed.add_entry(spec.entry[0], spec.entry[1])
  ec.ed.add_keepout(spec.core.x, spec.core.y, spec.core.w, spec.core.h, spec.core.label)
  ec.generateOnce(SAMPLE_PROGRAM, spec.seed)
  ec.refresh()
  ec.frameContent()
  return SAMPLE_PLATE
}
