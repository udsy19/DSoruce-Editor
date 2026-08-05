import init, { Editor, open_share } from '../wasm/ds_core'
import { catByCategory } from './catalog'
import { drawSymbol, seatsForSize, pen, lod, type PenWeight } from './symbols'
import { CadController } from '../cad/controller'
import { entityBBox } from '../cad/render'
import type { CadEntity, SnapContext, Vec2, SnapResult } from '../cad/model'
import {
  emptyDyn,
  dynEmpty,
  parseTyped,
  polarSnap,
  resolvePoint,
  bearingDeg,
  norm360,
  type DynState,
  type PolarOpts,
} from '../cad/dynamicInput'
import { fmtMeters, parseDim, endpointForLength } from '../cad/dimEdit'
import { evaluatorAvailable } from '../ai/evaluator'
import { applyDelta, proposeAdjustment, refScore, type ProgramDelta } from '../ai/refine'
import { proposeDesign, proposeDesignOptions, applyDesignSpec, DESIGN_OBJECTIVES, type DesignSpec, type DesignObjective } from '../ai/designer'

// Types mirroring the Rust core's serialized document (serde field names).
export interface DocWall {
  id: number
  a: { x: number; y: number }
  b: { x: number; y: number }
  thickness: number
  /** Emitted by the test-fit generator (room partitions); re-emitted per run. */
  generated?: boolean
  /** Glazed partition (glass front) — triple-line in 2D, translucent in 3D. */
  glazing?: boolean
}
export interface DocComponent {
  id: number
  category: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  /** Hinge handedness (doors only): reflect the symbol across its long axis. serde
   *  defaults false, so pre-mirror snapshots + generated components read as false. */
  mirror?: boolean
  /** Passive REFERENCE facet: imported/legacy CAD furniture drawn for context but
   *  NOT counted in any metric (workstations, pax, cost, CO2). serde defaults false,
   *  so generated/placed content counts (see `Component::reference`, Rust core). */
  reference?: boolean
  /** How many people sit AT this object, resolved once by the core
   *  (`model::seats_for`) and only ever READ here — the renderer must never
   *  recompute it (see `Component::seats`, Rust core, and ui-system.md §3.6).
   *  Distinct from a ROOM's pax, which is `zone_stats().capacity`. serde defaults
   *  0, so snapshots predating the facet read as 0. */
  seats?: number
  label: string
  product_id: string | null
  decision: 'Open' | 'InReview' | 'Confirmed'
}
/** Read-only geometry facet of a selection, surfaced to the object inspector. */
export type SelectedInfo =
  | {
      kind: 'component'
      id: number
      category: string
      x: number
      y: number
      w: number
      h: number
      rotation: number
      label: string
      product_id: string | null
      decision: 'Open' | 'InReview' | 'Confirmed'
    }
  | {
      kind: 'wall'
      id: number
      length: number
      thickness: number
      a: { x: number; y: number }
      b: { x: number; y: number }
    }
/** Partial edit applied by `updateSelected` (rotation in radians). */
export interface SelectedPatch {
  x?: number
  y?: number
  w?: number
  h?: number
  rotation?: number
  category?: string
  decision?: string
  product_id?: string
  product_name?: string
}
export type ZoneType =
  | 'Circulation'
  | 'Workspace'
  | 'Meeting'
  | 'Collaboration'
  | 'Core'
  | 'ClosedOffice'
  | 'Amenity'
export type ZoneShape =
  | { kind: 'Rect'; x: number; y: number; w: number; h: number }
  | { kind: 'RectRing'; x: number; y: number; w: number; h: number; in_w: number; in_h: number }
  // Boundary-conforming filled polygon (world meters): a zone that hugs an
  // angled/stepped wall edge-to-edge. Non-draggable/rotatable in v1 (edit guards
  // gate on `kind !== 'Rect'`).
  | { kind: 'Poly'; pts: [number, number][] }
export interface DocZone {
  id: number
  zone_type: ZoneType
  shape: ZoneShape
  label: string
  component_ids: number[]
}
/** A position-pinned room request (mirrors Rust `document::Anchor`). Rides
 *  `state()`; pushed via `Editor.add_anchor` (workflow.md §3.5). */
export interface DocAnchor {
  kind: SpaceKind
  x: number
  y: number
}
export interface DocState {
  walls: DocWall[]
  components: DocComponent[]
  zones?: DocZone[]
  /** Doc-level anchor pins (optional; empty/absent on pre-S6 docs). */
  anchors?: DocAnchor[]
  selection: number | null
}
export interface Metrics {
  floor_area: number
  wall_count: number
  component_count: number
  confirmed: number
  // Slice 2 additive Statistics-panel fields (optional for backward-compat).
  gross_external_area?: number
  net_internal_area?: number
  workstations?: number
  area_per_workstation?: number
  efficiency_pct?: number
  indicative_cost?: number
  /** Σ observed ₹ prices of bank-bound components (specified furniture capex). */
  specified_cost?: number
  indicative_carbon?: number
}
export interface ZoneStat {
  id: number
  zone_type: ZoneType
  label: string
  area: number
  capacity: number
  seated: number
  pct_of_nia: number
}

export type ToolId = string // 'select' | 'wall' | 'place:<Category>'

/** The core's room-type vocabulary (mirrors Rust `layout::SpaceKind`). A
 *  `RoomReq.kind` names one of these by string; the Program builder's richer
 *  vocabulary (Executive/Large/Medium office, XL conference, …) maps onto these
 *  at different footprints (see `program/spec.ts`). Guarded against the Rust
 *  enum by `src/coreParity.test.mjs`. */
export type SpaceKind =
  | 'Meeting'
  | 'Cabin'
  | 'Meeting4P'
  | 'Meeting6P'
  | 'Boardroom'
  | 'PhoneBooth'
  | 'Focus'
  | 'Collab'
  | 'Reception'
  | 'Pantry'
  | 'Print'
  | 'ItServer'
  | 'Storage'
  | 'Wellness'
/** Facade preference for an explicit room (mirrors Rust `layout::Placement`). */
export type Placement = 'Window' | 'Core' | 'Flexible'
/** One explicit room request from the Detailed program builder (mirrors Rust
 *  `layout::RoomReq`). Serializes 1:1 to the wasm `generate` program. */
export interface RoomReq {
  kind: SpaceKind
  count: number
  /** Corridor-run width (m); omitted → the kind's default footprint. */
  w?: number
  /** Depth (m); omitted → the kind's default. */
  d?: number
  placement?: Placement
  /** Briefed occupancy — the room's INTENT, carried to the generator so the
   *  furniture seats what was asked for. 0 = derive from the table. */
  seats?: number
}

/** A room tag computed by drawZones, drawn above furniture by drawZoneTags. */
interface ZoneTag {
  name: string
  metrics: string | null
  cx: number
  cy: number
  namePx: number
  color: string
  /** Zone area (m²) — the WORLD priority used to break tag collisions, so which
   *  tag survives never changes as the user zooms or pans. */
  area: number
}

// Space-planning strategies live in a dependency-free module (unit-testable in
// node); re-exported here so existing importers keep the single `EditorCanvas`
// entry point.
export type { Strategy } from './strategy'
export { STRATEGIES, STRATEGY_LABEL, STRATEGY_BLURB } from './strategy'
import type { Strategy } from './strategy'
import { STRATEGIES, STRATEGY_SEED_STRIDE, seedWindowOffset } from './strategy'
import { MONO } from '../ui/type'

/** Test-fit program + objective weights (mirrors Rust `layout::Program`). */
export interface Program {
  desks: number
  meeting_rooms: number
  desk_w: number
  desk_h: number
  meeting_w: number
  meeting_h: number
  cluster_cols: number
  target_corridor_m: number
  desk_clearance_m: number
  /** Back-to-back paired desk rows (real-world bench desking). */
  bench_pairs: boolean
  /** Derive + place the full professional support program (cabins, phone booths,
   * focus, pantry, reception, print, IT, storage, wellness — spec §1.1) alongside
   * the desks/meetings. Default true. */
  support_spaces: boolean
  /** Design headcount N. When set, drives `SpaceProgram::derive`; when omitted it
   * is inferred from the desk target (desks ≈ 0.85·N). Absent → Rust `None`. */
  headcount?: number
  /** Explicit room program from the Detailed builder (workflow.md §3.4). Empty →
   * the derived support program + `meeting_rooms` override (today's behaviour);
   * non-empty → these rooms replace it, counts + placement bias honored. */
  rooms?: RoomReq[]
  /** Space-planning strategy (M7). Absent → Rust `Balanced` (today's behaviour).
   *  `autoGenerate` injects one per alternative so the gallery's A/B/C are
   *  strategically distinct; an explicit `rooms` program pins the counts so a
   *  strategy then only varies layout/scoring, never the counts. */
  strategy?: Strategy
  w_capacity: number
  w_adjacency: number
  w_circulation: number
  w_density: number
  /** Weight of `program_fit` (delivered vs derived room program). */
  w_program: number
  /** Weight of `daylight` (% desks near the facade — M5). */
  w_daylight: number
  /** Weight of `entry_adjacency` (reception near entry, pantry far — M5). */
  w_entry: number
}
export interface LayoutScore {
  capacity: number
  adjacency: number
  circulation: number
  /** m²/person NIA density, peaking in the professional 8–12 band (M5). */
  density: number
  /** Delivered vs derived room program, 0..100 (M3/M4). */
  program_fit: number
  /** % of workstations within reach of the facade (M5). */
  daylight: number
  /** Entry narrative: reception near the entry, pantry far (M5). */
  entry_adjacency: number
  total: number
  placed_desks: number
}
export interface CirculationScore {
  score: number
  reachable_free_area: number
  floor_area: number
  circulation_ratio: number
  min_corridor_width: number
  mean_clearance: number
  pct_corridors_below_min: number
  largest_connected_free_region: number
  enclosed: boolean
  grid_cols: number
  grid_rows: number
  cell_size: number
}
/** One retained test-fit option from the autonomous search (Laiout-style gallery). */
export interface Candidate {
  seed: number
  /** Which strategy produced this option — the gallery labels A/B/C by it, and
   *  reproducing the exact plan needs the (strategy, seed) pair. */
  strategy: Strategy
  score: LayoutScore
  /** Opaque document snapshot — pass to `applyCandidate` to make it live. */
  snap: unknown
  /** Small plan-schematic dataURL for the gallery card. */
  thumb: string
}
export interface GenResult {
  best: LayoutScore
  iterations: number
  seed: number
  /** Top-K distinct candidates, best first. */
  candidates: Candidate[]
}

/** One objective-optimised design option (Laiout-style) from {@link EditorCanvas.designOptions}:
 *  Claude's spec + the realised fit + its headline metric, snapshot-backed. */
export interface DesignOptionResult {
  objective: DesignObjective
  spec: DesignSpec
  score: LayoutScore
  /** Placed workstations. */
  pax: number
  /** Indicative fit-out cost (₹). */
  cost: number
  /** Indicative embodied carbon (kgCO₂e). */
  carbon: number
  /** Net internal area (m²). */
  nia: number
  /** Opaque snapshot — pass to `applyCandidate` to make this option live. */
  snapshot: string
  thumb: string
}

/** One reasoning step of the AI refinement loop (surfaced in the UI trace). */
export interface RefineStep {
  iteration: number
  /** Claude's one-line reason for this adjustment. */
  rationale: string
  /** The bounded, clamped program delta it proposed. */
  delta: ProgramDelta
  /** Fixed-weight yardstick score before and after applying + regenerating. */
  scoreBefore: number
  scoreAfter: number
  /** Kept (improved the yardstick) or reverted. */
  accepted: boolean
}

/** Result of {@link EditorCanvas.refineWithAI}: the (best) generation now live,
 *  plus the reasoning trace so the UI can show before→after + rationale. */
export interface RefineOutcome {
  /** The winning generation — what is live on the canvas. */
  result: GenResult
  /** The (possibly adjusted) program that produced it. */
  program: Program
  steps: RefineStep[]
  /** Fixed-weight yardstick of the initial vs final winner. */
  baseScore: number
  finalScore: number
  improved: boolean
  /** false = clean no-op (no Claude key): `result` is the plain autoGenerate run. */
  ranAI: boolean
}

/** Default program — the single source used by the generate card and the AI. */
/** The core's open-plan share of headcount seated at open workstations.
 *  THE one owner is `layout::OPEN_SHARE`; this is the boundary read, so the
 *  frontend never keeps its own copy (two had already drifted — 0.85 vs 0.90).
 *  Requires wasm to be initialised, so pure/node-testable modules take the value
 *  as a parameter instead of importing this. */
export function openShare(): number | null {
  try {
    return open_share()
  } catch {
    // wasm not initialised yet. Returning null — never a hardcoded stand-in: a
    // fallback constant here is precisely how the 0.85 / 0.90 split happened.
    // Callers show "—" until the core can answer.
    return null
  }
}

export const DEFAULT_PROGRAM: Program = {
  desks: 20,
  meeting_rooms: 2,
  desk_w: 1.6,
  desk_h: 0.8,
  meeting_w: 3,
  meeting_h: 3,
  cluster_cols: 4,
  target_corridor_m: 1.2,
  desk_clearance_m: 0.9,
  bench_pairs: true,
  support_spaces: true,
  rooms: [],
  w_capacity: 0.35,
  w_adjacency: 0.2,
  w_circulation: 0.25,
  w_density: 0.2,
  w_program: 0.1,
  w_daylight: 0.05,
  w_entry: 0.05,
}

/** Resolved dynamic-input candidate for the current frame (see dynResolve). */
interface DynResolved {
  point: Vec2
  /** osnap indicator to draw (real object snap) or a synthetic 'none'. */
  snap: SnapResult
  dist: number
  angleDeg: number
  /** a typed distance/angle constrained the point */
  locked: boolean
  /** the free direction was polar/ortho-snapped */
  snapped: boolean
}

const GRID_M = 1 // 1-meter minor grid
const MAJOR_EVERY = 5 // heavier line every 5 m
// Tag visibility is a WORLD decision — a room earns a name because of how big the
// ROOM is, not how big it currently looks on screen (ui-system.md §3.5).
const TAG_MIN_AREA_M2 = 6 // below this a room is too small to name
const TAG_METRICS_MIN_AREA_M2 = 12 // below this, name only — no area/pax line
const SNAP_M = 0.1 // 10 cm snap
const RULER = 22 // px ruler gutter (top + left)

// Light "floor-plate" palette — mirrors styles.css tokens (Laiout aesthetic).
const C = {
  surface: '#ffffff', // floor plate
  mat: '#eef0f4', // outside the building footprint (a touch deeper so the plate lifts)
  gridMinor: 'rgba(23,26,30,0.035)',
  gridMajor: 'rgba(23,26,30,0.075)',
  axis: 'rgba(45,91,214,0.18)',
  wall: '#2b313a', // interior partitions — medium
  wallExt: '#1b1f25', // exterior/structural — darkest, but crisp (not a fat marker)
  wallGen: '#525a65', // generated partitions — lightest ink in the hierarchy
  // Matches DrawingCanvas FURNITURE_LINE so generated + imported plans read alike.
  furniture: '#565e69',
  // Secondary furniture detail (keyboard, armrests, backrest ticks) — a mid gray
  // that stays legible over the pastel zone (the old #b4b9c1 read as faint).
  furnitureDetail: '#9aa1ab',
  // Solid worktop/table fill so a desk reads as an object, not a hollow outline.
  furnitureFill: 'rgba(255,255,255,0.86)',
  // Chair/upholstery seat fill — a light cool neutral that sits on any pastel.
  furnitureSeat: '#e7eaee',
  // Passive as-drawn reference furniture (imported, not counted): muted so the
  // generated fit reads as the primary content and context sits quietly behind it.
  furnitureRef: '#b7bdc5',
  labelSub: '#5f6771', // zone-tag metrics line (area · pax)
  preview: 'rgba(45,91,214,0.70)',
  accent: '#2d5bd6',
  label: '#1a1d21',
  rulerBg: '#ffffff',
  rulerCorner: '#f7f8fa',
  rulerText: '#9aa2ad',
  rulerTick: 'rgba(23,26,30,0.18)',
}

const DECISION_DOT: Record<string, string> = {
  Confirmed: '#2fa36b',
  InReview: '#e0952b',
  Open: '#9aa2ad',
}

// Zone fills keyed by ZoneType serde tag → { fill, line } (Laiout pastels).
const ZONE: Record<string, { fill: string; line: string }> = {
  Circulation: { fill: '#dcebfb', line: '#4a82c4' },
  Workspace: { fill: '#fbf3d6', line: '#b99527' },
  Meeting: { fill: '#e9e3f7', line: '#7e63c0' },
  Collaboration: { fill: '#def1e2', line: '#4b9e66' },
  Core: { fill: '#eceef1', line: '#8b939e' },
  ClosedOffice: { fill: '#fce6d6', line: '#cb8150' },
  Amenity: { fill: '#d9f0ef', line: '#3f9c95' },
}

/** Default room name per zone type, applied when a room is reclassified. */
export const ZONE_LABEL: Record<ZoneType, string> = {
  Circulation: 'Circulation',
  Workspace: 'Open Workspace',
  Meeting: 'Meeting Room',
  Collaboration: 'Collaboration',
  Core: 'Core',
  ClosedOffice: 'Closed Office',
  Amenity: 'Amenity',
}

/** A selected room + its on-screen box, handed to the floating `RoomTools`. */
export interface RoomSelection {
  zone: DocZone
  /** Room bounding box in canvas CSS px (top-left origin). */
  box: { left: number; top: number; width: number; height: number }
}

// Resize-handle order: TL, T, TR, R, BR, B, BL, L — with matching cursors.
const ROOM_MIN_M = 1.0 // a room can't be dragged smaller than 1 m on a side
const HANDLE_HIT_PX = 8 // grab radius around a handle
// frameContent tuning (see the method for rationale):
const FRAME_MIN_VIEWPORT_PX = 40 // below this the canvas isn't really laid out → retry
const FRAME_MAX_RETRIES = 30 // ~0.5 s of rAF before giving up (canvas genuinely hidden)
const FRAME_ENTITY_MARGIN = 1.0 // admit CAD entities within 1× the shell span of it
const HANDLE_CURSOR = [
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
]

/**
 * Owns the canvas: transforms, input, and 2D rendering. All document mutations
 * go through the Rust `Editor`; this class re-reads `state()` to draw. Rendering
 * is TS-side for now and migrates into a Rust/WebGL renderer later
 * (docs/adr/0001-rendering-staging.md).
 */
export class EditorCanvas {
  ed: Editor
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = Math.max(1, window.devicePixelRatio || 1)

  scale = 46 // px per meter
  offset = { x: 120, y: 96 } // screen px of world origin
  /** Cold-reload guard: frameContent retries via rAF until the canvas has a real
   *  measured viewport (a saved plan can open before layout has sized the canvas). */
  private frameRetries = 0
  /** Set when frameContent bails because the container isn't laid out yet. The
   *  ResizeObserver completes the frame the instant the container reaches a real
   *  size — robust even if the rAF retry budget expires first (e.g. a candidate
   *  opened straight from the wizard route, where layout settles a beat late). */
  private frameOnLayout = false
  private containerObserver: ResizeObserver | null = null
  tool: ToolId = 'select'
  /** Presentation ("paper") mode: white full-bleed sheet — no grid, no axis,
   *  no rulers — lightened zone tints and a bottom-right plan-summary block.
   *  Toggle via {@link setPresentation} or the 'p' shortcut. */
  presentation = false

  // Optional status-bar readouts updated by direct DOM writes (no React churn).
  coordEl: HTMLElement | null = null
  scaleEl: HTMLElement | null = null

  private wallStart: { x: number; y: number } | null = null
  private mouseWorld = { x: 0, y: 0 }
  private hasCursor = false
  private dragging = false
  private panning = false
  /** Space held → left-drag pans (universal design-tool convention). */
  private spaceDown = false
  private lastScreen = { x: 0, y: 0 }

  // ---- direct room manipulation (Laiout-style) ----
  /** Currently selected room (zone id), independent of component selection. */
  selectedZoneId: number | null = null
  /** Notified when the selected room (or its screen box) changes; null on deselect. */
  onRoom: ((sel: RoomSelection | null) => void) | null = null
  private roomDrag: {
    zoneId: number
    start: { x: number; y: number }
    zone0: { x: number; y: number; w: number; h: number }
    comps: { id: number; x0: number; y0: number }[]
    walls: { id: number; ax0: number; ay0: number; bx0: number; by0: number }[]
  } | null = null
  private roomResize: {
    zoneId: number
    handle: number
    zone0: { x: number; y: number; w: number; h: number }
    // members stored as fractions of the room box so they re-flow on resize
    comps: { id: number; fx: number; fy: number }[]
    walls: { id: number; afx: number; afy: number; bfx: number; bfy: number }[]
  } | null = null
  private lastRoomKey: string | null = null

  // ---- dynamic input (cursor-first typed Distance/Angle, M1) ----
  /** Typed Distance/Angle buffers for the in-progress Line/Wall segment. */
  private dyn: DynState = emptyDyn()
  /** Shift → force ortho, Alt → 45° polar (tracked off pointer/key events). */
  private shiftDown = false
  private altDown = false
  /** Floating dynamic-input widget (created once, positioned each frame). */
  private dynEl: HTMLDivElement | null = null
  private dynDistEl: HTMLElement | null = null
  private dynAngEl: HTMLElement | null = null
  private dynDistField: HTMLElement | null = null
  private dynAngField: HTMLElement | null = null
  /** Per-frame cache of the resolved candidate point (avoids re-snapping). */
  private dynResolved: DynResolved | null = null

  // ---- selection dimensions + click-to-edit (M4) ----
  /** Inline numeric editor (an <input> over the canvas) for a clicked dimension. */
  private dimEditEl: HTMLInputElement | null = null
  /** What the open inline editor is editing, or null when closed. */
  private dimEditing: { kind: 'compX' | 'compY' | 'lineLen'; targetId: number } | null = null
  /** Screen-space click targets for the editable selection dimensions, rebuilt
   *  each frame in {@link drawSelectionDims}. */
  private dimHits: { x: number; y: number; w: number; h: number; kind: 'compX' | 'compY' | 'lineLen'; targetId: number }[] = []

  onChange: (() => void) | null = null
  /** Last program used to generate — shared source for the generate card + AI. */
  program: Program = { ...DEFAULT_PROGRAM }
  /** CAD drafting layer (line/rect/arc/dimension/door/… + snapping). */
  cad!: CadController
  /** True while store.load() replays doc-owned cad_json (skip the write-back). */
  private cadHydrating = false

  private constructor(canvas: HTMLCanvasElement, ed: Editor) {
    this.canvas = canvas
    this.ed = ed
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
    this.cad = new CadController({
      toScreen: (p) => this.toScreen(p.x, p.y),
      toWorld: (sx, sy) => this.toWorld(sx, sy),
      pxPerM: () => this.scale,
      requestRender: () => this.render(),
      snapContext: () => this.buildSnapContext(),
      addComponent: (category, x, y, w, h, rotation) => {
        const id = this.ed.add_component(category, x, y, w, h)
        if (rotation) this.ed.set_component_rotation(id, rotation)
        this.commit()
      },
    })
    // The CAD layer rides the document as an opaque blob so snapshot()/restore()
    // (AI undo, candidate gallery) round-trip drafting geometry. The controller
    // hooked onChange → render; wrap it to also persist into the core.
    const cadRender = this.cad.store.onChange
    this.cad.store.onChange = () => {
      if (!this.cadHydrating) this.ed.set_cad_json(JSON.stringify(this.cad.store.entities))
      cadRender?.()
      // React side re-derives from the store (empty-state overlay, layers card).
      this.onChange?.()
    }
    this.attach()
    this.createDynWidget()
    this.createDimEditor()
    // Observe the CONTAINER (not just window resize): the canvas parent can go
    // from 0 → real size a frame or two after a route mount (opening a candidate
    // from the wizard), which window 'resize' never fires for. This is what
    // reliably finishes a frame that bailed while the container was collapsed.
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.containerObserver = new ResizeObserver(this.onContainerResize)
      this.containerObserver.observe(this.canvas.parentElement)
    }
    this.resize()
    this.render()
    // Dev-only test seam: expose the live instance so E2E / debugging can drive
    // the core directly. Guarded by Vite's DEV flag — never present in a build.
    if (import.meta.env.DEV) (window as unknown as { __ec?: EditorCanvas }).__ec = this
  }

  static async create(canvas: HTMLCanvasElement): Promise<EditorCanvas> {
    await init()
    const ec = new EditorCanvas(canvas, new Editor())
    // Dev-only seam: expose the live instance for console tooling + browser
    // E2E (there is no other path to the editor from outside React).
    if (import.meta.env.DEV) (window as unknown as { __ec?: EditorCanvas }).__ec = ec
    return ec
  }

  // ---- coordinate transforms ----
  private toWorld(sx: number, sy: number) {
    return { x: (sx - this.offset.x) / this.scale, y: (sy - this.offset.y) / this.scale }
  }
  private toScreen(wx: number, wy: number) {
    return { x: wx * this.scale + this.offset.x, y: wy * this.scale + this.offset.y }
  }
  private snap(w: { x: number; y: number }) {
    return { x: Math.round(w.x / SNAP_M) * SNAP_M, y: Math.round(w.y / SNAP_M) * SNAP_M }
  }
  private buildSnapContext(): Omit<SnapContext, 'from'> {
    const st = this.getState()
    return {
      entities: this.cad.store.entities,
      walls: st.walls.map((wl) => ({ a: { x: wl.a.x, y: wl.a.y }, b: { x: wl.b.x, y: wl.b.y } })),
      components: st.components.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, rotation: c.rotation })),
      grid: 0.1,
      pxPerM: this.scale,
      tolPx: 10,
    }
  }

  // ---- dynamic input (cursor-first typed Distance/Angle + polar snap, M1) ----

  /** The point the in-progress segment extends from (wall = wallStart, CAD draw
   *  = the tool's anchor), or null when no draw chain is live. */
  private dynAnchor(): Vec2 | null {
    if (this.tool === 'wall') return this.wallStart
    if (this.cad.active) return this.cad.anchor()
    return null
  }
  /** A draw chain is live and can receive typed Distance/Angle. */
  private dynArmed(): boolean {
    return this.dynAnchor() !== null
  }
  /** Polar/ortho constraint for the current modifiers: Shift forces ortho,
   *  Alt switches to 45° polar, else a subtle 90° assist. Documented in §6.5. */
  private polarOpts(): PolarOpts {
    if (this.shiftDown) return { stepDeg: 90, tolDeg: 45, enabled: true } // force ortho
    if (this.altDown) return { stepDeg: 45, tolDeg: 8, enabled: true } // polar 45°
    return { stepDeg: 90, tolDeg: 8, enabled: true } // subtle ortho assist
  }

  /**
   * Resolve the candidate next point from the anchor + cursor, honoring OSNAP
   * (a grabbed object point wins), then any typed Distance/Angle, then ortho/
   * polar snap; falls back to the classic grid snap for a purely free cursor so
   * the plain click-to-place feel is preserved. Returns null when not drawing.
   */
  private dynResolve(cursor: Vec2): DynResolved | null {
    const anchor = this.dynAnchor()
    if (!anchor) return null

    // OSNAP-first (CAD tools only): a real object snap overrides polar/typed dir.
    if (this.cad.active) {
      const s = this.cad.snap(cursor)
      if (s.type !== 'none' && s.type !== 'grid') {
        return {
          point: s.point,
          snap: s,
          dist: Math.hypot(s.point.x - anchor.x, s.point.y - anchor.y),
          angleDeg: bearingDeg(anchor, s.point),
          locked: false,
          snapped: false,
        }
      }
    }

    const typed = parseTyped(this.dyn)
    const polar = this.polarOpts()
    const ps = polarSnap(anchor, cursor, polar)
    // Feed the (already polar-snapped) cursor into resolvePoint; typed values win.
    const r = resolvePoint(anchor, ps.point, typed)
    let point = r.point
    // Preserve the classic grid feel only when the point is purely cursor-driven.
    if (!r.locked && !ps.snapped) point = this.snap(point)
    return {
      point,
      snap: { point, type: 'none' },
      dist: Math.hypot(point.x - anchor.x, point.y - anchor.y),
      angleDeg: bearingDeg(anchor, point),
      locked: r.locked,
      snapped: ps.snapped,
    }
  }

  private resetDyn() {
    this.dyn = emptyDyn()
  }

  /** Route a keystroke into the dynamic-input buffer while drawing. Returns true
   *  when consumed (digits/Tab/Enter/Backspace/first-Esc). */
  private handleDynKey(e: KeyboardEvent): boolean {
    const k = e.key
    if (k === 'Tab') {
      e.preventDefault()
      this.dyn.active = this.dyn.active === 'distance' ? 'angle' : 'distance'
      this.render()
      return true
    }
    if (/^[0-9]$/.test(k) || k === '.' || (k === '-' && this.dyn[this.dyn.active] === '')) {
      // Digits flow to Distance by default (fresh state starts there); an explicit
      // Tab is respected so you can type Angle first (matches AutoCAD Dynamic Input).
      e.preventDefault()
      this.dyn[this.dyn.active] += k
      this.render()
      return true
    }
    if (k === 'Backspace') {
      const f = this.dyn.active
      if (this.dyn[f].length) {
        e.preventDefault()
        this.dyn[f] = this.dyn[f].slice(0, -1)
        this.render()
        return true
      }
      return false
    }
    if (k === 'Enter') {
      e.preventDefault()
      if (!dynEmpty(this.dyn)) this.commitDyn()
      else this.finishDraw()
      return true
    }
    if (k === 'Escape' && !dynEmpty(this.dyn)) {
      // First Esc clears the typed lock; a second Esc (buffer empty) cancels the
      // chain via the normal handlers below.
      this.resetDyn()
      this.render()
      return true
    }
    return false
  }

  /** Commit the typed point through the tool's normal placement path. */
  private commitDyn() {
    const r = this.dynResolve(this.mouseWorld)
    if (!r) {
      this.resetDyn()
      return
    }
    if (this.tool === 'wall') {
      if (!this.wallStart) {
        this.wallStart = r.point
      } else {
        this.ed.add_wall(this.wallStart.x, this.wallStart.y, r.point.x, r.point.y, 0.1)
        this.wallStart = r.point
        this.commit()
      }
    } else if (this.cad.active) {
      this.cad.commitTypedPoint(r.point)
    }
    this.resetDyn()
    this.render()
  }

  /** Empty-Enter finishes the current chain (wall = drop start, CAD = tool end). */
  private finishDraw() {
    if (this.tool === 'wall') this.wallStart = null
    else if (this.cad.active) this.cad.key('Enter')
    this.resetDyn()
    this.render()
  }

  private createDynWidget() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const el = document.createElement('div')
    el.className = 'dyn-input'
    el.setAttribute('data-testid', 'dyn-input')
    el.style.display = 'none'
    const field = (label: string, unit: string, testid: string) => {
      const f = document.createElement('div')
      f.className = 'dyn-field'
      const l = document.createElement('span')
      l.className = 'dyn-label'
      l.textContent = label
      const v = document.createElement('span')
      v.className = 'dyn-val'
      v.setAttribute('data-testid', testid)
      v.textContent = '0'
      const u = document.createElement('span')
      u.className = 'dyn-unit'
      u.textContent = unit
      f.append(l, v, u)
      return { f, v }
    }
    const d = field('Dist', 'm', 'dyn-distance')
    const a = field('Angle', '°', 'dyn-angle')
    const prompt = document.createElement('div')
    prompt.className = 'dyn-prompt'
    prompt.textContent = 'Set another point or type a distance'
    el.append(d.f, a.f, prompt)
    parent.appendChild(el)
    this.dynEl = el
    this.dynDistField = d.f
    this.dynDistEl = d.v
    this.dynAngField = a.f
    this.dynAngEl = a.v
  }

  /** Position + fill the floating widget from the cached resolved point. */
  private syncDynWidget() {
    if (!this.dynEl) return
    const r = this.dynResolved
    const show = !!r && this.dynArmed() && this.hasCursor && !this.presentation && !this.panning
    if (!show || !r) {
      this.dynEl.style.display = 'none'
      return
    }
    const typed = parseTyped(this.dyn)
    if (this.dynDistEl) {
      this.dynDistEl.textContent = (typed.distance != null ? typed.distance : r.dist).toFixed(2)
    }
    if (this.dynAngEl) {
      const ang = typed.angleDeg != null ? norm360(typed.angleDeg) : r.angleDeg
      this.dynAngEl.textContent = String(Math.round(ang))
    }
    this.dynDistField?.classList.toggle('active', this.dyn.active === 'distance')
    this.dynAngField?.classList.toggle('active', this.dyn.active === 'angle')
    this.dynDistField?.classList.toggle('typed', this.dyn.distance !== '')
    this.dynAngField?.classList.toggle('typed', this.dyn.angle !== '')
    const sp = this.toScreen(r.point.x, r.point.y)
    this.dynEl.style.inset = 'auto'
    this.dynEl.style.left = `${Math.round(sp.x + 16)}px`
    this.dynEl.style.top = `${Math.round(sp.y - 14)}px`
    this.dynEl.style.display = 'flex'
  }

  /** Per-segment length chips (committed + in-progress) while a draw tool is
   *  active — Rayon's live "helper dimensions" (doc §6.6). */
  private drawDimChips() {
    if (this.presentation) return
    if (this.tool === 'wall') {
      for (const w of this.getState().walls) this.drawDimChip(w.a, w.b)
      const r = this.dynResolved
      if (this.wallStart && r) this.drawDimChip(this.wallStart, r.point, r.angleDeg, true, r.snapped)
    } else if (this.cad.active && this.cad.currentId === 'line') {
      for (const e of this.cad.store.entities) if (e.kind === 'line') this.drawDimChip(e.a, e.b)
      const anchor = this.cad.anchor()
      const r = this.dynResolved
      if (anchor && r) this.drawDimChip(anchor, r.point, r.angleDeg, true, r.snapped)
    }
  }

  private drawDimChip(a: Vec2, b: Vec2, angleDeg?: number, live = false, snapped = false) {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 0.02) return
    const ctx = this.ctx
    const mid = this.toScreen((a.x + b.x) / 2, (a.y + b.y) / 2)
    const label =
      angleDeg != null ? `${fmtMeters(len)}  ${Math.round(angleDeg)}°` : fmtMeters(len)
    ctx.save()
    ctx.font = `10px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const w = ctx.measureText(label).width
    // Live (in-progress) chip reads as a filled accent pill; committed chips are
    // quiet accent-on-paper labels (dimension-label style from render.ts).
    ctx.fillStyle = live ? (snapped ? '#1d47c0' : 'rgba(45,91,214,0.92)') : 'rgba(255,255,255,0.9)'
    this.roundRect(ctx, mid.x - w / 2 - 5, mid.y - 8.5, w + 10, 17, 4)
    ctx.fill()
    ctx.fillStyle = live ? '#ffffff' : C.accent
    ctx.fillText(label, mid.x, mid.y)
    ctx.restore()
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  // ---- selection dimensions + click-to-edit (M4, Rayon "the dimension IS the
  //      input"). Purely additive to render/input; guarded to exactly-one
  //      selection and disabled while drawing a chain or in presentation. ----

  /** The single selected CAD line (the app's only length-editable segment
   *  primitive — doc walls are immutable in the wasm surface), or null. */
  private selectedLine(): (CadEntity & { kind: 'line' }) | null {
    const ids = this.cad.selected
    if (ids.size !== 1) return null
    const e = this.cad.store.get([...ids][0])
    return e && e.kind === 'line' ? (e as CadEntity & { kind: 'line' }) : null
  }

  /**
   * Draw the measured dimensions of the current selection and register the
   * editable labels as click targets:
   *  - component → W (top) + H (right) informational size dims, plus editable
   *    X / Y position chips. The wasm Editor exposes no component-resize mutator
   *    (only move_component + set_component_rotation), so click-to-edit is scoped
   *    to POSITION per the editor-UX plan's fallback — clicking X/Y repositions.
   *  - CAD line → an editable length chip at its midpoint (Enter re-lengths the
   *    segment along its current bearing, anchoring endpoint a).
   * Nothing is drawn when nothing is selected (obviously non-destructive).
   */
  private drawSelectionDims() {
    this.dimHits = []
    if (this.presentation || this.dynArmed()) return

    const c = this.getSelected()
    if (c && this.tool === 'select') {
      const ctr = this.toScreen(c.x, c.y)
      const cos = Math.cos(c.rotation)
      const sin = Math.sin(c.rotation)
      // World point from a local (meters) offset, honoring rotation.
      const lp = (lx: number, ly: number) =>
        this.toScreen(c.x + lx * cos - ly * sin, c.y + lx * sin + ly * cos)
      // Place a label just outside an edge midpoint, offset in screen px along
      // the outward normal so the gap is zoom-independent and rotation-correct.
      const edge = (lx: number, ly: number, gap = 15) => {
        const p = lp(lx, ly)
        const dx = p.x - ctr.x
        const dy = p.y - ctr.y
        const d = Math.hypot(dx, dy) || 1
        return { x: p.x + (dx / d) * gap, y: p.y + (dy / d) * gap }
      }
      const hw = c.w / 2
      const hh = c.h / 2
      const wp = edge(0, -hh) // top
      const hp = edge(hw, 0) // right
      const xp = edge(0, hh) // bottom
      const yp = edge(-hw, 0) // left
      this.drawDimLabel(wp.x, wp.y, fmtMeters(c.w), false)
      this.drawDimLabel(hp.x, hp.y, fmtMeters(c.h), false)
      this.drawDimLabel(xp.x, xp.y, `X ${c.x.toFixed(2)}`, true, 'compX', c.id)
      this.drawDimLabel(yp.x, yp.y, `Y ${c.y.toFixed(2)}`, true, 'compY', c.id)
      return
    }

    const ln = this.selectedLine()
    if (ln && this.cad.active) {
      const len = Math.hypot(ln.b.x - ln.a.x, ln.b.y - ln.a.y)
      const mid = this.toScreen((ln.a.x + ln.b.x) / 2, (ln.a.y + ln.b.y) / 2)
      this.drawDimLabel(mid.x, mid.y, fmtMeters(len), true, 'lineLen', ln.id)
    }
  }

  /** Draw one selection-dimension pill (M1 chip visual language: editable →
   *  filled accent, informational → quiet paper). Records a hitbox when editable
   *  so {@link tryOpenDimEditor} can route a click to the inline editor. */
  private drawDimLabel(
    cx: number,
    cy: number,
    text: string,
    editable: boolean,
    kind?: 'compX' | 'compY' | 'lineLen',
    targetId?: number,
  ) {
    const ctx = this.ctx
    ctx.save()
    ctx.font = `10px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(text).width
    const w = tw + 12
    const h = 17
    const x = cx - w / 2
    const y = cy - h / 2
    // Skip the pill that the inline editor is currently covering.
    const hidden = editable && this.dimEditing?.kind === kind && this.dimEditing?.targetId === targetId
    if (!hidden) {
      ctx.fillStyle = editable ? C.accent : 'rgba(255,255,255,0.9)'
      this.roundRect(ctx, x, y, w, h, 4)
      ctx.fill()
      if (!editable) {
        ctx.strokeStyle = 'rgba(45,91,214,0.28)'
        ctx.lineWidth = 1
        this.roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4)
        ctx.stroke()
      }
      ctx.fillStyle = editable ? '#ffffff' : C.accent
      ctx.fillText(text, cx, cy)
    }
    ctx.restore()
    if (editable && kind && targetId != null) {
      this.dimHits.push({ x, y, w, h, kind, targetId })
    }
  }

  private createDimEditor() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const el = document.createElement('input')
    el.type = 'text'
    el.inputMode = 'decimal'
    el.className = 'dim-edit'
    el.setAttribute('data-testid', 'dim-edit')
    // Inline styles keep this self-contained in EditorCanvas (no styles.css edit),
    // while matching the M1 dyn-input look (IBM Plex Mono, accent focus ring).
    Object.assign(el.style, {
      position: 'absolute',
      zIndex: '7',
      display: 'none',
      width: '64px',
      padding: '2px 6px',
      textAlign: 'center',
      font: `12.5px ${MONO}`,
      color: '#1a1d21',
      background: 'rgba(255,255,255,0.98)',
      border: `1.5px solid ${C.accent}`,
      borderRadius: '5px',
      boxShadow: '0 1px 4px rgba(23,26,30,0.18)',
      outline: 'none',
    } as CSSStyleDeclaration)
    el.addEventListener('keydown', (e) => {
      e.stopPropagation() // never leak digits/Enter to the canvas key handlers
      if (e.key === 'Enter') {
        e.preventDefault()
        this.commitDimEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.cancelDimEdit()
      }
    })
    // Committing on blur would fight the Escape path; blur just cancels.
    el.addEventListener('blur', () => this.cancelDimEdit())
    parent.appendChild(el)
    this.dimEditEl = el
  }

  /** Route a canvas click to the inline dimension editor when it lands on an
   *  editable label. Returns true when consumed (so selection/placement is
   *  skipped). Guarded to exactly-one selection via {@link drawSelectionDims}. */
  private tryOpenDimEditor(s: { x: number; y: number }): boolean {
    for (const hb of this.dimHits) {
      if (s.x >= hb.x && s.x <= hb.x + hb.w && s.y >= hb.y && s.y <= hb.y + hb.h) {
        this.openDimEditor(hb)
        return true
      }
    }
    return false
  }

  private openDimEditor(hb: { x: number; y: number; w: number; h: number; kind: 'compX' | 'compY' | 'lineLen'; targetId: number }) {
    const el = this.dimEditEl
    if (!el) return
    let value = ''
    if (hb.kind === 'lineLen') {
      const ln = this.selectedLine()
      if (!ln) return
      value = Math.hypot(ln.b.x - ln.a.x, ln.b.y - ln.a.y).toFixed(2)
    } else {
      const c = this.getSelected()
      if (!c) return
      value = (hb.kind === 'compX' ? c.x : c.y).toFixed(2)
    }
    this.dimEditing = { kind: hb.kind, targetId: hb.targetId }
    el.value = value
    el.style.left = `${Math.round(hb.x + hb.w / 2 - 32)}px`
    el.style.top = `${Math.round(hb.y + hb.h / 2 - 11)}px`
    el.style.display = 'block'
    this.render()
    el.focus()
    el.select()
  }

  private commitDimEdit() {
    const ed = this.dimEditing
    const el = this.dimEditEl
    if (!ed || !el) return this.cancelDimEdit()
    const v = parseDim(el.value)
    if (v == null) return this.cancelDimEdit()
    if (ed.kind === 'lineLen') {
      const ln = this.selectedLine()
      if (ln && ln.id === ed.targetId) {
        this.cad.store.snapshot()
        this.cad.store.update(ln.id, { b: endpointForLength(ln.a, ln.b, v) })
      }
    } else {
      const c = this.getSelected()
      if (c && c.id === ed.targetId) {
        const x = ed.kind === 'compX' ? v : c.x
        const y = ed.kind === 'compY' ? v : c.y
        this.ed.move_component(c.id, x, y)
        this.commit()
      }
    }
    this.closeDimEditor()
  }

  private cancelDimEdit() {
    this.closeDimEditor()
  }

  private closeDimEditor() {
    this.dimEditing = null
    if (this.dimEditEl) this.dimEditEl.style.display = 'none'
    this.render()
  }

  // ---- API consumed by React ----
  getState(): DocState {
    return this.ed.state() as DocState
  }
  getMetrics(): Metrics {
    return this.ed.metrics() as Metrics
  }
  getZoneStats(): ZoneStat[] {
    const ed = this.ed as unknown as { zone_stats?: () => unknown }
    if (typeof ed.zone_stats !== 'function') return []
    return (ed.zone_stats() as ZoneStat[]) ?? []
  }
  getSelected(): DocComponent | null {
    const s = this.getState()
    if (s.selection == null) return null
    return s.components.find((c) => c.id === s.selection) ?? null
  }
  /**
   * Read-only geometry facet of the current selection, for the object inspector.
   * Returns the selected document component (category + x/y/w/h/rotation +
   * binding/decision) or, if the selection points at a wall, its length /
   * thickness / endpoints — else null. Purely derived from `getState()`.
   */
  selectedInfo(): SelectedInfo | null {
    const s = this.getState()
    if (s.selection == null) return null
    const c = s.components.find((x) => x.id === s.selection)
    if (c) {
      return {
        kind: 'component',
        id: c.id,
        category: c.category,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        rotation: c.rotation,
        label: c.label,
        product_id: c.product_id,
        decision: c.decision,
      }
    }
    const wl = s.walls.find((x) => x.id === s.selection)
    if (wl) {
      return {
        kind: 'wall',
        id: wl.id,
        length: Math.hypot(wl.b.x - wl.a.x, wl.b.y - wl.a.y),
        thickness: wl.thickness,
        a: { x: wl.a.x, y: wl.a.y },
        b: { x: wl.b.x, y: wl.b.y },
      }
    }
    return null
  }
  /**
   * Apply an edit to the current selection from the object inspector. Maps a
   * partial patch to the matching `Editor` primitive(s) and commits once. Only
   * component geometry/binding is editable today (walls are not select-hit).
   */
  updateSelected(patch: SelectedPatch) {
    const s = this.getState()
    const id = s.selection
    if (id == null) return
    const c = s.components.find((x) => x.id === id)
    if (!c) return
    if (patch.x !== undefined || patch.y !== undefined) {
      this.ed.move_component(id, patch.x ?? c.x, patch.y ?? c.y)
    }
    if (patch.w !== undefined || patch.h !== undefined) {
      this.ed.set_component_size(id, patch.w ?? c.w, patch.h ?? c.h)
    }
    if (patch.rotation !== undefined) this.ed.set_component_rotation(id, patch.rotation)
    if (patch.category !== undefined) this.ed.set_component_category(id, patch.category)
    if (patch.decision !== undefined) this.ed.set_decision(id, patch.decision)
    if (patch.product_id !== undefined) {
      this.ed.assign_product(id, patch.product_id, patch.product_name ?? c.label, undefined)
    }
    this.commit()
  }
  /** Enter/leave presentation ("paper") mode; repaints and notifies React so
   *  any toggle button can reflect the state. */
  setPresentation(on: boolean) {
    if (this.presentation === on) return
    this.presentation = on
    this.render()
    this.onChange?.()
  }
  setTool(t: ToolId) {
    this.tool = t
    this.wallStart = null
    this.resetDyn()
    if (this.dimEditing) this.closeDimEditor()
    if (t !== 'select' && this.selectedZoneId != null) {
      this.selectedZoneId = null
      this.emitRoom()
    }
    this.canvas.style.cursor = t === 'select' ? '' : 'crosshair'
    this.cad.setTool(t.startsWith('cad:') ? t.slice(4) : null)
    this.render()
  }
  assignProduct(id: number, productId: string, name: string, priceInr?: number | null) {
    this.ed.assign_product(id, productId, name, priceInr ?? undefined)
    this.commit()
  }
  setDecision(id: number, state: string) {
    this.ed.set_decision(id, state)
    this.commit()
  }
  deleteSelected() {
    this.ed.delete_selected()
    this.commit()
  }

  // ---- rooms: selection + contextual ops (composed from core bindings) ----
  private zones(): DocZone[] {
    return this.getState().zones ?? []
  }
  private zoneById(id: number): DocZone | null {
    return this.zones().find((z) => z.id === id) ?? null
  }
  getSelectedZone(): DocZone | null {
    return this.selectedZoneId == null ? null : this.zoneById(this.selectedZoneId)
  }

  /** Select a room by zone id (clears component selection); null to deselect. */
  selectRoom(id: number | null) {
    this.selectedZoneId = id
    if (id != null) this.ed.clear_selection()
    this.emitRoom(true)
    this.commit()
  }

  /** Reclassify a room's type and rename it to that type's default label. */
  setZoneTypeRoom(id: number, type: ZoneType) {
    this.ed.set_zone_type(id, type)
    this.ed.rename_zone(id, ZONE_LABEL[type] ?? type)
    this.selectedZoneId = id
    this.emitRoom(true)
    this.commit()
  }

  /** Delete a room (its zone + the furniture inside it). */
  deleteRoom(id: number) {
    this.ed.delete_zone(id)
    this.selectRoom(null)
  }

  /** Split a rectangular room in half along its longer axis. */
  splitRoom(id: number) {
    const z = this.zoneById(id)
    if (!z || z.shape.kind !== 'Rect') return
    const s = z.shape
    if (s.w >= s.h) this.ed.split_zone(id, 'Vertical', s.x)
    else this.ed.split_zone(id, 'Horizontal', s.y)
    this.emitRoom(true)
    this.commit()
  }

  /** Duplicate a rectangular room + its furniture, offset into free space. */
  duplicateRoom(id: number) {
    const z = this.zoneById(id)
    if (!z || z.shape.kind !== 'Rect') return
    const s = z.shape
    const bb = this.wallWorldBBox()
    // Offset by 1 m, clamped so the copy's bbox stays on the plate.
    let off = 1
    if (bb) off = Math.min(off, Math.max(0, bb.maxX - (s.x + s.w / 2)), Math.max(0, bb.maxY - (s.y + s.h / 2)))
    const members = this.getState().components.filter((c) => z.component_ids.includes(c.id))
    const newId = Number(this.ed.add_zone(z.zone_type, s.x + off, s.y + off, s.w, s.h, `${z.label} copy`))
    for (const c of members) this.ed.add_component(c.category, c.x + off, c.y + off, c.w, c.h)
    this.selectedZoneId = newId
    this.emitRoom(true)
    this.commit()
  }

  /**
   * Rotate a rectangular room 90° clockwise about its center. The zone Rect
   * swaps w/h (center fixed); every furniture member and interior wall is
   * rotated about that center — positions turn AND each component gains 90° of
   * `rotation` so the piece itself (chair/monitor) turns with the room. If the
   * swapped box would leave the plate it's translated back on (everything with
   * it, so members stay aligned). Rings aren't Rect → skipped, like resize.
   * Four calls return to the original orientation (4×90° = identity).
   */
  rotateRoom(id: number, deg = 90) {
    const z = this.zoneById(id)
    if (!z || z.shape.kind !== 'Rect') return // rings aren't rotatable (non-Rect)
    const s = z.shape
    const cx = s.x
    const cy = s.y
    // Number of clockwise quarter-turns (only 90° multiples keep an axis-aligned Rect).
    const turns = ((Math.round(deg / 90) % 4) + 4) % 4
    if (turns === 0) return
    const quarter = (Math.PI / 2) * turns
    // Clockwise quarter-turn about center in the Y-down plan: (dx,dy) → (-dy,dx).
    const rot = (px: number, py: number) => {
      let dx = px - cx
      let dy = py - cy
      for (let i = 0; i < turns; i++) {
        const ndx = -dy
        const ndy = dx
        dx = ndx
        dy = ndy
      }
      return { x: cx + dx, y: cy + dy }
    }
    // Odd turns swap w/h; even turns keep them.
    const newW = turns % 2 === 1 ? s.h : s.w
    const newH = turns % 2 === 1 ? s.w : s.h
    // Clamp the swapped box back onto the plate; translate the whole room by the
    // same (grid-snapped) delta so members stay aligned inside it.
    const snap = (v: number) => Math.round(v / SNAP_M) * SNAP_M
    let sdx = 0
    let sdy = 0
    const bb = this.wallWorldBBox()
    if (bb) {
      // If the swapped box can't fit the plate in an axis, no translation can
      // bring it fully on-plate — clamping one edge would shove furniture off the
      // opposite side (a wide room rotated onto a plate too short to hold its
      // length). Refuse the rotation (no-op) rather than let furniture escape.
      const eps = 1e-6
      if (newW > bb.maxX - bb.minX + eps || newH > bb.maxY - bb.minY + eps) return
      const left = cx - newW / 2
      const right = cx + newW / 2
      const top = cy - newH / 2
      const bottom = cy + newH / 2
      if (left < bb.minX) sdx = bb.minX - left
      else if (right > bb.maxX) sdx = bb.maxX - right
      if (top < bb.minY) sdy = bb.minY - top
      else if (bottom > bb.maxY) sdy = bb.maxY - bottom
    }
    sdx = snap(sdx)
    sdy = snap(sdy)
    const members = this.getState().components.filter((c) => z.component_ids.includes(c.id))
    for (const c of members) {
      const p = rot(c.x, c.y)
      this.ed.move_component(c.id, snap(p.x + sdx), snap(p.y + sdy))
      // Normalize into [0, 2π) so 4 turns land exactly back on the original value.
      const nr = (((c.rotation + quarter) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      this.ed.set_component_rotation(c.id, nr)
    }
    for (const wl of this.interiorWalls(this.zoneWorldBBox(z))) {
      const a = rot(wl.a.x, wl.a.y)
      const b = rot(wl.b.x, wl.b.y)
      this.ed.set_wall(wl.id, snap(a.x + sdx), snap(a.y + sdy), snap(b.x + sdx), snap(b.y + sdy))
    }
    this.ed.resize_zone(id, snap(cx + sdx), snap(cy + sdy), newW, newH)
    // Permanent invariant (DEV): after a rotation every member must still sit on
    // the plate. The fit-guard + shared translate guarantee this; a fire here
    // means a regression in either. (snap can nudge a member ≤½ a grid cell past
    // a wall, so allow SNAP_M/2 slack.)
    if (import.meta.env.DEV && bb) {
      const slack = SNAP_M / 2 + 1e-6
      for (const c of this.getState().components.filter((m) => z.component_ids.includes(m.id))) {
        if (c.x < bb.minX - slack || c.x > bb.maxX + slack || c.y < bb.minY - slack || c.y > bb.maxY + slack)
          console.error(`rotateRoom: member ${c.id} escaped the plate at (${c.x}, ${c.y})`, bb)
      }
    }
    this.selectedZoneId = id
    this.emitRoom(true)
    this.commit()
  }

  // ---- room geometry / hit-testing helpers ----
  private wallWorldBBox() {
    const bb = wallBbox(this.getState().walls)
    return bb ? { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY } : null
  }
  private zoneWorldBBox(z: DocZone) {
    const s = z.shape
    if (s.kind === 'Poly') {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [px, py] of s.pts) {
        minX = Math.min(minX, px)
        minY = Math.min(minY, py)
        maxX = Math.max(maxX, px)
        maxY = Math.max(maxY, py)
      }
      return { minX, minY, maxX, maxY }
    }
    return { minX: s.x - s.w / 2, minY: s.y - s.h / 2, maxX: s.x + s.w / 2, maxY: s.y + s.h / 2 }
  }
  /** Selected room box in screen px (top-left origin). */
  private roomScreenBox(z: DocZone) {
    const bb = this.zoneWorldBBox(z)
    const p0 = this.toScreen(bb.minX, bb.minY)
    const p1 = this.toScreen(bb.maxX, bb.maxY)
    return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y }
  }
  /** Topmost non-MeetingRoom component whose footprint covers world point w. */
  private topFurnitureAt(w: { x: number; y: number }): DocComponent | null {
    const comps = this.getState().components
    for (let i = comps.length - 1; i >= 0; i--) {
      const c = comps[i]
      if (c.category === 'MeetingRoom') continue
      if (Math.abs(c.x - w.x) <= c.w / 2 && Math.abs(c.y - w.y) <= c.h / 2) return c
    }
    return null
  }
  /** Index of the selected room's resize handle under screen point s, or null. */
  private handleAt(s: { x: number; y: number }): number | null {
    const z = this.getSelectedZone()
    if (!z || z.shape.kind !== 'Rect') return null
    const pts = handlePoints(this.roomScreenBox(z))
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i].x - s.x) <= HANDLE_HIT_PX && Math.abs(pts[i].y - s.y) <= HANDLE_HIT_PX) return i
    }
    return null
  }

  /** Walls that belong to a room and travel with it on drag/resize. Test is
   *  boundary-INCLUSIVE (bbox expanded by `eps`): a room's own enclosing/partition
   *  walls sit ON its bbox edges (endpoints at x≈minX/maxX or y≈minY/maxY), so a
   *  strict interior test dropped them and they stayed behind on drag. The
   *  expanded box still excludes a neighbour room's far wall (it lies beyond the
   *  room's own perimeter by more than `eps`). */
  private interiorWalls(bb: { minX: number; minY: number; maxX: number; maxY: number }) {
    const eps = 0.15
    const inside = (p: { x: number; y: number }) =>
      p.x >= bb.minX - eps && p.x <= bb.maxX + eps && p.y >= bb.minY - eps && p.y <= bb.maxY + eps
    return this.getState().walls.filter((wl) => inside(wl.a) && inside(wl.b))
  }

  // ---- room drag / resize (called from pointer handlers) ----
  private beginRoomDrag(zoneId: number, w: { x: number; y: number }) {
    const z = this.zoneById(zoneId)
    // Rect and Poly rooms drag; a RectRing (perimeter circulation) doesn't.
    // A Poly is dragged via its bounding box — the core exposes no Poly-preserving
    // move (`resize_zone`/`add_zone` build only `Rect`), so the first grid-step of
    // movement re-homes it as its rectangular footprint (honest limit; see
    // updateRoomDrag). Seeding zone0 from the bbox makes both paths identical.
    if (!z || (z.shape.kind !== 'Rect' && z.shape.kind !== 'Poly')) return
    const bb = this.zoneWorldBBox(z)
    const zone0 = {
      x: (bb.minX + bb.maxX) / 2,
      y: (bb.minY + bb.maxY) / 2,
      w: bb.maxX - bb.minX,
      h: bb.maxY - bb.minY,
    }
    const comps = this.getState()
      .components.filter((c) => z.component_ids.includes(c.id))
      .map((c) => ({ id: c.id, x0: c.x, y0: c.y }))
    const walls = this.interiorWalls(bb).map((wl) => ({
      id: wl.id,
      ax0: wl.a.x,
      ay0: wl.a.y,
      bx0: wl.b.x,
      by0: wl.b.y,
    }))
    this.roomDrag = { zoneId, start: w, zone0, comps, walls }
  }

  private updateRoomDrag(screen: { x: number; y: number }) {
    const rd = this.roomDrag
    if (!rd) return
    const w = this.toWorld(screen.x, screen.y)
    let dx = w.x - rd.start.x
    let dy = w.y - rd.start.y
    const bb = this.wallWorldBBox()
    if (bb) {
      dx = clampN(dx, bb.minX - (rd.zone0.x - rd.zone0.w / 2), bb.maxX - (rd.zone0.x + rd.zone0.w / 2))
      dy = clampN(dy, bb.minY - (rd.zone0.y - rd.zone0.h / 2), bb.maxY - (rd.zone0.y + rd.zone0.h / 2))
    }
    dx = Math.round(dx / SNAP_M) * SNAP_M
    dy = Math.round(dy / SNAP_M) * SNAP_M
    // No net movement → don't touch the document. Keeps a plain select-click on a
    // Poly non-destructive (a jittered sub-grid drag never re-homes it to a Rect).
    if (dx === 0 && dy === 0) return
    for (const c of rd.comps) this.ed.move_component(c.id, c.x0 + dx, c.y0 + dy)
    for (const wl of rd.walls) this.ed.set_wall(wl.id, wl.ax0 + dx, wl.ay0 + dy, wl.bx0 + dx, wl.by0 + dy)
    this.ed.resize_zone(rd.zoneId, rd.zone0.x + dx, rd.zone0.y + dy, rd.zone0.w, rd.zone0.h)
    this.emitRoom(true)
    this.commit()
  }

  private beginRoomResize(handle: number, zoneId: number) {
    const z = this.zoneById(zoneId)
    if (!z || z.shape.kind !== 'Rect') return
    const s = z.shape
    const frac = (v: number, o: number, size: number) => (v - o) / size
    const comps = this.getState()
      .components.filter((c) => z.component_ids.includes(c.id))
      .map((c) => ({ id: c.id, fx: frac(c.x, s.x, s.w), fy: frac(c.y, s.y, s.h) }))
    const walls = this.interiorWalls(this.zoneWorldBBox(z)).map((wl) => ({
      id: wl.id,
      afx: frac(wl.a.x, s.x, s.w),
      afy: frac(wl.a.y, s.y, s.h),
      bfx: frac(wl.b.x, s.x, s.w),
      bfy: frac(wl.b.y, s.y, s.h),
    }))
    this.roomResize = { zoneId, handle, zone0: { x: s.x, y: s.y, w: s.w, h: s.h }, comps, walls }
  }

  private updateRoomResize(screen: { x: number; y: number }) {
    const rr = this.roomResize
    if (!rr) return
    const w = this.toWorld(screen.x, screen.y)
    const snap = (v: number) => Math.round(v / SNAP_M) * SNAP_M
    const z0 = rr.zone0
    let left = z0.x - z0.w / 2
    let right = z0.x + z0.w / 2
    let top = z0.y - z0.h / 2
    let bottom = z0.y + z0.h / 2
    const h = rr.handle
    if (h === 0 || h === 6 || h === 7) left = snap(w.x) // left-edge handles
    if (h === 2 || h === 3 || h === 4) right = snap(w.x) // right-edge handles
    if (h === 0 || h === 1 || h === 2) top = snap(w.y) // top-edge handles
    if (h === 4 || h === 5 || h === 6) bottom = snap(w.y) // bottom-edge handles
    // enforce a minimum size (push the moving edge back if it crosses)
    if (right - left < ROOM_MIN_M) {
      if (h === 0 || h === 6 || h === 7) left = right - ROOM_MIN_M
      else right = left + ROOM_MIN_M
    }
    if (bottom - top < ROOM_MIN_M) {
      if (h === 0 || h === 1 || h === 2) top = bottom - ROOM_MIN_M
      else bottom = top + ROOM_MIN_M
    }
    // clamp to the plate
    const bb = this.wallWorldBBox()
    if (bb) {
      left = Math.max(left, bb.minX)
      top = Math.max(top, bb.minY)
      right = Math.min(right, bb.maxX)
      bottom = Math.min(bottom, bb.maxY)
    }
    const nx = (left + right) / 2
    const ny = (top + bottom) / 2
    const nw = right - left
    const nh = bottom - top
    for (const c of rr.comps) this.ed.move_component(c.id, nx + c.fx * nw, ny + c.fy * nh)
    for (const wl of rr.walls) {
      this.ed.set_wall(wl.id, nx + wl.afx * nw, ny + wl.afy * nh, nx + wl.bfx * nw, ny + wl.bfy * nh)
    }
    this.ed.resize_zone(rr.zoneId, nx, ny, nw, nh)
    this.emitRoom(true)
    this.commit()
  }

  /** Push the current room selection + its screen box to the floating toolbar. */
  private emitRoom(force = false) {
    if (!this.onRoom) return
    if (this.selectedZoneId == null) {
      if (this.lastRoomKey !== null || force) this.onRoom(null)
      this.lastRoomKey = null
      return
    }
    const z = this.zoneById(this.selectedZoneId)
    if (!z) {
      this.onRoom(null)
      this.lastRoomKey = null
      return
    }
    const b = this.roomScreenBox(z)
    const box = { left: b.x, top: b.y, width: b.w, height: b.h }
    const key = `${z.id}:${z.zone_type}:${z.label}:${Math.round(b.x)}:${Math.round(b.y)}:${Math.round(b.w)}:${Math.round(b.h)}`
    if (!force && key === this.lastRoomKey) return
    this.lastRoomKey = key
    this.onRoom({ zone: z, box })
  }

  private updateHoverCursor(s: { x: number; y: number }) {
    let cur = ''
    const z = this.getSelectedZone()
    if (z && z.shape.kind === 'Rect') {
      const hi = this.handleAt(s)
      if (hi != null) cur = HANDLE_CURSOR[hi]
      else if (inScreenBox(this.roomScreenBox(z), s)) cur = 'move'
    }
    if (!cur) {
      const w = this.toWorld(s.x, s.y)
      if (this.topFurnitureAt(w)) cur = 'pointer'
      else if (this.ed.zone_at(w.x, w.y) != null) cur = 'move'
      else cur = 'default'
    }
    this.canvas.style.cursor = cur
  }

  /** One deterministic test-fit for `seed`; mutates the document. */
  generateOnce(program: Program, seed: number, keepConfirmed = false): LayoutScore {
    return this.ed.generate(program, BigInt(seed), keepConfirmed) as LayoutScore
  }

  /**
   * Autonomous test-fit search across the three STRATEGIES (M7). Each strategy
   * runs its OWN seed search (early-stopping once `target` total is met) and
   * contributes its single best-scoring plan, so the gallery's A/B/C are
   * strategically DISTINCT — Open (dense open field) · Balanced (professional
   * mix) · Cellular (privacy-forward) — a real trade-off, not seed-noise. The
   * Rust generator is deterministic per (strategy, seed); the live document is
   * restored to the overall best-scoring option at the end.
   *
   * Seeds are kept in disjoint per-strategy ranges (`strategyIndex·STRIDE + s`)
   * so a candidate's `seed` is globally unique — the gallery keys by it — while
   * `(strategy, seed)` still reproduces the exact plan. When `keepConfirmed` is
   * set, Confirmed components are frozen and every candidate packs around them.
   *
   * `seedOffset` slides the searched seed WINDOW within each strategy's stride
   * band: the UI advances it every Regenerate press so consecutive presses
   * explore genuinely different seeds (real variety) while any exact
   * `(strategy, seed)` stays deterministic. It is wrapped inside the stride so a
   * candidate's global seed remains unique per strategy.
   */
  autoGenerate(
    program: Program,
    opts: { maxIter: number; target: number; keepConfirmed?: boolean; seedOffset?: number },
  ): GenResult {
    const keep = opts.keepConfirmed ?? false
    this.program = { ...program }
    const STRIDE = STRATEGY_SEED_STRIDE
    // Keep the window (offset+1 .. offset+maxIter) inside the strategy's stride
    // band so global seeds never collide across strategies.
    const offset = seedWindowOffset(opts.seedOffset ?? 0, opts.maxIter)
    const candidates: Candidate[] = []
    let iterations = 0
    STRATEGIES.forEach((strategy, si) => {
      const sp: Program = { ...program, strategy }
      let best: LayoutScore | null = null
      let bestSeed = si * STRIDE + offset + 1
      for (let seed = 1; seed <= opts.maxIter; seed++) {
        iterations++
        const actual = si * STRIDE + offset + seed
        const sc = this.ed.generate(sp, BigInt(actual), keep) as LayoutScore
        if (!best || sc.total > best.total) {
          best = sc
          bestSeed = actual
        }
        if (best.total >= opts.target) break
      }
      // Re-generate the strategy's winning seed to capture its snapshot + thumb.
      const finalSc = this.ed.generate(sp, BigInt(bestSeed), keep) as LayoutScore
      candidates.push({
        seed: bestSeed,
        strategy,
        score: finalSc,
        snap: this.ed.snapshot(),
        thumb: renderThumb(this.getState()),
      })
    })
    // The live document reflects the overall best-scoring option (candidates
    // stay in strategy order so A/B/C map to Open/Balanced/Cellular).
    const best = candidates.reduce((a, b) => (b.score.total > a.score.total ? b : a))
    this.ed.restore(best.snap as string)
    this.hydrateCad()
    this.ed.clear_selection()
    this.commit()
    return { best: best.score, iterations, seed: best.seed, candidates }
  }

  /**
   * Autonomous REASONING loop (the vision's generate→evaluate→optimize): an
   * initial {@link autoGenerate}, then up to `refineIters` rounds where Claude
   * SHAPES the next batch — proposing a bounded program delta (desks / meetings
   * / corridor / cluster density / adjacency + circulation emphasis) via the
   * `adjust_program` tool — which we apply, regenerate, and KEEP only if a
   * FIXED-weight yardstick ({@link refScore} under the ORIGINAL weights) rises.
   * A rejected round is reverted (only the winner stays live); a null delta or a
   * non-improving round ends the loop early (convergence). Each round's rationale
   * is captured in `steps`.
   *
   * WITHOUT a Claude key this is a clean no-op: it returns the plain
   * autoGenerate result with `ranAI: false` — generation is never blocked.
   * Latency is bounded: iterations are capped 1–3 and the search runs on the
   * live doc but every trial is snapshot-guarded so only the accepted plan
   * survives.
   */
  async refineWithAI(
    program: Program,
    opts: {
      maxIter: number
      target: number
      keepConfirmed?: boolean
      seedOffset?: number
      refineIters?: number
      softGoals?: string
    },
  ): Promise<RefineOutcome> {
    const gen = { maxIter: opts.maxIter, target: opts.target, keepConfirmed: opts.keepConfirmed, seedOffset: opts.seedOffset }
    // Fixed rubric: the ORIGINAL weights, so re-weighting deltas are judged fairly.
    const refWeights: Program = { ...program }
    const base = this.autoGenerate(program, gen)
    const baseScore = refScore(base.best, refWeights)

    let curProgram: Program = { ...program }
    let curResult = base
    let curScore = baseScore
    const steps: RefineStep[] = []

    if (!(await evaluatorAvailable())) {
      return { result: base, program: curProgram, steps, baseScore, finalScore: baseScore, improved: false, ranAI: false }
    }

    let liveSnap = this.snapshot() // the last ACCEPTED plan (currently `base`)
    const rounds = Math.max(1, Math.min(3, opts.refineIters ?? 3))
    const softGoals =
      opts.softGoals?.trim() ||
      'Balance a dense open-desk field with legible circulation and coherent room adjacencies.'

    for (let i = 0; i < rounds; i++) {
      const delta: ProgramDelta | null = await proposeAdjustment({
        program: curProgram,
        best: curResult.best,
        zones: this.getZoneStats(),
        softGoals,
      })
      if (!delta) break // converged / declined / errored

      const nextProgram = applyDelta(curProgram, delta)
      if (this.programLeversEqual(nextProgram, curProgram)) {
        // Clamped down to no change — record the rationale, then stop.
        steps.push({ iteration: i + 1, rationale: delta.rationale ?? '', delta, scoreBefore: curScore, scoreAfter: curScore, accepted: false })
        break
      }

      const trial = this.autoGenerate(nextProgram, gen)
      const trialScore = refScore(trial.best, refWeights)
      const accepted = trialScore > curScore + 1e-6
      steps.push({ iteration: i + 1, rationale: delta.rationale ?? '', delta, scoreBefore: curScore, scoreAfter: trialScore, accepted })

      if (accepted) {
        curProgram = nextProgram
        curResult = trial
        curScore = trialScore
        liveSnap = this.snapshot() // this trial is the new winner (already live)
      } else {
        this.restore(liveSnap) // revert: keep the last accepted plan live
        break
      }
    }

    this.program = { ...curProgram }
    return { result: curResult, program: curProgram, steps, baseScore, finalScore: curScore, improved: curScore > baseScore + 1e-6, ranAI: true }
  }

  /**
   * AGENTIC SENIOR DESIGNER (docs/design/agentic-designer.md, phase 1). Claude
   * DESIGNS the program from a brief — deciding headcount, desk + meeting counts,
   * the spatial strategy, the support-room mix with placement bias, and objective
   * emphasis — and APPLIES it to `this.program`. The caller then generates (the UI
   * runs the normal seed-search so Claude's design gets the A/B/C gallery + gates;
   * a script can `generateOnce`). Geometry stays entirely with the solver — Claude
   * never emits coordinates. A plate must exist (walls); the design is sized to the
   * net internal area. Returns the spec (incl. Claude's rationale), or `null`
   * without a Claude key / on failure (design is never blocking — fall back to
   * Generate).
   */
  async designWithAI(brief: string, signal?: AbortSignal): Promise<DesignSpec | null> {
    const m = this.getMetrics()
    if (m.wall_count === 0) return null // no plate to design for
    const plateAreaM2 = m.net_internal_area ?? m.floor_area
    const spec = await proposeDesign({ plateAreaM2, program: this.program, brief }, signal)
    if (!spec) return null
    this.program = applyDesignSpec(this.program, spec)
    return spec
  }

  /**
   * MULTI-OBJECTIVE designer (docs/design/agentic-designer.md; Laiout-style option
   * set). Claude designs a DISTINCT fit per objective — Max people / Budget / Low
   * carbon / Wellbeing / Balanced — and the solver realizes each; every option
   * carries its headline metric (pax · ₹ fit-out · kgCO₂e) for the option cards.
   * Snapshots are captured so the UI can make any option live. Leaves the program
   * unchanged. Returns [] without a Claude key / plate.
   */
  async designOptions(brief: string, seed = 1, signal?: AbortSignal): Promise<DesignOptionResult[]> {
    const m0 = this.getMetrics()
    if (m0.wall_count === 0) return []
    const plateAreaM2 = m0.net_internal_area ?? m0.floor_area
    const opts = await proposeDesignOptions({ plateAreaM2, program: this.program, brief }, DESIGN_OBJECTIVES, signal)
    const base = { ...this.program }
    const out: DesignOptionResult[] = []
    for (const o of opts) {
      this.program = applyDesignSpec(base, o.spec)
      const score = this.generateOnce(this.program, seed)
      const m = this.getMetrics()
      out.push({
        objective: o.objective,
        spec: o.spec,
        score,
        pax: m.workstations ?? 0,
        cost: m.indicative_cost ?? 0,
        carbon: m.indicative_carbon ?? 0,
        nia: m.net_internal_area ?? 0,
        snapshot: this.ed.snapshot() as string,
        thumb: renderThumb(this.getState()),
      })
    }
    this.program = base
    return out
  }

  /** True when two programs match on every lever the AI delta can touch. */
  private programLeversEqual(a: Program, b: Program): boolean {
    return (
      a.desks === b.desks &&
      a.meeting_rooms === b.meeting_rooms &&
      a.target_corridor_m === b.target_corridor_m &&
      a.cluster_cols === b.cluster_cols &&
      a.w_adjacency === b.w_adjacency &&
      a.w_circulation === b.w_circulation
    )
  }

  /** Make a gallery candidate live: restore its snapshot, repaint, notify React.
   *  The user's CAD drafting layer is preserved across the switch — layout
   *  options differ in layout, not in drafting; `restore()` (undo) keeps true
   *  time-travel semantics instead. */
  applyCandidate(snap: unknown): void {
    const cad = this.ed.get_cad_json()
    this.ed.restore(snap as string)
    this.ed.set_cad_json(cad)
    this.ed.clear_selection()
    this.hydrateCad()
    this.refresh()
    this.onChange?.()
  }

  /** Circulation / "walking place" evaluation of the current document. */
  circulation(): CirculationScore {
    return this.ed.circulation() as CirculationScore
  }
  /** Re-measure + repaint. Call after the canvas becomes visible again (2D/3D toggle). */
  refresh() {
    this.resize()
    this.render()
    this.updateScaleReadout()
  }

  /** Frame the document so the PLATE/SHELL sits centered and fully visible in the
   *  current viewport. `padding` is the fraction of the viewport kept clear on
   *  each side. No-op when the document is empty.
   *
   *  Robustness — two failure modes this guards against (see
   *  docs/design/laiout-deep-research.md §2.4):
   *  1. **Outlier CAD entities.** Imported DXFs carry stray geometry far from the
   *     plate (leaders, site lines, title blocks). Framing to the raw entity set
   *     blows the span up and clamps scale to the 8 px/m floor, cornering the
   *     plan. So we anchor to the walls+components bbox (the real shell) and admit
   *     a CAD entity only when it overlaps a generous margin of that anchor. A
   *     pure CAD doc (no walls/components) still frames to all its entities.
   *  2. **Viewport not yet measured on open.** A saved plan can open before layout
   *     has sized the canvas; a zero/tiny measurement would mis-frame. We retry on
   *     the next frame (capped) until the canvas has a real size. */
  frameContent(padding = 0.08, isRetry = false) {
    // A fresh (non-retry) request must start with a full retry budget. The counter
    // is instance state shared across every frame attempt and is only cleared on a
    // SUCCESSFUL frame — so if a prior sequence exhausted it against a hidden canvas
    // and never succeeded, it would stay saturated and make THIS open give up on its
    // first tiny measurement and never frame (a permanent cripple). Reset on entry.
    if (!isRetry) this.frameRetries = 0
    // Ensure the canvas is measured (may be freshly un-hidden from 3D/route change).
    this.resize()
    // Gate on the CONTAINER, never the canvas. resize() bails on a collapsed
    // container (0-size, mid-route-mount) leaving the canvas at its 300×150
    // intrinsic default — a canvas-based guard would pass that and frame the plan
    // into a tiny corner at the 8 px/m floor (the "opens tiny" bug). Not laid out
    // yet → mark the frame pending (the ResizeObserver finishes it when layout
    // settles) and retry on rAF, capped so a genuinely hidden canvas doesn't spin.
    const vp = this.viewportReady()
    if (!vp) {
      this.frameOnLayout = true
      if (this.frameRetries < FRAME_MAX_RETRIES) {
        this.frameRetries++
        requestAnimationFrame(() => this.frameContent(padding, true))
      }
      return
    }
    const w = vp.w
    const h = vp.h
    this.frameRetries = 0
    this.frameOnLayout = false

    const st = this.getState()
    // Anchor to the shell: walls + placed/generated components. This is the clean
    // extent a user expects to see, free of stray CAD outliers.
    let aMinX = Infinity
    let aMinY = Infinity
    let aMaxX = -Infinity
    let aMaxY = -Infinity
    const anchor = (ax: number, ay: number, bx: number, by: number) => {
      aMinX = Math.min(aMinX, ax)
      aMinY = Math.min(aMinY, ay)
      aMaxX = Math.max(aMaxX, bx)
      aMaxY = Math.max(aMaxY, by)
    }
    const wb = wallBbox(st.walls)
    if (wb) anchor(wb.minX, wb.minY, wb.maxX, wb.maxY)
    for (const c of st.components) anchor(c.x - c.w / 2, c.y - c.h / 2, c.x + c.w / 2, c.y + c.h / 2)
    const hasAnchor = isFinite(aMinX)

    let minX = aMinX
    let minY = aMinY
    let maxX = aMaxX
    let maxY = aMaxY
    const acc = (ax: number, ay: number, bx: number, by: number) => {
      minX = Math.min(minX, ax)
      minY = Math.min(minY, ay)
      maxX = Math.max(maxX, bx)
      maxY = Math.max(maxY, by)
    }
    if (hasAnchor) {
      // Admit only CAD entities that overlap the anchor grown by a generous margin
      // (one full plan-span on each side). Doors/windows/dims drawn on the shell
      // stay in frame; a leader 1000 m away is dropped so it can't force 8 px/m.
      const margin = FRAME_ENTITY_MARGIN * Math.max(aMaxX - aMinX, aMaxY - aMinY, 1)
      const gMinX = aMinX - margin
      const gMinY = aMinY - margin
      const gMaxX = aMaxX + margin
      const gMaxY = aMaxY + margin
      for (const e of this.cad.store.entities) {
        const [ex0, ey0, ex1, ey1] = entityBBox(e)
        if (ex1 < gMinX || ex0 > gMaxX || ey1 < gMinY || ey0 > gMaxY) continue // outlier: no overlap
        // Clip the admitted entity to the grown-anchor window before accumulating.
        // Rejecting only entities that are ENTIRELY outside isn't enough: a single
        // entity that OVERLAPS or ENCLOSES the shell — a title-block border around the
        // whole sheet, a grid/match/construction line that starts on the plate and runs
        // out to 900 m (both routine in imported DXFs) — passes the overlap test and,
        // taken at full extent, re-inflates the span straight back to the 8 px/m floor
        // and corners the plan (the very symptom this method guards against). Clipping
        // caps each entity's contribution to shell + one span-margin: bounded and sane.
        acc(Math.max(ex0, gMinX), Math.max(ey0, gMinY), Math.min(ex1, gMaxX), Math.min(ey1, gMaxY))
      }
    } else {
      // No shell — a hand-drawn CAD-only doc: frame to all its entities.
      for (const e of this.cad.store.entities) {
        const [ex0, ey0, ex1, ey1] = entityBBox(e)
        acc(ex0, ey0, ex1, ey1)
      }
    }
    if (!isFinite(minX)) return // no content

    const spanX = Math.max(maxX - minX, 0.001)
    const spanY = Math.max(maxY - minY, 0.001)
    const availW = w * (1 - 2 * padding)
    const availH = h * (1 - 2 * padding)
    const k = clampN(Math.min(availW / spanX, availH / spanY), 8, 300)
    this.scale = k
    // Map the content center onto the viewport center under screenX = wx*k + off.x.
    this.offset.x = w / 2 - ((minX + maxX) / 2) * k
    this.offset.y = h / 2 - ((minY + maxY) / 2) * k

    this.render()
    this.updateScaleReadout()
  }

  /** Repaint + notify React. Call after mutating the doc directly (e.g. the AI). */
  sync() {
    this.render()
    this.onChange?.()
  }

  /** Opaque lossless snapshot of the whole document (undo + dry-run source). */
  snapshot(): string {
    return this.ed.snapshot() as string
  }
  restore(snap: string) {
    this.ed.restore(snap)
    this.hydrateCad()
    this.sync()
  }

  /** Wipe the document to a fresh empty doc (import→test-fit bridge). */
  clearAll() {
    this.ed = new Editor()
    this.hydrateCad()
    this.sync()
  }

  /** The CAD drafting entities (live store array) — export/orchestration reads. */
  cadEntities(): CadEntity[] {
    return this.cad.store.entities
  }

  /** Replace the CAD store from the document's cad_json blob (after restore/clear). */
  private hydrateCad() {
    this.cadHydrating = true
    try {
      const json = this.ed.get_cad_json()
      this.cad.store.load(json ? (JSON.parse(json) as CadEntity[]) : [])
    } finally {
      this.cadHydrating = false
    }
  }

  private commit() {
    this.render()
    this.onChange?.()
  }

  // ---- events ----
  private attach() {
    this.canvas.addEventListener('mousedown', this.onDown)
    window.addEventListener('mousemove', this.onMove)
    window.addEventListener('mouseup', this.onUp)
    this.canvas.addEventListener('mouseleave', this.onLeave)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onCtx)
    window.addEventListener('resize', this.onResize)
    this.setActive(true)
  }

  /** Whether the window-level KEY listeners are currently bound. */
  private keysBound = false

  /**
   * Bind or unbind this canvas's window-level keyboard listeners.
   *
   * These are on `window` (not the canvas) because the canvas isn't focusable and
   * shortcuts must work with the pointer anywhere over the editor. The cost is
   * that they keep firing when the editor is merely HIDDEN — and EditorView is
   * deliberately never unmounted, so it is hidden behind every wizard step. That
   * let `Delete` remove a component from a document the user could not see
   * (133 → 132, no click, no feedback), `p` toggle Presentation, and `Escape`
   * clear the selection, all from the upload screen.
   *
   * The fix is structural rather than a check inside each handler: when the
   * editor is not the active surface the listeners are NOT BOUND, so a handler
   * added later inherits the behaviour instead of having to remember a guard.
   * Mouse and resize listeners stay — the canvas has no pointer events while
   * `display:none`, and resize must keep the backing store correct so the view
   * is right the moment it is shown again.
   */
  setActive(on: boolean): void {
    if (on === this.keysBound) return
    this.keysBound = on
    if (on) {
      window.addEventListener('keydown', this.onKey)
      window.addEventListener('keyup', this.onKeyUp)
    } else {
      window.removeEventListener('keydown', this.onKey)
      window.removeEventListener('keyup', this.onKeyUp)
      // Drop transient modifier state so returning to the editor doesn't resume
      // mid-gesture (a Space-pan armed before navigating away, say).
      this.shiftDown = false
      this.altDown = false
      this.spaceDown = false
    }
  }
  dispose() {
    this.canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    this.canvas.removeEventListener('mouseleave', this.onLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onCtx)
    this.setActive(false)
    window.removeEventListener('resize', this.onResize)
    this.containerObserver?.disconnect()
    this.dynEl?.remove()
    this.dimEditEl?.remove()
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.shiftDown = e.shiftKey
    this.altDown = e.altKey
    if (e.code === 'Space') {
      this.spaceDown = false
      if (!this.panning) this.canvas.style.cursor = ''
    }
    // Releasing Shift/Alt changes the polar constraint → repaint the ghost.
    if (e.key === 'Shift' || e.key === 'Alt') this.render()
  }

  private screenFromEvent(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onCtx = (e: Event) => e.preventDefault()

  private onDown = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    this.lastScreen = s
    // Pan on middle/right button, or left-drag while Space is held (so a laptop
    // trackpad user without a middle button can always pan).
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.panning = true
      this.canvas.style.cursor = 'grabbing'
      return
    }
    // M4: a click on an editable selection-dimension label opens the inline
    // numeric editor (single selection, not while drawing). A miss dismisses any
    // open editor. Runs before tool routing so it wins over select/grip hits.
    if (e.button === 0 && !this.dynArmed()) {
      if (this.tryOpenDimEditor(s)) return
      if (this.dimEditing) this.cancelDimEdit()
    }
    const w = this.toWorld(s.x, s.y)
    if (this.cad.active) {
      // Route the click through the resolved (osnap + polar + typed) point when a
      // chain is live, so a plain click lands where the ghost previews; the real
      // event still flows so polyline double-click-to-commit keeps working.
      const r = this.dynResolve(w)
      if (r) {
        this.cad.downAt(r.point, e)
        this.resetDyn()
      } else {
        this.cad.down(s.x, s.y, e)
      }
      return
    }
    if (this.tool === 'select') {
      // 1. Grabbing a resize handle of the already-selected room?
      const hi = this.handleAt(s)
      if (hi != null && this.selectedZoneId != null) {
        this.beginRoomResize(hi, this.selectedZoneId)
        return
      }
      // ROOM-FIRST selection (Laiout/Canva model). A room is furnished, so
      // furniture-first hit-testing made rooms impossible to grab — every click
      // landed on a desk, never the room (the reported "can't drag rooms"). Now a
      // click inside a room selects and drags the ROOM, even over furniture.
      // DRILL-IN: once that room is already selected, a click on its furniture
      // selects the component (Materio re-imagine); a click on its empty floor
      // re-grabs the room to drag.
      const zid = this.ed.zone_at(w.x, w.y)
      if (zid != null) {
        if (zid === this.selectedZoneId) {
          const furn = this.topFurnitureAt(w)
          if (furn) {
            this.ed.select_at(w.x, w.y) // drill into the piece under the cursor
            this.dragging = true
            this.commit()
            return
          }
          this.ed.clear_selection() // empty floor of the selected room → drag it
          this.beginRoomDrag(zid, w)
          this.commit()
          return
        }
        this.selectedZoneId = zid
        this.ed.clear_selection()
        this.beginRoomDrag(zid, w)
        this.emitRoom(true)
        this.commit()
        return
      }
      // 3. Outside any room → a loose component (e.g. passive reference furniture),
      //    else clear everything.
      const furn = this.topFurnitureAt(w)
      if (furn) {
        this.selectedZoneId = null
        this.emitRoom()
        this.ed.select_at(w.x, w.y)
        this.dragging = true
        this.commit()
        return
      }
      this.selectedZoneId = null
      this.emitRoom()
      this.ed.clear_selection()
      this.dragging = false
      this.commit()
    } else if (this.tool === 'wall') {
      // First point: classic grid snap. Chained points: honor typed/polar input.
      const r = this.wallStart ? this.dynResolve(w) : null
      const sp = r ? r.point : this.snap(w)
      if (!this.wallStart) {
        this.wallStart = sp
      } else {
        this.ed.add_wall(this.wallStart.x, this.wallStart.y, sp.x, sp.y, 0.1)
        this.wallStart = sp // chain walls
        this.commit()
      }
      this.resetDyn()
    } else if (this.tool.startsWith('place:')) {
      const cat = this.tool.slice('place:'.length)
      const item = catByCategory(cat)
      if (item) {
        const sp = this.snap(w)
        this.ed.add_component(cat, sp.x, sp.y, item.w, item.h)
        this.commit()
      }
    }
  }

  private onMove = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    this.mouseWorld = this.toWorld(s.x, s.y)
    this.hasCursor = true
    this.shiftDown = e.shiftKey
    this.altDown = e.altKey
    this.updateCoordReadout()
    if (this.panning) {
      this.offset.x += s.x - this.lastScreen.x
      this.offset.y += s.y - this.lastScreen.y
      this.lastScreen = s
      this.render()
      return
    }
    if (this.cad.active) {
      // Steer the preview through the resolved point when a chain is live; else
      // fall back to the tool's own osnap (first-point pick, non-draw tools).
      const r = this.dynResolve(this.mouseWorld)
      if (r) this.cad.moveSnap(r.snap)
      else this.cad.move(s.x, s.y)
      const hint = this.cad.hint()
      if (hint && this.coordEl) this.coordEl.textContent = hint
      return
    }
    // Room manipulation takes priority over component drag.
    if (this.roomResize) {
      this.updateRoomResize(s)
      return
    }
    if (this.roomDrag) {
      this.updateRoomDrag(s)
      return
    }
    if (this.dragging && this.tool === 'select') {
      const dxw = (s.x - this.lastScreen.x) / this.scale
      const dyw = (s.y - this.lastScreen.y) / this.scale
      this.ed.move_selected(dxw, dyw)
      this.lastScreen = s
      this.commit()
      return
    }
    if (this.tool === 'select') this.updateHoverCursor(s)
    if (this.tool === 'wall' && this.wallStart) this.render()
    else if (this.hasCursor) this.render() // keep ruler cursor ticks live
  }

  private onLeave = () => {
    this.hasCursor = false
    if (this.coordEl) this.coordEl.textContent = 'x —  y —'
    this.render()
  }

  private onUp = (e: MouseEvent) => {
    if (this.cad.active && !this.panning) {
      const s = this.screenFromEvent(e)
      this.cad.up(s.x, s.y)
    }
    if (this.roomDrag || this.roomResize) {
      this.roomDrag = null
      this.roomResize = null
      this.emitRoom(true)
      this.commit()
    }
    this.panning = false
    this.dragging = false
    this.canvas.style.cursor = this.spaceDown ? 'grab' : ''
  }

  /** Wheel: pinch-zoom (trackpad emits ctrlKey) and true mouse wheels zoom to
   *  the cursor; a two-finger trackpad scroll pans. This makes the plan
   *  navigable on a laptop trackpad, where there is no middle button and a
   *  plain two-finger scroll should move the map, not zoom it. */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const pinch = e.ctrlKey || e.metaKey
    // A real mouse wheel reports line-mode deltas, or a chunky integer,
    // vertical-only step; a trackpad reports smaller/fractional pixel deltas
    // (often with a horizontal component).
    const mouseWheel =
      e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40)
    if (pinch || mouseWheel) {
      const s = this.screenFromEvent(e)
      const before = this.toWorld(s.x, s.y)
      const factor = Math.exp(-e.deltaY * (pinch ? 0.01 : 0.0015))
      this.scale = Math.min(300, Math.max(8, this.scale * factor))
      this.offset.x = s.x - before.x * this.scale
      this.offset.y = s.y - before.y * this.scale
      this.updateScaleReadout()
      this.render()
    } else {
      this.offset.x -= e.deltaX
      this.offset.y -= e.deltaY
      this.render()
    }
  }

  private onKey = (e: KeyboardEvent) => {
    // Space (when not typing) arms hold-to-pan in every tool, incl. CAD.
    const tgt = e.target as HTMLElement | null
    const typingNow =
      !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)
    this.shiftDown = e.shiftKey
    this.altDown = e.altKey
    if (e.code === 'Space' && !typingNow) {
      if (!this.spaceDown) {
        this.spaceDown = true
        if (!this.panning) this.canvas.style.cursor = 'grab'
      }
      e.preventDefault() // don't scroll the page
      return
    }
    // Dynamic input: while a Line/Wall chain is live, digits/Tab/Enter/Backspace
    // and the first Esc drive the typed Distance/Angle (before tool/mode keys).
    if (!typingNow && this.dynArmed() && this.handleDynKey(e)) return
    if (this.cad.active) {
      // ⌘Z / Ctrl+Z pops the CAD undo stack (grip drags, trims, fillets, …).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        this.cad.store.undo()
        this.render()
        return
      }
      // CAD tools consume typing (text) + shortcuts (door 'f', column 'r', Esc).
      if (e.key === 'Backspace') e.preventDefault()
      this.cad.key(e.key)
      return
    }
    const t = e.target as HTMLElement | null
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (e.key.toLowerCase() === 'p' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      this.setPresentation(!this.presentation)
    } else if (e.key === 'Escape') {
      this.wallStart = null
      this.resetDyn()
      if (this.dimEditing) this.closeDimEditor()
      this.selectedZoneId = null
      this.emitRoom()
      this.ed.clear_selection()
      this.commit()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedZoneId != null) {
        e.preventDefault()
        this.deleteRoom(this.selectedZoneId)
      } else if (this.getState().selection != null) {
        e.preventDefault()
        this.ed.delete_selected()
        this.commit()
      }
    }
  }

  private onResize = () => {
    this.resize()
    this.render()
  }

  /** Container-size changes (route mount, panel show/hide, split-pane drag). If a
   *  frame was left pending because the container was collapsed, complete it the
   *  moment the container becomes real — otherwise just resize+repaint, preserving
   *  the user's pan/zoom (no `frameOnLayout` → never fights a deliberate view). */
  private onContainerResize = () => {
    this.resize()
    if (this.frameOnLayout && this.viewportReady()) {
      this.frameOnLayout = false
      this.frameContent()
      return
    }
    this.render()
  }

  /** True when the canvas container is laid out to a real, usable size. Framing
   *  gates on THIS (the container), never on the canvas — resize() bails on a
   *  collapsed container, leaving the canvas at its 300×150 intrinsic default,
   *  which would otherwise sail past a canvas-based guard and frame into a corner. */
  private viewportReady(): { w: number; h: number } | null {
    const r = this.canvas.parentElement?.getBoundingClientRect()
    if (!r || r.width < FRAME_MIN_VIEWPORT_PX || r.height < FRAME_MIN_VIEWPORT_PX) return null
    return { w: r.width, h: r.height }
  }

  private updateCoordReadout() {
    if (this.coordEl) {
      this.coordEl.textContent = `x ${this.mouseWorld.x.toFixed(2)}  y ${this.mouseWorld.y.toFixed(2)}`
    }
  }
  private updateScaleReadout() {
    if (this.scaleEl) this.scaleEl.textContent = `${Math.round(this.scale)} px/m`
  }

  private resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return // hidden (e.g. 3D mode)
    // Re-read the DPR on every resize. It was a field initialiser read ONCE at
    // construction, so moving the window to a display with a different DPI (or
    // changing browser zoom) left the backing store sized with the stale ratio —
    // a blurry or over-sharp canvas with no way to recover short of a reload.
    // DrawingCanvas already did this; the two now agree.
    this.dpr = Math.max(1, window.devicePixelRatio || 1)
    this.canvas.width = Math.floor(rect.width * this.dpr)
    this.canvas.height = Math.floor(rect.height * this.dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
  }

  // ---- rendering ----
  private render() {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const w = this.canvas.width / this.dpr
    const h = this.canvas.height / this.dpr
    if (w === 0 || h === 0) return

    const st = this.getState()

    // Presentation: full-bleed paper white. Normal: gray mat everywhere with a
    // white floor plate over the building footprint, plus grid + axis.
    if (this.presentation) {
      ctx.fillStyle = C.surface
      ctx.fillRect(0, 0, w, h)
    } else {
      ctx.fillStyle = C.mat
      ctx.fillRect(0, 0, w, h)
      const bb = wallBbox(st.walls)
      if (bb) {
        const p0 = this.toScreen(bb.minX, bb.minY)
        const p1 = this.toScreen(bb.maxX, bb.maxY)
        ctx.fillStyle = C.surface
        ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)
      } else {
        ctx.fillStyle = C.surface
        ctx.fillRect(0, 0, w, h)
      }
      this.drawGrid(w, h)
    }
    this.updatePlate(st.walls)
    const tags = this.drawZones(st.zones)

    // Resolve the dynamic-input candidate once per frame (wall preview + chips +
    // widget all read it) so OSNAP/getState isn't recomputed three times.
    this.dynResolved =
      this.hasCursor && !this.presentation && this.dynArmed()
        ? this.dynResolve(this.mouseWorld)
        : null

    for (const wall of st.walls) {
      // Glass fronts get the triple-line convention; everything else draws in
      // the lineweight hierarchy (exterior > interior > generated partition).
      if (wall.glazing) {
        this.drawGlazing(wall.a, wall.b)
      } else {
        this.drawWall(wall.a, wall.b, wall)
      }
    }
    if (this.tool === 'wall' && this.wallStart) {
      this.drawSegment(
        this.wallStart,
        this.dynResolved?.point ?? this.snap(this.mouseWorld),
        Math.max(2, 0.1 * this.scale),
        C.preview,
      )
    }
    for (const c of st.components) this.drawComponent(c, c.id === st.selection)
    this.drawRoomSelection()
    // Room tags sit ABOVE furniture (architect's sheet convention) with a soft
    // paper halo so they stay legible over desks and linework.
    this.drawZoneTags(tags)

    // CAD layer: entities + tool preview + snap indicator + grips.
    this.cad.render(ctx, {
      toScreen: (p) => this.toScreen(p.x, p.y),
      pxPerM: this.scale,
      selected: this.cad.selected,
      hiddenLayers: this.cad.store.hiddenLayers,
      colors: { wall: C.wall, ink: C.label, accent: C.accent, dim: '#2d5bd6', faint: C.rulerText },
    })

    // Live per-segment dimension chips (Rayon helper-dimensions) above linework.
    this.drawDimChips()

    // Measured dimensions of the current selection + click-to-edit targets (M4).
    this.drawSelectionDims()

    if (this.presentation) {
      if (st.walls.length || st.components.length) this.drawSummary(w, h)
    } else {
      this.drawRulers(w, h)
    }

    // Floating typed Distance/Angle widget at the cursor.
    this.syncDynWidget()

    if (this.selectedZoneId != null) this.emitRoom()
  }

  /** Selected-room outline, 8 resize handles, and a live W×H dimension badge. */
  private drawRoomSelection() {
    if (this.selectedZoneId == null) return
    const z = this.zoneById(this.selectedZoneId)
    if (!z) return
    const ctx = this.ctx
    const box = this.roomScreenBox(z)
    const ring = z.shape.kind !== 'Rect'

    ctx.save()
    ctx.strokeStyle = C.accent
    ctx.lineWidth = 2
    ctx.setLineDash(ring ? [6, 4] : [])
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
    ctx.setLineDash([])
    ctx.restore()

    if (z.shape.kind !== 'Rect') return // no handles / dims for non-rect (ring/poly) zones

    // Live dimension badge (accent pill) centered under the room.
    const label = `${z.shape.w.toFixed(2)} × ${z.shape.h.toFixed(2)} m`
    ctx.font = '600 11px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(label).width
    const cx = box.x + box.w / 2
    const by = box.y + box.h + 14
    ctx.fillStyle = C.accent
    roundRect(ctx, cx - tw / 2 - 7, by - 9, tw + 14, 18, 9)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, cx, by + 1)

    // 8 white square handles with an accent border.
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = C.accent
    ctx.lineWidth = 1.5
    for (const p of handlePoints(box)) {
      ctx.beginPath()
      ctx.rect(p.x - 4, p.y - 4, 8, 8)
      ctx.fill()
      ctx.stroke()
    }
  }

  /**
   * Wall ink + outline pen (architect's sheet convention): exterior/plate walls
   * heaviest in the darkest ink, interior user walls medium, generated
   * partitions lightest.
   *
   * The wall's MASS is world (its true thickness, filled as poché by
   * `drawWall`); only this OUTLINE is screen space, and it is a discrete pen
   * weight snapped to the device-pixel grid. That replaces the old
   * `clamp(thickness × scale, min, max)` stroke, which was three different
   * visual laws across one zoom sweep: pinned to its floor below ~12 px/m
   * (hierarchy compressed to nothing), proportional in the middle, and pinned to
   * its ceiling above ~25 px/m (walls stopped thickening while the rooms around
   * them kept growing). That is what "the line weight changes at every zoom
   * level" was.
   */
  private wallStyle(w: DocWall): { color: string; pen: PenWeight } {
    if (w.generated ?? false) return { color: C.wallGen, pen: 'thin' }
    if (this.exteriorIds.has(w.id)) return { color: C.wallExt, pen: 'thick' }
    return { color: C.wall, pen: 'med' }
  }

  /**
   * Draw a wall as an architect would: a FILLED body at its true thickness in
   * world units, outlined with a device-pixel-snapped hairline pen.
   *
   * A wall is a 200 mm-thick object, so it should measure 200 mm at every zoom.
   * Below the point where its true thickness is thinner than the pen itself
   * (~3 device px), the poché would be sub-pixel mush, so it degrades to a
   * single stroke — faded in across a band, so nothing pops.
   */
  private drawWall(a: { x: number; y: number }, b: { x: number; y: number }, w: DocWall) {
    const ctx = this.ctx
    const s = this.wallStyle(w)
    const pa = this.toScreen(a.x, a.y)
    const pb = this.toScreen(b.x, b.y)
    const tPx = w.thickness * this.scale
    const stroke = pen(s.pen, this.dpr)
    // Fade the poché in as the wall's true thickness overtakes its own outline.
    const solid = lod(tPx, { exit: stroke * 1.5, enter: stroke * 4 })

    if (solid < 1) {
      // Thin-zoom fallback: the wall as a single line at its pen weight.
      ctx.save()
      ctx.globalAlpha = 1 - solid
      ctx.strokeStyle = s.color
      ctx.lineWidth = stroke
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
      ctx.stroke()
      ctx.restore()
    }
    if (solid <= 0) return

    // Poché: the wall's real body, filled.
    const dx = pb.x - pa.x
    const dy = pb.y - pa.y
    const len = Math.hypot(dx, dy) || 1
    const hx = (-dy / len) * (tPx / 2)
    const hy = (dx / len) * (tPx / 2)
    ctx.save()
    ctx.globalAlpha = solid
    ctx.beginPath()
    ctx.moveTo(pa.x + hx, pa.y + hy)
    ctx.lineTo(pb.x + hx, pb.y + hy)
    ctx.lineTo(pb.x - hx, pb.y - hy)
    ctx.lineTo(pa.x - hx, pa.y - hy)
    ctx.closePath()
    ctx.fillStyle = s.color
    ctx.fill()
    ctx.lineWidth = pen('hair', this.dpr)
    ctx.strokeStyle = s.color
    ctx.stroke()
    ctx.restore()
  }

  /** Floor-plate polygon for zone clipping, cached on a cheap wall fingerprint
   *  (walls change rarely; `ed.plate()` re-traces + serializes on every call).
   *  Also classifies which walls lie ON the plate boundary (exterior ink). */
  private platePoly: [number, number][] | null = null
  private plateKey = ''
  private exteriorIds = new Set<number>()

  private updatePlate(walls: DocWall[]) {
    let sum = 0
    for (const w of walls) sum += w.a.x + w.a.y * 7 + w.b.x * 13 + w.b.y * 31
    const key = `${walls.length}:${sum.toFixed(4)}`
    if (key === this.plateKey) return
    this.plateKey = key
    this.platePoly = (this.ed.plate() as [number, number][] | null | undefined) ?? null
    // Exterior = both endpoints sit on the traced plate boundary (within 8 cm).
    this.exteriorIds.clear()
    const poly = this.platePoly
    if (poly && poly.length >= 3) {
      for (const w of walls) {
        if (w.generated ?? false) continue
        if (distToPoly(poly, w.a) < 0.08 && distToPoly(poly, w.b) < 0.08) {
          this.exteriorIds.add(w.id)
        }
      }
    }
  }

  /**
   * Fine 45° architectural poché hatch, clipped to a zone's screen path. The
   * standard drawing convention for a solid service core (shafts / stairs / WC /
   * MEP) so a `Core` zone reads as built poché instead of an unfinished gray
   * block. Deliberately restrained (Laiout/qbiq): thin light lines in the zone's
   * own ink over its pale fill. `tracePath` re-lays the fill path (we begin it)
   * so the hatch is clipped to Rect AND Poly cores identically.
   */
  private drawPoche(
    tracePath: () => void,
    bb: { minX: number; minY: number; maxX: number; maxY: number },
    line: string,
    evenOdd = false,
  ) {
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    tracePath()
    ctx.clip(evenOdd ? 'evenodd' : 'nonzero')
    ctx.strokeStyle = hexToRgba(line, 0.34)
    ctx.lineWidth = 0.6
    const step = 6 // px between hatch lines (screen space; fixed density, not zoom-scaled)
    const span = bb.maxY - bb.minY
    ctx.beginPath()
    // Parallel 45° lines (slope +1): start far enough left that down-right
    // diagonals cover the whole clip rect.
    for (let x = bb.minX - span; x <= bb.maxX; x += step) {
      ctx.moveTo(x, bb.minY)
      ctx.lineTo(x + span, bb.maxY)
    }
    ctx.stroke()
    ctx.restore()
  }

  private drawZones(zones?: DocZone[]): ZoneTag[] {
    if (!zones || zones.length === 0) return []
    const ctx = this.ctx

    // Zone shapes are rectangles even on an L-shaped plate; clip their fills to
    // the plate polygon so tints never spill past the building boundary.
    // Labels draw after restore so they stay legible near clipped corners.
    const clipped = this.platePoly && this.platePoly.length >= 3
    if (clipped) {
      ctx.save()
      ctx.beginPath()
      const poly = this.platePoly!
      const p0 = this.toScreen(poly[0][0], poly[0][1])
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i < poly.length; i++) {
        const p = this.toScreen(poly[i][0], poly[i][1])
        ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
      ctx.clip()
    }

    this.updateZoneStats(zones)
    const tags: ZoneTag[] = []
    for (const z of zones) {
      const pal = ZONE[z.zone_type] ?? ZONE.Core
      ctx.fillStyle = this.presentation ? lighten(pal.fill, 0.4) : pal.fill
      if (z.shape.kind === 'Poly') {
        // Boundary-conforming polygon: trace + fill + hairline; label at the
        // area-weighted centroid.
        const pts = z.shape.pts
        if (pts.length < 3) continue
        ctx.beginPath()
        const s0 = this.toScreen(pts[0][0], pts[0][1])
        ctx.moveTo(s0.x, s0.y)
        for (let i = 1; i < pts.length; i++) {
          const p = this.toScreen(pts[i][0], pts[i][1])
          ctx.lineTo(p.x, p.y)
        }
        ctx.closePath()
        ctx.fill()
        ctx.strokeStyle = hexToRgba(pal.line, 0.45)
        ctx.lineWidth = 1
        ctx.stroke()
        if (z.zone_type === 'Core') {
          let bminX = Infinity
          let bminY = Infinity
          let bmaxX = -Infinity
          let bmaxY = -Infinity
          const sp = pts.map((pt) => this.toScreen(pt[0], pt[1]))
          for (const q of sp) {
            bminX = Math.min(bminX, q.x)
            bminY = Math.min(bminY, q.y)
            bmaxX = Math.max(bmaxX, q.x)
            bmaxY = Math.max(bmaxY, q.y)
          }
          this.drawPoche(
            () => {
              ctx.moveTo(sp[0].x, sp[0].y)
              for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y)
              ctx.closePath()
            },
            { minX: bminX, minY: bminY, maxX: bmaxX, maxY: bmaxY },
            pal.line,
          )
        }
        // Area-weighted centroid (world), then screen, for the room tag.
        let a2 = 0
        let cx = 0
        let cy = 0
        for (let i = 0; i < pts.length; i++) {
          const [x0, y0] = pts[i]
          const [x1, y1] = pts[(i + 1) % pts.length]
          const cross = x0 * y1 - x1 * y0
          a2 += cross
          cx += (x0 + x1) * cross
          cy += (y0 + y1) * cross
        }
        const stat = this.zoneStats.get(z.id)
        const area = stat?.area ?? Math.abs(a2) / 2
        if (area < TAG_MIN_AREA_M2 || Math.abs(a2) < 1e-6) continue
        const wcx = cx / (3 * a2)
        const wcy = cy / (3 * a2)
        const c = this.toScreen(wcx, wcy)
        const name = z.label.toUpperCase()
        const cap = stat?.capacity ?? 0
        const metrics: string | null =
          area >= TAG_METRICS_MIN_AREA_M2
            ? `${fmtArea(area)} m²${cap > 0 ? ` · ${cap} pax` : ''}`
            : null
        tags.push({ name, metrics, cx: c.x, cy: c.y, namePx: 10, color: pal.line, area })
      } else if (z.shape.kind === 'RectRing') {
        const s = z.shape
        const o = this.toScreen(s.x - s.w / 2, s.y - s.h / 2)
        const io = this.toScreen(s.x - s.in_w / 2, s.y - s.in_h / 2)
        ctx.beginPath()
        ctx.rect(o.x, o.y, s.w * this.scale, s.h * this.scale)
        ctx.rect(io.x, io.y, s.in_w * this.scale, s.in_h * this.scale)
        ctx.fill('evenodd')
        if (z.zone_type === 'Core') {
          this.drawPoche(
            () => {
              ctx.rect(o.x, o.y, s.w * this.scale, s.h * this.scale)
              ctx.rect(io.x, io.y, s.in_w * this.scale, s.in_h * this.scale)
            },
            { minX: o.x, minY: o.y, maxX: o.x + s.w * this.scale, maxY: o.y + s.h * this.scale },
            pal.line,
            true,
          )
        }
      } else {
        const s = z.shape
        const p = this.toScreen(s.x - s.w / 2, s.y - s.h / 2)
        const w = s.w * this.scale
        const h = s.h * this.scale
        ctx.fillRect(p.x, p.y, w, h)
        // Soft inset border (secondary to walls) — a refined architectural edge,
        // not a saturated toy outline.
        ctx.strokeStyle = hexToRgba(pal.line, 0.45)
        ctx.lineWidth = 1
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1)
        if (z.zone_type === 'Core') {
          this.drawPoche(
            () => ctx.rect(p.x, p.y, w, h),
            { minX: p.x, minY: p.y, maxX: p.x + w, maxY: p.y + h },
            pal.line,
          )
        }

        // Centered room tag: NAME over "area m² · N pax" (architect's sheet
        // style). Visibility is a WORLD decision — a room earns a name because of
        // how big the ROOM is, not because of how big it currently looks. The old
        // screen tests (`h < 18` to drop the name, `h < 34` to drop the metrics,
        // measureText vs the on-screen width) made room names blink in and out as
        // the user zoomed. The whole tag layer fades out at overview zoom instead
        // (see drawZoneTags), where a plan is read as shape, not as labels.
        const stat = this.zoneStats.get(z.id)
        const area = stat?.area ?? s.w * s.h
        if (area < TAG_MIN_AREA_M2) continue
        const name = z.label.toUpperCase()
        const cap = stat?.capacity ?? 0
        const metrics: string | null =
          area >= TAG_METRICS_MIN_AREA_M2
            ? `${fmtArea(area)} m²${cap > 0 ? ` · ${cap} pax` : ''}`
            : null
        const c = this.toScreen(s.x, s.y)
        tags.push({ name, metrics, cx: c.x, cy: c.y, namePx: 10, color: pal.line, area })
      }
    }
    if (clipped) ctx.restore()
    return tags
  }

  /** Draw collected room tags (after furniture) as clean soft-rounded label
   *  pills — white with a subtle drop shadow and a hairline in the zone color —
   *  so a room name reads over desks/linework without the cheap hard white box.
   *  Numbers set in the UI sans (Hanken, tabular) to match the rest of the sheet;
   *  see the CLAUDE.md typography note in the visual overhaul. */
  private drawZoneTags(tags: ZoneTag[]) {
    const ctx = this.ctx
    const NAME_FONT = (px: number) => `600 ${px}px "Hanken Grotesk", system-ui, sans-serif`
    const MET_FONT = '500 9.5px "Hanken Grotesk", system-ui, sans-serif'
    // Annotation is for READING a plan, not for surveying it. Below ~10 px/m the
    // constant-size pills swamp the drawing they annotate (at 8 px/m they used to
    // collide into an unreadable mat), so the whole layer fades out.
    const layerAlpha = lod(this.scale, { exit: 7, enter: 12 })
    if (layerAlpha <= 0) return

    // De-collide by WORLD priority: when two pills overlap, the smaller ROOM
    // yields. Priority is a world quantity, so which tag survives is stable
    // under zoom and pan — it never flickers as the user moves.
    const ordered = [...tags].sort((a, b) => b.area - a.area)
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = []

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.save()
    ctx.globalAlpha = layerAlpha
    for (const t of ordered) {
      ctx.font = NAME_FONT(t.namePx)
      const nameW = ctx.measureText(t.name).width
      ctx.font = MET_FONT
      const metW = t.metrics ? ctx.measureText(t.metrics).width : 0
      const padX = 8
      const pillW = Math.max(nameW, metW) + padX * 2
      const pillH = t.metrics ? 32 : 19
      const px = t.cx - pillW / 2
      const py = t.cy - pillH / 2

      // Yield to any larger room's pill already placed.
      const box = { x0: px, y0: py, x1: px + pillW, y1: py + pillH }
      if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) {
        continue
      }
      placed.push(box)

      // Soft pill: drop shadow + near-white fill + hairline border in zone color.
      ctx.save()
      ctx.shadowColor = 'rgba(23,26,30,0.14)'
      ctx.shadowBlur = 6
      ctx.shadowOffsetY = 1
      ctx.fillStyle = 'rgba(255,255,255,0.94)'
      roundRect(ctx, px, py, pillW, pillH, pillH / 2)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = hexToRgba(t.color, 0.28)
      ctx.lineWidth = 1
      roundRect(ctx, px + 0.5, py + 0.5, pillW - 1, pillH - 1, (pillH - 1) / 2)
      ctx.stroke()

      // Name (zone-line color) over metrics (muted).
      ctx.fillStyle = t.color
      ctx.font = NAME_FONT(t.namePx)
      ctx.fillText(t.name, t.cx, t.metrics ? t.cy - 6 : t.cy)
      if (t.metrics) {
        ctx.fillStyle = C.labelSub
        ctx.font = MET_FONT
        ctx.fillText(t.metrics, t.cx, t.cy + 7.5)
      }
    }
    ctx.restore()
  }

  /** Per-zone Rust-truth stats (plate-clipped area, capacity), cached on a
   *  zone fingerprint — `zone_stats()` re-clips + serializes on every call. */
  private zoneStats = new Map<number, ZoneStat>()
  private zoneStatsKey = ''

  private updateZoneStats(zones: DocZone[]) {
    let sum = 0
    for (const z of zones) {
      const s = z.shape
      if (s.kind === 'Poly') {
        sum += z.id * 3
        for (const [px, py] of s.pts) sum += px * 13 + py * 31
      } else {
        sum += z.id * 3 + s.x + s.y * 7 + s.w * 13 + s.h * 31
      }
    }
    const key = `${zones.length}:${sum.toFixed(4)}:${this.plateKey}`
    if (key === this.zoneStatsKey) return
    this.zoneStatsKey = key
    this.zoneStats = new Map(this.getZoneStats().map((s) => [s.id, s]))
  }

  private drawGrid(w: number, h: number) {
    const ctx = this.ctx
    const step = GRID_M * this.scale
    if (step >= 6) {
      const originX = this.offset.x
      const originY = this.offset.y
      for (let i = 0, x = originX % step; x < w; x += step, i++) {
        const worldM = Math.round((x - originX) / step) * GRID_M
        ctx.strokeStyle = worldM % MAJOR_EVERY === 0 ? C.gridMajor : C.gridMinor
        line(ctx, x, 0, x, h)
      }
      for (let y = originY % step; y < h; y += step) {
        const worldM = Math.round((y - originY) / step) * GRID_M
        ctx.strokeStyle = worldM % MAJOR_EVERY === 0 ? C.gridMajor : C.gridMinor
        line(ctx, 0, y, w, y)
      }
    }
    const o = this.toScreen(0, 0)
    ctx.strokeStyle = C.axis
    line(ctx, o.x, 0, o.x, h)
    line(ctx, 0, o.y, w, o.y)
  }

  private drawSegment(
    a: { x: number; y: number },
    b: { x: number; y: number },
    widthPx: number,
    color: string,
  ) {
    const ctx = this.ctx
    const pa = this.toScreen(a.x, a.y)
    const pb = this.toScreen(b.x, b.y)
    ctx.strokeStyle = color
    ctx.lineWidth = widthPx
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
  }

  /** Glazed wall: the drafting triple-line convention (two frame lines with a
   *  lighter center glazing line), visually distinct from solid poché walls. */
  private drawGlazing(a: { x: number; y: number }, b: { x: number; y: number }) {
    const ctx = this.ctx
    const pa = this.toScreen(a.x, a.y)
    const pb = this.toScreen(b.x, b.y)
    const dx = pb.x - pa.x
    const dy = pb.y - pa.y
    const len = Math.hypot(dx, dy) || 1
    // Frame offset: half the drawn glazing depth, ≥1.5 px so it never collapses.
    const o = Math.max(1.5, 0.05 * this.scale)
    const nx = (-dy / len) * o
    const ny = (dx / len) * o
    ctx.lineCap = 'round'
    ctx.strokeStyle = C.wall
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pa.x + nx, pa.y + ny)
    ctx.lineTo(pb.x + nx, pb.y + ny)
    ctx.moveTo(pa.x - nx, pa.y - ny)
    ctx.lineTo(pb.x - nx, pb.y - ny)
    ctx.stroke()
    ctx.strokeStyle = '#8fb6c9' // glass: light cool center line
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
  }

  /** Presentation-mode plan summary block (bottom-right): the test-fit
   *  deliverable card — name, NIA, workstations, m²/ws, efficiency. */
  private drawSummary(w: number, h: number) {
    const m = this.getMetrics()
    const rows: [string, string][] = [
      ['AREA (NIA)', `${fmtArea(m.net_internal_area ?? m.floor_area)} m²`],
      ['WORKSTATIONS', `${m.workstations ?? 0}`],
      ['M² / WS', m.area_per_workstation ? m.area_per_workstation.toFixed(1) : '—'],
      ['EFFICIENCY', m.efficiency_pct != null ? `${Math.round(m.efficiency_pct)} %` : '—'],
    ]
    const ctx = this.ctx
    const W = 196
    const pad = 12
    const rowH = 17
    const H = 30 + rows.length * rowH + pad - 4
    const x = w - W - 16
    const y = h - H - 16
    ctx.fillStyle = C.surface
    ctx.fillRect(x, y, W, H)
    ctx.strokeStyle = 'rgba(23,26,30,0.30)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = C.label
    ctx.font = '700 10px "Hanken Grotesk", system-ui, sans-serif'
    ctx.fillText('TEST FIT', x + pad, y + 18)
    ctx.strokeStyle = 'rgba(23,26,30,0.14)'
    line(ctx, x + pad, y + 24.5, x + W - pad, y + 24.5)

    let ry = y + 24 + rowH - 4
    for (const [label, value] of rows) {
      ctx.fillStyle = C.labelSub
      ctx.font = '600 8px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(label, x + pad, ry)
      ctx.fillStyle = C.label
      ctx.font = `10px ${MONO}`
      ctx.textAlign = 'right'
      ctx.fillText(value, x + W - pad, ry)
      ry += rowH
    }
    ctx.textAlign = 'left'
  }

  private drawComponent(c: DocComponent, selected: boolean) {
    const ctx = this.ctx
    const p = this.toScreen(c.x, c.y)
    const w = c.w * this.scale
    const h = c.h * this.scale
    const frozen = c.decision === 'Confirmed'
    // Passive as-drawn reference (imported furniture that isn't counted): draw it
    // muted and plate-less so the generated fit stays the primary read. No decision
    // dot / frozen styling — it carries no decision state.
    const ref = c.reference === true && !selected

    // Recognizable top-view CAD symbol, specified in WORLD metres — the module
    // owns the world→screen conversion so no part of the symbol's content can
    // depend on the zoom level. The symbol carries its own solid worktop/seat
    // fill (a filled object reads as furniture, where a hollow white plate under
    // a hollow outline read as faint clutter over the pastel zone). Reference
    // furniture gets no fill so it recedes into context.
    drawSymbol(
      ctx,
      {
        category: c.category,
        cx: p.x,
        cy: p.y,
        w: c.w, // METRES
        h: c.h,
        rotation: c.rotation,
        mirror: c.mirror,
        // FROM THE MODEL. The core resolved this once when the component was
        // created (`model::seats_for`); the renderer only ever reads it. Older
        // snapshots predate the facet and report 0, so fall back to the same
        // world-size rule rather than to a screen-size guess.
        seats: c.seats || seatsForSize(c.category, c.w, c.h),
        selected,
      },
      {
        stroke: ref ? C.furnitureRef : frozen ? DECISION_DOT.Confirmed : C.furniture,
        detail: ref ? C.furnitureRef : C.furnitureDetail,
        fill: ref ? undefined : frozen ? 'rgba(47,163,107,0.10)' : C.furnitureFill,
        seat: ref ? undefined : frozen ? 'rgba(47,163,107,0.16)' : C.furnitureSeat,
        accent: C.accent,
      },
      { pxPerM: this.scale, dpr: this.dpr },
    )

    // Label only for the selected item — zone labels carry the room names, so the
    // plan stays clean.
    if (selected) {
      ctx.fillStyle = C.label
      ctx.font = '600 11px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(clip(c.label, Math.max(w, 64)), p.x, p.y - h / 2 - 9)
    }

    // decision dot (top-right) — only for non-Open, to keep the plate clean
    // (reference furniture carries no decision state, so never dot it).
    if (c.decision !== 'Open' && !ref) {
      ctx.fillStyle = DECISION_DOT[c.decision]
      ctx.beginPath()
      ctx.arc(p.x + w / 2 - 5.5, p.y - h / 2 + 5.5, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // selection corner ticks (CAD handles)
    if (selected) {
      ctx.strokeStyle = C.accent
      ctx.lineWidth = 1.5
      const t = 6
      const L = -w / 2
      const R = w / 2
      const T = -h / 2
      const B = h / 2
      ctx.save()
      ctx.translate(p.x, p.y)
      for (const [cx, cy, sx, sy] of [
        [L, T, 1, 1],
        [R, T, -1, 1],
        [L, B, 1, -1],
        [R, B, -1, -1],
      ] as const) {
        ctx.beginPath()
        ctx.moveTo(cx + sx * t, cy)
        ctx.lineTo(cx, cy)
        ctx.lineTo(cx, cy + sy * t)
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  private drawRulers(w: number, h: number) {
    const ctx = this.ctx
    // strips
    ctx.fillStyle = C.rulerBg
    ctx.fillRect(0, 0, w, RULER)
    ctx.fillRect(0, 0, RULER, h)
    ctx.fillStyle = C.rulerCorner
    ctx.fillRect(0, 0, RULER, RULER)

    const stepM = niceStep(this.scale)
    ctx.font = '9px "Hanken Grotesk", system-ui, sans-serif'
    ctx.fillStyle = C.rulerText
    ctx.strokeStyle = C.rulerTick
    ctx.lineWidth = 1

    // top ruler (world X)
    const xStart = Math.ceil(this.toWorld(RULER, 0).x / stepM) * stepM
    const xEnd = this.toWorld(w, 0).x
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.beginPath()
    for (let m = xStart; m <= xEnd; m += stepM) {
      const sx = this.toScreen(m, 0).x
      if (sx < RULER) continue
      ctx.moveTo(sx + 0.5, RULER - 6)
      ctx.lineTo(sx + 0.5, RULER)
      ctx.fillText(fmtM(m), sx + 3, 10)
    }
    ctx.stroke()

    // left ruler (world Y)
    const yStart = Math.ceil(this.toWorld(0, RULER).y / stepM) * stepM
    const yEnd = this.toWorld(0, h).y
    ctx.textAlign = 'center'
    ctx.beginPath()
    for (let m = yStart; m <= yEnd; m += stepM) {
      const sy = this.toScreen(0, m).y
      if (sy < RULER) continue
      ctx.moveTo(RULER - 6, sy + 0.5)
      ctx.lineTo(RULER, sy + 0.5)
      ctx.fillText(fmtM(m), RULER / 2, sy - 3)
    }
    ctx.stroke()

    // amber cursor ticks
    if (this.hasCursor) {
      const cs = this.toScreen(this.mouseWorld.x, this.mouseWorld.y)
      ctx.strokeStyle = C.accent
      ctx.lineWidth = 1
      if (cs.x >= RULER) line(ctx, cs.x + 0.5, 0, cs.x + 0.5, RULER)
      if (cs.y >= RULER) line(ctx, 0, cs.y + 0.5, RULER, cs.y + 0.5)
    }
  }
}

// ---- module helpers ----

// Thumbnail fills by category — desks cool blue, meeting rooms translucent teal.
const THUMB_FILL: Record<string, string> = {
  Desk: 'rgba(91, 141, 239, 0.85)',
  MeetingRoom: 'rgba(70, 179, 166, 0.35)',
}
const THUMB_OTHER = 'rgba(138, 144, 153, 0.55)'

/**
 * Minimal plan schematic of a document state → dataURL, for gallery cards.
 * Deliberately NOT the interactive render() pipeline: render() draws to the
 * live canvas with pan/zoom transforms, rulers, and CAD overlays; thumbnails
 * need an isolated fit-to-frame offscreen scene.
 */
export function renderThumb(st: DocState, w = 200, h = 140): string {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return ''

  // Fit the wall bbox (fall back to component extents) into the frame.
  let bb = wallBbox(st.walls)
  if (!bb && st.components.length) {
    bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const c of st.components) {
      bb.minX = Math.min(bb.minX, c.x - c.w / 2)
      bb.minY = Math.min(bb.minY, c.y - c.h / 2)
      bb.maxX = Math.max(bb.maxX, c.x + c.w / 2)
      bb.maxY = Math.max(bb.maxY, c.y + c.h / 2)
    }
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  if (!bb) return cv.toDataURL()

  const pad = 8
  const spanX = Math.max(bb.maxX - bb.minX, 0.001)
  const spanY = Math.max(bb.maxY - bb.minY, 0.001)
  const k = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY)
  const ox = (w - spanX * k) / 2 - bb.minX * k
  const oy = (h - spanY * k) / 2 - bb.minY * k
  const X = (m: number) => m * k + ox
  const Y = (m: number) => m * k + oy

  // Zone tints (rect + ring), same pastels as the main canvas.
  for (const z of st.zones ?? []) {
    const pal = ZONE[z.zone_type] ?? ZONE.Core
    ctx.fillStyle = pal.fill
    const s = z.shape
    if (s.kind === 'Poly') {
      if (s.pts.length < 3) continue
      ctx.beginPath()
      ctx.moveTo(X(s.pts[0][0]), Y(s.pts[0][1]))
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(X(s.pts[i][0]), Y(s.pts[i][1]))
      ctx.closePath()
      ctx.fill()
    } else if (s.kind === 'RectRing') {
      ctx.beginPath()
      ctx.rect(X(s.x - s.w / 2), Y(s.y - s.h / 2), s.w * k, s.h * k)
      ctx.rect(X(s.x - s.in_w / 2), Y(s.y - s.in_h / 2), s.in_w * k, s.in_h * k)
      ctx.fill('evenodd')
    } else {
      ctx.fillRect(X(s.x - s.w / 2), Y(s.y - s.h / 2), s.w * k, s.h * k)
    }
  }

  // Components as flat category-colored rects (no symbols at this size).
  for (const c of st.components) {
    ctx.fillStyle = THUMB_FILL[c.category] ?? THUMB_OTHER
    ctx.save()
    ctx.translate(X(c.x), Y(c.y))
    ctx.rotate(c.rotation)
    ctx.fillRect((-c.w / 2) * k, (-c.h / 2) * k, c.w * k, c.h * k)
    ctx.restore()
  }

  // Wall outlines on top.
  ctx.strokeStyle = '#2e343b'
  ctx.lineCap = 'round'
  for (const wl of st.walls) {
    ctx.lineWidth = Math.max(1, wl.thickness * k)
    ctx.beginPath()
    ctx.moveTo(X(wl.a.x), Y(wl.a.y))
    ctx.lineTo(X(wl.b.x), Y(wl.b.y))
    ctx.stroke()
  }
  return cv.toDataURL()
}

function wallBbox(
  walls: DocWall[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!walls.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const wl of walls) {
    for (const pt of [wl.a, wl.b]) {
      minX = Math.min(minX, pt.x)
      minY = Math.min(minY, pt.y)
      maxX = Math.max(maxX, pt.x)
      maxY = Math.max(maxY, pt.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

/** The 8 resize-handle screen points of a room box, ordered TL,T,TR,R,BR,B,BL,L. */
function handlePoints(box: { x: number; y: number; w: number; h: number }) {
  const { x, y, w, h } = box
  const mx = x + w / 2
  const my = y + h / 2
  return [
    { x, y },
    { x: mx, y },
    { x: x + w, y },
    { x: x + w, y: my },
    { x: x + w, y: y + h },
    { x: mx, y: y + h },
    { x, y: y + h },
    { x, y: my },
  ]
}

function inScreenBox(box: { x: number; y: number; w: number; h: number }, s: { x: number; y: number }) {
  return s.x >= box.x && s.x <= box.x + box.w && s.y >= box.y && s.y <= box.y + box.h
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function clampN(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Min distance (m) from point `p` to the polygon's boundary edges. */
export function distToPoly(poly: [number, number][], p: { x: number; y: number }): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? clampN(((p.x - ax) * dx + (p.y - ay) * dy) / len2, 0, 1) : 0
    best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy)))
  }
  return best
}

/** Blend a #rrggbb color toward white by `amt` (0..1) — presentation tints. */
function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (c: number) => Math.round(c + (255 - c) * amt)
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`
}

/** Area readout: whole m² from 10 up, one decimal below ("42 m²", "7.5 m²"). */
function fmtArea(a: number): string {
  return a >= 10 ? String(Math.round(a)) : a.toFixed(1)
}

function niceStep(pxPerM: number): number {
  const minPx = 46
  for (const s of [0.5, 1, 2, 5, 10, 20, 50, 100]) if (s * pxPerM >= minPx) return s
  return 100
}

function fmtM(m: number): string {
  const r = Math.round(m * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r)
}

function clip(text: string, boxW: number): string {
  const max = Math.max(3, Math.floor(boxW / 7))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** '#rrggbb' → 'rgba(r,g,b,a)' (zone-line hairlines on tag pills). */
function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
