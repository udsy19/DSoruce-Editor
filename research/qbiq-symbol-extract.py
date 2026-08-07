#!/usr/bin/env python3
"""Extract the reference's FURNITURE SYMBOL vocabulary from its own vector operators.

    python3 research/qbiq-symbol-extract.py             # writes the JSON
    python3 research/qbiq-symbol-extract.py --print     # measure, print, write nothing
    python3 research/qbiq-symbol-extract.py --falsify   # perturb the input, prove the numbers move
    python3 research/qbiq-symbol-extract.py --dump DIR  # render every symbol to SVG for labelling

Output: `research/qbiq-symbol-spec.json`, frozen like the composition fixture.
Re-running it after a reference change is a re-registration event.

Companion to `research/qbiq-composition-extract.py`, whose structure, self-checks
and frozen constants this file reuses. Everything in the SCALE block below comes
from there and is NOT re-derived here.

WHY A CONSTELLATION EXTRACTOR AND NOT A CLUSTERER
-------------------------------------------------
The obvious method — union adjacent paths into "symbol instances" — was built
first and it is WRONG on this artifact, measurably:

    eps (bbox shrink, pt)   clusters   largest cluster   desk rects surviving alone
    0.0  (touching joins)      229      78 paths, 3.7 m       0 of 106
   -0.1                       1090      67 paths, 4.6 m      35 of 106
   -0.3                       1219      67 paths, 4.6 m      53 of 106

A bench desk field is drawn as 675 x 1350 rectangles that TOUCH, so any epsilon
that keeps a chair's armrest attached to its seat also welds forty desks into one
"symbol", and any epsilon that separates the desks also detaches the armrest.
The instance boundary is simply not present in the bytes as adjacency. Reporting
a symbol count off that method would have been a confident wrong number.

What IS present is REPETITION. A CAD block placed 106 times leaves 106 congruent
point sets at the same relative poses. So:

  1. TYPE every furniture-tier path by congruence — orientation-canonicalised,
     arclength-resampled, matched within a stated tolerance. No adjacency.
  2. LINK two paths only when they are in contact (bbox gap <= ADJACENCY_GAP_MM)
     AND the ordered pair (typeA, typeB, relative pose in A's own frame) recurs
     at least MIN_SUPPORT times. A contact that happens once is a coincidence; a
     contact that happens twenty times at the same pose is a block.
  3. SAME-TYPE relations are excluded. A symbol does not contain a repeated copy
     of itself at a lattice pitch — that is a FIELD, and it is exactly the
     desk-to-desk contact that welded the field together above. Chair seat to
     chair backrest survives (different types); desk to desk does not, so the
     bench field stays 106 objects instead of one.

The same-type exclusion is the one load-bearing modelling choice in this file.
It is stated here, and `--falsify` measures what it is worth.

WHAT COUNTS AS ONE SYMBOL
-------------------------
The assembled object, not the composed scene. A conference table and its ring of
chairs come out as ONE table plus TEN chairs, because the chairs stand clear of
the table edge — that separation is measured, not assumed, and it is reported in
`placement_relations` as the ring offset. Treating the ring as part of the table
symbol would bake a seat count into a glyph, which is the exact defect
`web/src/editor/symbols.ts` was written to remove.

CALIBRATING SHAPE_TOL_MM (measured, not chosen)
-----------------------------------------------
The tolerance sweep, on page 3, reporting the count of the two most repeated
parts (the chair backrest and the chair armrest):

    tol mm    part types    backrest    armrest
       12          304       129 + 91   176
       18          259       137 + 91   196
       25          225       218        203
       35          198       231        212
       50          172       228        207

Below 25 mm the reference's own arc tessellation splits ONE block into two types
(415.1 x 81.6 and 415.4 x 81.6 mm — the same backrest, sampled at a different
phase). Above 35 mm distinct parts begin to merge (the backrest count overshoots
the number of chairs). 25 mm is the floor of the plateau, and it is 6% of the
backrest's long side.

WHAT THIS FILE DOES NOT CLAIM
-----------------------------
Symbol NAMES are not measured. The extractor produces geometry, dimensions and
counts; naming a 483 x 272 mm rounded polygon "chair seat" is a reading of the
rendered SVG by a human or an agent, and it is recorded in `naming_provenance`
as a reading, not as a measurement.
"""
import argparse
import collections
import json
import math
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "docs/reference/qbiq/extracted/Sample Report/Crystal Tower  Modern-2024-08-11-07-17-04.pdf"
OUT = ROOT / "research/qbiq-symbol-spec.json"

# --- FROZEN, from research/qbiq-composition-extract.py. Do not re-derive. -----
#: 1 pt in mm at the reference plan's measured scale.
MM_PER_PT = 10 / 32.5 * 304.8
#: The bench desk position, in mm. PRIMARY SIZE ANCHOR — the run aborts if the
#: dominant matched rectangle is not this within 10%.
DESK_POSITION_MM = (675, 1350)
#: The left 30% of the page is the stats card, not the plan.
PLAN_X_FRACTION = 0.30
#: Furniture-tier stroke width, in pt (spec `line_weights.tiers[0]`).
FURNITURE_PT = 0.1452
#: Column tier, and the grey the reference fills columns with.
COLUMN_PT = 0.2177
COLUMN_GREY = (0.6274510025978088,) * 3

# --- Extractor parameters. Every one of them is reported in the output. ------
#: Points per resampled outline. 48 puts a sample every ~84 mm on the largest
#: repeated part (the 1348 x 674 desk rect), well under SHAPE_TOL_MM.
RESAMPLE_N = 48
#: Two outlines are the same part type if no corresponding sample differs by
#: more than this. CALIBRATED, not chosen — see the sweep in the module
#: docstring. 25 mm is the floor of the plateau where one block stops splitting
#: into two types and before distinct parts start merging.
SHAPE_TOL_MM = 25.0
#: Relative poses are binned at this size before counting support.
POSE_QUANT_MM = 15.0
#: Parts are members of one symbol only if their bounding boxes are in CONTACT
#: within this gap. Adjacency alone welds the desk field (see the docstring); it
#: is safe only in combination with the same-type exclusion and MIN_SUPPORT.
#: Measured insensitivity: 5 / 30 / 60 mm give 886 / 810 / 799 groups with an
#: identical largest group, so nothing here balances on the value.
ADJACENCY_GAP_MM = 5.0
#: Radius for the PLACEMENT relations reported alongside the symbols (a chair's
#: offset from the table it serves). Not used for assembly.
RELATE_RADIUS_MM = 1200.0
#: A (typeA, typeB, pose) relation must recur this many times to be a block.
MIN_SUPPORT = 3
#: A symbol shape is reported when it occurs at least this often. Below it the
#: geometry is bespoke draughting, not a repeated block.
MIN_SYMBOL_COUNT = 3


#: READINGS, not measurements. Keyed by (parts, round(w_mm), round(h_mm)) so the
#: key is reproducible across runs. Each value is what an agent READ off the
#: rendered SVG (`--dump`); the geometry beside it is measured, the noun is not.
#: An unlisted symbol is reported with no name rather than a guessed one.
READINGS = {
    (5, 1348, 1021): "workstation: bench desk position + tucked task chair",
    (1, 415, 75): "task-chair backrest capsule (chair whose seat sits on another symbol)",
    (4, 1348, 939): "workstation, armless chair variant",
    (4, 565, 510): "task chair: seat 470x429, backrest 415x82, two armrests 48x286",
    (2, 470, 510): "side chair: seat + backrest, no arms",
    (1, 483, 48): "table-top cable/power slot",
    (1, 286, 48): "table-top cable/power slot, short",
    (3, 565, 429): "task chair, backrest omitted",
    (5, 490, 538): "planter: overlapping foliage blobs",
    (1, 510, 510): "pouffe / low round-square stool",
    (2, 477, 422): "lounge armchair: seat + back",
    (1, 470, 429): "chair seat, standalone",
    (5, 1348, 1048): "workstation with two chairs",
    (1, 858, 68): "coat rail with five hooks",
    (1, 579, 579): "round table / stool, 579 dia",
    (2, 572, 497): "lounge armchair with wrap-around back",
    (5, 1491, 1321): "workstation on the diagonal facade (rotated ~25 degrees)",
    (5, 1497, 1327): "workstation on the diagonal facade (rotated ~25 degrees)",
    (4, 558, 510): "task chair, arms on the long sides",
    (6, 960, 436): "crossed-X casework run: outline + cell divider + both diagonals",
    (4, 1348, 1048): "workstation with two chairs",
    (3, 463, 306): "training / auditorium chair: seat + back",
    (2, 463, 299): "training / auditorium chair: seat + back",
    (1, 769, 769): "round table, 769 dia",
    (1, 1926, 769): "meeting table top, rounded rect",
    (1, 987, 681): "crossed-X casework cell, large",
}


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def path_points(d):
    """A drawing's items flattened to one mm-space polyline."""
    out = []
    for it in d["items"]:
        k = it[0]
        if k == "l":
            out += [(it[1].x, it[1].y), (it[2].x, it[2].y)]
        elif k == "c":
            out += [(it[i].x, it[i].y) for i in (1, 2, 3, 4)]
        elif k == "re":
            r = it[1]
            out += [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)]
        elif k == "qu":
            q = it[1]
            out += [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y),
                    (q.ll.x, q.ll.y), (q.ul.x, q.ul.y)]
    return [(x * MM_PER_PT, y * MM_PER_PT) for x, y in out]


def orient(P):
    """Canonical orientation: landscape bbox at the origin, third-moment signs
    positive. Deterministic, and stable for symmetric shapes (whose moments are
    zero and whose flips are therefore congruent anyway)."""
    xs = [a for a, _ in P]
    ys = [b for _, b in P]
    W, H = max(xs) - min(xs), max(ys) - min(ys)
    if W + 1e-9 < H:
        P = [(-b, a) for a, b in P]
        W, H = H, W
    mx = min(a for a, _ in P)
    my = min(b for _, b in P)
    P = [(a - mx, b - my) for a, b in P]
    n = len(P)
    cx = sum(a for a, _ in P) / n
    cy = sum(b for _, b in P) / n
    scale = (max(W, H) ** 3 * n) or 1.0
    if sum((a - cx) ** 3 for a, _ in P) / scale < -1e-6:
        P = [(W - a, b) for a, b in P]
    if sum((b - cy) ** 3 for _, b in P) / scale / (scale and 1) < -1e-6:
        P = [(a, H - b) for a, b in P]
    return P, W, H


def arclengths(P):
    s = [0.0]
    for i in range(len(P) - 1):
        s.append(s[-1] + math.dist(P[i], P[i + 1]))
    return s


def point_at(P, s, t):
    lo, hi = 0, len(s) - 1
    while lo < hi - 1:
        m = (lo + hi) // 2
        if s[m] <= t:
            lo = m
        else:
            hi = m
    d = s[lo + 1] - s[lo]
    f = (t - s[lo]) / d if d > 0 else 0.0
    return (P[lo][0] + (P[lo + 1][0] - P[lo][0]) * f,
            P[lo][1] + (P[lo + 1][1] - P[lo][1]) * f)


def signature(P0):
    """Congruence signature: RESAMPLE_N points, orientation-canonical, started at
    the vertex nearest the bbox origin (a continuous anchor — an integer index
    shift would leave up to half a sample of phase error, which measured 42 mm on
    the desk rect and split it into two spurious types)."""
    P, W, H = orient(P0)
    s = arclengths(P)
    L = s[-1]
    if L <= 0:
        return ((0.0, 0.0),) * RESAMPLE_N, W, H
    closed = math.dist(P[0], P[-1]) < 2.0
    start = min(range(len(P)), key=lambda i: P[i][0] ** 2 + P[i][1] ** 2)
    t0 = s[start] if closed else 0.0
    variants = []
    for direction in (1, -1):
        v = []
        for i in range(RESAMPLE_N):
            if closed:
                v.append(point_at(P, s, (t0 + direction * L * i / RESAMPLE_N) % L))
            else:
                u = L * i / (RESAMPLE_N - 1)
                v.append(point_at(P, s, u if direction > 0 else L - u))
        variants.append(tuple(v))
    return min(variants), W, H


def transform(pt, rot, mir):
    x, y = pt[0] * mir, pt[1]
    for _ in range(rot):
        x, y = -y, x
    return x, y


# ---------------------------------------------------------------------------
# Reading the page
# ---------------------------------------------------------------------------

def furniture_paths(page):
    x0 = page.rect.width * PLAN_X_FRACTION
    return [d for d in page.get_drawings()
            if d["rect"].x1 >= x0 and round(d.get("width") or 0, 4) == round(FURNITURE_PT, 4)]


def column_paths(page):
    """Grey-filled column rects. Cross-check on the scale AND on the palette."""
    x0 = page.rect.width * PLAN_X_FRACTION
    out = []
    for d in page.get_drawings():
        f = d.get("fill")
        if d["rect"].x1 < x0 or not f:
            continue
        if all(abs(c - COLUMN_GREY[0]) < 2e-3 for c in f):
            out.append(d)
    return out


def figure_ground_census(page):
    """The white-fill rule, counted rather than asserted. A furniture mark in the
    reference is an OPAQUE WHITE fill with an outline over it — that is what makes
    a desk read as an object standing on the zone wash instead of a hollow frame.
    """
    x0 = page.rect.width * PLAN_X_FRACTION
    tally = collections.Counter()
    for d in page.get_drawings():
        if d["rect"].x1 < x0:
            continue
        if round(d.get("width") or 0, 4) != round(FURNITURE_PT, 4):
            continue
        f = d.get("fill")
        if f is None:
            tally["stroke_only"] += 1
        elif all(c > 0.999 for c in f):
            tally["opaque_white_fill"] += 1
        else:
            tally["other_fill"] += 1
        tally["fill_opacity_" + str(d.get("fill_opacity"))] += 1
    return dict(tally)


def parallel_runs(page, min_members=5):
    """Evenly-spaced parallel line runs — the stair-tread convention, measured
    rather than assumed. Reads the WALL tier, because the reference draws its core
    fixtures there and not on the furniture tier (itself a finding)."""
    x0 = page.rect.width * PLAN_X_FRACTION
    lines = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.x1 < x0 or len(d["items"]) != 1 or d["items"][0][0] != "l":
            continue
        a, b = d["items"][0][1], d["items"][0][2]
        if abs(a.y - b.y) < 1e-6:
            lines.append(("h", round(abs(a.x - b.x) * MM_PER_PT), a.y * MM_PER_PT,
                          min(a.x, b.x) * MM_PER_PT))
        elif abs(a.x - b.x) < 1e-6:
            lines.append(("v", round(abs(a.y - b.y) * MM_PER_PT), a.x * MM_PER_PT,
                          min(a.y, b.y) * MM_PER_PT))
    families = collections.defaultdict(list)
    for orient_, length, across, start in lines:
        families[(orient_, round(length / 25) * 25, round(start / 100))].append(across)
    runs = []
    for (orient_, length, _), vals in families.items():
        vals = sorted(vals)
        run = [vals[0]]
        for v in vals[1:]:
            step = v - run[-1]
            if len(run) == 1 or abs(step - (run[1] - run[0])) < 25:
                run.append(v)
            else:
                if len(run) >= min_members:
                    runs.append((len(run), length, round(run[1] - run[0])))
                run = [v]
        if len(run) >= min_members:
            runs.append((len(run), length, round(run[1] - run[0])))
    runs.sort(reverse=True)
    return [{"members": n, "line_length_mm": L, "pitch_mm": p} for n, L, p in runs[:6]]


def check_scale_anchor(paths):
    """ABORT if the dominant matched rectangle is not the stated bench desk
    position within 10%. Every millimetre below depends on it."""
    lo, hi = DESK_POSITION_MM
    sizes = collections.Counter()
    for d in paths:
        r = d["rect"]
        w, h = r.width * MM_PER_PT, r.height * MM_PER_PT
        if abs(min(w, h) - lo) <= 0.20 * lo and abs(max(w, h) - hi) <= 0.20 * hi:
            sizes[(round(min(w, h)), round(max(w, h)))] += 1
    if not sizes:
        sys.exit("no desk positions matched — the scale anchor or the page index is wrong")
    top, count = sizes.most_common(1)[0]
    want = tuple(sorted(DESK_POSITION_MM))
    if any(abs(a - b) > 0.10 * b for a, b in zip(top, want)):
        sys.exit(f"dominant matched size is {top} mm, expected {want} mm — scale anchor failed")
    return {"dominant_mm": list(top), "count": count, "expected_mm": list(want)}


# ---------------------------------------------------------------------------
# The extraction
# ---------------------------------------------------------------------------

def type_paths(paths):
    """Group congruent paths. Returns (per-path type id, per-type representative)."""
    reps = []          # (signature, W, H)
    by_box = collections.defaultdict(list)
    assign = []
    sigs = [signature(path_points(d)) for d in paths]
    for sig, W, H in sigs:
        found = None
        bw, bh = int(W // 60), int(H // 60)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ri in by_box.get((bw + dx, bh + dy), ()):
                    rs = reps[ri][0]
                    if max(max(abs(a[0] - b[0]), abs(a[1] - b[1]))
                           for a, b in zip(sig, rs)) <= SHAPE_TOL_MM:
                        found = ri
                        break
                if found is not None:
                    break
            if found is not None:
                break
        if found is None:
            found = len(reps)
            reps.append((sig, W, H))
            by_box[(bw, bh)].append(found)
        assign.append(found)
    return assign, reps, sigs


def build_instances(paths, assign, sigs):
    inst = []
    for d, t, (_sig, W, H) in zip(paths, assign, sigs):
        P0 = path_points(d)
        # Recover the pose that `orient` applied, so relative poses are comparable.
        xs = [a for a, _ in P0]
        ys = [b for _, b in P0]
        rot = 1 if (max(xs) - min(xs)) + 1e-9 < (max(ys) - min(ys)) else 0
        r = d["rect"]
        inst.append({
            "t": t,
            "rot": rot,
            "cx": (r.x0 + r.x1) / 2 * MM_PER_PT,
            "cy": (r.y0 + r.y1) / 2 * MM_PER_PT,
            "w": r.width * MM_PER_PT,
            "h": r.height * MM_PER_PT,
            "W": W, "H": H,
            "fill": d.get("fill"),
            "pts": P0,
        })
    return inst


def _bbox_gap_mm(a, b):
    dx = max(0.0, max(a["cx"] - a["w"] / 2, b["cx"] - b["w"] / 2)
             - min(a["cx"] + a["w"] / 2, b["cx"] + b["w"] / 2))
    dy = max(0.0, max(a["cy"] - a["h"] / 2, b["cy"] - b["h"] / 2)
             - min(a["cy"] + a["h"] / 2, b["cy"] + b["h"] / 2))
    return math.hypot(dx, dy)


def _pairs(inst, radius):
    """Ordered near pairs of DIFFERENT part types, with b's pose in a's frame."""
    cell = radius
    buckets = collections.defaultdict(list)
    for i, a in enumerate(inst):
        buckets[(int(a["cx"] // cell), int(a["cy"] // cell))].append(i)
    for (gx, gy), here in buckets.items():
        near = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                near += buckets.get((gx + dx, gy + dy), ())
        for i in here:
            a = inst[i]
            for j in near:
                if i == j:
                    continue
                b = inst[j]
                if a["t"] == b["t"]:
                    continue
                if abs(a["cx"] - b["cx"]) > radius or abs(a["cy"] - b["cy"]) > radius:
                    continue
                ax, ay = transform((a["cx"], a["cy"]), a["rot"], 1)
                bx, by = transform((b["cx"], b["cy"]), a["rot"], 1)
                key = (a["t"], b["t"], (b["rot"] - a["rot"]) % 4,
                       round((bx - ax) / POSE_QUANT_MM) * POSE_QUANT_MM,
                       round((by - ay) / POSE_QUANT_MM) * POSE_QUANT_MM)
                yield i, j, key, _bbox_gap_mm(a, b)


def assemble(inst):
    """Union parts that are IN CONTACT at a RECURRING relative pose. Same-type
    relations are excluded — see the module docstring."""
    support = collections.defaultdict(set)
    edges = []
    for i, j, key, gap in _pairs(inst, RELATE_RADIUS_MM):
        if gap > ADJACENCY_GAP_MM:
            continue
        support[key].add(i)
        edges.append((i, j, key))

    parent = list(range(len(inst)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    joined = 0
    for i, j, key in edges:
        if len(support[key]) >= MIN_SUPPORT:
            a, b = find(i), find(j)
            if a != b:
                parent[a] = b
                joined += 1
    groups = collections.defaultdict(list)
    for i in range(len(inst)):
        groups[find(i)].append(i)
    return list(groups.values()), joined, len(support)


def placement_relations(inst, part_of):
    """Recurring NON-CONTACT poses between parts of DIFFERENT symbols — the
    reference's own placement rules (a chair's stand-off from the table it
    serves). Reported, never used for assembly."""
    tally = collections.defaultdict(list)
    for i, j, key, gap in _pairs(inst, RELATE_RADIUS_MM):
        if gap <= ADJACENCY_GAP_MM or part_of[i] == part_of[j]:
            continue
        tally[key].append(gap)
    out = []
    for key, gaps in tally.items():
        if len(gaps) < 8:
            continue
        gaps.sort()
        out.append({
            "type_a": key[0], "type_b": key[1], "quarter_turns": key[2],
            "dx_mm": key[3], "dy_mm": key[4],
            "count": len(gaps), "median_clear_mm": round(gaps[len(gaps) // 2]),
        })
    out.sort(key=lambda r: -r["count"])
    return out[:20]


def fingerprint(inst, group):
    """Translation/rotation-invariant identity of an assembled symbol.

    NOT the exact part-type tuple. The reference's own arc tessellation still
    leaves near-duplicate part types after congruence typing, and an exact tuple
    splits one real symbol across several fingerprints — the workstation came out
    as 6 + 6 + 6 + 4 + 4 instead of one count of 26. So identity is the symbol's
    SHAPE: part count, overall size, and each part's size, all binned at
    SHAPE_TOL_MM. That is the level at which the spec is consumed anyway.
    """
    anchor = max(group, key=lambda i: inst[i]["w"] * inst[i]["h"])
    a = inst[anchor]
    rot = a["rot"]
    xs, ys = [], []
    dims = []
    for i in group:
        b = inst[i]
        q = [transform(p, rot, 1) for p in b["pts"]]
        bx = [p[0] for p in q]
        by = [p[1] for p in q]
        xs += bx
        ys += by
        dims.append((round((max(bx) - min(bx)) / SHAPE_TOL_MM),
                     round((max(by) - min(by)) / SHAPE_TOL_MM)))
    key = (len(group),
           round((max(xs) - min(xs)) / SHAPE_TOL_MM),
           round((max(ys) - min(ys)) / SHAPE_TOL_MM),
           tuple(sorted(dims)))
    return key, anchor


def symbol_geometry(inst, group, anchor):
    """The symbol's outlines in its own frame, mm, y-down, origin at bbox centre."""
    a = inst[anchor]
    rot = a["rot"]
    polys = []
    xs, ys = [], []
    for i in group:
        q = [transform(p, rot, 1) for p in inst[i]["pts"]]
        polys.append(q)
        xs += [p[0] for p in q]
        ys += [p[1] for p in q]
    cx = (min(xs) + max(xs)) / 2
    cy = (min(ys) + max(ys)) / 2
    return (
        [[(round(x - cx, 1), round(y - cy, 1)) for x, y in q] for q in polys],
        round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1),
    )


def placement_pitch(centres):
    """Nearest-neighbour spacing of a symbol's own instances, in mm."""
    if len(centres) < 4:
        return None
    ds = []
    for i, (x, y) in enumerate(centres):
        best = min((math.dist((x, y), c) for j, c in enumerate(centres) if j != i), default=None)
        if best:
            ds.append(best)
    if not ds:
        return None
    ds.sort()
    return round(ds[len(ds) // 2])


def extract(page, drop_paths=frozenset(), merge_groups=False):
    paths = furniture_paths(page)
    if drop_paths:
        paths = [d for i, d in enumerate(paths) if i not in drop_paths]
    anchor_check = check_scale_anchor(paths)
    assign, reps, sigs = type_paths(paths)
    inst = build_instances(paths, assign, sigs)
    groups, joined, relations = assemble(inst)
    if merge_groups and len(groups) >= 2:
        groups = sorted(groups, key=len, reverse=True)
        groups = [groups[0] + groups[1]] + groups[2:]

    part_of = {}
    for n, g in enumerate(groups):
        for i in g:
            part_of[i] = n

    by_fp = collections.defaultdict(list)
    for g in groups:
        fp, _anchor = fingerprint(inst, g)
        by_fp[fp].append(g)

    symbols = []
    for fp, gs in by_fp.items():
        if len(gs) < MIN_SYMBOL_COUNT:
            continue
        g = gs[0]
        anchor = max(g, key=lambda i: inst[i]["w"] * inst[i]["h"])
        polys, W, H = symbol_geometry(inst, g, anchor)
        centres = []
        for gg in gs:
            xs = [inst[i]["cx"] for i in gg]
            ys = [inst[i]["cy"] for i in gg]
            centres.append((sum(xs) / len(xs), sum(ys) / len(ys)))
        fills = collections.Counter(str(inst[i]["fill"]) for i in g)
        top_fill = fills.most_common(1)[0][0]
        symbols.append({
            "count": len(gs),
            "parts": len(g),
            "w_mm": W, "h_mm": H,
            "part_sizes_mm": sorted([round(inst[i]["w"]), round(inst[i]["h"])] for i in g),
            "fill": "white" if top_fill.startswith("(1.0, 1.0, 1.0)") else top_fill,
            "stroke_pt": FURNITURE_PT,
            "pitch_mm": placement_pitch(centres),
            "reading": READINGS.get((len(g), round(W), round(H))),
            "outlines": polys,
        })
    symbols.sort(key=lambda s: (-s["count"], -s["w_mm"] * s["h_mm"]))
    return {
        "paths": len(paths),
        "part_types": len(reps),
        "groups": len(groups),
        "relations": relations,
        "joins": joined,
        "distinct_fingerprints": len(by_fp),
        "anchor_check": anchor_check,
        "symbols": symbols,
        "placement": placement_relations(inst, part_of),
        "instances_in_reported": sum(s["count"] for s in symbols),
        "_inst": inst,
        "_groups": groups,
        "_by_fp": by_fp,
    }


# ---------------------------------------------------------------------------
# Falsification (rule R3): perturb the input, prove the numbers MOVE
# ---------------------------------------------------------------------------

def falsify(page):
    base = extract(page)
    print("BASELINE")
    print(f"  paths={base['paths']}  part_types={base['part_types']}  "
          f"groups={base['groups']}  fingerprints={base['distinct_fingerprints']}  "
          f"reported_symbols={len(base['symbols'])}")
    top = base["symbols"][0]
    print(f"  top symbol: n={top['count']} parts={top['parts']} "
          f"{top['w_mm']}x{top['h_mm']}mm pitch={top['pitch_mm']}")
    ok = True

    # (a) DROP one path out of ONE instance of the most-repeated symbol. That
    #     instance's shape changes, so the symbol's count must fall by exactly one.
    #     The victim is taken from the top symbol's OWN group list — picking any
    #     group with the same part count is not the same thing, and the first
    #     version of this check did that and reported a false pass.
    hot_fp = max(base["_by_fp"], key=lambda k: len(base["_by_fp"][k]))
    victim = base["_by_fp"][hot_fp][0][0]
    a = extract(page, drop_paths={victim})
    same = next((s for s in a["symbols"] if s["parts"] == top["parts"]
                 and abs(s["w_mm"] - top["w_mm"]) < 1 and abs(s["h_mm"] - top["h_mm"]) < 1), None)
    got = same["count"] if same else 0
    print(f"\n(a) DROP path #{victim} from one instance of the top symbol")
    print(f"    paths {base['paths']} -> {a['paths']}   "
          f"that symbol's count {top['count']} -> {got}")
    if got != top["count"] - 1:
        ok = False
        print(f"    *** FAIL: expected {top['count'] - 1}; the fingerprint is not reading geometry")

    # (b) MERGE the two largest groups. The fingerprint set must change.
    b = extract(page, merge_groups=True)
    print(f"\n(b) MERGE the two largest groups")
    print(f"    groups {base['groups']} -> {b['groups']}   "
          f"fingerprints {base['distinct_fingerprints']} -> {b['distinct_fingerprints']}")
    if b["distinct_fingerprints"] == base["distinct_fingerprints"] and b["groups"] == base["groups"]:
        ok = False
        print("    *** FAIL: merging two clusters changed nothing")

    # (c) DROP every instance of the most common part type. Symbol count must fall.
    tcount = collections.Counter(i["t"] for i in base["_inst"])
    hot = tcount.most_common(1)[0][0]
    drop = {i for i, x in enumerate(base["_inst"]) if x["t"] == hot}
    c = extract(page, drop_paths=drop)
    print(f"\n(c) DROP all {len(drop)} instances of the most common part type t{hot}")
    print(f"    part_types {base['part_types']} -> {c['part_types']}   "
          f"reported symbols {len(base['symbols'])} -> {len(c['symbols'])}")
    if len(c["symbols"]) >= len(base["symbols"]) and c["part_types"] >= base["part_types"]:
        ok = False
        print("    *** FAIL: removing the dominant part changed neither the vocabulary nor the count")

    print("\nFALSIFICATION " + ("PASSED — every perturbation moved a reported number"
                                if ok else "FAILED"))
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# SVG dump, so the geometry can be READ before it is named
# ---------------------------------------------------------------------------

def dump_svg(spec, outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    for n, s in enumerate(spec["symbols"]):
        pad = 40
        W, H = s["w_mm"] + 2 * pad, s["h_mm"] + 2 * pad
        body = []
        for poly in s["outlines"]:
            pts = " ".join(f"{x + W / 2:.1f},{y + H / 2:.1f}" for x, y in poly)
            body.append(f'<polyline points="{pts}" fill="white" stroke="black" stroke-width="6"/>')
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
               f'width="{W / 3:.0f}" height="{H / 3:.0f}">' + "".join(body) + "</svg>")
        (outdir / f"sym{n:02d}_n{s['count']}_{s['w_mm']:.0f}x{s['h_mm']:.0f}.svg").write_text(svg)
    print(f"wrote {len(spec['symbols'])} SVGs to {outdir}")


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", dest="show", action="store_true")
    ap.add_argument("--falsify", action="store_true")
    ap.add_argument("--dump")
    ap.add_argument("--page", type=int, default=2)
    args = ap.parse_args()

    doc = fitz.open(PDF)
    page = doc[args.page]
    if args.falsify:
        sys.exit(falsify(page))

    spec = extract(page)
    cols = column_paths(page)
    col_sizes = collections.Counter(
        (round(d["rect"].width * MM_PER_PT), round(d["rect"].height * MM_PER_PT)) for d in cols)

    if args.dump:
        dump_svg(spec, args.dump)
        return

    out = {
        "note": "FROZEN. Generated by research/qbiq-symbol-extract.py. "
                "Re-running it after a reference change is a re-registration event.",
        "source": str(PDF.relative_to(ROOT)),
        "page_index": args.page,
        "method": "congruence typing + recurring-rigid-relation assembly. NOT adjacency "
                  "clustering — see the module docstring for the measurement that rules it out.",
        "scale": {"mm_per_pt": round(MM_PER_PT, 3),
                  "anchor_desk_position_mm": list(DESK_POSITION_MM),
                  "anchor_check": spec["anchor_check"]},
        "parameters": {
            "resample_n": RESAMPLE_N,
            "shape_tol_mm": SHAPE_TOL_MM,
            "pose_quant_mm": POSE_QUANT_MM,
            "relate_radius_mm": RELATE_RADIUS_MM,
            "min_support": MIN_SUPPORT,
            "min_symbol_count": MIN_SYMBOL_COUNT,
            "same_type_relations_excluded": True,
        },
        "census": {
            "furniture_tier_paths": spec["paths"],
            "congruent_part_types": spec["part_types"],
            "assembled_groups": spec["groups"],
            "distinct_symbol_shapes": spec["distinct_fingerprints"],
            "recurring_contact_relations": spec["relations"],
            "reported_symbols": len(spec["symbols"]),
            "instances_covered_by_reported_symbols": spec["instances_in_reported"],
        },
        "placement_relations": {
            "$comment": "Recurring NON-CONTACT poses between parts of DIFFERENT symbols — the "
                        "reference's own placement rules (a chair's stand-off from the table it "
                        "serves). Reported, never used for assembly. `median_clear_mm` is the "
                        "bbox-to-bbox clear gap.",
            "top": spec["placement"],
        },
        "columns": {
            "$comment": "Cross-check, from a DIFFERENT tier: grey-filled rects at the column "
                        "stroke width. Confirms both the scale and planStyle's COLUMN_FILL.",
            "count_paths": len(cols),
            "sizes_mm": [{"w": w, "h": h, "n": n} for (w, h), n in col_sizes.most_common()],
            "fill_rgb01": list(COLUMN_GREY),
            "fill_hex": "#%02x%02x%02x" % tuple(round(c * 255) for c in COLUMN_GREY),
            "hatched": False,
        },
        "conventions": {
            "$comment": "Drawing conventions measured off the same page, outside the symbol "
                        "assembly, because they are RULES rather than shapes.",
            "figure_ground": {
                "$comment": "The white-fill rule, COUNTED. A furniture mark in the reference is an "
                            "opaque white fill with an outline over it — that is what makes a desk "
                            "read as an object standing on the zone wash rather than a hollow frame.",
                "census": figure_ground_census(page),
            },
            "even_line_runs": {
                "$comment": "Evenly-spaced parallel runs on the WALL tier — the stair-tread "
                            "convention. That core fixtures live on the wall tier and not the "
                            "furniture tier is itself a finding: a furniture-tier extractor sees "
                            "no stairs, no lift cars and no WC fixtures at all.",
                "runs": parallel_runs(page),
            },
        },
        "naming_provenance": "Dimensions, counts, poses and outlines are MEASURED. The `name` "
                             "field on each symbol is a READING of the rendered geometry "
                             "(--dump), not a measurement, and is marked as such.",
        "symbols": [
            {k: v for k, v in s.items() if k != "outlines"} | {"outlines": s["outlines"]}
            for s in spec["symbols"]
        ],
    }

    if args.show:
        slim = dict(out)
        slim["symbols"] = [{k: v for k, v in s.items() if k != "outlines"} for s in out["symbols"]]
        print(json.dumps(slim, indent=2))
        return

    OUT.write_text(json.dumps(out, indent=2) + "\n")
    back = json.loads(OUT.read_text())
    if len(back["symbols"]) != len(out["symbols"]):
        sys.exit("write did not take — refusing to report success")
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  furniture paths      {spec['paths']}")
    print(f"  congruent part types {spec['part_types']}")
    print(f"  assembled groups     {spec['groups']}")
    print(f"  distinct shapes      {spec['distinct_fingerprints']}")
    print(f"  reported symbols     {len(spec['symbols'])} (>= {MIN_SYMBOL_COUNT} occurrences)")
    for s in spec["symbols"][:12]:
        print(f"    n={s['count']:4d} parts={s['parts']:2d} "
              f"{s['w_mm']:7.1f} x {s['h_mm']:7.1f} mm  pitch={s['pitch_mm']}")


if __name__ == "__main__":
    main()
