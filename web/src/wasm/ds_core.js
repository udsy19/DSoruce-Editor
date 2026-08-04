/* @ts-self-types="./ds_core.d.ts" */

/**
 * The editor handle exposed to JavaScript. Holds the single source-of-truth
 * document; the frontend calls mutators then re-reads `state()` to render.
 */
export class Editor {
    static __wrap(ptr) {
        const obj = Object.create(Editor.prototype);
        obj.__wbg_ptr = ptr;
        EditorFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EditorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_editor_free(ptr, 0);
    }
    /**
     * Pin a room of `kind` onto `(x, y)` (world meters) — qbiq's "Place on Plan"
     * (workflow.md §3.5). `generate()` places anchored rooms FIRST at (near)
     * their point and bumps that kind's count. `kind` is a `SpaceKind` name
     * ("Reception"/"Cabin"/"Meeting"/…); an unknown kind is ignored. Serializes
     * with the doc via `state()`/`snapshot()`, mirroring `add_entry`.
     * @param {string} kind
     * @param {number} x
     * @param {number} y
     */
    add_anchor(kind, x, y) {
        const ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.editor_add_anchor(this.__wbg_ptr, ptr0, len0, x, y);
    }
    /**
     * Place a component (footprint centered at x,y). Returns the new component id
     * and makes it the current selection.
     * @param {string} category
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @returns {number}
     */
    add_component(category, x, y, w, h) {
        const ptr0 = passStringToWasm0(category, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_add_component(this.__wbg_ptr, ptr0, len0, x, y, w, h);
        return ret >>> 0;
    }
    /**
     * Add a building entry point (world meters). The test-fit generator anchors
     * its primary circulation spine to the first entry (spec §3). Serializes
     * with the doc via `state()`/`snapshot()`.
     * @param {number} x
     * @param {number} y
     */
    add_entry(x, y) {
        wasm.editor_add_entry(this.__wbg_ptr, x, y);
    }
    /**
     * Add a permanent interior keep-out (building core: stairs/lifts/shafts/
     * WCs) as a center-based rect. Keep-outs are hard obstacles `generate()`
     * always avoids regardless of freeze state, and render as `Core` zones.
     * Returns the new keep-out id. Serializes with the doc via `state()`.
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {string} label
     * @returns {number}
     */
    add_keepout(x, y, w, h, label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_add_keepout(this.__wbg_ptr, x, y, w, h, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Add a wall segment a→b. Returns the new wall id.
     * @param {number} ax
     * @param {number} ay
     * @param {number} bx
     * @param {number} by
     * @param {number} thickness
     * @returns {number}
     */
    add_wall(ax, ay, bx, by, thickness) {
        const ret = wasm.editor_add_wall(this.__wbg_ptr, ax, ay, bx, by, thickness);
        return ret >>> 0;
    }
    /**
     * Create a `Rect` zone (center `x,y`, size `w,h`) of `zone_type`; returns the
     * new zone id. The direct-manipulation "duplicate room" / "draw room"
     * primitive.
     * @param {string} zone_type
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {string} label
     * @returns {any}
     */
    add_zone(zone_type, x, y, w, h, label) {
        const ptr0 = passStringToWasm0(zone_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.editor_add_zone(this.__wbg_ptr, ptr0, len0, x, y, w, h, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Bind a material-bank product to a component (the "re-imagine" action).
     * `price_inr` is the observed bank price (undefined/None for spec-only
     * suppliers); it feeds the specified-furniture cost line in `metrics()`.
     * @param {number} id
     * @param {string} product_id
     * @param {string} product_name
     * @param {number | null} [price_inr]
     */
    assign_product(id, product_id, product_name, price_inr) {
        const ptr0 = passStringToWasm0(product_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(product_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.editor_assign_product(this.__wbg_ptr, id, ptr0, len0, ptr1, len1, !isLikeNone(price_inr), isLikeNone(price_inr) ? 0 : price_inr);
    }
    /**
     * Circulation / "walking place" evaluation of the current document.
     * @returns {any}
     */
    circulation() {
        const ret = wasm.editor_circulation(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Remove all anchor pins (mirrors `clear_entries`).
     */
    clear_anchors() {
        wasm.editor_clear_anchors(this.__wbg_ptr);
    }
    /**
     * Remove all entry points.
     */
    clear_entries() {
        wasm.editor_clear_entries(this.__wbg_ptr);
    }
    /**
     * Remove all keep-outs.
     */
    clear_keepouts() {
        wasm.editor_clear_keepouts(this.__wbg_ptr);
    }
    clear_selection() {
        wasm.editor_clear_selection(this.__wbg_ptr);
    }
    /**
     * Delete a component **by id** (complements `delete_selected`). Clears the
     * selection if it pointed at the deleted component.
     * @param {number} id
     */
    delete_component(id) {
        wasm.editor_delete_component(this.__wbg_ptr, id);
    }
    delete_selected() {
        wasm.editor_delete_selected(this.__wbg_ptr);
    }
    /**
     * Delete a room by zone id: removes the zone and the furniture it contains.
     * @param {number} id
     */
    delete_zone(id) {
        const ret = wasm.editor_delete_zone(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Construct a fresh `Editor` from a `snapshot` (scratch-clone for previews).
     * @param {any} snap
     * @returns {Editor}
     */
    static from_snapshot(snap) {
        const ret = wasm.editor_from_snapshot(snap);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Editor.__wrap(ret[0]);
    }
    /**
     * Autonomously generate a test-fit from a `Program` (plain JS object).
     * Clears existing components, places desks + meeting rooms deterministically
     * for `seed`, and returns the resulting `LayoutScore`.
     * @param {any} program
     * @param {bigint} seed
     * @param {boolean} keep_confirmed
     * @returns {any}
     */
    generate(program, seed, keep_confirmed) {
        const ret = wasm.editor_generate(this.__wbg_ptr, program, seed, keep_confirmed);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The stored CAD drafting-layer blob, or `""` when none.
     * @returns {string}
     */
    get_cad_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.editor_get_cad_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Score the current document against a `Program` without regenerating.
     * @param {any} program
     * @returns {any}
     */
    layout_score(program) {
        const ret = wasm.editor_layout_score(this.__wbg_ptr, program);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Merge zones `a` and `b`; returns the resulting zone id (a clean rect union
     * reuses `a`'s id) or the shared group id (logical L-room) as a number.
     * @param {number} a
     * @param {number} b
     * @returns {any}
     */
    merge_zones(a, b) {
        const ret = wasm.editor_merge_zones(this.__wbg_ptr, a, b);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Live metrics panel data. Areas are clipped to the traced floor-plate
     * polygon so non-rectangular plates report true numbers (see
     * `Document::plate_polygon`); rectangular rooms are unchanged.
     * @returns {any}
     */
    metrics() {
        const ret = wasm.editor_metrics(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Move a component **by id** to absolute center `(x, y)` meters. The by-id
     * primitive the AI uses; complements the selection-based `move_selected`.
     * @param {number} id
     * @param {number} x
     * @param {number} y
     */
    move_component(id, x, y) {
        wasm.editor_move_component(this.__wbg_ptr, id, x, y);
    }
    /**
     * Translate the current selection by (dx,dy) meters.
     * @param {number} dx
     * @param {number} dy
     */
    move_selected(dx, dy) {
        wasm.editor_move_selected(this.__wbg_ptr, dx, dy);
    }
    constructor() {
        const ret = wasm.editor_new();
        this.__wbg_ptr = ret;
        EditorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The traced floor-plate polygon as `[[x, y], ...]`, or `null` when the
     * walls don't close. For frontend zone-render clipping.
     * @returns {any}
     */
    plate() {
        const ret = wasm.editor_plate(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Hierarchical quantity schedule (level → room → category → item) derived
     * from the document directly — no IFC round-trip, works offline.
     * @returns {any}
     */
    qto_schedule() {
        const ret = wasm.editor_qto_schedule(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Rename a zone's label (e.g. to match a reclassified type).
     * @param {number} id
     * @param {string} label
     */
    rename_zone(id, label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_rename_zone(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Resize/move zone `id` to a `Rect` (center `x,y`, size `w,h`). Rejected if
     * the new bbox exceeds the wall bbox.
     * @param {number} id
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     */
    resize_zone(id, x, y, w, h) {
        const ret = wasm.editor_resize_zone(this.__wbg_ptr, id, x, y, w, h);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Replace the current document with a previously taken `snapshot`.
     * @param {any} snap
     */
    restore(snap) {
        const ret = wasm.editor_restore(this.__wbg_ptr, snap);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Monotonic mutation counter. Every `&mut self` method bumps it exactly
     * once (enforced by `tests::every_mutator_bumps_the_revision`), so a caller
     * that remembers the last value it saw can skip a `state()` re-read — and
     * the full-document serialize behind it — when nothing has changed.
     *
     * Deliberately coarse: it reports *that* the document changed, never what.
     * Rendering stays correct if a caller ignores it entirely.
     * @returns {bigint}
     */
    revision() {
        const ret = wasm.editor_revision(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Hit-test components at (x,y) in world coords, topmost first. Sets and
     * returns the selection (undefined in JS if nothing was hit).
     * @param {number} x
     * @param {number} y
     * @returns {number | undefined}
     */
    select_at(x, y) {
        const ret = wasm.editor_select_at(this.__wbg_ptr, x, y);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Store the frontend CAD drafting-layer blob (opaque JSON; the core never
     * parses it). It rides in snapshots, so undo/save round-trip it.
     * @param {string} json
     */
    set_cad_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.editor_set_cad_json(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Change a component's category (which slice of the material bank + which
     * top-view symbol it uses). The object inspector's category picker.
     * @param {number} id
     * @param {string} category
     */
    set_component_category(id, category) {
        const ptr0 = passStringToWasm0(category, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.editor_set_component_category(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * Set a component's hinge handedness (mirror across its long axis). Doors
     * imported from CAD recover a left- vs right-hand swing this way; renderers
     * reflect the leaf+arc when set. Additive: complements `set_component_rotation`
     * and leaves `add_component` (default `mirror: false`) untouched.
     * @param {number} id
     * @param {boolean} mirror
     */
    set_component_mirror(id, mirror) {
        wasm.editor_set_component_mirror(this.__wbg_ptr, id, mirror);
    }
    /**
     * Mark a component as **passive reference** (imported/legacy CAD furniture)
     * or back to counted. Reference components render but are excluded from every
     * metric (workstations, pax, cost, CO2) — see `Component::reference`. The
     * merge-stamp path (`App.stampBaseInto`) sets this `true` on imported
     * surroundings. Additive: leaves `add_component` (default `false`) untouched.
     * @param {number} id
     * @param {boolean} reference
     */
    set_component_reference(id, reference) {
        wasm.editor_set_component_reference(this.__wbg_ptr, id, reference);
    }
    /**
     * Set a component's rotation (radians, clockwise in the Y-down plan).
     * Doors/windows placed along angled walls need this; renderers already
     * honor `Component::rotation`.
     * @param {number} id
     * @param {number} radians
     */
    set_component_rotation(id, radians) {
        wasm.editor_set_component_rotation(this.__wbg_ptr, id, radians);
    }
    /**
     * Set a component's footprint (meters). Used by the object inspector's
     * editable W/H fields; clamped to a small positive minimum so a degenerate
     * zero-size box can't be created.
     * @param {number} id
     * @param {number} w
     * @param {number} h
     */
    set_component_size(id, w, h) {
        wasm.editor_set_component_size(this.__wbg_ptr, id, w, h);
    }
    /**
     * Advance a component's decision lifecycle. `state` is one of
     * "Open" | "InReview" | "Confirmed".
     * @param {number} id
     * @param {string} state
     */
    set_decision(id, state) {
        const ptr0 = passStringToWasm0(state, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.editor_set_decision(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * Move an existing wall's endpoints (by id) to `a=(ax,ay)`, `b=(bx,by)`.
     * No-op if the id is unknown. Lets an interior partition wall travel with a
     * room during drag/resize (generated plans have none; hand-drawn walls do).
     * @param {number} id
     * @param {number} ax
     * @param {number} ay
     * @param {number} bx
     * @param {number} by
     */
    set_wall(id, ax, ay, bx, by) {
        wasm.editor_set_wall(this.__wbg_ptr, id, ax, ay, bx, by);
    }
    /**
     * Reclassify zone `id` to `zone_type` (one of the serde `ZoneType` tags,
     * e.g. "Workspace"). Distinct from the component-level `set_decision`.
     * @param {number} id
     * @param {string} zone_type
     */
    set_zone_type(id, zone_type) {
        const ptr0 = passStringToWasm0(zone_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_set_zone_type(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Serialize the whole document to an opaque snapshot (JSON string). Pass it
     * back to `restore` / `from_snapshot` to undo.
     * @returns {any}
     */
    snapshot() {
        const ret = wasm.editor_snapshot(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Split zone `id` along `axis` ("Vertical" | "Horizontal") at world coord
     * `at`; returns `[id1, id2]`.
     * @param {number} id
     * @param {string} axis
     * @param {number} at
     * @returns {any}
     */
    split_zone(id, axis, at) {
        const ptr0 = passStringToWasm0(axis, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_split_zone(this.__wbg_ptr, id, ptr0, len0, at);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Whole document, for rendering. Returned as a plain JS object.
     * @returns {any}
     */
    state() {
        const ret = wasm.editor_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The most-specific zone id containing world point `(x, y)`, or undefined.
     * @param {number} x
     * @param {number} y
     * @returns {number | undefined}
     */
    zone_at(x, y) {
        const ret = wasm.editor_zone_at(this.__wbg_ptr, x, y);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Per-zone stats for the Statistics panel + AI reasoning. Array of
     * `{ id, zone_type, label, area, capacity, seated, pct_of_nia }`.
     * @returns {any}
     */
    zone_stats() {
        const ret = wasm.editor_zone_stats(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * All zones, for rendering. Part of `state()`, but exposed standalone for a
     * cheap re-read after a zone-only edit.
     * @returns {any}
     */
    zones() {
        const ret = wasm.editor_zones(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Editor.prototype[Symbol.dispose] = Editor.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_9a4e0ecb0fa16705: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_c25d447a39f5578f: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_aca499c5de7ff5e5: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_db4c3b15f63fc170: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_394265ed1e1b84ee: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_8a2dd23819f8a60a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_done_89b2b13e91a60321: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_entries_015dc610cd81ede0: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_get_507a50627bffa49b: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_c7eb1f358a7654df: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_6e0ad6d2a41b06f6: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_309b927aaf7a3fc7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_0677c962b281d01a: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_04f36e4056f1b851: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_6f722e4a93058b71: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_370319915dc99107: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_cd45aabdf6073e84: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_next_6dbf2c0ac8cde20f: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_71f2aa1cb3d1e37e: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_value_a5d5488a9589444a: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./ds_core_bg.js": import0,
    };
}

const EditorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_editor_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('ds_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
