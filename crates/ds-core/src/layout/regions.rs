//! Region, corridor and band planning: decomposing the plate into wings, the
//! per-region insets/seams, the drawn circulation network (spine, entry
//! connector, cross aisle) and how rooms and desks are allocated across regions.

use super::*;

// ---- M4: drawn circulation (spec §3) ----

/// Primary spine width (m): NBC 2016 corridor minimum 1.5 m; planning guidance
/// 1.5–2.4 m. One straight run per wing along the room band's face.
pub(crate) const SPINE_W: f64 = 1.5;
/// Secondary aisle width (m): IBC corridor 1118 mm — cross-aisles between desk
/// neighborhoods, joining the spine at right angles.
pub(crate) const SECONDARY_W: f64 = 1.15;
/// Facade maintenance gap (m): desks keep this to the window wall instead of a
/// full corridor — the perimeter ring wasted the daylight on corridor; real
/// plans give the window wall to workstations (spec §3 failure (a)).
pub(crate) const FACADE_GAP: f64 = 0.9;
/// Gap (m) between adjacent generated rooms in a band. Two independent 0.1 m
/// partitions 0.1 m apart rasterize as one solid mass on the evaluator's
/// 0.15 m grid, so the sliver can never fragment the walkable floor.
pub(crate) const ROOM_GAP: f64 = 0.1;
/// Gap (m) between a band room's rear and the plate boundary wall (rooms back
/// onto the wall; the old ring put a full corridor behind them).
pub(crate) const BAND_BACK_GAP: f64 = 0.1;
/// Anchor slide step (m) when hunting a clear slot along a band — 3 modules.
/// THE wall-dense-plate fix: instead of one fixed pitch position per room
/// (which real interior walls almost always reject), every room slides along
/// the band edge until a clear anchor appears.
pub(crate) const BAND_STEP: f64 = 0.15;
/// Candidate step (m) of the interior clear-pocket scan for rooms that found
/// no band slot on a wall-dense plate.
pub(crate) const POCKET_STEP: f64 = 0.6;
/// A region counts as a DOMINANT field region — reserved as a PURE open desk
/// field, zero room band (see `allocate_rooms`) — when its area is at least this
/// fraction of the LARGEST region's, so a plate with two comparably large wings
/// reserves BOTH for desks, not just the single biggest.
pub(crate) const FIELD_REGION_FRAC: f64 = 0.6;

/// Raster cell size (m) for plate decomposition — 0.5 m keeps the grid at a few
/// thousand cells (trivial cost) while resolving real wing geometry.
pub(crate) const REGION_CELL: f64 = 0.5;

/// SECOND-CHANCE ("wing") decomposition floors. The primary decomposition
/// stops at `REGION_MIN_DIM` (a desk-field wing), which on the repro plate
/// stranded 135 m² of ROOM-SCALE pockets — 7×3, 5.5×2.5, 5×3 — with no region,
/// no band and no pocket scan, while 38 briefed rooms dropped unplaced. A
/// second pass over the residue claims pockets down to room scale so the
/// existing allocate/band/pocket machinery reaches them. The dims are derived,
/// not tuned: a support room's 3.0 m module at the placement clamp's own 70%
/// floor is 2.1 m, backed `BAND_BACK_GAP` onto the wall → 2.0 m; the area is
/// that clamped room (2.1 × 2.31 ≈ 4.9 m²) plus its `ROOM_GAP` margins → 6 m².
pub(crate) const WING_MIN_DIM: f64 = 2.0;
pub(crate) const WING_MIN_AREA: f64 = 6.0;
/// A decomposition region must be at least this wide/tall (m) — narrower slivers
/// can't usefully hold a corridor-inset desk row, so they're discarded.
pub(crate) const REGION_MIN_DIM: f64 = 3.0;
/// …and at least this many m² — below this a region is noise, not a wing.
pub(crate) const REGION_MIN_AREA: f64 = 9.0;

/// Below this plate area (m²) a SINGLE (rectangular) plate reserves its desk field
/// from overflow rooms (see the pocket note in `plan_region`). The dead-zone bug
/// starved plates up to ~140 m² to ZERO desks because the fixed default program's
/// overflow rooms poisoned the field; a ~180 m² gate covers that zone with margin
/// while leaving the density-calibrated mid/large plates (≥ ~216 m²) exactly as
/// they were — those already seat a healthy field and host their overflow rooms in
/// a legitimate second band row rather than in the workstations.
pub(crate) const SMALL_PLATE_FIELD_AREA: f64 = 180.0;

/// Target floor for the whole-plate leftover fill (m² of NIA per SEAT). The
/// per-region packer fills each wing's inscribed desk rectangle, but a notched
/// irregular plate's maximal-rectangle tiling leaves big empty pockets (a
/// mid-size wing whose room band swallowed its depth, the shallow bottom band,
/// the fragments between the dominant column and the facades). The fill sweeps
/// those pockets on the SHARED global lattice, but only until total seats reach
/// `plate_area / floor` — so the plan spreads across the plate's real shape
/// instead of collapsing into a central column, WITHOUT crossing out of the
/// professional 8–12 m²/person band (§5).
///
/// The floor is STRATEGY-scaled: an **Open** plan is denser (more workstations,
/// the reserved wing filled hardest), a **Cellular** plan stays airier (its
/// floor IS given to enclosed rooms, so it should not be crammed with desks),
/// with **Balanced** between. This keeps the three strategies structurally
/// distinct by seat count even after the fill, while all stay inside the
/// professional band.
pub(crate) fn fill_density_floor(strategy: Strategy) -> f64 {
    match strategy {
        Strategy::Open => 8.2,
        Strategy::Balanced => 8.4,
        Strategy::Cellular => 10.5,
    }
}

/// Axis-aligned coverage threshold that flips the desk field to the principal-
/// axis oriented packer. A materially tilted or angular plate (a rotated area
/// selection, a hexagon, a sharp diagonal facade) has a small set of maximal
/// inscribed AXIS-ALIGNED rectangles, so `decompose_plate` covers only a
/// fraction of its true area and the axis lattice fills merely a corner. When
/// the decomposition covers LESS than this fraction of the plate, the whole desk
/// field is driven by `pack_desks_oriented` instead (desks follow the facade
/// angle and spread across the polygon). Chosen so the real multi-wing plate
/// (~0.80 coverage) and axis-aligned L/T plates (~0.85–1.0) keep the per-wing
/// band path, while rotated rects / hexagons (~0.45–0.60) fill via orientation.
pub(crate) const ORIENTED_COVER_FRAC: f64 = 0.70;

/// One region edge: how far the desk field insets from it, and whether it is a
/// SEAM shared with an adjacent region (half-corridor each side, forming ONE
/// shared corridor) or a plate-boundary/facade edge (0.9 m maintenance gap —
/// the window wall belongs to workstations, spec §3).
#[derive(Clone, Copy)]
pub(crate) struct Edge {
    pub(crate) inset: f64,
    pub(crate) seam: bool,
}

/// Per-edge insets for one region.
#[derive(Clone, Copy)]
pub(crate) struct Insets {
    pub(crate) left: Edge,
    pub(crate) right: Edge,
    pub(crate) top: Edge,
    pub(crate) bottom: Edge,
}

impl Insets {
    /// All four edges are plate boundary (single-region / rectangular path).
    pub(crate) fn boundary() -> Self {
        let e = Edge { inset: FACADE_GAP, seam: false };
        Insets { left: e, right: e, top: e, bottom: e }
    }
}

/// Minimum shared-edge overlap (m) for two regions to count as adjacent — below
/// this a mere corner-touch shouldn't halve a whole edge's corridor.
pub(crate) const SEAM_MIN_OVERLAP: f64 = 1.0;

/// Compute region `idx`'s per-edge insets: an edge becomes a seam (inset
/// `corridor/2`, the two neighbours' halves meeting as ONE shared corridor)
/// when another region abuts it co-linearly with ≥ `SEAM_MIN_OVERLAP` overlap;
/// otherwise it is plate boundary with the facade gap.
///
/// A SECONDARY (second-chance wing) region keeps only `BAND_BACK_GAP` at its
/// boundary edges: its ground is room-scale, and rooms back onto walls the way
/// band rooms do. Desks need no inset protection here — every desk slot is
/// independently held `FACADE_GAP` off the plate polygon by
/// `slot_fits_plate`, so the wing inset governs ROOM reach only.
pub(crate) fn region_insets(
    regions: &[geometry::Rect],
    idx: usize,
    corridor: f64,
    secondary: bool,
) -> Insets {
    let r = &regions[idx];
    let seam = Edge { inset: corridor / 2.0, seam: true };
    let eps = 1e-3;
    let mut ins = if secondary {
        let e = Edge { inset: BAND_BACK_GAP, seam: false };
        Insets { left: e, right: e, top: e, bottom: e }
    } else {
        Insets::boundary()
    };
    for (j, o) in regions.iter().enumerate() {
        if j == idx {
            continue;
        }
        let y_overlap = (r.y1.min(o.y1) - r.y0.max(o.y0)).max(0.0);
        let x_overlap = (r.x1.min(o.x1) - r.x0.max(o.x0)).max(0.0);
        if (o.x1 - r.x0).abs() < eps && y_overlap >= SEAM_MIN_OVERLAP {
            ins.left = seam;
        }
        if (o.x0 - r.x1).abs() < eps && y_overlap >= SEAM_MIN_OVERLAP {
            ins.right = seam;
        }
        if (o.y1 - r.y0).abs() < eps && x_overlap >= SEAM_MIN_OVERLAP {
            ins.bottom = seam;
        }
        if (o.y0 - r.y1).abs() < eps && x_overlap >= SEAM_MIN_OVERLAP {
            ins.top = seam;
        }
    }
    ins
}

/// The region an entry point anchors: nearest region rect (0 with no entry —
/// the largest region, since decomposition returns area-desc).
pub(crate) fn entry_region_idx(regions: &[geometry::Rect], entry: Option<Point>) -> usize {
    let Some(e) = entry else { return 0 };
    let mut best = 0;
    let mut best_d = f64::INFINITY;
    for (i, r) in regions.iter().enumerate() {
        let dx = (r.x0 - e.x).max(e.x - r.x1).max(0.0);
        let dy = (r.y0 - e.y).max(e.y - r.y1).max(0.0);
        let d = dx * dx + dy * dy;
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

/// Length (m) of a region's edges that lie on the plate BOUNDARY (facade) —
/// non-seam edges. High for a perimeter wing, low for one hemmed in by seams
/// with an adjacent region. The window/core placement bias sorts wings by this
/// (`allocate_rooms`): Window rooms prefer high-facade wings, Core low-facade.
pub(crate) fn region_facade_len(r: &geometry::Rect, ins: &Insets) -> f64 {
    let mut f = 0.0;
    if !ins.left.seam { f += r.height(); }
    if !ins.right.seam { f += r.height(); }
    if !ins.top.seam { f += r.width(); }
    if !ins.bottom.seam { f += r.width(); }
    f
}

/// Sort rank for the within-band placement bias: Window rooms take the band's
/// facade-end slots first, Core rooms fill the interior last, Flexible sits
/// between (its default order preserved by the STABLE sort). All-`Flexible`
/// (every derived-program room) → a no-op, so the derive path is byte-identical.
pub(crate) fn placement_rank(p: Placement) -> u8 {
    match p {
        Placement::Window => 0,
        Placement::Flexible => 1,
        Placement::Core => 2,
    }
}

/// Assign room jobs to regions. Returns per-region ordered job lists (the
/// placement order along each band), the per-region band depth (max depth of
/// its jobs — one COMMON depth per band keeps the corridor face a single
/// unbroken line, spec §4.3), and the jobs no region could take (they go to
/// the pocket pass). Deterministic and seed-independent: rooms concentrate in
/// the smallest wings so the largest wing stays a dense open desk field.
pub(crate) fn allocate_rooms(
    jobs: Vec<RoomJob>,
    regions: &[geometry::Rect],
    insets: &[Insets],
    entry_idx: usize,
    has_entry: bool,
    min_field_d: f64,
    field_regions: &[bool],
) -> (Vec<Vec<RoomJob>>, Vec<f64>, Vec<RoomJob>) {
    let n = regions.len();
    let mut lists: Vec<Vec<RoomJob>> = (0..n).map(|_| Vec::new()).collect();
    let mut overflow: Vec<RoomJob> = Vec::new();
    if n == 0 {
        return (lists, Vec::new(), jobs);
    }

    // Band capacity per region: length along the long axis, and the depth a
    // band may claim while leaving room for its spine + a desk-field sliver.
    let mut len_left = vec![0.0f64; n];
    let mut cap_d = vec![0.0f64; n];
    for i in 0..n {
        let r = &regions[i];
        let ins = &insets[i];
        let portrait = r.height() > r.width();
        let (along, cross) = if portrait {
            (r.height() - ins.bottom.inset - ins.top.inset, r.width())
        } else {
            (r.width() - ins.left.inset - ins.right.inset, r.height())
        };
        len_left[i] = along;
        // Reserve the rear gap, spine and window gap, AND `min_field_d` so at
        // least one desk row survives in front of the band. A shallow wing that
        // can't hold a room AND a desk field rejects the room here; it overflows
        // to the pocket pass rather than swallowing the wing with a room band
        // (spec 1: rooms cluster, desks line the facade). Deepening a room-wing's
        // band past this to fit the deep rooms was tried and REGRESSED the count:
        // room packing here is frontage-limited, so a deeper first row only
        // shrinks the second-row pocket, netting FEWER rooms — the room-wing
        // capacity comes from its two banded edges (band + pocket), not depth.
        cap_d[i] = (cross - BAND_BACK_GAP - SPINE_W - FACADE_GAP - min_field_d).max(0.0);
    }

    // Reserve the plate's dominant wing(s) as a PURE open desk field: zero band
    // capacity, so NO support room ever bands into them and their entire
    // cross-section stays workstations (spec §1: desks are the majority use).
    // A measured band grant (depth sized by dry-running the desk grid) was
    // TRIED here for the 50-room explicit brief and REVERTED on measurement:
    // the granted depth (~1.6 m, all the field could spare at the desk target)
    // was too shallow for any homeless room, so it bought a 44 m² spine and a
    // desk-field shrink for zero rooms placed — circulation 16.3 % → 23.8 %
    // NIA, breaching the registered 12–18 % falsifier. Room coverage comes
    // from the second-chance wings + pocket reach instead.
    for i in 0..n {
        if field_regions[i] {
            cap_d[i] = 0.0;
        }
    }

    // Pantry anchors the region farthest from the entry (social far end).
    let ec = regions[entry_idx];
    let (ecx, ecy) = ((ec.x0 + ec.x1) / 2.0, (ec.y0 + ec.y1) / 2.0);
    let far_idx = (0..n)
        .max_by(|&a, &b| {
            let da = ((regions[a].x0 + regions[a].x1) / 2.0 - ecx).powi(2)
                + ((regions[a].y0 + regions[a].y1) / 2.0 - ecy).powi(2);
            let db = ((regions[b].x0 + regions[b].x1) / 2.0 - ecx).powi(2)
                + ((regions[b].y0 + regions[b].y1) / 2.0 - ecy).powi(2);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0);

    // Region preference for generic rooms: fill the SMALLEST wings first so the
    // LARGEST wing stays a contiguous OPEN DESK FIELD. The old round-robin
    // scattered one room into every wing; on a wall-dense import each scattered
    // room grabbed a wall-free pocket — the exact area the desk packer needs —
    // so the open field fragmented and under-filled catastrophically (the field
    // bug: with the room program present the 843/882 m² plate seated ~3–9 desks,
    // yet the same plate open seats ~80). Concentrating rooms in the small wings
    // leaves the desk field intact and dense (spec §1: rooms cluster, desks line
    // the facade). Deterministic — the smallest-first order is a pure function of
    // the region geometry; seed variety now comes wholly from band side / cluster
    // rhythm / lattice phase / desk fill, which is ample (gallery diversity test).
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        regions[a]
            .area()
            .partial_cmp(&regions[b].area())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });
    // Per-wing facade length for the window/core region bias (soft, additive:
    // only non-Flexible jobs consult it).
    let facade_len: Vec<f64> = (0..n).map(|i| region_facade_len(&regions[i], &insets[i])).collect();
    for job in jobs {
        // Adjacency placement bias (spec §3): reception + the meeting/conference
        // family hug the ENTRY wing (client-facing), the pantry the FAR wing
        // (social anchor); every other room takes the smallest wing that still
        // fits. Meetings only claim the entry wing when there's a real entry AND
        // that wing is NOT the reserved open-desk field region — so the
        // client-facing cluster never eats the daylit desk field (spec §1).
        let meeting_family = matches!(
            job.kind,
            SpaceKind::Meeting | SpaceKind::Meeting4P | SpaceKind::Meeting6P | SpaceKind::Boardroom
        );
        let first = match job.kind {
            SpaceKind::Reception => Some(entry_idx),
            SpaceKind::Pantry => Some(far_idx),
            _ if meeting_family && has_entry && !field_regions[entry_idx] => Some(entry_idx),
            _ => None,
        };
        // Placement bias (soft): Window rooms prefer the highest-facade wings,
        // Core rooms the lowest (most interior); Flexible keeps the smallest-
        // wing-first order that reserves the largest wing for the desk field.
        // Stable re-sort → ties fall back to that base order.
        let scan: Vec<usize> = match job.placement {
            Placement::Flexible => order.clone(),
            Placement::Window => {
                let mut o = order.clone();
                o.sort_by(|&a, &b| facade_len[b].partial_cmp(&facade_len[a]).unwrap_or(std::cmp::Ordering::Equal));
                o
            }
            Placement::Core => {
                let mut o = order.clone();
                o.sort_by(|&a, &b| facade_len[a].partial_cmp(&facade_len[b]).unwrap_or(std::cmp::Ordering::Equal));
                o
            }
        };
        // A clamped room (down to 70% of the asked size) still counts as fitting.
        let mut target = None;
        for &i in first.iter().chain(scan.iter()) {
            if 0.7 * job.d <= cap_d[i] && 0.7 * job.w + ROOM_GAP <= len_left[i] {
                target = Some(i);
                break;
            }
        }
        match target {
            Some(i) => {
                len_left[i] -= job.w.min(len_left[i]) + ROOM_GAP;
                lists[i].push(job);
            }
            None => overflow.push(job),
        }
    }

    // Within-band placement bias: Window rooms slide in FIRST (nearest the
    // facade band-end), Core rooms LAST (toward the interior). Stable, so within
    // each placement class the size/priority order set above is preserved; a
    // list of all-`Flexible` jobs is left untouched (derive path unaffected).
    for l in lists.iter_mut() {
        l.sort_by_key(|j| placement_rank(j.placement));
    }

    let depths: Vec<f64> = (0..n)
        .map(|i| {
            lists[i]
                .iter()
                .map(|j| j.d.min(cap_d[i].max(0.0)))
                .fold(0.0f64, f64::max)
        })
        .collect();
    (lists, depths, overflow)
}

/// Desks: largest-remainder split proportional to each region's desk-field
/// capacity, clamped to it — regions that can seat nothing get zero.
///
/// **Capacity is now measured against the obstacles that are already down**, not
/// by dividing the field rect by the desk pitch. The empty-room arithmetic sent
/// 7 desks to two wings whose every candidate slot was already occupied by the
/// rooms banded into them (`rejects.obstacles` 6/6 and 3/3, measured), so those
/// wings placed 0 and the wings that could have used the desks were short.
///
/// A region whose measured capacity is zero **while it carries rooms** is a
/// ROOM WING: the reference's own strategy — a deep central field carries the
/// desk grid, shallow perimeter wings are given over entirely to rooms, amenity
/// and lounge. It is a declared state, not a silent zero, so `layout_diag` can
/// tell "this wing is meant to hold rooms" from "this wing failed".
#[allow(clippy::too_many_arguments)]
pub(crate) fn allocate_desks(
    program: &Program,
    plans: &[RegionPlan],
    clear: f64,
    desks: u32,
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &[(f64, f64, f64, f64)],
    lat: Lattice,
    // The packer's cluster-aisle rhythm. Capacity is measured through the SAME
    // `FieldGrid` the packer places out of, and the aisle moves slot positions —
    // so it is an input to capacity, not a placement-only detail.
    choices: SeedChoices,
) -> (Vec<u32>, Vec<u32>) {
    let n = plans.len();
    let mut desk_cap = vec![0u32; n];
    let mut grids: Vec<FieldGrid> = Vec::with_capacity(n);
    for (i, plan) in plans.iter().enumerate() {
        // NO depth pre-filter. It used to zero capacity for any field shallower
        // than one packer BLOCK (`min_viable_field_depth`), on the argument that
        // such a field "cannot hold the unit the packer places". That is a SECOND
        // model of the same question, and it disagreed with the enumeration in
        // the direction this file's own doc comment warns about — *"the reverse
        // strands floor."* MEASURED on the real plate, seeds 1 and 3: R3's field
        // is 2.0 m deep, under the 2.5 m paired block, so it was allocated 0 —
        // while its `FieldGrid` holds **one** free slot. A bench pair does not
        // fit; the pair's FIRST row does, and `outer_line(0)` is exactly that row.
        //
        // The guard was load-bearing only by accident: the desk that reached past
        // the notch into the far wing arrived through the top-up pass, which ran
        // only because the primary pass was under-delivering. Removing the
        // over-allocation removed the shortfall and with it the top-up, and the
        // far-wing desk went with it — until capacity stopped lying in the other
        // direction too. One model, both directions.
        let grid = FieldGrid::build(
            program, plan, plate, iwalls, obstacles, lat, clear, choices.cluster_cols, &[],
        );
        desk_cap[i] = grid.capacity();
        grids.push(grid);
    }

    let total_cap: u32 = desk_cap.iter().sum();
    let mut d_alloc = vec![0u32; n];
    if total_cap > 0 {
        let target = desks.min(total_cap);
        let mut rema: Vec<(f64, usize)> = Vec::with_capacity(n);
        let mut assigned = 0u32;
        for i in 0..n {
            let exact = target as f64 * desk_cap[i] as f64 / total_cap as f64;
            let base = (exact.floor() as u32).min(desk_cap[i]);
            d_alloc[i] = base;
            assigned += base;
            rema.push((exact - exact.floor(), i));
        }
        // Distribute the leftover to the largest fractional remainders, respecting
        // each cap; iterate to termination since total_cap ≥ target guarantees room.
        rema.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut left = target - assigned;
        while left > 0 {
            let mut progressed = false;
            for &(_, i) in &rema {
                if left == 0 {
                    break;
                }
                if d_alloc[i] < desk_cap[i] {
                    d_alloc[i] += 1;
                    left -= 1;
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        // Neighbourhood resolution: clamp each region's allocation to the
        // largest take its OWN grid can realise under the segment take rule
        // (`FieldGrid::resolve_take` — the identical walk `pack_desks` will
        // run on the identical grid). Without this, an allocation whose tail
        // lands 1–5 desks into a fresh segment would be unplaceable without a
        // runt, and `placed == allocated` — the one-model invariant the
        // capacity battery enforces — would silently become aspirational. The
        // trimmed desks flow to the OTHER regions' remaining quantized
        // headroom, largest first, so the plate-level target is still met
        // wherever the geometry allows it.
        loop {
            let mut freed = 0u32;
            for i in 0..n {
                let q = grids[i].resolve_take(d_alloc[i]);
                freed += d_alloc[i] - q;
                d_alloc[i] = q;
            }
            if freed == 0 {
                break;
            }
            let mut progressed = false;
            for &(_, i) in &rema {
                if freed == 0 {
                    break;
                }
                // Realizable takes jump by whole neighbourhoods, so offer the
                // whole freed budget and let the resolver keep what lands.
                let q = grids[i].resolve_take(d_alloc[i] + freed);
                if q > d_alloc[i] {
                    freed -= q - d_alloc[i];
                    d_alloc[i] = q;
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
    }
    (d_alloc, desk_cap)
}

/// Geometry plan of one region (wing): where its room band, primary spine,
/// entry connector, cross link and desk field sit. All circulation is explicit
/// **drawn** rect geometry — the perimeter `RectRing` regime is retired
/// (spec §3; the type stays in `zone.rs` for old snapshots).
#[derive(Clone)]
pub(crate) struct RegionPlan {
    /// long axis is Y: the band is a vertical strip, the spine vertical.
    pub(crate) portrait: bool,
    /// band on the high edge (top / right) instead of the low one.
    pub(crate) band_far: bool,
    /// slide "near" jobs from the `a1` end (the entry sits nearer that end).
    pub(crate) rev: bool,
    /// along-axis (long-axis) span of the band / spine / field.
    pub(crate) a0: f64,
    pub(crate) a1: f64,
    /// rooms' rear line (cross axis).
    pub(crate) band_base: f64,
    /// rooms' front line — the spine edge ALL room fronts align to, so the
    /// corridor face is one unbroken line (spec §4.3).
    pub(crate) band_front: f64,
    /// primary spine (1.5 m), `None` when the region is too shallow for one.
    pub(crate) spine: Option<geometry::Rect>,
    /// entry → spine connector strip, when the entry anchors in this region.
    pub(crate) connector: Option<geometry::Rect>,
    /// secondary strip joining the spine to a far-side seam corridor, so the
    /// drawn network is connected across regions by construction.
    pub(crate) link: Option<geometry::Rect>,
    /// desk-field rect (may be degenerate on a room-only wing).
    pub(crate) field: geometry::Rect,
    /// the region's whole placeable cross-section — the pocket-scan area.
    pub(crate) pocket: geometry::Rect,
    /// seam-strip corridors along edges shared with a neighbour region.
    pub(crate) seams: Vec<geometry::Rect>,
}

/// Compute one region's `RegionPlan`. The cross-axis stack reads
/// band (rooms, backed `BAND_BACK_GAP` onto the boundary wall) → spine →
/// desk field → facade gap; `band_far` mirrors it. Deterministic.
pub(crate) fn plan_region(
    outer: geometry::Rect,
    ins: Insets,
    portrait: bool,
    band_far: bool,
    band_depth: f64,
    entry: Option<Point>,
    field_region: bool,
    reserve_field: bool,
) -> RegionPlan {
    // Along-axis span (the long axis) and cross-axis outer coords + edges.
    let (a0, a1, c0, c1, e_lo, e_hi) = if portrait {
        (outer.y0 + ins.bottom.inset, outer.y1 - ins.top.inset, outer.x0, outer.x1, ins.left, ins.right)
    } else {
        (outer.x0 + ins.left.inset, outer.x1 - ins.right.inset, outer.y0, outer.y1, ins.bottom, ins.top)
    };
    let has_band = band_depth > 1e-9;
    // Rooms back onto a boundary wall (0.1 m); a seam keeps its half-corridor;
    // with no band the desk-field facade gap applies directly.
    let base_gap = |e: Edge| if e.seam { e.inset } else if has_band { BAND_BACK_GAP } else { e.inset };

    let (band_base, band_front, spine_c, field_c);
    if !has_band {
        // No rooms in this region -> no band, no spine: the whole inset rect is
        // open desk field (egress comes from the facade gaps + seams/entry). A
        // phantom spine here would waste 1.5 m of a pure open-plan wing.
        let base = if !band_far { c0 + e_lo.inset } else { c1 - e_hi.inset };
        spine_c = None;
        field_c = (c0 + e_lo.inset, c1 - e_hi.inset);
        band_base = base;
        band_front = base;
    } else if !band_far {
        let base = c0 + base_gap(e_lo);
        let front = snap_module(base + band_depth);
        let top = c1 - e_hi.inset;
        if front + SPINE_W <= top + 1e-9 {
            spine_c = Some((front, front + SPINE_W));
            field_c = (front + SPINE_W, top);
        } else {
            spine_c = None;
            field_c = (front, top);
        }
        band_base = base;
        band_front = front;
    } else {
        let base = c1 - base_gap(e_hi);
        let front = snap_module(base - band_depth);
        let bottom = c0 + e_lo.inset;
        if front - SPINE_W >= bottom - 1e-9 {
            spine_c = Some((front - SPINE_W, front));
            field_c = (bottom, front - SPINE_W);
        } else {
            spine_c = None;
            field_c = (bottom, front);
        }
        band_base = base;
        band_front = front;
    }

    // Map an (along-span, cross-span) pair into a world rect.
    let rect = |al0: f64, al1: f64, cr0: f64, cr1: f64| {
        if portrait {
            geometry::Rect { x0: cr0, y0: al0, x1: cr1, y1: al1 }
        } else {
            geometry::Rect { x0: al0, y0: cr0, x1: al1, y1: cr1 }
        }
    };

    let spine = spine_c.map(|(s0, s1)| rect(a0, a1, s0, s1));
    let field = rect(a0, a1, field_c.0, field_c.1);
    // Pocket-scan area for overflow rooms the band pass couldn't seat. For a
    // DOMINANT field region it is the BAND STRIP ONLY (banded edge → band
    // front): the pocket used to span the whole cross-section, so a room-heavy
    // plate dropped deep support rooms — pantry, collab, storage — into the
    // middle of the daylit desk field, fragmenting it (the field bug: the
    // 462 m² wing seated 16 of 54 desks). Reserving that wing's field for
    // workstations (spec §1: desks are the majority use) keeps its pocket in the
    // band. Other regions (small wings, and every region of a single-region
    // plate) keep the FULL cross-section so overflow rooms can stack in a second
    // band row rather than being dropped.
    // A SMALL single (rectangular) plate ALSO reserves its desk field: its pocket
    // is the band strip only, exactly like a dominant field wing. Otherwise the
    // pocket spanned the whole cross-section, so on a small plate the fixed default
    // program's overflow rooms (the ones the band frontage couldn't hold) dropped
    // into the middle of the desk field — and each overflow room's full-clearance
    // halo then rejected EVERY desk slot, starving the field to zero desks (the
    // dead-zone bug: plates up to ~140 m² seated 0 desks). Confining the pocket
    // makes a genuinely over-set room on a tiny plate DROP to a `program_fit`
    // shortfall rather than swallow the workstations (spec §1: desks are the
    // majority use). The gate is `SMALL_PLATE_FIELD_AREA` (in the caller): larger
    // single plates keep the full-cross pocket so their density-calibrated fill and
    // legitimate second band row are unchanged, and multi-region plates keep it for
    // their small non-field wings where rooms cluster (882 m² decomposition intact).
    // Pocket cross-edges reach the BOUNDARY at `BAND_BACK_GAP`, not the desk
    // facade gap: the pocket exists for ROOMS, rooms back onto walls exactly
    // as band rooms do (0.1 m), and desks never needed the pocket's protection
    // — every desk slot is held `FACADE_GAP` off the plate polygon by
    // `slot_fits_plate` independently. The 0.9 m pocket inset was a desk-era
    // leftover that permanently stranded a room-depth strip along every
    // pocket's window edge (measured: 10 m² on the repro plate's east wing
    // alone, typed Unassigned).
    let pocket_edge = |e: Edge| if e.seam { e.inset } else { BAND_BACK_GAP };
    let pocket = if field_region || reserve_field {
        if !band_far {
            rect(a0, a1, c0 + e_lo.inset, band_front.max(c0 + e_lo.inset))
        } else {
            rect(a0, a1, band_front.min(c1 - e_hi.inset), c1 - e_hi.inset)
        }
    } else if !band_far {
        rect(a0, a1, band_base, c1 - pocket_edge(e_hi))
    } else {
        rect(a0, a1, c0 + pocket_edge(e_lo), band_base)
    };

    // Entry connector: a spine-width strip from the entry point to the spine.
    let mut rev = false;
    let mut connector = None;
    if let (Some(e), Some((s0, s1))) = (entry, spine_c) {
        let (e_along, e_cross) = if portrait { (e.y, e.x) } else { (e.x, e.y) };
        rev = (e_along - a1).abs() < (e_along - a0).abs();
        if a1 - a0 > SPINE_W {
            let ax = snap_module(e_along.clamp(a0 + SPINE_W / 2.0, a1 - SPINE_W / 2.0));
            let ec = e_cross.clamp(c0, c1);
            let span = if ec < s0 - 1e-6 {
                Some((ec, s0))
            } else if ec > s1 + 1e-6 {
                Some((s1, ec))
            } else {
                None // the entry already opens onto the spine
            };
            if let Some((k0, k1)) = span {
                if k1 - k0 > 0.05 {
                    connector = Some(rect(ax - SPINE_W / 2.0, ax + SPINE_W / 2.0, k0, k1));
                }
            }
        }
    } else if let Some(e) = entry {
        // Entry into a RESERVED pure-desk field wing (no band, hence no spine):
        // draw a SECONDARY BOULEVARD running the field's FULL long axis at the
        // entry's cross-position. Two wins over the old 2.5 m approach stub:
        //   * NO DEAD-END — the stub terminated blind inside the desk block (a
        //     drawn corridor to nowhere, spec §3 / deliverable 2); a full-length
        //     run meets the region's along-edges (a seam corridor / the facade)
        //     at BOTH ends, so the door reads as a through-route into the network.
        //   * a LEGIBLE 1.15 m secondary aisle (IBC) that splits the reserved
        //     field into two desk neighborhoods and ties it into the primary-spine
        //     hierarchy — WITHOUT re-imposing the room-band + 1.5 m spine depth the
        //     concentration rework removed (that cost the wing whole desk columns).
        // Only the ENTRY wing is bisected; other reserved fields stay undivided and
        // dense, connected through their seam corridors. Never drawn without a real
        // entry, so the room-free dominance fits are unaffected.
        let (e_along, e_cross) = if portrait { (e.y, e.x) } else { (e.x, e.y) };
        rev = (e_along - a1).abs() < (e_along - a0).abs();
        let (fc0, fc1) = field_c;
        if a1 - a0 > SECONDARY_W && fc1 - fc0 > 2.0 * SECONDARY_W {
            // Keep the boulevard inside the field's cross-band so it never
            // straddles the facade gap or a seam.
            let cc = snap_module(e_cross.clamp(fc0 + SECONDARY_W / 2.0, fc1 - SECONDARY_W / 2.0));
            connector = Some(rect(a0, a1, cc - SECONDARY_W / 2.0, cc + SECONDARY_W / 2.0));
        }
    }

    // Cross link: when the desk field's far side is a seam, one secondary
    // aisle joins the spine to that seam so the corridor network is connected
    // as DRAWN geometry, not just as leftover walkable space. The entry
    // connector already crosses the field when present.
    let far_seam = if !band_far { e_hi.seam } else { e_lo.seam };
    let field_ok = field_c.1 - field_c.0 > 0.3 && a1 - a0 > SECONDARY_W + 0.2;
    let connector_crosses_field = connector.is_some_and(|r: geometry::Rect| {
        let (rc0, rc1) = if portrait { (r.x0, r.x1) } else { (r.y0, r.y1) };
        rc1 > field_c.0 + 1e-6 && rc0 < field_c.1 - 1e-6
    });
    let link = if spine_c.is_some() && far_seam && field_ok && !connector_crosses_field {
        let mid = snap_module((a0 + a1) / 2.0);
        Some(rect(mid - SECONDARY_W / 2.0, mid + SECONDARY_W / 2.0, field_c.0, field_c.1))
    } else {
        None
    };

    // Seam strips: this region's drawn half of each shared corridor (the
    // neighbour emits the other half — together exactly ONE corridor). The
    // HORIZONTAL strips yield their corner squares to the vertical ones: two
    // seams of one region used to both claim the corner, a double-cover the
    // partition-disjointness contract tolerates only while it is rare — the
    // second-chance wings multiplied seam count and pushed the summed corner
    // overlap past the 1% budget on the chamfer sweep. The corner floor stays
    // covered (by exactly one strip), so no coverage hole opens.
    let mut seams = Vec::new();
    let lx = if ins.left.seam { ins.left.inset } else { 0.0 };
    let rx = if ins.right.seam { ins.right.inset } else { 0.0 };
    if ins.left.seam {
        seams.push(geometry::Rect { x0: outer.x0, y0: outer.y0, x1: outer.x0 + ins.left.inset, y1: outer.y1 });
    }
    if ins.right.seam {
        seams.push(geometry::Rect { x0: outer.x1 - ins.right.inset, y0: outer.y0, x1: outer.x1, y1: outer.y1 });
    }
    if ins.bottom.seam {
        seams.push(geometry::Rect { x0: outer.x0 + lx, y0: outer.y0, x1: outer.x1 - rx, y1: outer.y0 + ins.bottom.inset });
    }
    if ins.top.seam {
        seams.push(geometry::Rect { x0: outer.x0 + lx, y0: outer.y1 - ins.top.inset, x1: outer.x1 - rx, y1: outer.y1 });
    }

    RegionPlan {
        portrait,
        band_far,
        rev,
        a0,
        a1,
        band_base,
        band_front,
        spine,
        connector,
        link,
        field,
        pocket,
        seams,
    }
}

/// Emit a plan's drawn circulation as `Circulation` Rect zones: the primary
/// spine ("Corridor"), the entry connector ("Entry"), the cross link ("Aisle")
/// and the seam strips ("Corridor").
pub(crate) fn emit_plan_zones(doc: &mut Document, plan: &RegionPlan) {
    fn circ(doc: &mut Document, r: &geometry::Rect, label: &str) {
        if r.width() > 0.05 && r.height() > 0.05 {
            push_zone(
                doc,
                ZoneType::Circulation,
                ZoneShape::Rect {
                    x: (r.x0 + r.x1) / 2.0,
                    y: (r.y0 + r.y1) / 2.0,
                    w: r.width(),
                    h: r.height(),
                },
                label,
            );
        }
    }
    if let Some(r) = &plan.spine {
        circ(doc, r, "Corridor");
    }
    if let Some(r) = &plan.connector {
        circ(doc, r, "Entry");
    }
    if let Some(r) = &plan.link {
        circ(doc, r, "Aisle");
    }
    for r in &plan.seams {
        circ(doc, r, "Corridor");
    }
}
