// Shared test fixture loader: the real furniture-plan sample, as a path or as a
// parsed `Drawing`. NOT a `*.test.mjs`, so the battery does not run it directly.
//
// THE FIXTURE IS GENERATED, NOT COMMITTED. `samples/*.dxf` is gitignored (a 15 MB
// derivative of the 2.6 MB DWG that IS committed), so it is derived on first run
// with dwg2dxf — the same LibreDWG converter the app's /api/dwg import path uses.
// Every test that wants the real plan goes through here; the generation used to
// live inside `dxf.test.mjs`, where a second caller could only copy it.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const samplesDir = path.resolve(here, '../../../samples')

/** Absolute path to `samples/furniture-plan.dxf`, generating it from the
 *  committed DWG when absent. Exits non-zero with the fix when it cannot. */
export function ensureSampleDxf() {
  const samplePath = path.join(samplesDir, 'furniture-plan.dxf')
  const dwgPath = path.join(samplesDir, 'furniture-plan.dwg')
  if (fs.existsSync(samplePath)) return samplePath
  if (!fs.existsSync(dwgPath)) {
    console.error(`FAIL  missing source sample: ${dwgPath}`)
    process.exit(1)
  }
  try {
    execFileSync('dwg2dxf', ['-o', samplePath, dwgPath], { stdio: 'pipe' })
  } catch (e) {
    console.error(
      `FAIL  could not generate ${path.basename(samplePath)} from the sample DWG.\n` +
        `      This test needs LibreDWG's dwg2dxf — the same converter the app's\n` +
        `      /api/dwg import path uses. Install it (macOS: brew install libredwg)\n` +
        `      and re-run. Original error: ${e.message}`,
    )
    process.exit(1)
  }
  return samplePath
}

/** esbuild, resolved through vite (it is a nested pnpm dep, not top-level). */
export async function esbuild() {
  const webRequire = createRequire(path.join(here, '../../package.json'))
  const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
  return import(pathToFileURL(esbuildPath).href)
}

/** Bundle a TS module under `src/import/` and import it. */
export async function bundleImport(entry) {
  const { build } = await esbuild()
  const outFile = path.join(os.tmpdir(), `ds-${path.basename(entry, '.ts')}-${process.pid}-${Date.now()}.mjs`)
  await build({
    entryPoints: [path.join(here, entry)],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(outFile).href)
  fs.rmSync(outFile, { force: true })
  return mod
}

/** The real sample plan, parsed through the app's own DXF importer. */
export async function sampleDrawing() {
  const { parseDrawing } = await bundleImport('dxf.ts')
  return parseDrawing(fs.readFileSync(ensureSampleDxf(), 'utf8'))
}
