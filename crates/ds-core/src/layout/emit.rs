//! Everything that writes geometry into the `Document`: the component/zone/wall
//! push primitives, and the enclosed-room shell (`emit_room`) with its
//! partitions, glazed front, door opening and interior furniture.

use super::*;

pub(crate) fn push_component(doc: &mut Document, category: &str, x: f64, y: f64, w: f64, h: f64, rotation: f64) {
    let id = doc.alloc_id();
    doc.components.push(Component {
        id,
        category: category.to_string(),
        x,
        y,
        w,
        h,
        rotation,
        mirror: false,
        reference: false, // generated fit-out counts toward every metric
        // Resolved HERE, from world size, so the renderer reads it instead of
        // guessing a chair count from the zoom level (ui-system.md §3.6).
        seats: crate::model::seats_for(category, w, h),
        label: format!("{} {}", category, id),
        product_id: None,
            price_inr: None,
        decision: DecisionState::Open,
    });
}

/// Mirror of `push_component` for zones: mint a shared id and record a tiled
/// floor region. `component_ids` is filled later by `reassign_components`.
///
/// Emits a **`Drawn`** zone — the designed program: rooms, the desk field, the
/// corridor network, keep-outs. Leftover floor goes through
/// [`push_residual_zone`] instead.
pub(crate) fn push_zone(doc: &mut Document, zone_type: ZoneType, shape: ZoneShape, label: &str) {
    push_with_origin(doc, zone_type, shape, label, ZoneOrigin::Drawn)
}

/// Emit a zone the generator could not justify as program: floor left over
/// after the desk field, the rooms and the fill.
///
/// **This is the only function in the codebase that mints `ZoneOrigin::Residual`**,
/// which is what makes the "generator-only" rule greppable rather than a
/// convention. It is a separate function from [`push_zone`] rather than a
/// parameter on it for exactly that reason: a parameter would put `Residual`
/// within reach of all ~30 `push_zone` call sites, and the invariant would
/// depend on none of them passing it.
pub(crate) fn push_residual_zone(
    doc: &mut Document,
    zone_type: ZoneType,
    shape: ZoneShape,
    label: &str,
) {
    push_with_origin(doc, zone_type, shape, label, ZoneOrigin::Residual)
}

fn push_with_origin(
    doc: &mut Document,
    zone_type: ZoneType,
    shape: ZoneShape,
    label: &str,
    origin: ZoneOrigin,
) {
    let id = doc.alloc_id();
    doc.zones.push(Zone {
        id,
        zone_type,
        shape,
        label: label.to_string(),
        component_ids: Vec::new(),
        group: None,
        origin,
    });
}

// ---- Open-workspace bands ------------------------------------------------

/// Emit the open-plan `Workspace` zones as **bands that hug the desk runs**,
/// derived from the desks actually seated — never from the field rectangle the
/// packer was allocated.
///
/// **Why this replaced one rect per region.** `pack_desks` used to push a single
/// `Workspace` rect over `plan.field` before packing anything into it, so the
/// zone was a statement of INTENT, not of what got built. On the user's imported
/// plate that zone measured 433.6 m² around 97 desks: 30% of it — the strip east
/// of the last desk column, the margin above the first row, and the cluster
/// aisles — was floor further than the program's own `desk_clearance_m` from any
/// desk in it. One uniform block covering a third of the plate is the single most
/// diagram-like mark a test-fit can carry, and it also billed circulation as
/// workspace. `tests::zone_geometry::workspace_zones_hug_their_desks` measures
/// the property directly (share of the zone within one clearance of a desk it
/// contains) rather than any area ratio, and it named 36 offending zones across
/// four plates when the defect report named one.
///
/// **A run, geometrically.** Desks are grouped by connected components of their
/// footprints inflated *anisotropically*: half a clearance ALONG the row (so
/// neighbours at the packer's pitch join, and the extra clearance of a cluster
/// aisle does not) and a hair ACROSS it (so a back-to-back bench pair joins,
/// and the next pair-row across its access aisle does not). Nothing here reads
/// the packer's lattice, its bench flag or its cluster width — a run is whatever
/// the placed desks say it is, so the bands stay right when the packer changes.
///
/// Adjacent runs with the SAME extent along the row and only their access aisle
/// between them are merged, so a regular field reads as a few bands rather than
/// one per row. Each band is then grown half a clearance on every side — the
/// desks' own share of the aisle they face — but never across an existing zone,
/// so bands can neither overlap a room nor annex the drawn corridor network.
///
/// What is left over — the desk-free margins, the cluster aisles, the gaps where
/// a slot was rejected — belongs to no band and falls to the residual pass, which
/// names it circulation or unassigned on its own merits.
pub(crate) fn emit_workspace_bands(
    doc: &mut Document,
    clear: f64,
    plate: Option<&[Point]>,
    fields: &[geometry::Rect],
) {
    let eps = 1e-9;
    // Half a clearance is one desk's SHARE of the aisle it faces: two desks a
    // full clearance apart grow until they touch, and the floor between them —
    // where the chairs go — belongs to the pair. Beyond that the aisle is
    // somebody else's, and the band stops.
    let half = (clear / 2.0).max(0.0);

    // Every already-named zone. A cell may not grow into a room, into the drawn
    // corridor network, or into a keep-out; those own their floor, and a band
    // that overlapped one would double-count it in NIA and take its components.
    let others: Vec<(f64, f64, f64, f64)> = doc.zones.iter().map(|z| z.shape.bbox()).collect();

    // One grown cell per seated desk: its world footprint, inflated by half a
    // clearance on each side and clipped back off anything already named.
    //
    // **The cell, not the row, is the primitive** — and that is what makes the
    // property hold by construction rather than by a threshold. Every point of a
    // grown cell is within `half·√2 ≈ 0.64·clear` of the desk that produced it,
    // so no band can contain floor further than one clearance from a desk no
    // matter what shape the field is. Two earlier attempts took the bounding box
    // of a ROW instead, and both leaked: a row's box swallows the step where the
    // next row is shorter, and on a TILTED plate a row runs diagonally, so its
    // box is mostly the two empty triangles beside the desks — measured at 0.88
    // and 0.82 worked share on rotated plates, against a 0.90 floor.
    let cells: Vec<geometry::Rect> = doc
        .components
        .iter()
        .filter(|c| c.category == "Desk" && !c.reference)
        .map(|c| {
            let (w, h) = world_extents(c.w, c.h, c.rotation);
            let r = geometry::Rect {
                x0: c.x - w / 2.0,
                y0: c.y - h / 2.0,
                x1: c.x + w / 2.0,
                y1: c.y + h / 2.0,
            };
            let (mut x0, mut y0, mut x1, mut y1) =
                (r.x0 - half, r.y0 - half, r.x1 + half, r.y1 + half);
            for &(ox0, oy0, ox1, oy1) in &others {
                if oy0 < r.y1 - eps && oy1 > r.y0 + eps {
                    if ox1 <= r.x0 + eps {
                        x0 = x0.max(ox1);
                    }
                    if ox0 >= r.x1 - eps {
                        x1 = x1.min(ox0);
                    }
                }
                if ox0 < r.x1 - eps && ox1 > r.x0 + eps {
                    if oy1 <= r.y0 + eps {
                        y0 = y0.max(oy1);
                    }
                    if oy0 >= r.y1 - eps {
                        y1 = y1.min(oy0);
                    }
                }
            }
            geometry::Rect {
                x0: x0.min(r.x0),
                y0: y0.min(r.y0),
                x1: x1.max(r.x1),
                y1: y1.max(r.y1),
            }
        })
        .collect();
    if cells.is_empty() {
        return;
    }

    // Bands = the maximal rectangles tiling the UNION of those cells. A regular
    // field's twelve stacked rows come back as one band; a ragged or diagonal one
    // comes back as the few steps it actually has. The tiling covers the union
    // and nothing else, so bands can neither invent empty floor nor overlap each
    // other — both by construction, not by a guard.
    let bands = tile_union(&cells);

    let many = bands.len() > 1;
    for (i, b) in bands.iter().enumerate() {
        let label = if many {
            format!("Open Workspace ({})", i + 1)
        } else {
            "Open Workspace".to_string()
        };
        push_zone(
            doc,
            ZoneType::Workspace,
            ZoneShape::Rect {
                x: (b.x0 + b.x1) / 2.0,
                y: (b.y0 + b.y1) / 2.0,
                w: b.x1 - b.x0,
                h: b.y1 - b.y0,
            },
            &label,
        );
    }
    emit_bank_aisles(doc, &bands, clear, plate, fields);
}

/// The maximal axis-aligned rectangles that tile the UNION of `rects`, exactly.
///
/// Subdivide the plane on every input edge, mark each cell that lies inside any
/// input, then merge cells by run-length along x and stack identical runs along
/// y. The result covers the union and nothing else — no invented floor, no
/// overlaps — and is deterministic (row-major discovery, ascending emit).
fn tile_union(rects: &[geometry::Rect]) -> Vec<geometry::Rect> {
    if rects.len() < 2 {
        return rects.to_vec();
    }
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    for r in rects {
        xs.push(r.x0);
        xs.push(r.x1);
        ys.push(r.y0);
        ys.push(r.y1);
    }
    let dedup = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    };
    dedup(&mut xs);
    dedup(&mut ys);
    let (nc, nr) = (xs.len() - 1, ys.len() - 1);
    let mut inside = vec![false; nc * nr];
    // Row-banded: the subdivision has 2N columns and 2N rows for N inputs, so a
    // naive cell × rect scan is O(N³) and this runs once per `generate` on a
    // hundred-desk plate. Narrowing to the rects that span the row first keeps it
    // to the handful that can possibly contain the cell.
    let mut row_rects: Vec<usize> = Vec::new();
    for r in 0..nr {
        let cy = (ys[r] + ys[r + 1]) / 2.0;
        row_rects.clear();
        row_rects.extend((0..rects.len()).filter(|&k| cy > rects[k].y0 && cy < rects[k].y1));
        if row_rects.is_empty() {
            continue;
        }
        for c in 0..nc {
            let cx = (xs[c] + xs[c + 1]) / 2.0;
            inside[r * nc + c] =
                row_rects.iter().any(|&k| cx > rects[k].x0 && cx < rects[k].x1);
        }
    }
    let mut used = vec![false; nc * nr];
    let mut out: Vec<geometry::Rect> = Vec::new();
    for r in 0..nr {
        for c in 0..nc {
            if !inside[r * nc + c] || used[r * nc + c] {
                continue;
            }
            let mut c1 = c;
            while c1 + 1 < nc && inside[r * nc + c1 + 1] && !used[r * nc + c1 + 1] {
                c1 += 1;
            }
            let mut r1 = r;
            'grow: while r1 + 1 < nr {
                for cc in c..=c1 {
                    if !inside[(r1 + 1) * nc + cc] || used[(r1 + 1) * nc + cc] {
                        break 'grow;
                    }
                }
                r1 += 1;
            }
            for rr in r..=r1 {
                for cc in c..=c1 {
                    used[rr * nc + cc] = true;
                }
            }
            out.push(geometry::Rect { x0: xs[c], y0: ys[r], x1: xs[c1 + 1], y1: ys[r1 + 1] });
        }
    }
    out
}

/// The floor BETWEEN the desk banks, named as the aisle it is.
///
/// Bands hug their desks, so what a bank's envelope holds and its bands do not
/// is the cluster aisle, the step where one row is shorter than the next, and the
/// pocket a rejected slot left. That floor is open-plan circulation — a person
/// walks it to reach a desk — and it is emitted here as **drawn** `Circulation`
/// by exact rectangle subtraction.
///
/// **Why not leave it to the residual pass.** Because the residual pass reaches
/// it through a 0.25 m raster whose cells must clear every zone corner, so each
/// pocket comes back a raster cell short on every side and the shortfall stays
/// untyped: routing the between-bank floor that way put 13.0% of the reference
/// plate into hairline seams and shattered the walking area into two dozen
/// hatched `Unassigned` fragments — floor the plan then bills as waste and the
/// score penalises, for the sole reason that a raster could not touch a rectangle.
/// Subtracting rectangles from rectangles has no such error: the aisles abut the
/// bands exactly. The rest of the plate is untouched and still goes to the
/// residual pass, which is the right instrument for floor with no owner nearby.
fn emit_bank_aisles(
    doc: &mut Document,
    bands: &[geometry::Rect],
    clear: f64,
    plate: Option<&[Point]>,
    fields: &[geometry::Rect],
) {
    let eps = 1e-9;
    // Banks: bands within one access aisle of each other belong to the same
    // envelope, so a bank's own gaps are aisles and the open floor beyond the
    // last bank is somebody else's problem (the residual pass names it).
    let mut group: Vec<usize> = (0..bands.len()).collect();
    fn root(g: &mut Vec<usize>, i: usize) -> usize {
        let mut i = i;
        while g[i] != i {
            g[i] = g[g[i]];
            i = g[i];
        }
        i
    }
    for i in 0..bands.len() {
        for j in (i + 1)..bands.len() {
            let (a, b) = (bands[i], bands[j]);
            let gx = (b.x0 - a.x1).max(a.x0 - b.x1);
            let gy = (b.y0 - a.y1).max(a.y0 - b.y1);
            if gx <= 2.0 * clear + eps && gy <= 2.0 * clear + eps {
                let (ra, rb) = (root(&mut group, i), root(&mut group, j));
                if ra != rb {
                    group[ra] = rb;
                }
            }
        }
    }
    let mut banks: Vec<(geometry::Rect, Vec<usize>)> = Vec::new();
    let mut slot: Vec<Option<usize>> = vec![None; bands.len()];
    // A band that sits in a region's DESK FIELD takes the whole field as its
    // envelope, so the field is tiled exactly into bands + aisles. That field
    // rect is what used to BE the Workspace zone; naming its desk-free part as
    // the aisle it is, by rectangle subtraction, is both the honest reading and
    // the one with no rasterisation error — routing it through the residual pass
    // instead left a raster cell of untyped seam around every edge.
    // A band that sits in a region's DESK FIELD takes the whole field as its
    // envelope, so the field is tiled exactly into bands + aisles. That field
    // rect is what used to BE the Workspace zone; naming its desk-free part as
    // the aisle it is, by rectangle subtraction, is both the honest reading and
    // the one with no rasterisation error — routing it through the residual pass
    // instead left a raster cell of untyped seam around every edge, and on the
    // reference plate's harder seeds that came to 10–11% of the floor.
    let field_of = |b: &geometry::Rect| -> Option<usize> {
        let (cx, cy) = ((b.x0 + b.x1) / 2.0, (b.y0 + b.y1) / 2.0);
        fields.iter().position(|f| cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1)
    };
    let mut by_field: Vec<(usize, Vec<usize>)> = Vec::new();
    for i in 0..bands.len() {
        if let Some(fi) = field_of(&bands[i]) {
            match by_field.iter_mut().find(|(f, _)| *f == fi) {
                Some((_, v)) => v.push(i),
                None => by_field.push((fi, vec![i])),
            }
            continue;
        }
        // No field owns it (the whole-plate fill, a pocket row): fall back to
        // grouping by proximity, so its own gaps still read as aisle.
        let r = root(&mut group, i);
        match slot[r] {
            Some(k) => {
                let e = &mut banks[k].0;
                e.x0 = e.x0.min(bands[i].x0);
                e.y0 = e.y0.min(bands[i].y0);
                e.x1 = e.x1.max(bands[i].x1);
                e.y1 = e.y1.max(bands[i].y1);
                banks[k].1.push(i);
            }
            None => {
                slot[r] = Some(banks.len());
                banks.push((bands[i], vec![i]));
            }
        }
    }

    for (fi, members) in by_field {
        let f = fields[fi];
        let mut env = f;
        for &m in &members {
            env.x0 = env.x0.min(bands[m].x0);
            env.y0 = env.y0.min(bands[m].y0);
            env.x1 = env.x1.max(bands[m].x1);
            env.y1 = env.y1.max(bands[m].y1);
        }
        banks.push((env, members));
    }

    // Existing zones the envelope may overlap (a room sitting in the bank's
    // shadow): their floor is already named, so it is never re-emitted. Their
    // EDGES join the subdivision grid below, so no emitted cell can straddle
    // one — which is what makes the aisles strictly disjoint from every zone,
    // and therefore keeps NIA ≤ GEA and leaves each desk in its own band rather
    // than in a smaller aisle that overlapped it.
    // Keep-outs join the list even though their `Core` zones are pushed later:
    // an envelope taken from a region field CAN span a shaft, and an aisle over
    // one would double-count the floor the Core zone claims at the end of
    // `generate` (NIA > GEA) and draw a corridor through a lift lobby.
    let mut taken: Vec<(f64, f64, f64, f64)> = doc.zones.iter().map(|z| z.shape.bbox()).collect();
    for k in &doc.keepouts {
        taken.push((k.x - k.w / 2.0, k.y - k.h / 2.0, k.x + k.w / 2.0, k.y + k.h / 2.0));
    }
    let mut out: Vec<geometry::Rect> = Vec::new();
    for (env, members) in &banks {
        if members.len() < 2
            && (env.x1 - env.x0) * (env.y1 - env.y0) <= bands[members[0]].area() + 1e-9
        {
            continue; // a lone band filling its own envelope has no aisle
        }
        // Everything this envelope may not claim: named zones, keep-outs, this
        // bank's own bands, and the aisles ALREADY emitted for earlier banks —
        // two region fields can overlap, and without the last of those two
        // envelopes tile the same floor twice (NIA > GEA).
        let mut blockers: Vec<geometry::Rect> = Vec::new();
        for &(a0, b0, a1, b1) in &taken {
            blockers.push(geometry::Rect { x0: a0, y0: b0, x1: a1, y1: b1 });
        }
        let zone_blockers = taken.len();
        for &m in members {
            blockers.push(bands[m]);
        }
        for r in &out {
            blockers.push(*r);
        }
        let mut xs = vec![env.x0, env.x1];
        let mut ys = vec![env.y0, env.y1];
        for b in &blockers {
            for v in [b.x0, b.x1] {
                if v > env.x0 + eps && v < env.x1 - eps {
                    xs.push(v);
                }
            }
            for v in [b.y0, b.y1] {
                if v > env.y0 + eps && v < env.y1 - eps {
                    ys.push(v);
                }
            }
        }
        let dedup = |v: &mut Vec<f64>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            v.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        };
        dedup(&mut xs);
        dedup(&mut ys);
        let (nc, nr) = (xs.len() - 1, ys.len() - 1);
        let mut free = vec![false; nc * nr];
        for r in 0..nr {
            for c in 0..nc {
                let (cx, cy) = ((xs[c] + xs[c + 1]) / 2.0, (ys[r] + ys[r + 1]) / 2.0);
                let taken_here = blockers.iter().enumerate().any(|(k, b)| {
                    cx > b.x0
                        && cx < b.x1
                        && cy > b.y0
                        && cy < b.y1
                        // A zone's own shape decides; everything else is a rect.
                        && (k >= zone_blockers
                            || k >= doc.zones.len()
                            || doc.zones[k].shape.contains(cx, cy))
                });
                // Wholly inside the plate: an aisle rect may not poke through a
                // wall, and `area_on` clipping would hide that from NIA while the
                // canvas drew it anyway.
                //
                // Measured as "the plate clipped to this cell has the cell's full
                // area", not as "all four corners are inside". The corner test was
                // written first and `zone_geometry::every_zone_lies_inside_the_plate`
                // caught it on the reference plate: the plate is NON-CONVEX, so a
                // notch can bite 4.19 m² out of a cell whose every corner is
                // interior. The clip is exact — the clipping window is the cell,
                // which is convex — and costs the same.
                let cell_area = (xs[c + 1] - xs[c]) * (ys[r + 1] - ys[r]);
                let in_plate = plate.is_none_or(|poly| {
                    geometry::rect_polygon_clip_area(poly, xs[c], ys[r], xs[c + 1], ys[r + 1])
                        >= cell_area - 1e-9
                });
                free[r * nc + c] = !taken_here && in_plate;
            }
        }
        // Merge free cells into maximal rectangles: run-length along x, then
        // stack identical runs along y. Deterministic, and exact — the emitted
        // rects abut the bands on their shared edges with no gap at all.
        let mut used = vec![false; nc * nr];
        for r in 0..nr {
            for c in 0..nc {
                if !free[r * nc + c] || used[r * nc + c] {
                    continue;
                }
                let mut c1 = c;
                while c1 + 1 < nc && free[r * nc + c1 + 1] && !used[r * nc + c1 + 1] {
                    c1 += 1;
                }
                let mut r1 = r;
                'grow: while r1 + 1 < nr {
                    for cc in c..=c1 {
                        if !free[(r1 + 1) * nc + cc] || used[(r1 + 1) * nc + cc] {
                            break 'grow;
                        }
                    }
                    r1 += 1;
                }
                for rr in r..=r1 {
                    for cc in c..=c1 {
                        used[rr * nc + cc] = true;
                    }
                }
                out.push(geometry::Rect { x0: xs[c], y0: ys[r], x1: xs[c1 + 1], y1: ys[r1 + 1] });
            }
        }
    }
    for r in out {
        // Sub-visible slivers stay unnamed rather than becoming zone noise — the
        // same `MIN_AREA` floor the merge pass applies to a leftover pocket.
        if r.width() < 0.3 || r.height() < 0.3 || r.width() * r.height() < 0.5 {
            continue;
        }
        push_zone(
            doc,
            ZoneType::Circulation,
            ZoneShape::Rect {
                x: (r.x0 + r.x1) / 2.0,
                y: (r.y0 + r.y1) / 2.0,
                w: r.width(),
                h: r.height(),
            },
            "Aisle",
        );
    }
}

// ---- Enclosed-room emission (M1 of docs/design/testfit-pro-quality.md) ----

/// Generated-partition thickness (m): 100 mm double-boarded drywall — the
/// standard office fit-out partition.
pub(crate) const PARTITION_T: f64 = 0.1;
/// Glazed-front thickness (m): framed office glazing renders thinner than
/// drywall (spec §2 "Glass fronts").
pub(crate) const GLAZING_T: f64 = 0.05;
/// Door leaf width (m): standard office single leaf 900×2100.
pub const DOOR_W: f64 = 0.9;
/// Door slab depth (m): the component footprint across the wall.
pub const DOOR_D: f64 = 0.15;
/// Hinge-side jamb offset (m) from the perpendicular wall, so the leaf opens
/// flat against it (spec §2 door convention).
pub(crate) const DOOR_JAMB: f64 = 0.15;
/// Clear ring (m) kept between a room's table and its walls' inner faces.
/// ≥ the 0.9 m accessible route so the circulation evaluator's in-room
/// chokepoints never undercut the corridor target (0.95 leaves raster
/// headroom over the evaluator's 0.15 m cells).
pub(crate) const TABLE_CLEAR: f64 = 0.95;

/// Which side of a generated room faces the corridor its door opens onto —
/// the side that gets the glass front and the door opening. Landscape wings
/// stack rooms against the work rect's RIGHT edge (perimeter/seam corridor to
/// their right); portrait wings band rooms along its BOTTOM edge.
#[derive(Clone, Copy)]
pub(crate) enum CorridorSide {
    Right,
    Bottom,
    /// Mirrors of Right/Bottom for M2's `band_far` seed choice, which moves
    /// the meeting band to the opposite region end — the glass front + door
    /// must still face the corridor/desk-field side.
    Left,
    Top,
}

/// Interior furnishing of a generated room — all from EXISTING renderer
/// categories (Table/Chair), so the 2D glyphs and 3D builds need no additions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum RoomFurniture {
    /// Full-size conference table with the TABLE_CLEAR egress ring (meetings).
    ConferenceTable,
    /// Work table against the rear wall + task chair facing the door
    /// (cabin / focus / phone booth — the booth degrades to chair + ledge).
    WorkPoint,
    /// Counter run along the rear wall (pantry).
    Counter,
    /// Centered desk-height table facing the door + chair behind (reception).
    ReceptionDesk,
    /// Unfurnished (IT/server, storage, wellness).
    Empty,
}

/// What `emit_room` builds around a placed room rect. M1 emitted meeting rooms
/// only; M3's cabins/booths/focus/pantry/reception/IT/storage/wellness reuse it
/// with per-type flags.
pub(crate) struct RoomSpec {
    pub(crate) zone_type: ZoneType,
    pub(crate) label: String,
    /// Corridor-facing wall is glazed (solid for booths/IT/storage — spec §2).
    pub(crate) glass_front: bool,
    /// Door leaf width (m); 1.0 for NBC-exit rooms (pantry).
    pub(crate) door_w: f64,
    pub(crate) furniture: RoomFurniture,
    /// Briefed occupancy from `RoomReq::seats` (0 = derive from the table).
    pub(crate) seats: u32,
}

/// Append one generated wall segment (partition or glass front).
pub(crate) fn push_gen_wall(doc: &mut Document, ax: f64, ay: f64, bx: f64, by: f64, thickness: f64, glazing: bool) {
    if ((bx - ax).abs() + (by - ay).abs()) < 1e-6 {
        return; // zero-length stub (door gap touched the corner)
    }
    let id = doc.alloc_id();
    doc.walls.push(Wall {
        id,
        a: Point::new(ax, ay),
        b: Point::new(bx, by),
        thickness,
        generated: true,
        glazing,
        // Generated partitions are always full storey height — the generator has
        // no partial-height primitive (see `quantity::WallType::HalfDrywall`).
        height_m: None,
    });
}

/// Emit one ENCLOSED room on the rect centered `(cx, cy)`, size `w`×`h`:
/// 0.1 m generated partitions on three sides, a glazed corridor-facing front
/// broken by a `door_w` opening (two collinear segments), a `Door` component
/// in the gap (rotated so the leaf swings INTO the room, hinge on the jamb
/// nearest the corner), a typed zone, and a full-size table with a ≥0.9 m
/// chair/egress ring.
///
/// Self-blocking is impossible by construction: wall centerlines are inset
/// half a thickness so the partitions' OUTER faces sit exactly on the room
/// rect — the same rect the caller pushes into `obstacles` with a full
/// clearance pad, which every later placement (rooms, desks, top-up passes)
/// already avoids. The packer's wall-obstacle list (`interior_walls`) is
/// snapshotted BEFORE any emission and generated walls are cleared at the top
/// of `generate()`, so a room's own shell can never reject its own interior
/// furniture, and later placements respect earlier rooms via the rect
/// obstacle (a strict superset of the walls + their clearance).
pub(crate) fn emit_room(doc: &mut Document, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide, spec: &RoomSpec) {
    let t2 = PARTITION_T / 2.0;
    // Wall centerline rectangle (inset so outer faces land on the room rect).
    let x0 = cx - w / 2.0 + t2;
    let x1 = cx + w / 2.0 - t2;
    let y0 = cy - h / 2.0 + t2;
    let y1 = cy + h / 2.0 - t2;

    // The corridor-facing run carries the door gap: hinge-side jamb DOOR_JAMB
    // from the far corner; fall back to a centered gap in short runs, and to a
    // solid front when even that can't fit (degenerate, sub-1.2 m rooms).
    let front_t = if spec.glass_front { GLAZING_T } else { PARTITION_T };
    let gap = |lo: f64, hi: f64| -> Option<(f64, f64)> {
        let run = hi - lo;
        if run < spec.door_w + 0.1 {
            return None;
        }
        let g_hi = if run >= spec.door_w + 2.0 * DOOR_JAMB {
            hi - DOOR_JAMB
        } else {
            (lo + hi) / 2.0 + spec.door_w / 2.0
        };
        Some((g_hi - spec.door_w, g_hi))
    };
    match side {
        CorridorSide::Right => {
            // Solid partitions: left, top, bottom.
            push_gen_wall(doc, x0, y0, x0, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y1, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y0, x1, y0, PARTITION_T, false);
            // Corridor-facing front at x1 (vertical run), gap near the TOP corner.
            match gap(y0, y1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x1, y0, x1, g_lo, front_t, spec.glass_front);
                    push_gen_wall(doc, x1, g_hi, x1, y1, front_t, spec.glass_front);
                    // rotation −π/2 puts the hinge on the g_hi jamb (nearest the
                    // corner) and swings the leaf into the room (−x).
                    push_component(
                        doc, "Door", x1, (g_lo + g_hi) / 2.0, spec.door_w, DOOR_D,
                        -std::f64::consts::FRAC_PI_2,
                    );
                }
                None => push_gen_wall(doc, x1, y0, x1, y1, front_t, spec.glass_front),
            }
        }
        CorridorSide::Bottom => {
            // Solid partitions: left, right, top.
            push_gen_wall(doc, x0, y0, x0, y1, PARTITION_T, false);
            push_gen_wall(doc, x1, y0, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y1, x1, y1, PARTITION_T, false);
            // Corridor-facing front at y0 (horizontal run), gap near the RIGHT corner.
            match gap(x0, x1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x0, y0, g_lo, y0, front_t, spec.glass_front);
                    push_gen_wall(doc, g_hi, y0, x1, y0, front_t, spec.glass_front);
                    // rotation π: hinge on the g_hi jamb, leaf swings into the room (+y).
                    push_component(
                        doc, "Door", (g_lo + g_hi) / 2.0, y0, spec.door_w, DOOR_D,
                        std::f64::consts::PI,
                    );
                }
                None => push_gen_wall(doc, x0, y0, x1, y0, front_t, spec.glass_front),
            }
        }
        CorridorSide::Left => {
            // Mirror of Right: solid right, top, bottom; front at x0.
            push_gen_wall(doc, x1, y0, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y1, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y0, x1, y0, PARTITION_T, false);
            match gap(y0, y1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x0, y0, x0, g_lo, front_t, spec.glass_front);
                    push_gen_wall(doc, x0, g_hi, x0, y1, front_t, spec.glass_front);
                    // rotation +π/2: hinge on the g_hi jamb, leaf swings into the room (+x).
                    push_component(
                        doc, "Door", x0, (g_lo + g_hi) / 2.0, spec.door_w, DOOR_D,
                        std::f64::consts::FRAC_PI_2,
                    );
                }
                None => push_gen_wall(doc, x0, y0, x0, y1, front_t, spec.glass_front),
            }
        }
        CorridorSide::Top => {
            // Mirror of Bottom: solid left, right, bottom; front at y1.
            push_gen_wall(doc, x0, y0, x0, y1, PARTITION_T, false);
            push_gen_wall(doc, x1, y0, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y0, x1, y0, PARTITION_T, false);
            match gap(x0, x1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x0, y1, g_lo, y1, front_t, spec.glass_front);
                    push_gen_wall(doc, g_hi, y1, x1, y1, front_t, spec.glass_front);
                    // rotation 0: hinge on the g_hi jamb, leaf swings into the room (−y).
                    push_component(
                        doc, "Door", (g_lo + g_hi) / 2.0, y1, spec.door_w, DOOR_D, 0.0,
                    );
                }
                None => push_gen_wall(doc, x0, y1, x1, y1, front_t, spec.glass_front),
            }
        }
    }

    // The room's zone (pastel fill + stats bucket) spans the FULL room rect.
    push_zone(
        doc,
        spec.zone_type,
        ZoneShape::Rect { x: cx, y: cy, w, h },
        &spec.label,
    );

    furnish_room(doc, cx, cy, w, h, side, spec.furniture, spec.seats);
}

/// Place a room's interior furniture (existing Table/Chair categories only).
/// `side` is the door/front side; furniture faces it, rear pieces back onto
/// the opposite wall. Everything snaps to the module.
pub(crate) fn furnish_room(doc: &mut Document, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide, furniture: RoomFurniture, briefed_seats: u32) {
    // Outward front normal, and the rotation mapping local +y (the side a
    // seated user faces) onto it: R(θ)·(0,1) = (−sinθ, cosθ) = f.
    let (fx, fy) = match side {
        CorridorSide::Right => (1.0, 0.0),
        CorridorSide::Left => (-1.0, 0.0),
        CorridorSide::Top => (0.0, 1.0),
        CorridorSide::Bottom => (0.0, -1.0),
    };
    let rot = f64::atan2(-fx, fy);
    // Room extent along the front normal (depth) and across it (front run).
    let (depth, run) = if fx != 0.0 { (w, h) } else { (h, w) };
    let inner_run = run - 2.0 * PARTITION_T - 0.2;
    let inner_depth = depth - 2.0 * PARTITION_T - 0.2;
    // A point `t` meters behind the room center along the inward normal.
    let at = |t: f64| (snap_module(cx - fx * t), snap_module(cy - fy * t));

    match furniture {
        RoomFurniture::ConferenceTable => {
            // Full-size conference table (chairs live in its 2D glyph / 3D
            // build), centered with the TABLE_CLEAR ring to the inner faces.
            let tw = (w - 2.0 * PARTITION_T - 2.0 * TABLE_CLEAR).max(0.8).min(w - 2.0 * PARTITION_T - 0.2);
            let th = (h - 2.0 * PARTITION_T - 2.0 * TABLE_CLEAR).max(0.8).min(h - 2.0 * PARTITION_T - 0.2);
            if tw > 0.3 && th > 0.3 {
                push_component(doc, "Table", cx, cy, tw, th, 0.0);
                // REAL chair components, seated all round. Seats stay inside the
                // partitions' INNER faces (the walls are centerline-inset by half
                // their thickness, so the inner face sits PARTITION_T in from the
                // room rect). These are billable objects, which is the point: the
                // plan, the thumbnails and the Furniture Inventory all count the
                // same chairs.
                seat_around_table(
                    doc, cx, cy, tw, th,
                    (
                        cx - w / 2.0 + PARTITION_T,
                        cy - h / 2.0 + PARTITION_T,
                        cx + w / 2.0 - PARTITION_T,
                        cy + h / 2.0 - PARTITION_T,
                    ),
                );
                // THE BRIEF WINS. The table is sized to the ROOM, so its
                // perimeter can seat more than the room was asked for — a
                // "6 person" team room fitted a table seating 8, and that 8 then
                // flowed to the plan tag, the report's meeting seats and the
                // density. Clamp the object's occupancy to what was briefed
                // (never above what physically fits) so the drawing, the tag and
                // the brief are the same number.
                // `last_mut()` no longer finds the table — seat_around_table has
                // pushed chairs after it — so clamp the last TABLE explicitly.
                if briefed_seats > 0 {
                    if let Some(t) = doc.components.iter_mut().rev().find(|c| c.category == "Table") {
                        t.seats = t.seats.min(briefed_seats);
                    }
                }
            }
        }
        RoomFurniture::WorkPoint => {
            if inner_depth >= 1.5 {
                // Work table backed onto the rear wall, chair in front of it.
                let tw = snap_module(inner_run.min(1.2).max(0.4));
                let td = 0.6;
                let (tx, ty) = at(depth / 2.0 - PARTITION_T - 0.1 - td / 2.0);
                push_component(doc, "Table", tx, ty, tw, td, rot);
                let (chx, chy) = at(depth / 2.0 - PARTITION_T - 0.1 - td - 0.35);
                // The chair faces the table (rearward), back to the door.
                push_component(doc, "Chair", chx, chy, 0.5, 0.5, rot + std::f64::consts::PI);
            } else if inner_run > 0.5 && inner_depth > 0.5 {
                // Phone-booth scale: seat + a shallow ledge when it fits.
                if inner_depth >= 0.85 {
                    let (tx, ty) = at(depth / 2.0 - PARTITION_T - 0.05 - 0.15);
                    push_component(doc, "Table", tx, ty, inner_run.min(0.6), 0.3, rot);
                }
                let (chx, chy) = at(-(depth / 2.0 - PARTITION_T - 0.05 - 0.3));
                // Seat faces the ledge (rearward).
                push_component(doc, "Chair", chx, chy, 0.5, 0.5, rot + std::f64::consts::PI);
            }
        }
        RoomFurniture::Counter => {
            if inner_run > 1.0 && inner_depth > 1.2 {
                let tw = snap_module(inner_run - 0.6);
                let td = 0.55;
                let (tx, ty) = at(depth / 2.0 - PARTITION_T - 0.05 - td / 2.0);
                push_component(doc, "Table", tx, ty, tw, td, rot);
            }
        }
        RoomFurniture::ReceptionDesk => {
            if inner_run > 2.0 && inner_depth > 2.0 {
                let (tx, ty) = at(0.0);
                push_component(doc, "Table", tx, ty, 1.8_f64.min(inner_run - 0.6), 0.7, rot);
                let (chx, chy) = at(0.75);
                push_component(doc, "Chair", chx, chy, 0.5, 0.5, rot);
            }
        }
        RoomFurniture::Empty => {}
    }
}

pub(crate) const CHAIR_SIZE: f64 = 0.5;
pub(crate) const CHAIR_PROJECT: f64 = 0.35;
/// Walkable gap (m) preserved between two chair backs sharing an aisle.
pub(crate) const CHAIR_AISLE_KEEP: f64 = 0.2;
pub(crate) const CHAIR_PROJECT_MIN: f64 = 0.05;
pub(crate) const SEAT_PITCH: f64 = 0.75;

/// Seat task chairs around a conference / meeting / collaboration table.
///
/// `floor(long_side / SEAT_PITCH)` seats along **each** long side, plus **one**
/// head seat at each end — office practice takes a single person at a table end
/// however wide it is. Every chair faces the table and tucks
/// `CHAIR_SIZE − CHAIR_PROJECT` under its edge, projecting `CHAIR_PROJECT` into
/// the room: the identical tuck `seat_desk_chairs` gives a workstation, so all
/// seating in the document reads as one object at one size.
///
/// `clear` is the `(x0, y0, x1, y1)` rect the seats must stay inside — a walled
/// room's INNER wall faces, or an open setting's zone rect. A seat that does not
/// fit, or that would collide with a seat already placed at this table, is
/// **dropped rather than forced**, so a table clamped against architecture
/// simply carries fewer chairs and never one inside a wall.
///
/// These are REAL `Chair` components, which is the whole point: the 2D plan
/// glyphs draw no implied seating (`web/src/editor/furniture.ts`), so what the
/// plan and the room thumbnails draw is exactly what the Furniture Inventory
/// bills and what `quantity::headcount` counts for a room with no desks.
/// Like every other chair they are exempt from the circulation raster
/// (`circulation::is_loose_seating`).
pub(crate) fn seat_around_table(
    doc: &mut Document,
    tx: f64,
    ty: f64,
    tw: f64,
    th: f64,
    clear: (f64, f64, f64, f64),
) {
    use std::f64::consts::{FRAC_PI_2, PI};
    let half = CHAIR_SIZE / 2.0;
    // Chair centre offset BEYOND the table edge: the seat overlaps the worktop
    // and projects CHAIR_PROJECT past it.
    let off = (CHAIR_PROJECT - half).max(0.0);
    let (x0, y0, x1, y1) = clear;

    let long_x = tw >= th;
    let (run, span) = if long_x { (tw, th) } else { (th, tw) };
    let n = ((run / SEAT_PITCH).floor() as usize).max(1);

    // Long sides first (they are the real capacity), heads last, so a head seat
    // is the one dropped when a stubby table's corners would collide.
    let side_d = snap_module(span / 2.0 + off);
    let head_d = snap_module(run / 2.0 + off);
    let mut seats: Vec<(f64, f64, f64)> = Vec::with_capacity(2 * n + 2);
    for i in 0..n {
        let t = snap_module(((i as f64 + 0.5) / n as f64 - 0.5) * run);
        if long_x {
            // Chair faces the table: rot maps its local +y onto the facing
            // direction (`rot = atan2(-fx, fy)`), matching `furnish_room`.
            seats.push((tx + t, ty - side_d, 0.0));
            seats.push((tx + t, ty + side_d, PI));
        } else {
            seats.push((tx - side_d, ty + t, -FRAC_PI_2));
            seats.push((tx + side_d, ty + t, FRAC_PI_2));
        }
    }
    if long_x {
        seats.push((tx - head_d, ty, -FRAC_PI_2));
        seats.push((tx + head_d, ty, FRAC_PI_2));
    } else {
        seats.push((tx, ty - head_d, 0.0));
        seats.push((tx, ty + head_d, PI));
    }

    let mut placed: Vec<(f64, f64, f64, f64)> = Vec::with_capacity(seats.len());
    for (cx, cy, rot) in seats {
        let inside = cx - half >= x0 - 1e-6
            && cx + half <= x1 + 1e-6
            && cy - half >= y0 - 1e-6
            && cy + half <= y1 + 1e-6;
        if !inside || footprint_overlaps(&placed, cx, cy, CHAIR_SIZE, CHAIR_SIZE, -1e-6) {
            continue;
        }
        placed.push((cx, cy, CHAIR_SIZE, CHAIR_SIZE));
        push_component(doc, "Chair", cx, cy, CHAIR_SIZE, CHAIR_SIZE, rot);
    }
}

/// Seat ONE task chair at every generated `Desk` — the workstation's other half.
///
/// Runs as a POST-PASS over the finished layout rather than inside the packer:
/// desk placement stays byte-identical (desk counts, determinism and every
/// `LayoutScore` term are unaffected), and the seating rule lives in one place
/// regardless of which packer — axis-aligned `pack_desks` or `pack_desks_oriented`
/// — placed the desk.
///
/// **Which side.** A desk's user sits on its local **+y** side: the monitor is on
/// the −y back edge and `web/src/editor/furniture.ts::drawDesk` states "the user
/// sits toward +y". Bench pairs butt their two desks together with
/// `SPINE_GAP == 0`, so for a paired desk that side is solid desk and the seat
/// falls back to −y — the outer aisle, and the only place a person can physically
/// sit in a back-to-back run. Trying +y then −y therefore seats BOTH the paired
/// and the single-row regimes correctly without this pass knowing which one ran.
///
/// **Tuck.** The chair overlaps its own desk and projects `CHAIR_PROJECT` into the
/// aisle, capped so two chairs sharing one `clear` aisle keep `CHAIR_AISLE_KEEP`
/// of walkable floor between their backs. Candidates are rejected if they leave
/// the plate, foul an interior wall, or touch ANY component other than their own
/// desk, so a desk pinned against architecture keeps a fully-tucked seat and a
/// desk with no room at all gets none — never an overlapping one.
///
/// Chairs are deliberately NOT added to the packer's obstacle list and are NOT
/// blocking in the circulation raster (see `circulation::rasterize_components`):
/// a task chair is loose furniture that tucks away, not fixed construction, so it
/// cannot narrow a code-measured clear width.
pub(crate) fn seat_desk_chairs(
    doc: &mut Document,
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    clear: f64,
) {
    // Two chair backs share one aisle in a bench run, so each may claim at most
    // half of it less the walkable keep.
    let project = CHAIR_PROJECT
        .min(((clear - CHAIR_AISLE_KEEP) / 2.0).max(CHAIR_PROJECT_MIN))
        .max(CHAIR_PROJECT_MIN);
    let half_chair = CHAIR_SIZE / 2.0;

    // Every existing component as a world AABB, so a candidate seat can be tested
    // against all of them at once. Rebuilt per desk only in the sense that the
    // desk's own entry is skipped by index.
    let boxes: Vec<(f64, f64, f64, f64)> = doc
        .components
        .iter()
        .map(|c| {
            let (ww, wh) = world_extents(c.w, c.h, c.rotation);
            (c.x, c.y, ww, wh)
        })
        .collect();

    let desks: Vec<usize> = (0..doc.components.len())
        .filter(|&i| doc.components[i].category == "Desk" && !doc.components[i].reference)
        .collect();

    // Seats decided first, pushed after — `push_component` borrows `doc` mutably.
    let mut seats: Vec<(f64, f64, f64)> = Vec::new();
    // Chair AABBs already committed in this pass, so two seats can never collide.
    let mut placed: Vec<(f64, f64, f64, f64)> = Vec::new();

    for &di in &desks {
        let d = &doc.components[di];
        // R(θ)·(0,1) — the desk's local +y in world space (the user's side).
        let (s, c) = d.rotation.sin_cos();
        let (ux, uy) = (-s, c);
        let half_depth = d.h / 2.0;
        // An existing user-placed/frozen chair already at this desk: don't add a
        // second one (a Confirmed chair survives `keep_confirmed` regeneration).
        let already = doc.components.iter().enumerate().any(|(j, o)| {
            j != di
                && o.category == "Chair"
                && (o.x - d.x).abs() < d.w
                && (o.y - d.y).abs() < d.h + CHAIR_SIZE
        });
        if already {
            continue;
        }

        let mut seated = false;
        'sides: for side in [1.0f64, -1.0] {
            // Chair faces its desk: on the +y side it looks back along −y (rot+π);
            // on the −y side its own +y already points at the worktop (rot).
            let rot = if side > 0.0 {
                d.rotation + std::f64::consts::PI
            } else {
                d.rotation
            };
            for proj in [project, project * 0.5, CHAIR_PROJECT_MIN] {
                let dist = half_depth + proj - half_chair;
                let cx = snap_module(d.x + side * ux * dist);
                let cy = snap_module(d.y + side * uy * dist);
                let (cw, ch) = world_extents(CHAIR_SIZE, CHAIR_SIZE, rot);
                if !slot_fits_plate(plate, cx, cy, cw, ch, 0.0)
                    || !slot_clears_walls(iwalls, cx, cy, cw, ch)
                    || footprint_overlaps(&placed, cx, cy, cw, ch, -1e-6)
                {
                    continue;
                }
                // Free of every component except the desk it belongs to.
                let fouls = boxes
                    .iter()
                    .enumerate()
                    .any(|(j, &b)| j != di && footprint_overlaps(&[b], cx, cy, cw, ch, -1e-6));
                if fouls {
                    continue;
                }
                seats.push((cx, cy, rot));
                placed.push((cx, cy, cw, ch));
                seated = true;
                break 'sides;
            }
        }
        let _ = seated;
    }

    for (x, y, rot) in seats {
        push_component(doc, "Chair", x, y, CHAIR_SIZE, CHAIR_SIZE, rot);
    }
}

/// Solid return (m) at each end of a modelled facade wall, which the glazed
/// curtain-wall band stops short of. 600 mm is the module the plan renderer's
/// own fallback already draws (`web/src/export/wallTypes.ts::CORNER_RETURN`), so
/// the drawn facade and the billed facade are one convention, not two.
pub(crate) const FACADE_PIER: f64 = 0.6;
/// Below this run length (m) a facade wall is all pier — there is no room for a
/// window band between two returns.
pub(crate) const MIN_GLAZED_RUN: f64 = 2.0 * FACADE_PIER + 0.5;

/// Model the perimeter facade as what an office facade actually is: a **glazed
/// band between solid corner piers**.
///
/// Each architectural wall the quantity classifier calls `PerimeterWall` is split
/// into three collinear segments — `FACADE_PIER` solid, the glazed band, then
/// `FACADE_PIER` solid — with `glazing: true` on the band only. Runs shorter than
/// `MIN_GLAZED_RUN` stay wholly solid.
///
/// **Why in the geometry and not in a classifier rule.** Everything downstream
/// reads the document: `quantity::classify_wall` bills the band as
/// `Perimeter windows` (rule 2) and the piers as `Perimeter wall`, the plan
/// renderer colours them from that same classification, the 3D viewer builds
/// glass there, and `cost.rs` prices it. One edit to the model therefore makes
/// the takeoff and the plan graphic tell the same story by construction — they
/// cannot drift, because there is only one fact.
///
/// **Idempotent**, so regenerating never re-splits: an already-glazed band is
/// skipped by the `!glazing` guard and a `FACADE_PIER` return is far below
/// `MIN_GLAZED_RUN`. Deterministic — document order, no RNG. Only walls the
/// classifier ALREADY calls `PerimeterWall` are touched, so core/keep-out walls,
/// interior partitions and every generated wall are left alone, and a document
/// whose walls do not close into a plate (no traced polygon) is left alone
/// entirely rather than guessed at.
pub(crate) fn glaze_facade(doc: &mut Document) {
    let Some(plate) = doc.plate_polygon() else { return };
    // Re-cut a wall in place (it keeps its id as the first pier) and append the
    // band + far pier. Collecting first keeps the borrow checker happy and makes
    // the pass independent of the order things are pushed.
    let mut extra: Vec<Wall> = Vec::new();
    for i in 0..doc.walls.len() {
        let w = &doc.walls[i];
        if w.generated || w.glazing {
            continue;
        }
        let len = w.length();
        if len < MIN_GLAZED_RUN {
            continue;
        }
        if crate::quantity::classify_wall(w, &doc.keepouts, Some(&plate))
            != crate::quantity::WallType::PerimeterWall
        {
            continue;
        }
        let (a, b, thickness, height_m) = (w.a, w.b, w.thickness, w.height_m);
        let (ux, uy) = ((b.x - a.x) / len, (b.y - a.y) / len);
        let at = |t: f64| Point::new(a.x + ux * t, a.y + uy * t);
        let (p0, p1) = (at(FACADE_PIER), at(len - FACADE_PIER));
        let seg = |a: Point, b: Point, glazing: bool| Wall {
            id: 0, // assigned below, once `doc` is free to allocate
            a,
            b,
            thickness,
            generated: false,
            glazing,
            height_m,
        };
        extra.push(seg(p0, p1, true));
        extra.push(seg(p1, b, false));
        doc.walls[i].b = p0; // the original wall becomes the near pier
    }
    for mut w in extra {
        w.id = doc.alloc_id();
        doc.walls.push(w);
    }
}
