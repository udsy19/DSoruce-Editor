//! Strategy selection and program derivation: the `Program` the user sets,
//! the `Strategy` mix it implies, and the professional `SpaceProgram` derived
//! from a headcount (spec §1.1) that the placers consume.

use super::*;

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
    pub(crate) fn open_share(self) -> f64 {
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
    pub(crate) fn cellular_mult(self) -> f64 {
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
    pub(crate) fn support_cap(self) -> f64 {
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
    pub(crate) fn weight_bias(self) -> WeightBias {
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
pub(crate) struct WeightBias {
    pub(crate) capacity: f64,
    pub(crate) adjacency: f64,
    pub(crate) circulation: f64,
    pub(crate) density: f64,
    pub(crate) program: f64,
    pub(crate) daylight: f64,
    pub(crate) entry: f64,
}

impl WeightBias {
    /// All-ones → the strategy leaves the program's weights untouched (Balanced).
    pub(crate) fn identity() -> WeightBias {
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
pub(crate) fn program_open_share(program: &Program) -> f64 {
    if program.rooms.is_empty() {
        program.strategy.open_share()
    } else {
        Strategy::Balanced.open_share()
    }
}

/// The DERIVED cellular-family multiplier for a program (see `program_open_share`
/// for the explicit-program gate).
pub(crate) fn program_cellular_mult(program: &Program) -> f64 {
    if program.rooms.is_empty() {
        program.strategy.cellular_mult()
    } else {
        1.0
    }
}

/// The DERIVED support-area cap for a program (see `program_open_share`).
pub(crate) fn program_support_cap(program: &Program) -> f64 {
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

/// serde field-default for `Program::bench_pairs` (missing field → bench desking on).
pub(crate) fn default_bench_pairs() -> bool {
    true
}

/// serde field-default for `Program::support_spaces` (missing field → the full
/// professional program is derived and placed).
pub(crate) fn default_support_spaces() -> bool {
    true
}

/// serde field-default for `Program::w_program`.
pub(crate) fn default_w_program() -> f64 {
    0.10
}

/// serde field-default for `Program::w_daylight`.
pub(crate) fn default_w_daylight() -> f64 {
    0.05
}

/// serde field-default for `Program::w_entry`.
pub(crate) fn default_w_entry() -> f64 {
    0.05
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
pub(crate) const DESK_ALLOWANCE_M2: f64 = 4.15;
/// Circulation share added on top of net program area for the m²/person sanity
/// figure (test-fit convention: 25–30%).
#[allow(dead_code)] // spec 1.1 density sanity, exercised by space_program_derive_is_sane
pub(crate) const CIRCULATION_SHARE: f64 = 0.27;

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
pub(crate) const TARGET_M2_PER_PERSON: f64 = 10.0;
/// Open-plan share of the headcount seated at open workstations. Raised to
/// **0.90** (spec default was 0.85) as part of the lean, qbiq-dominant
/// recalibration: the reference Crystal Tower floor runs 141 open / 149 seats ≈
/// **0.95** open share — an office where open desks, not enclosed rooms, are the
/// overwhelming majority. 0.90 moves the derived desk target toward that
/// dominance (so a large plate reaches ~80+ workstations instead of ~52) while
/// still leaving a real 10% of headcount for meeting/collab seats. Drives both
/// `SpaceProgram::derive`'s `desks` and `desk_target` so rooms and desks scale
/// from the SAME headcount (M5 invariant).
pub(crate) const OPEN_SHARE: f64 = 0.90;
/// Ceiling on the DERIVED support program's net area as a fraction of the plate
/// (spec §1 / qbiq open-plan dominance). `SpaceProgram::derive` trims its most
/// discretionary rooms until the enclosed+open support program fits under this,
/// guaranteeing the open desk field keeps the MAJORITY of usable area on any
/// headcount. 0.22 leaves the normal fill (~0.17 at N = area/10) untouched and
/// bites only on an over-set headcount squeezed onto a modest plate.
pub(crate) const SUPPORT_AREA_CAP: f64 = 0.22;

/// The design headcount for a program: explicit `program.headcount`, else the
/// plate filled to the professional density (`plate_area / TARGET_M2_PER_PERSON`)
/// so BOTH the derived room program (`SpaceProgram`) and the desk fill scale to
/// the plate. Plate 0 / unknown (open walls) falls back to the legacy inference
/// from the desk target at the open share, so nothing regresses off-plate.
pub(crate) fn program_headcount(program: &Program, plate_area: f64) -> u32 {
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
pub(crate) fn desk_target(program: &Program, plate_area: f64) -> u32 {
    let n = program_headcount(program, plate_area);
    let pro = ((n as f64) * program_open_share(program)).ceil() as u32;
    program.desks.max(pro)
}
