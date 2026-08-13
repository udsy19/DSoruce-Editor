// Three-surface zone dump — the instrument that CANNOT mix surfaces.
//
// WHY THIS EXISTS. The Phase 0 fixture (`scripts/fixtures/zone-dump.furniture-plan.json`)
// carried rows reading `label: "Unassigned", zone_type: "Circulation"` — a combination no
// single core surface can produce: `classify_residual_zones` derives a residual's label
// from its type (conform.rs), and the fold (`zone_rows(fold=true)`, lib.rs) rewrites type
// AND label together. Those rows were an instrument artifact: a JOIN of the raw document
// surface (labels) with the published stats surface (types), with neither column saying
// which surface it came from. This script replaces that instrument.
//
// THE RULE IT ENFORCES: every value is prefixed with the surface it was read from —
// `doc_*` (Editor.state().zones), `raw_*` (Editor.zone_stats()), `pub_*`
// (Editor.zone_stats_published()). There are no unprefixed label/type fields anywhere in
// the output, so a future reader cannot quote a value without quoting its provenance.
//
// It drives the USER'S EXACT PATH (wizard → Property → Space: samples/furniture-plan.dwg,
// confirm boundary → Program defaults → Generate → candidate A → Open in editor) against a
// dev server, because the `window.__ec` seam is dev-only (EditorCanvas.ts).
//
//   node scripts/zone-dump.mjs --port 5301 --out reports/editor-completion/zone-dump.json
//
// Provenance is asserted, not assumed: the script runs verify-preflight.sh against the
// port first (listener is THIS worktree, serves a known identifier), reloads the page
// unconditionally, and records the git HEAD + wasm mtime it measured against.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const PORT = Number(arg('--port', '5301'))
const OUT = arg('--out', path.join(REPO, 'reports/editor-completion/zone-dump.three-surface.json'))

// ---------------------------------------------------------------------------
// Provenance gate: the server must be THIS worktree serving current code.
// `__ec` is the dev seam identifier in EditorCanvas.ts — present only in dev
// builds, which is exactly the build this instrument requires.
execFileSync('bash', [path.join(REPO, 'scripts/verify-preflight.sh'), String(PORT), '__ec', 'src/editor/EditorCanvas.ts'], {
  stdio: 'inherit',
})

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message)))

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
  // Unconditional reload — goto-is-not-reload (gate-independence.md).
  await page.reload({ waitUntil: 'domcontentloaded' })

  // --- Property (create project) ---
  await page.waitForSelector('[data-testid="project-new"], [data-testid="create-project-form"]', { timeout: 15000 })
  if (await page.$('[data-testid="project-new"]')) await page.click('[data-testid="project-new"]')
  await page.waitForSelector('[data-testid="create-project-form"]', { timeout: 15000 })
  await page.fill('[data-testid="create-name"]', 'zone-dump')
  await page.fill('[data-testid="create-property"]', 'zone-dump property')
  await page.click('[data-testid="create-submit"]')

  // --- Space: upload the DWG, confirm the boundary ---
  await page.waitForSelector('[data-testid="space-step"]', { timeout: 15000 })
  const dwg = path.join(REPO, 'samples/furniture-plan.dwg')
  if (!fs.existsSync(dwg)) throw new Error(`missing ${dwg}`)
  await page.setInputFiles('[data-testid="space-upload-input"]', dwg)
  // DWG → DXF conversion + parse; generous timeout.
  await page.waitForSelector('[data-testid="space-readouts"]', { timeout: 120000 })
  const draftConfirm = await page
    .waitForSelector('[data-testid="plate-draft-confirm"]', { timeout: 10000 })
    .catch(() => null)
  if (draftConfirm) await draftConfirm.click()
  await page.click('[data-testid="wizard-next"]')

  // --- Program: keep the defaults, record them ---
  await page.waitForSelector('[data-testid="program-step"]', { timeout: 15000 })
  const programSummary = await page
    .textContent('[data-testid="program-summary"]')
    .catch(() => null)
  await page.click('[data-testid="program-next"]')

  // --- Generate: wait out the run, open candidate A ---
  await page.waitForSelector('[data-testid="generate-alt"]', { timeout: 300000 })
  const alts = await page.$$('[data-testid="generate-alt"]')
  if (!alts.length) throw new Error('no candidates')
  const openBtn = await alts[0].$('[data-testid="generate-alt-open"]')
  if (!openBtn) throw new Error('candidate A has no open control')
  await openBtn.click()

  // --- Editor: the dev seam ---
  await page.waitForFunction(() => !!window.__ec, null, { timeout: 60000 })
  // Let the canvas settle (zone assignment happens in the core on open).
  await page.waitForTimeout(1500)

  const dump = await page.evaluate(() => {
    const ec = window.__ec
    const ed = ec.ed
    const state = ed.state()
    const raw = ed.zone_stats()
    const pub = ed.zone_stats_published()
    return {
      // SURFACE 1 — the document. Editor.state().zones, verbatim fields.
      document: state.zones.map((z) => ({
        id: z.id,
        doc_label: z.label,
        doc_zone_type: z.zone_type,
        doc_origin: z.origin,
        doc_shape_kind: z.shape?.kind ?? (z.shape?.Rect ? 'Rect' : z.shape?.Poly ? 'Poly' : Object.keys(z.shape ?? {})[0]),
        doc_shape: z.shape,
        doc_component_count: (z.component_ids ?? []).length,
        doc_group: z.group ?? null,
      })),
      // SURFACE 2 — honest stats. Editor.zone_stats() (fold=false).
      stats_raw: raw.map((r) => ({
        id: r.id,
        raw_label: r.label,
        raw_zone_type: r.zone_type,
        raw_area_m2: r.area,
        raw_capacity: r.capacity,
        raw_seated: r.seated,
        raw_pct_of_nia: r.pct_of_nia,
      })),
      // SURFACE 3 — published stats. Editor.zone_stats_published() (fold=true).
      stats_published: pub.map((r) => ({
        id: r.id,
        pub_label: r.label,
        pub_zone_type: r.zone_type,
        pub_area_m2: r.area,
      })),
      walls: state.walls.length,
      components: state.components.length,
    }
  })

  // Cross-surface identity checks the instrument itself is responsible for:
  // same ids in the same order on all three surfaces (rows are index-aligned in
  // zone_rows), and published areas byte-equal raw areas (the fold changes only
  // the word — lib.rs docs).
  const ids = (a) => a.map((r) => r.id).join(',')
  if (ids(dump.document) !== ids(dump.stats_raw) || ids(dump.stats_raw) !== ids(dump.stats_published)) {
    throw new Error('surface id order diverges — refusing to write a dump that would need a join')
  }
  for (let i = 0; i < dump.stats_raw.length; i++) {
    if (dump.stats_raw[i].raw_area_m2 !== dump.stats_published[i].pub_area_m2) {
      throw new Error(`area diverges between raw and published at id ${dump.stats_raw[i].id}`)
    }
  }

  // The per-zone comparison table: every field carries its surface prefix.
  const perZone = dump.document.map((d, i) => ({
    id: d.id,
    doc_label: d.doc_label,
    doc_zone_type: d.doc_zone_type,
    doc_origin: d.doc_origin,
    raw_label: dump.stats_raw[i].raw_label,
    raw_zone_type: dump.stats_raw[i].raw_zone_type,
    pub_label: dump.stats_published[i].pub_label,
    pub_zone_type: dump.stats_published[i].pub_zone_type,
    raw_area_m2: dump.stats_raw[i].raw_area_m2,
  }))

  const byTypeRaw = {}
  const byTypePub = {}
  for (const r of dump.stats_raw) {
    const t = (byTypeRaw[r.raw_zone_type] ??= { count: 0, area: 0 })
    t.count++
    t.area += r.raw_area_m2
  }
  for (const r of dump.stats_published) {
    const t = (byTypePub[r.pub_zone_type] ??= { count: 0, area: 0 })
    t.count++
    t.area += r.pub_area_m2
  }
  for (const m of [byTypeRaw, byTypePub])
    for (const k of Object.keys(m)) m[k].area = Math.round(m[k].area * 100) / 100

  const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim()
  const out = {
    provenance: {
      instrument: 'scripts/zone-dump.mjs (three-surface; every value carries its surface prefix)',
      path: 'wizard → Property → Space (samples/furniture-plan.dwg, boundary confirmed) → Program defaults → Generate → candidate A → Open in editor',
      port: PORT,
      git_head: head,
      wasm_mtime: fs.statSync(path.join(REPO, 'web/src/wasm/ds_core_bg.wasm')).mtime.toISOString(),
      captured_at: new Date().toISOString(),
      program_summary_text: programSummary?.replace(/\s+/g, ' ').trim() ?? null,
      page_errors: errors,
    },
    totals: {
      zones: dump.document.length,
      walls: dump.walls,
      components: dump.components,
      sum_raw_area_m2: Math.round(dump.stats_raw.reduce((s, r) => s + r.raw_area_m2, 0) * 100) / 100,
    },
    byType_raw: byTypeRaw,
    byType_published: byTypePub,
    perZone,
    surfaces: {
      document: dump.document,
      stats_raw: dump.stats_raw,
      stats_published: dump.stats_published,
    },
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
  // Tooling-layer rule: re-read and assert before reporting success.
  const back = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  if (back.perZone.length !== perZone.length) throw new Error('write did not take')
  console.log(`\nwrote ${OUT}: ${perZone.length} zones, ${dump.walls} walls, ${dump.components} components`)
  console.log('byType_raw:', JSON.stringify(byTypeRaw))
  console.log('byType_published:', JSON.stringify(byTypePub))

  // Divergence report: where do the surfaces disagree, per zone?
  const diverging = perZone.filter(
    (z) => z.doc_zone_type !== z.pub_zone_type || z.doc_label !== z.pub_label || z.doc_zone_type !== z.raw_zone_type,
  )
  console.log(`\n${diverging.length} zone(s) where surfaces disagree (expected: exactly the fold):`)
  for (const z of diverging)
    console.log(
      `  id ${z.id} [${z.doc_origin}] doc=(${z.doc_label} · ${z.doc_zone_type}) raw=(${z.raw_label} · ${z.raw_zone_type}) pub=(${z.pub_label} · ${z.pub_zone_type})`,
    )
} finally {
  await browser.close()
}
