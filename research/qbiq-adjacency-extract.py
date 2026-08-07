#!/usr/bin/env python3
"""Extract the reference's ROOM ADJACENCY PATTERNS — who sits next to what, and where.

    python3 research/qbiq-adjacency-extract.py             # measure + write the JSON
    python3 research/qbiq-adjacency-extract.py --print      # measure, print, write nothing
    python3 research/qbiq-adjacency-extract.py --falsify    # sabotage the input, prove it moves

Output: `research/qbiq-adjacency-spec.json`, frozen like `qbiq-composition-spec.json`.
Re-running it after a reference change is a re-registration event.

WHY THIS EXISTS
---------------
`docs/audits/LOOP-LEDGER.md` (S3-1) traced twelve dropped rooms back to `allocate_rooms`
setting `cap_d[i] = 0` for every field region, and proposed the fix as: *"the reference
lines the main field's window wall with alternating offices and conference rooms."*
That sentence is a prose label, and by this project's own rule a prose label is a scalar
(`.claude/rules/gate-independence.md`, "A scalar is not geometry"). It was never measured.
This script measures it. **It does not survive.** See FINDINGS below.

WHAT THE MEASUREMENT IS MADE OF — VECTORS ONLY
----------------------------------------------
Everything below comes from the PDF's own path operators via `page.get_drawings()`.
No rasterisation, no flood fill, no colour clustering, no pixel sampling. The one
retracted approach on this project was a raster flood; nothing here touches a bitmap.

Four vector populations, each identified by a property the file states rather than one
we infer:

1. **Rooms** — filled paths whose fill hex is one of the nine zone washes already
   measured and frozen in `research/qbiq-plan-style-spec.json` at `/palette/zone_fills`.
   That mapping is REUSED, never re-derived. One wash path == one room (proved below).
2. **The plate boundary** — the unique 6-segment closed path at the wall stroke width
   (0.2903 pt, the "walls (bulk linework)" tier of the style spec). It is a hexagon:
   two orthogonal long walls, two short returns and two diagonals. The file draws it
   three times (inner face, outer face, and a rotation of the inner); we take the
   smallest-area 6-gon, i.e. the inner face, because rooms are drawn to the inner face.
3. **The service core** — the single large unfilled rectangle inside the plate
   (x 418.41-635.58 pt, 88 pt tall, 217x88 pt = 20.4 x 8.3 m = 168 m^2). Identical on
   all three plan pages up to the pages' ~1.4 pt vertical offset, which is itself
   evidence it is fixed building fabric rather than a layout decision.
4. **In-plan labels** — the 4.35 pt uppercase abbreviations (STOR. COAT. CLEA. IT WELL.),
   assigned to the room polygon that contains them, to subtype the support rooms.

THE ANCHOR THAT MAKES THE ROOM EXTRACTION TRUSTWORTHY
------------------------------------------------------
"One wash path == one room" is not assumed. It is checked against a STATED fact, the
strongest anchor available and one this script cannot influence: the report's own summary
table on page 6 gives offices/conference rooms per alternative as A=7/12, B=5/11, C=7/12.
Counting wash paths by colour on pages 3/4/5 gives **exactly 7/12, 5/11, 7/12**. Three
pages, six numbers, no fudge factor. If a wash were a decorative sub-region rather than a
room, or if a room were painted in two pieces, those numbers could not land. The run
ABORTS if they do not.

(This also fixes which page is which alternative: page 3 = A, page 4 = B, page 5 = C, in
the 1-indexed numbering the style spec uses. 0-indexed here: 2, 3, 4.)

Two further independent checks run before any number is emitted:
  * the bench-desk size anchor from `qbiq-composition-spec.json` (675 x 1350 mm) must
    still dominate the rect histogram, which validates MM_PER_PT;
  * the plate hexagon's own area, 15 062 sqft, must land within 10% of the report's
    stated 15 360 USF. It lands at 1.9%. This is a *corroboration of the scale from a
    completely different quantity* (a boundary polygon vs a furniture rect). It is
    deliberately NOT treated as an area identity: USF and gross plate area are different
    definitions, and the core alone is 1 809 sqft. A 2% agreement between two definitions
    that should differ by 12% is a coincidence worth stating and not worth building on.

HOW ADJACENCY IS DECIDED
------------------------
Two rooms are edge-adjacent when their boundaries share a run of collinear, overlapping
edge. Generic segment arithmetic, not an axis-aligned rect test, because the plate has two
diagonal walls and ten of the rooms are 5- or 6-gons that follow them.

    parallel:   |a x b| / (|a||b|) <= 2e-3
    coincident: perpendicular offset <= CONTACT_TOL (2.0 pt = 19 cm)
    real:       projected overlap  >= MIN_CONTACT (5.4 pt = 50 cm)

CONTACT_TOL is not tuned. Wash polygons of neighbouring rooms in this file either share a
coordinate exactly or differ by ~0.1 pt; the wall tier is 0.2903 pt wide. So the true gap
population is 0-0.3 pt and the next feature is metres away — anything from 0.5 to 5 pt
lands in the same place. The script PROVES this rather than asserting it: it re-runs the
whole adjacency pass at TOL/2 and 2xTOL and aborts if the pair count moves by more than
5%. MIN_CONTACT = 0.5 m says a shared run narrower than a door is a corner touch, not an
adjacency.

The same primitive answers three different questions, which is why it is worth being
generic: room-vs-room gives the pairing matrix, room-vs-plate gives the window-wall band,
room-vs-core gives the core face. Whatever perimeter is left over is FREE edge — it faces
floor that carries no wash, which on this drawing means circulation (or the core's own
lift lobby, which is why the core is subtracted first and reported separately).

FINDINGS THAT CONTRADICT THE BRIEF — READ THESE BEFORE USING THE NUMBERS
------------------------------------------------------------------------
The standing brief and the S3-1 ledger entry between them make three claims about the
reference's perimeter. The instrument agrees with none of them.

* **"alternating offices and conference rooms" on the window wall — FALSE.**
  Enclosed rooms (Office + Conf Room) take **31%** of the perimeter the rooms claim on
  page 3, 26% on page 4, 28% on page 5. The single largest consumer of window wall is
  **Open Space**, at 55% / 61% / 57%. The reference does not line its facade with cabins;
  it gives the facade to the open field and *punctuates* it with enclosed rooms.
* **"alternating" as a rhythm — FALSE, and specifically so.** Office->Office is the most
  common enclosed-to-enclosed transition on all three plans (3 / 2 / 2 occurrences) and
  there is no O-C-O-C run anywhere. Offices arrive in PAIRS — six of page 3's seven
  perimeter offices sit in three back-to-back pairs — and conference rooms arrive as
  singles. Office<->Conf alternations on the whole boundary: **2 / 1 / 1**.

Three things ARE true, and they are the transferable rules:

* **SUBSCRIPTION.** Rooms of some kind claim **83.5% / 85.8% / 85.8%** of the plate's
  151.9 m boundary. Our generator's failure is not that it puts the wrong rooms on the
  facade; it is that it puts *nothing* there and then has nowhere to put twelve rooms.
* **OFFICES TAKE THE FACADE, CONFERENCE ROOMS DO NOT.** Metres-of-boundary hides this
  because there are 12 conf rooms to 7 offices. The incidence does not: **100% / 100% /
  57% of offices touch the exterior, against 25% / 18% / 33% of conference rooms.** Per
  metre of the rooms' own perimeter, an office spends 0.27 / 0.29 / 0.19 of itself on the
  facade and a conference room 0.09 / 0.10 / 0.12. That is the actual perimeter rule the
  ledger was reaching for, and it is a *different* rule from the one it wrote down.
* **A 4 m BAND, on every page.** The median perimeter-room depth is **4.04 / 4.04 / 4.03 m**
  — three plans, three digits, one number. It is 24-43% of the local cross-section, and
  the ray from the facade is stopped by the core rather than the far wall in 13/24, 9/16
  and 11/22 cases.

AND ONE FINDING THAT CONTRADICTS THE QUESTION AS ASKED (Q4)
-----------------------------------------------------------
Q4 asked whether "service rooms (IT, STOR., CLEA., COAT., WELL.) are clustered together
or distributed", against programme rooms as the control. The premise is that "service"
is one behaviour. **It is two, and they are opposite.**

At GROUP level the statistic is flat and says nothing: same-class adjacency fraction is
0.52 / 0.44 / 0.43 for support against 0.40 / 0.45 / 0.49 for enclosed programme. No
separation. But that flatness is an artifact of the grouping — it averages two opposite
behaviours that are unambiguous at kind level:

  * **Amenities (the WC / STOR. / COAT. / CLEA. / WELL. block) CLUSTER.** Same-class
    adjacency 0.39 / 0.53 / 0.32, mean nearest same-kind 3.9 / 3.9 / 4.3 m, and the
    highest room-to-room perimeter fraction of ANY kind on all three pages
    (0.54 / 0.55 / 0.62) against a facade incidence of 0.07 / 0.00 / 0.00. They are the
    one type that is walled in by its own siblings and never reaches the window.
    (They do NOT hug the core: only 0.05 / 0.01 / 0.00 of their perimeter is on the core
    face. The two kinds that touch the core are IT Room, 0.25 / 0.28 / 0.29, and Pantry,
    0.23 / 0.14 / 0.21 — the wet and the serviced.)
  * **Pantry and Comfort Zone are DELIBERATELY DISTRIBUTED — never once adjacent to their
    own kind on any of the three plans** (same-class adjacency 0.000 for Pantry on 3/3
    pages, and for Comfort Zone on 2/3 with 0.091 on the third). Mean nearest same-kind
    for Pantry: 18.8 / 10.8 / 13.6 m, a clustering ratio of 4.5 / 2.5 / 3.2.

So the answer to Q4 is not "clustered" or "distributed". It is: **hard service clusters on
the core, soft service scatters through the field**, and any allocator that treats
`SpaceKind::Pantry` and `SpaceKind::Amenities` with one placement rule gets one of them
wrong. This is reported at kind level in the JSON for exactly that reason; the group
rollup is kept only to show that it is uninformative.

THE SABOTAGE ROUND — run, and the nulls are reported too
---------------------------------------------------------
`--falsify` proves the OUTPUT moves with the input. That is half of it. The other half is
that each self-check actually fires, which is a separate question and one this project has
been bitten by (a guard that was never attached, `gate-independence.md`). Each anchor was
disabled in turn in a disposable `git worktree`, never in the real tree, and the control
copy passed first:

    S1  MM_PER_PT x 1.25              -> RED  "dominant rect is (633, 1114) mm, expected (675, 1350)"
    S2  legend swatches admitted      -> RED  "8 offices / 13 conf rooms; the report states 7/12"
    S3  plate detector wants a 5-gon  -> RED  "plate boundary is None-gon, expected 6"
    S4  tolerance sweep widened 40x   -> RED  "tolerance-dependent {1.0: 56, 2.0: 56, 80.0: 190}"
    S5  core rect detection disabled  -> RED  "service core rect not found"
    S6  one real Office wash dropped  -> RED  "5 offices / 12 conf rooms; the report states 7/12"

    N1  plate-area corroboration deleted entirely -> STILL GREEN.

N1 is the null result and it is the honest one: the 15 062-vs-15 360 sqft agreement guards
nothing that S1 does not already guard harder, because any scale error large enough to move
the area 10% moves the desk histogram first. It is kept as a *corroboration from a second
quantity*, and it is labelled as such rather than counted as a check.

The tolerance sweep in S4 is worth reading as a positive result too: the pair count is
**56 at 1.0 pt, 56 at 2.0 pt and 56 at 4.0 pt**. Identical, not merely within 5%. The
adjacency verdict is not a function of the tolerance in any regime the drawing supports.

WHAT THIS SCRIPT CANNOT MEASURE — stated, not guessed
------------------------------------------------------
* **Glazing.** "Window wall" is not separable from "exterior wall" in this file. Every
  one of the six plate edges is drawn identically: a 0.2903 pt double line, no mullion
  ticks, no glazing hatch. The 0.1524 pt "fine detail" tier the style spec left
  PROVISIONAL was tested as a glazing candidate and it is not one -- **0 of its 1265
  segments lie within 4 pt of any plate edge**. So Q1 is answered as EXTERIOR-BOUNDARY
  contact and the word "window" is the brief's, not the drawing's.
* **Circulation as an object.** No wash marks corridors, so circulation is only ever the
  complement: free edge = perimeter - exterior - core - room contacts. A room's free edge
  faces unwashed floor. On this drawing that is corridor, but the drawing does not say so,
  and a lift lobby inside the core footprint would read the same way. Hence the core is
  subtracted and reported as its own column.
* **Doors.** Openings are punched by overdrawing in white (1.2339 pt, style spec), so a
  door is an absence of wall, not a placed symbol. Which face a room is ENTERED from is
  therefore recoverable in principle and is not attempted here; "fronts onto circulation"
  below means *has free edge*, which is necessary for a door but not proof of one.
* **Wings.** Q5 asked for depth as a fraction of "the wing's cross-section". This plate
  has no wings -- it is one convex-ish hexagon around a central core. Depth is therefore
  reported against the LOCAL cross-section: a ray cast inward from the room's facade
  contact until it hits the core or the far wall. That is a different denominator from the
  one the brief imagined and the difference is stated in the JSON.
"""
import collections
import json
import math
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "docs/reference/qbiq/extracted/Sample Report/Crystal Tower  Modern-2024-08-11-07-17-04.pdf"
STYLE = ROOT / "research/qbiq-plan-style-spec.json"
OUT = ROOT / "research/qbiq-adjacency-spec.json"

#: 1 pt in mm at the reference plan's measured scale. FROZEN — see qbiq-composition-spec.json.
MM_PER_PT = 10 / 32.5 * 304.8
M_PER_PT = MM_PER_PT / 1000
#: The bench desk position, in mm. FROZEN — the scale anchor, re-verified here.
DESK_POSITION_MM = (675, 1350)
#: The stats card occupies the left 30% of the page; the plan is the rest.
PLAN_X_FRACTION = 0.30
#: Perpendicular offset under which two edges are the same line, in pt. See the docstring.
CONTACT_TOL = 2.0
#: Shared run under which a touch is a corner, not an adjacency, in pt (~0.5 m).
MIN_CONTACT = 0.5 / M_PER_PT
#: Parallelism tolerance (sin of the angle between two edges).
PARALLEL_TOL = 2e-3

#: 0-indexed plan pages -> the alternative each one draws, and the report's STATED counts
#: for that alternative (page 6 summary table, transcribed in qbiq-composition-spec.json).
#: These are the abort anchor: extraction must reproduce them exactly.
PAGES = {2: ("A", 7, 12), 3: ("B", 5, 11), 4: ("C", 7, 12)}
#: The report's stated usable area, for the plate-area corroboration.
STATED_USF_SQFT = 15360

#: Coarse groups for the clustering statistic. SUPPORT is the brief's "service rooms".
GROUPS = {
    "Amenities": "support", "IT Room": "support", "Pantry": "support",
    "Office": "enclosed_programme", "Conf Room": "enclosed_programme",
    "Executive": "enclosed_programme", "Reception": "enclosed_programme",
    "Open Space": "open", "Comfort Zone": "open",
}


# ---------------------------------------------------------------- geometry primitives

def poly_of(drawing):
    """The closed polygon a wash / boundary path traces, as a vertex list."""
    pts = []
    for it in drawing["items"]:
        if it[0] == "re":
            r = it[1]
            pts += [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
        elif it[0] == "l":
            if not pts:
                pts.append((it[1].x, it[1].y))
            pts.append((it[2].x, it[2].y))
        elif it[0] == "c":
            pts.append((it[1].x, it[1].y))
            pts.append((it[4].x, it[4].y))
        elif it[0] == "qu":
            q = it[1]
            pts += [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)]
    out = []
    for p in pts:
        if not out or math.dist(p, out[-1]) > 1e-6:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) <= 1e-6:
        out.pop()
    return out


def edges(poly):
    return [(poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly))]


def seg_contact(a, b, tol=CONTACT_TOL):
    """Length of the collinear overlap between segments `a` and `b`, in pt."""
    (ax0, ay0), (ax1, ay1) = a
    (bx0, by0), (bx1, by1) = b
    ux, uy = ax1 - ax0, ay1 - ay0
    vx, vy = bx1 - bx0, by1 - by0
    la, lb = math.hypot(ux, uy), math.hypot(vx, vy)
    if la < 1e-6 or lb < 1e-6:
        return 0.0
    if abs(ux * vy - uy * vx) / (la * lb) > PARALLEL_TOL:
        return 0.0
    ex, ey = ux / la, uy / la
    off0 = abs((bx0 - ax0) * -ey + (by0 - ay0) * ex)
    off1 = abs((bx1 - ax0) * -ey + (by1 - ay0) * ex)
    if max(off0, off1) > tol:
        return 0.0
    s0 = (bx0 - ax0) * ex + (by0 - ay0) * ey
    s1 = (bx1 - ax0) * ex + (by1 - ay0) * ey
    return max(0.0, min(la, max(s0, s1)) - max(0.0, min(s0, s1)))


def contact(pa, pb, tol=CONTACT_TOL):
    return sum(seg_contact(ea, eb, tol) for ea in edges(pa) for eb in edges(pb))


def area(poly):
    a = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def centroid(poly):
    a = cx = cy = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        cr = x1 * y2 - x2 * y1
        a += cr
        cx += (x1 + x2) * cr
        cy += (y1 + y2) * cr
    if abs(a) < 1e-9:
        return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))
    return (cx / (3 * a), cy / (3 * a))


def perimeter(poly):
    return sum(math.dist(a, b) for a, b in edges(poly))


def ray_hit(origin, direction, poly, skip_edge=None, eps=1e-3):
    """Nearest positive-t intersection of a ray with a polygon's edges, or None."""
    ox, oy = origin
    dx, dy = direction
    best = None
    for k, (a, b) in enumerate(edges(poly)):
        if skip_edge is not None and k == skip_edge:
            continue
        ex, ey = b[0] - a[0], b[1] - a[1]
        den = dx * ey - dy * ex
        if abs(den) < 1e-12:
            continue
        t = ((a[0] - ox) * ey - (a[1] - oy) * ex) / den
        u = ((a[0] - ox) * dy - (a[1] - oy) * dx) / den
        if t > eps and -1e-6 <= u <= 1 + 1e-6 and (best is None or t < best):
            best = t
    return best


# ---------------------------------------------------------------- vector extraction

def zone_fills():
    """The nine zone washes, REUSED from the frozen style spec. Never re-derived."""
    spec = json.loads(STYLE.read_text())
    fills = spec["palette"]["zone_fills"]
    if len(fills) < 9:
        sys.exit(f"style spec lists {len(fills)} zone fills, expected 9 — the frozen input moved")
    return {z["hex"].lower(): z["name"] for z in fills}


def hexof(rgb):
    return "#%02x%02x%02x" % tuple(round(c * 255) for c in rgb)


def extract_page(page, zf):
    """Plate hexagon, core rect, room polygons and in-plan labels — from paths only."""
    cut = page.rect.width * PLAN_X_FRACTION
    plate = core = None
    rooms = []
    for d in page.get_drawings():
        r = d["rect"]
        w = round(d.get("width") or 0, 4)
        # (2) plate boundary: the smallest-area 6-gon at the wall stroke width
        if len(d["items"]) == 6 and r.width > 500 and r.height > 250 and w == 0.2903:
            p = poly_of(d)
            if len(p) == 6 and (plate is None or area(p) < area(plate)):
                plate = p
        # (3) core: the largest unfilled single rect inside the plan region
        if (not d.get("fill")) and len(d["items"]) == 1 and d["items"][0][0] == "re" \
                and r.x1 > cut and r.width > 150 and r.height > 50:
            if core is None or r.width * r.height > area(core):
                core = poly_of(d)
        # (1) rooms: zone-wash fills, excluding the full-page legend swatch clips
        f = d.get("fill")
        if f and hexof(f) in zf and r.x1 >= cut and not (r.width > 800 and r.height > 500):
            p = poly_of(d)
            if len(p) >= 3:
                rooms.append({"kind": zf[hexof(f)], "poly": p, "labels": []})
    # (4) labels -> containing room
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            for s in ln["spans"]:
                if s["bbox"][2] < cut or s["size"] > 6:
                    continue
                mx = (s["bbox"][0] + s["bbox"][2]) / 2
                my = (s["bbox"][1] + s["bbox"][3]) / 2
                for rm in rooms:
                    xs = [p[0] for p in rm["poly"]]
                    ys = [p[1] for p in rm["poly"]]
                    if min(xs) <= mx <= max(xs) and min(ys) <= my <= max(ys):
                        rm["labels"].append(s["text"].strip())
                        break
    for rm in rooms:
        rm["area_pt2"] = area(rm["poly"])
        rm["perim_pt"] = perimeter(rm["poly"])
        rm["c"] = centroid(rm["poly"])
    return plate, core, rooms


# ---------------------------------------------------------------- self-checks

def check_scale_anchor(page):
    """The bench desk must still dominate the rect histogram at MM_PER_PT."""
    cut = page.rect.width * PLAN_X_FRACTION
    lo_pt, hi_pt = (v / MM_PER_PT for v in DESK_POSITION_MM)
    sizes = collections.Counter()
    for d in page.get_drawings():
        r = d["rect"]
        if r.x1 < cut:
            continue
        w, h = r.width, r.height
        if abs(min(w, h) - lo_pt) <= 0.20 * lo_pt and abs(max(w, h) - hi_pt) <= 0.20 * hi_pt:
            sizes[(round(w, 1), round(h, 1))] += 1
    if not sizes:
        sys.exit("SELF-CHECK FAILED: no bench-desk rects matched — scale anchor or page index wrong")
    top = max(sizes.items(), key=lambda kv: kv[1])[0]
    got = tuple(sorted(round(v * MM_PER_PT) for v in top))
    want = tuple(sorted(DESK_POSITION_MM))
    if any(abs(a - b) > 0.1 * b for a, b in zip(got, want)):
        sys.exit(f"SELF-CHECK FAILED: dominant rect is {got} mm, expected {want} mm — scale anchor")
    return {"dominant_rect_mm": list(got), "instances": sizes[top]}


def check_page(pi, plate, core, rooms):
    alt, want_off, want_conf = PAGES[pi]
    if plate is None or len(plate) != 6:
        sys.exit(f"SELF-CHECK FAILED: page {pi} plate boundary is {plate and len(plate)}-gon, expected 6")
    if core is None:
        sys.exit(f"SELF-CHECK FAILED: page {pi} service core rect not found")
    if len(rooms) < 40:
        sys.exit(f"SELF-CHECK FAILED: page {pi} found {len(rooms)} wash rooms, expected >= 40")
    n = collections.Counter(r["kind"] for r in rooms)
    if n["Office"] != want_off or n["Conf Room"] != want_conf:
        sys.exit(
            f"SELF-CHECK FAILED: page {pi} (alternative {alt}) has {n['Office']} offices / "
            f"{n['Conf Room']} conf rooms; the report's own summary states {want_off}/{want_conf}. "
            "One wash path != one room — the whole extraction is void."
        )
    sqft = area(plate) * M_PER_PT ** 2 / 0.092903
    if abs(sqft - STATED_USF_SQFT) > 0.10 * STATED_USF_SQFT:
        sys.exit(f"SELF-CHECK FAILED: page {pi} plate is {sqft:.0f} sqft vs stated {STATED_USF_SQFT} USF (>10%)")
    return {"alternative": alt, "plate_sqft_gross": round(sqft), "core_m2": round(area(core) * M_PER_PT ** 2, 1)}


def check_tolerance_stability(rooms):
    """The adjacency verdict must not be a function of CONTACT_TOL. Proved, not assumed."""
    counts = {}
    for tol in (CONTACT_TOL / 2, CONTACT_TOL, CONTACT_TOL * 2):
        n = 0
        for i in range(len(rooms)):
            for j in range(i + 1, len(rooms)):
                if contact(rooms[i]["poly"], rooms[j]["poly"], tol) >= MIN_CONTACT:
                    n += 1
        counts[round(tol, 2)] = n
    lo, hi = min(counts.values()), max(counts.values())
    if hi and (hi - lo) / hi > 0.05:
        sys.exit(f"SELF-CHECK FAILED: adjacency count is tolerance-dependent {counts} (>5% spread)")
    return counts


# ---------------------------------------------------------------- the measurements

def measure(pi, plate, core, rooms):
    """Q1-Q5 for one page. Pure function of the polygons handed in (so --falsify works)."""
    E = edges(plate)
    cum = [0.0]
    for a, b in E:
        cum.append(cum[-1] + math.dist(a, b))
    plate_perim = cum[-1]
    pc = centroid(plate)

    # --- room-vs-room, room-vs-plate, room-vs-core
    pairs = []
    for i in range(len(rooms)):
        for j in range(i + 1, len(rooms)):
            c = contact(rooms[i]["poly"], rooms[j]["poly"])
            if c >= MIN_CONTACT:
                pairs.append((i, j, c))
    shared = [0.0] * len(rooms)
    for i, j, c in pairs:
        shared[i] += c
        shared[j] += c
    for k, rm in enumerate(rooms):
        rm["ext_pt"] = contact(rm["poly"], plate)
        rm["core_pt"] = contact(rm["poly"], core)
        rm["shared_pt"] = shared[k]
        rm["free_pt"] = max(0.0, rm["perim_pt"] - rm["ext_pt"] - rm["core_pt"] - shared[k])

    # --- Q1: the walk along the exterior boundary
    seq = []
    for rm in rooms:
        best = None
        for k, (a, b) in enumerate(E):
            L = math.dist(a, b)
            ex, ey = (b[0] - a[0]) / L, (b[1] - a[1]) / L
            tot, ss = 0.0, []
            for ea in edges(rm["poly"]):
                c = seg_contact((a, b), ea)
                if c > 0:
                    tot += c
                    ss += [(p[0] - a[0]) * ex + (p[1] - a[1]) * ey for p in ea]
            if tot >= MIN_CONTACT and (best is None or tot > best[1]):
                s = sorted(max(0.0, min(L, v)) for v in ss)
                best = (cum[k] + (s[0] + s[-1]) / 2, tot, k, ex, ey)
        if best:
            # Q5 depth: how far inward does this room reach, and how far COULD it?
            mid_s = best[0] - cum[best[2]]
            a = E[best[2]][0]
            ox, oy = a[0] + best[3] * mid_s, a[1] + best[4] * mid_s
            nx, ny = -best[4], best[3]
            if (pc[0] - ox) * nx + (pc[1] - oy) * ny < 0:
                nx, ny = -nx, -ny
            far = ray_hit((ox, oy), (nx, ny), plate, skip_edge=best[2])
            hit_core = ray_hit((ox, oy), (nx, ny), core)
            cross = min(v for v in (far, hit_core) if v is not None) if (far or hit_core) else None
            depth = max((p[0] - ox) * nx + (p[1] - oy) * ny for p in rm["poly"])
            seq.append({
                "s_m": round(best[0] * M_PER_PT, 2), "edge": best[2], "kind": rm["kind"],
                "contact_m": round(best[1] * M_PER_PT, 2),
                "area_m2": round(rm["area_pt2"] * M_PER_PT ** 2, 1),
                "depth_m": round(depth * M_PER_PT, 2),
                "cross_section_m": round(cross * M_PER_PT, 2) if cross else None,
                "depth_fraction": round(depth / cross, 3) if cross else None,
                "blocked_by": ("core" if hit_core is not None and (far is None or hit_core < far)
                               else "far_wall") if cross else None,
            })
    seq.sort(key=lambda r: r["s_m"])

    claimed = sum(r["contact_m"] for r in seq)
    by_kind = collections.Counter()
    for r in seq:
        by_kind[r["kind"]] += r["contact_m"]
    # FACADE INCIDENCE: of all rooms of a kind, how many touch the exterior at all?
    # Metres-of-boundary alone hides this — 12 conf rooms sharing 16 m read like a band.
    total_by_kind = collections.Counter(r["kind"] for r in rooms)
    on_by_kind = collections.Counter(r["kind"] for r in seq)
    incidence = {k: {"on_boundary": on_by_kind[k], "total": total_by_kind[k],
                     "incidence": round(on_by_kind[k] / total_by_kind[k], 3)}
                 for k in sorted(total_by_kind, key=lambda k: -on_by_kind[k] / total_by_kind[k])}
    runs = []
    for r in seq:
        if runs and runs[-1][0] == r["kind"]:
            runs[-1][1] += 1
        else:
            runs.append([r["kind"], 1])
    trans = collections.Counter()
    for x, y in zip(seq, seq[1:]):
        trans["%s -> %s" % (x["kind"], y["kind"])] += 1

    q1 = {
        "plate_perimeter_m": round(plate_perim * M_PER_PT, 1),
        "plate_vertices": len(plate),
        "rooms_on_boundary": len(seq),
        "boundary_claimed_m": round(claimed, 1),
        "boundary_subscription": round(claimed / (plate_perim * M_PER_PT), 3),
        "boundary_m_by_kind": {k: round(v, 1) for k, v in by_kind.most_common()},
        "boundary_share_by_kind": {k: round(v / claimed, 3) for k, v in by_kind.most_common()},
        "facade_incidence_by_kind": incidence,
        "enclosed_programme_share": round(
            sum(v for k, v in by_kind.items() if GROUPS[k] == "enclosed_programme") / claimed, 3),
        "sequence": [r["kind"] for r in seq],
        "run_lengths": [[k, n] for k, n in runs],
        "max_run": max(n for _, n in runs) if runs else 0,
        "transitions": dict(trans.most_common()),
        "office_office_adjacent_on_boundary": trans.get("Office -> Office", 0),
        "office_conf_alternations": trans.get("Office -> Conf Room", 0) + trans.get("Conf Room -> Office", 0),
        "detail": seq,
    }

    # --- Q2: which face does each kind present?
    q2 = {}
    agg = collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0.0, 0])
    for rm in rooms:
        a = agg[rm["kind"]]
        a[0] += rm["ext_pt"]; a[1] += rm["core_pt"]; a[2] += rm["shared_pt"]; a[3] += rm["free_pt"]
        a[4] += 1
    for k, (e, c, s, f, n) in sorted(agg.items()):
        tot = e + c + s + f
        q2[k] = {
            "rooms": n, "perimeter_m": round(tot * M_PER_PT, 1),
            "exterior": round(e / tot, 3), "core": round(c / tot, 3),
            "room_to_room": round(s / tot, 3), "free_circulation": round(f / tot, 3),
            "rooms_with_free_edge": sum(1 for r in rooms if r["kind"] == k and r["free_pt"] >= MIN_CONTACT),
        }

    # --- Q3: the pairing matrix
    mat = collections.Counter()
    length = collections.Counter()
    for i, j, c in pairs:
        key = " | ".join(sorted((rooms[i]["kind"], rooms[j]["kind"])))
        mat[key] += 1
        length[key] += c * M_PER_PT
    tot_pairs = sum(mat.values())
    q3 = {
        "pairs": tot_pairs,
        "counts": dict(mat.most_common()),
        "normalised": {k: round(v / tot_pairs, 3) for k, v in mat.most_common()},
        "shared_edge_m": {k: round(v, 1) for k, v in length.most_common()},
    }

    # --- Q4: are support rooms clustered?
    q4 = {"by_kind": {}, "by_group": {}}
    for keyfn, bucket in (("kind", "by_kind"), ("group", "by_group")):
        cls = {k: (rooms[k]["kind"] if keyfn == "kind" else GROUPS[rooms[k]["kind"]])
               for k in range(len(rooms))}
        same = collections.Counter()
        tot = collections.Counter()
        for i, j, _ in pairs:
            for a, b in ((i, j), (j, i)):
                tot[cls[a]] += 1
                if cls[a] == cls[b]:
                    same[cls[a]] += 1
        for c in sorted(set(cls.values())):
            members = [k for k in range(len(rooms)) if cls[k] == c]
            nn_same, nn_any = [], []
            for k in members:
                ds = [(math.dist(rooms[k]["c"], rooms[o]["c"]) * M_PER_PT, cls[o])
                      for o in range(len(rooms)) if o != k]
                if not ds:
                    continue
                nn_any.append(min(d for d, _ in ds))
                s = [d for d, cc in ds if cc == c]
                if s:
                    nn_same.append(min(s))
            if not nn_same:
                continue
            msame = sum(nn_same) / len(nn_same)
            many = sum(nn_any) / len(nn_any)
            frac = same[c] / tot[c] if tot[c] else None
            q4[bucket][c] = {
                "n": len(members),
                "mean_nn_same_class_m": round(msame, 2),
                "mean_nn_any_class_m": round(many, 2),
                # >1 means members of this class sit FURTHER from each other than from the
                # nearest room of any kind, i.e. they are spread rather than blocked.
                "clustering_ratio": round(msame / many, 2),
                "same_class_adjacency_fraction": round(frac, 3) if frac is not None else None,
                "verdict": ("n/a" if len(members) < 2 else
                            "DISTRIBUTED (never adjacent to its own kind)" if frac == 0 else
                            "clustered" if frac >= 0.30 else "mixed"),
            }

    # --- Q5 rollup (per-room detail already sits inside q1.detail)
    fr = [r["depth_fraction"] for r in seq if r["depth_fraction"] is not None]
    dp = [r["depth_m"] for r in seq if r["depth_fraction"] is not None]
    encl = [r for r in seq if GROUPS[r["kind"]] == "enclosed_programme" and r["depth_fraction"] is not None]
    q5 = {
        "$note": "cross-section = ray cast inward from the facade contact to the core or the far "
                 "wall. This plate has no wings; see the docstring's limitation.",
        "perimeter_rooms_measured": len(fr),
        "median_depth_m": round(sorted(dp)[len(dp) // 2], 2) if dp else None,
        "median_depth_fraction": round(sorted(fr)[len(fr) // 2], 3) if fr else None,
        "enclosed_median_depth_m": round(sorted(r["depth_m"] for r in encl)[len(encl) // 2], 2) if encl else None,
        "enclosed_median_depth_fraction": round(
            sorted(r["depth_fraction"] for r in encl)[len(encl) // 2], 3) if encl else None,
        "blocked_by": dict(collections.Counter(r["blocked_by"] for r in seq if r["blocked_by"])),
    }

    return {"q1_window_wall_band": q1, "q2_corridor_face": q2, "q3_pairing": q3,
            "q4_core_clustering": q4, "q5_depth": q5}


# ---------------------------------------------------------------- falsification

def falsify(doc, zf):
    """Perturb the input; the statistics MUST move. Exits non-zero if they do not.

    Two independent sabotages against page 3 (0-indexed 2), reported before/after:
      DROP  — delete the Office with the most facade. Q1's boundary total, Q1's office
              metres and Q3's pair count must all fall.
      SHIFT — translate the most-connected Conf Room by (18, 18) pt = (1.70, 1.70) m.
              It breaks collinearity on one axis and offsets on the other, so Q3's pair
              count and its matrix must both change.
    Each sabotage must move at least 2 of its 3 statistics ON ITS OWN — a combined score
    would let one loud sabotage carry a dead one.

    Read-only with respect to the PDF: the polygons are perturbed in memory, the file is
    never written (`.claude/rules/gate-independence.md`, "falsify against a disposable copy").
    """
    page = doc[2]
    plate, core, rooms = extract_page(page, zf)
    base = measure(2, plate, core, [dict(r) for r in rooms])

    def report(tag, m):
        q1, q3 = m["q1_window_wall_band"], m["q3_pairing"]
        return (f"{tag:9s} boundary_claimed_m={q1['boundary_claimed_m']:6.1f} "
                f"office_boundary_m={q1['boundary_m_by_kind'].get('Office', 0.0):5.1f} "
                f"rooms_on_boundary={q1['rooms_on_boundary']:3d} "
                f"pairs={q3['pairs']:3d} "
                f"distinct_pair_types={len(q3['counts']):3d}")

    print(report("BASELINE", base))
    ok = True

    # DROP -------------------------------------------------------------------
    victim = max(range(len(rooms)), key=lambda k: (rooms[k]["kind"] == "Office",
                                                   contact(rooms[k]["poly"], plate)))
    dropped = [dict(r) for k, r in enumerate(rooms) if k != victim]
    m_drop = measure(2, plate, core, dropped)
    print(report("DROP", m_drop) + f"   (dropped one {rooms[victim]['kind']})")
    n = sum(f(base) != f(m_drop) for f in (
        lambda m: m["q1_window_wall_band"]["boundary_claimed_m"],
        lambda m: m["q1_window_wall_band"]["boundary_m_by_kind"].get("Office", 0.0),
        lambda m: m["q3_pairing"]["pairs"]))
    print(f"          -> {n}/3 statistics moved")
    ok &= n >= 2

    # SHIFT ------------------------------------------------------------------
    deg = collections.Counter()
    for i in range(len(rooms)):
        for j in range(i + 1, len(rooms)):
            if contact(rooms[i]["poly"], rooms[j]["poly"]) >= MIN_CONTACT:
                deg[i] += 1
                deg[j] += 1
    k = max((i for i, r in enumerate(rooms) if r["kind"] == "Conf Room"), key=lambda i: deg[i])
    shifted = [dict(r) for r in rooms]
    shifted[k] = dict(rooms[k], poly=[(x + 18.0, y + 18.0) for x, y in rooms[k]["poly"]])
    shifted[k]["c"] = centroid(shifted[k]["poly"])
    m_shift = measure(2, plate, core, shifted)
    print(report("SHIFT", m_shift) + f"   (Conf Room with {deg[k]} neighbours moved +1.70,+1.70 m)")
    n = sum(f(base) != f(m_shift) for f in (
        lambda m: m["q3_pairing"]["pairs"],
        lambda m: m["q3_pairing"]["counts"],
        lambda m: m["q1_window_wall_band"]["boundary_claimed_m"]))
    print(f"          -> {n}/3 statistics moved")
    ok &= n >= 2

    if not ok:
        sys.exit("FALSIFICATION FAILED: the measurement is insensitive to its own input")
    print("\nFALSIFICATION PASSED — every statistic above is a function of the geometry, "
          "not of the constants")


# ---------------------------------------------------------------- main

def main():
    zf = zone_fills()
    doc = fitz.open(PDF)

    if "--falsify" in sys.argv:
        falsify(doc, zf)
        return

    anchor = check_scale_anchor(doc[2])
    pages, checks = {}, {}
    for pi in sorted(PAGES):
        plate, core, rooms = extract_page(doc[pi], zf)
        checks[str(pi + 1)] = check_page(pi, plate, core, rooms)
        if pi == 2:
            checks[str(pi + 1)]["adjacency_tolerance_sweep"] = check_tolerance_stability(rooms)
        m = measure(pi, plate, core, rooms)
        m["$page"] = pi + 1
        m["$alternative"] = checks[str(pi + 1)]["alternative"]
        m["room_counts"] = dict(collections.Counter(r["kind"] for r in rooms).most_common())
        m["service_labels"] = dict(collections.Counter(
            l for r in rooms for l in r["labels"]).most_common())
        pages[str(pi + 1)] = m

    a, b, c = (pages[k]["q1_window_wall_band"] for k in ("3", "4", "5"))
    spec = {
        "note": "FROZEN. Generated by research/qbiq-adjacency-extract.py. "
                "Re-running it is a re-registration event.",
        "source": str(PDF.relative_to(ROOT)),
        "reused_frozen_inputs": {
            "mm_per_pt": round(MM_PER_PT, 3),
            "desk_position_anchor_mm": list(DESK_POSITION_MM),
            "zone_fills": "research/qbiq-plan-style-spec.json#/palette/zone_fills",
            "stated_programme": "research/qbiq-composition-spec.json#/programme_mix/alternatives",
        },
        "method": "PDF path operators only (PyMuPDF get_drawings). No rasterisation, no flood "
                  "fill, no pixel sampling. Adjacency = collinear overlapping edge runs >= 0.5 m "
                  "at a 2.0 pt coincidence tolerance, with the tolerance sweep recorded below.",
        "self_checks": {
            "$comment": "Every one of these ABORTS the run rather than degrading. The office/conf "
                        "counts are the load-bearing one: they are the report's own STATED numbers, "
                        "reproduced from geometry the report did not supply.",
            "scale_anchor": anchor,
            "per_page": checks,
        },
        "headline": {
            "$comment": "The three claims a reader should take away, stated so they can be "
                        "falsified rather than believed.",
            "boundary_subscription": [a["boundary_subscription"], b["boundary_subscription"],
                                      c["boundary_subscription"]],
            "open_space_share_of_boundary": [x["boundary_share_by_kind"].get("Open Space", 0)
                                             for x in (a, b, c)],
            "enclosed_programme_share_of_boundary": [x["enclosed_programme_share"] for x in (a, b, c)],
            "office_conf_alternations_on_boundary": [x["office_conf_alternations"] for x in (a, b, c)],
            "office_office_adjacent_on_boundary": [x["office_office_adjacent_on_boundary"] for x in (a, b, c)],
            "office_facade_incidence": [x["facade_incidence_by_kind"]["Office"]["incidence"]
                                        for x in (a, b, c)],
            "conf_room_facade_incidence": [x["facade_incidence_by_kind"]["Conf Room"]["incidence"]
                                           for x in (a, b, c)],
            "perimeter_band_depth_m": [pages[k]["q5_depth"]["median_depth_m"] for k in ("3", "4", "5")],
            "RETRACTS": "docs/audits/LOOP-LEDGER.md S3-1: 'the reference lines the main field's "
                        "window wall with alternating offices and conference rooms'. Measured: "
                        "Open Space is the largest consumer of the facade on all three "
                        "alternatives, enclosed programme takes 26-31%, and office<->conf "
                        "alternations across the whole 151.9 m boundary number 2 / 1 / 1. "
                        "Office->Office is the commonest enclosed transition on every page. "
                        "REPLACE the retracted claim with three measured ones: (i) SUBSCRIPTION "
                        "— 84-86% of the boundary is claimed by SOME room, against a generator "
                        "that claims none of it; (ii) OFFICES take the facade and conference "
                        "rooms do not — incidence 1.00/1.00/0.57 vs 0.25/0.18/0.33; (iii) the "
                        "band is 4.03-4.04 m deep on all three plans.",
        },
        "limitations": [
            "GLAZING IS NOT MEASURABLE. All six plate edges are drawn identically (0.2903 pt "
            "double line); 0 of the 1265 fine-detail (0.1524 pt) segments lie within 4 pt of any "
            "plate edge, so that provisional tier is not glazing. 'Window wall' below means "
            "EXTERIOR BOUNDARY, which is the brief's word, not the drawing's.",
            "CIRCULATION IS NOT AN OBJECT. No wash marks corridors, so 'fronts onto circulation' "
            "is measured as FREE EDGE = perimeter - exterior - core - room-to-room. It proves the "
            "edge faces unwashed floor; it does not prove a corridor and it does not prove a door.",
            "DOORS ARE NOT MEASURED. Openings are white overdraws, not symbols; entry face is "
            "recoverable in principle and is not attempted here.",
            "NO WINGS. The plate is one hexagon around a central core, so Q5's 'fraction of the "
            "wing cross-section' is reported against a LOCAL cross-section (inward ray to core or "
            "far wall). Different denominator from the one the brief assumed.",
            "PAGE 5 (alternative C) LABELS ITS ROOMS THE SAME WAY BUT IS A DIFFERENT PLAN. "
            "Nothing here averages the three pages; each is reported separately and the spread "
            "between them is the honest error bar.",
        ],
        "pages": pages,
    }

    if "--print" in sys.argv:
        print(json.dumps(spec, indent=2))
        return
    OUT.write_text(json.dumps(spec, indent=2) + "\n")
    back = json.loads(OUT.read_text())
    if back["headline"]["boundary_subscription"] != spec["headline"]["boundary_subscription"]:
        sys.exit("write did not take — refusing to report success")
    print(f"wrote {OUT.relative_to(ROOT)}")
    for k in ("3", "4", "5"):
        q1 = pages[k]["q1_window_wall_band"]
        print(f"  page {k} (alt {pages[k]['$alternative']}): "
              f"subscription {q1['boundary_subscription']:.1%}  "
              f"open-space share {q1['boundary_share_by_kind'].get('Open Space', 0):.1%}  "
              f"enclosed share {q1['enclosed_programme_share']:.1%}  "
              f"office<->conf alternations {q1['office_conf_alternations']}")


if __name__ == "__main__":
    main()
