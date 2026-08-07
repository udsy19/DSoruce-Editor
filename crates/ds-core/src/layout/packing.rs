//! Desk packing: the axis-aligned lattice packer and the principal-axis
//! oriented packer for tilted/irregular plates.

use super::*;

/// Pack one region's desk field on the GLOBAL lattice `lat`, skipping any cell
/// that collides with an obstacle (rooms, keep-outs, frozen items, connector).
/// Emits the Workspace zone(s) — segmented at the secondary aisles / crossing
/// strips so rect zones tile without overlap — plus the drawn secondary-aisle
/// `Circulation` rects. Returns desks placed.
#[allow(clippy::too_many_arguments)]
/// Centre and rotation of outer-axis line `o`.
///
/// **Shared by the packer and by `field_free_slots` on purpose.** Under bench
/// pairing the outer axis is not a uniform pitch: rows come back-to-back in
/// blocks of `2·desk + SPINE_GAP + clear`, which is DENSER than two single rows.
/// The first capacity measurement stepped a uniform pitch instead and undercounted
/// rows — a 14 × 10 m plate that seats 6 desks was allocated 5 — so the two must
/// come from one function rather than from two that agree today.
#[allow(clippy::too_many_arguments)]
fn outer_line(
    o: i64,
    bench: bool,
    outer_first: f64,
    outer_first_near: f64,
    outer_half: f64,
    outer_desk: f64,
    block: f64,
    outer_pitch: f64,
    base_rot: f64,
) -> (f64, f64) {
    if bench {
        let p = o / 2;
        let w = o % 2;
        let near = outer_first_near
            + p as f64 * block
            + if w == 1 { outer_desk + SPINE_GAP } else { 0.0 };
        let rot = if w == 1 { base_rot + std::f64::consts::PI } else { base_rot };
        (near + outer_half, rot)
    } else {
        (outer_first + o as f64 * outer_pitch, base_rot)
    }
}

/// **The minimum depth at which a desk field is a field**, derived from the
/// packer's own arithmetic rather than chosen.
///
/// The packer lays desks in BLOCKS on the cross axis. Under bench pairing the
/// block is two desks back-to-back plus the aisle that serves them —
/// `2·desk_h + SPINE_GAP + clear`; with pairing off it is one row and its aisle,
/// `desk_h + clear`. A field shallower than one block cannot hold the unit the
/// packer places, so allocating desks to it is allocating them to nothing.
///
/// At the shipped defaults (desk 1.6 × 0.8, clearance 0.9, `SPINE_GAP` 0.0) that
/// is **2.5 m** paired and **1.7 m** single. The sample plate's R2 field is
/// 2.0 m: below the block, and it placed 0 of its 2 allocated desks.
///
/// It is a NECESSARY condition, not a sufficient one — R1's field is 3.5 m, over
/// the threshold, and also placed 0 because rooms had consumed it. Depth is what
/// this function knows; occupancy is what `field_free_slots` measures.
pub(crate) fn min_viable_field_depth(program: &Program, clear: f64) -> f64 {
    if program.bench_pairs {
        2.0 * program.desk_h + SPINE_GAP + clear
    } else {
        program.desk_h + clear
    }
}

/// How many desks a region's field can ACTUALLY take, against the obstacles that
/// are already down.
///
/// `allocate_desks` used to divide the field rect by the desk pitch. That is
/// capacity in an empty room, and the desks are packed into a room that is not
/// empty: on the sample plate R1 was allocated 5 desks into a field whose six
/// candidate slots were **all six** rejected as occupied, and R2 was allocated 2
/// into three slots that were **all three** occupied. Seven desks went to wings
/// that could not take one, and the regions that could were short by seven.
///
/// So capacity is measured the way placement is: walk the same lattice and apply
/// the same predicates. This function and `pack_desks` MUST agree — a slot this
/// counts and the packer rejects is an over-allocation, and the reverse strands
/// floor. `desk_capacity_never_exceeds_what_the_packer_places` pins that.
#[allow(clippy::too_many_arguments)]
pub(crate) fn field_free_slots(
    program: &Program,
    plan: &RegionPlan,
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &[(f64, f64, f64, f64)],
    lat: Lattice,
    clear: f64,
) -> u32 {
    let f = plan.field;
    if f.x1 <= f.x0 || f.y1 <= f.y0 || program.desk_w <= 0.0 || program.desk_h <= 0.0 {
        return 0;
    }
    let column_major = plan.portrait;
    let (fw, fh) = if column_major {
        (program.desk_h, program.desk_w)
    } else {
        (program.desk_w, program.desk_h)
    };
    let (hw, hh) = (fw / 2.0, fh / 2.0);
    let (px, py) = (fw + clear, fh + clear);
    let bench = program.bench_pairs;
    // Same axis assignment the packer uses: a portrait region runs its uniform
    // INNER axis along Y and its paired OUTER axis along X.
    let (inner_o, i_lo, i_hi, i_half, i_pitch) =
        if column_major { (lat.oy, f.y0, f.y1, hh, py) } else { (lat.ox, f.x0, f.x1, hw, px) };
    let (outer_o, o_lo, o_hi, o_half, o_pitch, o_desk) =
        if column_major { (lat.ox, f.x0, f.x1, hw, px, fw) } else { (lat.oy, f.y0, f.y1, hh, py, fh) };

    let mut inner_first = inner_o + ((i_lo - inner_o) / i_pitch).ceil() * i_pitch + i_half;
    if inner_first + i_half > i_hi + 1e-9 && i_hi - i_lo >= 2.0 * i_half - 1e-9 {
        inner_first = i_lo + i_half;
    }
    let mut outer_first = outer_o + ((o_lo - outer_o) / o_pitch).ceil() * o_pitch + o_half;
    if outer_first + o_half > o_hi + 1e-9 && o_hi - o_lo >= o_desk - 1e-9 {
        outer_first = o_lo + o_half;
    }
    let block = 2.0 * o_desk + SPINE_GAP + clear;
    let outer_first_near = outer_first - o_half;

    let mut n = 0u32;
    let mut o = 0i64;
    loop {
        let (oc, _) =
            outer_line(o, bench, outer_first, outer_first_near, o_half, o_desk, block, o_pitch, 0.0);
        if oc + o_half > o_hi + 1e-9 {
            break;
        }
        let mut i = 0i64;
        loop {
            let ic = inner_first + i as f64 * i_pitch;
            if ic + i_half > i_hi + 1e-9 {
                break;
            }
            let (cx, cy) = if column_major { (oc, ic) } else { (ic, oc) };
            let (sx, sy) = (snap_module(cx), snap_module(cy));
            if sx - hw >= f.x0 - 1e-9
                && sx + hw <= f.x1 + 1e-9
                && sy - hh >= f.y0 - 1e-9
                && sy + hh <= f.y1 + 1e-9
                && slot_fits_plate(plate, sx, sy, fw, fh, FACADE_GAP)
                && slot_clears_walls(iwalls, sx, sy, fw, fh)
                && !footprint_overlaps(obstacles, sx, sy, fw, fh, clear - 1e-6)
            {
                n += 1;
            }
            i += 1;
        }
        o += 1;
    }
    n
}

pub(crate) fn pack_desks(
    doc: &mut Document,
    program: &Program,
    plan: &RegionPlan,
    desk_target: u32,
    region_no: Option<u32>,
    // `false` on the top-up pass: zones were already emitted — only place.
    emit_zones: bool,
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    lat: Lattice,
    clear: f64,
    choices: SeedChoices,
    // Why slots were turned down, and the grid actually walked. `None` on the
    // passes whose rejections are not diagnostic (the top-up re-walks ground the
    // primary pass already covered, so its rejections are mostly "occupied").
    mut diag: Option<&mut RegionDesks>,
) -> u32 {
    // The desk field is the region plan's field rect (facade side of the
    // spine); the 0.9 m facade gap and the drawn circulation stay OUTSIDE it,
    // so desks line the daylit perimeter (spec §3) instead of a corridor ring.
    let field = plan.field;
    let (dz_x0, dz_y0, dz_x1, dz_y1) = (field.x0, field.y0, field.x1, field.y1);
    let column_major = plan.portrait;

    // Workspace zone over the field. Drawn circulation (spine/connector/link/
    // seams) is emitted separately by `emit_plan_zones`; the facade gap stays
    // deliberately un-zoned floor (it is maintenance clearance, not a room).
    if emit_zones && dz_x1 > dz_x0 && dz_y1 > dz_y0 {
        let ws_label = match region_no {
            Some(n) => format!("Open Workspace ({})", n),
            None => "Open Workspace".to_string(),
        };
        push_zone(
            doc,
            ZoneType::Workspace,
            ZoneShape::Rect {
                x: (dz_x0 + dz_x1) / 2.0,
                y: (dz_y0 + dz_y1) / 2.0,
                w: dz_x1 - dz_x0,
                h: dz_y1 - dz_y0,
            },
            &ws_label,
        );
    }

    // --- Desk grid fills the field on the GLOBAL lattice, skipping any cell
    // that collides with a frozen or just-placed obstacle (rooms, keep-outs,
    // connector/link strips). ---
    let mut desks_here = 0u32;
    'desks: {
        if program.desk_w <= 0.0 || program.desk_h <= 0.0 {
            break 'desks;
        }
        if dz_x1 <= dz_x0 || dz_y1 <= dz_y0 {
            break 'desks;
        }
        let cluster_cols = choices.cluster_cols.max(1);
        let bench = program.bench_pairs;

        // World-axis desk footprint. A portrait wing rotates every desk ±π/2 so
        // rows read along the wing's long (Y) axis with the SAME back-to-back
        // pair convention as landscape wings — the world footprint swaps w/h
        // (spec §4.2; the old code paired unrotated desks side-by-side along X
        // and flipped them π about the wrong axis, so symbols read scrambled).
        let (fw, fh, base_rot) = if column_major {
            (program.desk_h, program.desk_w, std::f64::consts::FRAC_PI_2)
        } else {
            (program.desk_w, program.desk_h, 0.0)
        };
        let hw = fw / 2.0;
        let hh = fh / 2.0;
        let pitch_x = fw + clear;
        let pitch_y = fh + clear;

        // Two axes. The INNER axis runs uniform-pitch desks along the region's
        // long side (cluster aisles accrue here). The OUTER axis carries the rows
        // that PAIR back-to-back under bench desking. Row-major (landscape) runs
        // rows along Y (outer) with long desk rows along X (inner); a portrait
        // region transposes so its wing fills with natural vertical rows.
        let (inner_o, inner_dz0, inner_dz1, inner_half, inner_pitch, inner_size) = if column_major {
            (lat.oy, dz_y0, dz_y1, hh, pitch_y, fh)
        } else {
            (lat.ox, dz_x0, dz_x1, hw, pitch_x, fw)
        };
        let (outer_o, outer_dz0, outer_dz1, outer_half, outer_pitch, outer_desk) = if column_major {
            (lat.ox, dz_x0, dz_x1, hw, pitch_x, fw)
        } else {
            (lat.oy, dz_y0, dz_y1, hh, pitch_y, fh)
        };

        // GLOBAL lattice phase: the first desk line in each region is the first
        // line of the shared lattice (module-snapped origin at the plate bbox
        // min, plus the odd-seed half-pitch) that clears this region's inset. Because the phase comes from the plate
        // origin — not the region corner — adjacent wings' rows/columns land on
        // the SAME lines across the seam. `ceil` picks that first line; the offset
        // it introduces is why global alignment can cost a fractional row (bench
        // pairing more than pays it back). Inner axis (uniform pitch):
        let mut inner_first =
            inner_o + ((inner_dz0 - inner_o) / inner_pitch).ceil() * inner_pitch + inner_half;
        // Degenerate-field fallback (small-plate graceful degradation): the GLOBAL
        // lattice phase — the odd-seed half-pitch, or an inset edge falling just
        // past a lattice line — can push the ONLY line that physically fits OUT of
        // a shallow field, zeroing an axis that has room for a desk. When the first
        // phased line overshoots but a desk fits in the span, seat that single line
        // at the field's near edge. Fires only in the n==0-but-fits case, so
        // aligned fields on larger plates keep the shared global lattice untouched.
        if inner_first + inner_half > inner_dz1 + 1e-9 && inner_dz1 - inner_dz0 >= inner_size - 1e-9 {
            inner_first = inner_dz0 + inner_half;
        }
        let inner_n = if inner_first + inner_half <= inner_dz1 + 1e-9 {
            (((inner_dz1 - inner_half - inner_first) / inner_pitch).floor() as i64 + 1).max(0)
        } else {
            0
        };

        // OUTER axis. Under bench pairing rows come back-to-back in PAIRS:
        //   [desk | SPINE_GAP | desk(rotated π) | clear aisle] repeating,
        // block = 2·desk + SPINE_GAP + clear — DENSER than 2·(desk+clear) single
        // rows, which is exactly why real plans pair. Pairs anchor to global BLOCK
        // lines so stacked wings still share pair lines. `bench == false` restores
        // uniform single rows on the same global lattice.
        let block = 2.0 * outer_desk + SPINE_GAP + clear;
        let mut outer_first =
            outer_o + ((outer_dz0 - outer_o) / outer_pitch).ceil() * outer_pitch + outer_half;
        // Same degenerate-field fallback as the inner axis: a shallow (≈one-pitch)
        // field must still seat its single row even when the global lattice phase
        // lands the first line past its far edge (seed 1 on an ~88 m² plate zeroed
        // the field this way). o==0 sits at `outer_first`, so this pull-to-near-edge
        // also rescues the bench pair's first row.
        if outer_first + outer_half > outer_dz1 + 1e-9 && outer_dz1 - outer_dz0 >= outer_desk - 1e-9 {
            outer_first = outer_dz0 + outer_half;
        }
        // Pairs start at the first PITCH-aligned line clearing the inset (not the
        // coarser block line — that wasted up to a full 2·desk+clear block at each
        // region's near edge, shrinking the field's spread). Two regions sharing
        // the outer range still resolve the same start, so their rows align.
        let outer_first_near = outer_first - outer_half;
        // Center + rotation of outer desk index `o`. The pair partner mirrors
        // across the spine: base orientation + π (0/π in landscape wings,
        // π/2 / 3π/2 in portrait wings — same reading convention, rotated).
        let outer_at = |o: i64| -> (f64, f64) {
            outer_line(
                o, bench, outer_first, outer_first_near, outer_half, outer_desk, block,
                outer_pitch, base_rot,
            )
        };
        let outer_n = {
            let mut n = 0i64;
            while outer_at(n).0 + outer_half <= outer_dz1 + 1e-9 {
                n += 1;
            }
            n
        };
        if let Some(d) = diag.as_deref_mut() {
            d.grid_outer = outer_n;
            d.grid_inner = inner_n;
            d.field_depth = outer_dz1 - outer_dz0;
        }
        if inner_n <= 0 || outer_n <= 0 {
            break 'desks;
        }

        // ---- NEIGHBOURHOOD SPREAD ------------------------------------------
        //
        // The sweep below stops the instant it has placed `desk_target` desks.
        // With a target BELOW what the field holds, that packed every desk
        // against the field's near edge and left the rest of the wing bare.
        //
        // MEASURED on the sample plate (`Editor::layout_diag`, F1): the dominant
        // wing's field is 14.8 × 36.2 m; its 90 desks occupied x 12.9…21.0 —
        // **8.1 m of 14.8** — with ~240 m² of its own field empty beside them.
        // The plan was at professional density (10.3 m²/desk, inside the 8–12
        // band) and geometrically collapsed into a column. Every one of the five
        // suspects the brief listed was eliminated by the same instrument: the
        // decomposition found all three wings and covered 86.9% of the plate
        // (gate 70%), so it is not `decompose_plate`, not `ORIENTED_COVER_FRAC`,
        // and not keep-outs.
        //
        // So spread the rows the target DOES buy across the whole field instead
        // of stacking them at one edge. The gaps that opens are not waste — they
        // are the aisles between desk neighbourhoods, which is what makes an open
        // field read as a plan rather than as a slab of furniture.
        //
        // Bench pairs move as PAIRS, so back-to-back rows stay back-to-back and
        // the pairing convention is untouched; only which pair-lines are used
        // changes, and each used line is still a global-lattice line.
        let pairs_avail = if bench { (outer_n + 1) / 2 } else { outer_n };
        let rows_needed = if inner_n > 0 {
            ((desk_target as i64) + inner_n - 1) / inner_n
        } else {
            0
        };
        let units_needed = if bench { (rows_needed + 1) / 2 } else { rows_needed };
        // Never denser than requested and never sparser than available.
        let units_used = units_needed.clamp(1, pairs_avail.max(1));
        // Map the u-th used unit onto the available range. Integer arithmetic, so
        // the result is deterministic and every unit still lands on its lattice
        // line — the spread chooses BETWEEN lattice lines, it does not invent
        // positions between them.
        // ONLY the primary per-region field pass spreads. `emit_zones` is exactly
        // that flag: the top-up pass and the whole-plate leftover fill both pass
        // `false`, and their whole job is to seat desks in the gaps a previous
        // pass left. Spreading THEM would stride over the very gaps they exist to
        // close — measured: with the spread applied to every pass the plate fell
        // from 92 desks to 70 and the fill placed 0 of its 22-desk budget.
        let spread_unit = |u: i64| -> i64 {
            if !emit_zones || units_used >= pairs_avail || units_used <= 0 {
                u
            } else {
                (u * (pairs_avail - 1)) / (units_used - 1).max(1)
            }
        };
        let outer_at_spread = |o: i64| -> (f64, f64) {
            if bench {
                let (u, w) = (o / 2, o % 2);
                outer_at(spread_unit(u) * 2 + w)
            } else {
                outer_at(spread_unit(o))
            }
        };
        // The sweep now walks only the units it will use; without this the
        // remapped indices would revisit the last line once `u` passed
        // `units_used` and re-reject every slot as already occupied.
        let outer_sweep = if !emit_zones {
            outer_n
        } else {
            (if bench { units_used * 2 } else { units_used }).min(outer_n)
        };

        // Cluster aisles accrue on the INNER axis only, capped to what the inner
        // slack absorbs so a bench aisle never costs a whole row (utilization wins;
        // the perimeter/seam corridors carry egress).
        let inner_tight = (inner_n - 1).max(0) as f64 * inner_pitch + inner_size;
        let inner_span = inner_dz1 - (inner_first - inner_half);
        let max_aisles = ((inner_span - inner_tight).max(0.0) / clear).floor().max(0.0) as u32;

        // Two clearance regimes. Same-grid desks are pitched `clear` apart (or
        // SPINE_GAP apart for a bench pair) BY CONSTRUCTION, so their check needs
        // only guard fp noise; meetings/frozen/earlier-pass footprints still need
        // the FULL clearance so a person can pass. Under pairing the same-grid pad
        // shrinks below the spine so the intended 0.15 m gap (or a touching 0.0)
        // is never flagged as a collision.
        let same_grid_pad = if bench { SPINE_GAP * 0.5 - 1e-6 } else { clear * 0.5 };

        // ONE grid pass on the base lattice. (A half-pitch phase-2 infill used
        // to half-offset stragglers into meeting-shadow gaps; it broke row
        // rhythm — the exact "half-desk offset" tell §4.5 bans — and is gone.
        // Cross-region shortfall recovery is the top-up pass in `generate`.)
        let grid_start = obstacles.len();
        'grid: for o in 0..outer_sweep {
            let (outer_c, rot) = outer_at_spread(o);
            for i in 0..inner_n {
                if desks_here >= desk_target {
                    break 'grid;
                }
                let aisle = ((i as u32 / cluster_cols).min(max_aisles)) as f64 * clear;
                let inner_c = inner_first + i as f64 * inner_pitch + aisle;
                let (cx, cy) = if column_major {
                    (outer_c, inner_c)
                } else {
                    (inner_c, outer_c)
                };
                // Snap to the module; the snapped footprint must stay inside
                // the work zone (a cluster aisle can push a slot past the inner
                // edge, and on off-module plates the snap itself may shift a
                // slot 0.025 m outward — drop it rather than break alignment).
                let fx = snap_module(cx);
                let fy = snap_module(cy);
                if fx - hw < dz_x0 - 1e-9
                    || fx + hw > dz_x1 + 1e-9
                    || fy - hh < dz_y0 - 1e-9
                    || fy + hh > dz_y1 + 1e-9
                {
                    if let Some(d) = diag.as_deref_mut() {
                        d.rejects.bounds += 1;
                    }
                    continue;
                }
                // Evaluated SEPARATELY, not as one `&&` chain, so the counter
                // names the cause. "placed 0" has four different fixes in four
                // different files and a single tally cannot tell them apart.
                if !slot_fits_plate(plate, fx, fy, fw, fh, FACADE_GAP) {
                    if let Some(d) = diag.as_deref_mut() {
                        d.rejects.plate += 1;
                    }
                    continue;
                }
                if !slot_clears_walls(iwalls, fx, fy, fw, fh) {
                    if let Some(d) = diag.as_deref_mut() {
                        d.rejects.walls += 1;
                    }
                    continue;
                }
                if footprint_overlaps(&obstacles[..grid_start], fx, fy, fw, fh, clear - 1e-6)
                    || footprint_overlaps(&obstacles[grid_start..], fx, fy, fw, fh, same_grid_pad)
                {
                    if let Some(d) = diag.as_deref_mut() {
                        d.rejects.obstacles += 1;
                    }
                    continue;
                }
                // Local (unrotated) dims + rotation — the renderer, 3D, and the
                // circulation rasterizer all rotate; only the obstacle list is
                // AABB and takes the world extents (fw × fh).
                push_component(doc, "Desk", fx, fy, program.desk_w, program.desk_h, rot);
                obstacles.push((fx, fy, fw, fh));
                desks_here += 1;
            }
        }
    }

    desks_here
}

/// Orientation (radians) of a polygon's LONGEST edge — the principal axis a
/// rotated rectangular/T/L selection reads along. `pack_desks_oriented` aligns
/// its desk grid to this so a tilted band fills lengthwise, exactly as the same
/// band would if it were axis-aligned.
pub(crate) fn principal_axis(poly: &[Point]) -> f64 {
    let mut best_len2 = -1.0;
    let mut theta = 0.0;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let len2 = dx * dx + dy * dy;
        if len2 > best_len2 {
            best_len2 = len2;
            theta = dy.atan2(dx);
        }
    }
    theta
}

/// True when the axis-aligned rectangle (`w`×`h`) rotated by `theta` about
/// `(cx, cy)` sits inside `poly` with at least `margin` clearance to every edge.
/// The rotated-rect variant of [`slot_fits_plate`]: it transforms each polygon
/// edge into the rectangle's own frame (rotate by −θ about the center) and
/// reuses the exact axis-aligned [`geometry::rect_segment_dist`], so no new
/// distance math is introduced. Used only by the degenerate-plate rescue.
pub(crate) fn oriented_slot_in_poly(poly: &[Point], cx: f64, cy: f64, w: f64, h: f64, theta: f64, margin: f64) -> bool {
    if !geometry::point_in_polygon(cx, cy, poly) {
        return false;
    }
    let (s, c) = (-theta).sin_cos(); // rotate WORLD into rect-local by −θ
    let to_local = |p: Point| -> Point {
        let (dx, dy) = (p.x - cx, p.y - cy);
        Point::new(dx * c - dy * s, dx * s + dy * c)
    };
    (0..poly.len()).all(|i| {
        let a = to_local(poly[i]);
        let b = to_local(poly[(i + 1) % poly.len()]);
        geometry::rect_segment_dist(0.0, 0.0, w, h, a, b) >= margin - 1e-6
    })
}

/// Last-resort desk fill for a plate the axis-aligned region packer could not
/// seat a single desk in — always a NARROW / ANGLED band (the region raster
/// found no inscribed axis-aligned rectangle, so the field packer ran over the
/// oversized wall-bbox and every lattice slot fell outside the tilted polygon).
/// Packs desks on a grid rotated to the plate's principal axis, testing each
/// rotated footprint against the polygon (with the facade gap), the interior
/// walls, and the existing obstacle set (rooms / keep-outs). Deterministic and
/// self-non-overlapping (regular pitch ≥ footprint + clearance). Returns the
/// count placed; caller invokes it only when the normal packer placed zero.
pub(crate) fn pack_desks_oriented(
    doc: &mut Document,
    program: &Program,
    poly: &[Point],
    target: u32,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    clear: f64,
) -> u32 {
    let (fw, fh) = (program.desk_w, program.desk_h);
    if fw <= 0.0 || fh <= 0.0 || target == 0 {
        return 0;
    }
    let theta = principal_axis(poly);
    let (s, c) = theta.sin_cos();
    // Polygon bounds in the rotated (u = along axis, v = across) frame.
    let mut umin = f64::INFINITY;
    let mut umax = f64::NEG_INFINITY;
    let mut vmin = f64::INFINITY;
    let mut vmax = f64::NEG_INFINITY;
    for p in poly {
        let u = p.x * c + p.y * s;
        let v = -p.x * s + p.y * c;
        umin = umin.min(u);
        umax = umax.max(u);
        vmin = vmin.min(v);
        vmax = vmax.max(v);
    }
    let (pitch_u, pitch_v) = (fw + clear, fh + clear);
    let (world_w, world_h) = world_extents(fw, fh, theta);
    // Centered lines along one axis: count how many footprints fit inside the
    // MARGIN-inset span (the facade gap the poly test enforces on both edges),
    // then center that run within the full span. Centering is what seats the
    // single row a narrow band holds — a phase anchored at the edge lands every
    // candidate row against a margin and fits none (the field packer's bug).
    let lines = |lo: f64, hi: f64, size: f64, pitch: f64, margin: f64| -> Vec<f64> {
        let usable = (hi - lo) - 2.0 * margin;
        if usable < size - 1e-9 {
            return Vec::new();
        }
        let n = ((usable - size) / pitch).floor() as i64 + 1;
        let run = (n - 1) as f64 * pitch + size;
        let first = lo + margin + (usable - run) / 2.0 + size / 2.0;
        (0..n).map(|k| first + k as f64 * pitch).collect()
    };
    let start = obstacles.len();
    let mut placed = 0u32;
    'rows: for &v in &lines(vmin, vmax, fh, pitch_v, FACADE_GAP) {
        for &u in &lines(umin, umax, fw, pitch_u, FACADE_GAP) {
            if placed >= target {
                break 'rows;
            }
            // Rotated grid center back in world coordinates.
            let cx = u * c - v * s;
            let cy = u * s + v * c;
            if oriented_slot_in_poly(poly, cx, cy, fw, fh, theta, FACADE_GAP)
                && slot_clears_walls(iwalls, cx, cy, world_w, world_h)
                && !footprint_overlaps(&obstacles[..start], cx, cy, world_w, world_h, clear - 1e-6)
            {
                push_component(doc, "Desk", cx, cy, fw, fh, theta);
                obstacles.push((cx, cy, world_w, world_h));
                placed += 1;
            }
        }
    }
    placed
}
