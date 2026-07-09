import init, { Editor } from '../wasm/ds_core'
import { catByCategory } from './catalog'
import { drawFurnitureSymbol } from './furniture'
import { CadController } from '../cad/controller'
import type { CadEntity, SnapContext } from '../cad/model'
import { evaluatorAvailable } from '../ai/evaluator'
import { applyDelta, proposeAdjustment, refScore, type ProgramDelta } from '../ai/refine'

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
  label: string
  product_id: string | null
  decision: 'Open' | 'InReview' | 'Confirmed'
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
 *  at different footprints (see `program/spec.ts`). */
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
}

/** A room tag computed by drawZones, drawn above furniture by drawZoneTags. */
interface ZoneTag {
  name: string
  metrics: string | null
  cx: number
  cy: number
  namePx: number
  color: string
}

// Space-planning strategies live in a dependency-free module (unit-testable in
// node); re-exported here so existing importers keep the single `EditorCanvas`
// entry point.
export type { Strategy } from './strategy'
export { STRATEGIES, STRATEGY_LABEL, STRATEGY_BLURB } from './strategy'
import type { Strategy } from './strategy'
import { STRATEGIES, STRATEGY_SEED_STRIDE, seedWindowOffset } from './strategy'

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

const GRID_M = 1 // 1-meter minor grid
const MAJOR_EVERY = 5 // heavier line every 5 m
const SNAP_M = 0.1 // 10 cm snap
const RULER = 22 // px ruler gutter (top + left)

// Light "floor-plate" palette — mirrors styles.css tokens (Laiout aesthetic).
const C = {
  surface: '#ffffff', // floor plate
  mat: '#f2f4f7', // outside the building footprint
  gridMinor: 'rgba(23,26,30,0.06)',
  gridMajor: 'rgba(23,26,30,0.12)',
  axis: 'rgba(45,91,214,0.20)',
  wall: '#2e343b',
  wallExt: '#1e2329',
  wallGen: '#4a525c', // generated partitions — lightest ink in the hierarchy
  // Matches DrawingCanvas FURNITURE_LINE so generated + imported plans read alike.
  furniture: '#5c6670',
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
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('resize', this.onResize)
  }
  dispose() {
    this.canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    this.canvas.removeEventListener('mouseleave', this.onLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onCtx)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('resize', this.onResize)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      this.spaceDown = false
      if (!this.panning) this.canvas.style.cursor = ''
    }
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
    if (this.cad.active) {
      this.cad.down(s.x, s.y, e)
      return
    }
    const w = this.toWorld(s.x, s.y)
    if (this.tool === 'select') {
      const hit = this.ed.select_at(w.x, w.y)
      this.dragging = hit !== undefined
      this.commit()
    } else if (this.tool === 'wall') {
      const sp = this.snap(w)
      if (!this.wallStart) {
        this.wallStart = sp
      } else {
        this.ed.add_wall(this.wallStart.x, this.wallStart.y, sp.x, sp.y, 0.1)
        this.wallStart = sp // chain walls
        this.commit()
      }
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
    this.updateCoordReadout()
    if (this.panning) {
      this.offset.x += s.x - this.lastScreen.x
      this.offset.y += s.y - this.lastScreen.y
      this.lastScreen = s
      this.render()
      return
    }
    if (this.cad.active) {
      this.cad.move(s.x, s.y)
      const hint = this.cad.hint()
      if (hint && this.coordEl) this.coordEl.textContent = hint
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
    if (e.code === 'Space' && !typingNow) {
      if (!this.spaceDown) {
        this.spaceDown = true
        if (!this.panning) this.canvas.style.cursor = 'grab'
      }
      e.preventDefault() // don't scroll the page
      return
    }
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
      this.ed.clear_selection()
      this.commit()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.getState().selection != null) {
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

    for (const wall of st.walls) {
      // Glass fronts get the triple-line convention; everything else draws in
      // the lineweight hierarchy (exterior > interior > generated partition).
      if (wall.glazing) {
        this.drawGlazing(wall.a, wall.b)
      } else {
        const s = this.wallStyle(wall)
        this.drawSegment(wall.a, wall.b, s.width, s.color)
      }
    }
    if (this.tool === 'wall' && this.wallStart) {
      this.drawSegment(
        this.wallStart,
        this.snap(this.mouseWorld),
        Math.max(2, 0.1 * this.scale),
        C.preview,
      )
    }
    for (const c of st.components) this.drawComponent(c, c.id === st.selection)
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

    if (this.presentation) {
      if (st.walls.length || st.components.length) this.drawSummary(w, h)
    } else {
      this.drawRulers(w, h)
    }
  }

  /**
   * Lineweight hierarchy (architect's sheet convention, cf. DrawingCanvas
   * LINE_WEIGHT): exterior/plate walls heaviest in the darkest ink, interior
   * user walls medium, generated partitions lightest. Stroke is proportional
   * to true thickness with min/max clamps so hierarchy survives any zoom.
   */
  private wallStyle(w: DocWall): { color: string; width: number } {
    const t = w.thickness * this.scale
    if (w.generated ?? false) {
      return { color: C.wallGen, width: clampN(t * 0.8, 1.4, 8) }
    }
    if (this.exteriorIds.has(w.id)) {
      return { color: C.wallExt, width: clampN(t * 1.15, 3, 14) }
    }
    return { color: C.wall, width: clampN(t, 2, 10) }
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
      if (z.shape.kind === 'RectRing') {
        const s = z.shape
        const o = this.toScreen(s.x - s.w / 2, s.y - s.h / 2)
        const io = this.toScreen(s.x - s.in_w / 2, s.y - s.in_h / 2)
        ctx.beginPath()
        ctx.rect(o.x, o.y, s.w * this.scale, s.h * this.scale)
        ctx.rect(io.x, io.y, s.in_w * this.scale, s.in_h * this.scale)
        ctx.fill('evenodd')
      } else {
        const s = z.shape
        const p = this.toScreen(s.x - s.w / 2, s.y - s.h / 2)
        const w = s.w * this.scale
        const h = s.h * this.scale
        ctx.fillRect(p.x, p.y, w, h)
        ctx.strokeStyle = pal.line
        ctx.lineWidth = 1
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1)

        // Centered room tag: NAME over "area m² · N pax" (architect's sheet
        // style). Skip when the zone is tiny (< 6 m²) or the tag can't fit;
        // shrink the name one step before giving up.
        const stat = this.zoneStats.get(z.id)
        const area = stat?.area ?? s.w * s.h
        if (area < 6 || h < 18) continue
        const name = z.label.toUpperCase()
        const maxW = w - 10
        ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
        let namePx = 10
        if (ctx.measureText(name).width > maxW) {
          ctx.font = '600 8px "Hanken Grotesk", system-ui, sans-serif'
          namePx = 8
          if (ctx.measureText(name).width > maxW) continue
        }
        const cap = stat?.capacity ?? 0
        let metrics: string | null = `${fmtArea(area)} m²${cap > 0 ? ` · ${cap} pax` : ''}`
        ctx.font = '9.5px "IBM Plex Mono", ui-monospace, monospace'
        if (h < 34 || ctx.measureText(metrics).width > maxW) metrics = null
        const c = this.toScreen(s.x, s.y)
        tags.push({ name, metrics, cx: c.x, cy: c.y, namePx, color: pal.line })
      }
    }
    if (clipped) ctx.restore()
    return tags
  }

  /** Draw collected room tags (after furniture) with a soft paper halo. */
  private drawZoneTags(tags: ZoneTag[]) {
    const ctx = this.ctx
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const t of tags) {
      ctx.font = `600 ${t.namePx}px "Hanken Grotesk", system-ui, sans-serif`
      const nameW = ctx.measureText(t.name).width
      ctx.font = '9.5px "IBM Plex Mono", ui-monospace, monospace'
      const metW = t.metrics ? ctx.measureText(t.metrics).width : 0
      const halfW = Math.max(nameW, metW) / 2 + 5
      const halfH = t.metrics ? 15 : 9
      ctx.fillStyle = 'rgba(255,255,255,0.78)'
      ctx.fillRect(t.cx - halfW, t.cy - halfH, halfW * 2, halfH * 2)

      ctx.fillStyle = t.color
      ctx.font = `600 ${t.namePx}px "Hanken Grotesk", system-ui, sans-serif`
      ctx.fillText(t.name, t.cx, t.metrics ? t.cy - 6 : t.cy)
      if (t.metrics) {
        ctx.fillStyle = C.labelSub
        ctx.font = '9.5px "IBM Plex Mono", ui-monospace, monospace'
        ctx.fillText(t.metrics, t.cx, t.cy + 7)
      }
    }
  }

  /** Per-zone Rust-truth stats (plate-clipped area, capacity), cached on a
   *  zone fingerprint — `zone_stats()` re-clips + serializes on every call. */
  private zoneStats = new Map<number, ZoneStat>()
  private zoneStatsKey = ''

  private updateZoneStats(zones: DocZone[]) {
    let sum = 0
    for (const z of zones) {
      const s = z.shape
      sum += z.id * 3 + s.x + s.y * 7 + s.w * 13 + s.h * 31
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
      ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace'
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

    // Very-light plate so the glyph sits cleanly on the pastel zone.
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(c.rotation)
    ctx.fillStyle = frozen ? hexA(DECISION_DOT.Confirmed, 0.12) : 'rgba(255,255,255,0.5)'
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(4, Math.min(w, h) * 0.14))
    ctx.fill()
    ctx.restore()

    // Recognizable top-view CAD furniture line-symbol.
    drawFurnitureSymbol(ctx, {
      category: c.category,
      cx: p.x,
      cy: p.y,
      w,
      h,
      rotation: c.rotation,
      stroke: frozen ? DECISION_DOT.Confirmed : C.furniture,
      detail: '#b4b9c1',
      accent: C.accent,
      selected,
    })

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
    if (c.decision !== 'Open') {
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
    if (s.kind === 'RectRing') {
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

function hexA(hex: string, a: number): string {
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
