//! Desk packing: the axis-aligned lattice packer and the principal-axis
//! oriented packer for tilted/irregular plates.

use super::*;
use super::diag::DeskRejects;

/// Minimum desks a contiguous bench-pair segment must seat to be packed at all —
/// the NEIGHBOURHOOD floor. The professional-feel rubric (§1.1.2, the same
/// source PQ1's 6–12 band pins) reads an open field as neighbourhoods of ~6–12
/// desks; a 1-, 2- or 4-desk fragment stranded beside an obstacle reads as
/// furniture left behind, not as a workplace. Measured on the demo plate before
/// this floor existed: 63 desks fell into neighbourhoods
/// [16, 12, 8, 8, 4, 4, 4, 4, 2, 1] — seven of ten outside the band, every one
/// under it a fragment (an obstacle-cut row segment, the unpaired trailing
/// lattice line, or a target-exhaustion tail).
pub(crate) const NEIGHBOURHOOD_MIN: u32 = 6;

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

/// **The ONE obstacle model.** One region field's candidate desk lattice, and
/// which of those candidates are free against ONE obstacle set — built once and
/// read by BOTH `field_free_slots` (capacity) and `pack_desks` (placement).
///
/// `allocate_desks` used to divide the field rect by the desk pitch. That is
/// capacity in an empty room, and the desks are packed into a room that is not
/// empty: on the sample plate R1 was allocated 5 desks into a field whose six
/// candidate slots were **all six** rejected as occupied, and R2 was allocated 2
/// into three slots that were **all three** occupied. Seven desks went to wings
/// that could not take one, and the regions that could were short by seven.
///
/// Measuring capacity by re-walking "the same" lattice with "the same"
/// predicates fixed that on ONE plate and left the two halves free to drift,
/// which they did — in **three** places at once, all invisible while the sample
/// plate's field was over-subscribed and capacity therefore never bound:
///
/// 1. **The cluster aisle.** The packer offsets inner slot `i` by
///    `(i / cluster_cols).min(max_aisles) · clear`; the capacity walk did not.
///    The two were counting slots at *different coordinates*.
/// 2. **The neighbourhood spread.** The packer sweeps only `units_used` outer
///    units — derived from `ceil(target / inner_n)`, i.e. from the assumption
///    that every slot on a used line is free — and strides them across the
///    field. Capacity walked every outer line. Measured on a plain 20×20 m
///    rectangle: capacity 25, the packer's four spread rows hold 28 candidates
///    of which 12 are inside rooms, so it placed 16.
/// 3. **The pair tail.** A spread bench unit maps to lines `2u` and `2u+1`, and
///    `2u+1` can be `outer_n` — off the end of the field. Every slot on that
///    phantom line was counted as a bounds rejection (`b11` on 30×24, `b13` on
///    the real plate).
///
/// So the two no longer *agree*; they are the same enumeration. `free[o]` holds
/// the inner indices of outer line `o` whose SNAPPED footprint clears the field
/// rect, the plate, the interior walls and every obstacle — and capacity is its
/// cardinality while placement is a subset of its members.
pub(crate) struct FieldGrid {
    column_major: bool,
    fw: f64,
    fh: f64,
    base_rot: f64,
    pub(crate) bench: bool,
    inner_first: f64,
    inner_pitch: f64,
    outer_first: f64,
    outer_first_near: f64,
    outer_half: f64,
    outer_desk: f64,
    outer_pitch: f64,
    block: f64,
    clear: f64,
    cluster_cols: u32,
    /// Neighbourhood discipline is ON: bench pairing with at least one
    /// full-size segment, so the segment floor and the take rule apply. See
    /// [`NEIGHBOURHOOD_MIN`]. Off (non-bench, or a field too small to hold one
    /// proper neighbourhood) the packer behaves as before — a tiny office
    /// seats its four desks rather than nobody.
    pub(crate) neighbourhoods: bool,
    pub(crate) inner_n: i64,
    pub(crate) outer_n: i64,
    pub(crate) field_depth: f64,
    /// Inner indices free on each outer line `0..outer_n`.
    pub(crate) free: Vec<Vec<i64>>,
    /// Why the rest were turned down, over the WHOLE grid (not merely the lines
    /// a particular target happened to sweep).
    pub(crate) rejects: DeskRejects,
}

impl FieldGrid {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build(
        program: &Program,
        plan: &RegionPlan,
        plate: Option<&[Point]>,
        iwalls: &[(Point, Point, f64)],
        obstacles: &[(f64, f64, f64, f64)],
        lat: Lattice,
        clear: f64,
        cluster_cols: u32,
        // Zone rects a candidate may not STRADDLE (partly inside, partly
        // outside). The whole-plate fill passes the emitted Workspace zones —
        // its field is the plate bbox, so a lattice slot can lie half across a
        // region zone's edge, which is the user's "desk crossing the zone
        // boundary" defect (Workstream E; 3 desks × 3 golden real_plate cases,
        // up to 0.55 m outside). Fully inside (owned by that zone) and fully
        // outside (tiled by the fill afterwards) both stay legal — this also
        // makes the fill's center-containment tile test EXACT, because with
        // straddlers rejected center-in implies fully-in. The per-region and
        // top-up passes pass `&[]`: their field rect IS the zone rect, so a
        // straddler is already a bounds rejection there.
        no_straddle: &[geometry::Rect],
    ) -> FieldGrid {
        let f = plan.field;
        let column_major = plan.portrait;
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
        let (hw, hh) = (fw / 2.0, fh / 2.0);
        let (px, py) = (fw + clear, fh + clear);
        let bench = program.bench_pairs;
        let depth = if column_major { f.width() } else { f.height() };
        let mut g = FieldGrid {
            column_major,
            fw,
            fh,
            base_rot,
            bench,
            inner_first: 0.0,
            inner_pitch: 0.0,
            outer_first: 0.0,
            outer_first_near: 0.0,
            outer_half: 0.0,
            outer_desk: 0.0,
            outer_pitch: 0.0,
            block: 0.0,
            clear,
            cluster_cols: cluster_cols.max(1),
            neighbourhoods: false,
            inner_n: 0,
            outer_n: 0,
            field_depth: depth,
            free: Vec::new(),
            rejects: DeskRejects::default(),
        };
        if f.x1 <= f.x0 || f.y1 <= f.y0 || program.desk_w <= 0.0 || program.desk_h <= 0.0 {
            return g;
        }
        // Axis assignment. The INNER axis runs uniform-pitch desks along the
        // region's long side (cluster aisles accrue here); the OUTER axis carries
        // the rows that PAIR back-to-back under bench desking. A portrait region
        // transposes so its wing fills with natural vertical rows.
        let (inner_o, i_lo, i_hi, i_half, i_pitch, i_size) =
            if column_major { (lat.oy, f.y0, f.y1, hh, py, fh) } else { (lat.ox, f.x0, f.x1, hw, px, fw) };
        let (outer_o, o_lo, o_hi, o_half, o_pitch, o_desk) = if column_major {
            (lat.ox, f.x0, f.x1, hw, px, fw)
        } else {
            (lat.oy, f.y0, f.y1, hh, py, fh)
        };

        // GLOBAL lattice phase: the first line of the shared lattice (module-
        // snapped origin at the plate bbox min, plus the odd-seed half-pitch)
        // that clears this region's inset. Because the phase comes from the plate
        // origin — not the region corner — adjacent wings' rows/columns land on
        // the SAME lines across the seam.
        let mut inner_first = inner_o + ((i_lo - inner_o) / i_pitch).ceil() * i_pitch + i_half;
        // Degenerate-field fallback (small-plate graceful degradation): the phase
        // can push the ONLY line that physically fits OUT of a shallow field.
        // Fires only in the n==0-but-fits case.
        if inner_first + i_half > i_hi + 1e-9 && i_hi - i_lo >= i_size - 1e-9 {
            inner_first = i_lo + i_half;
        }
        let mut outer_first = outer_o + ((o_lo - outer_o) / o_pitch).ceil() * o_pitch + o_half;
        if outer_first + o_half > o_hi + 1e-9 && o_hi - o_lo >= o_desk - 1e-9 {
            outer_first = o_lo + o_half;
        }
        g.inner_first = inner_first;
        g.inner_pitch = i_pitch;
        g.outer_first = outer_first;
        g.outer_half = o_half;
        g.outer_desk = o_desk;
        g.outer_pitch = o_pitch;
        // Under bench pairing rows come back-to-back in PAIRS:
        //   [desk | SPINE_GAP | desk(rotated π) | aisle] repeating,
        // block = 2·desk + SPINE_GAP + aisle — DENSER than 2·(desk+clearance)
        // single rows, which is exactly why real plans pair. Pairs anchor to
        // global BLOCK lines so stacked wings still share pair lines.
        //
        // The aisle between two pair-blocks is a WALKABLE cross-aisle between
        // desk neighbourhoods, so it is floored at `SECONDARY_W` (1.15 m, IBC —
        // that constant's own documented meaning), not at the per-desk
        // maintenance clearance (0.9 m). At 0.9 m two adjacent pair-blocks fuse
        // into one un-walkable 4-row mat — the [16]-desk super-cluster on the
        // demo plate — and the field packs past the density a person can move
        // through (zone 680 at 4.29 m²/pax on the repro plate). A program whose
        // clearance already exceeds the IBC aisle keeps it.
        g.block = 2.0 * o_desk + SPINE_GAP + clear.max(SECONDARY_W);
        // Pairs start at the first PITCH-aligned line clearing the inset (not the
        // coarser block line — that wasted up to a full block at each region's
        // near edge). Two regions sharing the outer range resolve the same start.
        g.outer_first_near = outer_first - o_half;

        // Axis extents. `inner_n` is the AISLE-FREE count, exactly as the packer
        // has always computed it, because `max_aisles` is derived from it — the
        // aisle-shifted slots that then fall past the far edge are recorded as
        // bounds rejections rather than silently shortening the axis.
        g.inner_n = if inner_first + i_half <= i_hi + 1e-9 {
            (((i_hi - i_half - inner_first) / i_pitch).floor() as i64 + 1).max(0)
        } else {
            0
        };
        g.outer_n = {
            let mut n = 0i64;
            while g.outer_center(n) + o_half <= o_hi + 1e-9 {
                n += 1;
            }
            n
        };
        if g.inner_n <= 0 || g.outer_n <= 0 {
            g.inner_n = g.inner_n.max(0);
            g.outer_n = g.outer_n.max(0);
            return g;
        }
        // Cluster aisles accrue on the INNER axis, one per `cluster_cols`
        // columns, UNCONDITIONALLY. They used to be capped to whatever slack
        // the inner span happened to have left ("utilization wins"), which is
        // how eight columns fused into the demo plate's [16]-desk super-cluster:
        // the third aisle never opened, and the neighbourhood boundary the
        // cluster rhythm exists to draw simply was not drawn. An aisle-shifted
        // slot that no longer fits the field is a bounds rejection like any
        // other — the aisle is structure, not a luxury of leftover space.

        // The single occupancy walk. Every candidate is classified once, by the
        // same predicates in the same order the packer used to apply them —
        // separately, not as one `&&` chain, so the counter names the cause.
        g.free = Vec::with_capacity(g.outer_n as usize);
        for o in 0..g.outer_n {
            let mut line = Vec::new();
            for i in 0..g.inner_n {
                let (fx, fy, _) = g.slot_center(o, i);
                if fx - hw < f.x0 - 1e-9
                    || fx + hw > f.x1 + 1e-9
                    || fy - hh < f.y0 - 1e-9
                    || fy + hh > f.y1 + 1e-9
                {
                    g.rejects.bounds += 1;
                    continue;
                }
                if !slot_fits_plate(plate, fx, fy, fw, fh, FACADE_GAP) {
                    g.rejects.plate += 1;
                    continue;
                }
                if !slot_clears_walls(iwalls, fx, fy, fw, fh) {
                    g.rejects.walls += 1;
                    continue;
                }
                if footprint_overlaps(obstacles, fx, fy, fw, fh, clear - 1e-6) {
                    g.rejects.obstacles += 1;
                    continue;
                }
                if no_straddle.iter().any(|r| {
                    // Interpenetration beyond fp noise…
                    let overlaps = fx - hw < r.x1 - 1e-6
                        && fx + hw > r.x0 + 1e-6
                        && fy - hh < r.y1 - 1e-6
                        && fy + hh > r.y0 + 1e-6;
                    // …without full containment (flush-on-the-edge counts as in).
                    let inside = fx - hw >= r.x0 - 1e-9
                        && fx + hw <= r.x1 + 1e-9
                        && fy - hh >= r.y0 - 1e-9
                        && fy + hh <= r.y1 + 1e-9;
                    overlaps && !inside
                }) {
                    g.rejects.straddle += 1;
                    continue;
                }
                line.push(i);
            }
            g.free.push(line);
        }

        // ---- The NEIGHBOURHOOD floor (bench pairing only) -------------------
        //
        // A bench unit's free slots partition into contiguous COLUMN SEGMENTS
        // (runs of consecutive columns inside one aisle block with at least one
        // free line) — and a segment IS a neighbourhood: within it every desk
        // is < 1.1 m from a neighbour, across a segment break (an aisle, a
        // missing column, a pair gap at SECONDARY_W) nothing is. A segment that
        // cannot seat NEIGHBOURHOOD_MIN desks would pack as a stray fragment,
        // so its slots are not free at all — counted under `rejects.runt`, so
        // capacity and placement (both reads of THIS enumeration) agree that
        // they do not exist.
        //
        // Non-bench fields are exempt: single rows connect across the outer
        // axis, so their neighbourhoods span rows and a per-unit floor would be
        // measuring the wrong unit. So is a field whose LARGEST segment is
        // under the floor — a plate that can only ever hold one small cluster
        // (a 4-desk studio) should seat people, not nobody.
        if g.bench {
            let mut any_full = false;
            for u in 0..g.units_avail() {
                for (_, _, slots) in g.segments(u) {
                    if slots >= NEIGHBOURHOOD_MIN {
                        any_full = true;
                    }
                }
            }
            if any_full {
                g.neighbourhoods = true;
                for u in 0..g.units_avail() {
                    for (c0, c1, slots) in g.segments(u) {
                        if slots >= NEIGHBOURHOOD_MIN {
                            continue;
                        }
                        for o in g.unit_lines(u) {
                            let line = &mut g.free[o as usize];
                            let before = line.len();
                            line.retain(|&i| i < c0 || i > c1);
                            g.rejects.runt += (before - line.len()) as u32;
                        }
                    }
                }
            }
        }
        g
    }

    /// Column segments of bench unit `u`: `(col0, col1, free_slots)` for each
    /// maximal run of consecutive columns that (a) stays inside one cluster
    /// aisle block and (b) has at least one free line per column. The
    /// neighbourhood partition — used by the floor above, the take rule in
    /// [`pack_desks`] and [`FieldGrid::resolve_take`], so all three are one
    /// model.
    fn segments(&self, u: i64) -> Vec<(i64, i64, u32)> {
        let lines = self.unit_lines(u);
        let mut per = vec![0u32; self.inner_n.max(0) as usize];
        for &o in &lines {
            for &i in &self.free[o as usize] {
                per[i as usize] += 1;
            }
        }
        let mut out = Vec::new();
        let mut start: Option<i64> = None;
        let mut slots = 0u32;
        for i in 0..self.inner_n {
            let breaks = per[i as usize] == 0
                || start.is_some_and(|s| {
                    s as u32 / self.cluster_cols != i as u32 / self.cluster_cols
                });
            if breaks {
                if let Some(s) = start.take() {
                    out.push((s, i - 1, slots));
                }
                slots = 0;
            }
            if per[i as usize] > 0 {
                if start.is_none() {
                    start = Some(i);
                }
                slots += per[i as usize];
            }
        }
        if let Some(s) = start {
            out.push((s, self.inner_n - 1, slots));
        }
        out
    }

    /// The slots of one segment, column-major (both lines of a column before
    /// the next column), which is the order the packer takes a partial
    /// segment in — a `k`-desk take covers `ceil(k/2)` adjacent columns, so a
    /// truncated neighbourhood is still a compact block.
    fn segment_slots(&self, u: i64, c0: i64, c1: i64) -> Vec<(i64, i64)> {
        let lines = self.unit_lines(u);
        let mut out = Vec::new();
        for i in c0..=c1 {
            for &o in &lines {
                if self.free[o as usize].binary_search(&i).is_ok() {
                    out.push((o, i));
                }
            }
        }
        out
    }

    /// How many desks a walk with target `t` would actually place, under the
    /// spread and the neighbourhood take rule (no collisions can occur before
    /// placement, so this is exact for the pass that runs on this grid).
    fn walk_take(&self, t: u32) -> u32 {
        let units = if self.neighbourhoods { self.spread_for(t) } else { return t.min(self.capacity()) };
        let mut placed = 0u32;
        'walk: for &u in &units {
            for (_, _, slots) in self.segments(u) {
                let remaining = t - placed;
                if remaining == 0 {
                    break 'walk;
                }
                if remaining < NEIGHBOURHOOD_MIN && slots > remaining {
                    break 'walk; // a runt tail is not placed at all
                }
                placed += slots.min(remaining);
            }
        }
        placed
    }

    /// The largest achievable take ≤ `target` under the neighbourhood rule —
    /// the fixpoint of [`FieldGrid::walk_take`] (each iteration only shrinks,
    /// so it terminates). `allocate_desks` clamps each region's allocation
    /// through THIS, and `pack_desks` walks the same rule on the same grid, so
    /// `placed == allocated` stays an invariant rather than an aspiration.
    pub(crate) fn resolve_take(&self, target: u32) -> u32 {
        let mut t = target.min(self.capacity());
        loop {
            let k = self.walk_take(t);
            if k >= t {
                return t;
            }
            t = k;
        }
    }

    fn outer_center(&self, o: i64) -> f64 {
        outer_line(
            o,
            self.bench,
            self.outer_first,
            self.outer_first_near,
            self.outer_half,
            self.outer_desk,
            self.block,
            self.outer_pitch,
            0.0,
        )
        .0
    }

    /// Snapped world centre + rotation of candidate `(o, i)`. Snapping to the
    /// module can shift a slot 0.025 m on an off-module plate, which is why the
    /// bounds test above runs on the SNAPPED footprint, not the lattice one.
    fn slot_center(&self, o: i64, i: i64) -> (f64, f64, f64) {
        let (oc, rot) = outer_line(
            o,
            self.bench,
            self.outer_first,
            self.outer_first_near,
            self.outer_half,
            self.outer_desk,
            self.block,
            self.outer_pitch,
            self.base_rot,
        );
        let aisle = (i as u32 / self.cluster_cols) as f64 * self.clear;
        let ic = self.inner_first + i as f64 * self.inner_pitch + aisle;
        let (cx, cy) = if self.column_major { (oc, ic) } else { (ic, oc) };
        (snap_module(cx), snap_module(cy), rot)
    }

    /// Free slots in total — the region's capacity.
    pub(crate) fn capacity(&self) -> u32 {
        self.free.iter().map(|l| l.len() as u32).sum()
    }

    /// Bench pairs (or single rows) available on the outer axis.
    fn units_avail(&self) -> i64 {
        if self.bench {
            (self.outer_n + 1) / 2
        } else {
            self.outer_n
        }
    }

    /// The outer lines a unit occupies, clipped to the field — a bench pair's
    /// second line is `2u+1`, which for an odd `outer_n` runs off the end.
    fn unit_lines(&self, u: i64) -> Vec<i64> {
        if self.bench {
            [u * 2, u * 2 + 1].into_iter().filter(|&o| o < self.outer_n).collect()
        } else {
            [u].into_iter().filter(|&o| o < self.outer_n).collect()
        }
    }

    /// The `used` units spread across the whole outer axis. Integer arithmetic,
    /// so the result is deterministic and every unit still lands on its lattice
    /// line — the spread chooses BETWEEN lattice lines, it does not invent
    /// positions between them.
    fn spread_units(&self, used: i64) -> Vec<i64> {
        let avail = self.units_avail();
        (0..used.clamp(0, avail))
            .map(|u| {
                if used >= avail || used <= 1 {
                    u
                } else {
                    (u * (avail - 1)) / (used - 1)
                }
            })
            .collect()
    }

    /// **The smallest spread that actually holds `target` free slots.**
    ///
    /// The old arithmetic was `ceil(target / inner_n)` — rows-needed computed as
    /// if every slot on a row were free, which is the empty-room assumption F1a
    /// removed from allocation, still live inside the spread. Counting the free
    /// slots of each candidate spread instead makes the packer's own line
    /// selection obstacle-aware, and is what lets `placed == allocated` hold.
    fn spread_for(&self, target: u32) -> Vec<i64> {
        let avail = self.units_avail();
        for used in 1..=avail {
            let units = self.spread_units(used);
            let got: u32 = units
                .iter()
                .flat_map(|&u| self.unit_lines(u))
                .map(|o| self.free[o as usize].len() as u32)
                .sum();
            if got >= target {
                return units;
            }
        }
        (0..avail).collect()
    }
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
    // Zone rects a slot may not straddle — see `FieldGrid::build`. `&[]` on
    // every pass except the whole-plate fill.
    no_straddle: &[geometry::Rect],
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
        // ONE obstacle model, built against the obstacle set as it stands at
        // ENTRY — byte-for-byte the set `allocate_desks` measured capacity
        // against on the primary pass. Capacity is `grid.capacity()`; placement
        // is a subset of `grid.free`. There is no second enumeration to drift.
        let grid = FieldGrid::build(
            program, plan, plate, iwalls, &obstacles[..], lat, clear, choices.cluster_cols,
            no_straddle,
        );
        if let Some(d) = diag.as_deref_mut() {
            d.grid_outer = grid.outer_n;
            d.grid_inner = grid.inner_n;
            d.field_depth = grid.field_depth;
            d.rejects = grid.rejects.clone();
            d.pack_capacity = grid.capacity();
        }
        if grid.inner_n <= 0 || grid.outer_n <= 0 || desk_target == 0 {
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
        // band) and geometrically collapsed into a column.
        //
        // So spread the rows the target DOES buy across the whole field instead
        // of stacking them at one edge. The gaps that opens are not waste — they
        // are the aisles between desk neighbourhoods, which is what makes an open
        // field read as a plan rather than as a slab of furniture.
        //
        // Bench pairs move as PAIRS, so back-to-back rows stay back-to-back and
        // the pairing convention is untouched; only which pair-lines are used
        // changes, and each used line is still a global-lattice line.
        //
        // `spread_for` sizes the spread by the FREE slots on each candidate set,
        // not by `ceil(target / inner_n)`. That old arithmetic assumed every slot
        // on a used line was empty — the same empty-room assumption F1a removed
        // from allocation, still live here, and the reason a 20×20 m plate
        // allocated 25 and placed 16.
        //
        // ONLY the primary per-region field pass spreads. `emit_zones` is exactly
        // that flag: the top-up pass and the whole-plate leftover fill both pass
        // `false`, and their whole job is to seat desks in the gaps a previous
        // pass left. Spreading THEM would stride over the very gaps they exist to
        // close — measured: with the spread applied to every pass the plate fell
        // from 92 desks to 70 and the fill placed 0 of its 22-desk budget.
        let units: Vec<i64> = if emit_zones {
            grid.spread_for(desk_target)
        } else {
            (0..grid.units_avail()).collect()
        };

        // Two clearance regimes. Same-grid desks are pitched `clear` apart (or
        // SPINE_GAP apart for a bench pair) BY CONSTRUCTION, so their check needs
        // only guard fp noise; the pre-pass obstacles the grid was built against
        // already hold the FULL clearance. Under pairing the same-grid pad shrinks
        // below the spine so the intended 0.15 m gap (or a touching 0.0) is never
        // flagged as a collision.
        //
        // KEPT, not assumed away: "by construction" is precisely the claim that
        // made this defect invisible for a whole plate. If two slots the grid
        // called free ever do collide, this rejects one and the shortfall shows up
        // as `placed < allocated` in
        // `desk_capacity_agrees_with_the_packer_across_plates_and_seeds`.
        let same_grid_pad = if program.bench_pairs { SPINE_GAP * 0.5 - 1e-6 } else { clear * 0.5 };
        let grid_start = obstacles.len();

        // The walk takes whole SEGMENTS (neighbourhoods) in spread order —
        // the same partition and take rule as `FieldGrid::resolve_take`, which
        // is what the allocation was clamped through, so the two agree by
        // construction. A remaining target below `NEIGHBOURHOOD_MIN` at a
        // segment boundary is NOT placed: a 1–5 desk tail stranded beside a
        // proper neighbourhood is exactly the fragment the floor exists to
        // prevent (the demo plate's trailing `[4, 4, 1]`).
        'grid: for u in units {
            for (c0, c1, slots) in grid.segments(u) {
                let remaining = desk_target - desks_here;
                if remaining == 0 {
                    break 'grid;
                }
                if grid.neighbourhoods && remaining < NEIGHBOURHOOD_MIN && slots > remaining {
                    break 'grid;
                }
                for (o, i) in grid.segment_slots(u, c0, c1) {
                    if desks_here >= desk_target {
                        break;
                    }
                    let (fx, fy, rot) = grid.slot_center(o, i);
                    if footprint_overlaps(&obstacles[grid_start..], fx, fy, grid.fw, grid.fh, same_grid_pad)
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
                    obstacles.push((fx, fy, grid.fw, grid.fh));
                    desks_here += 1;
                }
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
