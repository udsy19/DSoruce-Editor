#!/usr/bin/env python3
"""G11 — Furniture agreement: the workbook bills exactly the furniture the plan
shows, and the plan actually SHOWS it.

The pack's premise is that plan, inventory and renders are provably the same
model. A workbook that bills a table the plan does not draw is what a client
catches by holding two sheets side by side (defect E7, reports/defects-2.md).

Two assertions, both geometry-to-geometry:

  1. EMISSION (count-exact). Per room, the multiset of furniture instances the
     workbook's `Furniture Inventory` bills equals the multiset this gate
     derives from the CORE STATE — same room bucketing rule as the core
     (`Document::zone_index_at`: a specific zone outranks Circulation, smallest
     area wins), same "Name Wxx X Lyy" description built from the component's
     own dimensions.

  2. VISIBILITY. Emission is necessary but NOT sufficient — the furniture in E7
     *is* emitted; it is painted over by the room-ID label, which is drawn last
     with a 4 px white halo. So every billed instance must still be LEGIBLE in
     the delivered PNG: its footprint must retain furniture line-work ink.

GATE INDEPENDENCE (.claude/rules/gate-independence.md). Nothing here reads a
producer-emitted summary of what the renderer drew. Both sides are re-derived:
the billed side from the workbook's own cells, the drawn side from the core
state (the Rust generator, run in Node) projected through a transform this gate
recomputes itself, sampled against the delivered PNG's pixels.
`ground-truth.json` and `plan-labels.json` are never opened — deleting or
corrupting them leaves this gate's output byte-identical.

--- HOW VISIBILITY IS MEASURED ------------------------------------------------

Furniture is CAD line-work, so the ink a symbol should deposit scales with its
OUTLINE LENGTH, not its area — which makes the measure cohort-free (a room with
one billed table has no sibling to be compared against, and in the E7 pack BOTH
0.6x0.6 tables were occluded, so any peer-relative measure is blind to them):

    ink_per_outline = (furniture-ink px inside the footprint) / 2*(w_px + h_px)

Ink classes are separated by hue, from the delivered pixels alone:
  * FURNITURE ink is cool-neutral — #2e343b stroke / #7c848e detail (pdf.ts
    PRINT_STROKE/PRINT_DETAIL) and their blends toward white: blue > red, low
    chroma. The coloured wall/circulation/door palette is far outside that.
  * ROOM-LABEL ink is PURE neutral (palette.json plan.room_label_text is
    #000000; black on white anti-aliases to r == g == b exactly).
This gate asserts both classes are present, so a change that makes them
indistinguishable fails loudly instead of silently measuring nothing.

CALIBRATION — measured over all three round-trip packs (seeded, testfit, dwg;
552 billed instances, 489 with no label ink anywhere near them) as they were
BEFORE the E7 fix:

    label-free instances   min 1.05 (dwg 133/Chair) · 1.19 (seeded 103/Table)
                           · 1.46 (testfit 164/Table); typical 1.4-2.3
    label-occluded         seeded  12/Chair 0.06 · 155/Chair 0.15 · 188 0.21
                           · 21 0.21 · 171/Chair 0.28 · 179 0.38
                           · 147/Table 0.44 · 145/Table 0.48
                           dwg     125/Chair 0.00 · OS/Chair 0.00 · 41 0.06
                           · 82 0.06 · 141/Table 0.10 · 154/Chair 0.56
                           testfit 216/Chair 0.06 · 208/Table 0.39 · 133 0.57

MIN_INK_PER_OUTLINE = 0.70 sits in the gap between the two measured ranges:
1.5x above the worst defect it has to catch on the delivered pack (0.48, the
Print Point table E7 names) and 1.5x below the worst genuine instance (1.05) —
the log-scale midpoint. After the fix the worst room in any pack is 0.99.

Usage: g11-furniture-agreement.py [--plan out/plan.png]
                                  [--workbook out/quantity-takeoff.xlsx]
                                  [--case seeded|testfit|dwg]
                                  [--min-ink-per-outline 0.70]
"""
import json
import math
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402

# --- the plan renderer's fit, re-derived here (pdf.ts renderPrintCanvas) ------
PAD_PX = 48

# Visibility floor — see CALIBRATION above.
MIN_INK_PER_OUTLINE = 0.70

# Dilation applied to room-label ink when attributing a failure to the label:
# the label is stroked with a 4 px white halo, so it erases ~2 px beyond its
# glyphs. 3 px is deliberately generous — this only labels the CAUSE in the
# failure message, it is not part of the pass/fail test.
LABEL_HALO_PX = 3

# Categories the furniture BOM does not carry (takeoff.ts NON_FURNITURE).
NOT_FURNITURE = {"Door"}

# The one document per round-trip case, built by the Rust core in Node.
CASE_BUILDERS = {
    "seeded": "buildDemoDoc({ seed: 7 })",
    "testfit": "buildTestFitDoc()",
    "dwg": "buildDwgDoc({ esbuild: build })",
}


# ---------------------------------------------------------------- core state --
def core_state(case: str) -> dict:
    """Re-run the Rust core and return its document. This is the gate's ground
    truth: upstream of every export, and not something the producer can edit."""
    if case not in CASE_BUILDERS:
        raise RuntimeError(f"unknown --case {case!r}; expected one of {sorted(CASE_BUILDERS)}")
    prog = f"""
      import {{ createRequire }} from 'node:module'
      import {{ pathToFileURL }} from 'node:url'
      import path from 'node:path'
      import {{ REPO, buildDemoDoc, buildTestFitDoc, buildDwgDoc }} from './scripts/lib/demo-doc.mjs'
      const webRequire = createRequire(path.join(REPO, 'web/package.json'))
      const {{ build }} = await import(
        pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href)
      const doc = await {CASE_BUILDERS[case]}
      const s = doc.state
      process.stdout.write(JSON.stringify({{
        components: s.components,
        zones: s.zones ?? [],
        walls: s.walls.map((w) => ({{ a: w.a, b: w.b }})),
      }}))
    """
    r = subprocess.run([G.which("node"), "--input-type=module", "-e", prog],
                       cwd=G.REPO, capture_output=True, text=True, timeout=600)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(
            f"could not rebuild the '{case}' document from the Rust core "
            f"(rc={r.returncode}): {r.stderr.strip()[-500:]}")
    return json.loads(r.stdout)


# ----------------------------------------------------------------- geometry --
def corners(c: dict):
    """The four world-space corners of a component's footprint."""
    cs, sn = math.cos(c["rotation"]), math.sin(c["rotation"])
    for lx, ly in ((-c["w"] / 2, -c["h"] / 2), (c["w"] / 2, -c["h"] / 2),
                   (c["w"] / 2, c["h"] / 2), (-c["w"] / 2, c["h"] / 2)):
        yield c["x"] + lx * cs - ly * sn, c["y"] + lx * sn + ly * cs


def fit(state: dict, w_px: int, h_px: int):
    """world -> canvas, recomputed from the model exactly as the renderer fits
    it: the bbox of every wall endpoint and every component corner, padded."""
    xs, ys = [], []
    for w in state["walls"]:
        xs += [w["a"]["x"], w["b"]["x"]]
        ys += [w["a"]["y"], w["b"]["y"]]
    for c in state["components"]:
        for x, y in corners(c):
            xs.append(x)
            ys.append(y)
    if not xs:
        raise RuntimeError("the core document has no geometry to project")
    min_x, min_y, max_x, max_y = min(xs), min(ys), max(xs), max(ys)
    span_x, span_y = max(max_x - min_x, 0.001), max(max_y - min_y, 0.001)
    k = min((w_px - 2 * PAD_PX) / span_x, (h_px - 2 * PAD_PX) / span_y)
    return k, (w_px - span_x * k) / 2 - min_x * k, (h_px - span_y * k) / 2 - min_y * k


def shape_area(s: dict) -> float:
    if s["kind"] == "Rect":
        return s["w"] * s["h"]
    if s["kind"] == "RectRing":
        return s["w"] * s["h"] - s["in_w"] * s["in_h"]
    pts = s["pts"]
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def point_in_shape(s: dict, x: float, y: float) -> bool:
    if s["kind"] == "Rect":
        return abs(x - s["x"]) <= s["w"] / 2 and abs(y - s["y"]) <= s["h"] / 2
    if s["kind"] == "RectRing":
        outer = abs(x - s["x"]) <= s["w"] / 2 and abs(y - s["y"]) <= s["h"] / 2
        inner = abs(x - s["x"]) <= s["in_w"] / 2 and abs(y - s["y"]) <= s["in_h"] / 2
        return outer and not inner
    pts = s["pts"]
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def zone_at(x: float, y: float, zones: list):
    """The core's own rule: a specific zone outranks Circulation; within a class
    the SMALLEST-area zone wins (crates/ds-core Document::zone_index_at)."""
    chosen, chosen_area, specific = None, 0.0, False
    for z in zones:
        if not point_in_shape(z["shape"], x, y):
            continue
        circ = z["zone_type"] == "Circulation"
        a = shape_area(z["shape"])
        if circ and specific:
            continue
        if not circ and not specific:
            chosen, chosen_area, specific = z, a, True
        elif chosen is None or a < chosen_area:
            chosen, chosen_area = z, a
    return chosen


def item_name(category: str) -> str:
    """'MeetingRoom' -> 'Meeting Room' — the catalog's own label rule."""
    return re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", category)


def item_description(c: dict) -> str:
    """"Desk W70 X L140": W is the shorter side, L the longer (takeoff.ts)."""
    a = round(min(c["w"], c["h"]) * 100)
    b = round(max(c["w"], c["h"]) * 100)
    return f"{item_name(c['category'])} W{a} X L{b}"


# ------------------------------------------------------------------- pixels --
def is_furniture_ink(p) -> bool:
    """Cool-neutral CAD line-work: BLUE ABOVE GREEN, low chroma, not near-white.

    Blue-above-green rather than blue-above-red because furniture inside a
    circulation zone is painted over by the pink wash (rgba(255,0,0,25), drawn
    after the print plan), which pushes red up: #2e343b under the wash reads
    (66,47,53), warm. The wash multiplies green and blue by the same factor and
    only lifts red, so b > g survives it, while every pure-neutral pixel —
    room-label ink on white AND on the wash, both of which have g == b exactly —
    stays out. Measured on out/cases/dwg/plan.png: washed stroke (66,47,53)
    b-g=6, washed light blend (207,184,185) b-g=1, the wash itself
    (255,230,230) b-g=0.
    """
    r, g, b = p[0], p[1], p[2]
    return (b - g) >= 1 and (max(r, g, b) - min(r, g, b)) <= 30 and max(r, g, b) <= 235


def is_label_ink(p) -> bool:
    """Pure neutral and dark — black room-ID text and its anti-aliasing."""
    return p[0] == p[1] == p[2] and p[0] <= 200


def label_mask(im, halo: int):
    """Room-label ink dilated by `halo`, as a 0/1 lookup grid."""
    from PIL import ImageChops, ImageFilter
    r, g, b = im.split()
    same = ImageChops.lighter(ImageChops.difference(r, g), ImageChops.difference(g, b))
    neutral = same.point(lambda v: 255 if v == 0 else 0)
    dark = r.point(lambda v: 255 if v <= 200 else 0)
    m = ImageChops.multiply(neutral, dark)
    if halo > 0:
        m = m.filter(ImageFilter.MaxFilter(2 * halo + 1))
    return m.load(), m.histogram()[255]


# --------------------------------------------------------------------- gate --
def body(g: G.Gate):
    planp = G.arg("--plan", G.DEFAULTS["plan"])
    wbp = G.arg("--workbook", G.DEFAULTS["workbook"])
    case = G.arg("--case", "seeded")
    min_ink = float(G.arg("--min-ink-per-outline", str(MIN_INK_PER_OUTLINE)))

    G.require_file(wbp, "workbook")
    im = G.open_rgb(planp, "plan png").convert("RGB")
    W, H = im.size
    px = im.load()

    state = core_state(case)
    zones = state["zones"]
    k, ox, oy = fit(state, W, H)

    # ---- 1. emission: workbook rows vs the core's own furniture --------------
    derived = {}   # (roomId, description) -> count
    placed = []    # (roomId, description, component)
    for c in state["components"]:
        if c["category"] in NOT_FURNITURE or c.get("reference"):
            continue
        z = zone_at(c["x"], c["y"], zones)
        rid = str(z["id"]) if z else "OS"
        desc = item_description(c)
        derived[(rid, desc)] = derived.get((rid, desc), 0) + 1
        placed.append((rid, desc, c))

    wb = G.load_wb(wbp)
    if not g.check("Furniture Inventory" in wb.sheetnames,
                   "workbook has no 'Furniture Inventory' sheet to check the plan against"):
        return
    ws = wb["Furniture Inventory"]
    hdr = {str(c.value).strip().lower(): c.column_letter
           for c in ws[4] if isinstance(c.value, str) and c.value.strip()}
    for want in ("room id", "item description", "quantity"):
        g.check(want in hdr, f"Furniture Inventory header row 4 missing {want!r} (saw {sorted(hdr)})")
    if g.reasons:
        return
    billed = {}
    for r in range(5, min(ws.max_row, 5000) + 1):
        rid = ws[f"{hdr['room id']}{r}"].value
        desc = ws[f"{hdr['item description']}{r}"].value
        qty = ws[f"{hdr['quantity']}{r}"].value
        if rid is None or not isinstance(desc, str) or not desc.strip():
            continue
        if not isinstance(qty, (int, float)):
            g.fail(f"Furniture Inventory row {r} Quantity is not numeric: {qty!r}")
            continue
        key = (str(rid).strip(), desc.strip())
        billed[key] = billed.get(key, 0) + int(qty)

    g.check(bool(billed), "Furniture Inventory bills no furniture at all")
    for key in sorted(set(billed) | set(derived)):
        rid, desc = key
        b, d = billed.get(key, 0), derived.get(key, 0)
        g.check(b == d,
                f"room {rid} '{desc}': the workbook bills {b}, the model places {d} — "
                "the takeoff and the plan are not the same document")
    g.note(f"emission: {sum(billed.values())} billed / {sum(derived.values())} placed "
           f"instances across {len({r for r, _ in derived})} rooms — case '{case}'")

    # ---- 2. visibility: every billed instance still reads on the PNG ---------
    # Sanity: the transform this gate recomputed must land the model on the ink.
    xs = [x * k + ox for c in state["components"] for x, _ in corners(c)]
    ys = [y * k + oy for c in state["components"] for _, y in corners(c)]
    g.check(-1 <= min(xs) and max(xs) <= W + 1 and -1 <= min(ys) and max(ys) <= H + 1,
            f"the gate's re-derived world->canvas transform projects furniture outside the "
            f"{W}x{H} plan ({min(xs):.0f}..{max(xs):.0f}, {min(ys):.0f}..{max(ys):.0f}) — "
            "the renderer's fit and this gate's have diverged; every measurement below "
            "would be meaningless")

    lab, n_lab = label_mask(im, LABEL_HALO_PX)
    g.check(n_lab > 0,
            "no room-label ink (pure-neutral dark pixels) found anywhere on the plan — "
            "either the labels are gone or they no longer use palette.json "
            "plan.room_label_text, and this gate can no longer tell label ink from "
            "furniture ink")

    worst = {}   # roomId -> (ratio, description, label coverage)
    n_ink = 0
    for rid, desc, c in placed:
        cx = [x * k + ox for x, _ in corners(c)]
        cy = [y * k + oy for _, y in corners(c)]
        x0, y0 = int(math.floor(min(cx))), int(math.floor(min(cy)))
        x1, y1 = int(math.ceil(max(cx))), int(math.ceil(max(cy)))
        ink = tot = cov = 0
        for y in range(max(0, y0), min(H, y1)):
            for x in range(max(0, x0), min(W, x1)):
                tot += 1
                if lab[x, y]:
                    cov += 1
                if is_furniture_ink(px[x, y]):
                    ink += 1
        outline = 2 * (c["w"] * k + c["h"] * k)
        ratio = ink / outline if outline > 0 else 0.0
        n_ink += ink
        cur = worst.get(rid)
        if cur is None or ratio < cur[0]:
            worst[rid] = (ratio, desc, cov / tot if tot else 1.0)

    g.check(n_ink > 0,
            "not one billed furniture footprint contains any furniture line-work ink — "
            "either the plan draws no furniture at all, or PRINT_STROKE/PRINT_DETAIL "
            "changed hue and this gate is measuring the wrong pixels")

    for rid in sorted(worst, key=lambda r: worst[r][0]):
        ratio, desc, cov = worst[rid]
        g.check(ratio >= min_ink,
                f"room {rid}: the workbook bills '{desc}' and the plan does not show it — "
                f"its footprint holds {ratio:.2f} ink px per px of symbol outline "
                f"(floor {min_ink:.2f}; label ink + halo covers {cov * 100:.0f}% of it). "
                "Billed but invisible is the same contradiction as billed but undrawn")

    ok = sorted(v[0] for v in worst.values())
    g.note(f"visibility: {len(placed)} instances, {len(worst)} rooms · worst-per-room "
           f"ink/outline min={ok[0]:.2f} p25={ok[len(ok) // 4]:.2f} "
           f"median={ok[len(ok) // 2]:.2f} (floor {min_ink:.2f})")
    # The scoreboard line caps at four reasons; name every hidden room here so a
    # failure is actionable in one read.
    hidden = [r for r in sorted(worst, key=lambda r: worst[r][0]) if worst[r][0] < min_ink]
    if hidden:
        g.note("rooms whose furniture the plan hides: "
               + ", ".join(f"{r}({worst[r][0]:.2f})" for r in hidden))


G.run_gate("G11", body)
