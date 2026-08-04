//! Hierarchical quantity takeoff, derived from the `Document` directly.
//!
//! Branch-2 candidate `qto-native` (ADR 0004): level → room → category → item,
//! with parametric quantity links and rolled-up subtotals, computed in the core
//! with no IFC round-trip and no network — so it works offline, which the
//! service-backed alternative cannot.
//!
//! **Independence.** The bake-off's ground truth is a deliberately dumb flat
//! summation over the SERIALIZED state, written in JS. This is a rollup over the
//! in-memory `Document`, written in Rust. They share no aggregation code, which
//! is the condition under which agreement between them is evidence rather than
//! tautology (ADR 0004).
//!
//! Room attribution comes from `Zone::component_ids`, which is exactly the
//! information our IFC export drops — the structural reason a native rollup can
//! build a room level and an IFC-consuming one cannot.

use crate::document::Document;
use crate::model::Component;
use crate::zone::ZoneType;
use serde::Serialize;

/// What a quantity measures. The parametric link the flat takeoff lacks.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum QuantityKind {
    Count,
    // Reserved for the parametric links a richer schedule will carry; the
    // vocabulary is fixed now so the serialized shape does not churn later.
    #[allow(dead_code)]
    Length,
    #[allow(dead_code)]
    Area,
    #[allow(dead_code)]
    Volume,
}

#[derive(Serialize, Clone, Debug)]
pub struct CostLine {
    pub label: String,
    /// Document category this line measures — engines cover different category
    /// sets, so per-category comparison is the only fair accuracy metric.
    pub category: String,
    pub product_id: Option<String>,
    pub quantity_kind: QuantityKind,
    pub quantity: f64,
    /// Footprint area (m²) of the items on this line.
    pub area_m2: f64,
    /// ₹ unit price when bound. `None` means UNPRICED — never conflated with 0.
    pub unit_price_inr: Option<f64>,
    pub total_inr: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CostNode {
    pub kind: &'static str,
    pub label: String,
    pub children: Vec<CostNode>,
    pub lines: Vec<CostLine>,
    pub subtotal_inr: f64,
    pub item_count: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct CostSchedule {
    pub root: CostNode,
    pub all_lines: Vec<CostLine>,
    pub grand_total_inr: f64,
    pub item_count: usize,
    pub hierarchical: bool,
    /// Items in no zone. Surfaced, not silently folded into a room.
    pub unassigned_items: usize,
}

fn line_for(label: &str, category: &str, comps: &[&Component]) -> CostLine {
    let area: f64 = comps.iter().map(|c| c.w * c.h).sum();
    // A line is priced only if every item on it carries the same bound price;
    // mixed bindings would make a single unit price a lie, so they split by
    // product upstream of here.
    let priced: Vec<f64> = comps.iter().filter_map(|c| c.price_inr).collect();
    let (unit, total) = if !priced.is_empty() && priced.len() == comps.len() {
        let u = priced[0];
        if priced.iter().all(|p| (*p - u).abs() < 1e-9) {
            (Some(u), Some(u * comps.len() as f64))
        } else {
            (None, Some(priced.iter().sum()))
        }
    } else if !priced.is_empty() {
        (None, Some(priced.iter().sum()))
    } else {
        (None, None)
    };
    CostLine {
        label: label.to_string(),
        category: category.to_string(),
        product_id: comps.iter().find_map(|c| c.product_id.clone()),
        quantity_kind: QuantityKind::Count,
        quantity: comps.len() as f64,
        area_m2: area,
        unit_price_inr: unit,
        total_inr: total,
    }
}

/// Group by product first, then category, so a priced binding always lands on
/// its own line and can never be averaged away into an unpriced group.
fn lines_for(comps: &[&Component]) -> Vec<CostLine> {
    let mut keys: Vec<(String, String)> = Vec::new();
    for c in comps {
        let k = (
            c.product_id.clone().unwrap_or_default(),
            c.category.clone(),
        );
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    keys.iter()
        .map(|(pid, cat)| {
            let group: Vec<&Component> = comps
                .iter()
                .filter(|c| {
                    c.product_id.clone().unwrap_or_default() == *pid && c.category == *cat
                })
                .copied()
                .collect();
            let label = group
                .iter()
                .find(|c| c.product_id.is_some())
                .map(|c| c.label.clone())
                .unwrap_or_else(|| cat.clone());
            line_for(&label, cat, &group)
        })
        .collect()
}

fn roll(node: &mut CostNode) {
    let mut subtotal: f64 = node.lines.iter().filter_map(|l| l.total_inr).sum();
    let mut count: usize = node.lines.iter().map(|l| l.quantity as usize).sum();
    for ch in node.children.iter_mut() {
        roll(ch);
        subtotal += ch.subtotal_inr;
        count += ch.item_count;
    }
    node.subtotal_inr = subtotal;
    node.item_count = count;
}

fn zone_label(t: ZoneType, label: &str) -> String {
    if label.is_empty() {
        format!("{t:?}")
    } else {
        label.to_string()
    }
}

/// Build the schedule. Single storey today — the document has no level concept,
/// so the level node is real but degenerate, and level-correctness must not be
/// claimed from it (ADR 0004).
pub fn schedule(doc: &Document) -> CostSchedule {
    let mut rooms: Vec<CostNode> = Vec::new();
    let mut claimed: Vec<u32> = Vec::new();

    for z in &doc.zones {
        let comps: Vec<&Component> = doc
            .components
            .iter()
            .filter(|c| z.component_ids.contains(&c.id))
            .collect();
        for c in &comps {
            claimed.push(c.id);
        }
        if comps.is_empty() {
            continue;
        }
        // category level under each room
        let mut cats: Vec<String> = Vec::new();
        for c in &comps {
            if !cats.contains(&c.category) {
                cats.push(c.category.clone());
            }
        }
        let children: Vec<CostNode> = cats
            .iter()
            .map(|cat| {
                let group: Vec<&Component> =
                    comps.iter().filter(|c| c.category == *cat).copied().collect();
                CostNode {
                    kind: "category",
                    label: cat.clone(),
                    children: Vec::new(),
                    lines: lines_for(&group),
                    subtotal_inr: 0.0,
                    item_count: 0,
                }
            })
            .collect();
        rooms.push(CostNode {
            kind: "room",
            label: zone_label(z.zone_type, &z.label),
            children,
            lines: Vec::new(),
            subtotal_inr: 0.0,
            item_count: 0,
        });
    }

    // Anything in no zone gets its own node rather than vanishing.
    let orphans: Vec<&Component> = doc
        .components
        .iter()
        .filter(|c| !claimed.contains(&c.id))
        .collect();
    let unassigned = orphans.len();
    if !orphans.is_empty() {
        let mut cats: Vec<String> = Vec::new();
        for c in &orphans {
            if !cats.contains(&c.category) {
                cats.push(c.category.clone());
            }
        }
        rooms.push(CostNode {
            kind: "room",
            label: "Unassigned".to_string(),
            children: cats
                .iter()
                .map(|cat| {
                    let group: Vec<&Component> =
                        orphans.iter().filter(|c| c.category == *cat).copied().collect();
                    CostNode {
                        kind: "category",
                        label: cat.clone(),
                        children: Vec::new(),
                        lines: lines_for(&group),
                        subtotal_inr: 0.0,
                        item_count: 0,
                    }
                })
                .collect(),
            lines: Vec::new(),
            subtotal_inr: 0.0,
            item_count: 0,
        });
    }

    let mut root = CostNode {
        kind: "level",
        label: "Level 1".to_string(),
        children: rooms,
        lines: Vec::new(),
        subtotal_inr: 0.0,
        item_count: 0,
    };
    roll(&mut root);

    fn collect(n: &CostNode, out: &mut Vec<CostLine>) {
        out.extend(n.lines.iter().cloned());
        for c in &n.children {
            collect(c, out);
        }
    }
    let mut all_lines = Vec::new();
    collect(&root, &mut all_lines);

    CostSchedule {
        grand_total_inr: root.subtotal_inr,
        item_count: root.item_count,
        hierarchical: !root.children.is_empty(),
        unassigned_items: unassigned,
        all_lines,
        root,
    }
}
