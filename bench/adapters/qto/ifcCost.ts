// `ifc-cost` — class B. Our IFC export → IfcOpenShell → a cost schedule.
//
// Runs Python out of process, exactly as the production service class would, so
// what is measured here is the real plumbing rather than a simulation of it.
// Per ADR 0004 the class-B costs are scored as their own rows (wheel size,
// native footprint, cold start, Vercel viability); installation difficulty in
// this sandbox is explicitly NOT one of them.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { docStateToIFC } from '../../../web/src/export/ifc'
import type { DocState } from '../../../web/src/types/doc'
import type { CostSchedule, QuantityEngine } from './types'

// NOT derived from import.meta.url: esbuild rewrites it to the temp bundle's
// location, which is how this first failed. Anchored to the repo instead.
const RUNNER = process.env.DS_IFC_COST_RUNNER
  ?? path.resolve(process.cwd(), 'bench/adapters/qto/ifc_cost.py')

export const ifcCost: QuantityEngine = {
  meta: {
    id: 'ifc-cost',
    summary:
      'IfcOpenShell consuming our existing IFC export; quantities read if declared, else derived from geometry.',
    portability: 'B-service',
    license: 'LGPL-3.0 (ifcopenshell)',
    upstream: 'https://github.com/IfcOpenShell/IfcOpenShell',
  },
  schedule(state: DocState, bindings): CostSchedule | null {
    const ifc = docStateToIFC(state, { project: 'Bench' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ifccost-'))
    const ifcPath = path.join(dir, 'model.ifc')
    const bindPath = path.join(dir, 'bindings.json')
    fs.writeFileSync(ifcPath, ifc)
    fs.writeFileSync(bindPath, JSON.stringify(bindings))
    try {
      const out = execFileSync('python3', [RUNNER, ifcPath, bindPath], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      })
      return JSON.parse(out) as CostSchedule
    } catch (e) {
      const msg = (e as { stderr?: string; message?: string }).stderr ?? (e as Error).message
      console.error(`  ifc-cost failed: ${String(msg).slice(0, 400)}`)
      return null
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },
}
export default ifcCost
