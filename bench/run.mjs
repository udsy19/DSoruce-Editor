// Bake-off runner.  pnpm bench <branch> | pnpm bench all
//
// Bundles the adapters with esbuild (same pattern as the *.test.mjs suites, so
// TS under web/src/ is exercised as written), runs every implementation over
// every fixture, and writes:
//   bench/results/<branch>.json   raw, diffable across commits
//   bench/report.md               the table humans read
//
// Determinism is enforced, not assumed: every implementation runs twice and a
// differing result is reported as a failure, because a non-deterministic
// extractor cannot be adopted no matter how well it scores.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `bench-${path.basename(entry, '.ts')}-${process.pid}.mjs`)
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm',
    platform: 'node', logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

const M = await bundle(path.join(here, 'metrics.ts'))

// ---- fixtures ---------------------------------------------------------------

function loadFixtures() {
  const dir = path.join(here, 'fixtures/plate')
  const out = []
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const id = f.replace(/\.json$/, '')
    const truthPath = path.join(here, 'fixtures/truth', `${id}.geojson`)
    if (!fs.existsSync(truthPath)) {
      console.log(`  ! ${id}: no ground truth — SKIPPED (a fixture without truth scores nothing)`)
      continue
    }
    const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'))
    const ring = truth.geometry.coordinates[0].slice(0, -1)
    out.push({
      id,
      drawing: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
      truth: ring,
      truthMeta: truth.properties ?? {},
    })
  }
  return out
}

/**
 * The real DWG, parsed through the production importer.
 *
 * Runs even with NO truth polygon: the drawing has no closed exterior envelope
 * on any wall layer (see fixtures/truth/README.md), so a reference boundary is a
 * product decision rather than something recoverable from the file. The
 * truth-free metrics — self-intersections, closure error, phantom-edge length,
 * determinism — are well defined without one, and they are exactly where the
 * production bug shows up, so excluding this fixture entirely would hide it.
 */
async function realFixture() {
  const truthPath = path.join(here, 'fixtures/truth/real-furniture-plan.geojson')
  const hasTruth = fs.existsSync(truthPath)
  const dwg = path.join(ROOT, 'samples/furniture-plan.dwg')
  const dxfOut = path.join(os.tmpdir(), `bench-real-${process.pid}.dxf`)
  let dxfText
  try {
    execFileSync('dwg2dxf', ['-o', dxfOut, dwg], { stdio: ['ignore', 'ignore', 'pipe'] })
    dxfText = fs.readFileSync(dxfOut, 'utf8')
    fs.rmSync(dxfOut, { force: true })
  } catch {
    const dxf = path.join(ROOT, 'samples/furniture-plan.dxf')
    if (!fs.existsSync(dxf)) return null
    dxfText = fs.readFileSync(dxf, 'utf8')
  }
  const { parseDrawing } = await bundle(path.join(ROOT, 'web/src/import/dxf.ts'))
  const truth = hasTruth ? JSON.parse(fs.readFileSync(truthPath, 'utf8')) : null
  return {
    id: 'real-furniture-plan',
    drawing: parseDrawing(dxfText),
    truth: truth ? truth.geometry.coordinates[0].slice(0, -1) : null,
    truthMeta: truth?.properties ?? {
      why: 'The real 882 m² plan. No closed exterior envelope on any wall layer.',
      source: 'TRUTH NOT ESTABLISHED — truth-free metrics only (see truth/README.md)',
    },
  }
}

// ---- source linework (for the phantom-edge metric) --------------------------

function sourceSegments(drawing) {
  const segs = []
  for (const e of drawing.entities ?? []) {
    if (e.category !== 'wall' && e.category !== 'glazing') continue
    const pts = e.pts ?? []
    for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]])
    if (e.closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]])
  }
  return segs
}

// ---- scoring ----------------------------------------------------------------

function score(fx, res, ms) {
  if (!res || !res.boundary || res.boundary.length < 3) {
    return { ok: false, note: 'no plate returned' }
  }
  // Candidates translate the plate into editor space; undo it so geometry is
  // compared in source coordinates. An implementation that reports no offset is
  // taken at its word.
  const off = res.offset ?? { x: 0, y: 0 }
  const ring = res.boundary.map(([x, y]) => [x + off.x, y + off.y])
  const segs = sourceSegments(fx.drawing)
  const phantom = M.phantomEdgeLength(ring, segs)
  let perim = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    perim += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  // Truth-free metrics — meaningful with or without a reference polygon.
  const containment = M.furnitureContainment(ring, fx.drawing)
  const selfX = M.selfIntersections(ring)
  const out = {
    ok: true,
    method: res.method ?? '?',
    selfIntersections: selfX,
    // GATES. A candidate must pass both before its phantom number means
    // anything: self-crossing is a hard fail at any IoU, and phantom fraction
    // is minimizable by shrinking, which containment is what catches.
    furnitureContainment: +containment.toFixed(4),
    lineworkCoverage: +M.lineworkCoverage(ring, segs).toFixed(4),
    gatesPass: selfX === 0 && containment >= 0.98,
    closureErrorM: +M.closureError(ring).toFixed(4),
    orthogonalityPct: +(M.orthogonality(ring) * 100).toFixed(1),
    phantomEdgeM: +phantom.toFixed(2),
    phantomPctOfPerimeter: +((phantom / Math.max(perim, 1e-9)) * 100).toFixed(1),
    vertices: ring.length,
    ms: +ms.toFixed(1),
  }
  if (!fx.truth) return { ...out, iou: null, areaDeltaPct: null, boundaryDevM: null }
  const truthArea = M.area(fx.truth)
  return {
    ...out,
    iou: +M.iou(ring, fx.truth).toFixed(4),
    areaDeltaPct: +(((M.area(ring) - truthArea) / truthArea) * 100).toFixed(2),
    boundaryDevM: +M.boundaryDeviation(ring, fx.truth).toFixed(3),
  }
}

// ---- adapters ---------------------------------------------------------------

async function loadImpls(branch) {
  const dir = path.join(here, 'adapters', branch)
  if (!fs.existsSync(dir)) throw new Error(`no adapter dir: bench/adapters/${branch}`)
  const impls = []
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'types.ts').sort()) {
    const mod = await bundle(path.join(dir, f))
    const impl = mod.default ?? Object.values(mod).find((v) => v && v.extract)
    if (!impl) { console.log(`  ! ${f}: no PlateExtractor export — skipped`); continue }
    impls.push(impl)
  }
  return impls
}

// ---- run --------------------------------------------------------------------

const branch = process.argv[2] ?? 'all'
const branches = branch === 'all' ? ['plate'] : [branch]

for (const b of branches) {
  const fixtures = loadFixtures()
  const real = await realFixture()
  if (real) {
    fixtures.push(real)
    if (!real.truth) console.log('  * real-furniture-plan: no truth polygon — truth-free metrics only')
  } else console.log('  ! real-furniture-plan: sample or LibreDWG unavailable — skipped')

  const impls = await loadImpls(b)
  console.log(`\n=== branch: ${b} — ${impls.length} implementation(s) x ${fixtures.length} fixture(s) ===\n`)

  const results = { branch: b, generatedFrom: 'bench/run.mjs', impls: {} }
  for (const impl of impls) {
    const per = {}
    for (const fx of fixtures) {
      const t0 = performance.now()
      let r1
      try { r1 = impl.extract(structuredClone(fx.drawing)) } catch (e) {
        per[fx.id] = { ok: false, note: `threw: ${(e && e.message) || e}` }
        continue
      }
      const ms = performance.now() - t0
      const s = score(fx, r1, ms)
      // determinism: identical input must give identical output
      let r2
      try { r2 = impl.extract(structuredClone(fx.drawing)) } catch { r2 = null }
      s.deterministic = JSON.stringify(r1?.boundary ?? null) === JSON.stringify(r2?.boundary ?? null)
      per[fx.id] = s
    }
    results.impls[impl.meta.id] = { meta: impl.meta, fixtures: per }
    const okCount = Object.values(per).filter((p) => p.ok).length
    console.log(`${impl.meta.id}: ${okCount}/${fixtures.length} produced a plate`)
  }

  fs.mkdirSync(path.join(here, 'results'), { recursive: true })
  fs.writeFileSync(path.join(here, 'results', `${b}.json`), JSON.stringify(results, null, 2))
  writeReport(b, results, fixtures)
}

function writeReport(b, results, fixtures) {
  const names = Object.keys(results.impls)
  const L = []
  L.push(`# Bake-off report — \`${b}\``)
  L.push('')
  L.push('Regenerate with `pnpm bench ' + b + '`. Raw results: `bench/results/' + b + '.json`.')
  L.push('')
  L.push('## Implementations')
  L.push('')
  L.push('| impl | portability | license | summary |')
  L.push('|---|---|---|---|')
  for (const n of names) {
    const m = results.impls[n].meta
    L.push(`| \`${n}\` | ${m.portability} | ${m.license} | ${m.summary} |`)
  }
  L.push('')
  L.push('## Per-fixture results')
  L.push('')
  L.push('**GATES** must pass before a phantom number means anything: `self×` = 0 AND')
  L.push('`contain` (furniture bbox centres inside the envelope) ≥ 0.98 — phantom fraction is')
  L.push('minimizable by shrinking, and containment is what catches that. `linework` is a')
  L.push('diagnostic, never gated (keep-outs and service runs legitimately sit outside).')
  L.push('')
  L.push('`IoU` vs ground truth · ')
  L.push('`Δarea%` signed · `dev` worst boundary deviation (m) · `orth%` length-weighted ·')
  L.push('`phantom` boundary metres with no supporting linework · `det` deterministic.')
  L.push('')
  for (const fx of fixtures) {
    L.push(`### \`${fx.id}\``)
    if (fx.truthMeta.why) L.push(`_${fx.truthMeta.why}_`)
    L.push(`Truth area: **${fx.truth ? (fx.truthMeta.areaM2 ?? M.area(fx.truth).toFixed(2)) + ' m²' : 'not established'}** · truth source: ${fx.truthMeta.source ?? 'n/a'}`)
    L.push('')
    L.push('| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const n of names) {
      const r = results.impls[n].fixtures[fx.id]
      if (!r || !r.ok) { L.push(`| \`${n}\` | — | — | — | — | — | — | — | — | — | — | ${r?.note ?? 'n/a'} |`); continue }
      const flag = (v, bad) => (bad ? `**${v}**` : `${v}`)
      const dash = (v) => (v === null || v === undefined ? '—' : v)
      L.push(`| \`${n}\` | ${r.gatesPass ? 'pass' : '**FAIL**'} | ${flag(r.selfIntersections, r.selfIntersections > 0)} | ${flag(r.furnitureContainment, r.furnitureContainment < 0.98)} | ${r.iou === null ? '—' : flag(r.iou, r.iou < 0.98)} | ${dash(r.areaDeltaPct)} | ${dash(r.boundaryDevM)} | ${flag(r.phantomEdgeM, r.phantomEdgeM > 0.5)} (${r.phantomPctOfPerimeter}%) | ${r.lineworkCoverage} | ${r.vertices} | ${r.ms} | ${r.deterministic ? 'y' : '**NO**'} |`)
    }
    L.push('')
  }
  fs.writeFileSync(path.join(here, 'report.md'), L.join('\n'))
  console.log(`\nreport → bench/report.md`)
}
