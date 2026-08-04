import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { DocState, DocComponent, DocZone } from '../editor/EditorCanvas'
import { MATERIALS } from '../export/qbiqPalette'
import { FINISH_SPEC, finishTypeFor, type FinishKey } from '../export/finishSchedule'
import { classifyWalls, type WallSpan, type WallType } from '../export/wallTypes'
import { buildFurniture3D, TEXTURES } from './furniture3d'
import { WALL_HEIGHT, CEILING_HEIGHT } from './Viewer3D'
import { zoneRings, zoneBBox, zoneCenter, pointInZoneShape } from '../util/zoneGeom'
import { platePolygonFromWalls, type Pt } from '../util/clip'

/**
 * THE SHARED MATERIAL THEME — one look for every 3D deliverable.
 *
 *   docs/reference/qbiq/spec/palette.json
 *        └─► export/qbiqPalette.ts (MATERIALS)  ─► this module ─► { room renders (D),
 *                                                    walkthrough video (E), web viewer (F) }
 *
 * Nothing here transcribes a hex. `MATERIALS` is `palette.json`'s own `materials`
 * block, imported straight from the JSON, so the render tier, the walkthrough and
 * the shared web viewer cannot drift from each other or from the spec.
 *
 * ── The anti-drift rule (gate G6) ──────────────────────────────────────────
 * A room's FLOOR material is not an art direction choice: it is derived from
 * {@link FINISH_SPEC} / {@link finishTypeFor} — the very same table the workbook's
 * Inventory sheet bills from (see `export/finishSchedule.ts`). `floorKeyForZone`
 * maps a zone to one of the qbiq vocabulary's TWO floor materials, and
 * {@link floorMaterialNameForZone} returns the exact Inventory material name. A
 * render therefore cannot show timber where the takeoff sold carpet.
 *
 * ── What E and F consume ───────────────────────────────────────────────────
 *   const scene = buildInteriorScene(state)          // one THREE.Group
 *   viewer.setContent(scene.root)                    // existing Viewer3D API
 *   scene.dispose()                                  // when replaced
 * plus {@link createInteriorLighting} (sun + ambient + luminaire fill) and
 * {@link interiorEnvironment} (the IBL). There is exactly one scene builder;
 * the still renderer (`three/interiorStill.ts`) adds only a camera and a
 * composer on top of it.
 *
 * Coordinate mapping mirrors `Viewer3D`: plan X → world X, plan Y → world Z,
 * height → world +Y, plan rotation θ → −θ about +Y.
 */

// ── Palette-derived colour helpers ───────────────────────────────────────────

/** The ten material families `palette.json` measures off the reference renders. */
export type QbiqMaterialKey = keyof typeof MATERIALS

/** The qbiq Inventory vocabulary carries exactly two floor materials. */
export type FloorMaterialKey = 'herringbone_parquet' | 'light_gray_carpet'

const hex = (k: QbiqMaterialKey): number => new THREE.Color(MATERIALS[k].hex).getHex()

/**
 * `palette.materials.*.hex` values are AS-RENDERED medians sampled off the
 * reference stills (see the spec's `$comment`), i.e. albedo × the reference's
 * warm key light. Feeding them back in as albedo under our own warm key would
 * double-count that light, so each material's albedo is the measured colour
 * divided by the tier's mean light gain. Tuned once against G6's floor-pixel
 * check — the rendered floor lands mid-band, not scraped past the edge.
 */
const LIGHT_GAIN = 1.55

function toAlbedo(source: string, gain: number): THREE.Color {
  const c = new THREE.Color(source)
  c.convertSRGBToLinear()
  c.multiplyScalar(1 / gain)
  c.convertLinearToSRGB()
  return c
}

/**
 * ACES tone mapping compresses and warms dark, saturated browns: the parquet
 * measured at H≈21 as albedo came back out of the renderer at H≈33, just past
 * the top of its own measured band (15–32). Its albedo is therefore pre-rotated
 * by the measured offset so the RENDERED floor lands where `palette.json` says
 * that material lands. No other family's band is tight enough to need it.
 */
/**
 * Chroma boost applied to an albedo, in sRGB space.
 *
 * The interior IBL is a neutral light box and three has no bounce GI, so a
 * matte floor away from the sun is lit almost entirely by achromatic ambient
 * and renders far flatter than its swatch: the reception's parquet measured
 * S 0.10 against `palette.json`'s own 0.18–0.48 band for that material. The
 * albedo is therefore pre-saturated so the RENDERED floor lands where the
 * palette says the material lands — the same calibration logic as
 * {@link LIGHT_GAIN}, on the other axis.
 */
const SAT_BOOST: Partial<Record<QbiqMaterialKey, number>> = {
  herringbone_parquet: 1.4,
}

/** Hue rotation (deg) applied to an albedo, same calibration idea as
 *  {@link SAT_BOOST}: the residual specular and the tone curve together drag
 *  the dark parquet ~8° redder than its albedo, off the bottom of its measured
 *  15–32 band, so the albedo is pre-rotated by the measured offset. */
const HUE_TRIM_DEG: Partial<Record<QbiqMaterialKey, number>> = {
  herringbone_parquet: 10,
}

/** Albedo from a family's measured median, calibrated so the RENDERED surface
 *  lands inside that family's own measured hue/saturation/luminance band. */
function albedo(k: QbiqMaterialKey, gain = LIGHT_GAIN): THREE.Color {
  const c = toAlbedo(MATERIALS[k].hex, gain)
  const boost = SAT_BOOST[k]
  const trim = HUE_TRIM_DEG[k]
  if (boost || trim) {
    const hsl = { h: 0, s: 0, l: 0 }
    c.getHSL(hsl, THREE.SRGBColorSpace)
    c.setHSL(
      ((hsl.h + (trim ?? 0) / 360) % 1 + 1) % 1,
      Math.min(1, hsl.s * (boost ?? 1)),
      hsl.l,
      THREE.SRGBColorSpace,
    )
  }
  return c
}

/** Albedo from the LIGHT end of a family's measured range. Used where the
 *  physical material is white and the median only looks warm because it was
 *  sampled in shadow — `ceiling_white`'s own note says exactly that
 *  ("Physically white; renders warm-off-white under the 3000K key"). */
function albedoLight(k: QbiqMaterialKey, gain = LIGHT_GAIN): THREE.Color {
  return toAlbedo(MATERIALS[k].range[1], gain)
}

/** Inventory ("General" sheet) material name for each floor family — the
 *  palette's own field, so the workbook and the renders name it identically. */
export const FLOOR_MATERIAL_NAME: Record<FloorMaterialKey, string> = {
  herringbone_parquet: MATERIALS.herringbone_parquet.inventoryMaterialName,
  light_gray_carpet: MATERIALS.light_gray_carpet.inventoryMaterialName,
}

/**
 * Collapse a {@link FinishKey}'s India-market floor spec onto the qbiq floor
 * vocabulary: anything soft is carpet, every hard floor (stone, timber, vinyl,
 * tile, screed) is the dark herringbone parquet. Derived from `FINISH_SPEC` at
 * call time — edit the finish schedule and the renders follow automatically.
 *
 * The split also matches `palette.json`'s own `usedFor` notes: parquet for
 * "circulation spines, reception, open-space and lounge floors", carpet for
 * "conference rooms, offices, focus rooms, workstation zones".
 */
export function floorKeyForFinish(k: FinishKey): FloorMaterialKey {
  return /carpet/i.test(FINISH_SPEC[k].floor) ? 'light_gray_carpet' : 'herringbone_parquet'
}

/** The floor family a zone renders — same derivation the Inventory row uses. */
export function floorKeyForZone(z: DocZone): FloorMaterialKey {
  return floorKeyForFinish(finishTypeFor(z))
}

/** The Inventory floor-material NAME for a zone (`'Carpet Light Gray'`, …). */
export function floorMaterialNameForZone(z: DocZone): string {
  return FLOOR_MATERIAL_NAME[floorKeyForZone(z)]
}

// ── Procedural texture kit (module scope, shared, no network assets) ─────────
// Mirrors `furniture3d.ts`'s kit — canvas-drawn once, reused by every material.

const TEX_SIZE = 512

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeTex(
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
  opts: { srgb?: boolean; size?: number } = {},
): THREE.CanvasTexture {
  const s = opts.size ?? TEX_SIZE
  const c = document.createElement('canvas')
  c.width = c.height = s
  draw(c.getContext('2d')!, s)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * Parquet block weave: four bands per tile, each band fully covered by planks
 * that alternate orientation band-to-band. Seamless by construction (every band
 * spans the full tile width and the band heights divide the tile), so it tiles
 * a 40 m floor without a visible repeat seam — and the material rotates its UVs
 * 45° so it reads as the reference's herringbone run.
 *
 * `tone` maps [base, lightPlank, darkPlank, joint]; the same routine draws the
 * colour map and the derived roughness map so grain and gloss stay registered.
 */
function drawParquet(ctx: CanvasRenderingContext2D, s: number, tone: [string, string, string, string]) {
  const rnd = mulberry32(0x9a7d5c)
  const [base, light, dark, joint] = tone
  ctx.fillStyle = base
  ctx.fillRect(0, 0, s, s)
  const bands = 4
  const bh = s / bands // band height == plank width
  const plank = bh * 2 // plank length (2:1)
  for (let b = 0; b < bands; b++) {
    const y = b * bh
    const vertical = b % 2 === 1
    if (vertical) {
      // Band of upright planks, one plank-width wide each.
      for (let x = 0; x < s; x += bh) {
        ctx.fillStyle = rnd() < 0.5 ? light : dark
        ctx.globalAlpha = 0.55 + rnd() * 0.45
        ctx.fillRect(x, y, bh, bh)
        ctx.globalAlpha = 1
        ctx.strokeStyle = joint
        ctx.lineWidth = 1.2
        ctx.strokeRect(x + 0.6, y + 0.6, bh - 1.2, bh - 1.2)
      }
    } else {
      for (let x = 0; x < s; x += plank) {
        ctx.fillStyle = rnd() < 0.5 ? light : dark
        ctx.globalAlpha = 0.55 + rnd() * 0.45
        ctx.fillRect(x, y, plank, bh)
        ctx.globalAlpha = 1
        ctx.strokeStyle = joint
        ctx.lineWidth = 1.2
        ctx.strokeRect(x + 0.6, y + 0.6, plank - 1.2, bh - 1.2)
      }
    }
  }
  // Fine lengthwise grain over the whole tile.
  ctx.globalAlpha = 0.16
  ctx.strokeStyle = joint
  ctx.lineWidth = 0.6
  for (let i = 0; i < 160; i++) {
    const y = rnd() * s
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(s, y + (rnd() - 0.5) * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Dot-matrix perforation — the bronze screen's alpha + roughness signature. */
function drawPerforation(ctx: CanvasRenderingContext2D, s: number, on: string, off: string) {
  ctx.fillStyle = on
  ctx.fillRect(0, 0, s, s)
  const cells = 16
  const step = s / cells
  ctx.fillStyle = off
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      ctx.beginPath()
      ctx.arc((i + 0.5) * step, (j + 0.5) * step, step * 0.29, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/** Vertical timber slats — the reference's tall fluted screens and desk fronts. */
function drawSlats(ctx: CanvasRenderingContext2D, s: number, light: string, dark: string, gap: string) {
  const n = 16
  const w = s / n
  for (let i = 0; i < n; i++) {
    const g = ctx.createLinearGradient(i * w, 0, (i + 1) * w, 0)
    g.addColorStop(0, dark)
    g.addColorStop(0.35, light)
    g.addColorStop(0.75, light)
    g.addColorStop(1, dark)
    ctx.fillStyle = g
    ctx.fillRect(i * w, 0, w, s)
    ctx.fillStyle = gap
    ctx.fillRect((i + 1) * w - w * 0.13, 0, w * 0.13, s)
  }
}

// The parquet colour map is drawn in near-neutral tones, NOT in wood browns.
// A brown map multiplies its own hue into the result and then dominates it —
// rotating the material's albedo by 10° moved the rendered floor by half a
// degree, because the map was doing the talking. Keeping the map to luminance
// variation (plank tone, joints, grain) leaves hue and chroma entirely to the
// calibrated albedo, which is the value derived from `palette.json`.
const THEME_TEX = {
  parquet: makeTex((c, s) => drawParquet(c, s, ['#c9c1b9', '#ddd6ce', '#a79d94', '#6b6058']), { srgb: true }),
  parquetRough: makeTex((c, s) => drawParquet(c, s, ['#b6b6b6', '#c8c8c8', '#9c9c9c', '#6e6e6e'])),
  perfAlpha: makeTex((c, s) => drawPerforation(c, s, '#ffffff', '#101010'), { size: 256 }),
  slat: makeTex((c, s) => drawSlats(c, s, '#d9bb95', '#a87f56', '#4a3628'), { srgb: true, size: 256 }),
  slatBump: makeTex((c, s) => drawSlats(c, s, '#e8e8e8', '#8a8a8a', '#242424'), { size: 256 }),
} as const

// ── The theme ────────────────────────────────────────────────────────────────

/**
 * Every material the interior scene needs, built once per scene and disposed
 * together. Keys are the `palette.json` material families plus the fabric
 * (partitions, mullions) those families dress.
 */
export interface MaterialTheme {
  floors: Record<FloorMaterialKey, THREE.MeshStandardMaterial>
  /** Painted plasterboard partition (the neutral the palette's accents sit on). */
  wall: THREE.MeshStandardMaterial
  /** Heavier exterior/plate fabric. */
  wallExterior: THREE.MeshStandardMaterial
  /** `sage_green_feature_wall` — reception backdrop, pod walls, column drums. */
  feature: THREE.MeshStandardMaterial
  /** `perforated_bronze_screen` — library backs, room dividers. */
  screen: THREE.MeshStandardMaterial
  /** `white_oak_furniture` — desks, counters, casework. */
  oak: THREE.MeshStandardMaterial
  /** Fluted white-oak slat screen (the reference's tall vertical battens). */
  slat: THREE.MeshStandardMaterial
  /** `upholstery_charcoal` — tub chairs, task seating, ottomans. */
  upholstery: THREE.MeshStandardMaterial
  /** `black_ring_luminaire` — ring/frame fixtures, pendant stems, chair bases. */
  luminaire: THREE.MeshStandardMaterial
  /** The light-emitting face of a fixture (unlit, blooms under tone mapping). */
  emissive: THREE.MeshBasicMaterial
  /** `ceiling_white` plasterboard soffit. */
  ceiling: THREE.MeshStandardMaterial
  /** `black_exposed_ceiling` open-plenum slab. */
  ceilingExposed: THREE.MeshStandardMaterial
  /** `glass_partition` — near-clear full-height glazing. */
  glass: THREE.MeshPhysicalMaterial
  /** Slim white-painted mullion caps on the ~1.2 m glazing module. */
  mullion: THREE.MeshStandardMaterial
  /** Exterior landscape seen through the perimeter glazing. */
  exterior: THREE.MeshStandardMaterial
  /** Accent colour (hex) handed to `buildFurniture3D` per furniture kind. */
  furnitureAccent: (category: string) => number
  dispose(): void
}

/** Build the shared theme. One per scene; call {@link MaterialTheme.dispose}. */
export function createMaterialTheme(): MaterialTheme {
  const parquet = THEME_TEX.parquet.clone()
  parquet.needsUpdate = true
  parquet.center.set(0.5, 0.5)
  parquet.rotation = Math.PI / 4 // the herringbone run, not the block weave
  parquet.repeat.set(2.2, 2.2) // one tile ≈ 0.45 m → ~0.11 m planks
  const parquetRough = THEME_TEX.parquetRough.clone()
  parquetRough.needsUpdate = true
  parquetRough.center.set(0.5, 0.5)
  parquetRough.rotation = Math.PI / 4
  parquetRough.repeat.set(2.2, 2.2)
  const carpet = TEXTURES.carpet.clone()
  carpet.needsUpdate = true
  carpet.repeat.set(1.6, 1.6)

  const floors: Record<FloorMaterialKey, THREE.MeshStandardMaterial> = {
    herringbone_parquet: new THREE.MeshStandardMaterial({
      color: albedo('herringbone_parquet', 2.2),
      map: parquet,
      roughnessMap: parquetRough,
      // Matte oiled parquet, and almost no environment reflection.
      //
      // This is the single most load-bearing tuning in the theme. At roughness
      // 0.42 / envMapIntensity 0.45 the floor mirrored the (bright) interior
      // IBL hard enough to bury its own colour: a controlled test with a PURE
      // RED albedo rendered #994A4A — equal green and blue lifted to 74/255 by
      // an achromatic specular term that no diffuse colour can produce. The
      // real parquet came back at S 0.10 against `palette.json`'s own 0.18–0.48
      // band for that exact material. Killing the specular restored the red
      // test to #7C211F (S 0.60) and the parquet to its measured family.
      roughness: 0.95,
      envMapIntensity: 0.06,
      metalness: 0.0,
    }),
    light_gray_carpet: new THREE.MeshStandardMaterial({
      color: albedo('light_gray_carpet', 1.35),
      map: carpet,
      roughness: 0.96,
      metalness: 0.0,
    }),
  }

  // Wall boxes carry 0..1 UVs per face, so these repeats set the visual module
  // (≈5 slat bays / ≈4 perforation tiles across a partition, 3 up its height).
  const slatMap = THEME_TEX.slat.clone()
  slatMap.needsUpdate = true
  slatMap.repeat.set(5, 1)
  const slatBump = THEME_TEX.slatBump.clone()
  slatBump.needsUpdate = true
  slatBump.repeat.set(5, 1)
  const perf = THEME_TEX.perfAlpha.clone()
  perf.needsUpdate = true
  perf.repeat.set(4, 3)

  const theme: MaterialTheme = {
    floors,
    wall: new THREE.MeshStandardMaterial({
      color: albedoLight('ceiling_white', 1.32),
      roughness: 0.94,
      roughnessMap: TEXTURES.plasterRough,
      metalness: 0,
    }),
    wallExterior: new THREE.MeshStandardMaterial({
      color: albedoLight('ceiling_white', 1.5),
      roughness: 0.9,
      roughnessMap: TEXTURES.plasterRough,
      metalness: 0,
    }),
    feature: new THREE.MeshStandardMaterial({
      color: albedo('sage_green_feature_wall'),
      roughness: 0.82,
      roughnessMap: TEXTURES.plasterRough,
      metalness: 0,
    }),
    // Bronze-anodised sheet with the perforation punched out as real holes
    // (alpha map, not a printed dot pattern) so backlight reads through it.
    screen: new THREE.MeshStandardMaterial({
      color: albedo('perforated_bronze_screen', 1.0), // already near-black; no gain divide
      alphaMap: perf,
      transparent: true,
      alphaTest: 0.5,
      roughness: 0.5,
      metalness: 0.55,
      side: THREE.DoubleSide,
    }),
    oak: new THREE.MeshStandardMaterial({
      color: albedo('white_oak_furniture'),
      map: TEXTURES.wood,
      roughnessMap: TEXTURES.woodRough,
      roughness: 0.55,
      metalness: 0.02,
    }),
    slat: new THREE.MeshStandardMaterial({
      color: albedo('white_oak_furniture'),
      map: slatMap,
      bumpMap: slatBump,
      bumpScale: 0.01,
      roughness: 0.6,
      metalness: 0.02,
    }),
    upholstery: new THREE.MeshStandardMaterial({
      color: albedo('upholstery_charcoal', 1.0),
      map: TEXTURES.fabric,
      bumpMap: TEXTURES.fabricBump,
      bumpScale: 0.012,
      roughness: 0.92,
      metalness: 0,
    }),
    luminaire: new THREE.MeshStandardMaterial({
      color: albedo('black_ring_luminaire', 1.0),
      roughness: 0.45,
      metalness: 0.35,
    }),
    emissive: new THREE.MeshBasicMaterial({ color: 0xfff1dc }),
    ceiling: new THREE.MeshStandardMaterial({
      color: albedoLight('ceiling_white', 1.28),
      roughness: 0.95,
      roughnessMap: TEXTURES.plasterRough,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    ceilingExposed: new THREE.MeshStandardMaterial({
      color: albedo('black_exposed_ceiling', 1.0),
      roughness: 0.95,
      metalness: 0.05,
      side: THREE.DoubleSide,
    }),
    // `glass_partition.hex` (#D5C6AF) is what the reference's CAMERA saw THROUGH
    // the glazing — room behind it included — not the glass's own tint. Using it
    // as the pane colour tints everything twice: it turned the reception's
    // parquet, sampled through the glass wall, a good 10° warmer than the floor
    // actually is. The palette's own note ("the glass itself is near-clear with
    // a faint warm reflection") points at the light end of the range instead.
    // ALPHA glass, not `transmission`. Three renders transmission by sampling a
    // half-resolution, roughness-blurred copy of the scene, so a floor seen
    // THROUGH a glazed wall comes back washed and desaturated — it measured
    // L 0.56 / S 0.10 for a floor that is L 0.35 / S 0.22 in the open. That is a
    // material lie in a deliverable whose whole point is that the render and the
    // takeoff agree, and it is the same reason `Viewer3D` glazes partitions with
    // cheap transparency. The pane still reflects the room via the environment.
    glass: new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(MATERIALS.glass_partition.range[1]),
      // Optically weak on purpose. A meeting room 5 m across cannot be framed
      // from inside itself at eye height, so the reference — and this renderer —
      // shoot it from the corridor THROUGH its glazed wall. Every pixel of that
      // room's floor then arrives via this material, so its tint and its
      // reflection are a direct source of render-vs-takeoff drift. It still
      // reads as glass: mullion frame, grazing-angle reflections, a faint tint.
      roughness: 0.35,
      metalness: 0,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
      // No specular lobe and no environment reflection. A smooth pane reflecting
      // a bright interior IBL adds a large, neutral, view-dependent term to
      // every pixel behind it: the reception's parquet, sampled through its
      // glazed wall, came back H 20 / S 0.06 / L 0.61 for a floor that is
      // H 22 / S 0.23 / L 0.28 in the open. Sparkle is not worth a material lie.
      specularIntensity: 0.25,
      envMapIntensity: 0.3,
      side: THREE.DoubleSide,
    }),
    mullion: new THREE.MeshStandardMaterial({
      color: new THREE.Color(MATERIALS.glass_partition.mullionHex),
      roughness: 0.5,
      metalness: 0.1,
    }),
    exterior: new THREE.MeshStandardMaterial({ color: 0x7d8f63, roughness: 1, metalness: 0 }),
    furnitureAccent: (category: string): number => {
      const s = category.toLowerCase()
      if (/chair|seat|task|stool|lounge|sofa|tub|ottoman|bench/.test(s)) return hex('upholstery_charcoal')
      if (/desk|table|cabinet|storage|credenza|counter|worktop|shelf/.test(s)) return hex('white_oak_furniture')
      if (/partition|screen|divider|panel/.test(s)) return hex('perforated_bronze_screen')
      if (/planter|plant/.test(s)) return hex('sage_green_feature_wall')
      return hex('white_oak_furniture')
    },
    dispose(): void {
      for (const m of [
        floors.herringbone_parquet,
        floors.light_gray_carpet,
        theme.wall,
        theme.wallExterior,
        theme.feature,
        theme.screen,
        theme.oak,
        theme.slat,
        theme.upholstery,
        theme.luminaire,
        theme.emissive,
        theme.ceiling,
        theme.ceilingExposed,
        theme.glass,
        theme.mullion,
        theme.exterior,
      ]) {
        m.dispose()
      }
      parquet.dispose()
      parquetRough.dispose()
      carpet.dispose()
      slatMap.dispose()
      slatBump.dispose()
      perf.dispose()
    },
  }
  return theme
}

// ── Interior scene ───────────────────────────────────────────────────────────

/** One rendered room, resolved: geometry, its Inventory floor material, and the
 *  point a camera should look at. */
export interface InteriorRoom {
  zone: DocZone
  finishKey: FinishKey
  floorKey: FloorMaterialKey
  /** The Inventory ("General" sheet) material name — G6 cross-checks this. */
  floorMaterialName: string
  /** Area-weighted centre of the zone (plan m). */
  center: { x: number; y: number }
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
  /** Centroid of the furniture actually in the room, else the zone centre. */
  focus: { x: number; y: number }
  components: DocComponent[]
  /** Midpoint of the room's accent wall (sage backdrop, oak slats, bronze
   *  screen), when it has one. A hero still should be facing it — that surface
   *  is the room's identity, and a camera with its back to it produces a
   *  photograph of blank plasterboard. */
  accentWall?: { x: number; y: number }
}

export interface InteriorSceneOpts {
  /** Reuse an existing theme (E/F share one across scene rebuilds). */
  theme?: MaterialTheme
  /** Typed wall runs. Defaults to `classifyWalls(state)` — the same classifier
   *  the 2D plan draws from, so plan and render show the same fabric. */
  wallSpans?: WallSpan[]
  /** Floor-plate polygon (`Editor.plate_polygon()`); traced from the walls if absent. */
  plate?: Pt[] | null
  /** Draw the perimeter shell as a curtain-wall band above 0.9 m. Default true
   *  — see the note on {@link buildInteriorScene}. */
  perimeterGlazing?: boolean
  /** Suspended ceiling + recessed downlights. Default true. */
  ceiling?: boolean
  /** Feature luminaires (reception rings, open-plan frames, desk pendants). */
  luminaires?: boolean
  /** Exterior ground + horizon seen through the glazing. Default true. */
  exterior?: boolean
}

export interface InteriorScene {
  /** Drop straight into `Viewer3D.setContent(root)`. */
  root: THREE.Group
  theme: MaterialTheme
  /** Floor plates only — the still renderer masks these to locate floor pixels. */
  floors: THREE.Group
  rooms: InteriorRoom[]
  /** The floor-plate ring the scene was built on — a camera outside it is
   *  outside the building, which is how the still renderer rejects one. */
  plate: Pt[] | null
  bounds: THREE.Box3
  /** Frees geometry created here (and the theme, unless one was passed in). */
  dispose(): void
}

const SILL_H = 0.9 // curtain-wall spandrel height (m)
const DOOR_H = 2.1
const HALF_WALL_H = 1.2
const GLAZING_MODULE = 1.2 // mullion spacing (m), per palette.glass_partition
/** Recessed-downlight grid (m). The drawn fixtures AND the lights that stand in
 *  for them share this, so the render is lit by the ceiling it shows. */
const DOWNLIGHT_SPACING = 2.4

/** Furniture that is fabric, not loose furniture — never re-placed by the scene. */
const SKIP_CATEGORIES = new Set(['MeetingRoom', 'FallCeiling', 'Window'])

function ringToShape(ring: Pt[], holes: Pt[][] = []): THREE.Shape {
  const s = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)))
  for (const h of holes) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))))
  return s
}

/** Lay a plan-space `Shape` flat at height `y` (plan Y → world Z), normal UP. */
function flatPlate(shape: THREE.Shape, mat: THREE.Material, y: number): THREE.Mesh {
  const geo = new THREE.ShapeGeometry(shape)
  // The shape lives in XY; rotating +90° about X maps plan Y → world Z exactly,
  // but leaves the face normal pointing DOWN — so reverse the winding and
  // recompute, giving a floor that faces the room.
  geo.rotateX(Math.PI / 2)
  const idx = geo.getIndex()
  if (idx) {
    const a = idx.array as unknown as number[]
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i]
      a[i] = a[i + 2]
      a[i + 2] = t
    }
    idx.needsUpdate = true
  }
  geo.computeVertexNormals()
  // UVs in plan METRES (ShapeGeometry seeds them from the vertex XY), so a
  // material's `repeat` is a real-world tile size and floors tile consistently
  // across rooms instead of stretching with each plate's size.
  const uv = geo.getAttribute('uv')
  const pos = geo.getAttribute('position')
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), -pos.getZ(i))
  uv.needsUpdate = true
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = y
  mesh.receiveShadow = true
  return mesh
}

interface Opening {
  /** Distance along the span from its a-end (m). */
  t: number
  halfWidth: number
}

/** Doors that pierce a span, projected onto it. */
function openingsFor(span: WallSpan, doors: DocComponent[]): Opening[] {
  const dx = span.bx - span.ax
  const dy = span.by - span.ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-3) return []
  const ux = dx / len
  const uy = dy / len
  const out: Opening[] = []
  for (const d of doors) {
    const px = d.x - span.ax
    const py = d.y - span.ay
    const t = px * ux + py * uy
    const perp = Math.abs(px * -uy + py * ux)
    if (perp > span.thickness / 2 + 0.35) continue
    if (t < -0.2 || t > len + 0.2) continue
    // The door symbol's long axis is its leaf width.
    const leaf = Math.max(d.w, d.h)
    out.push({ t, halfWidth: Math.max(0.4, leaf / 2) + 0.03 })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Solid sub-runs of `[0, len]` left once the openings are cut out. */
function solidRuns(len: number, openings: Opening[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let cursor = 0
  for (const o of openings) {
    const a = Math.max(0, o.t - o.halfWidth)
    const b = Math.min(len, o.t + o.halfWidth)
    if (a > cursor + 0.05) runs.push([cursor, a])
    cursor = Math.max(cursor, b)
  }
  if (cursor < len - 0.05) runs.push([cursor, len])
  return runs
}

/** One box of fabric along a span, from `t0..t1` and `y0..y1`. */
function spanBox(
  span: WallSpan,
  t0: number,
  t1: number,
  y0: number,
  y1: number,
  mat: THREE.Material,
  geo: THREE.BoxGeometry,
  shadows = true,
): THREE.Mesh | null {
  const dx = span.bx - span.ax
  const dy = span.by - span.ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-3 || t1 - t0 < 0.02 || y1 - y0 < 0.02) return null
  const ux = dx / len
  const uy = dy / len
  const mid = (t0 + t1) / 2
  const m = new THREE.Mesh(geo, mat)
  m.scale.set(t1 - t0, y1 - y0, Math.max(span.thickness, 0.06))
  m.position.set(span.ax + ux * mid, (y0 + y1) / 2, span.ay + uy * mid)
  m.rotation.y = -Math.atan2(dy, dx)
  m.castShadow = shadows
  m.receiveShadow = true
  return m
}

/**
 * Build the whole interior as one `THREE.Group`, dressed in the shared theme.
 *
 * Room floors carry the material their Inventory row bills (see the anti-drift
 * note at the top). Walls come from `classifyWalls`, so the 3D fabric and the
 * 2D plan's colour legend describe the same building; door components are cut
 * out of their wall as real openings (with a lintel above), which is what makes
 * a threshold camera see into the room instead of at a blank slab.
 *
 * **Perimeter convention (deliberate, documented):** the shell is drawn as a
 * 0.9 m spandrel with a glazed band above. The core classifies a bare shell run
 * as `perimeter_wall` only because a generated test-fit carries no `Window`
 * components (`reports/C-1.md` §8.3); a windowless office render would be wrong
 * for the deliverable, and no quantity is taken from this geometry. Pass
 * `perimeterGlazing: false` for a solid shell.
 */
export function buildInteriorScene(state: DocState, opts: InteriorSceneOpts = {}): InteriorScene {
  const theme = opts.theme ?? createMaterialTheme()
  const ownsTheme = !opts.theme
  const root = new THREE.Group()
  root.name = 'interior'
  const floors = new THREE.Group()
  floors.name = 'floors'
  root.add(floors)

  const owned: Array<THREE.BufferGeometry> = []
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    owned.push(g)
    return g
  }
  const unitBox = track(new THREE.BoxGeometry(1, 1, 1))

  const zones = state.zones ?? []
  const doors = state.components.filter((c) => c.category === 'Door')
  const spans = opts.wallSpans ?? classifyWalls(state)
  const plate =
    opts.plate ?? (platePolygonFromWalls(state.walls.filter((w) => !w.generated)) as Pt[] | null)

  // ── 1. Floors ─────────────────────────────────────────────────────────────
  // The plate first (circulation + any residual gap reads as the parquet spine
  // the palette describes), then every room's own plate on top of it.
  if (plate && plate.length >= 3) {
    const base = flatPlate(ringToShape(plate), theme.floors.herringbone_parquet, 0)
    base.userData.surface = 'floor'
    floors.add(base)
    owned.push(base.geometry)
  }

  const rooms: InteriorRoom[] = []
  for (const z of zones) {
    const finishKey = finishTypeFor(z)
    const floorKey = floorKeyForFinish(finishKey)
    const rings = zoneRings(z.shape)
    if (z.zone_type !== 'Core' && rings[0] && rings[0].length >= 3) {
      const mesh = flatPlate(ringToShape(rings[0], rings.slice(1)), theme.floors[floorKey], 0.004)
      mesh.userData.floorKey = floorKey
      mesh.userData.zoneId = z.id
      mesh.userData.surface = 'floor'
      floors.add(mesh)
      owned.push(mesh.geometry)
    }
    const byId = new Map(state.components.map((c) => [c.id, c] as const))
    const members = z.component_ids.length
      ? (z.component_ids.map((id) => byId.get(id)).filter(Boolean) as DocComponent[])
      : state.components.filter((c) => c.category !== 'Door' && pointInZoneShape(z.shape, c.x, c.y))
    const center = zoneCenter(z.shape)
    let focus = center
    if (members.length) {
      focus = {
        x: members.reduce((t, c) => t + c.x, 0) / members.length,
        y: members.reduce((t, c) => t + c.y, 0) / members.length,
      }
    }
    rooms.push({
      zone: z,
      finishKey,
      floorKey,
      floorMaterialName: FLOOR_MATERIAL_NAME[floorKey],
      center,
      bbox: zoneBBox(z.shape),
      focus,
      components: members,
    })
  }

  // ── 2. Walls ──────────────────────────────────────────────────────────────
  const overrides = spanMaterialOverrides(rooms, spans, theme)
  const perimeterGlazing = opts.perimeterGlazing !== false
  for (const span of spans) {
    const len = Math.hypot(span.bx - span.ax, span.by - span.ay)
    if (len < 0.05) continue
    const runs = solidRuns(len, openingsFor(span, doors))
    const cuts = runs.length !== 1 || runs[0][0] > 0.01 || runs[0][1] < len - 0.01

    const addBox = (t0: number, t1: number, y0: number, y1: number, mat: THREE.Material, shadow = true) => {
      const m = spanBox(span, t0, t1, y0, y1, mat, unitBox, shadow)
      if (m) root.add(m)
    }

    const perimeter: WallType[] = ['perimeter_wall', 'perimeter_windows']
    if (span.type === 'glass') {
      for (const [t0, t1] of runs) addBox(t0, t1, 0, WALL_HEIGHT, theme.glass, false)
      addMullions(root, span, runs, theme, unitBox)
      if (cuts) addBox(0, len, DOOR_H, WALL_HEIGHT, theme.glass, false)
    } else if (perimeter.includes(span.type) && perimeterGlazing) {
      addBox(0, len, 0, SILL_H, theme.wallExterior)
      addBox(0, len, SILL_H, WALL_HEIGHT, theme.glass, false)
      addMullions(root, span, [[0, len]], theme, unitBox, SILL_H)
    } else if (span.type === 'core') {
      for (const [t0, t1] of runs) addBox(t0, t1, 0, WALL_HEIGHT, theme.wallExterior)
    } else if (span.type === 'half_drywall') {
      for (const [t0, t1] of runs) addBox(t0, t1, 0, HALF_WALL_H, theme.wall)
    } else {
      const mat = overrides.get(spanKey(span)) ?? theme.wall
      for (const [t0, t1] of runs) addBox(t0, t1, 0, WALL_HEIGHT, mat)
      if (cuts) addBox(0, len, DOOR_H, WALL_HEIGHT, mat) // lintel over the openings
    }
  }

  // ── 3. Furniture ──────────────────────────────────────────────────────────
  for (const c of state.components) {
    if (SKIP_CATEGORIES.has(c.category)) continue
    const g = new THREE.Group()
    g.position.set(c.x, 0, c.y)
    g.rotation.y = -c.rotation
    g.add(buildFurniture3D(c.category, c.w, c.h, { color: theme.furnitureAccent(c.category) }))
    redressFurniture(g, c.category, theme)
    root.add(g)
  }

  // ── 4. Ceiling + luminaires ───────────────────────────────────────────────
  if (opts.ceiling !== false && plate && plate.length >= 3) {
    const c = flatPlate(ringToShape(plate), theme.ceiling, CEILING_HEIGHT)
    c.userData.surface = 'ceiling'
    c.receiveShadow = false
    root.add(c)
    owned.push(c.geometry)
    addDownlights(root, plate, theme, track)
  }
  if (opts.luminaires !== false) addFeatureLuminaires(root, rooms, theme, track)

  // ── 5. Exterior (what the glazing looks out on) ───────────────────────────
  if (opts.exterior !== false) {
    const ground = new THREE.Mesh(track(new THREE.CircleGeometry(300, 48)), theme.exterior)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.35
    root.add(ground)
  }

  const bounds = new THREE.Box3().setFromObject(root)

  return {
    root,
    theme,
    floors,
    rooms,
    plate,
    bounds,
    // Only OUR allocations are freed. `buildFurniture3D` hands back groups over
    // module-level shared geometry/materials (also used by the live Viewer3D) —
    // disposing those would blank every other consumer; the groups are GC'd.
    dispose(): void {
      for (const g of owned) g.dispose()
      owned.length = 0
      root.clear()
      if (ownsTheme) theme.dispose()
    },
  }
}

/**
 * Re-dress a `buildFurniture3D` model into the qbiq palette by swapping the
 * library's NAMED shared materials (`furniture3d.ts` `MAT`) for the theme's.
 * Swapping the mesh's material reference — never mutating the shared material —
 * keeps the live `Viewer3D` and the section renderer on their own look.
 *
 * Worktops/casework become `white_oak_furniture`; seating upholstery becomes
 * `upholstery_charcoal`; legs and frames become the `black_ring_luminaire`
 * near-black. Monitors, chair bases, soil and foliage keep the library's own
 * materials — the palette has nothing to say about them.
 */
function redressFurniture(g: THREE.Object3D, category: string, theme: MaterialTheme): void {
  const seating = /chair|stool|lounge|bench|sofa|seat|tub|ottoman/i.test(category)
  g.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = true
    const mat = m.material as THREE.Material | undefined
    switch (mat?.name) {
      case 'laminate':
      case 'wood':
        m.material = theme.oak
        break
      case 'accent':
        m.material = seating ? theme.upholstery : theme.oak
        break
      case 'fabric':
        m.material = theme.upholstery
        break
      case 'darkMetal':
        m.material = theme.luminaire
        break
      case 'pot':
        m.material = theme.wall
        break
      case 'glass':
        m.material = theme.glass
        break
      default:
        break
    }
  })
}

function spanKey(s: WallSpan): string {
  return `${s.wallId}:${s.ax.toFixed(2)},${s.ay.toFixed(2)}-${s.bx.toFixed(2)},${s.by.toFixed(2)}`
}

/**
 * Accent partitions, assigned from `palette.json`'s own `usedFor` notes rather
 * than by eye:
 *  - `sage_green_feature_wall` → the longest opaque wall bounding **reception**
 *    (the "reception backdrop") — the surface a threshold camera faces.
 *  - `white_oak_furniture` (fluted slats) → walls bounding a **collaboration**
 *    room ("open-space alcove/pod walls").
 *  - `perforated_bronze_screen` → walls bounding **storage / IT / print** rooms
 *    ("bookcase/library backs, storage-wall infill").
 */
function spanMaterialOverrides(
  rooms: InteriorRoom[],
  spans: WallSpan[],
  theme: MaterialTheme,
): Map<string, THREE.Material> {
  const mark = (r: InteriorRoom, s: WallSpan) => {
    if (!r.accentWall) r.accentWall = { x: (s.ax + s.bx) / 2, y: (s.ay + s.by) / 2 }
  }
  const out = new Map<string, THREE.Material>()
  const opaque = (s: WallSpan) =>
    s.type !== 'glass' && s.type !== 'perimeter_wall' && s.type !== 'perimeter_windows'
  const bounding = (r: InteriorRoom, pad = 0.7): WallSpan[] =>
    spans.filter((s) => {
      if (!opaque(s)) return false
      const mx = (s.ax + s.bx) / 2
      const my = (s.ay + s.by) / 2
      return (
        mx >= r.bbox.minX - pad &&
        mx <= r.bbox.maxX + pad &&
        my >= r.bbox.minY - pad &&
        my <= r.bbox.maxY + pad
      )
    })
  const spanLen = (s: WallSpan) => Math.hypot(s.bx - s.ax, s.by - s.ay)

  for (const r of rooms) {
    if (r.finishKey === 'reception') {
      const best = bounding(r).sort((a, b) => spanLen(b) - spanLen(a))[0]
      if (best && spanLen(best) > 1.2) {
        out.set(spanKey(best), theme.feature)
        mark(r, best)
      }
    } else if (r.finishKey === 'collab') {
      for (const s of bounding(r).sort((a, b) => spanLen(b) - spanLen(a))) {
        if (spanLen(s) <= 1.0) continue
        out.set(spanKey(s), theme.slat)
        mark(r, s)
      }
    } else if (r.finishKey === 'storage' || r.finishKey === 'itserver' || r.finishKey === 'print') {
      for (const s of bounding(r).sort((a, b) => spanLen(b) - spanLen(a))) {
        if (spanLen(s) <= 1.0) continue
        out.set(spanKey(s), theme.screen)
        mark(r, s)
      }
    }
  }
  return out
}

/** Slim mullion caps on the glazing module — the reference's white-painted grid. */
function addMullions(
  root: THREE.Group,
  span: WallSpan,
  runs: Array<[number, number]>,
  theme: MaterialTheme,
  geo: THREE.BoxGeometry,
  y0 = 0,
): void {
  for (const [t0, t1] of runs) {
    const n = Math.max(1, Math.round((t1 - t0) / GLAZING_MODULE))
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n
      const m = spanBox(span, t - 0.025, t + 0.025, y0, WALL_HEIGHT, theme.mullion, geo, false)
      if (m) root.add(m)
    }
    // head + sill rails
    for (const y of [y0, WALL_HEIGHT]) {
      const m = spanBox(span, t0, t1, y - 0.03, y + 0.03, theme.mullion, geo, false)
      if (m) root.add(m)
    }
  }
}

/** Recessed downlights on a 2.4 m grid inside the plate — the ceiling sparkle
 *  every one of the four reference stills shows. */
function addDownlights(
  root: THREE.Group,
  plate: Pt[],
  theme: MaterialTheme,
  track: <T extends THREE.BufferGeometry>(g: T) => T,
): void {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of plate) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const step = DOWNLIGHT_SPACING
  const disc = track(new THREE.CircleGeometry(0.075, 16))
  const pts: number[] = []
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      if (!pointInPolygon(plate, x, y)) continue
      pts.push(x, y)
    }
  }
  const count = pts.length / 2
  if (count === 0) return
  const inst = new THREE.InstancedMesh(disc, theme.emissive, count)
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
  const one = new THREE.Vector3(1, 1, 1)
  for (let i = 0; i < count; i++) {
    m4.compose(new THREE.Vector3(pts[i * 2], CEILING_HEIGHT - 0.012, pts[i * 2 + 1]), q, one)
    inst.setMatrixAt(i, m4)
  }
  inst.instanceMatrix.needsUpdate = true
  root.add(inst)
}

/** Even-odd point-in-polygon on a world-metre ring. Exported because the still
 *  renderer must keep every candidate camera inside the floor plate. */
export function pointInPolygon(poly: Pt[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * The reference's signature fixtures: suspended black **rings** over reception,
 * a rectangular black **frame** over the open-plan lounge, and rows of linear
 * **pendants** over the desk banks (`palette.materials.black_ring_luminaire`).
 */
function addFeatureLuminaires(
  root: THREE.Group,
  rooms: InteriorRoom[],
  theme: MaterialTheme,
  track: <T extends THREE.BufferGeometry>(g: T) => T,
): void {
  const hang = CEILING_HEIGHT - 0.55
  const ring = (cx: number, cz: number, r: number) => {
    const g = new THREE.Group()
    const torus = new THREE.Mesh(track(new THREE.TorusGeometry(r, 0.045, 8, 48)), theme.luminaire)
    torus.rotation.x = Math.PI / 2
    g.add(torus)
    const glow = new THREE.Mesh(track(new THREE.TorusGeometry(r, 0.028, 8, 48)), theme.emissive)
    glow.rotation.x = Math.PI / 2
    glow.position.y = -0.03
    g.add(glow)
    for (const a of [0.4, 2.5, 4.6]) {
      const stem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.006, 0.006, 0.55, 6)), theme.luminaire)
      stem.position.set(Math.cos(a) * r, 0.275, Math.sin(a) * r)
      g.add(stem)
    }
    g.position.set(cx, hang, cz)
    root.add(g)
  }
  const bar = (cx: number, cz: number, len: number, along: 'x' | 'z') => {
    const g = new THREE.Group()
    const body = new THREE.Mesh(track(new THREE.BoxGeometry(1, 1, 1)), theme.luminaire)
    body.scale.set(along === 'x' ? len : 0.08, 0.07, along === 'x' ? 0.08 : len)
    g.add(body)
    const glow = new THREE.Mesh(track(new THREE.BoxGeometry(1, 1, 1)), theme.emissive)
    glow.scale.set(along === 'x' ? len - 0.06 : 0.05, 0.012, along === 'x' ? 0.05 : len - 0.06)
    glow.position.y = -0.04
    g.add(glow)
    for (const s of [-0.4, 0.4]) {
      const stem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.005, 0.005, 0.55, 6)), theme.luminaire)
      stem.position.set(along === 'x' ? s * len : 0, 0.275, along === 'z' ? s * len : 0)
      g.add(stem)
    }
    g.position.set(cx, hang, cz)
    root.add(g)
  }

  for (const r of rooms) {
    const w = r.bbox.maxX - r.bbox.minX
    const h = r.bbox.maxY - r.bbox.minY
    if (r.finishKey === 'reception') {
      ring(r.center.x - Math.min(w, h) * 0.18, r.center.y, Math.min(1.05, Math.min(w, h) * 0.34))
      ring(r.center.x + Math.min(w, h) * 0.2, r.center.y - 0.3, Math.min(0.8, Math.min(w, h) * 0.26))
    } else if (r.finishKey === 'conference' || r.finishKey === 'boardroom') {
      bar(r.center.x, r.center.y, Math.min(w, h) * 0.72, w >= h ? 'x' : 'z')
    } else if (r.finishKey === 'workspace') {
      // A pendant over each desk bank: cluster the desks by row and light them.
      const desks = r.components.filter((c) => /desk|workstation/i.test(c.category))
      const rowsMap = new Map<number, DocComponent[]>()
      for (const d of desks) {
        const k = Math.round(d.y / 1.6)
        const list = rowsMap.get(k)
        if (list) list.push(d)
        else rowsMap.set(k, [d])
      }
      for (const list of rowsMap.values()) {
        if (list.length < 2) continue
        const y = list.reduce((t, d) => t + d.y, 0) / list.length
        const xs = list.map((d) => d.x).sort((a, b) => a - b)
        // Split a row into contiguous desk RUNS (a >2.2 m gap is an aisle, not
        // a desk), then light each run with pendants of a realistic ~2.6 m —
        // one bar per run would hang a 30 m black beam across the ceiling.
        let runStart = xs[0]
        const runs: Array<[number, number]> = []
        for (let i = 1; i <= xs.length; i++) {
          if (i === xs.length || xs[i] - xs[i - 1] > 2.2) {
            runs.push([runStart, xs[i - 1]])
            if (i < xs.length) runStart = xs[i]
          }
        }
        const SEG = 2.6
        for (const [x0, x1] of runs) {
          const span = x1 - x0 + 1.2
          const n = Math.max(1, Math.round(span / (SEG * 1.35)))
          for (let i = 0; i < n; i++) {
            const cx = x0 - 0.6 + (span * (i + 0.5)) / n
            bar(cx, y, Math.min(SEG, span / n - 0.3), 'x')
          }
        }
      }
    } else if (r.finishKey === 'collab') {
      const s = Math.min(w, h) * 0.6
      bar(r.center.x, r.center.y - s / 2, s, 'x')
      bar(r.center.x, r.center.y + s / 2, s, 'x')
      bar(r.center.x - s / 2, r.center.y, s, 'z')
      bar(r.center.x + s / 2, r.center.y, s, 'z')
    }
  }
}

// ── Lighting + environment ───────────────────────────────────────────────────

export interface InteriorLightingOpts {
  /** Aim the shadow frustum at this plan point (the room being rendered), so a
   *  4096 map resolves a 6 m room instead of spreading over a 40 m plate. */
  focus?: { x: number; y: number; radius: number }
  /** Sun elevation / azimuth (deg). Default: warm low-mid morning key. */
  elevationDeg?: number
  azimuthDeg?: number
  /** Multiplier on every light (exposure is handled by the renderer). */
  intensity?: number
  shadowMapSize?: number
  /** How many ceiling luminaires to light the focused room with. Default 4. */
  ceilingLamps?: number
  /** Per-luminaire intensity (candela-ish, decay 2). Default 2. */
  lampIntensity?: number
  /** Radius (m) around the subject to place luminaires within. Default 11. */
  lampReachM?: number
}

/**
 * The interior light rig: a warm-neutral hemispheric fill, a shadow-casting sun
 * aimed through the perimeter glazing, and a soft overhead fill that stands in
 * for the ceiling's luminaires. Returned as one `THREE.Group` — add it to the
 * scene, `remove()` it to swap rigs.
 */
export function createInteriorLighting(opts: InteriorLightingOpts = {}): THREE.Group {
  const g = new THREE.Group()
  g.name = 'interior-lighting'
  const k = opts.intensity ?? 1

  // Light COLOUR is deliberately close to neutral. `palette.materials.*.hex`
  // was measured off renders already lit at 3000 K, so the warmth is baked into
  // the albedos; adding a strongly orange key on top pushes every surface's hue
  // out of its own measured band (G6 checks hue, and a 0xffe6c2 key shifted the
  // parquet from H≈23 to H≈34 — out of range for the material it IS).
  const hemi = new THREE.HemisphereLight(0xfdfaf5, 0xcfc9c1, 0.6 * k)
  g.add(hemi)

  const elev = ((opts.elevationDeg ?? 26) * Math.PI) / 180
  const az = ((opts.azimuthDeg ?? 205) * Math.PI) / 180
  const sun = new THREE.DirectionalLight(0xfffaf0, 3.1 * k)
  const dist = 60
  const fx = opts.focus?.x ?? 0
  const fz = opts.focus?.y ?? 0
  sun.position.set(
    fx + Math.sin(az) * Math.cos(elev) * dist,
    Math.sin(elev) * dist,
    fz + Math.cos(az) * Math.cos(elev) * dist,
  )
  sun.target.position.set(fx, 0, fz)
  sun.castShadow = true
  const size = opts.shadowMapSize ?? 4096
  sun.shadow.mapSize.set(size, size)
  sun.shadow.bias = -0.00018
  sun.shadow.normalBias = 0.025
  const r = Math.max(6, opts.focus?.radius ?? 24)
  const cam = sun.shadow.camera
  cam.near = 1
  cam.far = dist * 2.2
  cam.left = -r
  cam.right = r
  cam.top = r
  cam.bottom = -r
  cam.updateProjectionMatrix()
  g.add(sun)
  g.add(sun.target)

  // Ceiling fill: what the recessed downlights would throw. A downward-aimed
  // wide directional light with no shadow — cheap, and it keeps the floor lit
  // in deep-plan rooms the sun never reaches.
  const fill = new THREE.DirectionalLight(0xfff9f1, 0.85 * k)
  fill.position.set(fx + 2, 30, fz + 2)
  fill.target.position.set(fx, 0, fz)
  fill.castShadow = false
  g.add(fill)
  g.add(fill.target)

  // Real luminaires. An ENCLOSED room (a meeting room off a corridor) gets no
  // sun at all, so on ambient alone its floor renders a stop and a half under
  // the same material's open-plan reading — and two stills then disagree about
  // a material they share.
  //
  // They sit on the SAME 2.4 m grid the ceiling's recessed downlights are drawn
  // on, rather than as a ring scaled to the subject. That matters: a fixed ring
  // puts far more light per square metre into a 4 m reception than into a 38 m
  // floor, and the reception's parquet then reads a stop brighter and washed
  // out — measured L 0.54 / S 0.06 against L 0.28 / S 0.23 for the same
  // material under the same fixtures at the right density.
  const reach = opts.lampReachM ?? 11
  const grid: Array<[number, number]> = []
  for (let x = fx - reach; x <= fx + reach; x += DOWNLIGHT_SPACING) {
    for (let z = fz - reach; z <= fz + reach; z += DOWNLIGHT_SPACING) {
      if (Math.hypot(x - fx, z - fz) > reach) continue
      grid.push([x, z])
    }
  }
  grid.sort((a, b) => Math.hypot(a[0] - fx, a[1] - fz) - Math.hypot(b[0] - fx, b[1] - fz))
  for (const [x, z] of grid.slice(0, opts.ceilingLamps ?? 28)) {
    const p = new THREE.PointLight(0xfff8ee, (opts.lampIntensity ?? 2) * k, DOWNLIGHT_SPACING * 4, 2)
    p.position.set(x, CEILING_HEIGHT - 0.15, z)
    p.castShadow = false
    g.add(p)
  }

  return g
}

/**
 * The image-based ambient every 3D deliverable shares — `RoomEnvironment`
 * PMREM'd, which is an interior light-box and therefore the right IBL for a
 * fit-out (the `Viewer3D` 'render' tier's physical sky is an EXTERIOR rig and
 * emits NaN on software GL). Caller owns the returned target.
 */
export function interiorEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer)
  const env = new RoomEnvironment()
  const rt = pmrem.fromScene(env, 0.04)
  env.dispose()
  pmrem.dispose()
  return rt
}

/** Warm-to-cool vertical sky gradient for `scene.background` — the daylight the
 *  perimeter glazing looks out on. */
export function interiorSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 256
  const ctx = c.getContext('2d')!
  const grd = ctx.createLinearGradient(0, 0, 0, 256)
  grd.addColorStop(0, '#9fbcd8')
  grd.addColorStop(0.55, '#dfe6ea')
  grd.addColorStop(0.72, '#f3ead9')
  grd.addColorStop(1, '#9aa88a')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, 4, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.mapping = THREE.EquirectangularReflectionMapping
  return t
}
