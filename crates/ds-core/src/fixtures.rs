//! **The edited-plan population.**
//!
//! Every gate and every test in this repo used to run against one population:
//! a freshly generated plan. `golden_generate_output_is_frozen` pins it, ten
//! (program, seed) cases deep, and it is authoritative for what `generate`
//! produces. What no gate touched was the document a *user* has after ten
//! minutes of work — a wall drawn, a zone resized, a room reassigned.
//!
//! That gap shipped a defect: the statistics panel reporting **GEA 1 m²** beside
//! **NIA 138 m²** and **efficiency 1159%**, on an edited plan, under a board
//! reporting green. Nothing was broken in `generate`; the number the panel
//! showed had simply never been measured after an edit.
//!
//! So the edited states become artifacts, frozen like the goldens, and both
//! sides of the wasm boundary build them from THIS module: `cargo test` reaches
//! [`build`] directly, and the browser harness reaches it through
//! `Editor::load_fixture`. One definition, so a browser capture and a Rust
//! assertion are looking at the same document rather than at two documents that
//! were meant to be the same.
//!
//! | id | state |
//! |----|-------|
//! | `F1` | pristine `generate` on the sample plate |
//! | `F2` | F1 + a user-drawn closed wall loop; the plate's outer loop intact |
//! | `F3` | F2 with one plate wall removed — the outer loop is broken while a smaller *closed* loop survives. **This is the GEA-collapse state.** |
//! | `F4` | the reported user sequence: generate → select a zone → resize it → reassign it to Circulation |
//! | `F5` | edit soup: eleven mixed mutations across walls, zones and components |
//!
//! The plate boundary comes from `fixtures/plate-furniture-plan.json`, captured
//! from `samples/furniture-plan.dxf` by `scripts/capture-plate-fixture.mjs`.
//! DXF parsing lives in TypeScript, so that polygon is the one thing that
//! crosses; it is frozen, and re-capturing it is a re-registration event.

use crate::document::Document;
use crate::geometry::Point;
use crate::layout::{self, Program};
use crate::model::Wall;
use crate::zone::{ZoneShape, ZoneType};

/// The frozen sample plate, as captured from the DXF.
const PLATE_JSON: &str = include_str!("../fixtures/plate-furniture-plan.json");

/// Every fixture generates at this seed. Fixed, because a fixture that moves
/// with the clock is not a fixture.
pub(crate) const FIXTURE_SEED: u64 = 3;

/// The five fixture ids, in order. Exposed so a harness can enumerate them
/// rather than hard-coding a list that drifts.
pub(crate) const FIXTURE_IDS: [&str; 5] = ["F1", "F2", "F3", "F4", "F5"];

/// Boundary vertices of the frozen sample plate, in meters.
pub(crate) fn plate_boundary() -> Vec<Point> {
    #[derive(serde::Deserialize)]
    struct PlateFixture {
        boundary: Vec<[f64; 2]>,
    }
    let p: PlateFixture = serde_json::from_str(PLATE_JSON).expect("plate fixture parses");
    p.boundary.into_iter().map(|[x, y]| Point::new(x, y)).collect()
}

/// The program every fixture generates with — the wizard's own defaults at the
/// sample plate's headcount, so the fixtures exercise the code path a user does.
pub(crate) fn fixture_program() -> Program {
    Program {
        desks: 90,
        meeting_rooms: 6,
        ..Program::default()
    }
}

/// Push a closed loop of USER walls (`generated: false`) through `corners`.
fn push_loop(doc: &mut Document, corners: &[Point], thickness: f64) {
    for i in 0..corners.len() {
        let a = corners[i];
        let b = corners[(i + 1) % corners.len()];
        let id = doc.alloc_id();
        doc.walls.push(Wall {
            id,
            a,
            b,
            thickness,
            generated: false,
            glazing: false,
            height_m: None,
        });
    }
}

/// F1's base: the plate walls, then one deterministic `generate`.
fn generated_plate() -> Document {
    let mut doc = Document::new();
    push_loop(&mut doc, &plate_boundary(), 0.15);
    layout::generate(&mut doc, &fixture_program(), FIXTURE_SEED, false);
    doc
}

/// A 1.2 × 1.0 m closed loop of user walls, centred on the plate's centroid.
///
/// Small on purpose. It is the shape a user gets from drawing a phone-booth
/// outline, and — once the plate's own loop is broken — it is the loop that
/// `trace_floor_polygon` locks onto, which is how a 930 m² floor came to report
/// as ~1 m². The reported symptom and the fixture are the same order of
/// magnitude because they are the same defect.
fn drawn_box_corners(doc: &Document) -> [Point; 4] {
    let (min_x, min_y, max_x, max_y) = doc.wall_bbox().expect("plate has walls");
    let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
    let (hw, hh) = (0.6, 0.5);
    [
        Point::new(cx - hw, cy - hh),
        Point::new(cx + hw, cy - hh),
        Point::new(cx + hw, cy + hh),
        Point::new(cx - hw, cy + hh),
    ]
}

/// Build fixture `name`, or `None` if there is no such fixture.
pub(crate) fn build(name: &str) -> Option<Document> {
    match name {
        "F1" => Some(generated_plate()),

        "F2" => {
            let mut doc = generated_plate();
            let corners = drawn_box_corners(&doc);
            push_loop(&mut doc, &corners, 0.1);
            Some(doc)
        }

        "F3" => {
            let mut doc = build("F2")?;
            // Remove exactly one PLATE wall — the first user wall, which is the
            // boundary's first edge. The drawn box survives, so the document
            // still has a closed loop; it is simply the wrong one.
            //
            // Walls have no delete mutator on the `Editor` surface today (see the
            // ledger note), so the fixture edits the document directly. That is
            // not a claim the state is unreachable: a wall committed from the CAD
            // layer that snaps across the plate subdivides the same face, and the
            // invariant battery covers that variant separately.
            let plate_len = plate_boundary().len();
            let doomed = doc
                .walls
                .iter()
                .filter(|w| !w.generated)
                .take(plate_len)
                .map(|w| w.id)
                .next()
                .expect("plate walls exist");
            doc.walls.retain(|w| w.id != doomed);
            Some(doc)
        }

        "F4" => {
            let mut doc = generated_plate();
            // The reported sequence. Pick the zone deterministically: the
            // largest Meeting room by id, which is what a user clicks first.
            let target = doc
                .zones
                .iter()
                .filter(|z| z.zone_type == ZoneType::Meeting)
                .filter_map(|z| match z.shape {
                    ZoneShape::Rect { x, y, w, h } => Some((z.id, x, y, w, h)),
                    _ => None,
                })
                .max_by(|a, b| (a.3 * a.4).partial_cmp(&(b.3 * b.4)).unwrap())
                .or_else(|| {
                    doc.zones.iter().find_map(|z| match z.shape {
                        ZoneShape::Rect { x, y, w, h } => Some((z.id, x, y, w, h)),
                        _ => None,
                    })
                })?;
            let (id, x, y, w, h) = target;
            doc.resize_zone(id, ZoneShape::Rect { x, y, w: w + 1.5, h: h + 1.5 }).ok()?;
            doc.set_zone_type(id, ZoneType::Circulation).ok()?;
            Some(doc)
        }

        "F5" => {
            let mut doc = generated_plate();
            // Eleven mixed mutations. Deliberately unglamorous: this is what ten
            // minutes of somebody moving things around looks like, and the point
            // is that no sequence of them may produce an impossible metric.
            let corners = drawn_box_corners(&doc);
            push_loop(&mut doc, &corners, 0.1); // 1: draw a box

            // 2: draw an open stub that dead-ends inside the plate
            let stub_id = doc.alloc_id();
            doc.walls.push(Wall {
                id: stub_id,
                a: corners[0],
                b: Point::new(corners[0].x - 3.0, corners[0].y),
                thickness: 0.1,
                generated: false,
                glazing: false,
                height_m: None,
            });

            // 3: move that stub (the `set_wall` path)
            if let Some(w) = doc.walls.iter_mut().find(|w| w.id == stub_id) {
                w.b = Point::new(w.b.x, w.b.y - 1.0);
            }

            let rects: Vec<(u32, ZoneType, f64, f64, f64, f64)> = doc
                .zones
                .iter()
                .filter_map(|z| match z.shape {
                    ZoneShape::Rect { x, y, w, h } => Some((z.id, z.zone_type, x, y, w, h)),
                    _ => None,
                })
                .collect();

            // 4/5: grow one zone, shrink another
            if let Some(&(id, _, x, y, w, h)) = rects.first() {
                let _ = doc.resize_zone(id, ZoneShape::Rect { x, y, w: w * 1.4, h: h * 1.4 });
            }
            if let Some(&(id, _, x, y, w, h)) = rects.get(1) {
                let _ = doc.resize_zone(id, ZoneShape::Rect { x, y, w: w * 0.5, h: h * 0.5 });
            }
            // 6/7: reassign two zones across the ground boundary
            if let Some(&(id, ..)) = rects.get(2) {
                let _ = doc.set_zone_type(id, ZoneType::Circulation);
            }
            if let Some(&(id, ..)) = rects.get(3) {
                let _ = doc.set_zone_type(id, ZoneType::Workspace);
            }
            // 8: rename one
            if let Some(&(id, ..)) = rects.get(4) {
                let _ = doc.rename_zone(id, "Renamed by the user".into());
            }
            // 9: delete one
            if let Some(&(id, ..)) = rects.get(5) {
                let _ = doc.delete_zone(id);
            }
            // 10: move a component well off its zone
            if let Some(c) = doc.components.iter_mut().find(|c| c.category == "Desk") {
                c.x += 4.0;
                c.y -= 2.5;
            }
            // 11: delete a component
            if let Some(pos) = doc.components.iter().position(|c| c.category == "Chair") {
                doc.components.remove(pos);
            }
            doc.reassign_components();
            Some(doc)
        }

        _ => None,
    }
}
