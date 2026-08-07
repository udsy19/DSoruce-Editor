// Photoreal render pack — the app's OWN 3D geometry, re-lit by Replicate.
//
// Two stages, one command:
//
//   1. CAPTURE — drive the app's real interior renderer (`web/src/export/
//      roomRenders.ts` → `web/src/three/{materialTheme,interiorStill}.ts`) over
//      the seeded demo document from the Rust core, exactly the way
//      `scripts/render-rooms.mjs` does. Nothing is re-implemented; the only new
//      camera here is the aerial cutaway (`Overview_aerial`), which is a plain
//      `StillCamera` handed to the SAME `renderInteriorStill`.
//   2. RESTYLE — POST each base still to a structure-preserving Replicate model
//      (depth / edge / interior-ControlNet) with a materials-and-lighting
//      prompt, then poll, download and VERIFY the bytes.
//
// Usage:
//   set -a; . /path/to/replicate.env; set +a          # REPLICATE_API_TOKEN
//   node scripts/renders/render-plan.mjs
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
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc } from '../lib/demo-doc.mjs'

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
    'DRIFT — the foreground reception desk is re-read as a raised floor plinth, and a framed ' +
    'sign is invented on the far wall. Shell, glazed partition and the meeting room beyond are ' +
    'correct; the furniture in the near third is not.',
  Reception__premium_terrazzo:
    'DRIFT — same lost reception desk as the daylight variant, plus a small invented logo at ' +
    'bottom left.',
  Reception__evening_warm:
    'HOLDS — the depth model keeps the reception desk a desk. Faint illegible lettering is ' +
    'hallucinated on the glass partition.',
  Conference_room__daylight_oak: 'HOLDS — table, chair positions, door and pendant all track the base. Illegible lettering appears in the fritted glass.',
  Conference_room__premium_terrazzo: 'HOLDS — as above; illegible lettering in the fritted glass.',
  Overview_aerial__evening_warm:
    'HOLDS with licence — plate outline, mullion rhythm, meeting-room boxes and the open ' +
    'circulation zone are all in place; individual desk runs are re-interpreted as continuous ' +
    'benches.',
}
const noteFor = (view, style) => NOTES[`${view}__${style.replace(/-/g, '_')}`] ?? null

const promptFor = (view, style) => `${SHELL}. ${view.subject}. ${style.style}.`

// ── stage 1: capture the base stills out of the app's own renderer ───────────
const webRequire = createRequire(path.join(REPO, 'web/package.json'))

async function capture(keys) {
  const { build } = await import(
    pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
  )
  const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
  const chromium = playwright.chromium ?? playwright.default.chromium

  const { state, wallTypes, plate } = await buildDemoDoc({ seed: SEED })
  console.log(
    `doc: ${state.walls.length} walls · ${state.components.length} components · ` +
      `${(state.zones ?? []).length} zones · seed ${SEED}`,
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
          const eye = new THREE.Vector3(
            minX - spanX * 0.34,
            span * 0.55,
            maxZ + spanZ * 0.75,
          )
          const target = new THREE.Vector3(cx, 0.8, cz)
          const cam = {
            eye,
            target,
            fovHorizontalDeg: 62,
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
    seed: SEED,
    walls: state.walls.length,
    components: state.components.length,
    zones: (state.zones ?? []).length,
  }
  // Stamped BESIDE the stills at the moment they were shot. `crates/ds-core` is
  // live code — a `make wasm` between two runs changes the test-fit — so the
  // provenance travels with the pixels rather than being re-derived later from a
  // core that may since have moved.
  fs.writeFileSync(path.join(BASE_DIR, 'doc.json'), JSON.stringify({ gpu: gl, doc, stills: written }, null, 2))
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
const api = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON body — reported below */ }
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
  console.log(`rebuilt ${SHEET} from ${rows.length} manifest rows`)
  process.exit(0)
}

let capturedMeta = { gpu: 'reused', doc: null, stills: [] }
if (SKIP_CAPTURE) {
  for (const k of keys) {
    const f = path.join(BASE_DIR, `${k}.png`)
    if (!fs.existsSync(f)) throw new Error(`--skip-capture but ${f} is missing — run without it first`)
    capturedMeta.stills.push({ key: k, ...imageInfo(fs.readFileSync(f)) })
  }
  const stamp = path.join(BASE_DIR, 'doc.json')
  if (fs.existsSync(stamp)) capturedMeta.doc = JSON.parse(fs.readFileSync(stamp, 'utf8')).doc
  console.log(`reusing ${keys.length} base stills in ${BASE_DIR}`)
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
console.log(
  `\n${predictions} predictions · ${results.length} variations on disk · ${failures.length} failures\n` +
    `  images  ${OUT}\n  sheet   ${SHEET}`,
)
if (failures.length) process.exitCode = 1

// ── the contact sheet ────────────────────────────────────────────────────────
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
            <p>Rendered from the Rust core's document, seed ${SEED}. This is the structure every
            variation to its right is conditioned on.</p></figcaption>
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
<p class="sub">Every image on this page is the SAME office plan: the base still on the left of each row is
rendered by the app's own 3D pipeline out of the Rust core's document (seed <span class="num">${SEED}</span>,
GPU <span class="num">${esc(meta.gpu)}</span>${meta.doc ? `, <span class="num">${meta.doc.walls}</span> walls ·
<span class="num">${meta.doc.components}</span> placed components · <span class="num">${meta.doc.zones}</span> zones` : ''}),
and each variation is that exact frame re-lit by a
structure-preserving model on Replicate. Prompts and model versions are printed under each image.</p>
${sections}
${failHtml}
</body></html>`
  fs.mkdirSync(path.dirname(SHEET), { recursive: true })
  fs.writeFileSync(SHEET, html)
}
