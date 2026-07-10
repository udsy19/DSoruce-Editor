//! Autonomous test-fit layout generator (v1) + objective function.
//!
//! This is Stage 3 ("Generate") of the pipeline in
//! `research/07-synthesis-and-proposed-pipeline.md`, and the deterministic
//! heuristic engine (`research/06 §1`) at the base of the
//! generate → evaluate → optimize loop documented in
//! `docs/design/autonomous-testfit-loop.md`.
//!
//! Strategy: carve the wall bounding box into a perimeter circulation corridor,
//! a meeting-room band, and a grid-packed desk zone with clearance aisles. The
//! generator is a **pure function of (program, seed)** so runs are reproducible
//! and the optimizer can re-roll by bumping the seed. Constraints (perimeter
//! corridor + per-desk clearance) hold *by construction*.
//!
//! Standards used for the defaults / clearances:
//!   - perimeter/primary circulation 0.9–1.2 m (IBC 2024 §1020.3 ≈ 1.118 m min):
//!     https://arcedior.com/blog/open-office-layout-standards-clearances-2025
//!   - workstation clearances:
//!     https://www.dimensions.com/element/office-workstation-clearances
//!   - ~5.5–6.5 m² per workstation, 40–50 % of floor to desks:
//!     https://www.factoryoficina.com/gb/blog/office-space-planning-how-many-workstations-fit-per-m-quick-rule-templates.html
//! Evaluator-optimizer loop pattern this scoring feeds:
//!     https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/evaluator_optimizer.ipynb

use crate::circulation::{self, CirculationConfig};
use crate::document::Document;
use crate::geometry::{self, Point};
use crate::model::{Component, DecisionState, Wall};
use crate::zone::{Zone, ZoneShape, ZoneType};
use serde::{Deserialize, Serialize};

// ---- M7: strategy-distinct alternatives (the A/B/C the gallery shows) --------

/// A space-planning STRATEGY the autonomous search optimises for. The three are
/// meant to be structurally DISTINCT — not seed-noise — so the gallery's A/B/C
/// are a real trade-off the user picks between (mirrors qbiq's A/B/C, which
/// differ in offices/conference/seats), not three renders of one plan:
///
///  - **Open** — maximise open workstations, minimal enclosed rooms. The daylit
///    floor is desks; the highest seat count / density.
///  - **Balanced** — the professional derived mix (spec §1.1). The DEFAULT, and
///    byte-identical to the pre-M7 behaviour (identity mix + identity weights),
///    so every existing plan/test is unchanged.
///  - **Cellular** — privacy-forward: more enclosed offices + focus rooms, fewer
///    open desks.
///
/// A strategy shifts (a) the DERIVED program mix — open share (desks) and the
/// cellular room families (cabins / focus / phone booths) — and (b) the SCORING
/// weights (Open rewards capacity/density; Cellular rewards program-fit/enclosure).
/// When the user sets an EXPLICIT room program (`Program.rooms`) the counts are
/// honoured verbatim: the mix shift is suppressed (see `program_open_share` /
/// `program_cellular_mult`) and the strategy then only steers scoring + the seed
/// search, never the counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Strategy {
    Open,
    #[default]
    Balanced,
    Cellular,
}

impl Strategy {
    /// Open-plan share of the design headcount seated at open workstations.
    /// Balanced returns the tuned baseline `OPEN_SHARE`; Open pushes toward the
    /// qbiq reference (~0.95 open); Cellular pulls headcount into enclosed rooms.
    fn open_share(self) -> f64 {
        match self {
            Strategy::Open => 0.95,
            Strategy::Balanced => OPEN_SHARE,
            Strategy::Cellular => 0.72,
        }
    }

    /// Multiplier on the CELLULAR room families (cabins, focus rooms, phone
    /// booths) in the derived program. Balanced is the identity (1.0 → the
    /// derive table is byte-unchanged); Open thins the enclosure; Cellular
    /// multiplies it into a privacy-forward mix.
    fn cellular_mult(self) -> f64 {
        match self {
            Strategy::Open => 0.45,
            Strategy::Balanced => 1.0,
            Strategy::Cellular => 1.9,
        }
    }

    /// Ceiling on the derived support program's net area as a fraction of the
    /// plate. Balanced keeps the tuned `SUPPORT_AREA_CAP`; Open tightens it (the
    /// open field must dominate even harder); Cellular relaxes it so the extra
    /// enclosure it asks for is not trimmed straight back to Balanced.
    fn support_cap(self) -> f64 {
        match self {
            Strategy::Open => 0.15,
            Strategy::Balanced => SUPPORT_AREA_CAP,
            Strategy::Cellular => 0.40,
        }
    }

    /// Per-sub-score multipliers applied to the program's objective weights, so
    /// the seed search WITHIN a strategy optimises for that strategy's priorities
    /// (Open → capacity/density; Cellular → program-fit/entry). Balanced is the
    /// identity, so the pre-M7 `total` is byte-unchanged.
    fn weight_bias(self) -> WeightBias {
        match self {
            Strategy::Open => WeightBias {
                capacity: 1.5,
                adjacency: 1.15,
                circulation: 1.0,
                density: 1.35,
                program: 0.6,
                daylight: 1.15,
                entry: 0.8,
            },
            Strategy::Balanced => WeightBias::identity(),
            Strategy::Cellular => WeightBias {
                capacity: 0.7,
                adjacency: 0.9,
                circulation: 1.1,
                density: 0.9,
                program: 1.9,
                daylight: 1.0,
                entry: 1.25,
            },
        }
    }
}

/// Multiplicative adjustment to each objective weight for a `Strategy`.
struct WeightBias {
    capacity: f64,
    adjacency: f64,
    circulation: f64,
    density: f64,
    program: f64,
    daylight: f64,
    entry: f64,
}

impl WeightBias {
    /// All-ones → the strategy leaves the program's weights untouched (Balanced).
    fn identity() -> WeightBias {
        WeightBias {
            capacity: 1.0,
            adjacency: 1.0,
            circulation: 1.0,
            density: 1.0,
            program: 1.0,
            daylight: 1.0,
            entry: 1.0,
        }
    }
}

/// The DERIVED open share for a program: its strategy's, UNLESS an explicit room
/// program is set — then the counts are the user's, so the mix is not shifted
/// (Balanced baseline) and the strategy only steers scoring + the seed search.
fn program_open_share(program: &Program) -> f64 {
    if program.rooms.is_empty() {
        program.strategy.open_share()
    } else {
        Strategy::Balanced.open_share()
    }
}

/// The DERIVED cellular-family multiplier for a program (see `program_open_share`
/// for the explicit-program gate).
fn program_cellular_mult(program: &Program) -> f64 {
    if program.rooms.is_empty() {
        program.strategy.cellular_mult()
    } else {
        1.0
    }
}

/// The DERIVED support-area cap for a program (see `program_open_share`).
fn program_support_cap(program: &Program) -> f64 {
    if program.rooms.is_empty() {
        program.strategy.support_cap()
    } else {
        SUPPORT_AREA_CAP
    }
}

/// The user-set program + criteria. `desks`/`meeting_rooms` and the footprint
/// fields drive the generator; the `w_*` weights drive the evaluator (§1c of the
/// design doc). Implements `Default` so partial JSON from the UI fills sensibly.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Program {
    // --- what to place (generator inputs) ---
    pub desks: u32,
    pub meeting_rooms: u32,
    /// desk footprint, meters (default 1.6 × 0.8)
    pub desk_w: f64,
    pub desk_h: f64,
    /// meeting-room footprint, meters (default 4.0 × 4.0)
    pub meeting_w: f64,
    pub meeting_h: f64,
    /// desks per bench cluster before an aisle is inserted
    pub cluster_cols: u32,
    /// pair desk rows back-to-back (bench desking) instead of uniform single
    /// rows. Default **true**. The struct carries no blanket `#[serde(default)]`,
    /// so a partial JSON blob that omits this field would otherwise ERROR — the
    /// field-level default makes a missing `bench_pairs` deserialize to `true`
    /// (verified by `missing_bench_pairs_field_defaults_true`).
    #[serde(default = "default_bench_pairs")]
    pub bench_pairs: bool,
    /// Derive + place the full professional support program (cabins, phone
    /// booths, focus rooms, pantry, reception, print, IT, storage, wellness —
    /// spec §1.1) alongside the desks/meetings the user asked for. Default
    /// **true**: the UI's existing payload (which omits the field) gets the
    /// professional program automatically. M1/M2-mechanics tests opt out.
    #[serde(default = "default_support_spaces")]
    pub support_spaces: bool,
    /// Design headcount N. `None` → inferred from the desk target at the spec's
    /// default open share (desks = 0.85·N). Drives `SpaceProgram::derive`.
    #[serde(default)]
    pub headcount: Option<u32>,
    /// Explicit room program from the Detailed builder (workflow.md §3.4). Empty
    /// (the default, and every pre-S5 JSON blob) → the derived support program +
    /// `meeting_rooms` override, i.e. today's behaviour. Non-empty → these rooms
    /// REPLACE that room program; the generator honours their counts and
    /// placement bias. `#[serde(default)]` so a missing field never errors and
    /// old documents round-trip unchanged.
    #[serde(default)]
    pub rooms: Vec<RoomReq>,
    /// Space-planning strategy for the autonomous search (M7). Shifts the derived
    /// program mix + scoring weights so the gallery's A/B/C are strategically
    /// distinct. `#[serde(default)]` → missing field deserialises to `Balanced`,
    /// i.e. the exact pre-M7 behaviour, so old JSON round-trips unchanged.
    #[serde(default)]
    pub strategy: Strategy,

    // --- hard constraints ---
    /// perimeter circulation corridor width, meters
    pub target_corridor_m: f64,
    /// clear gap around each desk, meters
    pub desk_clearance_m: f64,

    // --- objective weights (soft goals) ---
    pub w_capacity: f64,
    pub w_adjacency: f64,
    pub w_circulation: f64,
    pub w_density: f64,
    /// Weight of `program_fit` (delivered vs derived room program). Small by
    /// default (M5 recalibrates all weights); serde default keeps old JSON valid.
    #[serde(default = "default_w_program")]
    pub w_program: f64,
    /// Weight of `daylight` (% desks within reach of the facade — qbiq's
    /// published daylight sub-score, spec §5). Small; serde default keeps old
    /// JSON valid.
    #[serde(default = "default_w_daylight")]
    pub w_daylight: f64,
    /// Weight of `entry_adjacency` (reception near the entry, pantry far —
    /// the plan's "enter → reception → spine" narrative, spec §3/§5).
    #[serde(default = "default_w_entry")]
    pub w_entry: f64,
}

impl Default for Program {
    fn default() -> Self {
        Program {
            desks: 24,
            meeting_rooms: 2,
            desk_w: 1.6,
            desk_h: 0.8,
            meeting_w: 4.0,
            meeting_h: 4.0,
            cluster_cols: 4,
            bench_pairs: true,
            support_spaces: true,
            headcount: None,
            rooms: Vec::new(),
            strategy: Strategy::Balanced,
            target_corridor_m: 1.2,
            desk_clearance_m: 0.9,
            w_capacity: 0.35,
            w_adjacency: 0.20,
            w_circulation: 0.25,
            w_density: 0.20,
            w_program: 0.10,
            w_daylight: 0.05,
            w_entry: 0.05,
        }
    }
}

/// Weighted objective breakdown. All sub-scores are 0..100; `total` is the
/// weight-normalised blend. Serialize so the frontend metrics panel and the
/// optimizer loop read the exact same numbers a human judges by.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LayoutScore {
    pub capacity: f64,
    pub adjacency: f64,
    pub circulation: f64,
    pub density: f64,
    /// Delivered vs derived room program, 0..100 (spec §1.1 / M5-prep). 100
    /// when every requested room (meetings + support spaces) got placed; a
    /// shortfall on a wall-dense plate shows here instead of being silent.
    pub program_fit: f64,
    /// % of workstations within `DAYLIGHT_REACH_M` of the facade (plate
    /// boundary) — qbiq's daylight sub-score (spec §5). 100 when every desk sits
    /// near a window, low when desks are buried in the deep plan.
    pub daylight: f64,
    /// Entry narrative, 0..100: reception nearer the entry than the pantry
    /// (spec §3). 100 (neutral) when the plate carries no entry to judge against.
    pub entry_adjacency: f64,
    pub total: f64,
    /// desks actually placed (diagnostic for the loop's "which sub-score is weak")
    pub placed_desks: u32,
}

/// serde field-default for `Program::bench_pairs` (missing field → bench desking on).
fn default_bench_pairs() -> bool {
    true
}

/// serde field-default for `Program::support_spaces` (missing field → the full
/// professional program is derived and placed).
fn default_support_spaces() -> bool {
    true
}

/// serde field-default for `Program::w_program`.
fn default_w_program() -> f64 {
    0.10
}

/// serde field-default for `Program::w_daylight`.
fn default_w_daylight() -> f64 {
    0.05
}

/// serde field-default for `Program::w_entry`.
fn default_w_entry() -> f64 {
    0.05
}

/// Back-to-back spine gap (m) between the two rows of a bench pair. Set to 0.0
/// (**touching** pairs — desks share the spine over a common cable tray, the most
/// common real bench-desking detail). A 0.15 m gap was tried first, but the
/// circulation evaluator's 0.15 m occupancy cells resolved that slot as a spurious
/// ~0.30 m "corridor" (2×cell) flanked by desks, tanking `min_corridor_width` far
/// below the aisle clearance in `l_plate_circulation_quality`. Touching pairs
/// leave no walkable cell between the two rows, so no bogus min-corridor appears,
/// and they pack even denser. Kept as a named constant so the intent — and the
/// path back to a nonzero gap on a finer circulation grid — is explicit.
const SPINE_GAP: f64 = 0.0;

/// The global alignment module (m): EVERY emitted component coordinate and
/// dimension snaps to this grid, so plan dimensions read as round numbers and
/// rows share long straight lines (docs/design/testfit-pro-quality.md §4.1).
const MODULE: f64 = 0.05;

/// Snap a coordinate/dimension to the nearest module line.
fn snap_module(v: f64) -> f64 {
    (v / MODULE).round() * MODULE
}

/// Snap DOWN to the module — for dimensions clamped by available space, so the
/// snapped size never exceeds it. The epsilon rescues exact multiples from
/// binary-representation dust (4.0 / 0.05 sits fractionally below 80.0).
fn snap_module_floor(v: f64) -> f64 {
    ((v / MODULE) + 1e-9).floor() * MODULE
}

/// Snap a ROOM dimension DOWN to twice the module (0.1 m), so its half sits
/// exactly on a module line. Room walls, the centered table, and the door gap
/// are all derived from +/-(dim/2); flooring dims to 0.1 keeps every one of
/// those emitted coordinates on the 0.05 m grid (spec 4.1), even for the
/// support program's odd sizes (3.3 / 2.7 / 1.3 ...). Meeting rooms (even dims)
/// are unaffected.
fn snap_room_floor(v: f64) -> f64 {
    ((v / (2.0 * MODULE)) + 1e-9).floor() * (2.0 * MODULE)
}

// ---- M3: the professional space program (docs/design/testfit-pro-quality.md §1.1) ----

/// One space type of the derived program. `Deserialize` so the Program builder
/// (workflow.md §3.4) can send explicit `RoomReq`s naming these kinds by string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpaceKind {
    /// Generic meeting room — the `Program::meeting_rooms` user override.
    Meeting,
    Cabin,
    Meeting4P,
    Meeting6P,
    Boardroom,
    PhoneBooth,
    Focus,
    Collab,
    Reception,
    Pantry,
    Print,
    ItServer,
    Storage,
    Wellness,
}

impl SpaceKind {
    /// Parse a wire name (the serde variant identifier the TS side sends for an
    /// anchor's `kind`) into a `SpaceKind`. Unknown → `None`, so `add_anchor`
    /// silently ignores a bad kind rather than panicking at the wasm boundary.
    pub fn from_wire(s: &str) -> Option<SpaceKind> {
        use SpaceKind::*;
        Some(match s {
            "Meeting" => Meeting,
            "Cabin" => Cabin,
            "Meeting4P" => Meeting4P,
            "Meeting6P" => Meeting6P,
            "Boardroom" => Boardroom,
            "PhoneBooth" => PhoneBooth,
            "Focus" => Focus,
            "Collab" => Collab,
            "Reception" => Reception,
            "Pantry" => Pantry,
            "Print" => Print,
            "ItServer" => ItServer,
            "Storage" => Storage,
            "Wellness" => Wellness,
            _ => return None,
        })
    }
}

/// A derived space requirement: `count` rooms of `w` (front run along the
/// corridor) × `d` (depth away from it) meters.
#[derive(Clone, Debug, Serialize)]
pub struct SpaceReq {
    pub kind: SpaceKind,
    pub count: u32,
    pub w: f64,
    pub d: f64,
}

impl SpaceReq {
    #[allow(dead_code)] // used by area_per_person (density sanity), tested
    pub fn area(&self) -> f64 {
        self.w * self.d * self.count as f64
    }
}

/// Facade preference for an explicit room request (qbiq Window/Core/Flexible,
/// workflow.md §3.4). A SOFT placement BIAS, never a hard solver: Window rooms
/// sort toward facade-adjacent band slots (and, on a decomposed plate,
/// facade-adjacent wings); Core rooms toward the interior; Flexible keeps the
/// default order. Default `Flexible` → serde-missing fields and every legacy
/// (derived-program) room behave exactly as before.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Placement {
    Window,
    Core,
    #[default]
    Flexible,
}

/// One explicit room request from the Detailed program builder (workflow.md
/// §3.4). When `Program.rooms` is non-empty it REPLACES the derived support
/// program + meeting override: the generator places exactly these rooms (counts
/// honored where they fit, honestly reported through `program_fit` where they
/// don't). Desks still scale to the headcount/plate, unchanged.
///
/// `w`/`d` (meters, corridor-run × depth) override the per-kind default
/// footprint — the builder's Executive / Large / Medium / Small office are the
/// SAME `SpaceKind::Cabin` at different sizes, so the size lives on the request,
/// not in a combinatorial enum. Omitted → the kind's default from `job_template`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoomReq {
    pub kind: SpaceKind,
    pub count: u32,
    #[serde(default)]
    pub w: Option<f64>,
    #[serde(default)]
    pub d: Option<f64>,
    #[serde(default)]
    pub placement: Placement,
}

/// The full professional program for a headcount, per the spec §1.1 table.
/// Pure and deterministic — no RNG, no document.
#[derive(Clone, Debug, Serialize)]
pub struct SpaceProgram {
    /// Effective design headcount (input N, capped by what the plate can hold
    /// at ~7 m²/person so a tiny plate never receives a 150-person program).
    pub headcount: u32,
    /// Open workstations: `0.85·N` (open share default), ceil.
    pub desks: u32,
    pub reqs: Vec<SpaceReq>,
}

/// Gross allowance per open workstation (m², incl. its share of bench aisle):
/// middle of the spec's 3.7–4.6 band.
#[allow(dead_code)] // spec 1.1 density sanity, exercised by space_program_derive_is_sane
const DESK_ALLOWANCE_M2: f64 = 4.15;
/// Circulation share added on top of net program area for the m²/person sanity
/// figure (test-fit convention: 25–30%).
#[allow(dead_code)] // spec 1.1 density sanity, exercised by space_program_derive_is_sane
const CIRCULATION_SHARE: f64 = 0.27;

impl SpaceProgram {
    /// Derive the space program for `headcount` people on a plate of
    /// `plate_area_m2`. All counts `ceil` per the spec table:
    ///
    /// | kind        | count            | unit (w×d m)  |
    /// |-------------|------------------|---------------|
    /// | Cabin       | N/25             | 3.0×3.3       |
    /// | Meeting 4P  | N/24             | 2.7×3.3       |
    /// | Meeting 6–8P| N/40             | 3.6×4.2       |
    /// | Boardroom   | 1 if N≥60        | 4.5×6.5       |
    /// | Phone booth | N/25             | 1.3×1.1       |
    /// | Focus       | N/60             | 1.8×2.4       |
    /// | Collab      | ceil(desks/8)/12 settings | 4.8×4.2 |
    /// | Reception   | 1 if N≥20        | 4.0×3.2       |
    /// | Pantry      | 1, max(9, 0.35N) m² | depth 3.0/3.6 |
    /// | Print       | N/50 (open)      | 2.0×1.5       |
    /// | IT/server   | 1                | 3.0×2.4       |
    /// | Storage     | 1                | 3.0×2.0       |
    /// | Wellness    | 1 if N≥50        | 3.0×2.4       |
    ///
    /// LEAN, qbiq-DOMINANT recalibration (spec §1 / docs/reference/qbiq): the
    /// reference Crystal Tower floor is **141 open desks : 7 offices : 12
    /// meeting rooms** on ~1,427 m² — enclosed support is a SMALL minority and
    /// the open field dominates. The pre-lean ratios (booth N/12, focus N/30)
    /// over-roomed a large floor (28 support rooms ate ~40% of the plate, seating
    /// only ~52 desks). Rebalanced toward the reference: **phone booths N/25**
    /// (qbiq shows ~0 dedicated booths; 1/25 keeps a lean call-privacy provision
    /// vs. the old booth sprawl), **focus N/60** (qbiq's mix is offices+meeting,
    /// negligible quiet-rooms — halve), and **collab ÷12** (one open breakout per
    /// ~90 people, not one per 64). Cabins/pantry/reception/IT/storage stay —
    /// they are the essentials qbiq still shows. A hard `SUPPORT_AREA_CAP`
    /// (below) then guarantees the derived support program can never crowd out
    /// the open desk field, whatever the headcount.
    ///
    /// Meeting-seat mix ≈ 50/30/20 small/medium/large by count. The plate cap
    /// (`N ≤ area/7.0`) bounds absurd inputs while still letting a modest
    /// overload surface as a `program_fit` shortfall.
    ///
    /// `open_share` / `cellular_mult` / `support_cap` are the STRATEGY knobs
    /// (M7): Balanced passes `OPEN_SHARE` / `1.0` / `SUPPORT_AREA_CAP` and the
    /// derivation is byte-identical to the pre-M7 table; Open thins enclosure and
    /// grows the desk field, Cellular does the reverse. Cellular families (cabins,
    /// phone booths, focus) scale by `cellular_mult`; the essentials
    /// (pantry/reception/IT/storage) never do.
    pub fn derive(
        headcount: usize,
        plate_area_m2: f64,
        open_share: f64,
        cellular_mult: f64,
        support_cap: f64,
    ) -> SpaceProgram {
        let cap = if plate_area_m2 > 0.0 {
            ((plate_area_m2 / 7.0).floor() as usize).max(1)
        } else {
            usize::MAX
        };
        let n = headcount.min(cap).max(1) as u32;
        let ceil_div = |num: u32, den: u32| num.div_ceil(den);
        let desks = ((n as f64) * open_share).ceil() as u32;
        // Scale a cellular-family count by the strategy multiplier (Balanced 1.0
        // → identity, round-trips the base count exactly).
        let cell = |base: u32| ((base as f64) * cellular_mult).round() as u32;

        let mut reqs = vec![
            SpaceReq { kind: SpaceKind::Cabin, count: cell(ceil_div(n, 25)), w: 3.0, d: 3.3 },
            SpaceReq { kind: SpaceKind::Meeting4P, count: ceil_div(n, 24), w: 2.7, d: 3.3 },
            SpaceReq { kind: SpaceKind::Meeting6P, count: ceil_div(n, 40), w: 3.6, d: 4.2 },
        ];
        if n >= 60 {
            reqs.push(SpaceReq { kind: SpaceKind::Boardroom, count: 1, w: 4.5, d: 6.5 });
        }
        // Phone booths: LEAN 1/25 (was 1/12). qbiq's reference floor carries no
        // dedicated booth band; 1/25 keeps a token call-privacy provision without
        // the ~8-booth sprawl that ate the real 882 m² floor.
        reqs.push(SpaceReq { kind: SpaceKind::PhoneBooth, count: cell(ceil_div(n, 25)), w: 1.3, d: 1.1 });
        // Focus rooms: LEAN 1/60 (was 1/30). The reference mix is offices +
        // meeting with negligible quiet-rooms; halve toward it.
        reqs.push(SpaceReq { kind: SpaceKind::Focus, count: cell(ceil_div(n, 60)), w: 1.8, d: 2.4 });
        // Collab: 1 seat per 8 desks, ~12 seats per open breakout (was 8) — one
        // lean setting per ~90 people rather than a large room per 64.
        let collab_seats = ceil_div(desks, 8);
        reqs.push(SpaceReq {
            kind: SpaceKind::Collab,
            count: ceil_div(collab_seats, 12).max(1),
            w: 4.8,
            d: 4.2,
        });
        if n >= 20 {
            reqs.push(SpaceReq { kind: SpaceKind::Reception, count: 1, w: 4.0, d: 3.2 });
        }
        // Pantry: area max(9, 0.35N), clamped to a placeable footprint.
        let pantry_area = (0.35 * n as f64).max(9.0).min(40.0);
        let pantry_d = if pantry_area > 18.0 { 3.6 } else { 3.0 };
        let pantry_w = snap_module((pantry_area / pantry_d).clamp(3.0, 9.0));
        reqs.push(SpaceReq { kind: SpaceKind::Pantry, count: 1, w: pantry_w, d: pantry_d });
        reqs.push(SpaceReq { kind: SpaceKind::Print, count: ceil_div(n, 50), w: 2.0, d: 1.5 });
        reqs.push(SpaceReq { kind: SpaceKind::ItServer, count: 1, w: 3.0, d: 2.4 });
        reqs.push(SpaceReq { kind: SpaceKind::Storage, count: 1, w: 3.0, d: 2.0 });
        if n >= 50 {
            reqs.push(SpaceReq { kind: SpaceKind::Wellness, count: 1, w: 3.0, d: 2.4 });
        }

        // --- Lean cap: the open desk field ALWAYS keeps the majority ----------
        // qbiq open-plan dominance (spec §1): the DERIVED support program must
        // never claim more than SUPPORT_AREA_CAP of the plate, so the open field
        // stays the majority of usable area on ANY headcount. When an over-set
        // headcount on a modest plate would exceed the cap, trim the most
        // DISCRETIONARY rooms first — phone booths, then focus, then collab, then
        // print — never the essentials (cabins/reception/pantry/IT/storage).
        // Meeting-family rooms are excluded from the sum: they are placed via the
        // `meeting_rooms` override, not the support path (see `support_jobs`).
        let is_support = |k: SpaceKind| {
            !matches!(k, SpaceKind::Meeting | SpaceKind::Meeting4P | SpaceKind::Meeting6P | SpaceKind::Boardroom)
        };
        let support_area = |reqs: &[SpaceReq]| -> f64 {
            reqs.iter().filter(|r| is_support(r.kind)).map(|r| r.area()).sum()
        };
        if plate_area_m2 > 0.0 {
            let cap_area = support_cap * plate_area_m2;
            for trim in [SpaceKind::PhoneBooth, SpaceKind::Focus, SpaceKind::Collab, SpaceKind::Print] {
                while support_area(&reqs) > cap_area {
                    match reqs.iter_mut().find(|r| r.kind == trim && r.count > 0) {
                        Some(r) => r.count -= 1,
                        None => break,
                    }
                }
            }
            reqs.retain(|r| r.count > 0);
        }

        SpaceProgram { headcount: n, desks, reqs }
    }

    /// Sanity figure: estimated m² per person = (desk allowance + net room
    /// area) × (1 + circulation share) / N. The spec's worked N=50 example
    /// lands at ~8.4; BCO/NBC band is 8–12.
    #[allow(dead_code)] // spec 1.1 density sanity metric, exercised by space_program_derive_is_sane
    pub fn area_per_person(&self) -> f64 {
        let rooms: f64 = self.reqs.iter().map(|r| r.area()).sum();
        let net = self.desks as f64 * DESK_ALLOWANCE_M2 + rooms;
        net * (1.0 + CIRCULATION_SHARE) / self.headcount as f64
    }
}

/// Target NIA density (m² per person): BCO 2023 / NBC 2016 design occupancy for
/// general workspace is 10 m²/person; the professional band is 8–12 (spec §1).
/// A plate with no explicit headcount is filled to THIS density so a bare plate
/// lands in the band instead of echoing whatever sparse count the source drawing
/// happened to carry (the field bug: 24 fixed desks on any plate → ~20 m²/person
/// on the real 843 m² building).
const TARGET_M2_PER_PERSON: f64 = 10.0;
/// Open-plan share of the headcount seated at open workstations. Raised to
/// **0.90** (spec default was 0.85) as part of the lean, qbiq-dominant
/// recalibration: the reference Crystal Tower floor runs 141 open / 149 seats ≈
/// **0.95** open share — an office where open desks, not enclosed rooms, are the
/// overwhelming majority. 0.90 moves the derived desk target toward that
/// dominance (so a large plate reaches ~80+ workstations instead of ~52) while
/// still leaving a real 10% of headcount for meeting/collab seats. Drives both
/// `SpaceProgram::derive`'s `desks` and `desk_target` so rooms and desks scale
/// from the SAME headcount (M5 invariant).
const OPEN_SHARE: f64 = 0.90;
/// Ceiling on the DERIVED support program's net area as a fraction of the plate
/// (spec §1 / qbiq open-plan dominance). `SpaceProgram::derive` trims its most
/// discretionary rooms until the enclosed+open support program fits under this,
/// guaranteeing the open desk field keeps the MAJORITY of usable area on any
/// headcount. 0.22 leaves the normal fill (~0.17 at N = area/10) untouched and
/// bites only on an over-set headcount squeezed onto a modest plate.
const SUPPORT_AREA_CAP: f64 = 0.22;

/// The design headcount for a program: explicit `program.headcount`, else the
/// plate filled to the professional density (`plate_area / TARGET_M2_PER_PERSON`)
/// so BOTH the derived room program (`SpaceProgram`) and the desk fill scale to
/// the plate. Plate 0 / unknown (open walls) falls back to the legacy inference
/// from the desk target at the open share, so nothing regresses off-plate.
fn program_headcount(program: &Program, plate_area: f64) -> u32 {
    match program.headcount {
        Some(n) => n.max(1),
        None if plate_area > 0.0 => ((plate_area / TARGET_M2_PER_PERSON).floor() as u32).max(1),
        None => (((program.desks as f64) / program_open_share(program)).ceil() as u32).max(1),
    }
}

/// The desk target that fills the plate to professional density: the greater of
/// the user's explicit `program.desks` (honored as an over-ask, e.g. capacity
/// tests) and the open-plan share of the design headcount. When headcount is
/// unset this is what scales the open field to the plate — the coherent partner
/// of `program_headcount` so the room program and the desk count derive from the
/// SAME headcount (no more 13-office / 27-desk mismatch, spec §1 / M5).
fn desk_target(program: &Program, plate_area: f64) -> u32 {
    let n = program_headcount(program, plate_area);
    let pro = ((n as f64) * program_open_share(program)).ceil() as u32;
    program.desks.max(pro)
}

/// World-axis-aligned extents of a `w`×`h` footprint rotated by `rotation` —
/// the exact AABB (w×h at 0/π, swapped at ±π/2). Obstacle registration must
/// use this, not the raw local dims, now that portrait wings emit ±π/2 desks.
fn world_extents(w: f64, h: f64, rotation: f64) -> (f64, f64) {
    let (s, c) = rotation.sin_cos();
    (w * c.abs() + h * s.abs(), w * s.abs() + h * c.abs())
}

/// The GLOBAL desk lattice for one `generate()` call: origin snapped to the
/// module at the plate bbox min corner (plus the odd-seed half-pitch phase),
/// shared by every region so adjacent wings' rows/columns land on the same
/// lines across their seam. No continuous jitter — seed variety comes from
/// the DISCRETE `SeedChoices` below (spec §4.1: jitter put every coordinate
/// off-module, which is why plans read "broken").
#[derive(Clone, Copy)]
struct Lattice {
    ox: f64,
    oy: f64,
}

/// Discrete structural choices drawn once per `generate()` from the seed rng.
/// Together with the odd-seed half-pitch lattice phase and the seed-rotated
/// meeting round-robin (`allocate_regions`), these give the candidate gallery
/// structurally distinct — yet individually disciplined — layouts.
#[derive(Clone, Copy)]
struct SeedChoices {
    /// Meeting band anchors at the region's FAR end: a landscape wing's
    /// column moves from the right edge to the left; a portrait wing's band
    /// from the bottom edge to the top.
    band_far: bool,
    /// Desks per cluster before an aisle: the program's value or a valid
    /// neighbour (±1, never below 2) — shifts the cross-aisle rhythm.
    cluster_cols: u32,
}

impl SeedChoices {
    fn draw(rng: &mut Rng, program: &Program) -> SeedChoices {
        let base = program.cluster_cols.max(1);
        let cluster_cols = match rng.next_u64() % 3 {
            0 if base > 2 => base - 1,
            2 => base + 1,
            _ => base,
        };
        SeedChoices { band_far: rng.next_u64() & 1 == 1, cluster_cols }
    }
}

/// Tiny inline PRNG — xorshift64* (Marsaglia). Deterministic, no `rand` crate.
/// Used only to draw the discrete `SeedChoices` per `generate()`, so different
/// seeds yield structurally distinct but still-valid candidates.
struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Rng {
        // splitmix-style scramble; force nonzero so xorshift never sticks at 0.
        let s = (seed ^ 0x9E37_79B9_7F4A_7C15) | 1;
        Rng { state: s }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}

fn push_component(doc: &mut Document, category: &str, x: f64, y: f64, w: f64, h: f64, rotation: f64) {
    let id = doc.alloc_id();
    doc.components.push(Component {
        id,
        category: category.to_string(),
        x,
        y,
        w,
        h,
        rotation,
        label: format!("{} {}", category, id),
        product_id: None,
            price_inr: None,
        decision: DecisionState::Open,
    });
}

/// Mirror of `push_component` for zones: mint a shared id and record a tiled
/// floor region. `component_ids` is filled later by `reassign_components`.
fn push_zone(doc: &mut Document, zone_type: ZoneType, shape: ZoneShape, label: &str) {
    let id = doc.alloc_id();
    doc.zones.push(Zone {
        id,
        zone_type,
        shape,
        label: label.to_string(),
        component_ids: Vec::new(),
        group: None,
    });
}

// ---- Enclosed-room emission (M1 of docs/design/testfit-pro-quality.md) ----

/// Generated-partition thickness (m): 100 mm double-boarded drywall — the
/// standard office fit-out partition.
const PARTITION_T: f64 = 0.1;
/// Glazed-front thickness (m): framed office glazing renders thinner than
/// drywall (spec §2 "Glass fronts").
const GLAZING_T: f64 = 0.05;
/// Door leaf width (m): standard office single leaf 900×2100.
const DOOR_W: f64 = 0.9;
/// Door slab depth (m): the component footprint across the wall.
const DOOR_D: f64 = 0.15;
/// Hinge-side jamb offset (m) from the perpendicular wall, so the leaf opens
/// flat against it (spec §2 door convention).
const DOOR_JAMB: f64 = 0.15;
/// Clear ring (m) kept between a room's table and its walls' inner faces.
/// ≥ the 0.9 m accessible route so the circulation evaluator's in-room
/// chokepoints never undercut the corridor target (0.95 leaves raster
/// headroom over the evaluator's 0.15 m cells).
const TABLE_CLEAR: f64 = 0.95;

// ---- M4: drawn circulation (spec §3) ----

/// Primary spine width (m): NBC 2016 corridor minimum 1.5 m; planning guidance
/// 1.5–2.4 m. One straight run per wing along the room band's face.
const SPINE_W: f64 = 1.5;
/// Secondary aisle width (m): IBC corridor 1118 mm — cross-aisles between desk
/// neighborhoods, joining the spine at right angles.
const SECONDARY_W: f64 = 1.15;
/// Facade maintenance gap (m): desks keep this to the window wall instead of a
/// full corridor — the perimeter ring wasted the daylight on corridor; real
/// plans give the window wall to workstations (spec §3 failure (a)).
const FACADE_GAP: f64 = 0.9;
/// Gap (m) between adjacent generated rooms in a band. Two independent 0.1 m
/// partitions 0.1 m apart rasterize as one solid mass on the evaluator's
/// 0.15 m grid, so the sliver can never fragment the walkable floor.
const ROOM_GAP: f64 = 0.1;
/// Gap (m) between a band room's rear and the plate boundary wall (rooms back
/// onto the wall; the old ring put a full corridor behind them).
const BAND_BACK_GAP: f64 = 0.1;
/// Anchor slide step (m) when hunting a clear slot along a band — 3 modules.
/// THE wall-dense-plate fix: instead of one fixed pitch position per room
/// (which real interior walls almost always reject), every room slides along
/// the band edge until a clear anchor appears.
const BAND_STEP: f64 = 0.15;
/// Candidate step (m) of the interior clear-pocket scan for rooms that found
/// no band slot on a wall-dense plate.
const POCKET_STEP: f64 = 0.6;
/// A region counts as a DOMINANT field region — reserved as a PURE open desk
/// field, zero room band (see `allocate_rooms`) — when its area is at least this
/// fraction of the LARGEST region's, so a plate with two comparably large wings
/// reserves BOTH for desks, not just the single biggest.
const FIELD_REGION_FRAC: f64 = 0.6;

// ---- M5: professional scoring (spec §5) ----

/// A workstation this far (m) or nearer to the facade (plate boundary) counts as
/// daylit — matches the report's DAYLIGHT_RADIUS_M so the Rust sub-score and the
/// exported KPI agree on which desks see a window.
const DAYLIGHT_REACH_M: f64 = 5.0;

/// Which side of a generated room faces the corridor its door opens onto —
/// the side that gets the glass front and the door opening. Landscape wings
/// stack rooms against the work rect's RIGHT edge (perimeter/seam corridor to
/// their right); portrait wings band rooms along its BOTTOM edge.
#[derive(Clone, Copy)]
enum CorridorSide {
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
enum RoomFurniture {
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
struct RoomSpec {
    zone_type: ZoneType,
    label: String,
    /// Corridor-facing wall is glazed (solid for booths/IT/storage — spec §2).
    glass_front: bool,
    /// Door leaf width (m); 1.0 for NBC-exit rooms (pantry).
    door_w: f64,
    furniture: RoomFurniture,
}

/// Append one generated wall segment (partition or glass front).
fn push_gen_wall(doc: &mut Document, ax: f64, ay: f64, bx: f64, by: f64, thickness: f64, glazing: bool) {
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
fn emit_room(doc: &mut Document, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide, spec: &RoomSpec) {
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

    furnish_room(doc, cx, cy, w, h, side, spec.furniture);
}

/// Place a room's interior furniture (existing Table/Chair categories only).
/// `side` is the door/front side; furniture faces it, rear pieces back onto
/// the opposite wall. Everything snaps to the module.
fn furnish_room(doc: &mut Document, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide, furniture: RoomFurniture) {
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

/// Axis-aligned overlap test between a candidate footprint (center cx,cy, size
/// w×h) and any obstacle rect, expanded by `pad` on every side.
fn footprint_overlaps(
    obstacles: &[(f64, f64, f64, f64)],
    cx: f64,
    cy: f64,
    w: f64,
    h: f64,
    pad: f64,
) -> bool {
    obstacles.iter().any(|&(ox, oy, ow, oh)| {
        (cx - ox).abs() < (w + ow) / 2.0 + pad && (cy - oy).abs() < (h + oh) / 2.0 + pad
    })
}

/// The **architectural** walls' centerline segments, ready for
/// `geometry::trace_floor_polygon`. Generator-emitted partitions are excluded:
/// the plate is the building envelope, never our own room shells.
fn wall_segments(doc: &Document) -> Vec<(Point, Point)> {
    doc.walls
        .iter()
        .filter(|w| !w.generated)
        .map(|w| (w.a, w.b))
        .collect()
}

/// True when a candidate footprint (center `cx,cy`, size `w`×`h`) is a valid
/// slot on the floor plate: its center lies inside the plate polygon and the
/// whole rect keeps ≥ `margin` clearance to **every** plate edge. Because the
/// rect is connected, "center inside + no edge closer than `margin` > 0" is an
/// exact containment-with-clearance test (the rect cannot cross the boundary
/// without an edge at distance 0) — this is what keeps the perimeter corridor
/// intact around notches of L/U-shaped plates. `plate == None` (open walls, no
/// closed loop) accepts everything: pure bounding-box behavior, as before.
fn slot_fits_plate(plate: Option<&[Point]>, cx: f64, cy: f64, w: f64, h: f64, margin: f64) -> bool {
    let Some(poly) = plate else { return true };
    if !geometry::point_in_polygon(cx, cy, poly) {
        return false;
    }
    (0..poly.len()).all(|i| {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        geometry::rect_segment_dist(cx, cy, w, h, a, b) >= margin - 1e-6
    })
}

/// Clearance (m) kept between a packed footprint and each **face** of an
/// interior wall — the wall acts as a thin obstacle of `thickness + 2×this`.
const WALL_CLEARANCE: f64 = 0.05;
/// A wall whose whole centerline lies within this distance (m) of the plate
/// boundary IS the boundary, not an interior partition.
const INTERIOR_WALL_TOL: f64 = 0.05;

/// Interior partition walls as `(a, b, min_clearance)` obstacle segments.
///
/// A wall is **interior** when any of its five centerline samples (ends,
/// quarters, midpoint) sits farther than `INTERIOR_WALL_TOL` from every
/// boundary segment — the plate polygon's edges when the walls close a loop,
/// else the wall-bbox perimeter (the open-walls fallback, so bbox-edge walls
/// stay non-blocking and the historical behavior is byte-identical).
/// `min_clearance` is half the wall's thickness plus `WALL_CLEARANCE`: a
/// candidate rect must keep at least that distance from the centerline, so no
/// footprint straddles or presses against a partition.
fn interior_walls(
    doc: &Document,
    plate: Option<&[Point]>,
    bbox: (f64, f64, f64, f64),
) -> Vec<(Point, Point, f64)> {
    let boundary: Vec<(Point, Point)> = match plate {
        Some(poly) => (0..poly.len())
            .map(|i| (poly[i], poly[(i + 1) % poly.len()]))
            .collect(),
        None => {
            let (x0, y0, x1, y1) = bbox;
            vec![
                (Point::new(x0, y0), Point::new(x1, y0)),
                (Point::new(x1, y0), Point::new(x1, y1)),
                (Point::new(x1, y1), Point::new(x0, y1)),
                (Point::new(x0, y1), Point::new(x0, y0)),
            ]
        }
    };
    doc.walls
        .iter()
        .filter_map(|w| {
            let on_boundary = (0..=4).all(|k| {
                let t = k as f64 / 4.0;
                let p = Point::new(w.a.x + (w.b.x - w.a.x) * t, w.a.y + (w.b.y - w.a.y) * t);
                boundary
                    .iter()
                    .any(|&(a, b)| geometry::point_segment_dist(p, a, b) <= INTERIOR_WALL_TOL)
            });
            if on_boundary {
                None
            } else {
                Some((w.a, w.b, w.thickness / 2.0 + WALL_CLEARANCE))
            }
        })
        .collect()
}

/// True when the candidate footprint keeps every interior wall at least its
/// required clearance away. Exact for any wall angle (`rect_segment_dist`), so
/// no footprint can straddle a partition — the packer's wall-blocking test.
fn slot_clears_walls(walls: &[(Point, Point, f64)], cx: f64, cy: f64, w: f64, h: f64) -> bool {
    walls
        .iter()
        .all(|&(a, b, m)| geometry::rect_segment_dist(cx, cy, w, h, a, b) >= m - 1e-9)
}

/// Raster cell size (m) for plate decomposition — 0.5 m keeps the grid at a few
/// thousand cells (trivial cost) while resolving real wing geometry.
const REGION_CELL: f64 = 0.5;
/// A decomposition region must be at least this wide/tall (m) — narrower slivers
/// can't usefully hold a corridor-inset desk row, so they're discarded.
const REGION_MIN_DIM: f64 = 3.0;
/// …and at least this many m² — below this a region is noise, not a wing.
const REGION_MIN_AREA: f64 = 9.0;

/// Below this plate area (m²) a SINGLE (rectangular) plate reserves its desk field
/// from overflow rooms (see the pocket note in `plan_region`). The dead-zone bug
/// starved plates up to ~140 m² to ZERO desks because the fixed default program's
/// overflow rooms poisoned the field; a ~180 m² gate covers that zone with margin
/// while leaving the density-calibrated mid/large plates (≥ ~216 m²) exactly as
/// they were — those already seat a healthy field and host their overflow rooms in
/// a legitimate second band row rather than in the workstations.
const SMALL_PLATE_FIELD_AREA: f64 = 180.0;

/// One region edge: how far the desk field insets from it, and whether it is a
/// SEAM shared with an adjacent region (half-corridor each side, forming ONE
/// shared corridor) or a plate-boundary/facade edge (0.9 m maintenance gap —
/// the window wall belongs to workstations, spec §3).
#[derive(Clone, Copy)]
struct Edge {
    inset: f64,
    seam: bool,
}

/// Per-edge insets for one region.
#[derive(Clone, Copy)]
struct Insets {
    left: Edge,
    right: Edge,
    top: Edge,
    bottom: Edge,
}

impl Insets {
    /// All four edges are plate boundary (single-region / rectangular path).
    fn boundary() -> Self {
        let e = Edge { inset: FACADE_GAP, seam: false };
        Insets { left: e, right: e, top: e, bottom: e }
    }
}

/// Minimum shared-edge overlap (m) for two regions to count as adjacent — below
/// this a mere corner-touch shouldn't halve a whole edge's corridor.
const SEAM_MIN_OVERLAP: f64 = 1.0;

/// Compute region `idx`'s per-edge insets: an edge becomes a seam (inset
/// `corridor/2`, the two neighbours' halves meeting as ONE shared corridor)
/// when another region abuts it co-linearly with ≥ `SEAM_MIN_OVERLAP` overlap;
/// otherwise it is plate boundary with the facade gap.
fn region_insets(regions: &[geometry::Rect], idx: usize, corridor: f64) -> Insets {
    let r = &regions[idx];
    let seam = Edge { inset: corridor / 2.0, seam: true };
    let eps = 1e-3;
    let mut ins = Insets::boundary();
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

/// Deterministically generate a test-fit into `doc` for `program`, seeded by `seed`.
///
/// Walls are preserved. When `keep_confirmed` is true, components left `Confirmed`
/// are **frozen** — kept in place and treated as obstacles so newly-placed items
/// pack around them (Laiout-style Freeze/Regenerate, design §4). When false, all
/// components are cleared for a fresh fit. Frozen items count toward the program
/// targets, so regenerating tops the plan up to the requested counts.
///
/// Layout regime (M3+M4, docs/design/testfit-pro-quality.md §1/§3): a
/// non-rectangular plate is decomposed into rectangular regions (wings); a
/// rectangular plate is one region. Every region gets a ROOM BAND backed onto
/// one long edge, a PRIMARY SPINE (1.5 m **drawn** `Circulation` rect, NBC
/// corridor minimum) along the band's face that every room front and door
/// opens onto, and a DESK FIELD on the facade side holding a 0.9 m maintenance
/// gap to the window wall — the old perimeter `RectRing` (which spent the
/// daylight on corridor) is retired. `Document::entries` anchors the network:
/// the entry region gets a connector strip from the entry to its spine, and
/// reception is the first room sliding in from the entry end.
///
/// Rooms = the user's `meeting_rooms` override + (when `support_spaces`) the
/// support program derived from the headcount (spec §1.1). Placement is robust
/// on wall-dense plates: anchors SLIDE along the band in 0.15 m steps, rooms
/// that find no band slot fall back to interior clear pockets (both
/// orientations), and any remaining shortfall is reported honestly through
/// `LayoutScore::program_fit` rather than silently dropped.
pub fn generate(doc: &mut Document, program: &Program, seed: u64, keep_confirmed: bool) {
    // Generated walls (room partitions/glass fronts) are OUTPUT of a previous
    // run: clear them FIRST — and only them, never user-drawn/imported walls —
    // so the plate trace, wall bbox and interior-wall snapshot below see the
    // building envelope, not our own shells. Regeneration is thereby
    // idempotent (verified by `regenerate_replaces_generated_walls…`).
    doc.walls.retain(|w| !w.generated);

    // Snap the program's generator dimensions to the module ONCE, so every
    // pitch and anchor derived from them lands on module lines (§4.1). The
    // UI defaults are already module-aligned; this guards imported programs.
    let program = &{
        let mut p = program.clone();
        p.desk_w = snap_module(p.desk_w);
        p.desk_h = snap_module(p.desk_h);
        p.meeting_w = snap_module(p.meeting_w);
        p.meeting_h = snap_module(p.meeting_h);
        p.target_corridor_m = snap_module(p.target_corridor_m.max(0.0));
        p.desk_clearance_m = snap_module(p.desk_clearance_m.max(0.0));
        p
    };
    // Keep-outs are PERMANENT hard obstacles (the building core: stairs/lifts/
    // shafts/WCs) — always avoided regardless of `keep_confirmed`. They lead the
    // obstacle list so they sit before `frozen_len` (meetings reject slots over
    // them) and before every desk `grid_start` (the full-clearance regime keeps
    // furniture a real aisle away). Held as corner-origin holes for the plate
    // decomposition too, so no region ever spans the core.
    let holes: Vec<geometry::Rect> = doc
        .keepouts
        .iter()
        .map(|k| geometry::Rect {
            x0: k.x - k.w / 2.0,
            y0: k.y - k.h / 2.0,
            x1: k.x + k.w / 2.0,
            y1: k.y + k.h / 2.0,
        })
        .collect();
    // Center + label snapshot for the Core zones emitted at the end (taken now,
    // before `doc` is mutated further).
    let keepout_zones: Vec<(f64, f64, f64, f64, String)> = doc
        .keepouts
        .iter()
        .map(|k| (k.x, k.y, k.w, k.h, k.label.clone()))
        .collect();

    // Freeze: keep Confirmed components, drop the rest. Keep-outs + frozen
    // footprints become obstacles the new placement must avoid.
    let mut obstacles: Vec<(f64, f64, f64, f64)> = Vec::new();
    for k in &doc.keepouts {
        obstacles.push((k.x, k.y, k.w, k.h));
    }
    // Rooms treat keep-outs as abuttable architecture (0.05 m pad) but frozen
    // FURNITURE as needing a full person-clearance — the boundary index between
    // the two obstacle classes.
    let keepout_len = obstacles.len();
    if keep_confirmed {
        doc.components.retain(|c| c.decision == DecisionState::Confirmed);
        for c in &doc.components {
            // World AABB, not local dims — a frozen portrait desk is ±π/2.
            let (ww, wh) = world_extents(c.w, c.h, c.rotation);
            obstacles.push((c.x, c.y, ww, wh));
        }
    } else {
        doc.components.clear();
    }
    // Zones are regenerated wholesale each call (like components), including under
    // keep_confirmed — frozen components are simply re-bucketed into the new zones.
    doc.zones.clear();
    doc.selection = None;
    // Only keep-outs + frozen footprints block new placement. Items placed in
    // this call are laid out on non-overlapping pitches by construction, so they
    // must NOT be checked against each other (their spacing == the overlap
    // threshold, which floating-point rounding would otherwise flag as a collision).
    let frozen_len = obstacles.len();

    let (min_x, min_y, max_x, max_y) = match doc.wall_bbox() {
        Some(b) => b,
        None => return, // no boundary → nothing to place
    };

    // The floor-plate polygon: the largest closed loop through the walls. For a
    // rectangular room it equals the bbox. `None` (open walls) keeps the
    // historical bbox-only behavior.
    let plate = geometry::trace_floor_polygon(&wall_segments(doc), geometry::LOOP_SNAP_TOL);

    // Interior partitions (imported linework, committed CAD sketches) are hard
    // obstacles: nothing may straddle them. Boundary walls are excluded — the
    // plate/corridor inset already handles them. Per-candidate rejection (not
    // decomposition holes) is the v1: exact for diagonal walls, and it applies
    // on the rectangular single-region path too, which never decomposes.
    let iwalls = interior_walls(doc, plate.as_deref(), (min_x, min_y, max_x, max_y));

    let corridor = program.target_corridor_m.max(0.0);
    let clear = program.desk_clearance_m.max(0.0);

    // Frozen items already count toward the program targets, so we only place
    // the remainder. These global counters also number Meeting-Room zone labels.
    // ("MeetingRoom" components are now only legacy frozen pods from pre-M1
    // documents or user-placed catalog pods — generated rooms are walls + zone
    // + Door + Table — but they still count toward the meeting target so old
    // frozen plans don't over-place.)
    let mr_counter = doc.components.iter().filter(|c| c.category == "MeetingRoom").count() as u32;
    let frozen_desks = doc.components.iter().filter(|c| c.category == "Desk").count() as u32;
    let remaining_meetings = program.meeting_rooms.saturating_sub(mr_counter);

    // Regions: only a materially non-rectangular plate is decomposed; a
    // rectangular plate (or open walls) is ONE region. A region must survive
    // its insets with room for at least one desk — 3 m slivers pass a fixed
    // minimum but pack nothing, stealing desk allocation from real wings.
    let bbox_area = (max_x - min_x) * (max_y - min_y);
    let plate_area = plate
        .as_deref()
        .map(geometry::polygon_area)
        .unwrap_or(bbox_area);
    // Desk target scales to the plate at professional density (spec §1): fill
    // the open field to `desk_target` desks, the open-plan share of the design
    // headcount, so a bare plate lands in the 8–12 m²/person band instead of
    // echoing a fixed 24-desk count on any plate size (the field bug).
    let remaining_desks = desk_target(program, plate_area).saturating_sub(frozen_desks);
    let min_dim = REGION_MIN_DIM.max(2.0 * corridor + program.desk_w.min(program.desk_h));
    let mut regions = match &plate {
        Some(poly) if geometry::polygon_area(poly) < 0.98 * bbox_area => {
            geometry::decompose_plate(poly, REGION_CELL, min_dim, REGION_MIN_AREA, &holes)
        }
        _ => Vec::new(),
    };
    let single_region = regions.is_empty();
    if single_region {
        regions.push(geometry::Rect { x0: min_x, y0: min_y, x1: max_x, y1: max_y });
    }
    // Dominant wing(s) reserved for the open desk field (spec §1: desks are the
    // MAJORITY use): they get a shallow room band and a band-only room pocket so
    // no deep support room deepens their long band or fragments their field. Only
    // when the plate has MORE THAN ONE region — a single (rectangular) plate must
    // host the whole program in its one band.
    let field_regions: Vec<bool> = {
        let max_area = regions.iter().map(|r| r.area()).fold(0.0f64, f64::max);
        regions
            .iter()
            .map(|r| regions.len() > 1 && r.area() >= FIELD_REGION_FRAC * max_area)
            .collect()
    };
    // Per-region insets: 0.9 m facade gap on plate-boundary edges (desks get
    // the window wall), corridor/2 on seams shared with an adjacent region so
    // neighbours form ONE shared corridor.
    let insets: Vec<Insets> = if single_region {
        vec![Insets::boundary()]
    } else {
        (0..regions.len())
            .map(|i| region_insets(&regions, i, corridor))
            .collect()
    };

    // ONE global desk lattice per generate(): origin = plate bbox min corner,
    // snapped to the module, shared by EVERY region so adjacent wings' rows/
    // columns land on the same lines across their seam. Odd seeds shift the
    // whole lattice by half a pitch — one of the DISCRETE seed choices that
    // replaced the old continuous jitter (which shifted the lattice up to
    // ~0.22 m off any structural line — spec §4.1 / gap #6).
    let mut rng = Rng::new(seed);
    let choices = SeedChoices::draw(&mut rng, program);
    let half_phase = if seed % 2 == 1 { 0.5 } else { 0.0 };
    let lat = Lattice {
        ox: snap_module(min_x + half_phase * (program.desk_w + clear)),
        oy: snap_module(min_y + half_phase * (program.desk_h + clear)),
    };

    // --- Rooms: explicit builder program, or meeting override + derived ----
    let entry = doc.entries.first().copied();
    // Detailed builder: `program.rooms` REPLACES the derived room program +
    // meeting override (workflow.md §3.4). Desks still scale to the plate.
    // Empty → today's derive path, byte-identical.
    let mut jobs: Vec<RoomJob> = if !program.rooms.is_empty() {
        explicit_jobs(program)
    } else {
        let mut jobs: Vec<RoomJob> = Vec::new();
        let support = support_jobs(program, plate_area);
        let take = |jobs: &mut Vec<RoomJob>, kind: SpaceKind| {
            jobs.extend(support.iter().filter(|j| j.kind == kind).cloned());
        };
        // Priority order = placement order: reception first (entry-adjacent),
        // then the big rooms while band space is plentiful, small/distributed
        // last. Focus rooms are lifted ahead of the bulk support set: they are
        // facade-PINNED (item 4a), so they must claim a daylit band slot before
        // the frontage is spent — otherwise, being small and late, they overflow
        // into interior pockets, AWAY from the window the hard rule requires.
        take(&mut jobs, SpaceKind::Reception);
        for k in 0..remaining_meetings {
            let t = job_template(SpaceKind::Meeting, program);
            jobs.push(t.to_job(
                SpaceKind::Meeting,
                format!("Meeting Room {}", mr_counter + k + 1),
                program.meeting_w,
                program.meeting_h,
                Placement::Flexible,
            ));
        }
        take(&mut jobs, SpaceKind::Focus);
        for kind in [
            SpaceKind::Cabin,
            SpaceKind::Collab,
            SpaceKind::Pantry,
            SpaceKind::ItServer,
            SpaceKind::Storage,
            SpaceKind::Wellness,
            SpaceKind::Print,
            SpaceKind::PhoneBooth,
        ] {
            take(&mut jobs, kind);
        }
        jobs
    };

    // --- Anchored rooms (workflow.md §3.5): each pinned room is placed FIRST at
    // (near) its point and CONSUMES one of its kind's count. Removing one free
    // job per anchor makes the effective total `max(requested, anchored)`: an
    // anchor beyond the free supply nets a new room ("bumps the count"); an
    // anchor within it re-pins an already-requested room (no net change). Cloned
    // up front so Pass 0 can mutate `doc` freely.
    let anchored: Vec<(RoomJob, f64, f64)> = anchor_jobs(program, &doc.anchors);
    for (aj, _, _) in &anchored {
        if let Some(pos) = jobs.iter().position(|j| j.kind == aj.kind) {
            jobs.remove(pos);
        }
    }

    let entry_idx = entry_region_idx(&regions, entry);
    // A band may only claim depth that still leaves one desk row in front.
    let min_field_d = program.desk_w.min(program.desk_h) + clear;
    let (mut region_jobs, band_depths, mut overflow) =
        allocate_rooms(jobs, &regions, &insets, entry_idx, entry.is_some(), min_field_d, &field_regions);

    // --- Region plans: band + spine + connector + link geometry -----------
    let plans: Vec<RegionPlan> = (0..regions.len())
        .map(|i| {
            plan_region(
                regions[i],
                insets[i],
                regions[i].height() > regions[i].width(),
                choices.band_far,
                band_depths[i],
                if i == entry_idx { entry } else { None },
                field_regions[i],
                single_region && plate_area < SMALL_PLATE_FIELD_AREA,
            )
        })
        .collect();

    // Full-size circulation rects: rooms must not intrude on them, and pocket
    // rooms orient their door toward the nearest one.
    let circ_rects: Vec<geometry::Rect> = plans
        .iter()
        .flat_map(|p| [p.spine, p.connector, p.link])
        .flatten()
        .collect();
    // Desk-effective obstacles for the strips that cross the desk field
    // (connector/link): shrunk so the full-clearance pad rejects desks only
    // ~0.1 m from the strip edge instead of wasting a whole extra aisle.
    let shrink = (clear - 0.1).max(0.0);
    for p in &plans {
        for r in [p.connector, p.link].into_iter().flatten() {
            obstacles.push((
                (r.x0 + r.x1) / 2.0,
                (r.y0 + r.y1) / 2.0,
                (r.width() - 2.0 * shrink).max(0.05),
                (r.height() - 2.0 * shrink).max(0.05),
            ));
        }
    }

    // --- Pass 0: anchored rooms land FIRST at (near) their pinned point ------
    // Placed before the free band/pocket program so every later placement packs
    // AROUND them (each becomes an obstacle). The exact pin wins when it fits;
    // otherwise the nearest feasible slot on the plate is taken and the room is
    // still emitted — a truly infeasible pin (tiny plate) drops and surfaces as
    // a `program_fit` shortfall, never silently.
    for (job, tx, ty) in &anchored {
        place_anchor(
            doc, job, *tx, *ty, (min_x, min_y, max_x, max_y), plate.as_deref(),
            &iwalls, &mut obstacles, keepout_len, frozen_len, &circ_rects, clear,
        );
    }

    // --- Pass A: rooms slide into each region's band ------------------------
    for (i, plan) in plans.iter().enumerate() {
        let mut cursors = (plan.a0, plan.a1);
        for job in region_jobs[i].drain(..) {
            let placed = place_in_band(
                doc, plan, &job, &mut cursors, plate.as_deref(), &iwalls,
                &mut obstacles, keepout_len, frozen_len, &circ_rects, clear,
            );
            if !placed {
                overflow.push(job);
            }
        }
    }
    // --- Pass B: leftover rooms hunt interior clear pockets (both
    // orientations, nearest-to-circulation candidate wins). A room that fits
    // nowhere is a shortfall `program_fit` reports — never a silent drop.
    for job in overflow {
        place_in_pocket(
            doc, &plans, &job, plate.as_deref(), &iwalls, &mut obstacles,
            keepout_len, frozen_len, &circ_rects, clear,
        );
    }

    // --- Drawn circulation zones (spine / entry connector / link / seams) --
    for plan in &plans {
        emit_plan_zones(doc, plan);
    }

    // --- Pass C: desk fields on the global lattice -------------------------
    let d_alloc = allocate_desks(program, &plans, clear, remaining_desks);
    let mut placed_desks = 0u32;
    for (i, plan) in plans.iter().enumerate() {
        let region_no = if single_region { None } else { Some((i + 1) as u32) };
        placed_desks += pack_desks(
            doc, program, plan, d_alloc[i], region_no, /*emit_zones=*/ true,
            plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices,
        );
    }
    // --- Top-up pass: reclaim allocation lost to rooms/geometry. Smallest
    // wings first: the proportional allocation already loaded the big regions.
    // SAME global lattice → top-up slots either coincide with occupied lines
    // (rejected) or fill genuinely free ones in perfect row alignment.
    let mut shortfall = remaining_desks.saturating_sub(placed_desks);
    if shortfall > 0 {
        for (i, plan) in plans.iter().enumerate().rev() {
            if shortfall == 0 {
                break;
            }
            let region_no = if single_region { None } else { Some((i + 1) as u32) };
            let got = pack_desks(
                doc, program, plan, shortfall, region_no, /*emit_zones=*/ false,
                plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices,
            );
            shortfall = shortfall.saturating_sub(got);
        }
    }

    // Keep-outs surface as `Core` zones (gray tint, Core cost/NIA rate). Emitted
    // last so a point inside a keep-out buckets to Core, winning the
    // last-non-Circulation-wins tie over any overlapping Workspace rect.
    for (kx, ky, kw, kh, label) in &keepout_zones {
        push_zone(
            doc,
            ZoneType::Core,
            ZoneShape::Rect { x: *kx, y: *ky, w: *kw, h: *kh },
            label,
        );
    }

    // Fill each zone's component_ids by point-in-zone on component centers.
    doc.reassign_components();
}

// ---- Room jobs: the concrete rooms one generate() call tries to place ----

/// One room instance to place. `w` runs along the corridor front, `d` is the
/// depth away from it (a portrait band transposes both into world axes).
#[derive(Clone, Debug)]
struct RoomJob {
    kind: SpaceKind,
    /// Zone label, unique per instance ("Meeting Room 2", "Phone Booth 3") —
    /// `score()` counts delivered rooms by these exact labels.
    label: String,
    w: f64,
    d: f64,
    zone_type: ZoneType,
    glass_front: bool,
    door_w: f64,
    furniture: RoomFurniture,
    /// false → open setting (collab / print alcove): zone + furniture, no
    /// partitions and no door — spec §1.1 marks them open.
    walls: bool,
    /// Slide in from the band end FAR from the entry (pantry = social anchor
    /// at the far end of the spine; storage/IT/wellness/focus = quiet end;
    /// booths distributed away from reception).
    far: bool,
    /// Facade preference (explicit rooms only; derived rooms are `Flexible`).
    /// Biases region choice and within-band ordering — see `allocate_rooms`.
    placement: Placement,
}

/// Facade preference for a DERIVED support room. Focus rooms are pinned to the
/// facade via `Window` (item 4a: a HARD daylight/placement rule — Window biases
/// both the wing chosen and the within-band slot toward the plate boundary — on
/// top of the rear-alignment in `place_in_band` that seats them ON the facade
/// wall). Every other derived room stays placement-neutral (`Flexible`) so the
/// derive path is byte-identical apart from focus.
fn derived_placement(kind: SpaceKind) -> Placement {
    match kind {
        SpaceKind::Focus => Placement::Window,
        _ => Placement::Flexible,
    }
}

/// Expand the derived support program into placeable room jobs (spec §1.1).
///
/// Zone-type mapping (spec asks for a justified choice): cabins, phone booths
/// and focus rooms are cellular offices → `ClosedOffice`; pantry, reception,
/// print, IT/server, storage and wellness are tenant amenity/support program —
/// NOT building core, which stays reserved for landlord keep-outs (stairs,
/// lifts, shafts) so the Core stats keep meaning "non-lettable" → `Amenity`;
/// collab settings are open breakout → `Collaboration`. Meeting-typed kinds
/// (4P/6–8P/board) are covered by the user's `meeting_rooms` override and are
/// not duplicated here.
fn support_jobs(program: &Program, plate_area: f64) -> Vec<RoomJob> {
    if !program.support_spaces {
        return Vec::new();
    }
    let sp = SpaceProgram::derive(
        program_headcount(program, plate_area) as usize,
        plate_area,
        program_open_share(program),
        program_cellular_mult(program),
        program_support_cap(program),
    );
    let mut jobs = Vec::new();
    for req in &sp.reqs {
        // Meeting-typed kinds are covered by the `meeting_rooms` override in
        // the derive path and are not duplicated in the support program.
        if matches!(
            req.kind,
            SpaceKind::Meeting | SpaceKind::Meeting4P | SpaceKind::Meeting6P | SpaceKind::Boardroom
        ) {
            continue;
        }
        let t = job_template(req.kind, program);
        for i in 0..req.count {
            let label = if req.count == 1 {
                t.name.to_string()
            } else {
                format!("{} {}", t.name, i + 1)
            };
            // Derived rooms carry their derive() footprint. Focus rooms are pinned
            // to the facade (`Window`) — item 4a's HARD daylight rule; the rest stay
            // placement-neutral (`Flexible`), so the derive path is otherwise unchanged.
            jobs.push(t.to_job(req.kind, label, snap_module(req.w), snap_module(req.d), derived_placement(req.kind)));
        }
    }
    jobs
}

/// The per-kind room recipe: zone type, display name, glass/door/furniture
/// flags, whether it is a walled enclosure, which band end it prefers, and its
/// DEFAULT footprint (corridor-run `w` × depth `d`). Shared by the derived
/// program (`support_jobs`, which supplies its own derive() sizes) and the
/// explicit builder (`explicit_jobs`, which uses the default sizes unless the
/// `RoomReq` overrides them) so the two paths can never drift (no-bloat).
struct JobTemplate {
    zone_type: ZoneType,
    name: &'static str,
    glass_front: bool,
    door_w: f64,
    furniture: RoomFurniture,
    walls: bool,
    far: bool,
    w: f64,
    d: f64,
}

impl JobTemplate {
    fn to_job(&self, kind: SpaceKind, label: String, w: f64, d: f64, placement: Placement) -> RoomJob {
        RoomJob {
            kind,
            label,
            w,
            d,
            zone_type: self.zone_type,
            glass_front: self.glass_front,
            door_w: self.door_w,
            furniture: self.furniture,
            walls: self.walls,
            far: self.far,
            placement,
        }
    }
}

/// Recipe + default footprint for one `SpaceKind`. Meeting-family kinds use the
/// user's `meeting_w`/`meeting_h`; everything else mirrors `SpaceProgram::derive`.
fn job_template(kind: SpaceKind, program: &Program) -> JobTemplate {
    use RoomFurniture::*;
    use SpaceKind::*;
    let (zone_type, name, glass_front, door_w, furniture, walls, far, w, d) = match kind {
        Meeting => (ZoneType::Meeting, "Meeting Room", true, DOOR_W, ConferenceTable, true, false, program.meeting_w, program.meeting_h),
        Meeting4P => (ZoneType::Meeting, "Team Room", true, DOOR_W, ConferenceTable, true, false, 2.7, 3.3),
        Meeting6P => (ZoneType::Meeting, "Team Room", true, DOOR_W, ConferenceTable, true, false, 3.6, 4.2),
        Boardroom => (ZoneType::Meeting, "Boardroom", true, DOOR_W, ConferenceTable, true, false, 4.5, 6.5),
        Cabin => (ZoneType::ClosedOffice, "Cabin", true, DOOR_W, WorkPoint, true, false, 3.0, 3.3),
        // Booths: solid fronts (spec §2), narrow leaf for the 1.3 m run.
        PhoneBooth => (ZoneType::ClosedOffice, "Phone Booth", false, 0.8, WorkPoint, true, true, 1.3, 1.1),
        Focus => (ZoneType::ClosedOffice, "Focus Room", true, DOOR_W, WorkPoint, true, true, 1.8, 2.4),
        Collab => (ZoneType::Collaboration, "Collab", false, 0.0, ConferenceTable, false, false, 4.8, 4.2),
        // Reception/pantry doors at 1.0 m (NBC exit-leaf rooms, spec §2).
        Reception => (ZoneType::Amenity, "Reception", true, 1.0, ReceptionDesk, true, false, 4.0, 3.2),
        Pantry => (ZoneType::Amenity, "Pantry", false, 1.0, Counter, true, true, 3.6, 3.0),
        Print => (ZoneType::Amenity, "Print Point", false, 0.0, ConferenceTable, false, false, 2.0, 1.5),
        ItServer => (ZoneType::Amenity, "IT / Server", false, DOOR_W, Empty, true, true, 3.0, 2.4),
        Storage => (ZoneType::Amenity, "Storage", false, DOOR_W, Empty, true, true, 3.0, 2.0),
        Wellness => (ZoneType::Amenity, "Wellness Room", false, DOOR_W, Empty, true, true, 3.0, 2.4),
    };
    JobTemplate { zone_type, name, glass_front, door_w, furniture, walls, far, w, d }
}

/// Expand `Program.rooms` (the Detailed builder) into placeable jobs. Sizes come
/// from each request (falling back to the kind default), placement bias rides
/// through to `allocate_rooms`. Ordered reception-first then largest-first so big
/// rooms claim band space while it is plentiful — the same priority the derived
/// path uses.
fn explicit_jobs(program: &Program) -> Vec<RoomJob> {
    let mut jobs = Vec::new();
    for req in &program.rooms {
        let t = job_template(req.kind, program);
        let w = snap_module(req.w.unwrap_or(t.w).max(0.5));
        let d = snap_module(req.d.unwrap_or(t.d).max(0.5));
        for i in 0..req.count {
            let label = if req.count == 1 {
                t.name.to_string()
            } else {
                format!("{} {}", t.name, i + 1)
            };
            jobs.push(t.to_job(req.kind, label, w, d, req.placement));
        }
    }
    // Reception first (entry-adjacent), then largest footprint first.
    jobs.sort_by(|a, b| {
        let key = |j: &RoomJob| (j.kind != SpaceKind::Reception, -(j.w * j.d));
        key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    jobs
}

/// One pinned `RoomJob` per anchor (workflow.md §3.5), carrying its target point.
/// Each uses the kind's DEFAULT footprint from `job_template` (an anchor picks a
/// kind, not a size) and a distinct `(pinned N)` label so `score()` counts it as
/// a delivered room. Placement-neutral (`Flexible`): the pin *is* the placement.
fn anchor_jobs(program: &Program, anchors: &[crate::document::Anchor]) -> Vec<(RoomJob, f64, f64)> {
    anchors
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let t = job_template(a.kind, program);
            let job = t.to_job(
                a.kind,
                format!("{} (pinned {})", t.name, i + 1),
                snap_module(t.w.max(0.5)),
                snap_module(t.d.max(0.5)),
                Placement::Flexible,
            );
            (job, a.x, a.y)
        })
        .collect()
}

/// The region an entry point anchors: nearest region rect (0 with no entry —
/// the largest region, since decomposition returns area-desc).
fn entry_region_idx(regions: &[geometry::Rect], entry: Option<Point>) -> usize {
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
fn region_facade_len(r: &geometry::Rect, ins: &Insets) -> f64 {
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
fn placement_rank(p: Placement) -> u8 {
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
fn allocate_rooms(
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
    // The old shallow-band cap (`FIELD_REGION_BAND_D`, one room deep) still ran a
    // room band the full length of the biggest wing — on the real 462 m² wing
    // that band + its 1.5 m spine (≈4.8 m of a 12.5 m cross-section, across the
    // whole 37 m length) held ~9–11 rooms and cost the field ~20 desks. With
    // `cap_d = 0` the band-pass fit check (`0.7·d ≤ cap_d`) rejects every room
    // for these wings, `band_depths` stays 0, and `plan_region` emits no band and
    // no spine — the whole inset rect packs desks. Rooms concentrate in the
    // smaller wings instead (they lead the smallest-first `order`); a room that
    // fits in no room-wing overflows to the pocket pass, whose field-region
    // pocket is the now-empty band strip (zero width → never placed there), so
    // overflow can never leak back into a reserved desk wing. `field_regions`
    // already excludes the single-region case (that plate hosts every room in
    // its one band).
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
/// grid capacity, clamped to it — regions too small for a single desk get zero.
fn allocate_desks(program: &Program, plans: &[RegionPlan], clear: f64, desks: u32) -> Vec<u32> {
    let n = plans.len();
    let mut desk_cap = vec![0u32; n];
    for (i, plan) in plans.iter().enumerate() {
        let iw = plan.field.width();
        let ih = plan.field.height();
        // Capacity in the orientation the packer will actually use: a portrait
        // region rotates desks ±π/2, so its world footprint swaps w/h.
        let (dw, dh) = if plan.portrait {
            (program.desk_h, program.desk_w)
        } else {
            (program.desk_w, program.desk_h)
        };
        let (pitch_x, pitch_y) = (dw + clear, dh + clear);
        if iw >= dw && ih >= dh && pitch_x > 0.0 && pitch_y > 0.0 {
            let cols = (((iw + clear) / pitch_x).floor() as i64).max(0);
            let rows = (((ih + clear) / pitch_y).floor() as i64).max(0);
            desk_cap[i] = (cols * rows) as u32;
        }
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
    }
    d_alloc
}

/// Geometry plan of one region (wing): where its room band, primary spine,
/// entry connector, cross link and desk field sit. All circulation is explicit
/// **drawn** rect geometry — the perimeter `RectRing` regime is retired
/// (spec §3; the type stays in `zone.rs` for old snapshots).
struct RegionPlan {
    /// long axis is Y: the band is a vertical strip, the spine vertical.
    portrait: bool,
    /// band on the high edge (top / right) instead of the low one.
    band_far: bool,
    /// slide "near" jobs from the `a1` end (the entry sits nearer that end).
    rev: bool,
    /// along-axis (long-axis) span of the band / spine / field.
    a0: f64,
    a1: f64,
    /// rooms' rear line (cross axis).
    band_base: f64,
    /// rooms' front line — the spine edge ALL room fronts align to, so the
    /// corridor face is one unbroken line (spec §4.3).
    band_front: f64,
    /// primary spine (1.5 m), `None` when the region is too shallow for one.
    spine: Option<geometry::Rect>,
    /// entry → spine connector strip, when the entry anchors in this region.
    connector: Option<geometry::Rect>,
    /// secondary strip joining the spine to a far-side seam corridor, so the
    /// drawn network is connected across regions by construction.
    link: Option<geometry::Rect>,
    /// desk-field rect (may be degenerate on a room-only wing).
    field: geometry::Rect,
    /// the region's whole placeable cross-section — the pocket-scan area.
    pocket: geometry::Rect,
    /// seam-strip corridors along edges shared with a neighbour region.
    seams: Vec<geometry::Rect>,
}

/// Compute one region's `RegionPlan`. The cross-axis stack reads
/// band (rooms, backed `BAND_BACK_GAP` onto the boundary wall) → spine →
/// desk field → facade gap; `band_far` mirrors it. Deterministic.
fn plan_region(
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
    let pocket = if field_region || reserve_field {
        if !band_far {
            rect(a0, a1, c0 + e_lo.inset, band_front.max(c0 + e_lo.inset))
        } else {
            rect(a0, a1, band_front.min(c1 - e_hi.inset), c1 - e_hi.inset)
        }
    } else if !band_far {
        rect(a0, a1, band_base, c1 - e_hi.inset)
    } else {
        rect(a0, a1, c0 + e_lo.inset, band_base)
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
    // neighbour emits the other half — together exactly ONE corridor).
    let mut seams = Vec::new();
    if ins.left.seam {
        seams.push(geometry::Rect { x0: outer.x0, y0: outer.y0, x1: outer.x0 + ins.left.inset, y1: outer.y1 });
    }
    if ins.right.seam {
        seams.push(geometry::Rect { x0: outer.x1 - ins.right.inset, y0: outer.y0, x1: outer.x1, y1: outer.y1 });
    }
    if ins.bottom.seam {
        seams.push(geometry::Rect { x0: outer.x0, y0: outer.y0, x1: outer.x1, y1: outer.y0 + ins.bottom.inset });
    }
    if ins.top.seam {
        seams.push(geometry::Rect { x0: outer.x0, y0: outer.y1 - ins.top.inset, x1: outer.x1, y1: outer.y1 });
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
fn emit_plan_zones(doc: &mut Document, plan: &RegionPlan) {
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

/// Gap (m) between a center-based rect and a corner-based `geometry::Rect`
/// (0 when they touch or overlap).
fn rect_gap(cx: f64, cy: f64, w: f64, h: f64, r: &geometry::Rect) -> f64 {
    let dx = (r.x0 - (cx + w / 2.0)).max((cx - w / 2.0) - r.x1).max(0.0);
    let dy = (r.y0 - (cy + h / 2.0)).max((cy - h / 2.0) - r.y1).max(0.0);
    (dx * dx + dy * dy).sqrt()
}

/// Whether a room may stand at (cx, cy, w×h): on the plate, clear of interior
/// walls, abutting-but-not-inside keep-outs (0.05 m), a person-clearance from
/// frozen furniture, `ROOM_GAP` from other rooms, and never intruding on a
/// drawn circulation rect.
#[allow(clippy::too_many_arguments)]
fn room_slot_ok(
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &[(f64, f64, f64, f64)],
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
    cx: f64,
    cy: f64,
    w: f64,
    h: f64,
) -> bool {
    slot_fits_plate(plate, cx, cy, w, h, 0.05)
        && slot_clears_walls(iwalls, cx, cy, w, h)
        && !footprint_overlaps(&obstacles[..keepout_len], cx, cy, w, h, 0.05)
        && !footprint_overlaps(&obstacles[keepout_len..frozen_len], cx, cy, w, h, clear)
        && !footprint_overlaps(&obstacles[frozen_len..], cx, cy, w, h, ROOM_GAP - 1e-6)
        // A band room's glazed front sits EXACTLY on the spine edge (its door
        // opens onto it) - that shared edge must be allowed. Reject only genuine
        // interpenetration (a strict negative tolerance), not a touching front.
        && !circ_rects.iter().any(|r| {
            (cx - (r.x0 + r.x1) / 2.0).abs() < (w + r.width()) / 2.0 - 1e-6
                && (cy - (r.y0 + r.y1) / 2.0).abs() < (h + r.height()) / 2.0 - 1e-6
        })
}

/// Emit one placed room job: an enclosed shell via `emit_room` for walled
/// rooms, or an open setting (zone + breakout table) for collab/print.
fn emit_job(doc: &mut Document, job: &RoomJob, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide) {
    if job.walls {
        emit_room(
            doc, cx, cy, w, h, side,
            &RoomSpec {
                zone_type: job.zone_type,
                label: job.label.clone(),
                glass_front: job.glass_front,
                door_w: job.door_w,
                furniture: job.furniture,
            },
        );
    } else {
        push_zone(doc, job.zone_type, ZoneShape::Rect { x: cx, y: cy, w, h }, &job.label);
        let tw = snap_module((w - 1.8).clamp(0.6, 2.4).min(w - 0.2));
        let th = snap_module((h - 1.8).clamp(0.6, 1.2).min(h - 0.2));
        if tw > 0.3 && th > 0.3 {
            push_component(doc, "Table", snap_module(cx), snap_module(cy), tw, th, 0.0);
        }
    }
}

/// Slide `job` along `plan`'s band — from the entry end, or the far end for
/// `far` jobs — in `BAND_STEP` increments until a clear anchor appears. THE
/// wall-dense-plate fix: the old fixed-pitch placement found almost no clear
/// slots once real interior walls constrained the band (1 of 11 rooms on the
/// user's imported building); a sliding anchor hunts out the gaps between
/// them. Room fronts stay ON the shared band-front line. Returns placed.
#[allow(clippy::too_many_arguments)]
fn place_in_band(
    doc: &mut Document,
    plan: &RegionPlan,
    job: &RoomJob,
    cursors: &mut (f64, f64),
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
) -> bool {
    let depth_cap = (plan.band_front - plan.band_base).abs();
    if depth_cap < 0.5 {
        return false;
    }
    // Clamp to the band (the old meeting clamp, floored at 70% of the ask).
    let d = snap_room_floor(job.d.min(depth_cap));
    let w = snap_room_floor(job.w.min(cursors.1 - cursors.0));
    if d < 0.7 * job.d - 1e-9 || w < 0.7 * job.w - 1e-9 || w < 0.5 {
        return false;
    }
    // Front-aligned: the corridor face sits exactly on the band front line — so
    // every room front lands on one unbroken line (spec §4.3). EXCEPTION: Focus
    // rooms REAR-align to `band_base` (the band's rear, which backs onto the
    // boundary/facade wall) so they sit ON the facade for daylight — item 4a's
    // HARD placement rule (front-alignment would float a shallow focus room in
    // the band middle, AWAY from the window, which is exactly the inequality M7
    // couldn't guarantee). Their glazed front + door still open toward the spine
    // across the shallow set-back the deeper band leaves — a reachable pocket.
    let sign = if plan.band_far { 1.0 } else { -1.0 };
    let cc = if job.kind == SpaceKind::Focus {
        plan.band_base - sign * d / 2.0
    } else {
        plan.band_front + sign * d / 2.0
    };
    let side = match (plan.portrait, plan.band_far) {
        (false, false) => CorridorSide::Top,
        (false, true) => CorridorSide::Bottom,
        (true, false) => CorridorSide::Right,
        (true, true) => CorridorSide::Left,
    };
    // World rect dims: a portrait band runs along Y, so front-run/depth swap.
    let (ww, hh) = if plan.portrait { (d, w) } else { (w, d) };

    let from_hi = job.far ^ plan.rev;
    let mut along = if from_hi {
        snap_module_floor(cursors.1 - w / 2.0)
    } else {
        snap_module(cursors.0 + w / 2.0)
    };
    loop {
        if from_hi {
            if along - w / 2.0 < cursors.0 - 1e-9 {
                return false;
            }
        } else if along + w / 2.0 > cursors.1 + 1e-9 {
            return false;
        }
        let (cx, cy) = if plan.portrait { (cc, along) } else { (along, cc) };
        if room_slot_ok(
            plate, iwalls, obstacles, keepout_len, frozen_len, circ_rects, clear, cx, cy, ww, hh,
        ) {
            emit_job(doc, job, cx, cy, ww, hh, side);
            obstacles.push((cx, cy, ww, hh));
            if from_hi {
                cursors.1 = along - w / 2.0 - ROOM_GAP;
            } else {
                cursors.0 = along + w / 2.0 + ROOM_GAP;
            }
            return true;
        }
        along = if from_hi {
            snap_module(along - BAND_STEP)
        } else {
            snap_module(along + BAND_STEP)
        };
    }
}

/// Interior clear-pocket fallback for rooms the bands rejected: scan a
/// `POCKET_STEP` candidate grid across every region (BOTH orientations), keep
/// the fitting candidate nearest a drawn circulation rect, and face the door
/// toward it. This is what lets rooms land between the interior walls of a
/// wall-dense imported plan instead of being silently dropped.
#[allow(clippy::too_many_arguments)]
fn place_in_pocket(
    doc: &mut Document,
    plans: &[RegionPlan],
    job: &RoomJob,
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
) -> bool {
    let mut best: Option<(f64, f64, f64, f64, f64)> = None; // (dist, cx, cy, w, h)
    'search: for plan in plans {
        let p = &plan.pocket;
        for (w, d) in [(job.w, job.d), (job.d, job.w)] {
            let ww = snap_room_floor(w);
            let hh = snap_room_floor(d);
            if ww > p.width() + 1e-9 || hh > p.height() + 1e-9 || ww < 0.5 || hh < 0.5 {
                continue;
            }
            let x_lo = p.x0 + ww / 2.0;
            let x_hi = p.x1 - ww / 2.0;
            let y_lo = p.y0 + hh / 2.0;
            let y_hi = p.y1 - hh / 2.0;
            let nx = ((x_hi - x_lo) / POCKET_STEP).floor().max(0.0) as i64;
            let ny = ((y_hi - y_lo) / POCKET_STEP).floor().max(0.0) as i64;
            for iy in 0..=ny {
                for ix in 0..=nx {
                    let cx = snap_module(x_lo + ix as f64 * POCKET_STEP);
                    let cy = snap_module(y_lo + iy as f64 * POCKET_STEP);
                    if cx - ww / 2.0 < p.x0 - 1e-9
                        || cx + ww / 2.0 > p.x1 + 1e-9
                        || cy - hh / 2.0 < p.y0 - 1e-9
                        || cy + hh / 2.0 > p.y1 + 1e-9
                    {
                        continue;
                    }
                    if !room_slot_ok(
                        plate, iwalls, obstacles, keepout_len, frozen_len, circ_rects, clear,
                        cx, cy, ww, hh,
                    ) {
                        continue;
                    }
                    let dist = circ_rects
                        .iter()
                        .map(|r| rect_gap(cx, cy, ww, hh, r))
                        .fold(f64::INFINITY, f64::min);
                    if best.is_none_or(|b| dist < b.0) {
                        best = Some((dist, cx, cy, ww, hh));
                    }
                    if dist <= 0.3 {
                        break 'search; // adjacent to a corridor — take it
                    }
                }
            }
        }
    }
    let Some((_, cx, cy, ww, hh)) = best else { return false };
    let side = door_side_toward_circ(cx, cy, ww, hh, circ_rects);
    emit_job(doc, job, cx, cy, ww, hh, side);
    obstacles.push((cx, cy, ww, hh));
    true
}

/// Which wall a free-standing room's door/front faces: toward the NEAREST drawn
/// circulation rect, on its dominant axis. Shared by the pocket fallback and the
/// anchor placement (both drop rooms off the band, so both need a door side).
fn door_side_toward_circ(cx: f64, cy: f64, ww: f64, hh: f64, circ_rects: &[geometry::Rect]) -> CorridorSide {
    circ_rects
        .iter()
        .min_by(|a, b| {
            rect_gap(cx, cy, ww, hh, a)
                .partial_cmp(&rect_gap(cx, cy, ww, hh, b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|r| {
            let dx = (r.x0 + r.x1) / 2.0 - cx;
            let dy = (r.y0 + r.y1) / 2.0 - cy;
            if dx.abs() > dy.abs() {
                if dx > 0.0 { CorridorSide::Right } else { CorridorSide::Left }
            } else if dy > 0.0 {
                CorridorSide::Top
            } else {
                CorridorSide::Bottom
            }
        })
        .unwrap_or(CorridorSide::Top)
}

/// Place one ANCHORED room (workflow.md §3.5) at (near) its pinned point.
///
/// Scans candidate centers — the exact pin first, then a fixed `ANCHOR_STEP`
/// grid over the plate bbox, in BOTH orientations — and keeps the feasible slot
/// whose center is NEAREST the pin (`room_slot_ok` enforces plate containment,
/// wall clearance, keep-out/obstacle avoidance, and no circulation intrusion —
/// the SAME test the band/pocket passes use, so an anchor never overlaps them).
/// The room is emitted with its door toward the nearest corridor and registered
/// as an obstacle so later placement packs around it. Deterministic (no rng).
/// Returns whether it placed (false only when nothing fits anywhere — a shortfall
/// `program_fit` reports).
#[allow(clippy::too_many_arguments)]
fn place_anchor(
    doc: &mut Document,
    job: &RoomJob,
    tx: f64,
    ty: f64,
    bbox: (f64, f64, f64, f64),
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
) -> bool {
    /// Nearest-slot scan step (m): fine enough to snuggle a pin against real
    /// interior walls, coarse enough to stay cheap on a big plate.
    const ANCHOR_STEP: f64 = 0.3;
    let (min_x, min_y, max_x, max_y) = bbox;
    // (dist², cx, cy, ww, hh) of the feasible candidate nearest the pin so far.
    let mut best: Option<(f64, f64, f64, f64, f64)> = None;
    let consider = |cx: f64, cy: f64, ww: f64, hh: f64, best: &mut Option<(f64, f64, f64, f64, f64)>| {
        if room_slot_ok(
            plate, iwalls, obstacles, keepout_len, frozen_len, circ_rects, clear, cx, cy, ww, hh,
        ) {
            let dist2 = (cx - tx).powi(2) + (cy - ty).powi(2);
            if best.is_none_or(|b| dist2 < b.0) {
                *best = Some((dist2, cx, cy, ww, hh));
            }
        }
    };
    for (w, d) in [(job.w, job.d), (job.d, job.w)] {
        let ww = snap_room_floor(w);
        let hh = snap_room_floor(d);
        if ww < 0.5 || hh < 0.5 {
            continue;
        }
        // The exact pin first (dist 0 wins outright when it fits).
        consider(snap_module(tx), snap_module(ty), ww, hh, &mut best);
        let nx = (((max_x - min_x) / ANCHOR_STEP).floor() as i64).max(0);
        let ny = (((max_y - min_y) / ANCHOR_STEP).floor() as i64).max(0);
        for iy in 0..=ny {
            for ix in 0..=nx {
                let cx = snap_module(min_x + ix as f64 * ANCHOR_STEP);
                let cy = snap_module(min_y + iy as f64 * ANCHOR_STEP);
                consider(cx, cy, ww, hh, &mut best);
            }
        }
    }
    let Some((_, cx, cy, ww, hh)) = best else { return false };
    let side = door_side_toward_circ(cx, cy, ww, hh, circ_rects);
    emit_job(doc, job, cx, cy, ww, hh, side);
    obstacles.push((cx, cy, ww, hh));
    true
}

/// Pack one region's desk field on the GLOBAL lattice `lat`, skipping any cell
/// that collides with an obstacle (rooms, keep-outs, frozen items, connector).
/// Emits the Workspace zone(s) — segmented at the secondary aisles / crossing
/// strips so rect zones tile without overlap — plus the drawn secondary-aisle
/// `Circulation` rects. Returns desks placed.
#[allow(clippy::too_many_arguments)]
fn pack_desks(
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
        };
        let outer_n = {
            let mut n = 0i64;
            while outer_at(n).0 + outer_half <= outer_dz1 + 1e-9 {
                n += 1;
            }
            n
        };
        if inner_n <= 0 || outer_n <= 0 {
            break 'desks;
        }

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
        'grid: for o in 0..outer_n {
            let (outer_c, rot) = outer_at(o);
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
                    continue;
                }
                let ok = slot_fits_plate(plate, fx, fy, fw, fh, FACADE_GAP)
                    && slot_clears_walls(iwalls, fx, fy, fw, fh)
                    && !footprint_overlaps(&obstacles[..grid_start], fx, fy, fw, fh, clear - 1e-6)
                    && !footprint_overlaps(&obstacles[grid_start..], fx, fy, fw, fh, same_grid_pad);
                if !ok {
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

/// Professional density sub-score from NIA m² per person (spec §5). Peaks (100)
/// across the BCO/NBC professional band **8–12 m²/person** (10 is the design
/// occupancy) and tapers to 0 on BOTH sides: too CRAMMED (fewer m²/person, 0 at
/// ≤4.5) and too SPARSE (more m²/person, 0 at ≥20). This REPLACES the old
/// desk-area/floor 30–55% band, which peaked at ~2.3 m²/desk — literally
/// steering the optimizer toward unprofessional cramming (spec gap #7).
fn density_score(m2_per_person: f64) -> f64 {
    if m2_per_person < 8.0 {
        ((m2_per_person - 4.5) / (8.0 - 4.5) * 100.0).clamp(0.0, 100.0)
    } else if m2_per_person <= 12.0 {
        100.0
    } else {
        ((20.0 - m2_per_person) / (20.0 - 12.0) * 100.0).clamp(0.0, 100.0)
    }
}

/// Centroid of a zone (its bbox center).
fn zone_bbox_center(z: &Zone) -> (f64, f64) {
    let (x0, y0, x1, y1) = z.shape.bbox();
    ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
}

/// Shortest distance from a point to the plate boundary (facade). 0 when the
/// walls don't close a loop.
fn dist_to_facade(px: f64, py: f64, poly: Option<&[Point]>) -> f64 {
    let Some(poly) = poly else { return 0.0 };
    (0..poly.len())
        .map(|i| {
            let a = poly[i];
            let b = poly[(i + 1) % poly.len()];
            geometry::point_segment_dist(Point::new(px, py), a, b)
        })
        .fold(f64::INFINITY, f64::min)
}

/// RELATIONSHIP adjacency (0..100): how well the plan honours senior-planner
/// space relationships beyond desk pitch (spec §3 / the "smart" adjacency model,
/// docs/design/testfit-pro-quality.md). Averages the APPLICABLE checks:
///   - meeting/conference rooms CLUSTER near the entry (client-facing),
///   - focus rooms sit toward the FACADE (daylit / calm),
///   - the pantry is a CENTRAL social node,
///   - IT / storage sit toward the INTERIOR (near the building core).
/// Returns `None` when the plate offers nothing to judge (no rooms, or open
/// walls with no entry) — the caller then falls back to pure desk coherence.
/// Deterministic; a pure read of the document geometry.
fn relationship_adjacency(doc: &Document, poly: Option<&[Point]>, entry: Option<Point>) -> Option<f64> {
    // Plate bbox → centroid + diagonal, the intrinsic length scale the checks
    // normalise against (so a big plate isn't unfairly penalised).
    let (bx0, by0, bx1, by1) = doc.wall_bbox()?;
    let (cx, cy) = ((bx0 + bx1) / 2.0, (by0 + by1) / 2.0);
    let diag = ((bx1 - bx0).powi(2) + (by1 - by0).powi(2)).sqrt().max(1e-6);

    let centers = |pred: &dyn Fn(&Zone) -> bool| -> Vec<(f64, f64)> {
        doc.zones.iter().filter(|z| pred(z)).map(zone_bbox_center).collect()
    };
    let meetings = centers(&|z| z.zone_type == ZoneType::Meeting);
    let focus = centers(&|z| z.label.starts_with("Focus"));
    let pantry = centers(&|z| z.label.starts_with("Pantry"));
    let it_store = centers(&|z| z.label.starts_with("IT") || z.label.starts_with("Storage"));

    let mut sum = 0.0;
    let mut n = 0u32;
    let avg = |v: &[(f64, f64)], f: &dyn Fn(f64, f64) -> f64| -> f64 {
        v.iter().map(|&(x, y)| f(x, y)).sum::<f64>() / v.len() as f64
    };

    // (1) Meetings near the entry. Reference = the entry→centroid distance: a
    // meeting AT the entry scores 100, one at 2× that reference scores 0.
    if let Some(e) = entry {
        if !meetings.is_empty() {
            let d_ref = (((cx - e.x).powi(2) + (cy - e.y).powi(2)).sqrt()).max(1e-6);
            let d_m = avg(&meetings, &|x, y| ((x - e.x).powi(2) + (y - e.y).powi(2)).sqrt());
            sum += (100.0 * (2.0 * d_ref - d_m) / (2.0 * d_ref)).clamp(0.0, 100.0);
            n += 1;
        }
    }
    // (2) Focus rooms toward the facade (within ~DAYLIGHT_REACH_M → full marks).
    if !focus.is_empty() && poly.is_some() {
        let d_f = avg(&focus, &|x, y| dist_to_facade(x, y, poly));
        sum += (100.0 * (1.5 * DAYLIGHT_REACH_M - d_f) / (1.5 * DAYLIGHT_REACH_M)).clamp(0.0, 100.0);
        n += 1;
    }
    // (3) Pantry central: near the plate centroid (a social node the whole floor
    // reaches). At the centroid → 100, at half the diagonal away → 0.
    if !pantry.is_empty() {
        let d_p = avg(&pantry, &|x, y| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt());
        sum += (100.0 * (1.0 - d_p / (0.5 * diag))).clamp(0.0, 100.0);
        n += 1;
    }
    // (4) IT / storage toward the interior (away from the facade → near the core).
    if !it_store.is_empty() && poly.is_some() {
        let d_i = avg(&it_store, &|x, y| dist_to_facade(x, y, poly));
        sum += (100.0 * (d_i / 4.0)).clamp(0.0, 100.0);
        n += 1;
    }

    if n == 0 {
        None
    } else {
        Some(sum / n as f64)
    }
}

/// Score a layout against the program. Sub-scores are 0..100; `total` is the
/// weight-normalised blend (design §3). This is the deterministic evaluator that
/// drives the generate→evaluate→optimize loop.
pub fn score(doc: &Document, program: &Program) -> LayoutScore {
    let desks: Vec<&Component> = doc
        .components
        .iter()
        .filter(|c| c.category == "Desk")
        .collect();
    let placed_desks = desks.len() as u32;

    // The plate polygon (true floor loop) is traced ONCE and reused by the
    // adjacency (facade relationships), density and daylight sub-scores.
    let plate_poly = geometry::trace_floor_polygon(&wall_segments(doc), geometry::LOOP_SNAP_TOL);

    // --- capacity: fraction of requested desks actually seated ---
    let capacity = if program.desks == 0 {
        100.0
    } else {
        (100.0 * placed_desks as f64 / program.desks as f64).min(100.0)
    };

    // --- adjacency: desk-cluster coherence BLENDED with relationship adjacency ---
    // (1) Desk coherence: nearest-neighbour pitch ratio (tight benches read as
    // coherent clusters, not scattered desks).
    let ideal_pitch = ((program.desk_w + program.desk_clearance_m)
        .min(program.desk_h + program.desk_clearance_m))
    .max(1e-6);
    let desk_coherence = if desks.len() < 2 {
        100.0
    } else {
        let mut sum_nn = 0.0;
        for (i, a) in desks.iter().enumerate() {
            let mut best = f64::INFINITY;
            for (j, b) in desks.iter().enumerate() {
                if i == j {
                    continue;
                }
                let d = ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt();
                if d < best {
                    best = d;
                }
            }
            sum_nn += best;
        }
        let avg_nn = sum_nn / desks.len() as f64;
        // avg_nn == ideal_pitch → 100; larger spacing → lower.
        (100.0 * ideal_pitch / avg_nn.max(1e-6)).min(100.0)
    };
    // (2) Relationship adjacency (meeting↔entry, focus↔facade, pantry central,
    // IT↔core). Blended in when the plate offers relationships to judge; the
    // desk-coherence term keeps the sub-score meaningful for a bare open plan.
    let adjacency = match relationship_adjacency(doc, plate_poly.as_deref(), doc.entries.first().copied()) {
        Some(rel) => 0.45 * desk_coherence + 0.55 * rel,
        None => desk_coherence,
    };

    // --- density: peak at the professional 8–12 m²/person band (spec §5) ---
    // Floor area is the true plate-polygon area when the walls close a loop
    // (identical to the bbox for rectangular rooms); bbox only as a fallback.
    // Otherwise an L-plate's density would be diluted by its void notch. The
    // plate polygon (traced once at the top) is also reused by the daylight
    // sub-score below.
    let floor = plate_poly
        .as_deref()
        .map(geometry::polygon_area)
        .unwrap_or_else(|| doc.floor_area());
    // Total SEATS = workstations + meeting/collab capacity (the report's KPI),
    // so density measures people-per-area the way a consultant reads it, not
    // desk footprint coverage (which rewarded cramming).
    let meeting_seats: f64 = doc
        .zones
        .iter()
        .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::Collaboration))
        .map(|z| z.capacity() as f64)
        .sum();
    let seats = placed_desks as f64 + meeting_seats;
    let density = if floor <= 0.0 || seats <= 0.0 {
        0.0
    } else {
        density_score(floor / seats)
    };

    // --- circulation: the teammate-owned "walking place" evaluator ---
    // `crates/ds-core/src/circulation.rs::evaluate(doc, &CirculationConfig)`
    // returns a `CirculationScore` whose `.score` is the 0..100 headline. We feed
    // the program's target corridor width through so the corridor the generator
    // reserves is the same width the evaluator measures against.
    // (See docs/design/autonomous-testfit-loop.md §3.)
    let mut circ_cfg = CirculationConfig::default();
    circ_cfg.target_corridor_width = program.target_corridor_m;
    let circulation = circulation::evaluate(doc, &circ_cfg).score;

    // --- program_fit: delivered vs derived room program (spec 1.1) ---
    // Every placed room emits exactly one typed zone (Meeting / ClosedOffice /
    // Amenity / Collaboration); the derived target is the meeting override plus
    // the support program the same headcount derives. A shortfall on a
    // wall-dense plate surfaces here instead of being silently dropped.
    let placed_rooms = doc
        .zones
        .iter()
        .filter(|z| {
            matches!(
                z.zone_type,
                ZoneType::Meeting
                    | ZoneType::ClosedOffice
                    | ZoneType::Amenity
                    | ZoneType::Collaboration
            )
        })
        .count() as u32;
    // Derived target + the anchor "bump": for each anchored kind, the rooms its
    // pins ADD beyond the free supply (anchored − supply, floored at 0). Folding
    // it into the denominator keeps `program_fit` honest — a bumped pin that fits
    // nowhere shows as a shortfall instead of vanishing (workflow.md §3.5).
    let support = support_jobs(program, floor);
    let free_of = |k: SpaceKind| -> u32 {
        let s = support.iter().filter(|j| j.kind == k).count() as u32;
        if k == SpaceKind::Meeting { s + program.meeting_rooms } else { s }
    };
    let mut anchor_bump = 0u32;
    let mut seen: Vec<SpaceKind> = Vec::new();
    for a in &doc.anchors {
        if seen.contains(&a.kind) {
            continue;
        }
        seen.push(a.kind);
        let anchored_k = doc.anchors.iter().filter(|b| b.kind == a.kind).count() as u32;
        anchor_bump += anchored_k.saturating_sub(free_of(a.kind));
    }
    let derived_rooms = program.meeting_rooms + support.len() as u32 + anchor_bump;
    let program_fit = if derived_rooms == 0 {
        100.0
    } else {
        (100.0 * placed_rooms as f64 / derived_rooms as f64).min(100.0)
    };

    // --- daylight: % of workstations within reach of the facade (spec §5) ---
    // qbiq's published daylight metric: real plans put desks at the windows.
    // A desk is daylit when its center is within DAYLIGHT_REACH_M of any plate
    // boundary edge. No plate loop (open walls) → neutral 100 (nothing to fault).
    let daylight = if desks.is_empty() {
        100.0
    } else if let Some(poly) = plate_poly.as_deref() {
        let near = desks
            .iter()
            .filter(|c| {
                (0..poly.len()).any(|i| {
                    let a = poly[i];
                    let b = poly[(i + 1) % poly.len()];
                    geometry::point_segment_dist(Point::new(c.x, c.y), a, b) <= DAYLIGHT_REACH_M
                })
            })
            .count();
        100.0 * near as f64 / desks.len() as f64
    } else {
        100.0
    };

    // --- entry_adjacency: reception near the entry, pantry far (spec §3) ---
    // The plan's "enter → reception → spine → pantry" narrative. Neutral 100
    // when the plate carries no entry to judge against.
    let entry_adjacency = match doc.entries.first() {
        None => 100.0,
        Some(e) => {
            let dist_to = |label: &str| {
                doc.zones.iter().find(|z| z.label == label).map(|z| {
                    let (x0, y0, x1, y1) = z.shape.bbox();
                    (((x0 + x1) / 2.0 - e.x).powi(2) + ((y0 + y1) / 2.0 - e.y).powi(2)).sqrt()
                })
            };
            match (dist_to("Reception"), dist_to("Pantry")) {
                // 100 when reception hugs the door and the pantry is the far
                // social anchor; 50 when they are equidistant; →0 if inverted.
                (Some(dr), Some(dp)) if dr + dp > 1e-6 => {
                    (100.0 * dp / (dr + dp)).clamp(0.0, 100.0)
                }
                (Some(_), Some(_)) => 100.0,
                (Some(_), None) | (None, Some(_)) => 60.0,
                (None, None) => 50.0,
            }
        }
    };

    // --- weighted total ---
    // The strategy re-weights the objective so the seed search WITHIN a strategy
    // optimises for its priorities (Open → capacity/density; Cellular →
    // program-fit/entry). Balanced's bias is the identity, so `total` is
    // byte-unchanged for every pre-M7 (Balanced) program.
    let bias = program.strategy.weight_bias();
    let wc = program.w_capacity * bias.capacity;
    let wa = program.w_adjacency * bias.adjacency;
    let wr = program.w_circulation * bias.circulation;
    let wd = program.w_density * bias.density;
    let wp = program.w_program * bias.program;
    let wl = program.w_daylight * bias.daylight;
    let we = program.w_entry * bias.entry;
    let wsum = (wc + wa + wr + wd + wp + wl + we).max(1e-6);
    let total = (wc * capacity
        + wa * adjacency
        + wr * circulation
        + wd * density
        + wp * program_fit
        + wl * daylight
        + we * entry_adjacency)
        / wsum;

    LayoutScore {
        capacity,
        adjacency,
        circulation,
        density,
        program_fit,
        daylight,
        entry_adjacency,
        total,
        placed_desks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Wall;

    /// Build a room from a closed corner loop (one wall per consecutive pair).
    fn room_from_corners(corners: &[(f64, f64)]) -> Document {
        let mut doc = Document::new();
        for i in 0..corners.len() {
            let (ax, ay) = corners[i];
            let (bx, by) = corners[(i + 1) % corners.len()];
            let id = doc.alloc_id();
            doc.walls.push(Wall {
                id,
                a: Point::new(ax, ay),
                b: Point::new(bx, by),
                thickness: 0.1,
                generated: false,
                glazing: false,
            });
        }
        doc
    }

    /// Build a rectangular room `w`×`h` meters with its SW corner at origin.
    fn room(w: f64, h: f64) -> Document {
        room_from_corners(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)])
    }

    /// L-shaped plate: 20×14 with an 8×6 notch removed at the top-right corner
    /// (void where x > 12 and y > 8), drawn as 6 walls forming one closed loop.
    fn l_room() -> Document {
        room_from_corners(&[
            (0.0, 0.0),
            (20.0, 0.0),
            (20.0, 8.0),
            (12.0, 8.0),
            (12.0, 14.0),
            (0.0, 14.0),
        ])
    }

    /// Meeting rooms delivered by the generator — since M1 a room is a shell
    /// (generated walls + Door + Table) around a `Meeting` zone, so the zone
    /// is the room's identity.
    fn meeting_room_count(doc: &Document) -> usize {
        doc.zones.iter().filter(|z| z.zone_type == ZoneType::Meeting).count()
    }

    /// Rects of all generated meeting rooms.
    fn meeting_rects(doc: &Document) -> Vec<(f64, f64, f64, f64)> {
        doc.zones
            .iter()
            .filter(|z| z.zone_type == ZoneType::Meeting)
            .map(|z| match z.shape {
                ZoneShape::Rect { x, y, w, h } => (x, y, w, h),
                _ => panic!("meeting zone must be a Rect"),
            })
            .collect()
    }

    /// Assert the room rect (center `x,y`, size `w`×`h`) is a real enclosure:
    /// generated walls cover its full inset perimeter minus exactly one 0.9 m
    /// door gap, the gapped side is the glazed front, exactly one Door sits on
    /// that side's centerline inside the gap, and a full-size Table is centered
    /// in the room.
    fn assert_room_enclosed(doc: &Document, x: f64, y: f64, w: f64, h: f64, ctx: &str) {
        let t2 = 0.05; // PARTITION_T / 2 — the wall-centerline inset
        let (x0, x1) = (x - w / 2.0 + t2, x + w / 2.0 - t2);
        let (y0, y1) = (y - h / 2.0 + t2, y + h / 2.0 - t2);
        let eps = 1e-6;

        // Bucket generated walls onto the four centerline sides: L, R, B, T.
        let mut sides: [Vec<&Wall>; 4] = [vec![], vec![], vec![], vec![]];
        for wl in doc.walls.iter().filter(|w| w.generated) {
            let on = |v: f64, t: f64| (v - t).abs() < eps;
            let in_y = wl.a.y >= y0 - eps && wl.a.y <= y1 + eps && wl.b.y >= y0 - eps && wl.b.y <= y1 + eps;
            let in_x = wl.a.x >= x0 - eps && wl.a.x <= x1 + eps && wl.b.x >= x0 - eps && wl.b.x <= x1 + eps;
            if on(wl.a.x, x0) && on(wl.b.x, x0) && in_y {
                sides[0].push(wl);
            } else if on(wl.a.x, x1) && on(wl.b.x, x1) && in_y {
                sides[1].push(wl);
            } else if on(wl.a.y, y0) && on(wl.b.y, y0) && in_x {
                sides[2].push(wl);
            } else if on(wl.a.y, y1) && on(wl.b.y, y1) && in_x {
                sides[3].push(wl);
            }
        }
        let seg_len = |wl: &Wall| (wl.b.x - wl.a.x).abs() + (wl.b.y - wl.a.y).abs();
        let side_len = [y1 - y0, y1 - y0, x1 - x0, x1 - x0];

        // Exactly ONE side carries the 0.9 m door gap, and it is the glass front.
        let mut front: Option<usize> = None;
        for (i, s) in sides.iter().enumerate() {
            assert!(!s.is_empty(), "{ctx}: room at ({x:.1},{y:.1}) side {i} has no walls");
            let cov: f64 = s.iter().map(|w| seg_len(w)).sum();
            if (cov - side_len[i]).abs() < 1e-6 {
                assert!(s.iter().all(|w| !w.glazing), "{ctx}: solid side {i} must not be glazed");
            } else {
                assert!(
                    (cov - (side_len[i] - 0.9)).abs() < 1e-6,
                    "{ctx}: side {i} covers {cov:.3} of {:.3} — not a single 0.9 door gap",
                    side_len[i]
                );
                assert!(s.iter().all(|w| w.glazing), "{ctx}: the door side must be the glass front");
                assert!(front.is_none(), "{ctx}: two sides have gaps");
                front = Some(i);
            }
        }
        let front = front.unwrap_or_else(|| panic!("{ctx}: no door gap in room at ({x:.1},{y:.1})"));

        // Exactly one Door inside the room rect, on the front's centerline,
        // leaf 0.9, and no glass segment overlaps the leaf interval (the door
        // really sits IN the gap).
        let doors: Vec<_> = doc
            .components
            .iter()
            .filter(|c| {
                c.category == "Door"
                    && (c.x - x).abs() <= w / 2.0 + eps
                    && (c.y - y).abs() <= h / 2.0 + eps
            })
            .collect();
        assert_eq!(doors.len(), 1, "{ctx}: room at ({x:.1},{y:.1}) needs exactly one door");
        let d = doors[0];
        assert!((d.w - 0.9).abs() < 1e-9, "{ctx}: door leaf {} != 0.9", d.w);
        match front {
            0 => assert!((d.x - x0).abs() < eps, "{ctx}: door off the left front"),
            1 => assert!((d.x - x1).abs() < eps, "{ctx}: door off the right front"),
            2 => assert!((d.y - y0).abs() < eps, "{ctx}: door off the bottom front"),
            _ => assert!((d.y - y1).abs() < eps, "{ctx}: door off the top front"),
        }
        let (d_lo, d_hi) = if front <= 1 {
            (d.y - d.w / 2.0, d.y + d.w / 2.0)
        } else {
            (d.x - d.w / 2.0, d.x + d.w / 2.0)
        };
        for wl in &sides[front] {
            let (a, b) = if front <= 1 {
                (wl.a.y.min(wl.b.y), wl.a.y.max(wl.b.y))
            } else {
                (wl.a.x.min(wl.b.x), wl.a.x.max(wl.b.x))
            };
            assert!(
                b <= d_lo + eps || a >= d_hi - eps,
                "{ctx}: glass front overlaps the door leaf"
            );
        }

        // Full-size conference table centered in the room.
        let tables = doc
            .components
            .iter()
            .filter(|c| c.category == "Table" && (c.x - x).abs() < eps && (c.y - y).abs() < eps)
            .count();
        assert_eq!(tables, 1, "{ctx}: room at ({x:.1},{y:.1}) needs its table");
    }

    #[test]
    fn generate_is_deterministic_for_same_seed() {
        let program = Program::default();
        let mut a = room(20.0, 15.0);
        let mut b = room(20.0, 15.0);
        generate(&mut a, &program, 42, false);
        generate(&mut b, &program, 42, false);
        assert_eq!(a.components.len(), b.components.len());
        for (ca, cb) in a.components.iter().zip(b.components.iter()) {
            assert_eq!(ca.category, cb.category);
            assert!((ca.x - cb.x).abs() < 1e-12, "x differs across identical seeds");
            assert!((ca.y - cb.y).abs() < 1e-12, "y differs across identical seeds");
        }
        // The emitted room shells are deterministic too — wall for wall.
        assert_eq!(a.walls.len(), b.walls.len());
        for (wa, wb) in a.walls.iter().zip(b.walls.iter()) {
            assert_eq!(
                (wa.a.x.to_bits(), wa.a.y.to_bits(), wa.b.x.to_bits(), wa.b.y.to_bits()),
                (wb.a.x.to_bits(), wb.a.y.to_bits(), wb.b.x.to_bits(), wb.b.y.to_bits()),
                "wall geometry differs across identical seeds"
            );
            assert_eq!((wa.generated, wa.glazing), (wb.generated, wb.glazing));
        }
    }

    // ---- M1: enclosed rooms (partitions + glass front + door) --------------

    #[test]
    fn generated_rooms_are_enclosed_with_glass_front_and_door() {
        let program = Program::default(); // 2 meeting rooms, 4×4
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 3, false);
        let rooms = meeting_rects(&doc);
        assert_eq!(rooms.len(), 2);
        for &(x, y, w, h) in &rooms {
            assert_room_enclosed(&doc, x, y, w, h, "rect plate");
        }
        // Every generated wall belongs to a room perimeter — none float free —
        // and the user's 4 boundary walls are untouched.
        assert_eq!(doc.walls.iter().filter(|w| !w.generated).count(), 4);
        // Rooms stay REACHABLE: with partitions in and doors whitelisted the
        // walkable floor is still (nearly) one connected region.
        let circ = circulation::evaluate(&doc, &CirculationConfig::default());
        assert!(
            circ.largest_connected_free_region > 0.98,
            "rooms must connect through their doors (got {})",
            circ.largest_connected_free_region
        );
    }

    #[test]
    fn portrait_wing_rooms_are_enclosed_too() {
        // The L-plate's upper-left wing is portrait → rooms band along its
        // bottom edge (CorridorSide::Bottom path).
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 30;
        program.meeting_rooms = 2;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let mut doc = l_room();
        generate(&mut doc, &program, 3, false);
        let rooms = meeting_rects(&doc);
        assert!(rooms.len() >= 2, "expected both rooms placed");
        for &(x, y, w, h) in &rooms {
            assert_room_enclosed(&doc, x, y, w, h, "l plate");
        }
    }

    #[test]
    fn regenerate_replaces_generated_walls_and_keeps_user_walls() {
        let program = Program::default();
        let mut doc = room(30.0, 20.0);
        let user_ids: Vec<u32> = doc.walls.iter().map(|w| w.id).collect();

        generate(&mut doc, &program, 1, false);
        let gen1 = doc.walls.iter().filter(|w| w.generated).count();
        assert!(gen1 > 0, "rooms must emit partitions");
        let total1 = doc.walls.len();

        // Same seed again: prior generated walls are cleared, never stacked.
        generate(&mut doc, &program, 1, false);
        assert_eq!(doc.walls.len(), total1, "regenerate must not accumulate walls");

        // Different seed + keep_confirmed=true also fully replaces the shells
        // while user walls survive untouched.
        generate(&mut doc, &program, 9, true);
        for id in &user_ids {
            assert!(
                doc.walls.iter().any(|w| w.id == *id && !w.generated),
                "user wall {id} was dropped by regenerate"
            );
        }
        assert_eq!(
            doc.walls.iter().filter(|w| !w.generated).count(),
            user_ids.len(),
            "no extra non-generated walls appear"
        );
    }

    // (seed-to-seed variety is asserted structurally by
    // `seed_gallery_is_structurally_diverse` at the end of this module.)

    /// M4 regime: the perimeter corridor RING is retired (spec 3). Desks now
    /// line the facade keeping a FACADE_GAP (0.9 m) maintenance gap to the plate
    /// wall while the primary spine runs INBOARD and rooms back onto the wall.
    /// The surviving invariant: every DESK keeps >= FACADE_GAP to each plate
    /// edge. (Rooms back onto walls and doors bridge into circulation - both
    /// governed by other tests, not this containment one.)
    #[test]
    fn desks_keep_the_facade_maintenance_gap() {
        let mut program = Program::default();
        program.support_spaces = false;
        let mut doc = room(20.0, 15.0);
        generate(&mut doc, &program, 7, false);
        let g = FACADE_GAP;
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        assert!(!desks.is_empty(), "expected desks on a 20x15 plate");
        for comp in &desks {
            let left = comp.x - comp.w / 2.0;
            let right = comp.x + comp.w / 2.0;
            let bottom = comp.y - comp.h / 2.0;
            let top = comp.y + comp.h / 2.0;
            assert!(left >= g - 1e-6, "{} inside the left facade gap", comp.label);
            assert!(right <= 20.0 - g + 1e-6, "{} inside the right facade gap", comp.label);
            assert!(bottom >= g - 1e-6, "{} inside the bottom facade gap", comp.label);
            assert!(top <= 15.0 - g + 1e-6, "{} inside the top facade gap", comp.label);
        }
    }

    #[test]
    fn places_requested_when_room_is_large_enough() {
        let mut program = Program::default();
        program.desks = 12;
        program.meeting_rooms = 1;
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 3, false);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        let mrs = meeting_room_count(&doc);
        // M5 professional density: with `headcount` unset the desk target scales
        // to fill the 600 m² plate to ~10 m²/person (~51 desks), so `desks=12` is
        // a floor, not a ceiling — the surviving invariant is "no shortfall on the
        // request" (the old `== 12` echoed the pre-M5 fixed-count behavior that
        // left big plates sparse; see the density fix rationale in `desk_target`).
        assert!(desks >= 12, "large room must seat at least the requested desks (got {desks})");
        assert_eq!(mrs, 1);
    }

    #[test]
    fn places_multiple_meeting_rooms_when_they_fit() {
        let mut program = Program::default();
        program.meeting_rooms = 2;
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 1, false);
        let mrs = meeting_room_count(&doc);
        // The right-side column must stack both requested rooms (regression:
        // exact-pitch self-collision used to drop the 2nd).
        assert_eq!(mrs, 2, "column should stack both requested meeting rooms");
    }

    #[test]
    fn generate_clears_previous_components() {
        let program = Program::default();
        let mut doc = room(20.0, 15.0);
        generate(&mut doc, &program, 1, false);
        let first = doc.components.len();
        assert!(first > 0);
        generate(&mut doc, &program, 1, false);
        assert_eq!(doc.components.len(), first, "re-generate must not accumulate");
    }

    #[test]
    fn no_walls_is_a_noop() {
        let program = Program::default();
        let mut doc = Document::new();
        generate(&mut doc, &program, 1, false);
        assert!(doc.components.is_empty());
    }

    #[test]
    fn score_fields_are_bounded_and_capacity_tracks_placement() {
        let program = Program::default();
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 5, false);
        let s = score(&doc, &program);
        for v in [
            s.capacity, s.adjacency, s.circulation, s.density, s.program_fit,
            s.daylight, s.entry_adjacency, s.total,
        ] {
            assert!((0.0..=100.0).contains(&v), "score {} out of range", v);
        }
        // M5 professional density: the default program on a 600 m² plate now
        // fills to ~10 m²/person (well past the legacy fixed 24), so placed_desks
        // reflects the PLATE, not a constant. The surviving invariant is "the
        // plate seats at least the requested 24" → capacity saturates at 100.
        assert!(s.placed_desks >= 24, "600 m² plate must seat >= the requested 24 (got {})", s.placed_desks);
        assert!((s.capacity - 100.0).abs() < 1e-9);
    }

    #[test]
    fn capacity_is_partial_when_room_too_small() {
        let mut program = Program::default();
        program.desks = 200; // won't fit
        let mut doc = room(12.0, 10.0);
        generate(&mut doc, &program, 1, false);
        let s = score(&doc, &program);
        assert!(s.capacity < 100.0, "cramped room should not reach full capacity");
        assert!(s.placed_desks < 200);
    }

    /// M4 regime: the perimeter `RectRing` is retired for a DRAWN network of
    /// `Circulation` Rects (spine + connector + link + seams). The facade gap
    /// stays deliberately un-zoned floor, and circulation strips ABUT rooms and
    /// OVERLAY the workspace at crossings - so zones no longer sum to the bbox.
    /// The surviving invariant: the ROOM program (rooms + workspace + core)
    /// tiles cleanly (no two NON-circulation Rect zones overlap) and the zones
    /// together cover the majority of the plate.
    #[test]
    fn room_zones_dont_overlap_and_cover_most_of_the_plate() {
        let mut program = Program::default();
        program.support_spaces = false;
        let mut doc = room(20.0, 14.0);
        generate(&mut doc, &program, 1, false);

        assert!(doc.zones.len() >= 3, "expected a tiling, got {} zones", doc.zones.len());

        // (a) No two NON-circulation Rect zones overlap.
        let rects: Vec<(f64, f64, f64, f64)> = doc
            .zones
            .iter()
            .filter(|z| z.zone_type != ZoneType::Circulation)
            .filter_map(|z| match z.shape {
                ZoneShape::Rect { x, y, w, h } => Some((x, y, w, h)),
                _ => None,
            })
            .collect();
        for (i, &(ax, ay, aw, ah)) in rects.iter().enumerate() {
            for &(bx, by, bw, bh) in rects.iter().skip(i + 1) {
                let ox = (aw + bw) / 2.0 - (ax - bx).abs();
                let oy = (ah + bh) / 2.0 - (ay - by).abs();
                assert!(
                    ox <= 1e-6 || oy <= 1e-6,
                    "non-circulation zones overlap by ({}, {})",
                    ox,
                    oy
                );
            }
        }

        // (b) Zones cover the majority of the plate (facade gaps stay un-zoned).
        let bbox_area = 20.0 * 14.0;
        let sum: f64 = doc.zones.iter().map(|z| z.area()).sum();
        assert!(
            sum >= 0.55 * bbox_area && sum <= bbox_area + 1.0,
            "zones cover {} of bbox {}",
            sum,
            bbox_area
        );
    }

    #[test]
    fn every_component_is_bucketed_into_a_zone() {
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: desks + meetings only
        let mut doc = room(20.0, 14.0);
        generate(&mut doc, &program, 1, false);
        // Every component center lands in exactly one zone's component_ids.
        let assigned: usize = doc.zones.iter().map(|z| z.component_ids.len()).sum();
        assert_eq!(
            assigned,
            doc.components.len(),
            "every component must be reassigned to a zone"
        );
        // Desks live in the Workspace zone.
        let ws = doc
            .zones
            .iter()
            .find(|z| z.zone_type == ZoneType::Workspace)
            .expect("a workspace zone");
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert_eq!(ws.component_ids.len(), desks, "all desks in workspace");
    }

    #[test]
    fn l_room_keeps_every_footprint_out_of_the_notch() {
        let mut program = Program::default();
        program.support_spaces = false; // geometry test: notch containment, not the M3 program
        let mut doc = l_room();
        generate(&mut doc, &program, 7, false);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert!(desks > 0, "L-plate should still seat desks in its legs");
        // No corner, edge midpoint, or center of any footprint may fall in the
        // notch void (x > 12 ∧ y > 8) — that is outside the building.
        for comp in &doc.components {
            let xs = [comp.x - comp.w / 2.0, comp.x, comp.x + comp.w / 2.0];
            let ys = [comp.y - comp.h / 2.0, comp.y, comp.y + comp.h / 2.0];
            for &px in &xs {
                for &py in &ys {
                    assert!(
                        !(px > 12.0 + 1e-9 && py > 8.0 + 1e-9),
                        "{} has point ({}, {}) inside the notch void",
                        comp.label,
                        px,
                        py
                    );
                }
            }
        }
    }

    #[test]
    fn loop_tracer_finds_the_l_polygon_from_its_walls() {
        let doc = l_room();
        let segs: Vec<(Point, Point)> = doc.walls.iter().map(|w| (w.a, w.b)).collect();
        let poly = geometry::trace_floor_polygon(&segs, geometry::LOOP_SNAP_TOL)
            .expect("6 closed walls must trace a loop");
        assert_eq!(poly.len(), 6, "the L has 6 corners");
        // 20×14 − 8×6 notch = 232 m².
        assert!((geometry::polygon_area(&poly) - 232.0).abs() < 1e-9);
        assert!(geometry::point_in_polygon(5.0, 5.0, &poly));
        assert!(!geometry::point_in_polygon(16.0, 11.0, &poly), "notch is outside");
    }

    #[test]
    fn open_walls_fall_back_to_bbox_behavior() {
        // Only 3 sides of a 20×15 rect: no closed loop. The tracer must return
        // None, and generate() must match the closed 20×15 room placement-for-
        // placement (both reduce to the same bbox work zone).
        let mut open = room(20.0, 15.0);
        open.walls.pop();
        let segs: Vec<(Point, Point)> = open.walls.iter().map(|w| (w.a, w.b)).collect();
        assert!(
            geometry::trace_floor_polygon(&segs, geometry::LOOP_SNAP_TOL).is_none(),
            "open walls must not trace a loop"
        );

        let program = Program::default();
        generate(&mut open, &program, 7, false);
        let mut closed = room(20.0, 15.0);
        generate(&mut closed, &program, 7, false);
        assert!(!open.components.is_empty());
        assert_eq!(open.components.len(), closed.components.len());
        for (a, b) in open.components.iter().zip(closed.components.iter()) {
            assert_eq!(a.category, b.category);
            assert!((a.x - b.x).abs() < 1e-12 && (a.y - b.y).abs() < 1e-12);
        }
    }

    #[test]
    fn keep_confirmed_freezes_components_and_packs_around_them() {
        let program = Program::default();
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 3, false);

        // Confirm (freeze) the first two desks; remember id + position.
        let frozen: Vec<(u32, f64, f64)> = doc
            .components
            .iter_mut()
            .filter(|c| c.category == "Desk")
            .take(2)
            .map(|c| {
                c.decision = DecisionState::Confirmed;
                (c.id, c.x, c.y)
            })
            .collect();
        assert_eq!(frozen.len(), 2);

        // Regenerate with a different seed, keeping confirmed.
        generate(&mut doc, &program, 9, true);

        for (id, x, y) in &frozen {
            let kept = doc
                .components
                .iter()
                .find(|c| c.id == *id)
                .expect("frozen desk was dropped on regenerate");
            assert!(
                (kept.x - x).abs() < 1e-9 && (kept.y - y).abs() < 1e-9,
                "frozen desk moved"
            );
            assert_eq!(kept.decision, DecisionState::Confirmed);
            // No other component overlaps this frozen footprint.
            for c in &doc.components {
                if c.id == *id {
                    continue;
                }
                let overlaps = (c.x - x).abs() < (c.w + program.desk_w) / 2.0
                    && (c.y - y).abs() < (c.h + program.desk_h) / 2.0;
                assert!(!overlaps, "{} overlaps a frozen desk", c.label);
            }
        }

        // Total desks never exceed the EFFECTIVE target. Since M5 the target is
        // the professional plate-fill (`desk_target`), not the raw `program.desks`
        // (24) — regenerate still must not over-place past what the plate is asked
        // to hold. Frozen desks count toward it, so the top-up only fills the gap.
        let area = geometry::polygon_area(&poly_of(&doc));
        let target = desk_target(&program, area);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert!(desks <= target as usize, "over-placed past the effective target {target} (got {desks})");
    }

    // ---- Irregular-plate rigor (region pipeline + the user's real building) --

    const REAL_PLATE: [(f64, f64); 43] = [
        (7.75, 1.0), (15.25, 1.5), (15.25, 2.25), (14.25, 2.5),
        (14.5, 4.0), (18.5, 4.0), (18.75, 1.0), (24.75, 1.75),
        (26.0, 2.0), (26.25, 2.5), (27.5, 2.5), (27.75, 3.0),
        (31.75, 3.75), (33.25, 4.75), (34.5, 4.75), (34.75, 5.5),
        (37.0, 6.0), (37.25, 6.75), (38.5, 6.75), (38.5, 16.75),
        (24.0, 17.0), (24.0, 21.0), (27.25, 21.25), (27.25, 39.0),
        (28.75, 39.25), (30.5, 38.5), (30.75, 39.75), (18.5, 42.75),
        (12.75, 43.25), (10.75, 42.75), (10.75, 12.25), (11.5, 12.0),
        (11.5, 10.5), (10.25, 10.0), (11.5, 9.75), (11.5, 1.75),
        (7.5, 1.75), (7.5, 10.0), (1.0, 10.25), (1.0, 1.5),
        (1.5, 2.0), (4.0, 2.0), (4.25, 1.25),
    ];

    fn real_plate_doc() -> Document {
        room_from_corners(&REAL_PLATE)
    }

    /// LEAN, qbiq-DOMINANT rebalance (docs/design/testfit-pro-quality.md §1 +
    /// docs/reference/qbiq): with the FULL professional program (support_spaces
    /// on) on the user's real ~843 m² multi-wing plate, the open workstation field
    /// is the CLEAR majority — by seat count, by room count, AND by usable area.
    ///
    /// This is the test the lean recalibration is measured by. Before it, the
    /// derived program over-roomed the floor (booth N/12, focus N/30, 0.85 open
    /// share → ~28 support rooms eating ~40% of the plate, seating only ~52
    /// desks). The lean derive (booth N/25, focus N/60, collab ÷12,
    /// `SUPPORT_AREA_CAP`, 0.90 open share) lifted it to ~67; the room-
    /// CONCENTRATION rework (largest wing reserved as a PURE desk field, zero room
    /// band — see `allocate_rooms`) then removed the shallow room band that still
    /// ran the big wing's full length, lifting Balanced to a seed-stable ~76
    /// (Open ~80) while the support set stays a lean ~16 rooms in the small wings.
    ///
    /// Also the regression bar for the field-theft bugs this pipeline fixed:
    /// deep support rooms landing in the dominant wing's desk field, and a room
    /// band of ANY depth running the dominant wing — which used to crater the
    /// field below the room count (rooms outnumbering workstations, the opposite
    /// of a real office).
    #[test]
    fn real_plate_open_field_dominates_the_program() {
        let area = geometry::polygon_area(&poly_of(&real_plate_doc()));
        // The program a fresh professional fit derives for this plate (mirrors
        // the app's headcount-driven `suggestProgram`): headcount at 10 m²/person,
        // desks at the 0.90 open share, a MODEST meeting count (~1 per 17 people).
        let headcount = (area / 10.0).round() as u32;
        let mut program = Program::default();
        program.headcount = Some(headcount);
        program.desks = ((headcount as f64) * OPEN_SHARE).round() as u32;
        program.meeting_rooms = 5;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;

        let mut best_desks = 0usize;
        for seed in 1..=4u64 {
            let mut doc = real_plate_doc();
            generate(&mut doc, &program, seed, false);
            let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
            best_desks = best_desks.max(desks);
            let rooms = doc
                .zones
                .iter()
                .filter(|z| {
                    matches!(
                        z.zone_type,
                        ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration
                    )
                })
                .count();
            let meeting_seats: f64 = doc
                .zones
                .iter()
                .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::Collaboration))
                .map(|z| z.capacity() as f64)
                .sum();
            let seats = desks as f64 + meeting_seats;
            // Open desk field vs the rest of the PROGRAMMED (non-circulation,
            // non-core) floor — the qbiq "open dominates usable area" check.
            let ws_area: f64 = doc.zones.iter().filter(|z| z.zone_type == ZoneType::Workspace).map(|z| z.area()).sum();
            let usable: f64 = doc.zones.iter().filter(|z| !matches!(z.zone_type, ZoneType::Circulation | ZoneType::Core)).map(|z| z.area()).sum();

            // (a) OPEN-DESK DOMINANT by SEATS: workstations are the majority.
            assert!(
                desks as f64 > 0.6 * seats,
                "seed {seed}: workstations {desks} are not the majority of {seats:.0} seats"
            );
            // (b) OPEN-DESK DOMINANT by AREA: the open field keeps the majority of
            // usable floor (target ≥55% on a large plate; measured ~0.62 here).
            assert!(
                ws_area > 0.55 * usable,
                "seed {seed}: open field {ws_area:.0} m² is only {:.0}% of {usable:.0} m² usable (< 55%)",
                100.0 * ws_area / usable
            );
            // (c) OPEN-DESK DOMINANT by COUNT: far more workstations than rooms —
            // a lean support set, never the ~34-room field-eater (rooms < desks).
            assert!(
                (rooms as f64) < 0.6 * (desks as f64),
                "seed {seed}: {rooms} rooms is not a lean minority against {desks} workstations"
            );
            // (d) Every seed fills materially past the pre-concentration floor.
            // The room-concentration rework (largest wing reserved as a pure desk
            // field, no room band) lifted the seed-stable Balanced count from ~67
            // to ~76 on this plate, so the floor rises from 52 to 70.
            assert!(desks >= 70, "seed {seed}: only {desks} workstations on an 843 m² plate");
            // (e) Density in the professional band (seat-based m²/person, 8–12).
            let m2pp = area / seats;
            assert!(
                (8.0..=12.0).contains(&m2pp),
                "seed {seed}: {m2pp:.1} m²/seat outside the professional 8–12 band"
            );
            // (f) Rooms still placed AND sane — a real, lean support set.
            assert!(
                (12..=26).contains(&rooms),
                "seed {seed}: {rooms} rooms is not a sane lean professional support set"
            );
            // (g) Walkable.
            let circ = circulation::evaluate(&doc, &CirculationConfig::default());
            assert!(circ.score >= 54.0, "seed {seed}: circulation {:.1} < 54", circ.score);
            // (h) No overlaps, everything on the plate.
            assert_no_overlaps(&doc, "real plate full program");
            let poly = poly_of(&doc);
            for c in &doc.components {
                assert!(footprint_in_plate(c, &poly), "seed {seed}: {} escapes the plate", c.label);
            }
        }
        // (i) The candidate the app SHOWS (best of the seed gallery) seats a
        // materially higher count than the ~52 the pre-lean program managed and
        // the ~67 the pre-concentration field managed — the headline win of the
        // room-concentration rework (Balanced ~76 here; Open reaches ~80).
        assert!(
            best_desks >= 74,
            "best seed seated only {best_desks} workstations (< 74: concentration regressed)"
        );
    }

    /// The reserved wing's centroid, for pinning an entry INTO the dominant desk
    /// field so the field-boulevard path (spine-less region, `plan_region` entry
    /// branch) is exercised.
    fn dominant_field_center(doc: &Document) -> (f64, f64) {
        let poly = poly_of(doc);
        let holes: Vec<geometry::Rect> = Vec::new();
        let min_dim = REGION_MIN_DIM.max(2.0 * 1.2 + 0.8);
        let regions = geometry::decompose_plate(&poly, REGION_CELL, min_dim, REGION_MIN_AREA, &holes);
        let big = (0..regions.len())
            .max_by(|&a, &b| regions[a].area().partial_cmp(&regions[b].area()).unwrap())
            .unwrap();
        let r = &regions[big];
        ((r.x0 + r.x1) / 2.0, (r.y0 + r.y1) / 2.0)
    }

    /// DELIVERABLE 1+2+3 — the circulation NETWORK. On the real ~843 m² plate with
    /// the full professional program and an entry pinned into the dominant desk
    /// field, the walkable free space is ONE connected region, the network REACHES
    /// the entry, the reserved field carries a legible drawn SECONDARY aisle (the
    /// through-boulevard, not a dead-end stub), and the headline circulation score
    /// clears 60 — up from the ~50 the spine-less-field regression produced (the
    /// drop was a scoring artefact: the pervasive 0.9 m bench gaps were counted as
    /// sub-1.2 m corridor failures; the evaluator now scores connectivity, entry-
    /// reachability, genuine-pinch avoidance and corridor HIERARCHY instead).
    #[test]
    fn circulation_network_reaches_entry_with_no_dead_ends() {
        let area = geometry::polygon_area(&poly_of(&real_plate_doc()));
        let headcount = (area / 10.0).round() as u32;
        let mut program = Program::default();
        program.headcount = Some(headcount);
        program.desks = ((headcount as f64) * OPEN_SHARE).round() as u32;
        program.meeting_rooms = 5;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let (ex, ey) = dominant_field_center(&real_plate_doc());
        let mut cfg = CirculationConfig::default();
        cfg.target_corridor_width = program.target_corridor_m; // 1.2, the app's target

        for seed in 1..=4u64 {
            let mut doc = real_plate_doc();
            doc.entries.push(Point::new(ex, ey));
            generate(&mut doc, &program, seed, false);
            let s = circulation::evaluate(&doc, &cfg);

            // One connected walkable region that the network reaches from the door.
            assert!(
                s.largest_connected_free_region >= 0.98,
                "seed {seed}: free space fragments (largest region {:.3})",
                s.largest_connected_free_region
            );
            assert!(
                s.entry_reachable_fraction >= 0.98,
                "seed {seed}: network fails to reach the entry ({:.3})",
                s.entry_reachable_fraction
            );
            // Restored to a professional score (was ~50 spine-less).
            assert!(s.score >= 60.0, "seed {seed}: circulation {:.1} < 60", s.score);

            // The reserved desk field carries a DRAWN secondary aisle — a real
            // through-run (> 5 m, not the retired 2.5 m dead-end stub), ~1.15 m
            // wide (IBC secondary) — tying it into the primary-spine network.
            let entry_aisles: Vec<(f64, f64)> = doc
                .zones
                .iter()
                .filter(|z| z.zone_type == ZoneType::Circulation && z.label == "Entry")
                .map(|z| {
                    let (x0, y0, x1, y1) = z.shape.bbox();
                    ((x1 - x0).abs(), (y1 - y0).abs())
                })
                .collect();
            assert!(
                entry_aisles.iter().any(|&(w, h)| {
                    let (short, long) = (w.min(h), w.max(h));
                    (0.9..=1.4).contains(&short) && long > 5.0
                }),
                "seed {seed}: no full-length secondary boulevard in the desk field: {entry_aisles:?}"
            );
        }
    }

    /// DELIVERABLE 3 — the score holds ≥55 on the fixtures at the app's 1.2 m
    /// corridor target: a single-region plate (band + 1.5 m spine + desk field)
    /// and the L-plate. Guards against the scoring rework over-penalising the
    /// legitimate 0.9 m bench gaps a dense fixture carries.
    #[test]
    fn fixture_circulation_holds_above_55() {
        let mut program = Program::default();
        program.support_spaces = false;
        program.desks = 30;
        program.meeting_rooms = 2;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let mut cfg = CirculationConfig::default();
        cfg.target_corridor_width = program.target_corridor_m;
        for (label, mut doc) in [("rect 30x20", room(30.0, 20.0)), ("L-plate", l_room())] {
            for seed in 1..=3u64 {
                generate(&mut doc, &program, seed, false);
                let s = circulation::evaluate(&doc, &cfg);
                assert!(
                    s.score >= 55.0,
                    "{label} seed {seed}: circulation {:.1} < 55 (conn {:.2}, cover {:.2}, minw {:.2})",
                    s.score, s.largest_connected_free_region, s.corridor_coverage, s.min_corridor_width
                );
            }
        }
    }

    /// DELIVERABLE 4a — focus rooms sit ON the facade (daylight), nearer it than
    /// the meeting rooms. `Window` placement pins them to the facade-band wing +
    /// slot, and `place_in_band` REAR-aligns them onto the boundary wall — the
    /// geometric rule that makes the M7 inequality hold on a feasible plate (a
    /// front-aligned shallow focus room would float in the band middle, away from
    /// the window). Gated to a plate that actually derives both room types.
    #[test]
    fn focus_rooms_hug_the_facade_nearer_than_meetings() {
        let mut program = Program::default();
        program.headcount = Some(64); // → 2 focus (ceil 64/60) + the 2 meetings
        program.meeting_rooms = 2;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let mut doc = room(40.0, 16.0);
        generate(&mut doc, &program, 1, false);
        let poly = poly_of(&doc);
        let focus: Vec<(f64, f64)> = doc
            .zones
            .iter()
            .filter(|z| z.label.starts_with("Focus"))
            .map(zone_bbox_center)
            .collect();
        let meetings: Vec<(f64, f64)> = doc
            .zones
            .iter()
            .filter(|z| z.zone_type == ZoneType::Meeting)
            .map(zone_bbox_center)
            .collect();
        // Feasibility gate: only judge when the plate carries both room types.
        assert!(!focus.is_empty(), "test plate derived no focus rooms");
        assert!(!meetings.is_empty(), "test plate derived no meeting rooms");
        let avg = |v: &[(f64, f64)]| -> f64 {
            v.iter().map(|&(x, y)| dist_to_facade(x, y, Some(&poly))).sum::<f64>() / v.len() as f64
        };
        let (df, dm) = (avg(&focus), avg(&meetings));
        assert!(
            df < dm,
            "focus rooms ({df:.2} m to facade) are not nearer the facade than meetings ({dm:.2} m)"
        );
    }

    /// ROOM CONCENTRATION (the field-first rework): on the real multi-wing plate
    /// the plate's LARGEST wing is reserved as a PURE open desk field — no support
    /// room ever bands into it — and the support program concentrates into the
    /// SMALLER wings. This is the mechanism that lifted the workstation count from
    /// ~54/~67 to ~76 (Balanced) / ~80 (Open): a room band of any depth running
    /// the dominant wing's full length cost it whole desk columns.
    ///
    /// Mirrors qbiq's Crystal Tower reference (docs/reference/qbiq): rooms hug the
    /// core, open desks fill the largest perimeter wing uninterrupted.
    #[test]
    fn largest_wing_is_a_pure_desk_field_rooms_concentrate() {
        let doc0 = real_plate_doc();
        let poly = geometry::trace_floor_polygon(&wall_segments(&doc0), geometry::LOOP_SNAP_TOL).unwrap();
        let area = geometry::polygon_area(&poly);
        let holes: Vec<geometry::Rect> = Vec::new();
        let corridor = 1.2;
        let min_dim = REGION_MIN_DIM.max(2.0 * corridor + 0.8);
        let regions = geometry::decompose_plate(&poly, REGION_CELL, min_dim, REGION_MIN_AREA, &holes);
        assert!(regions.len() >= 2, "real plate must decompose into multiple wings");
        let big = (0..regions.len())
            .max_by(|&a, &b| regions[a].area().partial_cmp(&regions[b].area()).unwrap())
            .unwrap();
        let br = &regions[big];
        // The reserved wing is genuinely dominant (a real "one big field").
        let total: f64 = regions.iter().map(|r| r.area()).sum();
        assert!(br.area() > 0.4 * total, "largest wing is not clearly dominant");

        let headcount = (area / 10.0).round() as u32;
        let inside = |cx: f64, cy: f64| cx >= br.x0 && cx <= br.x1 && cy >= br.y0 && cy <= br.y1;

        for strat in [Strategy::Balanced, Strategy::Open] {
            let mut best = 0usize;
            for seed in 1..=4u64 {
                let mut program = Program::default();
                program.strategy = strat;
                program.headcount = Some(headcount);
                program.meeting_rooms = 5;
                program.meeting_w = 3.0;
                program.meeting_h = 3.0;
                let mut doc = real_plate_doc();
                generate(&mut doc, &program, seed, false);

                let room_zones: Vec<&Zone> = doc
                    .zones
                    .iter()
                    .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration))
                    .collect();
                // (a) NO room zone intersects the reserved desk wing — it is
                // desk-only, the invariant the whole rework turns on.
                for z in &room_zones {
                    let (cx, cy) = zone_bbox_center(z);
                    assert!(!inside(cx, cy), "{:?} seed {seed}: room '{}' landed in the reserved desk wing", strat, z.label);
                }
                // (b) The reserved wing holds the STRICT MAJORITY of desks — the
                // open field really is concentrated there, not scattered.
                let (mut big_desks, mut total_desks) = (0usize, 0usize);
                for c in doc.components.iter().filter(|c| c.category == "Desk") {
                    total_desks += 1;
                    if inside(c.x, c.y) { big_desks += 1; }
                }
                assert!(
                    big_desks * 2 > total_desks,
                    "{strat:?} seed {seed}: reserved wing holds only {big_desks}/{total_desks} desks (not the majority)"
                );
                // (c) Rooms concentrate into a MINORITY of the wings (≤ the wings
                // that are NOT the reserved desk field).
                let wings_with_rooms = (0..regions.len())
                    .filter(|&ri| {
                        ri != big
                            && room_zones.iter().any(|z| {
                                let (cx, cy) = zone_bbox_center(z);
                                cx >= regions[ri].x0 && cx <= regions[ri].x1 && cy >= regions[ri].y0 && cy <= regions[ri].y1
                            })
                    })
                    .count();
                assert!(
                    wings_with_rooms <= regions.len() - 1,
                    "{strat:?} seed {seed}: rooms not concentrated (in {wings_with_rooms} room-wings)"
                );
                assert!(!room_zones.is_empty(), "{:?} seed {seed}: the support program vanished", strat);

                // (d) Density in the professional band + walkable + on-plate.
                let meeting_seats: f64 = doc.zones.iter().filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::Collaboration)).map(|z| z.capacity() as f64).sum();
                let seats = total_desks as f64 + meeting_seats;
                let m2pp = area / seats;
                assert!((8.0..=12.0).contains(&m2pp), "{:?} seed {seed}: {m2pp:.1} m²/seat outside 8–12", strat);
                let circ = circulation::evaluate(&doc, &CirculationConfig::default()).score;
                assert!(circ >= 54.0, "{:?} seed {seed}: circulation {circ:.1} < 54", strat);
                assert_no_overlaps(&doc, "concentration");
                let pl = poly_of(&doc);
                for c in &doc.components {
                    assert!(footprint_in_plate(c, &pl), "{:?} seed {seed}: {} escapes the plate", strat, c.label);
                }
                best = best.max(total_desks);
            }
            // (e) The reserved-field win is materially higher than the ~54/~67 the
            // banded-dominant-wing plans managed.
            let floor = if strat == Strategy::Open { 78 } else { 74 };
            assert!(best >= floor, "{:?}: best only {best} workstations (< {floor})", strat);
        }
    }

    // ---- M7: strategy-distinct A/B/C alternatives ---------------------------

    /// The best-of-seeds (desks, enclosed offices, total rooms) a strategy fits
    /// onto the real plate — the numbers the gallery's A/B/C actually show.
    fn strategy_fit(strat: Strategy) -> (usize, usize, usize) {
        let area = geometry::polygon_area(&poly_of(&real_plate_doc()));
        let headcount = (area / 10.0).round() as u32;
        let mut best = (0usize, 0usize, 0usize);
        for seed in 1..=6u64 {
            let mut program = Program::default();
            program.strategy = strat;
            program.headcount = Some(headcount);
            program.meeting_rooms = 5;
            program.meeting_w = 3.0;
            program.meeting_h = 3.0;
            let mut doc = real_plate_doc();
            generate(&mut doc, &program, seed, false);
            let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
            let rooms = doc
                .zones
                .iter()
                .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration))
                .count();
            let offices = doc.zones.iter().filter(|z| z.zone_type == ZoneType::ClosedOffice).count();
            if desks > best.0 {
                best = (desks, offices, rooms);
            }
        }
        best
    }

    /// The three strategies produce STRUCTURALLY DISTINCT plans on the real plate
    /// — not seed-noise. Open maximises the open desk field with minimal
    /// enclosure; Cellular is privacy-forward (more enclosed offices, fewer
    /// desks); Balanced sits between. This is the flagship "smarter test-fit"
    /// differentiator (qbiq's A/B/C differ in offices/seats the same way).
    ///
    /// EVOLVED with the room-concentration rework (largest wing reserved as a
    /// pure desk field): the primary distinctness signal is now the DESK FIELD
    /// SIZE — Open fills the reserved wing hardest (80), Cellular gives most of
    /// the headcount to rooms (61), a 19-desk spread (was ~14). The DELIVERED
    /// office magnitude COMPRESSED (Open 4 / Balanced 7 / Cellular 8, was
    /// 5/10/19): rooms now concentrate into the small room-wings, whose banded
    /// capacity is bounded, so Cellular's extra derived cabins partly overflow
    /// rather than all landing as offices. Offices still increase monotonically
    /// with enclosure; the assertion tracks that reality (strict monotonic
    /// desks + offices, with a realistic office delta) instead of the old
    /// pre-concentration +5 magnitude.
    #[test]
    fn strategies_are_structurally_distinct() {
        let (open_d, open_o, _) = strategy_fit(Strategy::Open);
        let (bal_d, bal_o, _) = strategy_fit(Strategy::Balanced);
        let (cell_d, cell_o, _) = strategy_fit(Strategy::Cellular);

        // Open seats materially MORE workstations than Cellular (the density
        // trade-off the user picks between) — the headline distinctness signal,
        // now a wide ~19-desk spread from reserving the biggest wing for Open.
        assert!(
            open_d >= cell_d + 8,
            "Open ({open_d} desks) must seat materially more than Cellular ({cell_d})"
        );
        assert!(bal_d > cell_d && bal_d < open_d, "Balanced desks {bal_d} should sit between Cellular {cell_d} and Open {open_d}");
        // Cellular is privacy-forward: MORE enclosed offices than Open. The
        // delivered delta is realistic (room-wing capacity bounds the count),
        // but still materially more enclosed.
        assert!(
            cell_o >= open_o + 3,
            "Cellular ({cell_o} offices) must be materially more enclosed than Open ({open_o})"
        );
        assert!(bal_o > open_o && bal_o <= cell_o, "Balanced offices {bal_o} should sit between Open {open_o} and Cellular {cell_o}");
    }

    /// The DERIVED program mix shifts with strategy: Open pushes the open share
    /// up (more desks) and thins the cellular families (cabins/focus); Cellular
    /// does the reverse. Balanced is the pre-M7 identity table.
    #[test]
    fn derive_mix_shifts_with_strategy() {
        let area = 1500.0;
        let n = 100usize;
        let derive_for = |strat: Strategy| {
            let mut p = Program::default();
            p.strategy = strat;
            let sp = SpaceProgram::derive(n, area, program_open_share(&p), program_cellular_mult(&p), program_support_cap(&p));
            let cab = sp.reqs.iter().filter(|r| r.kind == SpaceKind::Cabin).map(|r| r.count).sum::<u32>();
            (sp.desks, cab)
        };
        let (open_desks, open_cab) = derive_for(Strategy::Open);
        let (bal_desks, bal_cab) = derive_for(Strategy::Balanced);
        let (cell_desks, cell_cab) = derive_for(Strategy::Cellular);
        // Balanced identity: desks = ceil(OPEN_SHARE·N), cabins = ceil(N/25).
        assert_eq!(bal_desks, ((n as f64) * OPEN_SHARE).ceil() as u32);
        assert_eq!(bal_cab, (n as u32).div_ceil(25));
        // Open: more desks, fewer cabins than Balanced.
        assert!(open_desks > bal_desks && open_cab < bal_cab, "Open should out-desk and under-cabin Balanced");
        // Cellular: fewer desks, more cabins than Balanced.
        assert!(cell_desks < bal_desks && cell_cab > bal_cab, "Cellular should under-desk and over-cabin Balanced");
    }

    /// An EXPLICIT room program (the Detailed builder) is honoured verbatim: the
    /// strategy must NOT override the counts. All three strategies place the same
    /// enclosed-room count; the strategy then only steers scoring + the search.
    #[test]
    fn explicit_program_overrides_strategy_counts() {
        let rooms = vec![
            RoomReq { kind: SpaceKind::Cabin, count: 3, w: None, d: None, placement: Placement::Flexible },
            RoomReq { kind: SpaceKind::Meeting, count: 2, w: None, d: None, placement: Placement::Flexible },
        ];
        let count_offices = |strat: Strategy| {
            let mut program = Program::default();
            program.strategy = strat;
            program.rooms = rooms.clone();
            let mut doc = room(30.0, 20.0);
            generate(&mut doc, &program, 3, false);
            let cabins = doc.zones.iter().filter(|z| z.label.starts_with("Cabin")).count();
            let meetings = doc.zones.iter().filter(|z| z.zone_type == ZoneType::Meeting).count();
            (cabins, meetings)
        };
        let open = count_offices(Strategy::Open);
        let bal = count_offices(Strategy::Balanced);
        let cell = count_offices(Strategy::Cellular);
        assert_eq!(open, bal, "explicit counts must not vary with strategy");
        assert_eq!(bal, cell, "explicit counts must not vary with strategy");
        assert_eq!(bal, (3, 2), "explicit program placed its exact requested rooms");
    }

    /// Determinism is per (strategy, seed): same pair → byte-identical layout;
    /// different strategy at the same seed → a genuinely different plan.
    #[test]
    fn strategy_determinism_and_divergence() {
        let gen = |strat: Strategy, seed: u64| {
            let mut program = Program::default();
            program.strategy = strat;
            program.headcount = Some(80);
            let mut doc = room(36.0, 24.0);
            generate(&mut doc, &program, seed, false);
            doc.components
                .iter()
                .filter(|c| c.category == "Desk")
                .count()
        };
        // Same (strategy, seed) is reproducible.
        assert_eq!(gen(Strategy::Cellular, 4), gen(Strategy::Cellular, 4));
        assert_eq!(gen(Strategy::Open, 2), gen(Strategy::Open, 2));
        // Open seats more desks than Cellular at the same seed (structural, not noise).
        assert!(gen(Strategy::Open, 2) > gen(Strategy::Cellular, 2), "Open should out-seat Cellular at the same seed");
    }

    /// Adjacency relationship: on a plate WITH an entry, the meeting/conference
    /// family clusters in the ENTRY wing (client-facing), the relationship a
    /// senior planner places by (spec §3) — not scattered to the smallest wing.
    #[test]
    fn meetings_cluster_in_the_entry_wing() {
        // L-plate: a dominant 28×8 bottom field wing (area 224) + a deeper 12×10
        // upper-left wing (area 120, x<12 & y>8 — smaller, and NOT a reserved
        // field region). The entry sits in that upper wing, so the meeting/
        // conference family clusters THERE (client-facing) — the placement bias
        // in `allocate_rooms` — instead of scattering to the smallest-wing default.
        let mut doc = room_from_corners(&[
            (0.0, 0.0),
            (28.0, 0.0),
            (28.0, 8.0),
            (12.0, 8.0),
            (12.0, 18.0),
            (0.0, 18.0),
        ]);
        doc.entries.push(Point::new(2.0, 16.0));
        let mut program = Program::default();
        // Isolate the meeting↔entry relationship from the support program (so the
        // small entry wing isn't also contested by reception/cabins): the meeting
        // override honours the bias regardless of `support_spaces`.
        program.support_spaces = false;
        program.headcount = Some(45);
        program.meeting_rooms = 2;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        generate(&mut doc, &program, 3, false);
        let e = doc.entries[0];
        let meetings: Vec<(f64, f64)> = doc
            .zones
            .iter()
            .filter(|z| z.zone_type == ZoneType::Meeting)
            .map(zone_bbox_center)
            .collect();
        assert!(!meetings.is_empty(), "meetings were placed");
        // The majority of meetings land in the entry wing (client-facing cluster).
        let in_entry_wing = meetings.iter().filter(|&&(x, y)| x < 12.0 && y > 8.0).count();
        assert!(
            in_entry_wing * 2 >= meetings.len(),
            "only {in_entry_wing}/{} meetings clustered in the entry wing",
            meetings.len()
        );
        // And they sit, on average, in a tight client-facing cluster near the entry.
        let avg_m = meetings
            .iter()
            .map(|&(x, y)| ((x - e.x).powi(2) + (y - e.y).powi(2)).sqrt())
            .sum::<f64>()
            / meetings.len() as f64;
        assert!(avg_m < 12.0, "meetings averaged {avg_m:.1} m from the entry (expected a tight cluster)");
        // The relationship-adjacency sub-score is well-defined and bounded here.
        let s = score(&doc, &program);
        assert!((0.0..=100.0).contains(&s.adjacency), "adjacency {} out of range", s.adjacency);
    }

    fn poly_of(doc: &Document) -> Vec<Point> {
        let segs: Vec<(Point, Point)> = doc.walls.iter().map(|w| (w.a, w.b)).collect();
        geometry::trace_floor_polygon(&segs, geometry::LOOP_SNAP_TOL).expect("plate loop")
    }

    /// All 9 sample points (corners, edge midpoints, center) of the WORLD
    /// footprint (rotation-aware — portrait desks are ±π/2) inside the plate.
    fn footprint_in_plate(c: &crate::model::Component, poly: &[Point]) -> bool {
        let (ww, wh) = world_extents(c.w, c.h, c.rotation);
        let xs = [c.x - ww / 2.0, c.x, c.x + ww / 2.0];
        let ys = [c.y - wh / 2.0, c.y, c.y + wh / 2.0];
        xs.iter().all(|&px| ys.iter().all(|&py| geometry::point_in_polygon(px, py, poly)))
    }

    fn footprints_overlap(a: &crate::model::Component, b: &crate::model::Component) -> bool {
        let (aw, ah) = world_extents(a.w, a.h, a.rotation);
        let (bw, bh) = world_extents(b.w, b.h, b.rotation);
        (a.x - b.x).abs() < (aw + bw) / 2.0 - 1e-6
            && (a.y - b.y).abs() < (ah + bh) / 2.0 - 1e-6
    }

    fn assert_no_overlaps(doc: &Document, ctx: &str) {
        for i in 0..doc.components.len() {
            for j in (i + 1)..doc.components.len() {
                assert!(
                    !footprints_overlap(&doc.components[i], &doc.components[j]),
                    "{ctx}: {} overlaps {}",
                    doc.components[i].label,
                    doc.components[j].label
                );
            }
        }
    }

    #[test]
    fn l_plate_fills_both_wings() {
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 30;
        program.meeting_rooms = 2;
        program.meeting_w = 3.0; // the app's DEFAULT_PROGRAM footprint
        program.meeting_h = 3.0;
        let mut doc = l_room();
        generate(&mut doc, &program, 3, false);
        let poly = poly_of(&doc);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        // M4 regime: each wing spends a 1.5 m primary spine in front of its
        // meeting band and a 0.9 m facade daylight gap (spec 3), so the plate
        // seats fewer but better-organised desks than the retired perimeter-ring
        // regime (~18 across seeds here vs the old 25-29). The bar tracks the new
        // reality; the point of THIS test - BOTH wings fill - is unchanged.
        assert!(desks.len() >= 16, "placed only {} of 30 desks", desks.len());
        // The L = a 20x8 bottom band + a 12x6 upper-left wing. BOTH must fill.
        let in_band = desks.iter().filter(|c| c.y < 8.0).count();
        let in_wing = desks.iter().filter(|c| c.y > 8.0 && c.x < 12.0).count();
        assert!(in_band >= 5, "bottom band has only {in_band} desks");
        assert!(in_wing >= 5, "upper-left wing has only {in_wing} desks");
        for c in &doc.components {
            assert!(footprint_in_plate(c, &poly), "{} escapes the plate", c.label);
        }
        assert_no_overlaps(&doc, "l_plate");
    }

    #[test]
    fn l_plate_circulation_quality() {
        // Aisle semantics: bench PAIRS touch at a 0.0 m spine (no walkable cell
        // between them, so no bogus min-corridor), and the aisle between pairs is
        // pitched at desk_clearance_m by design — so the narrowest measured passage
        // is an access AISLE (>= clearance); egress corridors (>= target) come from
        // the per-region rings. The shared global lattice keeps aisles from eroding.
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 30;
        program.meeting_rooms = 2;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let mut doc = l_room();
        generate(&mut doc, &program, 3, false);
        let score = circulation::evaluate(&doc, &CirculationConfig::default());
        assert!(
            score.min_corridor_width >= 0.95 * program.desk_clearance_m,
            "narrowest aisle {:.2} m eroded below the {:.2} m clearance",
            score.min_corridor_width,
            program.desk_clearance_m
        );
        assert!(score.score >= 55.0, "circulation score {:.1} < 55", score.score);
    }

    #[test]
    fn real_building_plate_spreads_the_program() {
        // The exact plate the user's DWG traces to: 843 m2, multiple wings,
        // diagonal glazing edges - the case the old bbox packer failed on.
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 60;
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        for seed in 1..=3u64 {
            let mut doc = real_plate_doc();
            let t0 = std::time::Instant::now();
            generate(&mut doc, &program, seed, false);
            let ms = t0.elapsed().as_millis();
            assert!(ms < 150, "seed {seed}: generate took {ms} ms (debug budget 150)");

            let poly = poly_of(&doc);
            let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
            let meetings = meeting_room_count(&doc);
            // Seam-shared corridors + capacity-aware cluster aisles fill the
            // whole program (60/60) on this plate; 52 leaves headroom (was 45).
            assert!(desks.len() >= 52, "seed {seed}: placed {} of 60 desks", desks.len());
            assert!(meetings >= 3, "seed {seed}: only {meetings} of 4 meeting rooms");
            for c in &doc.components {
                assert!(footprint_in_plate(c, &poly), "seed {seed}: {} escapes", c.label);
            }
            assert_no_overlaps(&doc, "real plate");
            // M1 rigor extension: every room on the real plate is a true
            // enclosure — partitions + one 0.9 m door gap + glazed front.
            for &(x, y, w, h) in &meeting_rects(&doc) {
                assert_room_enclosed(&doc, x, y, w, h, &format!("real plate seed {seed}"));
            }

            // Circulation stays walkable. The narrowest passage is plate-inherent
            // (this real building has a ~0.30 m structural neck present even with
            // ZERO furniture), so only the aggregate score is asserted here — the
            // desk-to-desk aisle guarantee is covered by l_plate_circulation_quality.
            let circ = circulation::evaluate(&doc, &CirculationConfig::default());
            assert!(circ.score >= 55.0, "seed {seed}: circulation score {:.1} < 55", circ.score);

            // Spread: the desk field must span the building, not clump in one
            // wing - its bbox covers >=55% of the plate bbox on x and >=60% on
            // y. The x bar was 60% pre-M2: the 6.5 m west annex then seated 2-3
            // desks via the (banned) half-pitch infill + off-module jitter. With
            // the 0.05 m module + one global lattice (testfit-pro-quality.md
            // §4.1/§4.5 — professional alignment beats squeezing stragglers into
            // misaligned slots), the annex hosts its meeting room only, so the
            // desk field legitimately spans just the two structural wings
            // (x centers ~13.1→36.5 of a 37.5 m plate, ~56-58% across seeds).
            let (px0, py0, px1, py1) = poly.iter().fold(
                (f64::MAX, f64::MAX, f64::MIN, f64::MIN),
                |(a, b, c2, d), p| (a.min(p.x), b.min(p.y), c2.max(p.x), d.max(p.y)),
            );
            let (dx0, dy0, dx1, dy1) = desks.iter().fold(
                (f64::MAX, f64::MAX, f64::MIN, f64::MIN),
                |(a, b, c2, d), k| (a.min(k.x), b.min(k.y), c2.max(k.x), d.max(k.y)),
            );
            assert!(
                (dx1 - dx0) >= 0.55 * (px1 - px0),
                "seed {seed}: desk spread x {:.1} of {:.1}",
                dx1 - dx0,
                px1 - px0
            );
            assert!(
                (dy1 - dy0) >= 0.6 * (py1 - py0),
                "seed {seed}: desk spread y {:.1} of {:.1}",
                dy1 - dy0,
                py1 - py0
            );

            // Deterministic: same seed twice -> identical layout.
            let mut again = real_plate_doc();
            generate(&mut again, &program, seed, false);
            assert_eq!(doc.components.len(), again.components.len());
            for (a, b) in doc.components.iter().zip(again.components.iter()) {
                assert_eq!(
                    (a.category.as_str(), a.x.to_bits(), a.y.to_bits()),
                    (b.category.as_str(), b.x.to_bits(), b.y.to_bits())
                );
            }
        }
    }

    // ---- Interior keep-outs (building core) -------------------------------

    /// True if component `c`'s WORLD footprint intersects rect (center `kx,ky`, `kw×kh`).
    fn intersects(c: &crate::model::Component, kx: f64, ky: f64, kw: f64, kh: f64) -> bool {
        let (cw, ch) = world_extents(c.w, c.h, c.rotation);
        (c.x - kx).abs() < (cw + kw) / 2.0 - 1e-9 && (c.y - ky).abs() < (ch + kh) / 2.0 - 1e-9
    }

    #[test]
    fn keepout_blocks_furniture_and_emits_core_zone() {
        // Capacity-bound program (asks for far more desks than the room seats) so
        // the keep-out's blocked core measurably lowers the placed count.
        let mut program = Program::default();
        program.desks = 100;
        program.meeting_rooms = 0;
        // Baseline capacity with no keep-out.
        let mut base = room(20.0, 15.0);
        generate(&mut base, &program, 7, false);
        let base_desks = base.components.iter().filter(|c| c.category == "Desk").count();

        // Same room with a 3×3 keep-out dead center.
        let mut doc = room(20.0, 15.0);
        doc.keepouts.push(crate::model::KeepOut {
            id: 900, x: 10.0, y: 7.5, w: 3.0, h: 3.0, label: "Stair".into(),
        });
        generate(&mut doc, &program, 7, false);

        // (a) Not one component footprint intersects the keep-out.
        for c in &doc.components {
            assert!(!intersects(c, 10.0, 7.5, 3.0, 3.0), "{} sits in the keep-out", c.label);
        }
        // (b) A Core zone with the keep-out's label + footprint exists (distinct
        // from the meeting-column Core bands the tile path also emits).
        let core = doc
            .zones
            .iter()
            .find(|z| z.zone_type == ZoneType::Core && z.label == "Stair")
            .expect("a Core zone for the keep-out");
        match core.shape {
            ZoneShape::Rect { x, y, w, h } => assert!(
                (x - 10.0).abs() < 1e-9 && (y - 7.5).abs() < 1e-9
                    && (w - 3.0).abs() < 1e-9 && (h - 3.0).abs() < 1e-9
            ),
            _ => panic!("Core zone should be a Rect"),
        }
        // (c) Capacity drops — the blocked core seats fewer desks.
        let ko_desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert!(
            ko_desks < base_desks,
            "keep-out should reduce capacity ({ko_desks} placed vs {base_desks} baseline)"
        );
    }

    #[test]
    fn real_plate_with_keepouts_still_meets_rigor() {
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 60;
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        // Two plausible core rects inside the plate's lower wing.
        let kos = [(14.0, 36.0, 2.5, 2.5), (20.0, 38.0, 2.5, 2.5)];
        for seed in 1..=3u64 {
            let mut doc = real_plate_doc();
            let poly0 = poly_of(&doc);
            for &(x, y, _, _) in &kos {
                assert!(geometry::point_in_polygon(x, y, &poly0), "keep-out ({x},{y}) not inside plate");
            }
            for (i, &(x, y, w, h)) in kos.iter().enumerate() {
                doc.keepouts.push(crate::model::KeepOut {
                    id: 1000 + i as u32, x, y, w, h, label: format!("Core {i}"),
                });
            }
            generate(&mut doc, &program, seed, false);

            let poly = poly_of(&doc);
            let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
            let meetings = meeting_room_count(&doc);
            // Rigor still holds with two keep-outs removing ~12 m² of core.
            assert!(desks.len() >= 52, "seed {seed}: only {} desks with keep-outs", desks.len());
            assert!(meetings >= 3, "seed {seed}: only {meetings} meeting rooms");
            for c in &doc.components {
                assert!(footprint_in_plate(c, &poly), "seed {seed}: {} escapes plate", c.label);
                for &(kx, ky, kw, kh) in &kos {
                    assert!(!intersects(c, kx, ky, kw, kh),
                        "seed {seed}: {} sits in the keep-out at ({kx},{ky})", c.label);
                }
            }
            assert_no_overlaps(&doc, "real plate + keep-outs");
            // One Core zone per keep-out.
            let cores = doc.zones.iter().filter(|z| z.zone_type == ZoneType::Core).count();
            assert_eq!(cores, kos.len(), "seed {seed}: expected {} Core zones, got {cores}", kos.len());
        }
    }

    // ---- Bench-pair desking + global lattice (round 3) --------------------

    /// Desks in a bench pair alternate rotation 0 / π, sit SPINE_GAP apart at the
    /// shared spine, and the aisle BETWEEN pairs is a full clearance.
    #[test]
    fn bench_pairs_alternate_rotation() {
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 40;
        program.meeting_rooms = 0; // keep the field clean of a meeting column
        program.cluster_cols = 100; // no inner cluster aisles to interleave
        assert!(program.bench_pairs, "bench pairing is the default");
        let mut doc = room(20.0, 15.0); // landscape → rows pair along Y
        generate(&mut doc, &program, 5, false);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        assert!(desks.len() >= 8, "need several rows to see pairs");

        // Both orientations must appear.
        let flat = desks.iter().filter(|c| c.rotation.abs() < 1e-9).count();
        let flipped = desks.iter().filter(|c| (c.rotation - std::f64::consts::PI).abs() < 1e-9).count();
        assert!(flat > 0 && flipped > 0, "expected both 0 and π rows, got {flat}/{flipped}");
        // Every desk is exactly one of the two orientations.
        for c in &desks {
            assert!(
                c.rotation.abs() < 1e-9 || (c.rotation - std::f64::consts::PI).abs() < 1e-9,
                "unexpected rotation {}",
                c.rotation
            );
        }

        // Take the fullest column (desks sharing an x line) and read its rows.
        use std::collections::BTreeMap;
        let mut cols: BTreeMap<i64, Vec<&&Component>> = BTreeMap::new();
        for c in &desks {
            cols.entry((c.x * 1000.0).round() as i64).or_default().push(c);
        }
        let mut col = cols.into_values().max_by_key(|v| v.len()).unwrap();
        col.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap());
        assert!(col.len() >= 4, "need ≥2 pairs in a column, got {}", col.len());

        let desk_h = program.desk_h;
        let clear = program.desk_clearance_m;
        // Row 0 flat, row 1 flipped (the pair), spine gap == SPINE_GAP.
        assert!(col[0].rotation.abs() < 1e-9, "row 0 should be un-rotated");
        assert!((col[1].rotation - std::f64::consts::PI).abs() < 1e-9, "row 1 should be π");
        let spine = (col[1].y - col[0].y) - desk_h;
        assert!((spine - SPINE_GAP).abs() < 1e-6, "spine gap {spine:.3} != {SPINE_GAP}");
        // Aisle between the pair and the next pair is ≥ a full clearance.
        let aisle = (col[2].y - col[1].y) - desk_h;
        assert!(aisle >= clear - 1e-6, "pair aisle {aisle:.3} < clearance {clear}");
        assert!(col[2].rotation.abs() < 1e-9, "next pair starts un-rotated");
    }

    /// With `bench_pairs = false` the generator falls back to uniform single rows:
    /// zero π rotations and a constant `desk_h + clear` row pitch.
    #[test]
    fn bench_pairs_false_reproduces_single_rows() {
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 40;
        program.meeting_rooms = 0;
        program.cluster_cols = 100;
        program.bench_pairs = false;
        let mut doc = room(20.0, 15.0);
        generate(&mut doc, &program, 5, false);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        assert!(desks.len() >= 8);

        // No desk is flipped.
        for c in &desks {
            assert!(c.rotation.abs() < 1e-9, "single rows must not rotate: {}", c.rotation);
        }
        // Old pitch: every consecutive gap in a column is desk_h + clear (no spine).
        use std::collections::BTreeMap;
        let mut cols: BTreeMap<i64, Vec<&&Component>> = BTreeMap::new();
        for c in &desks {
            cols.entry((c.x * 1000.0).round() as i64).or_default().push(c);
        }
        let mut col = cols.into_values().max_by_key(|v| v.len()).unwrap();
        col.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap());
        assert!(col.len() >= 3);
        let pitch_y = program.desk_h + program.desk_clearance_m;
        for w in col.windows(2) {
            let gap = w[1].y - w[0].y;
            assert!((gap - pitch_y).abs() < 1e-6, "row pitch {gap:.3} != single-row {pitch_y:.3}");
        }
    }

    /// Regions of one plate anchor their desk grids to the SAME global lattice:
    /// within an orientation class (landscape 0/π vs portrait ±π/2 — each has
    /// its own world pitches), every desk lies on shared lines modulo pitch.
    #[test]
    fn regions_share_the_global_lattice() {
        // The L-plate decomposes into the tall left leg [0,12]×[0,14] (portrait
        // → ±π/2 desks) and the bottom-right leg [12,20]×[0,8] (landscape).
        // bench off + no cluster aisles leaves a pure pitch lattice per class.
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 10;
        program.meeting_rooms = 0;
        program.cluster_cols = 100;
        program.bench_pairs = false;
        let mut doc = l_room();
        generate(&mut doc, &program, 3, false);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        // Both regions are populated (left leg at x<12, bottom-right at x>12).
        let leg = desks.iter().filter(|c| c.x < 12.0).count();
        let band = desks.iter().filter(|c| c.x > 12.0).count();
        assert!(leg > 0 && band > 0, "need desks in both regions (leg {leg}, band {band})");

        let clear = program.desk_clearance_m;
        for class in [0.0, std::f64::consts::FRAC_PI_2] {
            let members: Vec<_> = desks
                .iter()
                .filter(|c| ((c.rotation - class).rem_euclid(std::f64::consts::PI)).abs() < 1e-9)
                .collect();
            if members.len() < 2 {
                continue;
            }
            // World pitches for this orientation class.
            let (ww, wh) = world_extents(program.desk_w, program.desk_h, class);
            let (pitch_x, pitch_y) = (ww + clear, wh + clear);
            let x0 = members.iter().map(|c| c.x).fold(f64::MAX, f64::min);
            let y0 = members.iter().map(|c| c.y).fold(f64::MAX, f64::min);
            for c in &members {
                let kx = (c.x - x0) / pitch_x;
                let ky = (c.y - y0) / pitch_y;
                assert!((kx - kx.round()).abs() < 1e-6, "x {} off the shared lattice", c.x);
                assert!((ky - ky.round()).abs() < 1e-6, "y {} off the shared lattice", c.y);
            }
        }
    }

    /// A JSON `Program` that omits `bench_pairs` must deserialize (not error) with
    /// the field defaulting to `true` — the field-level `#[serde(default)]` at work
    /// (the struct carries no blanket default, so this is the only thing keeping the
    /// UI's not-yet-updated payload from failing).
    #[test]
    fn missing_bench_pairs_field_defaults_true() {
        let without = r#"{
            "desks": 24, "meeting_rooms": 2, "desk_w": 1.6, "desk_h": 0.8,
            "meeting_w": 4.0, "meeting_h": 4.0, "cluster_cols": 4,
            "target_corridor_m": 1.2, "desk_clearance_m": 0.9,
            "w_capacity": 0.35, "w_adjacency": 0.20, "w_circulation": 0.25, "w_density": 0.20
        }"#;
        let p: Program = serde_json::from_str(without).expect("missing bench_pairs must not error");
        assert!(p.bench_pairs, "omitted bench_pairs should default to true");

        // And an explicit false is still honored.
        let with_false = without.replace(
            "\"cluster_cols\": 4,",
            "\"cluster_cols\": 4, \"bench_pairs\": false,",
        );
        let p2: Program = serde_json::from_str(&with_false).expect("explicit bench_pairs parses");
        assert!(!p2.bench_pairs, "explicit false must be honored");
    }

    // ---- Interior walls block packing --------------------------------------

    /// Add an interior partition wall (0.1 m thick) to `doc`; returns (a, b).
    fn add_partition(doc: &mut Document, ax: f64, ay: f64, bx: f64, by: f64) -> (Point, Point) {
        let id = doc.alloc_id();
        let (a, b) = (Point::new(ax, ay), Point::new(bx, by));
        doc.walls.push(Wall { id, a, b, thickness: 0.1, generated: false, glazing: false });
        (a, b)
    }

    /// A footprint straddles/presses the wall when it comes closer to the
    /// centerline than half the wall thickness (same exact distance the packer
    /// uses, minus its extra clearance so the assertion is the harder bound).
    /// World extents: portrait desks are emitted at ±π/2.
    fn straddles(c: &crate::model::Component, a: Point, b: Point) -> bool {
        let (cw, ch) = world_extents(c.w, c.h, c.rotation);
        geometry::rect_segment_dist(c.x, c.y, cw, ch, a, b) < 0.05 - 1e-9
    }

    #[test]
    fn interior_wall_blocks_straddling_and_both_sides_fill() {
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 60; // capacity-bound so the grid presses against the wall
        program.meeting_rooms = 1;
        let mut doc = room(20.0, 15.0);
        // Full-height partition at x = 10 — divides the room wall-to-wall.
        let (a, b) = add_partition(&mut doc, 10.0, 0.0, 10.0, 15.0);
        generate(&mut doc, &program, 7, false);

        for c in &doc.components {
            assert!(!straddles(c, a, b), "{} straddles the partition", c.label);
        }
        // Packing still fills BOTH sides of the dividing wall.
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        let left = desks.iter().filter(|c| c.x < 10.0).count();
        let right = desks.iter().filter(|c| c.x > 10.0).count();
        assert!(left >= 5, "left of the partition has only {left} desks");
        assert!(right >= 5, "right of the partition has only {right} desks");

        // Determinism holds with interior walls present.
        let mut again = room(20.0, 15.0);
        add_partition(&mut again, 10.0, 0.0, 10.0, 15.0);
        generate(&mut again, &program, 7, false);
        assert_eq!(doc.components.len(), again.components.len());
        for (x, y) in doc.components.iter().zip(again.components.iter()) {
            assert!((x.x - y.x).abs() < 1e-12 && (x.y - y.y).abs() < 1e-12);
        }
    }

    #[test]
    fn boundary_walls_are_not_packing_obstacles() {
        // The interior-wall filter must classify all loop walls as boundary:
        // placement with the filter live is byte-identical to the historical
        // layout (which existing tests pin), including on the L-plate.
        let program = Program::default();
        let mut doc = l_room();
        let poly = poly_of(&doc);
        let iw = interior_walls(&doc, Some(&poly), (0.0, 0.0, 20.0, 14.0));
        assert!(iw.is_empty(), "{} loop walls misclassified as interior", iw.len());
        generate(&mut doc, &program, 3, false);
        assert!(!doc.components.is_empty());
    }

    #[test]
    fn real_plate_with_interior_wall_keeps_rigor() {
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 60;
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        for seed in 1..=3u64 {
            let mut doc = real_plate_doc();
            let poly0 = poly_of(&doc);
            // Synthetic partition across the lower wing (both endpoints inside).
            assert!(geometry::point_in_polygon(13.0, 36.0, &poly0));
            assert!(geometry::point_in_polygon(22.0, 36.0, &poly0));
            let (a, b) = add_partition(&mut doc, 13.0, 36.0, 22.0, 36.0);
            generate(&mut doc, &program, seed, false);

            // Zero components straddle the wall.
            for c in &doc.components {
                assert!(!straddles(c, a, b), "seed {seed}: {} straddles the wall", c.label);
            }
            // The plate still traces (a floating stub must not break the loop)
            // and the program still lands (one 9 m partition costs a few slots).
            let poly = poly_of(&doc);
            assert!((geometry::polygon_area(&poly) - geometry::polygon_area(&poly0)).abs() < 1e-6);
            let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
            assert!(desks >= 48, "seed {seed}: only {desks} desks with the partition");
            assert_no_overlaps(&doc, "real plate + interior wall");
        }
    }

    #[test]
    fn keep_confirmed_unaffected_by_interior_walls() {
        let program = Program::default();
        let mut doc = room(30.0, 20.0);
        let (a, b) = add_partition(&mut doc, 15.0, 0.0, 15.0, 20.0);
        generate(&mut doc, &program, 3, false);

        // Freeze two desks, regenerate around them with the wall still present.
        let frozen: Vec<(u32, f64, f64)> = doc
            .components
            .iter_mut()
            .filter(|c| c.category == "Desk")
            .take(2)
            .map(|c| {
                c.decision = DecisionState::Confirmed;
                (c.id, c.x, c.y)
            })
            .collect();
        assert_eq!(frozen.len(), 2);
        generate(&mut doc, &program, 9, true);

        for (id, x, y) in &frozen {
            let kept = doc
                .components
                .iter()
                .find(|c| c.id == *id)
                .expect("frozen desk dropped on regenerate");
            assert!((kept.x - x).abs() < 1e-9 && (kept.y - y).abs() < 1e-9, "frozen desk moved");
            assert_eq!(kept.decision, DecisionState::Confirmed);
        }
        for c in &doc.components {
            assert!(!straddles(c, a, b), "{} straddles the partition after freeze", c.label);
        }
    }

    // ---- M2 alignment discipline (module snap, portrait pairs, seed gallery) --

    /// `v` sits exactly on the 0.05 m module (the deliverable's acceptance
    /// expression: `(v / 0.05).round() * 0.05 == v` within 1e-9).
    fn on_module(v: f64) -> bool {
        ((v / MODULE).round() * MODULE - v).abs() < 1e-9
    }

    /// EVERY emitted component coordinate and dimension lands on the 0.05 m
    /// module — even when the plate's own corners are off-module, and on the
    /// real 43-vertex building. No continuous jitter survives anywhere.
    #[test]
    fn emitted_geometry_snaps_to_the_module() {
        // A room whose SW corner sits 0.13 / 0.07 off the grid: the lattice
        // origin and every derived anchor must still snap onto module lines.
        for seed in 1..=4u64 {
            let mut doc = room_from_corners(&[
                (0.13, 0.07),
                (20.13, 0.07),
                (20.13, 15.07),
                (0.13, 15.07),
            ]);
            generate(&mut doc, &Program::default(), seed, false);
            let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
            assert!(desks > 0, "seed {seed}: off-module room seats no desks");
            for c in &doc.components {
                for v in [c.x, c.y, c.w, c.h] {
                    assert!(on_module(v), "seed {seed}: {} has off-module value {v}", c.label);
                }
            }
        }
        // The real building plate (0.25 m-grid corners) with the full program.
        let mut program = Program::default();
        program.desks = 60;
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        for seed in 1..=3u64 {
            let mut doc = real_plate_doc();
            generate(&mut doc, &program, seed, false);
            for c in &doc.components {
                for v in [c.x, c.y, c.w, c.h] {
                    assert!(on_module(v), "seed {seed}: {} has off-module value {v}", c.label);
                }
            }
        }
    }

    /// Portrait wings (rows along the long/Y axis) pair desks BACK-TO-BACK
    /// across a vertical spine: partners sit `desk_h + SPINE_GAP` apart along
    /// X at the SAME y, rotated ±π/2 (the landscape 0/π convention rotated
    /// with the wing). Regression: the old code left portrait desks unrotated
    /// and π-flipped the partner about the wrong axis, so pairs were 1.6 m
    /// apart side-by-side and the symbols read scrambled (spec gap #6).
    #[test]
    fn portrait_wing_pairs_desks_across_the_spine() {
        // L-plate with a tall-thin left wing [0,6]×[0,30] (portrait) and a
        // bottom band [6,16]×[0,6] (landscape).
        let mut program = Program::default();
        program.support_spaces = false; // mechanics test: isolate desks/meetings from the M3 support program
        program.desks = 60; // over capacity, so the wing fills completely
        program.meeting_rooms = 0;
        program.cluster_cols = 100; // no cluster aisles between pair columns
        assert!(program.bench_pairs, "bench pairing is the default");
        let mut doc = room_from_corners(&[
            (0.0, 0.0),
            (16.0, 0.0),
            (16.0, 6.0),
            (6.0, 6.0),
            (6.0, 30.0),
            (0.0, 30.0),
        ]);
        generate(&mut doc, &program, 2, false);
        let wing: Vec<_> = doc
            .components
            .iter()
            .filter(|c| c.category == "Desk" && c.x < 6.0 && c.y > 7.0)
            .collect();
        assert!(wing.len() >= 8, "portrait wing seated only {} desks", wing.len());

        let q = std::f64::consts::FRAC_PI_2;
        for c in &wing {
            let is_portrait = (c.rotation - q).abs() < 1e-9 || (c.rotation - 3.0 * q).abs() < 1e-9;
            assert!(is_portrait, "{} not rotated ±π/2 in a portrait wing: {}", c.label, c.rotation);
        }

        // Group into rows by y; each row pairs across the spine along X.
        use std::collections::BTreeMap;
        let mut rows: BTreeMap<i64, Vec<&&Component>> = BTreeMap::new();
        for c in &wing {
            rows.entry((c.y * 1000.0).round() as i64).or_default().push(c);
        }
        let mut paired_rows = 0;
        for row in rows.values_mut() {
            row.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
            if row.len() < 2 {
                continue;
            }
            // Pair partners are ADJACENT ALONG X (mirror across the vertical
            // spine), separated by exactly the desk depth + spine gap — not by
            // the 1.6 m desk width the old wrong-axis pairing produced.
            let dx = row[1].x - row[0].x;
            assert!(
                (dx - (program.desk_h + SPINE_GAP)).abs() < 1e-6,
                "pair spacing {dx:.3} != depth {}",
                program.desk_h + SPINE_GAP
            );
            assert!((row[0].rotation - q).abs() < 1e-9, "near desk should read +π/2");
            assert!(
                (row[1].rotation - 3.0 * q).abs() < 1e-9,
                "far desk should mirror at 3π/2 (π/2 + π)"
            );
            paired_rows += 1;
        }
        assert!(paired_rows >= 4, "need ≥4 paired rows to trust the axis, got {paired_rows}");
    }

    /// The candidate gallery stays diverse WITHOUT jitter: over seeds 1..8 on
    /// one plate, at least 4 structurally distinct layouts appear (distinct =
    /// different component count or a different position multiset). Variety
    /// comes from discrete choices only: odd-seed half-pitch lattice phase,
    /// meeting band end A/B, cluster-column count, meeting round-robin start.
    #[test]
    fn seed_gallery_is_structurally_diverse() {
        let program = Program::default();
        let mut signatures = std::collections::BTreeSet::new();
        for seed in 1..=8u64 {
            let mut doc = room(20.0, 15.0);
            generate(&mut doc, &program, seed, false);
            let mut positions: Vec<(i64, i64)> = doc
                .components
                .iter()
                .map(|c| (((c.x * 1000.0).round()) as i64, ((c.y * 1000.0).round()) as i64))
                .collect();
            positions.sort_unstable();
            signatures.insert((doc.components.len(), positions));
        }
        // Measured at M2 time: 7/8 distinct here, 5/8 on the L-plate, 8/8 on
        // the real 43-vertex plate.
        assert!(
            signatures.len() >= 4,
            "seeds 1..8 produced only {} structurally distinct layouts",
            signatures.len()
        );
    }


    /// M4 evolution of `glass_front_faces_the_band_edge`: rooms no longer front
    /// the plate edge (the perimeter ring is retired) - they front the DRAWN
    /// primary spine, which runs INBOARD. The surviving invariant is stronger
    /// and more literal: the glazed front + door open onto an ADJACENT
    /// `Circulation` zone, whichever band end / spine side the seed chose. A
    /// probe 0.3 m beyond the glazed face must land in a Circulation zone.
    #[test]
    fn glass_front_faces_the_adjacent_circulation_across_seed_choices() {
        for seed in 1..=8u64 {
            let mut doc = room(20.0, 12.0);
            let mut program = Program::default();
            program.support_spaces = false;
            generate(&mut doc, &program, seed, false);
            for (x, y, w, h) in meeting_rects(&doc) {
                let t2 = 0.05;
                let (rx0, rx1) = (x - w / 2.0 + t2, x + w / 2.0 - t2);
                let (ry0, ry1) = (y - h / 2.0 + t2, y + h / 2.0 - t2);
                let eps = 1e-6;
                // Which side carries glazing? (L, R, B, T)
                let mut glazed = [false; 4];
                for wl in doc.walls.iter().filter(|w| w.generated && w.glazing) {
                    let on = |v: f64, t: f64| (v - t).abs() < eps;
                    let in_y = wl.a.y >= ry0 - eps && wl.b.y <= ry1 + eps && wl.a.y <= ry1 + eps && wl.b.y >= ry0 - eps;
                    let in_x = wl.a.x >= rx0 - eps && wl.b.x <= rx1 + eps && wl.a.x <= rx1 + eps && wl.b.x >= rx0 - eps;
                    if on(wl.a.x, rx0) && on(wl.b.x, rx0) && in_y { glazed[0] = true; }
                    if on(wl.a.x, rx1) && on(wl.b.x, rx1) && in_y { glazed[1] = true; }
                    if on(wl.a.y, ry0) && on(wl.b.y, ry0) && in_x { glazed[2] = true; }
                    if on(wl.a.y, ry1) && on(wl.b.y, ry1) && in_x { glazed[3] = true; }
                }
                let front = glazed.iter().position(|&g| g)
                    .unwrap_or_else(|| panic!("seed {seed}: room at ({x:.1},{y:.1}) has no glazed side"));
                // A probe 0.3 m beyond the glazed face must lie in a drawn
                // Circulation zone (the spine the front opens onto).
                let (px, py) = match front {
                    0 => (x - w / 2.0 - 0.3, y),
                    1 => (x + w / 2.0 + 0.3, y),
                    2 => (x, y - h / 2.0 - 0.3),
                    _ => (x, y + h / 2.0 + 0.3),
                };
                let faces_circ = doc.zones.iter().any(|z| {
                    z.zone_type == ZoneType::Circulation && z.shape.contains(px, py)
                });
                assert!(
                    faces_circ,
                    "seed {seed}: room at ({x:.1},{y:.1}) front (side {front}) does not open onto circulation",
                );
            }
        }
    }

    // ---- M3: the professional space program (spec 1.1) --------------------

    /// `SpaceProgram::derive` is a pure, deterministic expansion of a headcount
    /// into the spec 1.1 room palette, landing at a defensible density.
    #[test]
    fn space_program_derive_is_sane() {
        for &n in &[20usize, 60, 150] {
            // A huge plate so the area cap never bites (pure headcount derivation).
            // Balanced knobs → the pre-M7 table (identity mix), which this test pins.
            let sp = SpaceProgram::derive(n, 100_000.0, OPEN_SHARE, 1.0, SUPPORT_AREA_CAP);
            assert_eq!(sp.headcount, n as u32, "headcount preserved on a large plate");
            assert_eq!(sp.desks, ((n as f64) * OPEN_SHARE).ceil() as u32, "desks = ceil(OPEN_SHARE N)");
            // Density lands in the BCO/NBC 8-12 band (spec: ~8-12 m2/person NIA;
            // measured 10.96 / 9.08 / 7.69 at N=20/60/150 under the lean, qbiq-
            // dominant recalibration (0.90 open share + leaner booth/focus/collab)
            // - the 7.5 floor gives the densest large-N case a sliver of headroom).
            let m2pp = sp.area_per_person();
            assert!((7.5..=12.0).contains(&m2pp), "N={n}: {m2pp:.2} m2/person out of the 7.5-12 band");
            // Palette gates (spec 1.1 thresholds).
            let has = |k: SpaceKind| sp.reqs.iter().any(|r| r.kind == k && r.count > 0);
            assert!(has(SpaceKind::Cabin) && has(SpaceKind::PhoneBooth) && has(SpaceKind::Pantry)
                && has(SpaceKind::ItServer) && has(SpaceKind::Storage), "N={n}: core palette missing");
            assert!(has(SpaceKind::Reception), "N={n}: reception present for N>=20");
            assert_eq!(has(SpaceKind::Boardroom), n >= 60, "N={n}: boardroom iff N>=60");
            assert_eq!(has(SpaceKind::Wellness), n >= 50, "N={n}: wellness iff N>=50");
            // Deterministic.
            let sp2 = SpaceProgram::derive(n, 100_000.0, OPEN_SHARE, 1.0, SUPPORT_AREA_CAP);
            assert_eq!(sp.reqs.len(), sp2.reqs.len());
            assert_eq!(sp.desks, sp2.desks);
        }
        // The area cap bounds an absurd input: 150 people can't be programmed
        // onto a 300 m2 plate.
        let capped = SpaceProgram::derive(150, 300.0, OPEN_SHARE, 1.0, SUPPORT_AREA_CAP);
        assert!(capped.headcount < 150, "a tiny plate caps the effective headcount");
    }

    /// On the user's real 843 m2 plate (bare), the derived professional program
    /// PLACES: at least 70% of derived rooms land (spec's robustness floor;
    /// measured 100% here), circulation holds >= 55 (the pre-M3/M4 bar; measured
    /// ~63), and program_fit reports the delivered ratio. No overlaps; every
    /// footprint on the plate.
    #[test]
    fn real_plate_places_most_of_the_derived_program() {
        let mut program = Program::default();
        program.headcount = Some(60);
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        assert!(program.support_spaces, "support program is on by default");
        for seed in 1..=3u64 {
            let mut doc = real_plate_doc();
            let poly = poly_of(&doc);
            let area = geometry::polygon_area(&poly);
            let derived = program.meeting_rooms + support_jobs(&program, area).len() as u32;
            generate(&mut doc, &program, seed, false);
            let placed = doc.zones.iter().filter(|z| matches!(z.zone_type,
                ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration)).count() as u32;
            assert!(
                placed as f64 >= 0.70 * derived as f64,
                "seed {seed}: only {placed}/{derived} derived rooms placed (< 70%)"
            );
            for c in &doc.components {
                assert!(footprint_in_plate(c, &poly), "seed {seed}: {} escapes the plate", c.label);
            }
            assert_no_overlaps(&doc, "real plate derived program");
            let circ = circulation::evaluate(&doc, &CirculationConfig::default());
            assert!(circ.score >= 55.0, "seed {seed}: circulation {:.1} < 55 (must hold)", circ.score);
            let s = score(&doc, &program);
            assert!(s.program_fit >= 70.0, "seed {seed}: program_fit {:.1}", s.program_fit);
        }
    }

    /// Placement robustness on a WALL-DENSE variant of the real plate: interior
    /// partitions criss-cross the main wing (the field failure mode - the old
    /// band placement dropped 10 of 11 rooms on a wall-dense plate). The sliding
    /// band anchor + pocket fallback still place >= 70% (measured 100% here).
    #[test]
    fn wall_dense_plate_still_places_most_rooms() {
        let mut program = Program::default();
        program.headcount = Some(60);
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let mut doc = real_plate_doc();
        let poly = poly_of(&doc);
        for (ax, ay, bx, by) in [(12.0, 20.0, 26.0, 20.0), (12.0, 30.0, 26.0, 30.0),
                                 (18.0, 18.0, 18.0, 38.0), (14.0, 36.0, 22.0, 36.0)] {
            if geometry::point_in_polygon(ax, ay, &poly) && geometry::point_in_polygon(bx, by, &poly) {
                add_partition(&mut doc, ax, ay, bx, by);
            }
        }
        let area = geometry::polygon_area(&poly);
        let derived = program.meeting_rooms + support_jobs(&program, area).len() as u32;
        generate(&mut doc, &program, 1, false);
        let placed = doc.zones.iter().filter(|z| matches!(z.zone_type,
            ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration)).count() as u32;
        assert!(
            placed as f64 >= 0.70 * derived as f64,
            "wall-dense: only {placed}/{derived} rooms placed (< 70%)"
        );
        assert_no_overlaps(&doc, "wall-dense plate");
        for c in &doc.components {
            assert!(footprint_in_plate(c, &poly), "wall-dense: {} escapes the plate", c.label);
        }
    }

    // ---- M4: entries + drawn spine ----------------------------------------

    /// A `Document.entry` anchors the circulation narrative (spec 3): reception
    /// lands NEAR the entry, the pantry is pushed to the FAR social end, and an
    /// entry-connector `Circulation` zone is drawn from the door to the spine.
    #[test]
    fn entry_anchors_reception_near_the_door_and_pantry_far() {
        let mut doc = real_plate_doc();
        let entry = Point::new(20.0, 1.5); // on the plate's south edge
        doc.entries.push(entry);
        let mut program = Program::default();
        program.headcount = Some(40);
        program.meeting_rooms = 2;
        generate(&mut doc, &program, 1, false);

        let center = |z: &Zone| { let (x0, y0, x1, y1) = z.shape.bbox(); ((x0 + x1) / 2.0, (y0 + y1) / 2.0) };
        let dist = |c: (f64, f64)| ((c.0 - entry.x).powi(2) + (c.1 - entry.y).powi(2)).sqrt();
        let recep = doc.zones.iter().find(|z| z.label == "Reception").expect("a reception was placed");
        let pantry = doc.zones.iter().find(|z| z.label == "Pantry").expect("a pantry was placed");
        assert!(
            dist(center(recep)) < dist(center(pantry)),
            "reception ({:.1} m) must sit nearer the entry than the pantry ({:.1} m)",
            dist(center(recep)), dist(center(pantry))
        );
        // The drawn circulation network reaches the entry — EITHER a dedicated
        // "Entry" connector strip is drawn to the spine, OR (since the field-first
        // rebalance moved the dominant wing's shallow-band spine onto the entry's
        // cross-line) a spine/corridor already passes through the entry's cross
        // position, so no connector is needed. Both satisfy "network reaches the
        // door"; the old test assumed only the connector case.
        let circ_reaches_entry = doc.zones.iter().any(|z| {
            z.zone_type == ZoneType::Circulation && z.label == "Entry"
        }) || doc.zones.iter().any(|z| {
            if z.zone_type != ZoneType::Circulation {
                return false;
            }
            let (x0, _, x1, _) = z.shape.bbox();
            x0 - 1e-6 <= entry.x && entry.x <= x1 + 1e-6
        });
        assert!(
            circ_reaches_entry,
            "the drawn circulation network must reach the entry (connector or aligned spine)"
        );
    }

    /// `program_fit` honestly reports a shortfall: an over-programmed tiny plate
    /// can't place the whole derived program (fit < 100), while a roomy plate
    /// places it all (fit == 100). It is wired into the weighted total.
    #[test]
    fn program_fit_reports_shortfall_and_feeds_the_total() {
        let mut tiny = room(10.0, 8.0);
        let mut over = Program::default();
        over.headcount = Some(120); // far more program than 80 m2 can hold
        generate(&mut tiny, &over, 1, false);
        let st = score(&tiny, &over);
        assert!(st.program_fit < 100.0, "tiny over-programmed plate must show a shortfall");
        assert!((0.0..=100.0).contains(&st.program_fit));

        let mut roomy = room(40.0, 30.0);
        let mut fit = Program::default();
        fit.headcount = Some(40);
        generate(&mut roomy, &fit, 1, false);
        let sr = score(&roomy, &fit);
        assert!((sr.program_fit - 100.0).abs() < 1e-9, "a roomy plate places the whole program");
        // program_fit participates in the blended total (w_program default 0.1).
        assert!(over.w_program > 0.0, "w_program must weight the total");
    }

    /// A JSON `Program` that omits the M3/M4 additive fields (support_spaces,
    /// headcount, w_program) still deserializes with the documented defaults.
    #[test]
    fn missing_m3_m4_program_fields_default() {
        let without = r#"{
            "desks": 24, "meeting_rooms": 2, "desk_w": 1.6, "desk_h": 0.8,
            "meeting_w": 4.0, "meeting_h": 4.0, "cluster_cols": 4,
            "target_corridor_m": 1.2, "desk_clearance_m": 0.9,
            "w_capacity": 0.35, "w_adjacency": 0.20, "w_circulation": 0.25, "w_density": 0.20
        }"#;
        let p: Program = serde_json::from_str(without).expect("legacy program JSON must parse");
        assert!(p.support_spaces, "missing support_spaces defaults to true");
        assert_eq!(p.headcount, None, "missing headcount defaults to None");
        assert!((p.w_program - 0.10).abs() < 1e-9, "missing w_program defaults to 0.10");
    }

    /// `support_spaces` gates the whole derived program: off -> only the user's
    /// meeting rooms (no ClosedOffice/Amenity/Collaboration support zones); on ->
    /// the professional palette appears alongside the meetings.
    #[test]
    fn support_spaces_toggle_gates_the_program() {
        let mut base = Program::default();
        base.headcount = Some(40);
        base.meeting_rooms = 2;
        base.meeting_w = 3.0;
        base.meeting_h = 3.0;

        let mut off = base.clone();
        off.support_spaces = false;
        let mut d_off = room(30.0, 22.0);
        generate(&mut d_off, &off, 1, false);
        let support_off = d_off.zones.iter().filter(|z| matches!(z.zone_type,
            ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration)).count();
        assert_eq!(support_off, 0, "support_spaces=false must place no support rooms");
        assert!(d_off.zones.iter().filter(|z| z.zone_type == ZoneType::Meeting).count() >= 1,
            "the user's meeting rooms still place with support off");

        let mut d_on = room(30.0, 22.0);
        generate(&mut d_on, &base, 1, false);
        let support_on = d_on.zones.iter().filter(|z| matches!(z.zone_type,
            ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration)).count();
        assert!(support_on >= 5, "support_spaces=true must place the professional palette (got {support_on})");
    }

    // ---- S5: explicit room program (Detailed builder, workflow.md §3.4) ----

    /// ClosedOffice zone centers (Cabin / Focus / Phone-booth rooms), left→right.
    fn closed_office_centers(doc: &Document) -> Vec<(f64, f64)> {
        let mut v: Vec<(f64, f64)> = doc
            .zones
            .iter()
            .filter(|z| z.zone_type == ZoneType::ClosedOffice)
            .map(|z| match z.shape {
                ZoneShape::Rect { x, y, .. } => (x, y),
                _ => panic!("closed-office zone must be a Rect"),
            })
            .collect();
        v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        v
    }

    /// An explicit `rooms` program REPLACES the derived support program +
    /// meeting override: exactly the requested rooms are placed (counts honored
    /// when they fit), no derived palette leaks in, and desks still fill the
    /// field. Guards the S5 generator branch.
    #[test]
    fn explicit_rooms_replace_derived_program_and_honor_counts() {
        let mut program = Program::default();
        program.headcount = Some(40); // desks still derive from this
        program.rooms = vec![
            RoomReq { kind: SpaceKind::Cabin, count: 4, w: None, d: None, placement: Placement::Flexible },
            RoomReq { kind: SpaceKind::Meeting, count: 1, w: None, d: None, placement: Placement::Flexible },
        ];
        let mut doc = room(30.0, 22.0);
        generate(&mut doc, &program, 1, false);

        let cabins = doc.zones.iter().filter(|z| z.zone_type == ZoneType::ClosedOffice).count();
        assert_eq!(cabins, 4, "the 4 requested offices must all place on this ample plate");
        let meetings = doc.zones.iter().filter(|z| z.zone_type == ZoneType::Meeting).count();
        assert_eq!(meetings, 1, "exactly the 1 requested meeting room (override ignored under explicit rooms)");
        // No DERIVED support rooms (pantry/reception/IT/…): explicit list is the
        // whole room program, so Amenity/Collaboration zones are absent.
        let derived = doc.zones.iter().filter(|z| matches!(z.zone_type,
            ZoneType::Amenity | ZoneType::Collaboration)).count();
        assert_eq!(derived, 0, "explicit rooms must not pull in the derived support palette");
        // Desks still scale to the plate (rooms replace only the ROOM program).
        assert!(doc.components.iter().any(|c| c.category == "Desk"), "desks must still fill the field");
    }

    /// Empty `rooms` (the default) leaves the derive path byte-identical: a
    /// bare default program still emits the professional support palette.
    #[test]
    fn empty_rooms_falls_back_to_derive() {
        let mut doc = room(30.0, 22.0);
        generate(&mut doc, &Program::default(), 1, false);
        let support = doc.zones.iter().filter(|z| matches!(z.zone_type,
            ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration)).count();
        assert!(support >= 5, "empty rooms → derived program still places the palette (got {support})");
    }

    /// Placement bias (SOFT): with a clear facade at x=0, Window offices land
    /// nearer it than Core offices — and the bias, not the request order, drives
    /// it (feeding the rooms in the opposite order yields the SAME layout).
    #[test]
    fn explicit_placement_biases_window_toward_facade() {
        let cabin = |p: Placement| RoomReq { kind: SpaceKind::Cabin, count: 2, w: None, d: None, placement: p };
        let mut win_first = Program::default();
        win_first.support_spaces = false;
        win_first.headcount = Some(20);
        win_first.rooms = vec![cabin(Placement::Window), cabin(Placement::Core)];
        let mut a = room(40.0, 12.0);
        generate(&mut a, &win_first, 1, false);
        let ca = closed_office_centers(&a);
        assert_eq!(ca.len(), 4, "all four offices place on the 40×12 band");

        // Window rooms (placed first, low-x facade end) sit clear of the Core rooms.
        let (win_x, core_x) = ((ca[0].0 + ca[1].0) / 2.0, (ca[2].0 + ca[3].0) / 2.0);
        assert!(win_x < core_x, "window mean x {win_x:.1} must be left (facade) of core mean x {core_x:.1}");
        // …and genuinely nearer the x=0 facade wall than the core rooms.
        let dist = |x: f64| x.min(40.0 - x);
        assert!(
            (dist(ca[0].0) + dist(ca[1].0)) / 2.0 < (dist(ca[2].0) + dist(ca[3].0)) / 2.0,
            "window offices must average nearer a facade edge than core offices"
        );

        // Bias — not input order — decides: swap the requests, get the same plan.
        let mut core_first = win_first.clone();
        core_first.rooms = vec![cabin(Placement::Core), cabin(Placement::Window)];
        let mut b = room(40.0, 12.0);
        generate(&mut b, &core_first, 1, false);
        let cb = closed_office_centers(&b);
        for (pa, pb) in ca.iter().zip(cb.iter()) {
            assert!((pa.0 - pb.0).abs() < 1e-9 && (pa.1 - pb.1).abs() < 1e-9,
                "placement sort must make request order irrelevant");
        }
    }

    /// Serde round-trip of the S5 additive fields: `rooms` (with per-request
    /// `placement`, optional `w`/`d`) survives, and a JSON blob that omits
    /// `rooms` entirely deserializes to an empty list (the sanitizeProgram trap's
    /// core-side guarantee). Legacy programs never error.
    #[test]
    fn program_rooms_serde_round_trip() {
        let mut p = Program::default();
        p.rooms = vec![
            RoomReq { kind: SpaceKind::Cabin, count: 3, w: Some(4.5), d: Some(4.0), placement: Placement::Window },
            RoomReq { kind: SpaceKind::Pantry, count: 1, w: None, d: None, placement: Placement::Core },
        ];
        let s = serde_json::to_string(&p).expect("serialize");
        let p2: Program = serde_json::from_str(&s).expect("round-trip");
        assert_eq!(p2.rooms.len(), 2);
        assert_eq!(p2.rooms[0].kind, SpaceKind::Cabin);
        assert_eq!(p2.rooms[0].count, 3);
        assert_eq!(p2.rooms[0].w, Some(4.5));
        assert_eq!(p2.rooms[0].placement, Placement::Window);
        assert_eq!(p2.rooms[1].placement, Placement::Core);
        assert_eq!(p2.rooms[1].w, None);

        // Missing `rooms` (every pre-S5 blob) → empty, and a missing per-request
        // `placement` → Flexible.
        let legacy: Program = serde_json::from_str(
            r#"{"desks":24,"meeting_rooms":2,"desk_w":1.6,"desk_h":0.8,"meeting_w":4.0,
                "meeting_h":4.0,"cluster_cols":4,"target_corridor_m":1.2,"desk_clearance_m":0.9,
                "w_capacity":0.35,"w_adjacency":0.2,"w_circulation":0.25,"w_density":0.2}"#,
        )
        .expect("legacy JSON parses");
        assert!(legacy.rooms.is_empty(), "missing rooms → empty");
        let one: Program = serde_json::from_str(
            r#"{"desks":10,"meeting_rooms":0,"desk_w":1.6,"desk_h":0.8,"meeting_w":4.0,"meeting_h":4.0,
                "cluster_cols":4,"target_corridor_m":1.2,"desk_clearance_m":0.9,"w_capacity":0.35,
                "w_adjacency":0.2,"w_circulation":0.25,"w_density":0.2,
                "rooms":[{"kind":"Cabin","count":1}]}"#,
        )
        .expect("partial room parses");
        assert_eq!(one.rooms[0].placement, Placement::Flexible, "missing placement → Flexible");
    }

    // ---- M5: professional density + recentered scoring --------------------

    /// Total seats (workstations + meeting/collab capacity) and the true plate
    /// area — the m²/person the report and the density sub-score both read.
    fn seats_and_area(doc: &Document) -> (f64, f64) {
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count() as f64;
        let mseats: f64 = doc
            .zones
            .iter()
            .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::Collaboration))
            .map(|z| z.capacity() as f64)
            .sum();
        (desks + mseats, geometry::polygon_area(&poly_of(doc)))
    }

    /// Lean-cap SMALL-plate sanity (docs/design/testfit-pro-quality.md §1): the
    /// `SUPPORT_AREA_CAP` must lean a small floor's program without STRIPPING it —
    /// an 18×12 m (216 m²) plate keeps its essential rooms (a real office still
    /// has reception/pantry/IT/storage/a cabin), just not the booth/focus/collab
    /// sprawl a big floor gets. The open desk field stays the dominant use and the
    /// density stays professional. Guards the cap from over-trimming to a bare
    /// desk grid on modest plates.
    #[test]
    fn small_plate_keeps_a_sane_lean_program() {
        // App-representative fresh fit (mirrors `suggestProgram`): headcount at
        // 10 m²/person, desks at the 0.90 open share, a modest meeting count and
        // the app's 3×3 meeting footprint.
        let area = 18.0_f64 * 12.0;
        let headcount = (area / 10.0).round() as u32;
        let mut program = Program::default();
        program.headcount = Some(headcount);
        program.desks = ((headcount as f64) * OPEN_SHARE).round() as u32;
        program.meeting_rooms = 2;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let mut doc = room(18.0, 12.0);
        generate(&mut doc, &program, 1, false);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        let rooms = doc
            .zones
            .iter()
            .filter(|z| matches!(z.zone_type,
                ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration))
            .count();
        // Not stripped to a bare grid: the essentials still derive + place.
        assert!(rooms >= 3, "small plate stripped its program to {rooms} rooms");
        // But lean: fewer rooms than workstations, open field dominant.
        assert!(desks > rooms, "small plate seated {desks} desks vs {rooms} rooms — not open-dominant");
        // And still in the professional density band (with irregular slack).
        let (seats, area) = seats_and_area(&doc);
        let m2pp = area / seats;
        assert!((8.0..=13.0).contains(&m2pp), "small plate {m2pp:.1} m²/person out of the 8–13 band");
    }

    /// M5 / field-bug regression: a BARE plate (rectangular sizes + the real
    /// 843 m² DWG fixture) with the DEFAULT auto program (headcount unset) fills
    /// to the professional density — m²/person incl. meeting seats lands in the
    /// 8–13 band (BCO/NBC 8–12 + irregular-plate slack). Guards the field bug
    /// where a fixed 24-desk target left the real building at ~20 m²/person
    /// (2.5× too sparse), and the absurd ~29 m²/person on a large empty plate.
    #[test]
    fn bare_plate_fills_to_professional_density() {
        for (w, h) in [(20.0, 15.0), (30.0, 22.0), (40.0, 30.0)] {
            let mut doc = room(w, h);
            generate(&mut doc, &Program::default(), 1, false);
            let (seats, area) = seats_and_area(&doc);
            assert!(seats > 0.0, "rect {w}x{h}: no seats placed");
            let m2pp = area / seats;
            assert!(
                (8.0..=13.0).contains(&m2pp),
                "rect {w}x{h}: {m2pp:.1} m²/person out of the professional 8–13 band (seats {seats:.0}, area {area:.0})"
            );
        }
        // The user's real 843 m² building — the field case.
        let mut doc = real_plate_doc();
        generate(&mut doc, &Program::default(), 1, false);
        let (seats, area) = seats_and_area(&doc);
        let m2pp = area / seats;
        assert!(
            (8.0..=13.0).contains(&m2pp),
            "REAL_PLATE: {m2pp:.1} m²/person out of the professional 8–13 band (seats {seats:.0}, area {area:.0})"
        );
        // The recentered density sub-score rewards the in-band fill.
        let s = score(&doc, &Program::default());
        assert!(s.density >= 80.0, "REAL_PLATE density sub-score {:.0} should reward the in-band fill", s.density);
    }

    /// SMALL single-region plate (18×12) stays SANE after the room-concentration
    /// rework, not degenerate. The rework zeroes the room band only on the
    /// dominant wing(s) of a DECOMPOSED plate; a rectangular plate is one region
    /// (never a `field_region`), so it keeps its `min_field_d` desk-row reserve
    /// and must still host BOTH a real desk field AND its support rooms in one
    /// band — the regression guard that the multi-wing change left the common
    /// single-room-plate path untouched.
    #[test]
    fn small_single_region_plate_stays_sane() {
        let mut doc = room(18.0, 12.0);
        generate(&mut doc, &Program::default(), 1, false);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        let rooms = doc
            .zones
            .iter()
            .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Amenity | ZoneType::Collaboration))
            .count();
        let (seats, area) = seats_and_area(&doc);
        let m2pp = area / seats;
        assert!(desks >= 5, "18×12 seated only {desks} desks (degenerate)");
        assert!(rooms >= 3, "18×12 placed only {rooms} support rooms (degenerate)");
        assert!((8.0..=13.0).contains(&m2pp), "18×12: {m2pp:.1} m²/person out of band");
        let circ = circulation::evaluate(&doc, &CirculationConfig::default()).score;
        assert!(circ >= 54.0, "18×12: circulation {circ:.1} < 54");
        assert_no_overlaps(&doc, "small plate");
    }

    /// DEAD-ZONE regression: a small-but-usable rectangular plate must still pack a
    /// desk field, not zero. The fixed default program (24-desk / 2-meeting) put
    /// enough enclosed rooms on plates up to ~140 m² that overflow rooms fell into
    /// the desk field and their full-clearance halos rejected EVERY desk slot, so a
    /// tenant selecting an ~86 m² sub-area got 0 workstations. The fix confines the
    /// small-single-region pocket to the band strip (overflow drops rather than
    /// poisons the field) and rescues a shallow field's single row from an adverse
    /// lattice phase. Plates degrade gracefully — a handful of desks, never zero —
    /// while the density-calibrated mid/large plates (asserted elsewhere) are
    /// untouched. Seed 1 is the odd (half-pitch) phase that used to zero ~88 m².
    #[test]
    fn small_plates_pack_desks_not_zero() {
        let desks_on = |w: f64, h: f64| {
            let mut doc = room(w, h);
            generate(&mut doc, &Program::default(), 1, false);
            doc.components.iter().filter(|c| c.category == "Desk").count()
        };
        // ~81 m² and ~88 m²: the confirmed dead zone — must seat a handful, not 0.
        assert!(desks_on(9.0, 9.0) >= 1, "9×9 (81 m²) seated 0 desks (dead zone)");
        let d88 = desks_on(11.0, 8.0);
        assert!(d88 >= 3, "11×8 (88 m²) seated only {d88} desks (dead zone)");
        // A mid plate that also read 0 before must now pack a real field.
        assert!(desks_on(14.0, 10.0) >= 6, "14×10 (140 m²) under-packed");
        // Large plate stays strong (density-calibrated, well clear of any floor).
        assert!(desks_on(24.0, 15.0) >= 30, "24×15 (360 m²) lost its strong field");
    }

    /// The recentered density sub-score peaks in the professional band and falls
    /// off BOTH sides — a pure-function guard on the M5 curve (spec §5): the old
    /// band peaked at ~2.3 m²/desk cramming; this one peaks at 10 m²/person.
    #[test]
    fn density_score_peaks_in_band_and_falls_off_both_sides() {
        assert!((density_score(10.0) - 100.0).abs() < 1e-9, "10 m²/person is the peak");
        assert!((density_score(9.0) - 100.0).abs() < 1e-9 && (density_score(11.0) - 100.0).abs() < 1e-9);
        // Crammed side (too few m²/person) and sparse side (too many) both drop.
        assert!(density_score(5.0) < 60.0, "5 m²/person (crammed) must score low");
        assert!(density_score(3.0) < 20.0, "3 m²/person (very crammed) near zero");
        assert!(density_score(18.0) < 40.0, "18 m²/person (sparse) must score low");
        assert!(density_score(24.0) <= 0.0, "24 m²/person (very sparse) is zero");
        // Strictly monotone away from the band on each side.
        assert!(density_score(6.0) > density_score(5.0));
        assert!(density_score(14.0) > density_score(16.0));
    }

    /// A professional-density layout OUTSCORES both a sparse and a crammed one
    /// (deliverable): same objective weights, the density sub-score separates
    /// them, and it carries through to the blended total.
    #[test]
    fn professional_density_outscores_sparse_and_crammed() {
        // Professional: headcount unset → the plate fills to ~10 m²/person.
        let prof_prog = Program::default();
        let mut prof = room(40.0, 30.0);
        generate(&mut prof, &prof_prog, 1, false);
        let sp = score(&prof, &prof_prog);

        // Sparse: a small explicit headcount leaves the same plate under-filled.
        let mut sparse_prog = Program::default();
        sparse_prog.headcount = Some(40);
        let mut sparse = room(40.0, 30.0);
        generate(&mut sparse, &sparse_prog, 1, false);
        let ss = score(&sparse, &sparse_prog);

        // Crammed: no support rooms, desks jammed at a sub-code aisle onto a
        // modest plate — a deliberately unprofessional over-dense grid.
        let mut cram_prog = Program::default();
        cram_prog.support_spaces = false;
        cram_prog.meeting_rooms = 0;
        cram_prog.desks = 240;
        cram_prog.desk_clearance_m = 0.55;
        let mut crammed = room(30.0, 20.0);
        generate(&mut crammed, &cram_prog, 1, false);
        let cs = score(&crammed, &cram_prog);

        let (prof_seats, prof_area) = seats_and_area(&prof);
        let (spar_seats, spar_area) = seats_and_area(&sparse);
        let (cram_seats, cram_area) = seats_and_area(&crammed);
        assert!(
            sp.density > ss.density + 5.0 && sp.density > cs.density + 5.0,
            "professional density {:.0} ({:.1} m²/pp) must beat sparse {:.0} ({:.1}) and crammed {:.0} ({:.1})",
            sp.density, prof_area / prof_seats,
            ss.density, spar_area / spar_seats,
            cs.density, cram_area / cram_seats,
        );
        // And it carries the blended total (density is a weighted term).
        assert!(sp.total > ss.total, "professional total {:.0} must beat sparse {:.0}", sp.total, ss.total);
        assert!(sp.total > cs.total, "professional total {:.0} must beat crammed {:.0}", sp.total, cs.total);
    }

    // ---- S6: anchor pins (workflow.md §3.5) --------------------------------

    /// Center of the zone whose label carries `needle`, if any.
    fn zone_center(doc: &Document, needle: &str) -> Option<(f64, f64)> {
        doc.zones.iter().find(|z| z.label.contains(needle)).map(|z| {
            let (x0, y0, x1, y1) = z.shape.bbox();
            ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
        })
    }

    /// An anchored room lands AT/near its pin: the pinned Reception's zone center
    /// sits within a slot-step of the requested point on a roomy plate.
    #[test]
    fn anchored_room_lands_at_its_pin() {
        let mut doc = room(24.0, 16.0);
        doc.anchors.push(crate::document::Anchor { kind: SpaceKind::Reception, x: 6.0, y: 5.0 });
        generate(&mut doc, &Program::default(), 3, false);
        let (cx, cy) = zone_center(&doc, "Reception (pinned").expect("pinned reception zone emitted");
        let dist = ((cx - 6.0).powi(2) + (cy - 5.0).powi(2)).sqrt();
        assert!(dist <= 1.0, "pinned reception center ({cx:.2},{cy:.2}) is {dist:.2} m from the pin (6,5)");
    }

    /// Anchoring a kind the program never asked for BUMPS the count: with the
    /// support program off and no meetings, a bare plate would place zero rooms —
    /// a single Reception pin still yields a Reception room.
    #[test]
    fn anchor_bumps_count_when_kind_absent() {
        let mut program = Program::default();
        program.support_spaces = false;
        program.meeting_rooms = 0;
        // Baseline: nothing anchored → no Reception.
        let mut base = room(20.0, 14.0);
        generate(&mut base, &program, 2, false);
        assert!(zone_center(&base, "Reception").is_none(), "no reception without a pin");
        // Pinned → exactly the bumped room appears near the pin.
        let mut doc = room(20.0, 14.0);
        doc.anchors.push(crate::document::Anchor { kind: SpaceKind::Reception, x: 5.0, y: 5.0 });
        generate(&mut doc, &program, 2, false);
        let (cx, cy) = zone_center(&doc, "Reception (pinned").expect("bumped reception zone");
        assert!(((cx - 5.0).powi(2) + (cy - 5.0).powi(2)).sqrt() <= 1.5, "bumped reception near its pin");
    }

    /// An anchor of a REQUESTED kind consumes one of that kind's count rather than
    /// adding: an explicit 2-cabin program + 1 cabin pin yields 2 cabins total
    /// (one pinned near the point, one free), not 3.
    #[test]
    fn anchor_consumes_one_of_a_requested_kind() {
        let mut program = Program::default();
        program.support_spaces = false;
        program.meeting_rooms = 0;
        program.rooms = vec![RoomReq { kind: SpaceKind::Cabin, count: 2, w: None, d: None, placement: Placement::Flexible }];
        let mut doc = room(26.0, 18.0);
        doc.anchors.push(crate::document::Anchor { kind: SpaceKind::Cabin, x: 6.0, y: 5.0 });
        generate(&mut doc, &program, 4, false);
        let cabins = doc.zones.iter().filter(|z| z.zone_type == ZoneType::ClosedOffice && z.label.contains("Cabin")).count();
        assert_eq!(cabins, 2, "2 requested + 1 pinned (consumed) = 2 cabins, got {cabins}");
        let (cx, cy) = zone_center(&doc, "Cabin (pinned").expect("one cabin is the pinned instance");
        // "Near", not exact: a pin landing on the drawn spine is nudged just clear
        // of it (rooms may never intrude on circulation), so allow one room-depth.
        let dist = ((cx - 6.0).powi(2) + (cy - 5.0).powi(2)).sqrt();
        assert!(dist <= 2.5, "pinned cabin at ({cx:.2},{cy:.2}) is {dist:.2} m from its point (6,5)");
    }

    /// Anchors are a deterministic input: same seed + same pins → byte-identical
    /// document. Also: `generate()` never clears the anchors (they persist like
    /// entries, so a regenerate re-honours them).
    #[test]
    fn anchored_generate_is_deterministic_and_keeps_anchors() {
        let pins = [
            crate::document::Anchor { kind: SpaceKind::Reception, x: 5.0, y: 5.0 },
            crate::document::Anchor { kind: SpaceKind::Meeting, x: 18.0, y: 11.0 },
        ];
        let mut a = room(24.0, 16.0);
        a.anchors.extend_from_slice(&pins);
        let mut b = room(24.0, 16.0);
        b.anchors.extend_from_slice(&pins);
        generate(&mut a, &Program::default(), 7, false);
        generate(&mut b, &Program::default(), 7, false);
        assert_eq!(
            serde_json::to_value(&a.components).unwrap(),
            serde_json::to_value(&b.components).unwrap(),
            "same seed + pins → identical components"
        );
        assert_eq!(a.zones.len(), b.zones.len(), "identical zone count");
        assert_eq!(a.anchors.len(), 2, "generate preserves the anchors (like entries)");
    }
}
