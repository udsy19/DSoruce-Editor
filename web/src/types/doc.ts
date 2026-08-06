/**
 * The TS mirror of the Rust core's serialized document (serde field names).
 *
 * The Rust `Document` is the source of truth; these are read-only shapes handed
 * back by `Editor.state()`. Nothing here may grow behaviour — mutations go
 * through `Editor` and the caller re-reads `state()` (see CLAUDE.md).
 *
 * Dependency rule: this module imports nothing from `metrics.ts`/`program.ts`,
 * so the type layer stays an acyclic chain: program → metrics → doc.
 */

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
  /** How many people this object seats. FROM THE MODEL (`model::seats_for`),
   *  resolved once in the core — never inferred from size on screen (R2). */
  seats?: number
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
  label: string
  product_id: string | null
  /**
   * Bound product price (₹), authoritative. The core owns this — it is written
   * by `Editor.assign_product` and rides `state()`/`snapshot()`.
   *
   * It was previously absent from this mirror, which is exactly why the App's
   * bindings map became the de-facto price source and why a component bound
   * through the core could reach a cost line unpriced. Every cost-line
   * constructor reads THIS; the bindings map is UI-layer display metadata
   * (supplier, brand, thumbnail) and is not authoritative for money.
   */
  price_inr?: number | null
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
  /**
   * Floor the generator could neither furnish nor justify as circulation — too
   * narrow for a code-width path, or sealed off from the walking network.
   * Emitted by `ds-core`'s residual classifier (`layout/conform.rs`).
   *
   * **Ground, never figure, and never a published line item.** It renders as
   * paper like circulation does; the editor may flag it, exports fold it back
   * into Circulation (the core's `zone_stats_published`). Treat it as
   * circulation's twin wherever you special-case `'Circulation'` — a check that
   * says `!== 'Circulation'` to mean "is a real room" must exclude this too.
   */
  | 'Unassigned'
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

/** The core's room-type vocabulary (mirrors Rust `layout::SpaceKind`). A
 *  `RoomReq.kind` names one of these by string; the Program builder's richer
 *  vocabulary (Executive/Large/Medium office, XL conference, …) maps onto these
 *  at different footprints (see `program/spec.ts`). Lives here rather than with
 *  the program types because `DocAnchor` (document state) names one. */
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

/** Default room name per zone type, applied when a room is reclassified. */
export const ZONE_LABEL: Record<ZoneType, string> = {
  Circulation: 'Circulation',
  Workspace: 'Open Workspace',
  Meeting: 'Meeting Room',
  Collaboration: 'Collaboration',
  Core: 'Core',
  ClosedOffice: 'Closed Office',
  Amenity: 'Amenity',
  Unassigned: 'Unassigned',
}

/** A selected room + its on-screen box, handed to the floating `RoomTools`. */
export interface RoomSelection {
  zone: DocZone
  /** Room bounding box in canvas CSS px (top-left origin). */
  box: { left: number; top: number; width: number; height: number }
}
