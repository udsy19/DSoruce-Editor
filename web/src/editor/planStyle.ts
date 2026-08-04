// THE plan style table — one source for every mark the 2D plan draws.
//
// Rule: no renderer file hardcodes a colour or a width. Everything reads from
// here, and a CI grep gate enforces it (`bench/style-gate.mjs`).
//
// Every entry cites the value it implements from
// `research/qbiq-plan-style-spec.json`, which was measured from the qbiq
// reference PDF's own vector operators. Where this table deviates from the
// reference, the deviation is DECLARED with its reason — see `paper` vs
// `editor` below.
//
// Two profiles from day one, so canvas and export can never drift:
//   paper  — presentation/export. Faithful to the measured reference.
//   editor — the working surface. Diverges deliberately where an editing tool
//            needs affordances a presentation page does not.

import type { ZoneType } from '../types/doc'

export type PlanProfile = 'editor' | 'paper'

// ---------------------------------------------------------------------------
// Stroke ladder
// ---------------------------------------------------------------------------
// Spec `line_weights`: measured tier ratios from the reference. The RATIOS are
// the portable contract — absolute pt values there belong to the reference's
// page scale, not ours.
//
//   furniture        0.1452 pt   1.00x   (2354 paths/page — the dominant mark)
//   fine detail      0.1524 pt   1.05x   (role still provisional in the spec)
//   columns          0.2177 pt   1.50x   (grey-filled rects — cross-checked)
//   walls            0.2903 pt   2.00x   (463 paths/page, unfilled)
//   room enclosure   1.0234 pt   7.05x   (stroked around the zone polygon)
//   opening punch    1.2339 pt   8.50x   (WHITE, overdrawn to break the wall)

export const TIER = {
  furniture: 1.0,
  detail: 1.05,
  column: 1.5,
  wall: 2.0,
  roomEnclosure: 7.05,
  openingPunch: 8.5,
} as const
export type Tier = keyof typeof TIER

/** Base stroke in CSS px at 1× DPR, before tier multiplication. */
const BASE_STROKE_PX = 0.4
/** Clamp so hairlines stay visible and heavy tiers stay sane when zoomed in. */
const MIN_STROKE_PX = 0.35
const MAX_STROKE_PX = 6

/**
 * THE one function that owns stroke-width maths. Every stroke in the plan goes
 * through it — nothing computes a width itself.
 *
 * DPR-aware by construction: widths are multiplied by `devicePixelRatio` so a
 * 2× display renders the same *relative* hierarchy rather than half-weight
 * hairlines. Clamps are applied in CSS px BEFORE the DPR multiply, so the clamp
 * means the same thing on every display.
 *
 * `pixelsPerMeter` is accepted for future world-scaled widths (a wall that
 * thickens as you zoom). Today the ladder is screen-relative — the reference's
 * weights are paper-relative too — but the parameter is threaded now so 2b can
 * turn it on without touching call sites.
 */
export function strokePx(tier: Tier, _pixelsPerMeter: number, dpr = 1): number {
  const raw = BASE_STROKE_PX * TIER[tier]
  // ORDER IS LOAD-BEARING: clamp in CSS px, THEN multiply by DPR. Clamping
  // after the multiply would make the clamp mean a different physical width on
  // every display — a 0.35 px floor would be half a hairline at DPR 2. Do not
  // "simplify" by folding the multiply in first.
  const clamped = Math.min(MAX_STROKE_PX, Math.max(MIN_STROKE_PX, raw))
  return clamped * dpr
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
// Spec `palette.zone_fill_targets`: S 85–100%, L 80–92%. The standing identity
// decision is that DSource keeps its OWN HUES and adopts the reference's
// saturation/lightness DISCIPLINE.
//
// Measured gap on our current fills (all but ClosedOffice sit under the band):
//   Circulation   S 79.5  L 92.4      Workspace     S 82.2  L 91.2
//   Meeting       S 55.6  L 92.9      Collaboration S 40.4  L 90.8
//   Core          S 15.2  L 93.5      ClosedOffice  S 86.4  L 91.4  (in band)
//   Amenity       S 43.4  L 89.6
// The correction is MORE saturation, not less — the opposite of a "near-white
// tint", and consistent with what the reference actually measures.
//
// NOTE: these are today's values, staged for 2e. 2e re-lands them inside the
// band by adjusting S/L only, holding each hue. Keeping them here (rather than
// in paint.ts) is what makes 2e a one-file edit.


export interface ZoneStyle {
  fill: string
  line: string
}

// Lifted verbatim out of paint.ts so the render path holds no literals. Values
// are unchanged by this move — 2e is what re-lands them on the Laiout palette,
// and keeping the move and the restyle in separate commits is what makes the
// restyle's diff legible.
// Zone fills keyed by ZoneType serde tag → { fill, line } (Laiout pastels).
export const ZONE: Record<string, { fill: string; line: string }> = {
  Circulation: { fill: '#dcebfb', line: '#4a82c4' },
  Workspace: { fill: '#fbf3d6', line: '#b99527' },
  Meeting: { fill: '#e9e3f7', line: '#7e63c0' },
  Collaboration: { fill: '#def1e2', line: '#4b9e66' },
  Core: { fill: '#eceef1', line: '#8b939e' },
  ClosedOffice: { fill: '#fce6d6', line: '#cb8150' },
  Amenity: { fill: '#d9f0ef', line: '#3f9c95' },
}

export const C = {
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

  // Glass partitions: a light cool centre line between the two wall faces.
  glassCore: '#8fb6c9',
  // Floating label pill (editor affordance — never on paper output).
  pillShadow: 'rgba(23,26,30,0.14)',
  pillFill: 'rgba(255,255,255,0.94)',
  // Dimension/measure chips: paper-coloured when committed, accent when live.
  chipPaper: 'rgba(255,255,255,0.9)',
  accentDeep: '#1d47c0', // snapped-to-geometry state, deeper than `accent`
  // Candidate thumbnails (gallery cards).
  thumbBorder: 'rgba(23,26,30,0.30)',
  thumbRule: 'rgba(23,26,30,0.14)',
  thumbWall: '#2e343b',
}

/**
 * Thumbnail fills by category — desks cool blue, meeting rooms translucent
 * teal. Deliberately NOT the zone palette: a 180 px card cannot carry the
 * plan's pastels legibly, so the thumbnail is a distinct, denser legend.
 */
export const THUMB_FILL: Record<string, string> = {
  Desk: 'rgba(91, 141, 239, 0.85)',
  MeetingRoom: 'rgba(70, 179, 166, 0.35)',
}
export const THUMB_OTHER = 'rgba(138, 144, 153, 0.55)'

/** Reference column fill (spec `palette.column_fill`). */
const COLUMN_FILL = '#a0a0a0'

export const DECISION_DOT: Record<string, string> = {
  Confirmed: '#2fa36b',
  InReview: '#e0952b',
  Open: '#9aa2ad',
}

// ---------------------------------------------------------------------------
// Element styles, per profile
// ---------------------------------------------------------------------------

export interface ElementStyle {
  stroke?: string
  fill?: string
  tier?: Tier
  dash?: number[]
  /** Draw order. Higher paints later. */
  z: number
}

export interface PlanStyle {
  background: string
  /** Grid opacity: spec says the reference shows NO grid on presentation output. */
  gridOpacity: number
  gridMinor: ElementStyle
  gridMajor: ElementStyle
  /** Exterior / cut profile — the heaviest wall tier. */
  wallCut: ElementStyle
  /** Interior partitions. Spec: thin DOUBLE LINES, unfilled — no poché. */
  wallInterior: ElementStyle
  /** Openings are punched by overdrawing in WHITE (spec: 8.5×, #ffffff). */
  opening: ElementStyle
  /** Stroked around a zone polygon, filled with the zone colour. */
  roomEnclosure: ElementStyle
  furniture: ElementStyle
  furnitureDetail: ElementStyle
  column: ElementStyle
  hatch: ElementStyle
  labelPrimary: { color: string; sizePx: number; weight: number; upper: boolean }
  labelSecondary: { color: string; sizePx: number; weight: number; upper: boolean }
}

export const INK = '#1a1d21'
export const WHITE = '#ffffff'
/** Pure black. The reference's linework is true black, not our UI ink. */
export const BLACK = '#000000'

/**
 * PAPER — faithful to the measured reference.
 *
 * Spec: background #ffffff · grid ABSENT (0 of 394 sampled px non-white in an
 * empty band) · walls thin unfilled double lines · room enclosure heavy ·
 * openings punched white · labels are service-room abbreviations only,
 * UPPERCASE (`STOR.`, `COAT.`, `CLEA.`), with all other identification carried
 * by a legend outside the plan.
 */
const PAPER: PlanStyle = {
  background: WHITE,
  gridOpacity: 0,
  gridMinor: { stroke: 'rgba(23,26,30,0.035)', tier: 'furniture', z: 0 },
  gridMajor: { stroke: 'rgba(23,26,30,0.075)', tier: 'furniture', z: 0 },
  wallCut: { stroke: BLACK, tier: 'wall', z: 40 },
  wallInterior: { stroke: BLACK, tier: 'wall', z: 40 },
  opening: { stroke: WHITE, tier: 'openingPunch', z: 45 },
  roomEnclosure: { stroke: BLACK, tier: 'roomEnclosure', z: 30 },
  furniture: { stroke: '#565e69', tier: 'furniture', z: 20 },
  furnitureDetail: { stroke: '#9aa1ab', tier: 'furniture', z: 20 },
  column: { stroke: BLACK, fill: COLUMN_FILL, tier: 'column', z: 35 },
  hatch: { stroke: 'rgba(23,26,30,0.28)', tier: 'detail', z: 25 },
  // Reference: 4.35 pt on an A4-landscape page ≈ 6 px at our typical scale.
  labelPrimary: { color: INK, sizePx: 6, weight: 500, upper: true },
  labelSecondary: { color: '#5f6771', sizePx: 5, weight: 400, upper: true },
}

/**
 * EDITOR — DECLARED DIVERGENCE from the reference, with reason.
 *
 * An editing surface needs in-place identification a presentation page does
 * not: you cannot select and rename a room you cannot name on screen. So the
 * editor keeps a visible grid and readable in-room labels. This is a
 * working-tool affordance, NOT imitation of the reference, and it is recorded
 * as a divergence in `research/qbiq-plan-style-spec.json` → `profiles.editor`.
 *
 * Hover/selection pills remain editor-only INTERACTIVE states and are never
 * part of the resting drawing.
 */
const EDITOR: PlanStyle = {
  ...PAPER,
  background: '#ffffff',
  gridOpacity: 1,
  labelPrimary: { color: INK, sizePx: 11, weight: 500, upper: false },
  labelSecondary: { color: '#5f6771', sizePx: 9, weight: 400, upper: false },
}

const PROFILES: Record<PlanProfile, PlanStyle> = { editor: EDITOR, paper: PAPER }

export function planStyle(profile: PlanProfile): PlanStyle {
  return PROFILES[profile]
}

/**
 * Legend entries, DERIVED from the document — never a hardcoded list.
 *
 * Requirement from the spec's `required_new_feature`: the reference identifies
 * zones by a swatch-keyed list OUTSIDE the plan, so parity needs a legend. It
 * must generate from the zone kinds actually present, so a zone kind added to a
 * plan appears in its legend with zero legend-side changes.
 *
 * Lands with 2e, when the fills reach their band — a legend built earlier would
 * explain colours that are about to change.
 */
export function legendEntries(
  zones: ReadonlyArray<{ zone_type: ZoneType }>,
): Array<{ kind: ZoneType; fill: string; line: string }> {
  const seen: ZoneType[] = []
  for (const z of zones) if (!seen.includes(z.zone_type)) seen.push(z.zone_type)
  return seen.map((kind) => ({ kind, ...ZONE[kind] }))
}
