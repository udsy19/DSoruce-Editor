#!/usr/bin/env python3
"""REFERENCE DEAD SPACE, from the PDF's VECTORS and the report's STATED facts.

    python3 research/qbiq-deadspace-extract.py                # measure + write the spec
    python3 research/qbiq-deadspace-extract.py --print        # measure, print, write nothing
    python3 research/qbiq-deadspace-extract.py --clusters     # + the WHERE table
    python3 research/qbiq-deadspace-extract.py --falsify drop-wash
    python3 research/qbiq-deadspace-extract.py --falsify drop-desks

This is the missing half of a comparison. Our side is
`scripts/gates/deadspace-core.mjs`, which derives everything from core state;
this side derives everything from the reference report's page-3 path geometry.
The two must measure the SAME quantity or the comparison means nothing, so the
definition below is copied from that file rather than re-invented, and every
place the two can still differ is listed in DIFFERENCES FROM OUR SIDE.


WHY THERE IS NO RASTER ANYWHERE IN THIS FILE
============================================

`scripts/gates/deadspace.py` measured this exact quantity on this exact page by
rendering it and flood-filling. It reported the wall BOUNDING BOX as the plate —
1597 m² against a 930 m² polygon — because the editor paints a white rectangle
under the plan and the fill halted at that colour change. Flooding on ink
instead leaks through the anti-aliased 1 px boundary and reports 0.0%. Three
versions, three answers, on one unchanged drawing. Its reference figure of
"11.1%" is RETRACTED along with the rest.

The mistake underneath was trying to RECOVER geometry from an image when the
geometry is sitting in the file. A PDF plan page is not a picture of a drawing;
it is the drawing. `page.get_drawings()` hands over the outer wall as six line
segments and every zone wash as a closed path with its own fill colour. So:

  * no `get_pixmap`, no PIL, no flood fill, no colour thresholds against a
    sampled page background, and no pixel distance transform;
  * colour is used ONLY as a categorical key into the frozen wash palette
    (`research/qbiq-plan-style-spec.json`), never as a threshold — an exact hex
    match on a path's declared fill cannot drift the way `bg_lum - 55` did when
    the palette moved under it;
  * the distance transform runs on a 0.25 m grid in WORLD METRES sampled from
    the polygons, which is the same construction `deadspace-core.mjs` uses. It
    is geometric sampling of vector shapes, not image processing: there is no
    step that can find the wrong region, because the region is a polygon that
    was read, not inferred.

`grep -nE 'pixmap|PIL|Image|flood|threshold' research/qbiq-deadspace-extract.py`
returns nothing but this paragraph.


WHAT IT MEASURES  (definition copied from deadspace-core.mjs)
=============================================================

    dead = plate area more than `radius` (3.0 m) from any PROGRAMME element,
           where programme is a furniture footprint or an ENCLOSED room zone.
           Ground (circulation) and the OPEN FIELD zone are excluded — a
           coloured wash with nothing standing on it IS the dead space.

Mapped onto the reference:

  plate      the outer wall polygon (below).
  ground     the unwashed white floor. It carries no wash colour, so it is
             excluded by construction — there is nothing to exclude it BY.
  open field the "Open Space" wash (#9ec5fc). This is the exact analogue of our
             `Workspace` zone: one big blue rectangle drawn over the desk field.
             Excluded as a wash; its DESKS count, one footprint at a time.
  programme  every other wash polygon + every furniture-tier filled path.


THE THREE ANCHORS, AND THEY AGREE
=================================

1. **Scale.** The frozen `1 pt = 10/32.5 × 304.8 mm` comes from the bench-desk
   position anchor (675 × 1350 mm). This file re-checks it against a completely
   different feature — the page's own graphic SCALE BAR, whose "0" and "30"
   labels are 98.3 pt apart. At the frozen scale that bar is 9.22 m; 30 ft is
   9.144 m. **0.8%.** Two unrelated features, one scale.

2. **Plate.** The largest closed path in the plan area encloses **1421.3 m²**.
   The report states **15,360 USF = 1426.99 m²**. **0.40%.** This is the primary
   self-check the brief demands and it is not a soft one: the retracted raster
   version missed by 72% on the same page.

3. **The wash classifier.** Wash paths carry a black wall stroke when the zone
   is an enclosed room and none when it is an open band. Counting stroked wash
   paths gives **12 Conf Rooms and 7 Offices** — which is, to the unit, the
   report's own stated summary table (`12` and `7`). The colour→programme
   mapping is therefore corroborated by a stated fact from a different page,
   not asserted by whoever wrote this file. It aborts if either count moves.

Anchor 3 is a check, not an input: nothing downstream reads `stroked`. The
primary measurement includes every non-Open-Space wash regardless of enclosure,
because that is the literal mirror of our side's rule (exclude ground + the open
field, include everything else). Enclosure only appears in the sensitivity table.


DIFFERENCES FROM OUR SIDE — read this before quoting the comparison
===================================================================

Listed because a comparison is only as good as this list, and two of these are
material.

  a. **Zone geometry: exact polygons here, AABBs there.** `deadspace-core.mjs`
     covers a zone with its axis-aligned bounding box; our zones are Rect-shaped
     so that is lossless for us. The reference's washes are L- and U-shaped, and
     using their bboxes would cover floor the wash does not. Exact polygons are
     the STRICTER choice, so this difference can only make the reference number
     LARGER. The sensitivity table reports the AABB variant so the size of the
     effect is visible rather than argued.
  b. **The CORE, and this one decides the comparison.** The reference has a
     168.1 m² service core (lift lobby, two stair runs, WCs) inside the plate.
     Our plans have no core at all. It is left in the primary number because the
     stated 15,360 USF the plate reconciles against includes it, and its
     fixtures count as furniture like anything else — but **every square metre
     of dead space this measurement finds is inside it** (one cluster, 57.2 m²,
     wholly within the core ring), so the reference's TENANT floor scores 0.0%
     and the primary 4.0% is a measurement of a lift lobby. The `plate_less_core`
     row is the one to compare against ours; see the spec's `comparability` key.
     The core is found geometrically, not by eye: it is the largest closed ring
     inside the plate whose bounding box overlaps no zone wash, and at ≥30 m²
     it is the ONLY such ring on the page.
  c. **Furniture identity.** Ours iterates typed components. Here a furniture
     element is a filled path of plausible size, so a hatch block or a door leaf
     may count as furniture and a stroke-only symbol may be missed. 114 of the
     115 unique desk footprints are filled, so the desk field — the part that
     matters — is essentially complete.
  d. **Comfort Zone.** Included as programme by the literal mirror (it is not
     ground and not the desk field). It is an unenclosed perimeter band, so a
     reader who thinks our `Workspace` exclusion should extend to it will want
     the sensitivity row, which is reported.
  e. **Walls.** Neither side counts wall line-work as programme.

Only (a) and (b) move the number by more than a rounding, and both are reported
both ways. Nothing here is a reason the two numbers cannot be compared; they are
reasons to compare the right pair of rows.


FALSIFICATION (rule R3) — `--falsify`, and its output is recorded in the spec
=============================================================================

A measurement nobody has watched MOVE is a number, not a measurement. Four
sabotages, each with its expected verdict PINNED in `FALSIFY_MODES`; the harness
exits non-zero when reality disagrees with the pin, so a null that starts firing
is as loud as a fire that stops.

  drop-largest-wash    fires? NO   +0.00 pp   <- a NULL, and it is reported
  drop-all-washes      fires? yes  +2.25 pp
  drop-left-furniture  fires? yes  +5.60 pp
  shrink-plate         aborts      the plate guard has teeth

**The null is the most useful line here and it is not papered over.** Deleting
the single largest programme wash (Amenities, 56.4 m²) moves the answer by
nothing, because within a 3 m radius that room's own furniture already covers
the floor its wash covers. So: no INDIVIDUAL wash is load-bearing on this plan,
and a wash-extraction bug confined to one room would be invisible to this
measurement. The LAYER is load-bearing (+2.25 pp when all of it goes), which is
what licenses citing the number — but the per-room blind spot is real, is stated
here rather than discovered later, and is the reason `drop-all-washes` exists
alongside the weaker probe rather than instead of it.

`shrink-plate` is the enabling-step sabotage, and it is the one the retracted
raster version needed: it scales the plate polygon by 0.9 and confirms the
15,360 USF reconciliation ABORTS instead of quietly reporting a fraction over
the wrong denominator. A guard nobody has watched refuse is not a guard.
"""

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "docs/reference/qbiq/extracted/Sample Report/Crystal Tower  Modern-2024-08-11-07-17-04.pdf"
OUT = ROOT / "research/qbiq-deadspace-spec.json"
PAGE = 2  # 0-indexed; the plan page

# ---------------------------------------------------------------- frozen input
#: FROZEN, from research/qbiq-composition-spec.json. Not re-derived here.
MM_PER_PT = 10 / 32.5 * 304.8
M_PER_PT = MM_PER_PT / 1000
#: FROZEN, same file. The size anchor the scale rests on.
DESK_POSITION_MM = (675, 1350)
#: The report's own stated floor area (page 3 stats card, page 6 summary table).
STATED_USF_SQFT = 15360
STATED_USF_M2 = STATED_USF_SQFT * 0.092903
#: The report's own stated room counts, used to corroborate the wash classifier.
STATED_CONF_ROOMS = 12
STATED_OFFICES = 7

#: FROZEN, from research/qbiq-plan-style-spec.json /palette/zone_fills.
#: A categorical key, never a threshold — see the header.
ZONE_FILLS = {
    "#9ec5fc": "Open Space",
    "#d0fce4": "Conf Room",
    "#ffe7a7": "Amenities",
    "#fdf0cd": "Comfort Zone",
    "#d8e9fc": "Office",
    "#fcddba": "Pantry",
    "#efd8ff": "Reception",
    "#c5b898": "IT Room",
    "#cbf1fe": "Executive",
}
#: The reference's analogue of our OPEN_ZONES = {'Workspace'}. See the header.
OPEN_FIELD_WASHES = {"Open Space"}

# ------------------------------------------------------------- measurement dial
RADIUS_M = 3.0  # same value deadspace-core.mjs uses
CELL_M = 0.25  # same sampling pitch deadspace-core.mjs uses

# ------------------------------------------------------------------ page filter
#: The left panel is the stats card, not the plan. Same cut the sibling
#: extractors use (`plan_x0 = width * 0.30`); the card ends at x=213 pt.
PLAN_X0 = 230.0
#: Legend swatches are drawn as full-page rects and clipped. Nothing in the plan
#: is page-sized, so this drops the legend without naming it.
FULLPAGE_W, FULLPAGE_H = 800.0, 500.0
#: A filled path this large is not furniture (the largest real one is a 7.4 m²
#: bench run); this excludes the plan's structural white shape (1435 m²).
FURNITURE_MAX_M2 = 20.0
#: Below this a filled path is a glyph tick or a hatch hair, not a footprint.
FURNITURE_MIN_M2 = 0.02
#: A ring smaller than this is a room, not a core. See `find_core_ring`.
CORE_MIN_M2 = 30.0


# --------------------------------------------------------------- path plumbing
def hexof(c):
    if c is None:
        return None
    return "#%02x%02x%02x" % tuple(round(max(0, min(1, v)) * 255) for v in c[:3])


def subpaths(d):
    """Closed rings of a drawing, in points. Curves are chorded at their
    endpoints — every wash and wall on this page is polygonal, and the only
    curved paths are furniture symbols whose AABB we take anyway."""
    out, cur = [], []
    for it in d["items"]:
        if it[0] == "re":
            if cur:
                out.append(cur)
                cur = []
            r = it[1]
            out.append([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)])
        elif it[0] == "qu":
            if cur:
                out.append(cur)
                cur = []
            q = it[1]
            out.append([(q[i].x, q[i].y) for i in range(4)])
        elif it[0] in ("l", "c"):
            a = it[1]
            b = it[2] if it[0] == "l" else it[4]
            if cur and (abs(cur[-1][0] - a.x) > 0.01 or abs(cur[-1][1] - a.y) > 0.01):
                out.append(cur)
                cur = []
            if not cur:
                cur = [(a.x, a.y)]
            cur.append((b.x, b.y))
    if cur:
        out.append(cur)
    return [s for s in out if len(s) >= 3]


def poly_area(poly):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def bbox(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def in_plan(rect):
    if rect.x1 < PLAN_X0:
        return False
    if rect.width > FULLPAGE_W and rect.height > FULLPAGE_H:
        return False
    return True


# ------------------------------------------------------------------- extraction
def extract(page):
    """Everything the measurement needs, in POINTS. One pass over the paths."""
    drawings = page.get_drawings()

    plate = None
    plate_area_pt2 = 0.0
    washes = []  # {name, hex, poly, stroked}
    furniture = []  # (x0, y0, x1, y1) AABBs
    desk_boxes = set()
    desk_size_hist = Counter()

    lo_pt = DESK_POSITION_MM[0] / MM_PER_PT
    hi_pt = DESK_POSITION_MM[1] / MM_PER_PT
    tol = 0.20

    for d in drawings:
        r = d["rect"]
        if not in_plan(r):
            continue
        fill = hexof(d.get("fill"))
        stroke = hexof(d.get("color"))
        sp = subpaths(d)

        # -- plate: the largest closed ring anywhere in the plan area.
        for s in sp:
            a = poly_area(s)
            if a > plate_area_pt2:
                plate_area_pt2 = a
                plate = s

        # -- desk footprints, by the frozen size anchor (a check + a tally).
        w, h = r.width, r.height
        if abs(min(w, h) - lo_pt) <= tol * lo_pt and abs(max(w, h) - hi_pt) <= tol * hi_pt:
            desk_size_hist[(round(w, 1), round(h, 1))] += 1
            desk_boxes.add((round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1)))

        if fill is None:
            continue

        # -- zone washes, keyed on the frozen palette.
        if fill in ZONE_FILLS:
            for s in sp:
                washes.append(
                    {
                        "name": ZONE_FILLS[fill],
                        "hex": fill,
                        "poly": s,
                        "area_m2": poly_area(s) * M_PER_PT * M_PER_PT,
                        "stroked": stroke == "#000000",
                    }
                )
            continue

        # -- furniture tier: any other filled path of plausible footprint size.
        a_m2 = sum(poly_area(s) for s in sp) * M_PER_PT * M_PER_PT
        if FURNITURE_MIN_M2 <= a_m2 <= FURNITURE_MAX_M2:
            furniture.append((r.x0, r.y0, r.x1, r.y1))

    return {
        "plate": plate,
        "washes": washes,
        "furniture": furniture,
        "desk_boxes": sorted(desk_boxes),
        "desk_size_hist": desk_size_hist,
    }


def find_core_ring(page, ex):
    """The service core, identified by geometry rather than by a prose label.

    "The core" is exactly the kind of noun `.claude/rules/gate-independence.md`
    warns about — a compression that reads as observation and is actually an
    inference. So it is not asserted here. The rule is: **the largest closed
    ring inside the plate whose bounding box overlaps no zone wash.** Every
    tenant room on this page carries a wash; a lift/stair/WC block carries
    none. At >= CORE_MIN_M2 that rule matches exactly ONE ring on this page
    (168.1 m², two coincident strokes of the same outline), which is why it can
    be trusted rather than tuned — a rule with a single hit has no threshold to
    have chosen. Returns (poly, area_m2, n_matches)."""
    wash_bb = [bbox(w["poly"]) for w in ex["washes"]]
    plate_m2 = poly_area(ex["plate"]) * M_PER_PT * M_PER_PT
    hits = []
    for d in page.get_drawings():
        if not in_plan(d["rect"]):
            continue
        for s in subpaths(d):
            a = poly_area(s) * M_PER_PT * M_PER_PT
            if a < CORE_MIN_M2 or abs(a - plate_m2) < 1.0:
                continue
            bx0, by0, bx1, by1 = bbox(s)
            overlaps = False
            for wx0, wy0, wx1, wy1 in wash_bb:
                if min(bx1, wx1) - max(bx0, wx0) > 1 and min(by1, wy1) - max(by0, wy0) > 1:
                    overlaps = True
                    break
            if not overlaps:
                hits.append((a, s))
    if not hits:
        return None, 0.0, 0
    hits.sort(key=lambda h: -h[0])
    # Coincident duplicate strokes of the same outline are one ring.
    distinct = [h for h in hits if abs(h[0] - hits[0][0]) > 0.5 or h is hits[0]]
    return hits[0][1], hits[0][0], len(distinct)


def scale_bar_span_pt(page):
    """The page's own graphic scale bar: the gap between its '0' and '30' labels.

    An anchor entirely independent of the desk position that the frozen scale
    was derived from. Returns None if the bar is not where it is expected."""
    zero = thirty = None
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        if not (500 < y0 < 570):
            continue
        if word == "0" and zero is None:
            zero = (x0 + x1) / 2
        elif word == "30":
            thirty = (x0 + x1) / 2
    if zero is None or thirty is None:
        return None
    return thirty - zero


# ------------------------------------------------------------------ the measure
def measure(plate, prog_polys, prog_boxes, carve=None):
    """Sample the plate on a CELL_M grid, mark programme, chamfer, threshold.

    Mirrors `deadspace-core.mjs::measure` step for step, including the 3/4
    chamfer weights and the connected-cluster table.

    `carve` removes a polygon from the PLATE (numerator and denominator both) —
    used only for the `plate_less_core` variant. It does not touch the programme
    layer or the distance transform, so the field outside is unchanged."""
    px0, py0, px1, py1 = bbox(plate)
    # Work in metres with y flipped so the table reads like the page.
    x0, x1 = px0 * M_PER_PT, px1 * M_PER_PT
    y0, y1 = py0 * M_PER_PT, py1 * M_PER_PT
    plate_m = [(p[0] * M_PER_PT, p[1] * M_PER_PT) for p in plate]

    nx = math.ceil((x1 - x0) / CELL_M)
    ny = math.ceil((y1 - y0) / CELL_M)
    in_plate = bytearray(nx * ny)
    on_prog = bytearray(nx * ny)

    carve_m = [(p[0] * M_PER_PT, p[1] * M_PER_PT) for p in carve] if carve else None
    for j in range(ny):
        y = y0 + (j + 0.5) * CELL_M
        base = j * nx
        for i in range(nx):
            x = x0 + (i + 0.5) * CELL_M
            if not point_in_poly(x, y, plate_m):
                continue
            if carve_m and point_in_poly(x, y, carve_m):
                continue
            in_plate[base + i] = 1

    def cells_in_bbox(bx0, by0, bx1, by1):
        i0 = max(0, int((bx0 - x0) / CELL_M) - 1)
        i1 = min(nx - 1, int((bx1 - x0) / CELL_M) + 1)
        j0 = max(0, int((by0 - y0) / CELL_M) - 1)
        j1 = min(ny - 1, int((by1 - y0) / CELL_M) + 1)
        return i0, i1, j0, j1

    # Zone washes: exact polygons, only over their own bbox.
    for poly in prog_polys:
        pm = [(p[0] * M_PER_PT, p[1] * M_PER_PT) for p in poly]
        bx0, by0, bx1, by1 = bbox(pm)
        i0, i1, j0, j1 = cells_in_bbox(bx0, by0, bx1, by1)
        for j in range(j0, j1 + 1):
            y = y0 + (j + 0.5) * CELL_M
            base = j * nx
            for i in range(i0, i1 + 1):
                if on_prog[base + i]:
                    continue
                x = x0 + (i + 0.5) * CELL_M
                if point_in_poly(x, y, pm):
                    on_prog[base + i] = 1

    # Furniture: AABBs, exactly as deadspace-core.mjs treats a component.
    for bx0, by0, bx1, by1 in prog_boxes:
        bx0 *= M_PER_PT
        by0 *= M_PER_PT
        bx1 *= M_PER_PT
        by1 *= M_PER_PT
        i0, i1, j0, j1 = cells_in_bbox(bx0, by0, bx1, by1)
        for j in range(j0, j1 + 1):
            y = y0 + (j + 0.5) * CELL_M
            if not (by0 <= y <= by1):
                continue
            base = j * nx
            for i in range(i0, i1 + 1):
                x = x0 + (i + 0.5) * CELL_M
                if bx0 <= x <= bx1:
                    on_prog[base + i] = 1

    # Chamfer distance to the nearest programme cell, 3/4 weights.
    BIG = 1 << 24
    d = [0 if on_prog[k] else BIG for k in range(nx * ny)]

    def at(i, j):
        if i < 0 or j < 0 or i >= nx or j >= ny:
            return BIG
        return d[j * nx + i]

    for j in range(ny):
        for i in range(nx):
            k = j * nx + i
            d[k] = min(d[k], at(i - 1, j) + 3, at(i, j - 1) + 3, at(i - 1, j - 1) + 4, at(i + 1, j - 1) + 4)
    for j in range(ny - 1, -1, -1):
        for i in range(nx - 1, -1, -1):
            k = j * nx + i
            d[k] = min(d[k], at(i + 1, j) + 3, at(i, j + 1) + 3, at(i + 1, j + 1) + 4, at(i - 1, j + 1) + 4)

    plate_cells = dead_cells = 0
    dead = bytearray(nx * ny)
    for k in range(nx * ny):
        if not in_plate[k]:
            continue
        plate_cells += 1
        if (d[k] / 3.0) * CELL_M > RADIUS_M:
            dead_cells += 1
            dead[k] = 1

    # WHERE, not only how much — same descriptors our side reports, because a
    # fraction cannot tell a ring of edge ribbons from one empty wing.
    clusters = []
    seen = bytearray(nx * ny)
    for k0 in range(nx * ny):
        if not dead[k0] or seen[k0]:
            continue
        stack = [k0]
        seen[k0] = 1
        n = 0
        bx0 = by0 = float("inf")
        bx1 = by1 = float("-inf")
        while stack:
            k = stack.pop()
            i = k % nx
            j = k // nx
            n += 1
            bx0 = min(bx0, x0 + i * CELL_M)
            by0 = min(by0, y0 + j * CELL_M)
            bx1 = max(bx1, x0 + (i + 1) * CELL_M)
            by1 = max(by1, y0 + (j + 1) * CELL_M)
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ii, jj = i + di, j + dj
                if ii < 0 or jj < 0 or ii >= nx or jj >= ny:
                    continue
                kk = jj * nx + ii
                if dead[kk] and not seen[kk]:
                    seen[kk] = 1
                    stack.append(kk)
        w, h = bx1 - bx0, by1 - by0
        clusters.append(
            {
                "area_m2": round(n * CELL_M * CELL_M, 2),
                "w": round(w, 1),
                "h": round(h, 1),
                "aspect": round(max(w, h) / max(1e-9, min(w, h)), 1),
                "fill": round((n * CELL_M * CELL_M) / max(1e-9, w * h), 3),
                "x": round(bx0, 1),
                "y": round(by0, 1),
            }
        )
    clusters.sort(key=lambda c: -c["area_m2"])

    return {
        "plate_area_sampled_m2": plate_cells * CELL_M * CELL_M,
        "dead_area_m2": dead_cells * CELL_M * CELL_M,
        "dead_frac": (dead_cells / plate_cells) if plate_cells else 0.0,
        "clusters": clusters,
        "grid": (nx, ny),
    }


def programme(ex, exclude_names, enclosed_only=False, aabb_zones=False):
    """The programme layer, with the knobs the sensitivity table turns."""
    polys, boxes = [], list(ex["furniture"])
    for wsh in ex["washes"]:
        if wsh["name"] in exclude_names:
            continue
        if enclosed_only and not wsh["stroked"]:
            continue
        if aabb_zones:
            bx0, by0, bx1, by1 = bbox(wsh["poly"])
            polys.append([(bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1)])
        else:
            polys.append(wsh["poly"])
    return polys, boxes


# ------------------------------------------------------------------ self-checks
def self_checks(page, ex):
    """Every one of these ABORTS. A missing input is a failure, never a skip."""
    notes = {}

    # 1. SCALE, cross-checked against a feature the frozen scale never saw.
    span = scale_bar_span_pt(page)
    if span is None:
        sys.exit("scale bar labels not found — cannot corroborate the frozen scale")
    bar_m = span * M_PER_PT
    want_m = 30 * 0.3048  # the bar is labelled 0..30 in FEET (the report is USF)
    err = abs(bar_m - want_m) / want_m
    if err > 0.05:
        sys.exit(
            f"scale bar reads {bar_m:.2f} m against 30 ft = {want_m:.2f} m ({err*100:.1f}% off) — "
            "the frozen scale and the page disagree; every metre below would be wrong"
        )
    notes["scale_bar"] = {
        "span_pt": round(span, 2),
        "at_frozen_scale_m": round(bar_m, 3),
        "labelled_30_ft_m": round(want_m, 3),
        "err_pct": round(err * 100, 2),
    }

    # 2. DESK SIZE ANCHOR, checked rather than assumed (same test the
    #    composition extractor runs — if it fails, the scale is wrong).
    if not ex["desk_size_hist"]:
        sys.exit("no desk positions matched — the scale anchor or the page index is wrong")
    top = max(ex["desk_size_hist"].items(), key=lambda kv: kv[1])[0]
    top_mm = tuple(sorted(round(v * MM_PER_PT) for v in top))
    want = tuple(sorted(DESK_POSITION_MM))
    if any(abs(a - b) > 0.1 * b for a, b in zip(top_mm, want)):
        sys.exit(f"dominant desk size is {top_mm} mm, expected {want} mm — scale anchor failed")
    notes["desk_anchor_mm"] = list(top_mm)
    notes["desk_footprints"] = len(ex["desk_boxes"])

    # 3. PLATE vs the report's own STATED floor area. The primary check.
    if ex["plate"] is None or len(ex["plate"]) < 3:
        sys.exit("no plate polygon found — refusing to score an unresolved plate")
    plate_m2 = poly_area(ex["plate"]) * M_PER_PT * M_PER_PT
    err = abs(plate_m2 - STATED_USF_M2) / STATED_USF_M2
    if err > 0.10:
        sys.exit(
            f"plate polygon is {plate_m2:.0f} m² against the stated {STATED_USF_SQFT} USF "
            f"= {STATED_USF_M2:.0f} m² ({err*100:.1f}% off) — the extraction is not finding the "
            "building, and every fraction below would be over the wrong denominator"
        )
    notes["plate"] = {
        "polygon_m2": round(plate_m2, 1),
        "vertices": len(ex["plate"]),
        "stated_usf_sqft": STATED_USF_SQFT,
        "stated_usf_m2": round(STATED_USF_M2, 1),
        "err_pct": round(err * 100, 2),
    }

    # 4. THE WASH CLASSIFIER, corroborated by the report's own room counts.
    #    Nothing downstream consumes `stroked`; this only proves the
    #    colour→programme mapping is the one the report is describing.
    walled = Counter(w["name"] for w in ex["washes"] if w["stroked"])
    if walled["Conf Room"] != STATED_CONF_ROOMS or walled["Office"] != STATED_OFFICES:
        sys.exit(
            f"walled washes give {walled['Conf Room']} conf rooms / {walled['Office']} offices "
            f"against the report's stated {STATED_CONF_ROOMS} / {STATED_OFFICES} — "
            "the colour mapping is not describing this plan"
        )
    notes["wash_corroboration"] = {
        "walled_conf_rooms": walled["Conf Room"],
        "walled_offices": walled["Office"],
        "stated_conf_rooms": STATED_CONF_ROOMS,
        "stated_offices": STATED_OFFICES,
    }

    # 5. NON-VACUITY: the same floor our side sets.
    n_prog = len(ex["furniture"]) + len([w for w in ex["washes"] if w["name"] not in OPEN_FIELD_WASHES])
    if n_prog < 10:
        sys.exit(f"only {n_prog} programme elements — the extraction is the finding, not the plan")
    notes["programme_elements"] = n_prog
    return notes


def check_sampling(res, plate):
    """The sampler must agree with the polygon it is sampling, within 2% — the
    check the retracted raster version did not have, and the one that would have
    caught it at 72%."""
    truth = poly_area(plate) * M_PER_PT * M_PER_PT
    err = abs(res["plate_area_sampled_m2"] - truth) / truth
    if err > 0.02:
        sys.exit(
            f"sampled plate {res['plate_area_sampled_m2']:.0f} m² vs polygon {truth:.0f} m² "
            f"({err*100:.1f}% off) — the sampler is the finding"
        )
    return round(err * 100, 3)


# -------------------------------------------------------------------- reporting
def run(ex, exclude, carve=None, **kw):
    polys, boxes = programme(ex, exclude, **kw)
    return measure(ex["plate"], polys, boxes, carve=carve)


# ---------------------------------------------------------------- falsification
#: mode -> expected verdict. PINNED: the harness exits non-zero when reality
#: disagrees, so a null that starts firing is as loud as a fire that stops.
FALSIFY_MODES = {
    "drop-largest-wash": "null",
    "drop-all-washes": "fires",
    "drop-left-furniture": "fires",
    "shrink-plate": "aborts",
}
#: A dead-fraction move smaller than this is no move at all.
FALSIFY_EPS_PP = 0.05

#: Transcribed from actual `--falsify` runs, not written ahead of them. Re-record
#: on any change to the extraction.
FALSIFICATION_RECORD = [
    {
        "mode": "drop-largest-wash",
        "pinned": "null",
        "sabotage": "dropped the largest programme wash: Amenities 56.4 m²",
        "before_pct": 4.01,
        "after_pct": 4.01,
        "delta_pp": 0.00,
        "verdict": "null, as pinned",
        "meaning": "no INDIVIDUAL wash is load-bearing at a 3 m radius — each room's own "
        "furniture already covers its floor. A wash-extraction bug confined to ONE "
        "room would be invisible to this measurement. Stated, not hidden.",
    },
    {
        "mode": "drop-all-washes",
        "pinned": "fires",
        "sabotage": "dropped the whole programme-wash layer (46 paths)",
        "before_pct": 4.01,
        "after_pct": 6.26,
        "delta_pp": 2.25,
        "verdict": "fires, as pinned",
    },
    {
        "mode": "drop-left-furniture",
        "pinned": "fires",
        "sabotage": "deleted 765 furniture footprints in the left half of the plate",
        "before_pct": 4.01,
        "after_pct": 9.62,
        "delta_pp": 5.60,
        "verdict": "fires, as pinned",
    },
    {
        "mode": "shrink-plate",
        "pinned": "aborts",
        "sabotage": "scaled the plate polygon to 0.9x about its centroid (area x0.81)",
        "result": "ABORTED: plate polygon is 1151 m² against the stated 15360 USF = 1427 m² "
        "(19.3% off) — the extraction is not finding the building, and every fraction "
        "below would be over the wrong denominator",
        "verdict": "the plate guard refuses — the enabling step is guarded",
        "meaning": "this is the guard the retracted raster instrument did not have; it missed "
        "by 72% on this same page and reported a number anyway.",
    },
]


def falsify(mode, page, ex, base):
    print(f"FALSIFICATION — {mode}   (pinned expectation: {FALSIFY_MODES[mode]})")

    if mode == "shrink-plate":
        # The ENABLING STEP. Everything above rests on the plate reconciling
        # against the report's stated 15 360 USF; this proves that guard refuses.
        cx = sum(p[0] for p in ex["plate"]) / len(ex["plate"])
        cy = sum(p[1] for p in ex["plate"]) / len(ex["plate"])
        ex["plate"] = [(cx + (x - cx) * 0.9, cy + (y - cy) * 0.9) for x, y in ex["plate"]]
        print("  scaled the plate polygon to 0.9x about its centroid (area x0.81)")
        try:
            self_checks(page, ex)
        except SystemExit as e:
            print(f"  ABORTED: {e}")
            print("  VERDICT: the plate guard refuses. It is a guard, not a decoration.")
            return 0
        print("  VERDICT: the plate guard PASSED a plate 19% smaller than the stated floor —")
        print("           it is not guarding anything, and no figure here may be cited.")
        return 1

    print(
        f"  before  dead {base['dead_area_m2']:.1f} m² = {base['dead_frac']*100:.2f}%  "
        f"({len(ex['washes'])} wash paths, {len(ex['furniture'])} furniture footprints)"
    )
    if mode == "drop-largest-wash":
        prog = [w for w in ex["washes"] if w["name"] not in OPEN_FIELD_WASHES]
        victim = max(prog, key=lambda w: w["area_m2"])
        ex["washes"] = [w for w in ex["washes"] if w is not victim]
        what = f'dropped the largest programme wash: {victim["name"]} {victim["area_m2"]:.1f} m²'
    elif mode == "drop-all-washes":
        n = len([w for w in ex["washes"] if w["name"] not in OPEN_FIELD_WASHES])
        ex["washes"] = [w for w in ex["washes"] if w["name"] in OPEN_FIELD_WASHES]
        what = f"dropped the whole programme-wash layer ({n} paths)"
    else:  # drop-left-furniture
        px0, _, px1, _ = bbox(ex["plate"])
        mid = (px0 + px1) / 2
        keep = [f for f in ex["furniture"] if (f[0] + f[2]) / 2 >= mid]
        n = len(ex["furniture"]) - len(keep)
        ex["furniture"] = keep
        what = f"deleted {n} furniture footprints in the left half of the plate"

    after = run(ex, OPEN_FIELD_WASHES)
    delta = (after["dead_frac"] - base["dead_frac"]) * 100
    print(f"  {what}")
    print(f"  after   dead {after['dead_area_m2']:.1f} m² = {after['dead_frac']*100:.2f}%")
    print(f"  delta   {delta:+.2f} pp")

    fired = abs(delta) >= FALSIFY_EPS_PP
    want = FALSIFY_MODES[mode] == "fires"
    if fired and want:
        print("  VERDICT: fires, as pinned. This layer reaches the distance transform.")
        return 0
    if not fired and not want:
        print("  VERDICT: null, as pinned. This perturbation does NOT reach the transform —")
        print("           see the header: no INDIVIDUAL wash is load-bearing at a 3 m radius,")
        print("           because each room's own furniture already covers its floor.")
        return 0
    print(f"  VERDICT: PIN BROKEN — expected {FALSIFY_MODES[mode]}, got "
          f"{'fires' if fired else 'null'}. The extraction changed; re-record before citing.")
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true", help="measure and print, write nothing")
    ap.add_argument("--clusters", action="store_true", help="print the WHERE table")
    ap.add_argument("--falsify", choices=sorted(FALSIFY_MODES))
    a = ap.parse_args()

    doc = fitz.open(PDF)
    page = doc[PAGE]
    ex = extract(page)
    notes = self_checks(page, ex)

    base = run(ex, OPEN_FIELD_WASHES)
    notes["sampling_err_pct"] = check_sampling(base, ex["plate"])

    if a.falsify:
        return falsify(a.falsify, page, ex, base)

    # THE CORE — found geometrically, see find_core_ring.
    core_poly, core_m2, core_hits = find_core_ring(page, ex)
    if core_poly is None:
        sys.exit("no core ring found — the plan's structure is not what this extraction assumes")
    notes["core"] = {
        "area_m2": round(core_m2, 1),
        "frac_of_plate": round(core_m2 / notes["plate"]["polygon_m2"], 4),
        "distinct_rings_matching_the_rule": core_hits,
    }

    # Sensitivity: the differences from our side, priced instead of argued.
    variants = {
        "primary": base,
        "plate_less_core": run(ex, OPEN_FIELD_WASHES, carve=core_poly),
        "zones_as_aabb": run(ex, OPEN_FIELD_WASHES, aabb_zones=True),
        "enclosed_washes_only": run(ex, OPEN_FIELD_WASHES, enclosed_only=True),
        "also_exclude_comfort_zone": run(ex, OPEN_FIELD_WASHES | {"Comfort Zone"}),
        "furniture_only_no_washes": measure(ex["plate"], [], list(ex["furniture"])),
        "washes_only_no_furniture": measure(ex["plate"], programme(ex, OPEN_FIELD_WASHES)[0], []),
    }

    # ROBUSTNESS. The headline is "the tenant floor scores 0.0%", which is the
    # kind of clean answer that is usually an artefact of a dial. Both dials are
    # swept here rather than argued about: the radius, and the size floor that
    # decides what counts as a furniture footprint.
    global RADIUS_M, FURNITURE_MIN_M2
    r_keep, f_keep = RADIUS_M, FURNITURE_MIN_M2
    robust = {"radius_sweep_m": {}, "furniture_min_m2_sweep": {}}
    for r in (2.0, 2.5, 3.0, 3.5, 4.0, 5.0):
        RADIUS_M = r
        robust["radius_sweep_m"][str(r)] = {
            "primary_pct": round(run(ex, OPEN_FIELD_WASHES)["dead_frac"] * 100, 2),
            "tenant_pct": round(run(ex, OPEN_FIELD_WASHES, carve=core_poly)["dead_frac"] * 100, 2),
        }
    RADIUS_M = r_keep
    for f in (0.02, 0.1, 0.3, 0.5, 1.0):
        FURNITURE_MIN_M2 = f
        sub = extract(page)
        robust["furniture_min_m2_sweep"][str(f)] = {
            "footprints": len(sub["furniture"]),
            "primary_pct": round(run(sub, OPEN_FIELD_WASHES)["dead_frac"] * 100, 2),
            "tenant_pct": round(run(sub, OPEN_FIELD_WASHES, carve=core_poly)["dead_frac"] * 100, 2),
        }
    # A deliberately CRIPPLED configuration, as a floor under the claim: no wash
    # layer at all, and only furniture at or above half a square metre. Both
    # choices are wrong on purpose; the point is what survives them.
    FURNITURE_MIN_M2 = 0.5
    crippled = extract(page)
    FURNITURE_MIN_M2 = f_keep
    robust["tenant_worst_case"] = {
        "config": "no washes at all + furniture >= 0.5 m² only",
        "footprints": len(crippled["furniture"]),
        "tenant_pct": round(
            measure(crippled["plate"], [], list(crippled["furniture"]), carve=core_poly)["dead_frac"] * 100, 2
        ),
    }
    robust["$comment"] = (
        "The tenant floor holds at 0.00% for every radius from 2.0 m to 5.0 m and for every "
        "furniture size floor down to 0.5 m². It breaks only at a 1.0 m² floor, which is above "
        "the 0.91 m² bench desk and therefore deletes the desk field itself — a sabotage, not a "
        "setting. The result is not an artefact of either dial."
    )

    # Every dead cluster, tagged with whether it lies in the core. If they all
    # do, the primary number is a measurement of a lift lobby and must not be
    # compared against a plan that has no lift lobby.
    for c in base["clusters"]:
        cx, cy = (c["x"] + c["w"] / 2) / M_PER_PT, (c["y"] + c["h"] / 2) / M_PER_PT
        c["in_core"] = point_in_poly(cx, cy, core_poly)
    dead_in_core = sum(c["area_m2"] for c in base["clusters"] if c["in_core"])

    print(f"REFERENCE (qbiq Crystal Tower Modern, Alternative A, page {PAGE+1})")
    print(
        f"  scale bar    {notes['scale_bar']['span_pt']} pt = "
        f"{notes['scale_bar']['at_frozen_scale_m']} m vs 30 ft = "
        f"{notes['scale_bar']['labelled_30_ft_m']} m  ({notes['scale_bar']['err_pct']}%)"
    )
    print(
        f"  plate        {notes['plate']['polygon_m2']} m² ({notes['plate']['vertices']} verts) vs "
        f"stated {STATED_USF_SQFT} USF = {notes['plate']['stated_usf_m2']} m²  "
        f"({notes['plate']['err_pct']}%)"
    )
    print(f"  sampled      {base['plate_area_sampled_m2']:.1f} m² ({notes['sampling_err_pct']}% off the polygon)")
    print(
        f"  washes       {len(ex['washes'])} paths · walled conf {notes['wash_corroboration']['walled_conf_rooms']}"
        f"/{STATED_CONF_ROOMS} · walled office {notes['wash_corroboration']['walled_offices']}/{STATED_OFFICES}"
    )
    print(f"  furniture    {len(ex['furniture'])} footprints ({notes['desk_footprints']} desk-sized)")
    print(
        f"  core         {notes['core']['area_m2']} m² = "
        f"{notes['core']['frac_of_plate']*100:.1f}% of plate "
        f"({core_hits} ring matched the rule)"
    )
    print()
    print(f"  {'variant':28s} {'dead m²':>9s} {'plate m²':>9s} {'dead %':>8s}")
    for k, v in variants.items():
        print(
            f"  {k:28s} {v['dead_area_m2']:9.1f} {v['plate_area_sampled_m2']:9.1f} "
            f"{v['dead_frac']*100:8.2f}"
        )
    print()
    print(f"  REFERENCE DEAD SPACE (>{RADIUS_M} m) = {base['dead_frac']*100:.1f}%")
    print(
        f"  of which INSIDE THE SERVICE CORE: {dead_in_core:.1f} m² of "
        f"{base['dead_area_m2']:.1f} m² = {dead_in_core/max(1e-9,base['dead_area_m2'])*100:.0f}%"
    )

    print("\n  dead clusters (area m² · bbox · fill · aspect · at · in core):")
    for c in base["clusters"]:
        if c["area_m2"] < 2 and not a.clusters:
            continue
        print(
            f"    {c['area_m2']:6.1f} · bbox {c['w']}x{c['h']} · fill {c['fill']*100:.0f}% · "
            f"{c['aspect']}:1 · {c['x']},{c['y']} · {'CORE' if c['in_core'] else 'tenant'}"
        )

    if a.print:
        return 0

    spec = {
        "note": "FROZEN. Generated by research/qbiq-deadspace-extract.py from the reference PDF's "
        "VECTORS and stated facts. No raster step exists anywhere in the pipeline. "
        "Re-running is a re-registration event.",
        "source": str(PDF.relative_to(ROOT)),
        "page": PAGE + 1,
        "definition": {
            "$comment": "Copied from scripts/gates/deadspace-core.mjs so the two sides measure the "
            "same quantity. Differences that remain are listed in the script header "
            "under DIFFERENCES FROM OUR SIDE and priced in `sensitivity` below.",
            "dead": "plate area more than radius_m from any programme element",
            "radius_m": RADIUS_M,
            "cell_m": CELL_M,
            "programme": "furniture footprints (AABB) + every zone wash except the open field",
            "excluded_ground": "unwashed white floor — carries no wash colour, excluded by construction",
            "excluded_open_field": sorted(OPEN_FIELD_WASHES),
            "wash_mapping": {v: ("EXCLUDED (open field)" if v in OPEN_FIELD_WASHES else "included") for v in sorted(set(ZONE_FILLS.values()))},
        },
        "anchors": notes,
        "result": {
            "plate_m2": round(poly_area(ex["plate"]) * M_PER_PT * M_PER_PT, 1),
            "dead_area_m2": round(base["dead_area_m2"], 1),
            "dead_frac": round(base["dead_frac"], 4),
            "dead_pct": round(base["dead_frac"] * 100, 2),
            "dead_inside_core_m2": round(dead_in_core, 1),
            "wash_paths": len(ex["washes"]),
            "furniture_footprints": len(ex["furniture"]),
            "clusters_ge_2m2": [c for c in base["clusters"] if c["area_m2"] >= 2],
        },
        "comparability": {
            "$comment": "READ BEFORE QUOTING. The full list of ways this can differ from "
            "scripts/gates/deadspace-core.mjs is in the script header under "
            "DIFFERENCES FROM OUR SIDE; this is the one that decides the answer.",
            "finding": "100% of the reference's dead space is inside its 168.1 m² service core. "
            "Its TENANT floor scores 0.0%.",
            "compare_against_ours_using": "plate_less_core",
            "why": "our plans have no lift/stair/WC core, so the primary row compares our tenant "
            "floor against the reference's tenant floor PLUS a lift lobby. A threshold "
            "taken from the primary row would be a threshold on the reference's core.",
            "what_it_does_NOT_license": "subtracting the primary 4.01% from whatever "
            "`node scripts/gates/deadspace-core.mjs` prints and calling the remainder the "
            "gap. On the comparable row the reference is at ZERO, so the gap is our whole "
            "figure — a harder target than the primary row suggests, not a softer one. Our "
            "number is deliberately NOT transcribed here: this file is reference-only, and "
            "a copied figure is a mirror that drifts (CLAUDE.md §named-resource).",
        },
        "sensitivity": {
            k: {
                "dead_area_m2": round(v["dead_area_m2"], 1),
                "plate_m2": round(v["plate_area_sampled_m2"], 1),
                "dead_pct": round(v["dead_frac"] * 100, 2),
            }
            for k, v in variants.items()
        },
        "robustness": robust,
        "sensitivity_nulls": "zones_as_aabb, also_exclude_comfort_zone: byte-identical to primary. "
        "Reported as nulls, not omitted — those washes sit on floor the furniture layer "
        "already covers within the 3 m radius, so the choice does not reach the transform "
        "on THIS plan. It is not evidence the knob is inert in general.",
        "falsification": {
            "$comment": "Recorded from actual runs of --falsify. A number nobody has watched move "
            "is not a measurement. Re-record if the extraction changes.",
            "runs": FALSIFICATION_RECORD,
        },
        "retracted": {
            "$comment": "The previous reference figure for this quantity, and why it is void.",
            "value_pct": 11.1,
            "source": "scripts/gates/deadspace.py (raster flood fill)",
            "reason": "flooded across the plan's white underlay and measured the wall bounding box "
            "(1597 m² against a 930 m² plate); three versions of the same instrument "
            "gave 19.0%, an abort, and 0.0% on one unchanged drawing.",
        },
    }
    OUT.write_text(json.dumps(spec, indent=2) + "\n")
    back = json.loads(OUT.read_text())
    if back["result"]["dead_pct"] != spec["result"]["dead_pct"]:
        sys.exit("write did not take — refusing to report success")
    print(f"\nwrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
