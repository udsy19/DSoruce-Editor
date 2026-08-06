// The shared-link 3D viewer — the page behind `/share/<id>` (deliverable 4).
//
// A client with the link gets the model in their browser with no plugin, no
// Autodesk APS, no token and no external request of any kind: the page is the
// SPA build's second entry (`web/viewer.html`), every font is bundled, and the
// only fetches are same-origin (`/api/share/<id>` + its `.glb`).
//
// Why this is not `three/Viewer3D`: that viewer is the EDITOR's — it builds its
// own scene from a live `DocState`, carries picking, quality tiers, minimap
// poses, theme persistence and an ACES/sky look calibrated for editing. A share
// page has a different job: load one baked GLB, on the white studio backdrop, at
// the render pipeline's own settings (reports/D-1.md §2 — Neutral tone mapping,
// exposure 1.15, VSM shadows, env 0.42), so the link and the hero renders show
// the same building. What IS shared is the substance: the scene comes from
// `buildInteriorScene` via `export/share.ts`, and the light rig + IBL below are
// D's `createInteriorLighting` / `interiorEnvironment`, not a second rig.

import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/schibsted-grotesk/700.css'
import './viewer.css'
import { ACCENT_AMBER } from '../editor/planStyle'

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createInteriorLighting, interiorEnvironment } from '../three/materialTheme'

const EYE_HEIGHT = 1.6 // m — same eye as the hero stills (interiorStill.EYE_HEIGHT)
const WALK_SPEED = 3.0 // m/s
const SPRINT = 2.0

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const stage = byId('stage')
const hintEl = byId('hint')
const noticeEl = byId('notice')
const walkBtn = byId<HTMLButtonElement>('walk-toggle')
const frameBtn = byId<HTMLButtonElement>('reset-view')

const planId = /^\/share\/([^/]+)/.exec(location.pathname)?.[1] ?? ''

function hint(text: string): void {
  hintEl.textContent = text
}

function notice(html: string): void {
  noticeEl.innerHTML = html
  noticeEl.hidden = false
}

// ── Renderer / scene ────────────────────────────────────────────────────────
// Settings are reports/D-1.md §2 verbatim; the background is white because a
// share page is a product shot of the floor, not an interior photograph.

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  // The canvas is the deliverable: a client saving the view (right-click → save
  // image, or any screenshot tool that reads the canvas back) must get pixels
  // rather than a cleared buffer, so the drawing buffer is kept between frames.
  preserveDrawingBuffer: true,
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.toneMapping = THREE.NeutralToneMapping
renderer.toneMappingExposure = 1.15
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.VSMShadowMap
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xffffff)
const envRT = interiorEnvironment(renderer)
scene.environment = envRT.texture
scene.environmentIntensity = 0.42

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 900)
camera.position.set(18, 14, 18)

const orbit = new OrbitControls(camera, renderer.domElement)
orbit.enableDamping = true
orbit.dampingFactor = 0.12
orbit.zoomToCursor = true
orbit.maxPolarAngle = Math.PI * 0.495 // never orbit under the floor
orbit.minDistance = 1

const walk = new PointerLockControls(camera, renderer.domElement)
walk.enabled = false

let mode: 'orbit' | 'walk' = 'orbit'
let contentBox = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 3, 10))
/** Plan footprints of everything a walker could stand inside — walls, casework,
 *  desks. Collected once at load; the spawn search below is pure arithmetic
 *  over these rather than raycasts, which keeps it instant on a 500-mesh floor. */
let obstacles: Array<{ x0: number; x1: number; z0: number; z1: number }> = []

// ── Framing ─────────────────────────────────────────────────────────────────

function frameAll(): void {
  const center = contentBox.getCenter(new THREE.Vector3())
  const sphere = contentBox.getBoundingSphere(new THREE.Sphere())
  // Fit the plan's bounding sphere to the NARROWER of the two field angles, then
  // pull in: a floorplate is a flat rectangle, so its sphere over-reserves the
  // frame and a literal fit leaves the model marooned in white.
  const vFov = (camera.fov * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
  const dist = (Math.max(sphere.radius, 3) / Math.sin(Math.min(vFov, hFov) / 2)) * 0.95
  // Standard 3/4 aerial: ~40° above the floor, off one corner.
  camera.position
    .set(0.62, 0.66, 0.72)
    .normalize()
    .multiplyScalar(dist)
    .add(center)
  orbit.target.copy(center)
  orbit.maxDistance = dist * 3
  camera.near = Math.max(0.05, dist / 4000)
  camera.far = dist * 12
  camera.updateProjectionMatrix()
  orbit.update()
}

/** Planar distance from (x, z) to an obstacle footprint; 0 when inside it. */
function clearanceTo(o: (typeof obstacles)[number], x: number, z: number): number {
  const dx = Math.max(o.x0 - x, 0, x - o.x1)
  const dz = Math.max(o.z0 - z, 0, z - o.z1)
  return Math.hypot(dx, dz)
}

function clearance(x: number, z: number): number {
  let min = Infinity
  for (const o of obstacles) {
    const d = clearanceTo(o, x, z)
    if (d < min) min = d
    if (min === 0) break
  }
  return min
}

/** How far a walker could see along `heading` before hitting something (m). */
function openRun(x: number, z: number, heading: number): number {
  const ux = Math.sin(heading)
  const uz = Math.cos(heading)
  for (let t = 1; t < 40; t += 0.5) {
    if (clearance(x + ux * t, z + uz * t) < 0.35) return t
  }
  return 40
}

/**
 * Drop the walker into the most open spot on the floor, facing the longest
 * clear view from it. Spawning at the orbit camera's plan position is what a
 * naive implementation does — and on a real test-fit that lands you nose-first
 * into a meeting-room wall about half the time (observed).
 */
function enterWalk(): void {
  const min = contentBox.min
  const max = contentBox.max
  let best = { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2, score: -1 }
  const steps = 22
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const x = min.x + ((max.x - min.x) * i) / steps
      const z = min.z + ((max.z - min.z) * j) / steps
      const c = Math.min(clearance(x, z), 6) // beyond ~6 m it is all "open"
      if (c < 1) continue
      // Prefer open floor, then proximity to where the client was orbiting —
      // the view they chose still steers where they land.
      const near = 1 - Math.min(1, Math.hypot(x - camera.position.x, z - camera.position.z) / 40)
      const score = c + near * 1.5
      if (score > best.score) best = { x, z, score }
    }
  }
  let heading = 0
  let bestRun = -1
  for (let k = 0; k < 24; k++) {
    const h = (k / 24) * Math.PI * 2
    const run = openRun(best.x, best.z, h)
    if (run > bestRun) {
      bestRun = run
      heading = h
    }
  }
  camera.position.set(best.x, EYE_HEIGHT, best.z)
  camera.lookAt(best.x + Math.sin(heading), EYE_HEIGHT, best.z + Math.cos(heading))
}

function setMode(next: 'orbit' | 'walk'): void {
  if (next === mode) return
  mode = next
  orbit.enabled = mode === 'orbit'
  walk.enabled = mode === 'walk'
  walkBtn.setAttribute('aria-pressed', String(mode === 'walk'))
  walkBtn.textContent = mode === 'walk' ? 'Exit walk' : 'Walk through'
  if (mode === 'walk') {
    enterWalk()
    hint('W A S D to move · Shift to sprint · click to look around · Esc to release')
  } else {
    if (walk.isLocked) walk.unlock()
    frameAll()
    hint('Drag to orbit · scroll to zoom · right-drag to pan')
  }
}

walkBtn.addEventListener('click', () => setMode(mode === 'walk' ? 'orbit' : 'walk'))
frameBtn.addEventListener('click', () => {
  setMode('orbit')
  frameAll()
})

// Pointer lock is opt-in and only ever from a real click, so a browser that
// refuses it (or a headless run) never throws.
renderer.domElement.addEventListener('click', () => {
  if (mode !== 'walk' || walk.isLocked) return
  try {
    walk.lock()
  } catch {
    hint('This browser would not capture the mouse — use W A S D to move')
  }
})

const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  keys.add(e.code)
  if (e.code === 'KeyW' || e.code === 'KeyS' || e.code === 'Space') e.preventDefault()
})
window.addEventListener('keyup', (e) => keys.delete(e.code))
window.addEventListener('blur', () => keys.clear())

function stepWalk(dt: number): void {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? WALK_SPEED * SPRINT : WALK_SPEED) * dt
  const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
  const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
  if (fwd) walk.moveForward(fwd * speed)
  if (side) walk.moveRight(side * speed)
  // Stay at eye height and inside the floor plate's footprint.
  camera.position.y = EYE_HEIGHT
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, contentBox.min.x - 4, contentBox.max.x + 4)
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, contentBox.min.z - 4, contentBox.max.z + 4)
}

// ── Frame loop ──────────────────────────────────────────────────────────────

function resize(): void {
  const w = stage.clientWidth || window.innerWidth
  const h = stage.clientHeight || window.innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / Math.max(1, h)
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

let last = performance.now() // (not THREE.Clock — deprecated in r185)
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  if (mode === 'orbit') orbit.update()
  else stepWalk(dt)
  renderer.render(scene, camera)
})

// ── Load the published model ────────────────────────────────────────────────

async function load(): Promise<void> {
  if (!planId) {
    notice('<b>No model in this link.</b><br />A share link looks like <code>/share/&lt;id&gt;</code>.')
    return
  }
  const metaRes = await fetch(`/api/share/${encodeURIComponent(planId)}`)
  if (metaRes.status === 501) {
    notice(
      '<b>This deployment has no share store.</b><br />Serverless hosting keeps no disk, so shared ' +
        'models are only served by the full DSource server (<code>deploy/server.ts</code>). ' +
        'See <code>deploy/VERCEL.md</code>.',
    )
    return
  }
  if (!metaRes.ok) {
    notice('<b>This link has expired or was never published.</b><br />Ask for a fresh share link.')
    return
  }
  const meta = (await metaRes.json()) as { name?: string; createdAt?: string }
  const name = meta.name || 'Untitled Plan'
  byId('plan-name').textContent = name
  document.title = `${name} — DSource 3D`
  byId('plan-sub').textContent = meta.createdAt
    ? `shared 3D model · ${new Date(meta.createdAt).toLocaleDateString()}`
    : 'shared 3D model'

  hint('Loading model…')
  const bytes = await (await fetch(`/api/share/${encodeURIComponent(planId)}/model.glb`)).arrayBuffer()
  const gltf = await new GLTFLoader().parseAsync(bytes, '')
  // glTF carries no shadow flags, so they are re-derived here. Only objects with
  // real height cast: the floor plates are zero-thickness `ShapeGeometry`, and a
  // flat plate casting onto itself is what shadow acne is made of (it striped
  // the desks across the open plan before this test).
  gltf.scene.updateMatrixWorld(true)
  const probe = new THREE.Box3()
  obstacles = []
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.receiveShadow = true
    probe.setFromObject(m)
    const h = probe.max.y - probe.min.y
    m.castShadow = h > 0.05
    // Anything a person could walk into (waist height and up) blocks a spawn.
    if (h > 0.5 && probe.min.y < 1.9) {
      obstacles.push({ x0: probe.min.x, x1: probe.max.x, z0: probe.min.z, z1: probe.max.z })
    }
  })
  scene.add(gltf.scene)

  contentBox = new THREE.Box3().setFromObject(gltf.scene)
  const c = contentBox.getCenter(new THREE.Vector3())
  const s = contentBox.getSize(new THREE.Vector3())
  // D's rig, aimed at the middle of the plate (plan Y is world Z).
  scene.add(
    createInteriorLighting({
      focus: { x: c.x, y: c.z, radius: Math.max(s.x, s.z) / 2 },
      ceilingLamps: 12, // realtime budget; the stills use 28 offscreen
      lampReachM: Math.min(16, Math.max(s.x, s.z) / 2),
    }),
  )
  frameAll()
  hint('Drag to orbit · scroll to zoom · right-drag to pan')
}

load().catch((e: unknown) => {
  hint('')
  notice(`<b>Could not open this model.</b><br />${e instanceof Error ? e.message : String(e)}`)
})

// The viewer is a standalone page and cannot reference the app's token sheet, so
// the accent's ONE source reaches it here rather than being restated in CSS.
document.documentElement.style.setProperty('--accent', ACCENT_AMBER)
