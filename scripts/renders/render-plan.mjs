// Photoreal render pack — the app's OWN 3D geometry, re-lit by Replicate.
//
// Two stages, one command:
//
//   1. CAPTURE — drive the app's real interior renderer (`web/src/export/
//      roomRenders.ts` → `web/src/three/{materialTheme,interiorStill}.ts`) over
//      THE DOCUMENT THE DEMO ACTUALLY SHOWS, exactly the way
//      `scripts/render-rooms.mjs` does. Nothing is re-implemented; the only new
//      camera here is the aerial cutaway (`Overview_aerial`), which is a plain
//      `StillCamera` handed to the SAME `renderInteriorStill`.
//   2. RESTYLE — POST each base still to a structure-preserving Replicate model
//      (depth / edge / interior-ControlNet) with a materials-and-lighting
//      prompt, then poll, download and VERIFY the bytes.
//
// WHICH BUILDING (`--doc`, default `wizard`) — this pack once shipped renders of
// the WRONG building: the base stills came from the 40 × 24 m seeded sample
// (`seed 7 · 97 walls · 206 components`) while every other artifact in the demo
// is the user's imported DWG plate. The film showed one building and the
// "renders of it" showed another. `--doc wizard` therefore drives the app's own
// wizard — Start a project → upload `samples/furniture-plan.dwg` → Program →
// Generate → "Open in editor" — and lifts the live document straight off
// `window.__ec`, the same seam `scripts/demo/record-demo.mjs` films. The
// document is then ASSERTED to be the imported plate (`assertImportedPlate`)
// before a single pixel is rendered, so a silent fall-back to the sample is a
// crash rather than a beautiful picture of the wrong office.
//
// Like `record-demo.mjs`, this NEVER clicks [data-testid="plate-draft-confirm"]:
// that writes the plate calibration log, whose value is that a HUMAN produced
// its rows (ADR 0003 + .claude/rules/gate-independence.md). The flow does not
// need it, and the run asserts the store is still empty afterwards.
//
// Usage:
//   set -a; . /path/to/replicate.env; set +a          # REPLICATE_API_TOKEN
//   node scripts/renders/render-plan.mjs                         # the real imported plate
//   node scripts/renders/render-plan.mjs --doc seeded            # the 40x24 sample instead
//   node scripts/renders/render-plan.mjs --port 5199             # the dev server to drive
//   node scripts/renders/render-plan.mjs --skip-capture          # reuse base stills
//   node scripts/renders/render-plan.mjs --only Open_space,Reception
//   node scripts/renders/render-plan.mjs --views-only            # capture, no Replicate
//   node scripts/renders/render-plan.mjs --sheet-only            # rebuild the HTML only
//   node scripts/renders/render-plan.mjs --experimental          # + adirik/interior-design
//
// Writes (all under out/, which is gitignored):
//   out/renders/photoreal/base/<View>.png          the structure image, from OUR geometry
//   out/renders/photoreal/var/<View>__<style>.<ext> the photoreal variations
//   out/renders/photoreal/manifest.json            every prompt, model, version, timing
//   out/renders/index.html                         the contact sheet (base beside variations)
//
// The token is read from process.env.REPLICATE_API_TOKEN and is never written
// to disk, logged, or embedded in any artifact.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc, DEMO_PLATE } from '../lib/demo-doc.mjs'

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const has = (flag) => argv.includes(flag)

const OUT = path.resolve(REPO, arg('--out', 'out/renders/photoreal'))
const BASE_DIR = path.join(OUT, 'base')
const VAR_DIR = path.join(OUT, 'var')
const SHEET = path.resolve(REPO, arg('--sheet', 'out/renders/index.html'))
const SEED = Number(arg('--seed', '7'))
const DOC_SOURCE = arg('--doc', 'wizard')
if (DOC_SOURCE !== 'wizard' && DOC_SOURCE !== 'seeded') {
  throw new Error(`--doc must be 'wizard' (the imported DWG plate) or 'seeded' (the 40x24 sample)`)
}
const PORT = Number(arg('--port', '5199'))
const PLATE_DWG = path.join(REPO, 'samples/furniture-plan.dwg')
const WIDTH = Number(arg('--width', '1920'))
const HEIGHT = Number(arg('--height', '1080'))
const ONLY = arg('--only', '') ? arg('--only', '').split(',').map((s) => s.trim()) : null
const SKIP_CAPTURE = has('--skip-capture')
const VIEWS_ONLY = has('--views-only')
const SHEET_ONLY = has('--sheet-only')

// ── the viewpoints ───────────────────────────────────────────────────────────
// The first four are the app's own `ROOM_RENDER_SPECS` keys (rendered by
// `renderRoomPack`); the fifth is the aerial cutaway.
const VIEWS = [
  {
    key: 'Reception',
    label: 'Reception / arrival',
    // MEASURED: the pack's own camera stands this shot behind a bench that fills
    // the foreground, and two alternatives were tried and were WORSE — `close`
    // put the eye in a corner staring at a partition, and `wide` with a 7 m
    // forward-clearance floor returned the same standing point. The reception
    // zone in this test-fit is simply small and glazed on two sides; the shot is
    // the plan, not a framing bug.
    subject:
      'the arrival lobby of a corporate office: reception desk, glazed meeting-room partition ' +
      'behind it, a low bench, open workstation floor visible beyond the glass',
  },
  {
    key: 'Open_space',
    label: 'Open workspace — wide',
    subject:
      'a large open-plan office floor: long rows of bench desks with monitors and task chairs, ' +
      'linear pendant lighting, full-height perimeter glazing on the left',
  },
  {
    key: 'Work_stations',
    label: 'Workstations — eye level',
    subject:
      'an open-plan workstation floor seen from between the desk banks: bench desks, monitors, ' +
      'mesh task chairs, a wide circulation aisle, daylight from the window wall',
  },
  {
    key: 'Conference_room',
    label: 'Boardroom',
    subject:
      'a boardroom: a long solid-timber conference table with executive chairs, a glazed ' +
      'partition wall with fritted film, a timber-veneer door, a linear pendant over the table',
  },
  {
    key: 'Overview_aerial',
    label: 'Whole-floor aerial cutaway',
    aerial: true,
    subject:
      'an architectural aerial cutaway of a whole office floorplate with the roof removed: ' +
      'rows of bench desks, enclosed meeting rooms, a reception zone and wide circulation ' +
      'corridors, seen from above at an angle',
  },
]

// ── the styles (one Replicate call each, per view) ───────────────────────────
const SHELL =
  'photorealistic architectural interior visualisation of a modern Indian corporate GCC office ' +
  'fit-out in Bengaluru, realistic materials and believable construction detailing, ' +
  'architectural photography, 24mm lens, sharp focus, high dynamic range, ' +
  'empty and unoccupied, no people, no text, no logos, no signage'

const MODELS = {
  canny: {
    owner: 'black-forest-labs',
    name: 'flux-canny-pro',
    version: '835f0372c2cf4b2e494c2b8626288212ea5c2694ccc2e29f00dfb8cbf2a5e0ce',
    ext: 'jpg',
    input: (prompt, imageUrl, seed) => ({
      prompt,
      control_image: imageUrl,
      guidance: 30,
      steps: 50,
      output_format: 'jpg',
      safety_tolerance: 2,
      seed,
    }),
  },
  depth: {
    owner: 'black-forest-labs',
    name: 'flux-depth-dev',
    version: 'fc4f1401056237174d207056c49cd2afd44ede232ba286a3d40eb6376b726600',
    ext: 'jpg',
    input: (prompt, imageUrl, seed) => ({
      prompt,
      control_image: imageUrl,
      guidance: 10,
      num_inference_steps: 30,
      megapixels: '1',
      output_format: 'jpg',
      output_quality: 95,
      num_outputs: 1,
      seed,
    }),
  },
  interior: {
    owner: 'adirik',
    name: 'interior-design',
    version: '76604baddc85b1b4616e1c6475eca080da339c8875bd4996705440484a6eac38',
    ext: 'png',
    // Its segmentation pre-processor cannot read a 4-channel image — an RGBA
    // PNG straight off the WebGL canvas fails with "Unable to infer channel
    // dimension format". Flatten to 3-channel RGB (and to an SD-sized frame)
    // before uploading.
    prep: { format: 'jpeg', maxWidth: 1024 },
    input: (prompt, imageUrl, seed) => ({
      image: imageUrl,
      prompt,
      guidance_scale: 15,
      prompt_strength: 0.5,
      num_inference_steps: 50,
      negative_prompt:
        'lowres, watermark, banner, logo, text, signage, people, faces, deformed, blurry, ' +
        'out of focus, out of frame, surreal, extra furniture, cluttered, distorted geometry',
      seed,
    }),
  },
}

/**
 * Three passes over every viewpoint. All three are STRUCTURE-PRESERVING —
 * measured, not assumed: at `prompt_strength` 0.75 `adirik/interior-design`
 * rebuilt the open floor into a different room (cubicle partitions, a narrower
 * bay, a relocated window wall), so it is not in the deck. It is still
 * reachable behind `--experimental` at a gentler strength, because a model that
 * drifts is a finding worth being able to reproduce.
 */
const STYLES = [
  {
    id: 'daylight-oak',
    model: 'canny',
    label: 'Daylight · oak + off-white',
    style:
      'bright mid-morning daylight flooding in through the glazing, warm white-oak veneer, ' +
      'off-white micro-textured plaster walls, light grey loop-pile carpet tiles, ' +
      'matte black metalwork, soft natural shadows, cool neutral white balance',
  },
  {
    id: 'evening-warm',
    model: 'depth',
    label: 'Evening · warm walnut + brass',
    style:
      'late-afternoon golden light with the interior lighting on, walnut timber veneer, ' +
      'brushed brass trims, deep charcoal upholstery, warm pools of light from the pendants, ' +
      'polished concrete and dark carpet, cinematic warm grade',
  },
  {
    id: 'premium-terrazzo',
    model: 'canny',
    label: 'Premium · terrazzo + fluted timber',
    style:
      'premium finish palette: terrazzo flooring, fluted timber wall panelling, sage-green ' +
      'acoustic felt, linen upholstery, diffuse overcast daylight, clean and calm, ' +
      'high-end corporate interior photography',
  },
  {
    id: 'interior-controlnet',
    model: 'interior',
    experimental: true,
    label: 'Experimental · interior-design ControlNet',
    style:
      'premium finish palette: terrazzo flooring, fluted timber wall panelling, sage-green ' +
      'acoustic felt, linen upholstery, diffuse overcast daylight',
  },
].filter((s) => !s.experimental || has('--experimental'))

/**
 * FIDELITY NOTES — written by LOOKING at each output beside its base still, not
 * by trusting that a control model respected its control input. Keyed
 * `<view>__<style>`; anything not listed here tracked the base geometry with no
 * defect worth flagging. These print under the image on the contact sheet, so
 * nobody has to take a render on trust.
 */
const NOTES = {
  Reception__daylight_oak:
    'HOLDS — the glazed partition and its mullion rhythm, the poseur table, the reception run ' +
    'and the workstation floor beyond all track the base. The palette does not: the near ' +
    'worktop reads as white laminate rather than the oak the prompt asked for.',
  Reception__evening_warm:
    'HOLDS, best of the three — the depth model keeps the foreground timber slab a timber slab ' +
    'and the partition mullions exactly where the base put them.',
  Reception__premium_terrazzo:
    'HOLDS — same structure again; the terrazzo/sage palette lands cleanly, and the low bench ' +
    'the base draws as a plinth is read as upholstered seating.',
  Open_space__daylight_oak:
    'HOLDS — bench rows, pendant runs and the full-height glazing all track. The window wall ' +
    'gains an invented city beyond it, which the base (an empty exterior plane) does not have.',
  Open_space__evening_warm:
    'HOLDS — the depth model keeps every bench run, the pendant grid and the perimeter glazing ' +
    'in place under a heavy warm grade; the ceiling reads as exposed soffit rather than the ' +
    'base\'s flat slab.',
  Open_space__premium_terrazzo:
    'HOLDS with one violation — desks, pendants and glazing track, but a figure is invented ' +
    'behind the desk banks despite the prompt\'s explicit "empty and unoccupied, no people".',
  Work_stations__daylight_oak:
    'HOLDS — desk banks, pendant runs, the window wall and the timber partition at the left all ' +
    'track the base; the glazing again gains an invented city view.',
  Work_stations__evening_warm:
    'HOLDS — the strongest interior in the deck: desk banks, monitor arms, the pendant grid, ' +
    'the window wall and the fluted partition on the left all sit where the base put them.',
  Work_stations__premium_terrazzo: 'HOLDS — as above, with an invented skyline beyond the glazing.',
  Conference_room__daylight_oak:
    'HOLDS — table, the chair line against the wall, the timber-veneer door, the glazed ' +
    'partition and the linear pendant all track the base.',
  Conference_room__evening_warm: 'HOLDS — as above; the walnut panelling replaces the base\'s plaster wall, which is the style, not drift.',
  Conference_room__premium_terrazzo: 'HOLDS — as above, with the sage acoustic panel the prompt asked for on the long wall.',
  Overview_aerial__evening_warm:
    'HOLDS with licence — plate outline, the two wings, the meeting-room boxes, the reception ' +
    'zone and the open circulation band are all in place, and the desk banks stay desks. It ' +
    'invents a few small figures despite the "no people" instruction.',
  Overview_aerial__daylight_oak:
    'DRIFT — the plate outline, both wings, the meeting-room box and the reception corner are ' +
    'correct, but the desk banks are re-read as LIBRARY SHELVING. At whole-floor scale the ' +
    'edge model sees parallel desk runs as stacks; the depth model (evening) does not, and ' +
    'that difference is the finding.',
  Overview_aerial__premium_terrazzo: 'DRIFT — the same desks-as-shelving misreading as the daylight variant, from the same edge model.',
}
const noteFor = (view, style) => NOTES[`${view}__${style.replace(/-/g, '_')}`] ?? null

const promptFor = (view, style) => `${SHELL}. ${view.subject}. ${style.style}.`

// ── stage 0: WHICH document ──────────────────────────────────────────────────
const webRequire = createRequire(path.join(REPO, 'web/package.json'))

async function chromiumModule() {
  const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
  return playwright.chromium ?? playwright.default.chromium
}

/** Shoelace area of a closed ring, m². */
function ringArea(ring) {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

/**
 * THE GUARD. The class of defect this exists for is "renders of a different
 * building than the rest of the demo", and it recurs silently because a wrong
 * document renders just as prettily as a right one.
 *
 * It is anchored on things the producer cannot choose:
 *   • the plate RING ITSELF, compared vertex-for-vertex against `DEMO_PLATE` —
 *     the seeded sample's own definition, read from `web/src/editor/
 *     samplePlan.json`, not from anything this run produced;
 *   • the ring's shoelace area against the plate's documented extent
 *     (930.1 m², ADR 0003 §"Verified against a production build", ADR 0004,
 *     docs/audits/circulation-figure-ground-audit.md) — an external
 *     specification, not a number this script computed and then believed;
 *   • the ring's IRREGULARITY. The sample is a 4-vertex rectangle; the imported
 *     plate is a sawtooth polygon. A rectangle can never satisfy this.
 * A missing field is a failure, never a skip.
 */
const IMPORTED_PLATE = {
  areaM2: 930.1, // ADR 0003 / ADR 0004 / circulation-figure-ground-audit.md
  areaTolPct: 3,
  minVertices: 8,
  minWalls: 120,
  minComponents: 150,
}
function assertImportedPlate({ state, plate }) {
  const fail = (why) => {
    throw new Error(
      `WRONG BUILDING — ${why}. The demo's other artifacts are the imported ` +
        `samples/furniture-plan.dwg plate; rendering anything else ships images of a ` +
        `different office. Re-run without --skip-capture, or pass --doc seeded ` +
        `deliberately (and the sheet will then say so).`,
    )
  }
  if (!Array.isArray(plate) || plate.length < 3) fail(`the document has no floor plate (${JSON.stringify(plate)?.slice(0, 80)})`)
  if (plate.length < IMPORTED_PLATE.minVertices) {
    fail(`the plate has only ${plate.length} vertices — the imported plate is irregular (≥ ${IMPORTED_PLATE.minVertices})`)
  }
  const sameAsSample =
    plate.length === DEMO_PLATE.length &&
    plate.every((p, i) => Math.abs(p[0] - DEMO_PLATE[i][0]) < 0.01 && Math.abs(p[1] - DEMO_PLATE[i][1]) < 0.01)
  if (sameAsSample) fail('the plate IS the 40 × 24 m seeded sample rectangle')
  const area = ringArea(plate)
  const drift = Math.abs(area - IMPORTED_PLATE.areaM2) / IMPORTED_PLATE.areaM2 * 100
  if (drift > IMPORTED_PLATE.areaTolPct) {
    fail(`the plate measures ${area.toFixed(1)} m², ${drift.toFixed(1)}% off the documented ${IMPORTED_PLATE.areaM2} m²`)
  }
  if (state.walls.length < IMPORTED_PLATE.minWalls) fail(`only ${state.walls.length} walls (expected ≥ ${IMPORTED_PLATE.minWalls})`)
  if (state.components.length < IMPORTED_PLATE.minComponents) {
    fail(`only ${state.components.length} components (expected ≥ ${IMPORTED_PLATE.minComponents})`)
  }
  return { areaM2: Number(area.toFixed(1)), vertices: plate.length }
}

function waitForServer(port, ms = 8000) {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tick = () => {
      // `localhost`, not 127.0.0.1 — vite binds ::1 too (record-demo.mjs).
      const req = http.get({ host: 'localhost', port, path: '/' }, (res) => { res.resume(); resolve() })
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`No dev server on :${port}. Start one with:  cd web && pnpm dev --port ${port} --strictPort`))
        } else setTimeout(tick, 250)
      })
    }
    tick()
  })
}

/**
 * The REAL document: the app's own wizard, driven exactly as
 * `scripts/demo/record-demo.mjs` drives it for the film, then read off
 * `window.__ec` — the live `EditorCanvas` the app itself exposes in dev. Nothing
 * about the geometry is re-derived here; this is the same wasm `Editor` the
 * viewer, the workbook and the film are all looking at.
 */
async function wizardDoc() {
  if (!fs.existsSync(PLATE_DWG)) throw new Error(`demo CAD plate missing: ${PLATE_DWG}`)
  await waitForServer(PORT)
  const chromium = await chromiumModule()
  const BASE = `http://localhost:${PORT}`
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  const need = async (sel, timeout = 30000) => {
    const loc = page.locator(sel).first()
    try {
      await loc.waitFor({ state: 'visible', timeout })
    } catch {
      throw new Error(`wizard: \`${sel}\` never appeared within ${timeout} ms — url ${page.url()}`)
    }
    return loc
  }
  const waitHash = async (re, ms, what) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (re.test(page.url())) return page.url()
      await page.waitForTimeout(200)
    }
    throw new Error(`wizard: never reached ${what} (${re}) — url is ${page.url()}`)
  }

  try {
    console.log(`wizard: driving ${BASE} → the real imported plate`)
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await need('[data-testid="project-library"]')
    // A fresh context has an empty IndexedDB and the library says so. If a
    // profile were ever reused, an old project's document could be opened here.
    const empty = await page.locator('[data-testid="project-library-empty"]').count()
    if (empty !== 1) throw new Error(`wizard: the project library is not empty (empty-marker count ${empty})`)

    await (await need('[data-testid="project-new"]')).click()
    await need('[data-testid="create-project-form"]')
    await (await need('[data-testid="create-name"]')).fill('Q3 Tenant Fit-out')
    await (await need('[data-testid="create-property"]')).fill('One Prestige Tower')
    await (await need('[data-testid="create-address"]')).fill('12 MG Road, Bengaluru 560001')
    await (await need('[data-testid="create-floor"]')).fill('L14')
    await (await need('[data-testid="create-submit"]')).click()
    await waitHash(/#\/p\/[^/]+\/space/, 30000, 'the Space step')

    await need('[data-testid="space-step"]')
    await page.setInputFiles('[data-testid="space-upload-input"]', PLATE_DWG)
    const readouts = page.locator('[data-testid="space-readouts"]')
    const spaceErr = page.locator('[data-testid="space-error"]')
    const deadline = Date.now() + 300000
    for (;;) {
      if (await readouts.count()) break
      if (await spaceErr.count()) throw new Error(`wizard: the DWG import failed — ${(await spaceErr.first().innerText()).trim()}`)
      if (Date.now() > deadline) throw new Error('wizard: the DWG never produced readouts within 300 s')
      await page.waitForTimeout(400)
    }
    const metrics = await page
      .locator('[data-testid="space-readouts"] .space-metric')
      .evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean))
    console.log(`wizard: plate traced — ${metrics.join(' · ') || '(no metric tiles)'}`)
    // DELIBERATELY NOT CLICKED: [data-testid="plate-draft-confirm"] writes the
    // human-only plate calibration log (ADR 0003). A driver's CDP input is
    // `isTrusted`, so the row would be indistinguishable from a real one.
    const draftOffered = await page.locator('[data-testid="plate-draft-confirm"]').count()
    console.log(`wizard: plate-draft-confirm present: ${draftOffered ? 'yes — deliberately NOT clicked' : 'no'}`)

    const spaceNext = page.locator('[data-testid="wizard-next"]')
    if (await spaceNext.isDisabled()) {
      const why = await page.locator('[data-testid="wizard-next-reason"]').innerText().catch(() => '')
      throw new Error(`wizard: "Next: Program" stayed disabled — ${why || 'no reason given'}`)
    }
    await spaceNext.click()

    await need('[data-testid="program-step"]')
    await need('[data-testid="program-summary"]')
    console.log(
      `wizard: program — ${(await page.locator('[data-testid="program-summary"]').innerText()).replace(/\s+/g, ' ').slice(0, 120)}`,
    )
    await (await need('[data-testid="program-next"]')).click()

    await need('[data-testid="generate-step"]')
    const alts = page.locator('[data-testid="generate-alt"]')
    const genDeadline = Date.now() + 300000
    for (;;) {
      if ((await alts.count()) >= 1) break
      for (const bad of ['generate-noplate', 'generate-error']) {
        if (await page.locator(`[data-testid="${bad}"]`).count()) {
          throw new Error(`wizard: generation refused (${bad}): ${(await page.locator(`[data-testid="${bad}"]`).innerText()).replace(/\s+/g, ' ').slice(0, 200)}`)
        }
      }
      if (Date.now() > genDeadline) throw new Error('wizard: no scored alternatives after 300 s')
      await page.waitForTimeout(500)
    }
    const scores = await page.locator('.generate-alt-score').evaluateAll((els) =>
      els.map((e) => parseFloat((e.firstChild?.textContent ?? e.textContent).replace(/[^\d.]/g, '')) || 0),
    )
    console.log(`wizard: ${await alts.count()} alternatives scored ${scores.join(' / ')} — opening A`)
    // Let the async Claude soft-goal verdicts land before aiming: they add a row
    // to every card and reflow the gallery under the click (record-demo.mjs).
    await page.locator('[data-testid="generate-alt-ai"].is-pending').first().waitFor({ state: 'detached', timeout: 60000 }).catch(() => {})
    const openSel = '[data-testid="generate-alt"] >> nth=0 >> [data-testid="generate-alt-open"]'
    await (await need(openSel)).click()

    const EDITOR_RE = /#\/p\/[^/]+\/f\/[^/]+/
    try {
      await waitHash(EDITOR_RE, 25000, 'the editor deep-link')
    } catch {
      console.log('wizard: no navigation 25 s after "Open in editor" — clicking once more')
      await (await need(openSel)).click()
      await waitHash(EDITOR_RE, 60000, 'the editor deep-link')
    }
    await need('.canvas-wrap canvas', 40000)
    console.log(`wizard: editor open at ${page.url().split('#')[1]}`)

    // The live document, off the app's own seam. `ec.ed` is the wasm Editor.
    const doc = await page.evaluate(async () => {
      const ec = window.__ec
      if (!ec) throw new Error('window.__ec is not exposed — is this a dev build?')
      for (let i = 0; i < 80 && !(ec.getState()?.walls ?? []).length; i++) {
        await new Promise((r) => setTimeout(r, 250))
      }
      const state = ec.getState()
      let metrics = null
      try { metrics = ec.ed.metrics() } catch { metrics = null }
      return {
        state,
        wallTypes: ec.ed.wall_types(),
        plate: ec.ed.plate() ?? null,
        workstations: metrics?.workstations ?? null,
        revision: typeof ec.ed.revision === 'function' ? ec.ed.revision() : null,
      }
    })

    // We never performed the trusted-human event; this reads the store itself
    // rather than trusting that we did not.
    const plateRows = await page.evaluate(
      () =>
        new Promise((res) => {
          const rq = indexedDB.open('dsource')
          rq.onerror = () => res(-1)
          rq.onsuccess = () => {
            const db = rq.result
            if (!db.objectStoreNames.contains('plateLog')) return res(0)
            const c = db.transaction('plateLog', 'readonly').objectStore('plateLog').count()
            c.onsuccess = () => res(c.result)
            c.onerror = () => res(-1)
          }
        }),
    )
    if (plateRows !== 0) throw new Error(`wizard: the plate calibration log has ${plateRows} rows — this run must not write it`)
    console.log('wizard: plate calibration log untouched (0 rows) — no trusted-human event performed')
    if (pageErrors.length) console.log(`wizard: page errors — ${pageErrors.slice(0, 3).join(' | ')}`)

    return {
      state: doc.state,
      wallTypes: doc.wallTypes,
      plate: doc.plate,
      source: {
        kind: 'wizard',
        file: 'samples/furniture-plan.dwg',
        candidate: 'A',
        scores,
        spaceMetrics: metrics,
        workstations: doc.workstations,
      },
    }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

async function loadDoc() {
  if (DOC_SOURCE === 'seeded') {
    const { state, wallTypes, plate } = await buildDemoDoc({ seed: SEED })
    return { state, wallTypes, plate, source: { kind: 'seeded', seed: SEED } }
  }
  const doc = await wizardDoc()
  const measured = assertImportedPlate(doc)
  console.log(
    `guard: imported plate confirmed — ${measured.areaM2} m² over ${measured.vertices} vertices, ` +
      `${doc.state.walls.length} walls · ${doc.state.components.length} components`,
  )
  return { ...doc, source: { ...doc.source, ...measured } }
}

// ── stage 1: capture the base stills out of the app's own renderer ───────────

async function capture(keys) {
  const { build } = await import(
    pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
  )
  const chromium = await chromiumModule()

  const { state, wallTypes, plate, source } = await loadDoc()
  console.log(
    `doc: ${state.walls.length} walls · ${state.components.length} components · ` +
      `${(state.zones ?? []).length} zones · source ${source.kind}`,
  )

  const bundle = await build({
    stdin: {
      contents: `
        import * as THREE from 'three'
        import { renderRoomPack } from './src/export/roomRenders'
        import { classifyWalls } from './src/export/wallTypes'
        import { buildInteriorScene } from './src/three/materialTheme'
        import { renderInteriorStill } from './src/three/interiorStill'
        import { canvasToPngBytes } from './src/export/planGraphic'
        window.DS = { THREE, renderRoomPack, classifyWalls, buildInteriorScene, renderInteriorStill, canvasToPngBytes }
      `,
      resolveDir: path.join(REPO, 'web'),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome120',
    logLevel: 'warning',
  })

  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader'],
  })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('  [page error]', e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('aerial')) console.log(`  [page] ${m.text()}`)
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2')
    const d = c && c.getExtension('WEBGL_debug_renderer_info')
    return d ? String(c.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown'
  })
  console.log(`gpu: ${gl}`)

  const roomKeys = keys.filter((k) => k !== 'Overview_aerial')
  const wantAerial = keys.includes('Overview_aerial')

  const stills = await page.evaluate(
    async ({ state, wallTypes, plate, width, height, roomKeys, wantAerial }) => {
      const b64 = (u8) => {
        let s = ''
        for (let i = 0; i < u8.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
        }
        return btoa(s)
      }
      const { THREE } = window.DS
      const wallSpans = window.DS.classifyWalls(state, wallTypes)
      const out = []
      if (roomKeys.length) {
        const pack = await window.DS.renderRoomPack(state, {
          wallSpans,
          plate,
          width,
          height,
          exposure: 1.15,
          lampIntensity: 2,
          only: roomKeys,
        })
        for (const r of pack) {
          out.push({
            key: r.key,
            camera: {
              eye: r.camera.eye,
              target: r.camera.target,
              fovHorizontalDeg: r.camera.fovHorizontalDeg,
              placement: r.camera.placement,
            },
            roomLabel: r.roomLabel,
            width: r.width,
            height: r.height,
            png: b64(r.png),
          })
        }
      }

      if (wantAerial) {
        // The aerial cutaway: the SAME scene builder with the ceiling off, and a
        // plain StillCamera handed to the SAME renderer. Placed on the plate's
        // diagonal so the depth range covers the whole floorplate.
        const scene = window.DS.buildInteriorScene(state, {
          wallSpans,
          plate,
          ceiling: false,
          luminaires: true,
          exterior: true,
        })
        try {
          // The FLOORPLATE's extent, not `scene.bounds` — the latter includes the
          // 600 m exterior ground plane, which put the eye 500 m away staring at
          // empty sky. Plan (x, y) maps to world (x, ·, y).
          const ring = scene.plate ?? []
          // An empty ring silently yields Infinity here, and the symptom is a
          // frame of pure sky that looks exactly like a broken renderer. Fail loudly.
          if (ring.length < 3) throw new Error(`aerial: scene.plate has ${ring.length} points`)
          const xs = ring.map((p) => p[0])
          const zs = ring.map((p) => p[1])
          const minX = Math.min(...xs), maxX = Math.max(...xs)
          const minZ = Math.min(...zs), maxZ = Math.max(...zs)
          const cx = (minX + maxX) / 2
          const cz = (minZ + maxZ) / 2
          const spanX = maxX - minX
          const spanZ = maxZ - minZ
          const span = Math.max(spanX, spanZ)
          const FOV_X = 62
          const WALL_TOP_M = 3.2
          const target = new THREE.Vector3(cx, 0.8, cz)

          // THE FRAMING IS MEASURED, NOT ASSUMED. The previous version stood the
          // eye at fixed multiples of the plate's bbox — a rule tuned on one
          // rectangular 40 × 24 m plan. On the real irregular ~930 m² plate the
          // same multipliers left the building filling barely a third of the
          // frame, and on an unlucky plate they point at sky. So: fix the view
          // DIRECTION, then PROJECT the plate's own corners through the very
          // camera `renderInteriorStill` will build (same horizontal FOV, same
          // aspect, same fovY derivation) and bisect the standoff until the
          // footprint's extreme point lands at `FILL` of the half-frame.
          const FILL = 0.9
          const aspect = width / height
          const fovY = (2 * Math.atan(Math.tan((FOV_X * Math.PI) / 180 / 2) / aspect) * 180) / Math.PI
          // Every plate corner at floor AND at wall-top height: a roof-off shot
          // still has to contain the walls, and the near-corner parapet is what
          // actually leaves the frame first.
          const probes = []
          for (const [px, pz] of ring) for (const py of [0, WALL_TOP_M]) probes.push(new THREE.Vector3(px, py, pz))
          const camAt = (dir, dist) => {
            const probe = new THREE.PerspectiveCamera(fovY, aspect, 0.08, 400)
            probe.position.copy(target).addScaledVector(dir, dist)
            probe.lookAt(target)
            probe.updateMatrixWorld(true)
            probe.updateProjectionMatrix()
            return probe
          }
          const fillAt = (dir, dist) => {
            const probe = camAt(dir, dist)
            let worst = 0
            for (const p of probes) {
              const n = p.clone().project(probe)
              // Anything behind the camera projects to a meaningless NDC; at
              // these standoffs it cannot happen, but treat it as "off frame".
              if (n.z > 1) return Infinity
              worst = Math.max(worst, Math.abs(n.x), Math.abs(n.y))
            }
            return worst
          }
          /** The nearest standoff on this heading at which the whole plate fits. */
          const fitDist = (dir) => {
            let lo = span * 0.2
            let hi = span * 6
            if (fillAt(dir, hi) > FILL) return null
            for (let i = 0; i < 40; i++) {
              const mid = (lo + hi) / 2
              if (fillAt(dir, mid) > FILL) lo = mid
              else hi = mid
            }
            return hi
          }
          /** Fraction of the 16:9 frame the floorplate itself covers. The floor
           *  ring is planar, so its perspective image is still a simple polygon
           *  and the shoelace is exact. This is the number that decides the
           *  heading: "contains the building" is necessary, "and is mostly
           *  building rather than lawn" is what makes it a hero shot. */
          const coverage = (dir, dist) => {
            const probe = camAt(dir, dist)
            const pts = ring.map(([px, pz]) => new THREE.Vector3(px, 0, pz).project(probe))
            let a = 0
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i]
              const q = pts[(i + 1) % pts.length]
              a += p.x * q.y - q.x * p.y
            }
            return Math.abs(a) / 2 / 4 // NDC frame is 2 × 2
          }
          // Sweep headings around the open side of the plan (looking in over the
          // workspace, not at the back of a wall run) and keep the one that
          // covers most frame. A near-square footprint in a 16:9 frame wastes a
          // third of the picture on the wrong diagonal.
          const base = Math.atan2(0.86, -0.52)
          let best = null
          for (let dAz = -40; dAz <= 40; dAz += 4) {
            for (const elevDeg of [28, 32, 36, 40]) {
              const a = base + (dAz * Math.PI) / 180
              const el = (elevDeg * Math.PI) / 180
              const dir = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el))
              const dist = fitDist(dir)
              if (dist == null) continue
              const cov = coverage(dir, dist)
              if (!best || cov > best.cov) best = { dir, dist, cov, dAz, elevDeg }
            }
          }
          if (!best) throw new Error('aerial: no heading fits the plate in frame')
          const { dir, dist } = best
          const fill = fillAt(dir, dist)
          // A frame the building does not fill is the failure that shipped last
          // time in its other direction; assert BOTH ends of the bracket.
          if (!(fill > 0.6 && fill <= 1.0)) {
            throw new Error(`aerial: framing fit failed — the plate spans ${fill.toFixed(2)} of the half-frame`)
          }
          if (best.cov < 0.2) throw new Error(`aerial: the floorplate covers only ${(best.cov * 100).toFixed(0)}% of the frame`)
          const eye = target.clone().addScaledVector(dir, dist)
          const cam = {
            eye,
            target,
            fovHorizontalDeg: FOV_X,
            placement: 'interior',
            forwardClearanceM: eye.distanceTo(target),
          }
          const still = window.DS.renderInteriorStill(scene, cam, {
            width,
            height,
            exposure: 1.1,
            lampIntensity: 2,
            shadowRadiusM: Math.max(24, span * 0.7),
          })
          console.log(
            `aerial plate x[${minX.toFixed(1)},${maxX.toFixed(1)}] z[${minZ.toFixed(1)},${maxZ.toFixed(1)}] ` +
              `${ring.length} verts · heading ${best.dAz >= 0 ? '+' : ''}${best.dAz}° elev ${best.elevDeg}° · ` +
              `standoff ${dist.toFixed(1)} m · fills ${(fill * 100).toFixed(0)}% of the half-frame · ` +
              `floorplate covers ${(best.cov * 100).toFixed(0)}% of the frame · ` +
              `eye(${eye.x.toFixed(1)},${eye.y.toFixed(1)},${eye.z.toFixed(1)}) ` +
              `target(${target.x.toFixed(1)},${target.y.toFixed(1)},${target.z.toFixed(1)})`,
          )
          out.push({
            key: 'Overview_aerial',
            camera: {
              eye: [eye.x, eye.y, eye.z],
              target: [target.x, target.y, target.z],
              fovHorizontalDeg: cam.fovHorizontalDeg,
              placement: 'aerial',
            },
            roomLabel: 'whole floorplate',
            width: still.canvas.width,
            height: still.canvas.height,
            png: b64(await window.DS.canvasToPngBytes(still.canvas)),
          })
        } finally {
          scene.dispose()
        }
      }
      return out
    },
    { state, wallTypes, plate, width: WIDTH, height: HEIGHT, roomKeys, wantAerial },
  )
  await browser.close()

  fs.mkdirSync(BASE_DIR, { recursive: true })
  const written = []
  for (const s of stills) {
    const file = path.join(BASE_DIR, `${s.key}.png`)
    fs.writeFileSync(file, Buffer.from(s.png, 'base64'))
    const dim = imageInfo(fs.readFileSync(file))
    if (dim.kind !== 'png' || dim.width < 640) {
      throw new Error(`capture produced a bad PNG for ${s.key}: ${JSON.stringify(dim)}`)
    }
    console.log(
      `  base ${s.key.padEnd(17)} ${dim.width}x${dim.height}  ${s.roomLabel.padEnd(18)} ` +
        `${(fs.statSync(file).size / 1024).toFixed(0)} KB`,
    )
    written.push({ key: s.key, camera: s.camera, roomLabel: s.roomLabel, ...dim })
  }
  const doc = {
    source: source.kind,
    plateFile: source.file ?? null,
    seed: source.kind === 'seeded' ? SEED : null,
    plateAreaM2: source.areaM2 ?? (plate ? Number(ringArea(plate).toFixed(1)) : null),
    plateVertices: Array.isArray(plate) ? plate.length : 0,
    walls: state.walls.length,
    components: state.components.length,
    zones: (state.zones ?? []).length,
    workstations: source.workstations ?? null,
  }
  // Stamped BESIDE the stills at the moment they were shot. `crates/ds-core` is
  // live code — a `make wasm` between two runs changes the test-fit — so the
  // provenance travels with the pixels rather than being re-derived later from a
  // core that may since have moved.
  fs.writeFileSync(
    path.join(BASE_DIR, 'doc.json'),
    JSON.stringify({ gpu: gl, doc, source, stills: written }, null, 2),
  )
  return {
    gpu: gl,
    doc,
    stills: written,
  }
}

// ── byte-level verification (never trust a 200) ──────────────────────────────
/** Kind + pixel dimensions parsed OUT OF THE BYTES. Returns kind 'unknown' for
 *  anything that is not a real PNG/JPEG/WEBP — an HTML error page, a truncated
 *  download and a zero-length file all land there. */
export function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { kind: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      // SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry the frame dimensions.
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { kind: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), bytes: buf.length }
      }
      i += 2 + len
    }
    return { kind: 'jpeg', width: 0, height: 0, bytes: buf.length }
  }
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16)
    if (chunk === 'VP8X') {
      return {
        kind: 'webp',
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
        bytes: buf.length,
      }
    }
    if (chunk === 'VP8 ') {
      return { kind: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, bytes: buf.length }
    }
    return { kind: 'webp', width: 0, height: 0, bytes: buf.length }
  }
  return { kind: 'unknown', width: 0, height: 0, bytes: buf.length }
}

// ── Replicate ────────────────────────────────────────────────────────────────
const TOKEN = process.env.REPLICATE_API_TOKEN
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A 429 IS NOT A FAILED RENDER — it is the server saying "later", and the whole
 * request is still valid. Treating it as terminal cost this pack 8 of its 15
 * variations in one run: Replicate throttles prediction creation to 6/min with a
 * burst of 1 once an account drops under $5 of credit, and every view after the
 * sixth came back `FAILED — 429` while the sheet quietly rendered a half-empty
 * deck. Honour the server's own `retry_after`, and only give up after it has
 * asked us to wait more times than any real backlog would.
 */
const api = async (url, init = {}, attempt = 0) => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON body — reported below */ }
  if (res.status === 429 && attempt < 12) {
    // The server states the wait; the header is the fallback, and a floor of 11 s
    // clears a 6-per-minute window even when neither is present.
    const stated = Number(json?.retry_after ?? res.headers.get('retry-after') ?? 0)
    const wait = Math.max(11, stated + 2) * 1000
    process.stdout.write(`[429, waiting ${(wait / 1000).toFixed(0)}s] `)
    await sleep(wait)
    return api(url, init, attempt + 1)
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 400)}`)
  if (!json) throw new Error(`${url} returned a non-JSON body: ${text.slice(0, 200)}`)
  return json
}

/** Flatten an RGBA capture to a 3-channel JPEG (optionally downscaled) with
 *  Pillow — the same image library the acceptance gates use. */
function toRgbJpeg(src, dest, maxWidth) {
  execFileSync('python3', [
    '-c',
    'import sys\n' +
      'from PIL import Image\n' +
      'src, dest, mw = sys.argv[1], sys.argv[2], int(sys.argv[3])\n' +
      'im = Image.open(src).convert("RGB")\n' +
      'if im.width > mw: im = im.resize((mw, round(im.height * mw / im.width)), Image.LANCZOS)\n' +
      'im.save(dest, "JPEG", quality=95)\n',
    src,
    dest,
    String(maxWidth),
  ])
  const info = imageInfo(fs.readFileSync(dest))
  if (info.kind !== 'jpeg' || info.width < 512) throw new Error(`RGB conversion of ${src} produced ${JSON.stringify(info)}`)
  return dest
}

/** Upload a local file to Replicate's file store and return its served URL.
 *  Preferred over a data: URI — a 1080p PNG is ~2 MB and base64 inflates it. */
async function uploadFile(file) {
  const form = new FormData()
  const type = file.endsWith('.jpg') ? 'image/jpeg' : 'image/png'
  form.append('content', new Blob([fs.readFileSync(file)], { type }), path.basename(file))
  const json = await api('https://api.replicate.com/v1/files', { method: 'POST', body: form })
  const url = json?.urls?.get
  if (!url) throw new Error(`file upload returned no urls.get: ${JSON.stringify(json).slice(0, 200)}`)
  return url
}

async function predict(model, input) {
  const started = Date.now()
  let p = await api('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: model.version, input }),
  })
  const pollUrl = p?.urls?.get
  if (!pollUrl) throw new Error(`prediction created without urls.get: ${JSON.stringify(p).slice(0, 300)}`)
  while (p.status !== 'succeeded' && p.status !== 'failed' && p.status !== 'canceled') {
    await new Promise((r) => setTimeout(r, 2500))
    p = await api(pollUrl)
    if (Date.now() - started > 10 * 60_000) throw new Error(`prediction ${p.id} timed out after 10 min`)
  }
  if (p.status !== 'succeeded') {
    throw new Error(`prediction ${p.id} ${p.status}: ${p.error ?? '(no error field)'}`)
  }
  const out = Array.isArray(p.output) ? p.output[0] : p.output
  if (typeof out !== 'string' || !out.startsWith('http')) {
    throw new Error(`prediction ${p.id} succeeded with no usable output: ${JSON.stringify(p.output).slice(0, 200)}`)
  }
  return { url: out, id: p.id, seconds: (Date.now() - started) / 1000, metrics: p.metrics ?? null }
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const info = imageInfo(buf)
  // A success message is not evidence: the bytes must BE an image, and a real
  // one (a 1x1 placeholder or a 3 KB error page would otherwise pass a 200).
  if (info.kind === 'unknown') throw new Error(`downloaded bytes are not an image (${buf.length} B) from ${url}`)
  if (info.width < 512 || info.height < 512 * 0.4) {
    throw new Error(`downloaded image is too small: ${info.width}x${info.height} from ${url}`)
  }
  if (buf.length < 50_000) throw new Error(`downloaded image is only ${buf.length} B — likely blank`)
  fs.writeFileSync(dest, buf)
  return info
}

// ── main ─────────────────────────────────────────────────────────────────────
const keys = (ONLY ?? VIEWS.map((v) => v.key)).filter((k) => VIEWS.some((v) => v.key === k))
if (!keys.length) throw new Error(`--only matched no viewpoint; known: ${VIEWS.map((v) => v.key).join(',')}`)

const manifestPath = path.join(OUT, 'manifest.json')

// Re-render the contact sheet from the manifest already on disk — the notes and
// the layout are editable without paying for the images again.
if (SHEET_ONLY) {
  if (!fs.existsSync(manifestPath)) throw new Error(`--sheet-only but ${manifestPath} does not exist`)
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const rows = (m.variations ?? []).map((v) => ({ ...v, note: noteFor(v.view, v.style) }))
  const stamp = path.join(BASE_DIR, 'doc.json')
  const doc = m.doc ?? (fs.existsSync(stamp) ? JSON.parse(fs.readFileSync(stamp, 'utf8')).doc : null)
  fs.writeFileSync(manifestPath, JSON.stringify({ ...m, doc, variations: rows }, null, 2))
  writeContactSheet(rows, { gpu: m.gpu, doc }, m.failures ?? [])
  const gone = verifyDeck(rows)
  console.log(`rebuilt ${SHEET} from ${rows.length} manifest rows · ${rows.length - gone.length} verified on disk`)
  for (const g of gone) console.log(`  MISSING  ${g}`)
  process.exit(gone.length ? 1 : 0)
}

let capturedMeta = { gpu: 'reused', doc: null, stills: [] }
if (SKIP_CAPTURE) {
  for (const k of keys) {
    const f = path.join(BASE_DIR, `${k}.png`)
    if (!fs.existsSync(f)) throw new Error(`--skip-capture but ${f} is missing — run without it first`)
    capturedMeta.stills.push({ key: k, ...imageInfo(fs.readFileSync(f)) })
  }
  const stamp = path.join(BASE_DIR, 'doc.json')
  // The stamp is provenance, and reusing stills means re-consuming it. A MISSING
  // stamp is a failure, never a skip: unstamped stills are of an unknown
  // building, which is exactly the state that shipped the sample-office pack.
  if (!fs.existsSync(stamp)) throw new Error(`--skip-capture but ${stamp} is missing — the base stills have no provenance`)
  capturedMeta.doc = JSON.parse(fs.readFileSync(stamp, 'utf8')).doc
  if (DOC_SOURCE === 'wizard' && capturedMeta.doc?.source !== 'wizard') {
    throw new Error(
      `--skip-capture but the stills on disk were captured from '${capturedMeta.doc?.source}', not the imported plate. ` +
        `Re-capture, or pass --doc seeded deliberately.`,
    )
  }
  console.log(
    `reusing ${keys.length} base stills in ${BASE_DIR} — ${capturedMeta.doc?.source} · ` +
      `${capturedMeta.doc?.walls} walls · ${capturedMeta.doc?.components} components`,
  )
} else {
  capturedMeta = await capture(keys)
}

if (VIEWS_ONLY) {
  console.log('--views-only: base stills captured, skipping Replicate')
  process.exit(0)
}

if (!TOKEN) {
  console.error(
    'REPLICATE_API_TOKEN is not set. Source your credential file first:\n' +
      '  set -a; . /path/to/replicate.env; set +a\n' +
      'The token must never be written into this repository.',
  )
  process.exit(2)
}

fs.mkdirSync(VAR_DIR, { recursive: true })
const prior = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { variations: [] }
const results = (prior.variations ?? []).filter((v) => !keys.includes(v.view))
const failures = []
let predictions = 0

for (const key of keys) {
  const view = VIEWS.find((v) => v.key === key)
  const baseFile = path.join(BASE_DIR, `${key}.png`)
  console.log(`\n${key} — uploading base still`)
  // Drop this view's previous variations so a renamed style or a changed output
  // format cannot leave an orphan in the deck.
  for (const f of fs.readdirSync(VAR_DIR)) {
    if (f.startsWith(`${key}__`)) fs.rmSync(path.join(VAR_DIR, f))
  }
  /** One upload per distinct control-image variant, reused across styles. */
  const uploads = new Map()
  const controlUrl = async (model) => {
    const tag = model.prep ? `${model.prep.format}${model.prep.maxWidth}` : 'png'
    if (!uploads.has(tag)) {
      const src = model.prep
        ? toRgbJpeg(baseFile, path.join(BASE_DIR, `${key}.rgb${model.prep.maxWidth}.jpg`), model.prep.maxWidth)
        : baseFile
      uploads.set(tag, await uploadFile(src))
    }
    return uploads.get(tag)
  }

  for (const style of STYLES) {
    const model = MODELS[style.model]
    const prompt = promptFor(view, style)
    const dest = path.join(VAR_DIR, `${key}__${style.id}.${model.ext}`)
    process.stdout.write(`  ${style.id.padEnd(18)} ${model.owner}/${model.name} … `)
    try {
      predictions++
      const p = await predict(model, model.input(prompt, await controlUrl(model), SEED))
      const info = await download(p.url, dest)
      console.log(`ok ${info.width}x${info.height} ${(info.bytes / 1024).toFixed(0)} KB in ${p.seconds.toFixed(0)}s`)
      results.push({
        view: key,
        viewLabel: view.label,
        style: style.id,
        styleLabel: style.label,
        model: `${model.owner}/${model.name}`,
        version: model.version,
        prompt,
        file: path.relative(path.dirname(SHEET), dest),
        base: path.relative(path.dirname(SHEET), baseFile),
        width: info.width,
        height: info.height,
        bytes: info.bytes,
        predictionId: p.id,
        seconds: Number(p.seconds.toFixed(1)),
        note: noteFor(key, style.id),
      })
    } catch (e) {
      console.log(`FAILED — ${e.message}`)
      failures.push({ view: key, style: style.id, model: `${model.owner}/${model.name}`, error: e.message })
    }
  }
}

fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    { seed: SEED, capturedAt: new Date().toISOString(), gpu: capturedMeta.gpu, doc: capturedMeta.doc, base: capturedMeta.stills, variations: results, failures },
    null,
    2,
  ),
)

writeContactSheet(results, capturedMeta, failures)

// The manifest is the PRODUCER'S ACCOUNT of what it wrote; the deck is the
// bytes. Two rows once claimed 107 KB and 158 KB images that were not on disk —
// the sheet rendered them as broken frames and the summary line still said
// "15 variations on disk", because it was counting manifest rows. Re-derive the
// count from the filesystem, and check each row against the file it names.
const missing = verifyDeck(results)
console.log(
  `\n${predictions} predictions · ${results.length - missing.length}/${results.length} variations ` +
    `verified on disk · ${failures.length} prediction failures\n` +
    `  images  ${OUT}\n  sheet   ${SHEET}`,
)
for (const m of missing) console.log(`  MISSING  ${m}`)
if (failures.length || missing.length) process.exitCode = 1

/** Every manifest row re-read from the file it names. Returns the bad ones. */
function verifyDeck(rows) {
  const bad = []
  for (const r of rows) {
    const file = path.resolve(path.dirname(SHEET), r.file)
    if (!fs.existsSync(file)) { bad.push(`${r.view} · ${r.style} — ${r.file} does not exist`); continue }
    const info = imageInfo(fs.readFileSync(file))
    if (info.kind === 'unknown') bad.push(`${r.view} · ${r.style} — ${r.file} is not an image (${info.bytes} B)`)
    else if (info.bytes !== r.bytes || info.width !== r.width) {
      bad.push(`${r.view} · ${r.style} — ${r.file} is ${info.width}×${info.height} ${info.bytes} B, manifest says ${r.width}×${r.height} ${r.bytes} B`)
    }
  }
  return bad
}

// ── the contact sheet ────────────────────────────────────────────────────────

/** One line naming WHICH BUILDING these pixels are of, read off the stamp that
 *  travelled with them. The pack once shipped the seeded sample under a caption
 *  that said "the SAME office plan"; the caption is now derived, not written. */
function provenance(doc) {
  if (!doc) return 'document provenance unknown'
  if (doc.source === 'wizard') {
    return (
      `the imported ${doc.plateFile ?? 'DWG'} plate` +
      (doc.plateAreaM2 ? `, ${doc.plateAreaM2} m² over ${doc.plateVertices} boundary vertices` : '') +
      (doc.workstations ? `, ${doc.workstations} workstations` : '')
    )
  }
  return `the seeded 40 × 24 m sample office, seed ${doc.seed ?? '?'}`
}

function writeContactSheet(rows, meta, fails) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const byView = new Map()
  for (const r of rows) {
    if (!byView.has(r.view)) byView.set(r.view, [])
    byView.get(r.view).push(r)
  }
  const order = VIEWS.map((v) => v.key).filter((k) => byView.has(k))
  const sections = order
    .map((k) => {
      const view = VIEWS.find((v) => v.key === k)
      const rs = byView.get(k)
      const baseRel = rs[0].base
      const cards = rs
        .map(
          (r) => `
        <figure class="card">
          <a href="${esc(r.file)}"><img src="${esc(r.file)}" alt="${esc(r.viewLabel)} — ${esc(r.styleLabel)}"></a>
          <figcaption>
            <b>${esc(r.styleLabel)}</b>
            <span class="num">${r.width}×${r.height}</span>
            <code>${esc(r.model)}</code>
            <p>${esc(r.prompt)}</p>
            ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
          </figcaption>
        </figure>`,
        )
        .join('')
      return `
      <section>
        <h2>${esc(view.label)} <span class="key num">${esc(k)}</span></h2>
        <div class="row">
          <figure class="card base">
            <a href="${esc(baseRel)}"><img src="${esc(baseRel)}" alt="${esc(view.label)} base"></a>
            <figcaption><b>BASE — our 3D geometry</b><code>web/src/three/interiorStill.ts</code>
            <p>Rendered from the Rust core's document — ${esc(provenance(meta.doc))}. This is the
            structure every variation to its right is conditioned on.</p></figcaption>
          </figure>
          ${cards}
        </div>
      </section>`
    })
    .join('')

  const failHtml = fails.length
    ? `<section class="fails"><h2>Failures</h2><ul>${fails
        .map((f) => `<li><b>${esc(f.view)}</b> · ${esc(f.style)} · ${esc(f.model)} — ${esc(f.error)}</li>`)
        .join('')}</ul></section>`
    : ''

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>DSource — photoreal render pack</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --bg:#0d0f12; --panel:#15181d; --line:#262b33; --ink:#e8eaee; --dim:#9aa3af; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 "Hanken Grotesk",system-ui,-apple-system,sans-serif; padding:32px 28px 64px }
  h1 { font-size:26px; margin:0 0 4px; letter-spacing:-0.01em }
  .sub { color:var(--dim); margin:0 0 28px; max-width:80ch }
  .num, code { font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px }
  h2 { font-size:16px; margin:34px 0 10px; padding-bottom:8px; border-bottom:1px solid var(--line);
       display:flex; align-items:baseline; gap:10px }
  .key { color:var(--dim); font-weight:400 }
  .row { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:14px }
  .card { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden }
  .card.base { outline:2px solid #2d5bd6; outline-offset:-2px }
  .card img { width:100%; display:block; aspect-ratio:16/9; object-fit:contain; background:#000 }
  figcaption { padding:10px 12px 14px }
  figcaption b { display:block; font-size:13px }
  figcaption code { display:block; color:var(--dim); margin:3px 0 6px }
  figcaption .num { color:var(--dim); float:right }
  figcaption p { margin:0; color:var(--dim); font-size:12px; line-height:1.45 }
  figcaption .note { margin-top:7px; padding-top:7px; border-top:1px dashed var(--line); color:#c9b48a }
  .fails { color:#ff9a9a }
</style></head><body>
<h1>DSource — photoreal render pack</h1>
<p class="sub">Every image on this page is the SAME office plan — <b>${esc(provenance(meta.doc))}</b>, the
same document the demo film imports, edits and exports. The base still on the left of each row is
rendered by the app's own 3D pipeline out of the Rust core's document (GPU
<span class="num">${esc(meta.gpu)}</span>${meta.doc ? `, <span class="num">${meta.doc.walls}</span> walls ·
<span class="num">${meta.doc.components}</span> placed components · <span class="num">${meta.doc.zones}</span> zones` : ''}),
and each variation is that exact frame re-lit by a
structure-preserving model on Replicate. Prompts and model versions are printed under each image.</p>
${meta.doc && meta.doc.source !== 'wizard' ? `<p class="sub" style="color:#ff9a9a"><b>NOT THE DEMO'S BUILDING.</b>
These stills come from the ${esc(meta.doc.source)} sample office, not the imported
<span class="num">samples/furniture-plan.dwg</span> plate the rest of the demo uses.</p>` : ''}
${sections}
${failHtml}
</body></html>`
  fs.mkdirSync(path.dirname(SHEET), { recursive: true })
  fs.writeFileSync(SHEET, html)
}
