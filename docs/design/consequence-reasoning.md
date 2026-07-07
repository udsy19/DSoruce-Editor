# Design — Consequence / What-If Reasoning ("if you do X, then Y happens")

**Status:** Draft · 2026-07-07 · owner: metrics / decision-analysis
**Scope:** the reasoning layer that lets the AI backbone predict, in plain language and
grounded in real metrics, what an edit will do to a plan **before** it is applied —
so every AI action is *propose → preview → approve/undo*, never a blind mutation.

This is the analysis half of the AI backbone (`vision.md`: "AI as a supervised backbone").
The AI proposes a structured **action** (from tool-use), we run it as a **dry-run diff**,
turn the metric deltas into ranked **consequence warnings**, and show a compact
**preview card**. Only on approve does the action hit the real document.

Builds on the two evaluators that already exist:
`crates/ds-core/src/circulation.rs::evaluate` → `CirculationScore`, and
`crates/ds-core/src/layout.rs::score` → `LayoutScore`. It adds only two small models
(indicative cost + carbon) and one wasm method (`preview_action`).

---

## 0. The shape of the flow

```
user: "merge these two meeting rooms"
        │
        ▼
  Claude (tool-use) ──emits──▶ Action { kind, params }        // structured, typed
        │                          │
        │   (may first ask a       ▼
        │    clarifying Q)   ┌──────────────┐  clone doc, apply action to the CLONE,
        │                    │ preview_action│  recompute metrics on before + after
        │                    │   (Rust/wasm) │
        │                    └──────────────┘
        │                          │ PreviewDiff { before, after, deltas, severity }
        ▼                          ▼
  narrate consequences  ◀──  consequence RULES (§2) turn deltas → ranked warnings
        │
        ▼
  preview card (§3): "capacity 24→24 · area/person 5.4→7.1 m² ▲ · min corridor 1.30→0.86 m ▼ (below IBC 1.12)"
        │
   approve ─▶ apply the SAME action to the real doc, re-read state(), render
   reject  ─▶ discard the clone, nothing changed
```

The dry-run runs on a **throwaway clone**, so a preview is side-effect-free by
construction and can be recomputed on every keystroke of a slider (e.g. "adding N desks"
with N dragged live).

---

## 1. Dry-run diff mechanism

### 1a. Clone → apply → recompute → diff

`Document` already derives `Clone` (`document.rs`), and every editing primitive is a pure
mutation of a `Document`. So the dry run is:

```rust
let mut trial = self.doc.clone();     // 1. clone the source of truth
apply(&mut trial, &action);           // 2. run the proposed action on the clone
let before = snapshot(&self.doc, &program);   // 3. metrics of the current plan
let after  = snapshot(&trial,   &program);    //    metrics of the hypothetical plan
let diff   = MetricDiff::between(before, after); // 4. per-metric before/after/delta/severity
```

`snapshot()` is a single struct that bundles **everything the consequence rules read**,
computed once per plan. It composes the existing evaluators plus the small derived stats:

```rust
struct MetricSnapshot {
    // from layout::score(doc, program)
    workstations: u32,      // placed_desks (Desk count actually seated)
    capacity: f64,          // 0..100
    adjacency: f64,
    density: f64,
    layout_total: f64,
    // from circulation::evaluate(doc, cfg)   (cfg.target_corridor_width = program.target_corridor_m)
    circulation: f64,       // 0..100 headline
    min_corridor_width: f64,// m
    mean_clearance: f64,    // m
    pct_below_min: f64,     // 0..1  (pct_corridors_below_min)
    connectivity: f64,      // 0..1  (largest_connected_free_region)
    enclosed: bool,
    // areas
    gross_area: f64,        // m²  Document::floor_area() — wall-bbox gross (GEA-ish)
    net_free_area: f64,     // m²  circulation.reachable_free_area (walkable NIA-ish)
    // derived (this doc adds them)
    area_per_person: f64,   // m² per workstation
    indicative_cost: f64,   // $   (§1c)
    indicative_carbon: f64, // kgCO2e (§1c)
}
```

Guard rails already documented in CLAUDE.md apply: `circulation::evaluate` is degenerate
with **0 walls**, so `snapshot` reports circulation fields as `n/a` (not 0) when
`walls.is_empty()`, and the rules that read them are skipped for wall-less plans.

### 1b. The exact metrics to diff, and how each is computed today

| Metric | Unit | Source today | Addition needed |
|---|---|---|---|
| **workstations** | count | `LayoutScore.placed_desks` (or `components.filter(category=="Desk").count()`) | none |
| **capacity** | 0–100 | `LayoutScore.capacity` = `100·placed/requested` | none |
| **min_corridor_width** | m | `CirculationScore.min_corridor_width` | none |
| **mean_clearance** | m | `CirculationScore.mean_clearance` | none |
| **circulation score** | 0–100 | `CirculationScore.score` | none |
| **pct_corridors_below_min** | 0–1 | `CirculationScore.pct_corridors_below_min` | none |
| **connectivity** | 0–1 | `CirculationScore.largest_connected_free_region` | none |
| **gross area (GEA)** | m² | `Document::floor_area()` (wall bbox) | none |
| **net free area (NIA)** | m² | `CirculationScore.reachable_free_area` | none |
| **area / person** | m²/ws | — | **derive:** `net_free_area / max(workstations,1)` |
| **indicative cost** | $ | — | **add:** $/m² × area, by zone (§1c) |
| **indicative carbon** | kgCO2e | — | **add:** kgCO2e/m² × area, by zone (§1c) |
| **layout total** | 0–100 | `LayoutScore.total` | none |

Nine of the twelve are **already computed** by the two evaluators; the dry run is mostly
plumbing. Only three are new, and two of those (cost, carbon) share one tiny model.

### 1c. The two new models (deliberately simple, per-m², zone-weighted)

There are **no first-class rooms/zones yet** (the known core gap), so "zone" is derived
from what we have: component category footprints + leftover free area.

- **Workstation zone** = Σ desk footprints (`w·h` over `category=="Desk"`).
- **Meeting zone** = Σ `category=="MeetingRoom"` footprints.
- **Circulation/open zone** = `net_free_area − (workstation + meeting footprint)` (floor).
- **Core/service** = not modelled until zones exist (rate falls back to circulation).

Indicative **cost** and **carbon** are each `Σ zone_area · rate[zone]`, plus a flat
per-workstation furniture allowance:

| Zone | Cost $/m² | Carbon kgCO2e/m² | Basis (order-of-magnitude fit-out benchmarks) |
|---|---|---|---|
| Workstation (open) | 1,600 | 260 | mid open-plan Cat-B fit-out |
| Meeting room (enclosed) | 2,400 | 380 | partitions + AV + glazing raise both |
| Circulation / open floor | 900 | 150 | finishes + base building services only |
| Per workstation (furniture) | +1,200 /ws | +180 /ws | desk + chair + storage allowance |

These are **indicative planning figures**, tunable constants in one Rust module
(`cost.rs`), explicitly *not* a QS estimate — the UI labels them "indicative". The point
is **relative deltas** ("this edit adds ~$29k / ~4.7 tCO2e"), which are robust to the
absolute rate being approximate. When real rooms/zones land, the same `rate[zone]` table
keys off true zone types with no change to the diff/rule machinery.

`area_per_person` uses `net_free_area` (walkable NIA) so it tracks the "how much room does
each person actually get" reading Laiout shows, and moves the moment desks or walls change.

---

## 2. Consequence rules (metric deltas → ranked plain-language warnings)

Each rule reads the `MetricDiff` and, if it fires, emits a `Consequence { severity,
message, metric }`. Severity is **red** (violates a cited hard standard / large regression),
**amber** (approaches a threshold / meaningful regression), **green** (improvement worth
surfacing). Rules are evaluated in the order below and the card shows them ranked
**red → amber → green**, most-severe first. Thresholds are the ones already cited in
`circulation.rs` (ADA/IBC) and `layout.rs`.

### Thresholds (all already in-repo)
- **ADA accessible route** continuous clear width **0.915 m** (36 in). *(circulation.rs §Sources)*
- **IBC §1020.3 egress corridor** min **1.118 m ≈ 1.12 m** (44 in, ≥50 occupants). *(layout.rs, circulation.rs)*
- **Two-way passing** **1.52 m** (60 in). *(circulation.rs)*
- **Circulation share** of usable area ~**25–40%** (up to ~45% open plan). *(circulation.rs)*
- **Area per workstation** healthy band ~**5.5–6.5 m²**; <5 m² is cramped. *(layout.rs defaults)*
- **Density** desk-area/floor healthy **30–55%**. *(layout.rs `score`)*

### Ranked rule set

**R1 — Egress corridor breach (RED).**
`after.min_corridor_width < 1.12 && before.min_corridor_width ≥ 1.12`
→ "Removing this wall drops the narrowest corridor to **{after} m**, below the IBC 1.12 m
egress minimum." *Fires on the canonical "merge two rooms" case (a wall deletion opens a
pinch, or the newly merged span pushes furniture together).*

**R2 — Accessible-route breach (RED).**
`after.min_corridor_width < 0.915`
→ "A passage would narrow to **{after} m**, below the ADA 0.915 m accessible-route width."
(Strictly worse than R1; if both fire, R2 wins the ranking.)

**R3 — Corridors fall below target (AMBER→RED).**
`after.pct_below_min > before.pct_below_min + 0.10`
→ "**{Δ%}** more of the walkable centreline drops below the {target} m target corridor
width." Red if `after.pct_below_min > 0.5`.

**R4 — Circulation score regression (AMBER).**
`after.circulation < before.circulation − 5`; RED if `after.circulation < 60`.
→ "Circulation score falls **{before}→{after}** (walkability)." *Grounds the example
"…and circulation below 60".*

**R5 — Floor fragmented / dead-end created (AMBER→RED).**
`after.connectivity < before.connectivity − 0.05`
→ "This splits the walkable floor into disconnected pockets (connectivity
{before}→{after})." Red if `after.connectivity < 0.9` and it was ≥0.9 (furniture now
chops the floor into islands).

**R6 — Area-per-person too low (AMBER→RED).**
`after.area_per_person < 6.0`; RED if `< 5.0`.
→ "Adding {N} desks pushes area/person to **{after} m²**, below the ~6 m²
comfortable minimum." *Grounds "…pushes area/person below 6 m²".*

**R7 — Over-dense / over-sparse floor (AMBER).**
`after.density` leaves the 30–55% band while `before` was inside it.
→ "Desk density reaches **{after}%** of floor — above the 55% comfortable ceiling
(overcrowded)" / "…below 30% (under-utilised)".

**R8 — Capacity shortfall (AMBER→RED).**
`after.workstations < before.workstations` **and the action's intent was not removal**, or
`after.capacity < 100 && before.capacity == 100`.
→ "This displaces **{Δ}** workstation(s); capacity {before}%→{after}%." Red if the drop
> 10% of target. *Catches "merge rooms eats desk space".*

**R9 — Cost / carbon jump (AMBER, informational).**
`|Δcost| > 0.10·before.cost` or `|Δcarbon| > 0.10·before.carbon`.
→ "Indicative cost **{±$}** ({±%}), embodied carbon **{±kgCO2e}**." Amber on increase,
green on decrease. Always shown as a chip even when it doesn't fire a warning.

**R10 — Net improvement (GREEN).**
No red/amber fired **and** (`after.circulation > before.circulation + 3` or
`after.area_per_person` moves into 5.5–6.5 or `after.layout_total > before.layout_total`).
→ "Corridors widen / walking space improves — min corridor {before}→{after} m,
circulation {before}→{after}." Gives the AI a positive thing to say when an edit is good.

**Unenclosed-plan guard.** If `!after.enclosed` (or 0 walls), R1–R5 are suppressed
(circulation metrics are unreliable), and the card notes "open plan — corridor checks
skipped". Prevents the degenerate-grid false alarms called out in CLAUDE.md.

The AI narrates by reading these `Consequence` messages verbatim (they are already
plain-language and numeric), optionally summarising the top one or two. It never invents
numbers — every figure in its sentence came from the diff.

---

## 3. UX surface — the preview card

A compact card rendered **before approval**, styled in the Laiout language (soft rounded
card, hairline border, subtle shadow; numbers in tabular figures; muted uppercase eyebrow).

```
┌──────────────────────────────────────────────┐
│ PREVIEW · merge meeting rooms A + B            │  ← eyebrow (teal-gray, letter-spaced)
│                                                │
│  Workstations     24  →  24        ·           │  neutral
│  Area / person   5.4  →  7.1 m²    ▲ green     │  improvement
│  Min corridor    1.30 →  0.86 m    ▼ RED       │  ← below IBC 1.12
│  Circulation      74  →  63        ▼ amber     │
│  Indic. cost         +$28,900      ▲ amber     │
│  Indic. carbon      +4.7 tCO2e     ▲ amber     │
│                                                │
│  ⚠ Narrowest corridor 0.86 m is below the IBC  │  ← top consequence (R1), red
│     1.12 m egress minimum.                     │
│                                                │
│         [ Discard ]        [ Apply ]           │
└──────────────────────────────────────────────┘
```

- Each row = one diffed metric: `label · before → after · unit · arrow · severity dot`.
  Arrow direction encodes *change*; color encodes *whether the change is good* (a wider
  corridor is green-▲, a narrower one is red-▼) — direction and valence are decoupled so a
  rising cost (▲) can be amber while a rising area/person (▲) is green.
- Below the rows: the **top 1–3 consequences** (R1–R10) as sentences, red first.
- **Apply** is not blocked by a red severity (the user is sovereign — CAD tools warn, they
  don't forbid), but a red card requires a confirm click and is logged for undo.
- The whole card recomputes live for **parametric** actions (a slider "add N desks"): drag
  N, `preview_action` re-runs on the clone, card animates the deltas. Cheap because
  `evaluate` is O(grid cells) and runs thousands of times/sec (circulation.rs complexity note).
- Only rows whose value **changed** are shown by default; unchanged metrics collapse into a
  "＋3 unchanged" affordance to keep the card compact.

---

## 4. TS / Rust boundary

### Recommendation: do the clone + score **in Rust**, expose one `preview_action`.

Add a single wasm method to `Editor` (mirrors the existing `generate`/`layout_score`
serde-in/serde-out pattern in `lib.rs`):

```rust
/// Dry-run: apply `action` to a CLONE of the document, diff metrics vs. current,
/// and return a PreviewDiff. The live document is NOT mutated.
pub fn preview_action(&self, action: JsValue, program: JsValue) -> Result<JsValue, JsValue>;

/// Commit: apply the SAME action to the live document (called on approve).
pub fn apply_action(&mut self, action: JsValue) -> Result<JsValue, JsValue>; // returns state()
```

with a typed action enum shared by both:

```rust
#[derive(Deserialize)]
#[serde(tag = "kind")]
enum Action {
    AddComponent { category: String, x: f64, y: f64, w: f64, h: f64 },
    MoveComponent { id: u32, dx: f64, dy: f64 },
    DeleteComponent { id: u32 },
    AddWall { ax:f64, ay:f64, bx:f64, by:f64, thickness:f64 },
    DeleteWall { id: u32 },                    // NB: small addition — no delete_wall today
    Generate { seed: u64, keep_confirmed: bool },
    // composite, built from primitives:
    MergeRooms { wall_ids: Vec<u32> },         // = delete the shared wall(s)
}
```

`apply(doc, action)` is one pure function that dispatches to the existing document
mutators (`add_component`, `move_selected`-equivalent, `retain`, `layout::generate`, …).
`preview_action` calls `apply` on a clone; `apply_action` calls the identical `apply` on
`&mut self.doc` — **one code path, no divergence** between the previewed effect and the
applied effect (this is the property that makes preview trustworthy).

**Why in Rust, not TS:**
1. **Core is the source of truth** (CLAUDE.md convention) — business/metric logic must not
   live in the renderer. Cost/carbon/area-per-person are document logic.
2. `Document: Clone` + all evaluators are already Rust; cloning + scoring in JS would mean
   re-implementing `apply` and the metrics on the TS side — exactly the duplication
   `.claude/rules/no-bloat.md` forbids.
3. One serde round-trip per preview vs. shipping the whole document to JS, mutating it, and
   shipping it back for each of the two scores. Rust-side is fewer boundary crossings.
4. `preview` and `commit` sharing `apply` guarantees "what you previewed is what you get".

**Alternative considered (rejected):** keep a second scratch `Editor` in JS, replay the
action on it via existing mutators, read `state()`/`circulation()`/`layout_score()` twice,
diff in TS. Works with **zero new Rust**, but (a) forces the diff + cost/carbon logic into
TS (violates "core is truth"), (b) `generate` clears components so a scratch editor must be
rebuilt from `state()` each time (fiddly, and ids won't match), and (c) duplicates the
`MergeRooms`→`DeleteWall` decomposition in JS. Acceptable only as a **throwaway spike**
before `preview_action` exists.

**TS side** (thin): add `PreviewDiff` / `Consequence` / `Action` interfaces to
`EditorCanvas.ts` (next to `LayoutScore`/`CirculationScore`, keeping those exports stable
per CLAUDE.md), a `preview(action): PreviewDiff` wrapper, and a `<PreviewCard>` component.
The AI orchestrator emits an `Action`, calls `preview`, shows the card, and on approve
calls `apply`.

### Minimal build order
1. `cost.rs`: the rate table + `indicative_cost(doc)` / `indicative_carbon(doc)` (pure).
2. `MetricSnapshot` + `MetricDiff` + the R1–R10 rules (pure Rust, unit-testable — mirror the
   existing circulation/layout test style: build a `room()`, apply an action, assert a rule
   fires). `area_per_person` lives here.
3. `Action` enum + `apply()` + `Editor::preview_action` / `apply_action` + `delete_wall`.
4. `make wasm`, then TS `PreviewCard` + AI wiring.

Steps 1–2 are pure and land with tests before any wasm/TS work — they are the whole
consequence engine and can be validated in `cargo test -p ds-core`.

---

## Sources
- In-repo evaluators: `crates/ds-core/src/circulation.rs` (thresholds + `CirculationScore`),
  `crates/ds-core/src/layout.rs` (`LayoutScore`, density band, area/ws defaults),
  `crates/ds-core/src/document.rs` (`floor_area`, `Clone`).
- Companion design: `docs/design/autonomous-testfit-loop.md` (the generate→evaluate loop
  this reuses), `vision.md` (AI-as-supervised-backbone).
- Standards (already cited in `circulation.rs`): ADA/US Access Board Ch.4 (36 in / 0.915 m),
  IBC Ch.10 §1020.3 (44 in / 1.118 m), 60 in passing; circulation 25–40% of usable area.
- Cost/carbon rates are indicative order-of-magnitude fit-out planning figures, tunable
  constants in `cost.rs`; to be replaced by a real cost/QS + embodied-carbon source before
  any figure is shown without an "indicative" label.
