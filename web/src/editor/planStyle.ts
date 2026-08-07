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
 * Returns a width in CSS px, because that is the space the caller draws in.
 *
 * DO NOT multiply by `devicePixelRatio` here. `EditorCanvas.render` already
 * does `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` and `toScreen` returns CSS px,
 * so the context applies DPR itself. An earlier version of this function
 * multiplied as well, which applied DPR twice and drew every tier at exactly
 * 2× its intended weight on a retina display — verified in-browser at
 * devicePixelRatio 2 with a canvas buffer ratio of 2 and ctx transform 2.
 * The hierarchy still looked right because every tier scaled together, which is
 * precisely why it survived: the ladder is defined by RATIOS, so a uniform
 * error is invisible in the thing the ladder is judged on.
 *
 * Resolution independence needs no help from us — a 0.8 CSS px line already
 * becomes 1.6 device px on a 2× display, which is a crisper line, not a
 * half-weight one.
 *
 * `pixelsPerMeter` is accepted for future world-scaled widths (a wall that
 * thickens as you zoom). Today the ladder is screen-relative — the reference's
 * weights are paper-relative too — but the parameter is threaded now so 2b can
 * turn it on without touching call sites.
 */
/**
 * CHROME widths — editing affordances, in CSS px.
 *
 * These are deliberately NOT ladder tiers, and the distinction is the point.
 * The ladder is a DRAWING convention: it encodes how a plan's marks relate to
 * each other on a sheet, measured from the qbiq reference. A selection handle,
 * a ruler tick and a hover chip are not marks in the drawing — they are UI over
 * it, they vanish from `paper` output, and forcing them onto the ladder would
 * corrupt the ratios with values that have nothing to do with draughting.
 *
 * They still live here, so "no magic width in a renderer" holds for both kinds.
 * If you are adding a width, the question is which of the two it is.
 */
/**
 * LEVEL OF DETAIL — continuous, not snapped.
 *
 * The old rule was a single threshold: below 11 px a symbol became a chip, at
 * 11 px it became a full desk. One pixel of zoom changed the drawing, and every
 * symbol in the plan changed at the SAME instant because they cross the
 * threshold together — a visible pop across the whole canvas.
 *
 * These are RAMPS. Between `min` and `full` a mark crossfades, so zooming is
 * continuous and symbols cross at different moments because they differ in
 * size. Nothing in the plan ever changes state all at once.
 *
 * `hatch*` is where 2a''s finding lands: at 39 px/m a 100 mm partition is ~4 px
 * wide, and a hatch at 1/3-of-thickness spacing inside 4 px is not a texture,
 * it is a smear. Rather than a hard cutoff (which would pop the same way), the
 * hatch fades out as the wall gets thin and the wall reads as a plain double
 * line — which is qbiq's grammar, so the degraded state is a correct drawing
 * rather than a broken one.
 */
export const LOD = {
  /** Symbol detail, by the mark's smaller on-screen dimension (CSS px). */
  symbolMinPx: 7,
  symbolFullPx: 17,
  /** Wall hatch, by the wall's on-screen thickness (CSS px). */
  hatchMinPx: 5,
  hatchFullPx: 13,
} as const

/** Hermite ramp — 0 below `edge0`, 1 above `edge1`, C1-continuous between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** How much symbol detail a mark of this on-screen size earns, 0..1. */
export function detailLevel(minPx: number): number {
  return smoothstep(LOD.symbolMinPx, LOD.symbolFullPx, minPx)
}

/** How much hatch a wall of this on-screen thickness earns, 0..1. */
export function hatchLevel(thicknessPx: number): number {
  return smoothstep(LOD.hatchMinPx, LOD.hatchFullPx, thicknessPx)
}

/**
 * Rooms whose names the reference DOES print, abbreviated and uppercase.
 * Everything else is identified by the legend. Matched against the room label,
 * case-insensitively, as a prefix.
 */
export const SERVICE_ROOMS = [
  // The reference's own eight, measured.
  'STOR', 'COAT', 'CLEA', 'IT', 'PRINT', 'WC', 'MEP', 'SHAFT',
  // OUR vocabulary mapped onto their RULE. The reference abbreviates small
  // service rooms; a service core is one, it just is not a word that appears in
  // their plate. Extending the list is applying the rule, not inventing one.
  'CORE', 'PANTRY', 'SERVER', 'UTIL',
]

/** `OPEN WORKSPACE` -> `OPEN.` — the reference's own abbreviation shape. */
export function abbreviate(name: string): string {
  const first = name.split(/[\s/·]+/)[0] ?? name
  return first.length <= 4 ? `${first}.` : `${first.slice(0, 4)}.`
}

/**
 * PRINT inks — the sheet's own palette.
 *
 * These live here rather than in the exporter for the reason the fourth zone
 * palette existed: a colour defined next to the code that draws it is a colour
 * the other renderer cannot see. The sheet is a VIEW of this table, like the
 * canvas, so its inks belong with everything else's.
 *
 * They are distinct from the editor's `C` on purpose — print wants denser ink
 * than a screen — which is a declared difference, not a drifted copy.
 */
export const PRINT = {
  stroke: '#2e343b',
  detail: '#7c848e',
  wall: '#14181d',
  label: '#4a515a',
  zoneLabel: '#8b939e',
  /** Construction plan: generated partitions over-stroked. */
  newWall: '#3b6fd4',
  /** Demolition plan: existing-to-remove cross-hatch. */
  demolish: '#d6336c',
  /** Sheet ground. JPEG has no alpha, so the page must be painted. */
  paper: '#ffffff',
  /** Hairline rules on the sheet's own furniture (tables, keyplan frames). */
  rule: '#b9c0c9',
} as const

export const CHROME = {
  /** Hairline borders on affordances (tag pills, thumbnails, ruler ticks). */
  hairline: 1,
  /** Resize/selection handles and corner ticks. */
  handle: 1.5,
  /** Active selection outline — the heaviest chrome mark. */
  selection: 2,
  /**
   * Knockout halo behind a room tag that has nowhere clear to sit.
   *
   * Wider than `selection` because it is not a mark, it is an ERASER: the
   * stroke is drawn in paper white under the glyphs so desk line-work does not
   * run through the letterforms. It goes on only where a tag actually lands on
   * furniture — 29 of 205 label draws across the fixture set — because paper is
   * meant to be quiet and a halo on clear floor is just a smudge.
   */
  labelHalo: 3,
} as const

export function strokePx(tier: Tier, _pixelsPerMeter: number): number {
  const raw = BASE_STROKE_PX * TIER[tier]
  return Math.min(MAX_STROKE_PX, Math.max(MIN_STROKE_PX, raw))
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

// THE zone palette — Laiout, exact measured hexes (spec `laiout.palette`,
// provenance ASSERTED: two owner app views agreeing to the exact hex, sampled
// losslessly). Tolerance dE <= 3, covering capture colour-profile only.
//
// SEMANTIC FLIP, adopted deliberately (spec `laiout.semantic_flip`): DSource
// blue used to mean CIRCULATION. It now means WORKSPACE, and cream moves from
// workspace to amenity. We take Laiout's hue-to-program mapping wholesale
// rather than recolouring its palette into our old semantics — a half-adopted
// palette is neither. The risk is real: a returning user reads a familiar
// colour as a different thing. The LEGEND is the mitigation, which is why it is
// a required feature of this phase and not a nicety.
//
// LINES are DERIVED, not measured — Laiout's captures give fills, one wall grey
// and one secondary grey, no per-zone border. Each line is its own fill's hue
// at S x 0.75, L 48: dark enough to read on the fill, and hue-locked so the
// border can never drift away from the swatch the legend shows.
export const ZONE: Record<string, { fill: string; line: string }> = {
  // Ground, not figure — see `groundZones`. These values are what a circulation
  // zone falls back to if it is ever drawn as figure (e.g. selected/hovered);
  // the resting plan does not fill it at all.
  Circulation: { fill: '#d8d8d8', line: '#8b8b8b' },
  Workspace: { fill: '#bdddfb', line: '#487cad' }, // Laiout "open workspace"
  Meeting: { fill: '#d3c0fb', line: '#6b4ca8' }, // Laiout "meeting"
  Core: { fill: '#b3fabc', line: '#49ab56' }, // Laiout "core/service"
  Amenity: { fill: '#fbefc0', line: '#bea137' }, // Laiout "amenity"
  Collaboration: { fill: '#fad6ae', line: '#c87f2d' }, // Laiout "breakout"
  // NOT A LAIOUT VALUE. Their captures carry no closed-office role, so this is
  // DSource-original and must never be cited as measured. Hue 350 is the widest
  // gap in the five adopted hues (32/47/128/209/260), placed at the palette's
  // own band (S 60, L 91) so it belongs to the set without impersonating it.
  ClosedOffice: { fill: '#fbc0cb', line: '#b14356' },
  // Ground, like Circulation, and DELIBERATELY the same values as it: Phase 1
  // changes what leftover floor is CALLED, not how it looks. Phase 2.1 gives
  // this its own editor-only hatch (the "wasted floor, fix me" affordance);
  // until then an Unassigned zone must be indistinguishable from the
  // circulation it used to be, so the core change lands with zero visual delta.
  Unassigned: { fill: '#d8d8d8', line: '#8b8b8b' },
}

export const C = {
  surface: '#ffffff', // floor plate
  mat: '#eef0f4', // outside the building footprint (a touch deeper so the plate lifts)
  gridMinor: 'rgba(23,26,30,0.035)',
  gridMajor: 'rgba(23,26,30,0.075)',
  axis: 'rgba(45,91,214,0.18)',
  wall: '#2b313a', // interior partitions — medium
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

/**
 * The single warm-amber accent. MIRRORS the `--accent-amber` custom property —
 * canvas cannot read a CSS variable without a getComputedStyle round-trip per
 * frame, so the value necessarily exists twice. That duplication is DECLARED
 * and ENFORCED: `bench/style-gate.mjs` asserts this constant equals the token,
 * and fails if they drift. An undeclared second copy is what left 14 dead
 * `--zone-*` tokens shadowing this table.
 */
export const ACCENT_AMBER = '#E8A13C'

/**
 * SELECTION accent — amber's second sanctioned meaning (Ruling R5): selection,
 * hover, active, pick. References {@link ACCENT_AMBER} rather than restating the
 * value, so amber has one owner and a rebrand is one line.
 *
 * Distinct from ACCENT_AMBER because the MEANINGS are independent, not because
 * the colours differ. Reading `SELECTION_ACCENT` at a call site tells you why
 * that mark is amber, which a shared constant cannot.
 *
 * Never reaches paper: selection is chrome, and chrome vanishes on the sheet.
 *
 * DO NOT let this name absorb a third meaning. One owner of the VALUE permits
 * many honest names; it does not permit one dishonest name. If something amber
 * is neither an AI action nor a live selection, it gets its own token
 * referencing the same declaration — or it is not amber. Widening
 * `SELECTION_ACCENT` to mean "the warm one" would rebuild the vocabulary
 * blindness this structure exists to remove (ADR 0005, face 15).
 */
export const SELECTION_ACCENT = ACCENT_AMBER

/** The same value as a 0x literal, for three.js material colours. */
export const SELECTION_ACCENT_HEX = parseInt(ACCENT_AMBER.slice(1), 16)

/**
 * Colour math lives with the colours. Deriving a tint from its base is what
 * stops a hand-expanded copy going stale: the minimap's view cone was written
 * as `rgba(232, 161, 60, 0.45)`, which is this accent in decimal and therefore
 * invisible to any search for `#E8A13C`.
 */
/** Hex -> 0..1 RGB triplet, the form PDF content streams want. */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

export function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/**
 * Minimap (the 3D viewer's plan schematic). One cool grey at three weights —
 * solid for the label, 0.85 for wall lines, 0.35 for furniture dots. They share
 * a base on purpose, so the schematic reads as one material.
 */
export const MINIMAP = {
  accent: SELECTION_ACCENT,
  ink: '#5c626c',
  wallLine: 'rgba(92, 98, 108, 0.85)',
  dot: 'rgba(92, 98, 108, 0.35)',
  /** View cone — a radial fade of the accent to fully transparent. */
  coneInner: hexToRgba(SELECTION_ACCENT, 0.45),
  coneOuter: hexToRgba(SELECTION_ACCENT, 0),
  /** Viewer puck outline. */
  viewerOutline: 'rgba(24, 26, 30, 0.6)',
  /** The floating box's own chrome (warm translucent paper over the 3D view). */
  boxBorder: 'rgba(0,0,0,0.08)',
  boxBg: 'rgba(243, 241, 236, 0.72)',
  boxShadow: '0 2px 10px rgba(0,0,0,0.16)',
}

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

/**
 * How an element's interior is painted.
 *
 * A UNION rather than an optional colour, because the campaign needs three wall
 * grammars from one renderer: qbiq's unfilled double line (`none`), a solid
 * grey wall (`solid`), and Rayon's diagonal hatch (`hatch`). 2a' found that
 * `fill?: string` could express only one of them, so drawWall had no fill step
 * at all — the table's VOCABULARY was too small, not its design wrong.
 *
 * The acceptance condition this buys: switching wall treatment between the
 * three is now a change to THIS FILE ONLY. If a later grammar needs a fourth
 * kind, that is a second gap and worth a real look at ElementStyle; one
 * widening is a schema growing into its job.
 */
export type FillStyle =
  | { kind: 'none' }
  | { kind: 'solid'; color: string }
  | {
      kind: 'hatch'
      color: string
      /** Applied to `color`, so the same ink serves outline and hatch. */
      alpha: number
      /** 45 = down-right. */
      angleDeg: number
      /**
       * Absolute screen px, or a fraction of the element's own thickness.
       * Spec `rayon.hatch_spacing`: "start at 1/3 of wall thickness".
       */
      spacing: { px: number } | { ofThickness: number }
      /** Ladder tier for the hatch strokes — kept below the outlines so the
       *  texture never competes with the element's edge. */
      tier: Tier
    }

export interface ElementStyle {
  stroke?: string
  fill?: FillStyle
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
  labelPrimary: { color: string; sizePx: number; weight: number; upper: boolean }
  labelSecondary: { color: string; sizePx: number; weight: number; upper: boolean }
  /**
   * Zone kinds drawn as GROUND rather than figure.
   *
   * Laiout fills only PROGRAM zones; corridors are paper-white ground (spec
   * `laiout.circulation_rule`). Expressed as a list rather than an
   * `if (kind === 'Circulation')` in the renderer, because the rule is
   * figure/ground — which zones are content and which are the surface content
   * sits on — and that is a question the style table should answer.
   */
  /**
   * IDENTIFICATION POLICY for in-room text.
   *
   * Measured, and it falsified the brief: the reference does NOT label rooms
   * with name + area + pax. It carries eight tiny UPPERCASE service-room
   * abbreviations (`STOR.`, `COAT.`, `CLEA.`) and nothing else — every other
   * room is identified by the LEGEND beside the plan. That is why the legend is
   * a required feature and not a nicety: on paper it is the only identification
   * there is.
   *
   * The editor diverges DELIBERATELY. You cannot select and rename a room you
   * cannot name on screen, so the working surface keeps names and metrics. That
   * is a tool affordance, not imitation, and it is recorded as a divergence in
   * the spec's `profiles.editor`.
   */
  labelPolicy: {
    /** `service` = abbreviations for service rooms only, everything else to the
     *  legend (the reference). `all` = name every room (the editor). */
    names: 'all' | 'service'
    /** Area / pax line under the name. */
    metrics: boolean
    /**
     * Draw the soft pill behind a RESTING label?
     *
     * False in both profiles. A pill per room turns a drawing into a UI: at
     * overview zoom the plan was mostly pills. It is now an INTERACTIVE state —
     * hover and selection only — which is what it always should have been, and
     * matches the rule that interactive states are never part of the resting
     * drawing.
     */
    pillAtRest: boolean
  }
  groundZones: ZoneType[]
  /**
   * Texture drawn over `Unassigned` ground, or `null` for none.
   *
   * Keyed to the ONE type rather than to all ground zones: circulation is
   * working floor and gets nothing, unassigned floor is a defect the planner
   * should see. Both remain ground — neither is filled with its palette colour.
   */
  unassignedHatch: FillStyle | null
  /**
   * Dashed hairline around `Unassigned` ground, or `null` for none.
   *
   * Carries more signal than the hatch on the shapes this actually marks: the
   * unassigned pockets on the reference plate have inradii of 0.53–1.1 m, so at
   * overview zoom they are 19–40 px wide and a 9 px hatch pitch fits two to four
   * strokes across them. An outline is legible at any width, because a ribbon
   * is nearly all edge.
   */
  unassignedOutline: ElementStyle | null
  /**
   * Poché over `Core` zones, or `null` for none.
   *
   * **Paper says null, and the spec is why.** `qbiq-plan-style-spec.json`
   * `wall_poche` records the measurement: *"There is NO dark poche anywhere in
   * the reference. Walls are drawn as thin DOUBLE LINES with unfilled
   * interiors."* The only poché/hatch the spec sanctions is between WALL FACES
   * (Rayon's grammar); `core` appears in it exactly once, as a palette role,
   * with no texture. Professional convention pochés the material that is CUT —
   * walls — not a core's floor area.
   *
   * So this is per-profile rather than a module constant: the editor keeps the
   * texture as a working affordance (a core reads as "not your floor plate at
   * a glance"), and the sheet does not. Same divergence pattern as the grid and
   * the in-room labels, recorded in the spec's `profiles.editor`.
   *
   * This became a live question only when the LOD-reference fix resurrected a
   * poché that had never rendered; before that the paper profile carried a
   * declaration it never honoured, and every paper-parity judgment in this
   * workstream — including Phase 0's "presentation output is already fully
   * correct" — was measured against a render where it was dead. Setting paper to
   * `null` keeps those judgments valid rather than silently invalidating them.
   */
  corePoche: FillStyle | null
  /**
   * What a ground zone gets INSTEAD of its palette fill. `null` is true ground:
   * the paper shows through. The editor uses a barely-there tint (spec allows
   * <=2%) so a corridor stays visible as a selectable object while editing --
   * an affordance, not a fill.
   */
  groundTint: string | null
}

export /**
 * Rayon's wall treatment (spec `target.wall_form`). Fine ~45 degree diagonal
 * hatch between the two faces, at the hatch tier so it sits under the outlines.
 * Spacing starts at the spec's 1/3-of-thickness; PROVISIONAL, tuned against
 * reference imagery, and changing it is a one-line edit here.
 *
 * Switch a profile to `{ kind: 'none' }` to get qbiq's unfilled double line
 * back, or `{ kind: 'solid', color }` for a Laiout-style grey wall. That is the
 * whole point of the union.
 */
const RAYON_WALL_HATCH: FillStyle = {
  kind: 'hatch',
  color: '#171a1e',
  alpha: 0.34,
  angleDeg: 45,
  spacing: { ofThickness: 1 / 3 },
  tier: 'furniture',
}

/**
 * UNASSIGNED hatch — the editor-only "wasted floor" mark, SECONDARY to the
 * dashed outline.
 *
 * Uses the existing `hatch` kind of {@link FillStyle}. That union was widened
 * once, for wall grammars, with a note that a FOURTH kind would be a schema
 * finding rather than a patch; this needs no fourth kind, which is the union
 * doing its job.
 *
 * **The division of labour, and why it is this way round.** The pockets this
 * marks are RIBBONS — inradii of 0.53–1.1 m on the reference plate, so 19–40 px
 * wide at overview zoom, where a fixed 9 px pitch fits two to four strokes
 * across them. A ribbon is nearly all edge, so the edge is the semantically
 * correct carrier and {@link PlanStyle.unassignedOutline} is primary: it says
 * *flagged* at any zoom. The hatch is the zoom-scale CONFIRMER — its pitch is
 * fixed in screen px, so stroke count per pocket grows as you zoom in, and at
 * working zoom the texture says *wasted floor* where at overview it only
 * whispers. That is progressive disclosure by construction, not a compromise.
 *
 * **Ink target is a RELATION, not a fitted number.** The rule: clearly
 * subordinate to program fill, clearly above ground. Program fill measures
 * 33/255 against the same ground, so the hatch targets **half of that, 14–18/255**,
 * verified by pixel census (see `bench/` and the audit's evidence set). The
 * first value shipped, α 0.035, measured ≤7/255 — indistinguishable from ground,
 * which is why this is expressed as a band against a measured reference instead
 * of an opacity somebody eyeballed. Changing the band is a re-registration;
 * changing α to HIT the band is just meeting it.
 *
 * **Editor only.** `paper` renders this as nothing at all: on a sheet it is
 * indistinguishable from circulation, because no competitor publishes a
 * dead-space category and neither do we (see the core's `published_zone_type`).
 * This is a working-tool divergence, recorded in the spec's `profiles.editor`
 * alongside the grid and the in-room labels.
 */
export const UNASSIGNED_HATCH: FillStyle = {
  kind: 'hatch',
  color: '#5c626c',
  alpha: 0.1, // measured: stroke delta 16/255 — mid-band (target 14-18)
  angleDeg: 45,
  spacing: { px: 9 },
  tier: 'furniture',
}

/** Zone-core poche: fixed screen density, so it reads the same at any zoom. */
const CORE_POCHE_BASE: Extract<FillStyle, { kind: 'hatch' }> = {
  color: '#5c626c', // overridden per-zone with the palette line colour at the call site
  kind: 'hatch',
  alpha: 0.34,
  angleDeg: 45,
  spacing: { px: 6 },
  tier: 'furniture',
}

const INK = '#1a1d21'
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
  wallCut: { stroke: BLACK, fill: RAYON_WALL_HATCH, tier: 'wall', z: 40 },
  wallInterior: { stroke: BLACK, fill: RAYON_WALL_HATCH, tier: 'wall', z: 40 },
  opening: { stroke: WHITE, tier: 'openingPunch', z: 45 },
  roomEnclosure: { stroke: BLACK, tier: 'roomEnclosure', z: 30 },
  furniture: { stroke: '#565e69', tier: 'furniture', z: 20 },
  furnitureDetail: { stroke: '#9aa1ab', tier: 'furniture', z: 20 },
  column: { stroke: BLACK, fill: { kind: 'solid', color: COLUMN_FILL }, tier: 'column', z: 35 },
  // Reference: 4.35 pt on an A4-landscape page ≈ 6 px at our typical scale.
  labelPrimary: { color: INK, sizePx: 6, weight: 500, upper: true },
  labelSecondary: { color: '#5f6771', sizePx: 5, weight: 400, upper: true },
  labelPolicy: { names: 'service', metrics: false, pillAtRest: false },
  groundZones: ['Circulation', 'Unassigned'],
  groundTint: null, // paper: corridors ARE the paper
  unassignedHatch: null, // paper: and so is wasted floor — the sheet never tells
  unassignedOutline: null,
  corePoche: null, // spec: the reference has NO poche anywhere
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
  labelPolicy: { names: 'all', metrics: true, pillAtRest: false },
  groundTint: 'rgba(23,26,30,0.02)', // editor: still selectable, still ground
  unassignedHatch: UNASSIGNED_HATCH,
  unassignedOutline: {
    stroke: 'rgba(92, 98, 108, 0.45)',
    dash: [4, 3],
    tier: 'furniture',
    z: 31,
  },
  corePoche: CORE_POCHE_BASE,
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
  //
  // GROUND ZONES ARE EXCLUDED. A swatch keyed to white (paper) or a 2% tint
  // (editor) explains nothing, and the reference legend lists program
  // facilities only.
  //
  // SCOPE NOTE: this one line belongs to Phase 2.6 and was pulled forward into
  // Phase 1, because Phase 1 introduces `Unassigned` and without it the Plan Key
  // would sprout an "Unassigned" swatch the moment the core started emitting the
  // type — a visible regression shipped deliberately and fixed a commit later.
  // Phase 2.6 keeps the rest of its scope (`stats.ts` ordering, the report's
  // LEGEND_ORDER, the on-sheet legend).
  const ground = planStyle('paper').groundZones
  const seen: ZoneType[] = []
  for (const z of zones) {
    if (ground.includes(z.zone_type)) continue
    if (!seen.includes(z.zone_type)) seen.push(z.zone_type)
  }
  return seen.map((kind) => ({ kind, ...ZONE[kind] }))
}
