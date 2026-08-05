/* tslint:disable */
/* eslint-disable */

/**
 * The editor handle exposed to JavaScript. Holds the single source-of-truth
 * document; the frontend calls mutators then re-reads `state()` to render.
 */
export class Editor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Pin a room of `kind` onto `(x, y)` (world meters) — qbiq's "Place on Plan"
     * (workflow.md §3.5). `generate()` places anchored rooms FIRST at (near)
     * their point and bumps that kind's count. `kind` is a `SpaceKind` name
     * ("Reception"/"Cabin"/"Meeting"/…); an unknown kind is ignored. Serializes
     * with the doc via `state()`/`snapshot()`, mirroring `add_entry`.
     */
    add_anchor(kind: string, x: number, y: number): void;
    /**
     * Place a component (footprint centered at x,y). Returns the new component id
     * and makes it the current selection.
     */
    add_component(category: string, x: number, y: number, w: number, h: number): number;
    /**
     * Add a building entry point (world meters). The test-fit generator anchors
     * its primary circulation spine to the first entry (spec §3). Serializes
     * with the doc via `state()`/`snapshot()`.
     */
    add_entry(x: number, y: number): void;
    /**
     * Add a permanent interior keep-out (building core: stairs/lifts/shafts/
     * WCs) as a center-based rect. Keep-outs are hard obstacles `generate()`
     * always avoids regardless of freeze state, and render as `Core` zones.
     * Returns the new keep-out id. Serializes with the doc via `state()`.
     */
    add_keepout(x: number, y: number, w: number, h: number, label: string): number;
    /**
     * Add a wall segment a→b. Returns the new wall id.
     */
    add_wall(ax: number, ay: number, bx: number, by: number, thickness: number): number;
    /**
     * Create a `Rect` zone (center `x,y`, size `w,h`) of `zone_type`; returns the
     * new zone id. The direct-manipulation "duplicate room" / "draw room"
     * primitive.
     */
    add_zone(zone_type: string, x: number, y: number, w: number, h: number, label: string): any;
    /**
     * Bind a material-bank product to a component (the "re-imagine" action).
     * `price_inr` is the observed bank price (undefined/None for spec-only
     * suppliers); it feeds the specified-furniture cost line in `metrics()`.
     */
    assign_product(id: number, product_id: string, product_name: string, price_inr?: number | null): void;
    /**
     * Circulation / "walking place" evaluation of the current document.
     */
    circulation(): any;
    /**
     * Remove all anchor pins (mirrors `clear_entries`).
     */
    clear_anchors(): void;
    /**
     * Remove all entry points.
     */
    clear_entries(): void;
    /**
     * Remove all keep-outs.
     */
    clear_keepouts(): void;
    clear_selection(): void;
    /**
     * Delete a component **by id** (complements `delete_selected`). Clears the
     * selection if it pointed at the deleted component.
     */
    delete_component(id: number): void;
    delete_selected(): void;
    /**
     * Delete a room by zone id: removes the zone and the furniture it contains.
     */
    delete_zone(id: number): void;
    /**
     * The scoring engine's density verdict for this document, 0..100 — 100
     * across the professional 8–12 m²/person band, tapering to 0 at ≤4.5
     * (crammed) and ≥20 (sparse).
     *
     * **Exported because the frontend was deciding "too dense" on its own.**
     * `ai/engine.ts` compared `area_per_workstation` against a hand-typed
     * 6.0 m² whose comment said "planning norm (see layout.rs)" — a citation to
     * a constant that has never existed there. It was also the wrong quantity:
     * the scorer judges m² per SEAT (desks + meeting capacity), not per desk.
     * So the AI preview warned the user off layouts the engine was perfectly
     * happy with, in the engine's name. Whether a plan is professionally dense
     * is one question with one answer; this is it.
     */
    density_score(): number;
    /**
     * Construct a fresh `Editor` from a `snapshot` (scratch-clone for previews).
     */
    static from_snapshot(snap: any): Editor;
    /**
     * Autonomously generate a test-fit from a `Program` (plain JS object).
     * Clears existing components, places desks + meeting rooms deterministically
     * for `seed`, and returns the resulting `LayoutScore`.
     */
    generate(program: any, seed: bigint, keep_confirmed: boolean): any;
    /**
     * The stored CAD drafting-layer blob, or `""` when none.
     */
    get_cad_json(): string;
    /**
     * Score the current document against a `Program` without regenerating.
     */
    layout_score(program: any): any;
    /**
     * Merge zones `a` and `b`; returns the resulting zone id (a clean rect union
     * reuses `a`'s id) or the shared group id (logical L-room) as a number.
     */
    merge_zones(a: number, b: number): any;
    /**
     * Live metrics panel data. Areas are clipped to the traced floor-plate
     * polygon so non-rectangular plates report true numbers (see
     * `Document::plate_polygon`); rectangular rooms are unchanged.
     */
    metrics(): any;
    /**
     * Move a component **by id** to absolute center `(x, y)` meters. The by-id
     * primitive the AI uses; complements the selection-based `move_selected`.
     */
    move_component(id: number, x: number, y: number): void;
    /**
     * Translate the current selection by (dx,dy) meters.
     */
    move_selected(dx: number, dy: number): void;
    constructor();
    /**
     * The traced floor-plate polygon as `[[x, y], ...]`, or `null` when the
     * walls don't close. For frontend zone-render clipping.
     */
    plate(): any;
    /**
     * Hierarchical quantity schedule (level → room → category → item) derived
     * from the document directly — no IFC round-trip, works offline.
     */
    qto_schedule(): any;
    /**
     * Rename a zone's label (e.g. to match a reclassified type).
     */
    rename_zone(id: number, label: string): void;
    /**
     * Resize/move zone `id` to a `Rect` (center `x,y`, size `w,h`). Rejected if
     * the new bbox exceeds the wall bbox.
     */
    resize_zone(id: number, x: number, y: number, w: number, h: number): void;
    /**
     * Replace the current document with a previously taken `snapshot`.
     */
    restore(snap: any): void;
    /**
     * Monotonic mutation counter. Every `&mut self` method bumps it exactly
     * once (enforced by `tests::every_mutator_bumps_the_revision`), so a caller
     * that remembers the last value it saw can skip a `state()` re-read — and
     * the full-document serialize behind it — when nothing has changed.
     *
     * Deliberately coarse: it reports *that* the document changed, never what.
     * Rendering stays correct if a caller ignores it entirely.
     */
    revision(): bigint;
    /**
     * Hit-test components at (x,y) in world coords, topmost first. Sets and
     * returns the selection (undefined in JS if nothing was hit).
     */
    select_at(x: number, y: number): number | undefined;
    /**
     * Store the frontend CAD drafting-layer blob (opaque JSON; the core never
     * parses it). It rides in snapshots, so undo/save round-trip it.
     */
    set_cad_json(json: string): void;
    /**
     * Change a component's category (which slice of the material bank + which
     * top-view symbol it uses). The object inspector's category picker.
     */
    set_component_category(id: number, category: string): void;
    /**
     * Set a component's hinge handedness (mirror across its long axis). Doors
     * imported from CAD recover a left- vs right-hand swing this way; renderers
     * reflect the leaf+arc when set. Additive: complements `set_component_rotation`
     * and leaves `add_component` (default `mirror: false`) untouched.
     */
    set_component_mirror(id: number, mirror: boolean): void;
    /**
     * Mark a component as **passive reference** (imported/legacy CAD furniture)
     * or back to counted. Reference components render but are excluded from every
     * metric (workstations, pax, cost, CO2) — see `Component::reference`. The
     * merge-stamp path (`App.stampBaseInto`) sets this `true` on imported
     * surroundings. Additive: leaves `add_component` (default `false`) untouched.
     */
    set_component_reference(id: number, reference: boolean): void;
    /**
     * Set a component's rotation (radians, clockwise in the Y-down plan).
     * Doors/windows placed along angled walls need this; renderers already
     * honor `Component::rotation`.
     */
    set_component_rotation(id: number, radians: number): void;
    /**
     * Set a component's footprint (meters). Used by the object inspector's
     * editable W/H fields; clamped to a small positive minimum so a degenerate
     * zero-size box can't be created.
     */
    set_component_size(id: number, w: number, h: number): void;
    /**
     * Advance a component's decision lifecycle. `state` is one of
     * "Open" | "InReview" | "Confirmed".
     */
    set_decision(id: number, state: string): void;
    /**
     * Move an existing wall's endpoints (by id) to `a=(ax,ay)`, `b=(bx,by)`.
     * No-op if the id is unknown. Lets an interior partition wall travel with a
     * room during drag/resize (generated plans have none; hand-drawn walls do).
     */
    set_wall(id: number, ax: number, ay: number, bx: number, by: number): void;
    /**
     * Reclassify zone `id` to `zone_type` (one of the serde `ZoneType` tags,
     * e.g. "Workspace"). Distinct from the component-level `set_decision`.
     */
    set_zone_type(id: number, zone_type: string): void;
    /**
     * Serialize the whole document to an opaque snapshot (JSON string). Pass it
     * back to `restore` / `from_snapshot` to undo.
     */
    snapshot(): any;
    /**
     * Split zone `id` along `axis` ("Vertical" | "Horizontal") at world coord
     * `at`; returns `[id1, id2]`.
     */
    split_zone(id: number, axis: string, at: number): any;
    /**
     * Whole document, for rendering. Returned as a plain JS object.
     */
    state(): any;
    /**
     * The most-specific zone id containing world point `(x, y)`, or undefined.
     */
    zone_at(x: number, y: number): number | undefined;
    /**
     * Per-zone stats for the Statistics panel + AI reasoning. Array of
     * `{ id, zone_type, label, area, capacity, seated, pct_of_nia }`.
     */
    zone_stats(): any;
    /**
     * All zones, for rendering. Part of `state()`, but exposed standalone for a
     * cheap re-read after a zone-only edit.
     */
    zones(): any;
}

/**
 * Depth of a door/window leaf across its wall (m) — the committed footprint;
 * the swing arc is drawn by the 2D symbol, not stored.
 *
 * **Exported for the same reason as [`open_share`]:** `cad/archTools.ts` had its
 * own `LEAF_DEPTH = 0.15`, so a hand-drawn door and a generated door were one
 * object with two authored depths. Cheap to unify now, weird later.
 */
export function door_depth(): number;

/**
 * Standard office single-leaf door width (m) — 900×2100. Exported alongside
 * [`door_depth`]: `cad/archTools.ts` had `DOOR_DEFAULT = 0.9` for exactly the
 * same object.
 */
export function door_width(): number;

/**
 * The open-plan share of headcount seated at open workstations.
 *
 * **Exported because the frontend was keeping its own copies and one had already
 * drifted.** `program/spec.ts` used 0.85 while `ai/suggestProgram.ts` used 0.90
 * with a comment claiming it mirrored Rust — so the same headcount produced a
 * different building depending on which path the user came in through (88
 * people → 75 desks via the Program step, 79 via suggestProgram). A value that
 * decides how many desks a floor gets has exactly one owner: the generator that
 * places them. Read this; do not re-declare it.
 */
export function open_share(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_editor_free: (a: number, b: number) => void;
    readonly door_depth: () => number;
    readonly door_width: () => number;
    readonly editor_add_anchor: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly editor_add_component: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly editor_add_entry: (a: number, b: number, c: number) => void;
    readonly editor_add_keepout: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly editor_add_wall: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly editor_add_zone: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly editor_assign_product: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly editor_circulation: (a: number) => [number, number, number];
    readonly editor_clear_anchors: (a: number) => void;
    readonly editor_clear_entries: (a: number) => void;
    readonly editor_clear_keepouts: (a: number) => void;
    readonly editor_clear_selection: (a: number) => void;
    readonly editor_delete_component: (a: number, b: number) => void;
    readonly editor_delete_selected: (a: number) => void;
    readonly editor_delete_zone: (a: number, b: number) => [number, number];
    readonly editor_density_score: (a: number) => number;
    readonly editor_from_snapshot: (a: any) => [number, number, number];
    readonly editor_generate: (a: number, b: any, c: bigint, d: number) => [number, number, number];
    readonly editor_get_cad_json: (a: number) => [number, number];
    readonly editor_layout_score: (a: number, b: any) => [number, number, number];
    readonly editor_merge_zones: (a: number, b: number, c: number) => [number, number, number];
    readonly editor_metrics: (a: number) => [number, number, number];
    readonly editor_move_component: (a: number, b: number, c: number, d: number) => void;
    readonly editor_move_selected: (a: number, b: number, c: number) => void;
    readonly editor_new: () => number;
    readonly editor_plate: (a: number) => [number, number, number];
    readonly editor_qto_schedule: (a: number) => [number, number, number];
    readonly editor_rename_zone: (a: number, b: number, c: number, d: number) => [number, number];
    readonly editor_resize_zone: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly editor_restore: (a: number, b: any) => [number, number];
    readonly editor_revision: (a: number) => bigint;
    readonly editor_select_at: (a: number, b: number, c: number) => number;
    readonly editor_set_cad_json: (a: number, b: number, c: number) => void;
    readonly editor_set_component_category: (a: number, b: number, c: number, d: number) => void;
    readonly editor_set_component_mirror: (a: number, b: number, c: number) => void;
    readonly editor_set_component_reference: (a: number, b: number, c: number) => void;
    readonly editor_set_component_rotation: (a: number, b: number, c: number) => void;
    readonly editor_set_component_size: (a: number, b: number, c: number, d: number) => void;
    readonly editor_set_decision: (a: number, b: number, c: number, d: number) => void;
    readonly editor_set_wall: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly editor_set_zone_type: (a: number, b: number, c: number, d: number) => [number, number];
    readonly editor_snapshot: (a: number) => [number, number, number];
    readonly editor_split_zone: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly editor_state: (a: number) => [number, number, number];
    readonly editor_zone_at: (a: number, b: number, c: number) => number;
    readonly editor_zone_stats: (a: number) => [number, number, number];
    readonly editor_zones: (a: number) => [number, number, number];
    readonly open_share: () => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
