import * as THREE from 'three'
import type { DocState, DocWall, DocComponent } from '../editor/EditorCanvas'
import { catByCategory } from '../editor/catalog'
import { WALL_HEIGHT, CEILING_HEIGHT } from './Viewer3D'
import { buildFurniture3D, furnitureHeight } from './furniture3d'
import { MONO, UI } from '../ui/type'

/**
 * Orthographic architectural SECTION / ELEVATION renderer.
 *
 * Given a document state (walls with heights, placed components) and a vertical
 * cut plane, produce a clean section drawing on an offscreen canvas: walls the
 * plane passes through are drawn in solid **poché**, everything **beyond** the
 * cut is drawn as depth-faded elevation silhouettes, a **floor / ceiling datum**
 * frames the storey, and level tags + a height dimension + a human scale figure
 * annotate it. The result is a raster the drawing-set generator embeds on an A3
 * section sheet (see `web/src/export/section.ts`).
 *
 * ── Two render paths (same drawing) ────────────────────────────────────────
 *  - **WebGL** (primary, when a GL context is available): the beyond/cut solids
 *    are rebuilt as Three meshes — reusing the very same wall/ceiling heights
 *    ({@link WALL_HEIGHT}/{@link CEILING_HEIGHT}) and furniture geometry
 *    ({@link buildFurniture3D}) the interactive `Viewer3D` uses, so the section
 *    and the walkthrough never disagree — and rendered through an
 *    `OrthographicCamera` aimed along the cut axis to an offscreen canvas.
 *  - **Canvas2D** (fallback, headless / no WebGL): the same boxes are projected
 *    analytically to filled silhouettes. Section generation therefore never
 *    hard-fails; {@link SectionRender.path} reports which ran.
 *
 * The datum, poché emphasis, dimension string, level tags, section label and
 * scale figure are ALWAYS drawn in Canvas2D on top, so the annotation layer is
 * identical regardless of which massing path produced the solids.
 *
 * ── Coordinate mapping ─────────────────────────────────────────────────────
 * Mirrors Viewer3D: plan X → world X, plan Y → world Z, height → world +Y, and a
 * 2D clockwise rotation θ maps to −θ about +Y. A cut is a plane perpendicular to
 * one plan axis; the OTHER plan axis becomes the section's horizontal (`u`) axis
 * and world +Y its vertical.
 */

/** A vertical cut plane. `axis` is the plan axis the plane is perpendicular to;
 *  `position` is that axis' constant value (m); `look` (+1/−1) picks which side
 *  is "beyond" (drawn) — the other side is in front of the viewer and culled;
 *  `label` names the cut ('A', 'B', …). */
export interface SectionCut {
  axis: 'x' | 'y'
  position: number
  look: 1 | -1
  label: string
}

export interface SectionRender {
  canvas: HTMLCanvasElement
  path: 'webgl' | 'canvas2d'
  /** Horizontal metres-per-pixel of the drawing area (for a plot-scale note). */
  metersPerPx: number
  /** The cut this render depicts (for the sheet's "SECTION A-A" label). */
  cut: SectionCut
}

export interface SectionOpts {
  /** Force the Canvas2D fallback even where WebGL is available (testing). */
  forceCanvas2D?: boolean
}

// Section ink palette — cool architectural greys, warm-amber datum accent
// (CLAUDE.md). Poché is near-black solid; beyond fades grey→light with depth.
const INK = '#20242a'
const POCHE = '#22262c'
const DATUM = '#2e343b'
const DIM_INK = '#4a515a'
const GROUND = '#8b939e'
const FIGURE = '#9aa2ad'
const SKY_WASH = '#f6f7f9'

const HEADROOM = 0.5 // metres of air drawn above the ceiling datum
const VIEW_DEPTH_FADE = 12 // metres beyond the cut over which beyond fades to light

// ── Box model ────────────────────────────────────────────────────────────────

/** An element reduced to a vertical prism: its footprint corners in plan (m)
 *  plus a floor→top height range (m). Walls and components both become one. */
interface Prism {
  corners: Array<{ x: number; y: number }>
  y0: number
  y1: number
  kind: 'wall' | 'furniture'
  color: string
}

/** Rectangle footprint corners for a wall segment (length × thickness). */
function wallCorners(w: DocWall): Array<{ x: number; y: number }> {
  const dx = w.b.x - w.a.x
  const dy = w.b.y - w.a.y
  const len = Math.hypot(dx, dy) || 1e-3
  const ux = dx / len
  const uy = dy / len
  const t = Math.max(w.thickness, 0.05) / 2
  const nx = -uy * t
  const ny = ux * t
  return [
    { x: w.a.x + nx, y: w.a.y + ny },
    { x: w.b.x + nx, y: w.b.y + ny },
    { x: w.b.x - nx, y: w.b.y - ny },
    { x: w.a.x - nx, y: w.a.y - ny },
  ]
}

/** Rotated footprint corners for a component (w × h, rotation θ about centre). */
function compCorners(c: DocComponent): Array<{ x: number; y: number }> {
  const cos = Math.cos(c.rotation)
  const sin = Math.sin(c.rotation)
  const hw = c.w / 2
  const hh = c.h / 2
  return (
    [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as const
  ).map(([lx, ly]) => ({ x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos }))
}

/** Reduce a document to vertical prisms. MeetingRoom (a translucent zone volume)
 *  and FallCeiling (a ceiling slab) are excluded — they'd occlude the storey. */
function prismsFromState(state: DocState): Prism[] {
  const out: Prism[] = []
  for (const w of state.walls) {
    out.push({ corners: wallCorners(w), y0: 0, y1: WALL_HEIGHT, kind: 'wall', color: DATUM })
  }
  for (const c of state.components) {
    if (c.category === 'MeetingRoom' || c.category === 'FallCeiling') continue
    const h = furnitureHeight(c.category)
    const color = catByCategory(c.category)?.color ?? '#8a929c'
    out.push({ corners: compCorners(c), y0: 0, y1: h, kind: 'furniture', color })
  }
  return out
}

// ── Cut classification + projection ──────────────────────────────────────────

/** Map a plan point to (u = horizontal drawing axis, d = depth/cut axis). */
function toUD(p: { x: number; y: number }, axis: 'x' | 'y'): { u: number; d: number } {
  return axis === 'y' ? { u: p.x, d: p.y } : { u: p.y, d: p.x }
}

type Class = 'cut' | 'beyond' | 'front'

interface Projected {
  uMin: number
  uMax: number
  y0: number
  y1: number
  cls: Class
  /** Signed depth past the cut (m, ≥0 for beyond); drives the fade. */
  depth: number
  kind: 'wall' | 'furniture'
  color: string
}

function project(prism: Prism, cut: SectionCut): Projected {
  let uMin = Infinity
  let uMax = -Infinity
  let dMin = Infinity
  let dMax = -Infinity
  for (const c of prism.corners) {
    const { u, d } = toUD(c, cut.axis)
    uMin = Math.min(uMin, u)
    uMax = Math.max(uMax, u)
    dMin = Math.min(dMin, d)
    dMax = Math.max(dMax, d)
  }
  // Signed distance along the look direction: >0 is beyond the cut.
  const relMin = (dMin - cut.position) * cut.look
  const relMax = (dMax - cut.position) * cut.look
  const lo = Math.min(relMin, relMax)
  const hi = Math.max(relMin, relMax)
  let cls: Class
  if (lo <= 0 && hi >= 0) cls = 'cut'
  else if (lo > 0) cls = 'beyond'
  else cls = 'front'
  const depth = Math.max(0, (lo + hi) / 2)
  return { uMin, uMax, y0: prism.y0, y1: prism.y1, cls, depth, kind: prism.kind, color: prism.color }
}

// ── Default cuts ─────────────────────────────────────────────────────────────

/** Longitudinal (cut across plan-Y at the building centre, looking down-plan) +
 *  cross (cut across plan-X at the centre). Two orthogonal storey sections. */
export function defaultCuts(state: DocState): SectionCut[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of state.walls) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  if (!isFinite(minX)) return []
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return [
    { axis: 'y', position: cy, look: 1, label: 'A' }, // longitudinal — sees plan-X length
    { axis: 'x', position: cx, look: 1, label: 'B' }, // cross — sees plan-Y depth
  ]
}

// ── Drawing area geometry ────────────────────────────────────────────────────

const PAD_L = 46 // left gutter for the height dimension
const PAD_R = 20
const PAD_T = 18
const PAD_B = 34 // bottom band for the section label

interface Layout {
  rectL: number
  rectR: number
  rectT: number
  rectB: number
  uMin: number
  uMax: number
  hTop: number
  k: number // px per metre (equal on both axes → true orthographic)
  floorY: number // canvas y of the floor datum (height 0)
  massX: number // left canvas x of the drawn massing
  massW: number
  massH: number
  toX: (u: number) => number
  toY: (y: number) => number
}

/** Compute the equal-scale world→canvas transform for a cut over the walls'
 *  full horizontal envelope, fitting the storey height + massing into the rect. */
function layout(state: DocState, cut: SectionCut, wPx: number, hPx: number): Layout {
  let uMin = Infinity
  let uMax = -Infinity
  for (const w of state.walls) {
    for (const p of [w.a, w.b]) {
      const { u } = toUD(p, cut.axis)
      uMin = Math.min(uMin, u)
      uMax = Math.max(uMax, u)
    }
  }
  if (!isFinite(uMin)) {
    uMin = 0
    uMax = 10
  }
  const uSpan = Math.max(uMax - uMin, 1)
  const hTop = WALL_HEIGHT + HEADROOM
  const rectL = PAD_L
  const rectR = wPx - PAD_R
  const rectT = PAD_T
  const rectB = hPx - PAD_B
  const availW = rectR - rectL
  const availH = rectB - rectT
  const k = Math.min(availW / uSpan, availH / hTop)
  const massW = uSpan * k
  const massH = hTop * k
  const massX = rectL + (availW - massW) / 2
  const floorY = rectB - (availH - massH) / 2 // storey vertically centred in rect
  const toX = (u: number) => massX + (u - uMin) * k
  const toY = (y: number) => floorY - y * k
  return { rectL, rectR, rectT, rectB, uMin, uMax, hTop, k, floorY, massX, massW, massH, toX, toY }
}

// ── WebGL massing (primary) ──────────────────────────────────────────────────

/** Render the beyond + cut solids through an OrthographicCamera to an offscreen
 *  canvas sized to the massing rect, reusing Viewer3D's meshes/heights. Returns
 *  null if no WebGL context is available (headless / blocked). */
function renderMassingWebGL(
  state: DocState,
  cut: SectionCut,
  L: Layout,
): HTMLCanvasElement | null {
  const massW = Math.max(2, Math.round(L.massW))
  const massH = Math.max(2, Math.round(L.massH))
  let renderer: THREE.WebGLRenderer
  try {
    const gl = document.createElement('canvas')
    renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, preserveDrawingBuffer: true })
  } catch {
    return null // no GL context → caller falls back to Canvas2D
  }
  try {
    renderer.setPixelRatio(1)
    renderer.setSize(massW, massH, false)
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene = new THREE.Scene()
    // Only OUR allocations are disposed. Furniture built by buildFurniture3D
    // shares furniture3d's module-level geometries/materials (also used by the
    // live Viewer3D) — never dispose those; the throwaway groups/meshes are GC'd.
    const box = new THREE.BoxGeometry(1, 1, 1)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.95, metalness: 0 })
    const wallCutMat = new THREE.MeshStandardMaterial({ color: 0x3b4149, roughness: 1, metalness: 0 })

    // Cull anything in front of the cut so the storey opens up; keep a hair past
    // the plane so cut walls read as solid faces.
    const nrm = new THREE.Vector3(cut.axis === 'x' ? cut.look : 0, 0, cut.axis === 'y' ? cut.look : 0)
    const plane = new THREE.Plane(nrm, -cut.position * cut.look + 0.02)
    renderer.clippingPlanes = [plane]
    renderer.localClippingEnabled = false

    for (const w of state.walls) {
      const dx = w.b.x - w.a.x
      const dz = w.b.y - w.a.y // plan Y → world Z
      const len = Math.hypot(dx, dz) || 1e-2
      const m = new THREE.Mesh(box, w.generated ? wallMat : wallCutMat)
      m.scale.set(len, WALL_HEIGHT, Math.max(w.thickness, 0.05))
      m.position.set((w.a.x + w.b.x) / 2, WALL_HEIGHT / 2, (w.a.y + w.b.y) / 2)
      m.rotation.y = -Math.atan2(dz, dx)
      scene.add(m)
    }
    for (const c of state.components) {
      if (c.category === 'MeetingRoom' || c.category === 'FallCeiling') continue
      const g = new THREE.Group()
      g.position.set(c.x, 0, c.y)
      g.rotation.y = -c.rotation
      const color = catByCategory(c.category)?.color
      const obj = buildFurniture3D(c.category, c.w, c.h, color ? { color } : {})
      g.add(obj)
      scene.add(g)
    }

    // Lighting: flat ambient + a soft key from the camera so faces read as clean
    // greys (a section is line-led, not photoreal).
    scene.add(new THREE.AmbientLight(0xffffff, 1.5))
    const key = new THREE.DirectionalLight(0xffffff, 1.1)
    key.position.copy(nrm).multiplyScalar(-40).add(new THREE.Vector3(6, 30, 6))
    scene.add(key)

    // OrthographicCamera aimed along the cut axis. Frustum = the exact world
    // window [uMin..uMax] × [0..hTop] the Canvas2D transform maps to the rect.
    const uSpan = L.uMax - L.uMin
    const centerU = (L.uMin + L.uMax) / 2
    const centerY = L.hTop / 2
    const cam = new THREE.OrthographicCamera(-uSpan / 2, uSpan / 2, L.hTop / 2, -L.hTop / 2, 0.01, 400)
    const back = 200
    if (cut.axis === 'y') {
      cam.position.set(centerU, centerY, cut.position - cut.look * back)
      cam.up.set(0, 1, 0)
      cam.lookAt(centerU, centerY, cut.position + cut.look)
    } else {
      cam.position.set(cut.position - cut.look * back, centerY, centerU)
      cam.up.set(0, 1, 0)
      cam.lookAt(cut.position + cut.look, centerY, centerU)
    }
    cam.updateProjectionMatrix()

    renderer.render(scene, cam)

    // Copy to a plain 2D canvas (the WebGL canvas is disposed with the renderer).
    const out = document.createElement('canvas')
    out.width = massW
    out.height = massH
    const octx = out.getContext('2d')
    if (!octx) return null
    octx.drawImage(renderer.domElement, 0, 0)

    box.dispose()
    wallMat.dispose()
    wallCutMat.dispose()
    renderer.dispose()
    return out
  } catch {
    renderer.dispose()
    return null
  }
}

// ── Canvas2D massing (fallback) ──────────────────────────────────────────────

/** Analytic projection of the beyond + cut solids to the rect: beyond elements
 *  are depth-faded silhouettes, cut walls solid poché. Always available. */
function renderMassingCanvas2D(ctx: CanvasRenderingContext2D, projected: Projected[], L: Layout): void {
  // Beyond, far→near, so nearer elements overdraw. Fills only — the crisp
  // elevation outlines are added by the (always-on) annotation layer, so this
  // reads identically whether the massing came from WebGL or here.
  const beyond = projected.filter((p) => p.cls === 'beyond').sort((a, b) => b.depth - a.depth)
  for (const p of beyond) {
    const x = L.toX(p.uMin)
    const w = Math.max(1, (p.uMax - p.uMin) * L.k)
    const yTop = L.toY(p.y1)
    const yBot = L.toY(p.y0)
    const fade = Math.min(1, p.depth / VIEW_DEPTH_FADE)
    // Grey lightens with depth; furniture a touch lighter than fabric.
    const base = p.kind === 'wall' ? 0.62 : 0.74
    const g = Math.round(255 * (base + (1 - base) * 0.85 * fade))
    ctx.fillStyle = `rgb(${g},${g},${g})`
    ctx.fillRect(x, yTop, w, yBot - yTop)
  }
}

// ── Annotation layer (always Canvas2D, both paths) ───────────────────────────

function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  projected: Projected[],
  L: Layout,
  cut: SectionCut,
  wPx: number,
): void {
  const floorY = L.toY(0)
  const ceilY = L.toY(CEILING_HEIGHT)
  const xL = L.massX
  const xR = L.massX + L.massW

  // Sky wash ABOVE the ceiling only (never over the storey — that would hide
  // the massing) + a thin ground band below the floor datum.
  ctx.fillStyle = SKY_WASH
  ctx.fillRect(L.rectL, L.rectT, L.rectR - L.rectL, Math.max(0, ceilY - L.rectT))
  ctx.fillStyle = GROUND
  ctx.globalAlpha = 0.14
  ctx.fillRect(xL, floorY, xR - xL, Math.min(14, L.rectB - floorY))
  ctx.globalAlpha = 1

  // Beyond elements in elevation — crisp light outlines, depth-faded. Always
  // drawn (both paths) so furniture past the cut reads as line-work even where
  // the WebGL massing shades it faintly.
  for (const p of projected) {
    if (p.cls !== 'beyond') continue
    const x = L.toX(p.uMin)
    const w = Math.max(1, (p.uMax - p.uMin) * L.k)
    const yTop = L.toY(p.y1)
    const yBot = L.toY(p.y0)
    const fade = Math.min(1, p.depth / VIEW_DEPTH_FADE)
    ctx.strokeStyle = `rgba(58,64,72,${0.55 - 0.4 * fade})`
    ctx.lineWidth = p.kind === 'wall' ? 1 : 0.8
    ctx.strokeRect(x + 0.4, yTop + 0.4, w - 0.8, yBot - yTop - 0.8)
  }

  // Cut-wall poché — solid, drawn ON TOP so the storey's structure reads.
  ctx.fillStyle = POCHE
  for (const p of projected) {
    if (p.cls !== 'cut' || p.kind !== 'wall') continue
    const x = L.toX(p.uMin)
    const w = Math.max(2, (p.uMax - p.uMin) * L.k)
    ctx.fillRect(x, L.toY(p.y1), w, L.toY(p.y0) - L.toY(p.y1))
  }

  // Floor + ceiling datum lines.
  ctx.strokeStyle = DATUM
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.moveTo(xL, floorY)
  ctx.lineTo(xR, floorY)
  ctx.stroke()
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(xL, ceilY)
  ctx.lineTo(xR, ceilY)
  ctx.stroke()
  ctx.setLineDash([])

  // Height dimension string (left gutter): floor 0.00 → ceiling +2.60.
  const dimX = L.massX - 14
  ctx.strokeStyle = DIM_INK
  ctx.lineWidth = 0.8
  const tick = (y: number) => {
    ctx.beginPath()
    ctx.moveTo(dimX - 4, y)
    ctx.lineTo(dimX + 4, y)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(dimX, floorY)
  ctx.lineTo(dimX, ceilY)
  ctx.stroke()
  tick(floorY)
  tick(ceilY)
  ctx.save()
  ctx.translate(dimX - 8, (floorY + ceilY) / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillStyle = DIM_INK
  ctx.font = `600 11px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(`${CEILING_HEIGHT.toFixed(2)} m`, 0, 0)
  ctx.restore()

  // Level tags at the right edge.
  ctx.font = `600 10px ${MONO}`
  ctx.fillStyle = DIM_INK
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText('F.F.L  ±0.00', xR, floorY - 3)
  ctx.textBaseline = 'top'
  ctx.fillText(`C.L  +${CEILING_HEIGHT.toFixed(2)}`, xR, ceilY + 3)

  // Human scale figure (1.7 m) — placed by SCREEN fraction so it never depends
  // on which massing path (and its handedness) ran. A standing silhouette.
  drawScaleFigure(ctx, L.massX + L.massW * 0.28, floorY, 1.7 * L.k)
  drawSeatedFigure(ctx, L.massX + L.massW * 0.62, floorY, L.k)

  // Section label, bottom band.
  ctx.fillStyle = INK
  ctx.font = `700 13px ${UI}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const ly = L.rectB + PAD_B / 2
  ctx.fillText(`SECTION ${cut.label}-${cut.label}`, L.rectL, ly)
  ctx.textAlign = 'right'
  ctx.font = `400 10px ${MONO}`
  ctx.fillStyle = DIM_INK
  ctx.fillText(cut.axis === 'y' ? 'LONGITUDINAL' : 'CROSS', wPx - PAD_R, ly)
}

/** A minimal standing person silhouette, feet at (x, floorY), `h` px tall. */
function drawScaleFigure(ctx: CanvasRenderingContext2D, x: number, floorY: number, h: number): void {
  const headR = h * 0.075
  const shoulderY = floorY - h + headR * 2.4
  ctx.save()
  ctx.fillStyle = FIGURE
  ctx.globalAlpha = 0.85
  // head
  ctx.beginPath()
  ctx.arc(x, floorY - h + headR, headR, 0, Math.PI * 2)
  ctx.fill()
  // body: tapered torso + legs as a single rounded column
  const bw = h * 0.11
  ctx.beginPath()
  ctx.moveTo(x - bw, shoulderY)
  ctx.lineTo(x + bw, shoulderY)
  ctx.lineTo(x + bw * 0.7, floorY)
  ctx.lineTo(x - bw * 0.7, floorY)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** A seated person silhouette (≈1.2 m seated), feet at (x, floorY). */
function drawSeatedFigure(ctx: CanvasRenderingContext2D, x: number, floorY: number, k: number): void {
  const headR = 0.11 * k
  const seatY = floorY - 0.45 * k
  ctx.save()
  ctx.fillStyle = FIGURE
  ctx.globalAlpha = 0.8
  ctx.beginPath()
  ctx.arc(x, floorY - 1.2 * k + headR, headR, 0, Math.PI * 2)
  ctx.fill()
  const bw = 0.09 * k
  // torso down to the seat
  ctx.fillRect(x - bw, floorY - 1.2 * k + headR, bw * 2, 1.2 * k - headR - 0.45 * k)
  // thigh out to the knees
  ctx.fillRect(x - bw, seatY, bw + 0.4 * k, bw * 1.4)
  // shin down to the floor
  ctx.fillRect(x + 0.4 * k - bw, seatY, bw * 1.6, 0.45 * k)
  ctx.restore()
}

// ── Entry ────────────────────────────────────────────────────────────────────

/**
 * Render one section cut to a `wPx × hPx` canvas. Tries the WebGL massing first
 * (unless `forceCanvas2D`), falling back to the analytic Canvas2D projection so
 * it never hard-fails. The annotation layer (datum, poché, dims, tags, scale
 * figures, label) is drawn on top in both paths.
 */
export function renderSection(
  state: DocState,
  cut: SectionCut,
  wPx: number,
  hPx: number,
  opts: SectionOpts = {},
): SectionRender {
  const canvas = document.createElement('canvas')
  canvas.width = wPx
  canvas.height = hPx
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, wPx, hPx)

  const L = layout(state, cut, wPx, hPx)
  const projected = prismsFromState(state).map((p) => project(p, cut))

  let path: SectionRender['path'] = 'canvas2d'
  const webgl = opts.forceCanvas2D ? null : renderMassingWebGL(state, cut, L)
  if (webgl) {
    path = 'webgl'
    // Composite the shaded massing at the storey rect. The ortho camera views
    // along +look, which mirrors the horizontal axis for a 'y' cut (looking +Z
    // with +Y up flips world X); flip it back so +u runs rightward, matching the
    // Canvas2D transform the annotation layer uses.
    const flip = cut.axis === 'y'
    ctx.save()
    if (flip) {
      ctx.translate(L.massX + L.massW, L.floorY - L.massH)
      ctx.scale(-1, 1)
      ctx.drawImage(webgl, 0, 0, L.massW, L.massH)
    } else {
      ctx.drawImage(webgl, L.massX, L.floorY - L.massH, L.massW, L.massH)
    }
    ctx.restore()
  } else {
    renderMassingCanvas2D(ctx, projected, L)
  }

  drawAnnotations(ctx, projected, L, cut, wPx)
  return { canvas, path, metersPerPx: L.k > 0 ? 1 / L.k : 0, cut }
}
