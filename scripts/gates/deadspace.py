#!/usr/bin/env python3
"""DEAD SPACE: how much of a floor plan's plate is far from anything drawn on it.

    !!  UNTRUSTED — DO NOT QUOTE THIS SCRIPT'S NUMBERS  !!

    Its plate segmentation is wrong, it was wrong in the two earlier versions
    too, and the three versions disagree with each other. See
    "WHY THIS IS UNTRUSTED" below before using or citing anything here.


    python3 scripts/gates/deadspace.py --png <plan.png> --m-per-px <k> [--radius 3.0]
    python3 scripts/gates/deadspace.py --pdf <report.pdf> --page 3 [--radius 3.0]

One instrument, two subjects. It is applied to the qbiq reference report page to
derive a threshold, and to our own delivered plan to test against it — so the
comparison is between two measurements rather than between a measurement and a
number somebody chose. That is the point: the threshold is REFERENCE-DERIVED,
never calibrated on the artifact under test
(`.claude/rules/gate-independence.md`, "never calibrate against the population
under test").

WHAT IT MEASURES, from delivered pixels only:

  1. **The plate.** A flood fill from the frame border tags everything OUTSIDE
     the drawing; the plate is the complement, minus pure background inside it.
     Nothing is read from a producer's plate polygon — this gate must work on a
     PDF page it has no model for.
  2. **Ink.** Any pixel that is neither the page background nor a pale zone wash:
     line-work and furniture. Washes are excluded deliberately — a coloured floor
     with nothing on it is exactly the dead space being measured.
  3. **Dead space.** The fraction of plate pixels whose distance to the nearest
     ink pixel exceeds `radius` metres. A person standing there is more than
     `radius` metres from any desk, wall or room: that floor is doing nothing.

`radius` defaults to 3.0 m — a bit over two desk pitches, so an ordinary aisle
never counts and a genuinely empty wing always does.

WHY THIS IS UNTRUSTED
=====================

The plate segmentation does not find the building, and the arithmetic says so:

    plate_px x m_per_px^2  =  1597 m2
    the plate polygon      =   930 m2   (Editor.layout_diag, core state)
    the wall bounding box  =  1595 m2

**It was measuring the bounding box.** The editor paints a white rectangle over
the wall bbox under the plan, the flood fill halted at that colour change, and
so two thirds of the "dead space" it reported was floor OUTSIDE the building.
Every number this script produced before 2026-08-07 is a fraction of the wrong
denominator:

    reference page 3   11.1%      |  DSource F1, spread   19.0%
    DSource F1, pre    19.4%      |  DSource F1, F1a      19.0%

Those are retracted. They are recorded here so the retraction is legible, not
because they mean anything.

Flooding on INK instead of on background colour was the obvious fix and it is
also wrong: the plate boundary is an anti-aliased ~1 px double line at fit zoom,
the flood leaks through it, and the same plan then measures **0.0% dead** at both
fit and 2x. Three versions, three answers — 19.0%, an aborted run, 0.0% — on one
unchanged drawing. Per `CLAUDE.md`: when repeat measurement disagrees, the
instrument IS the finding; fix it before quoting any of its numbers.

WHAT THE REPLACEMENT LOOKS LIKE
-------------------------------

The two subjects need different derivations, and pretending one code path serves
both is what produced this:

  * **Our plans** have a document. Derive the plate from `Editor::plate()` and the
    programme from component footprints and zone rects, then run the distance
    transform in world metres. That is core state, which
    `.claude/rules/gate-independence.md` explicitly permits, and no segmentation
    is involved at all.
  * **The reference** has no document, so it stays a pixel measurement — but its
    plate must come from the page's stated floor area rather than from a flood
    fill, which removes the failing step rather than tuning it.

`--expect-area` is already wired and is a self-check, not an input: it changes no
number, it refuses to report one taken over the wrong region. Any replacement
keeps it and asserts against core state.

RATCHET is retained only so a future version has a slot to fill. It gates nothing
today because nothing here is trustworthy enough to gate on.
"""

import argparse
import sys
from collections import deque

import numpy as np

#: Today's measurement plus margin. A RATCHET, not the goal — see the module
#: docstring. It exists so the gap cannot widen while the remaining mechanisms
#: are fixed; the target is the reference's 11.1%.
RATCHET = 0.20


def load_png(path):
    from PIL import Image

    return np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)


def load_pdf_page(path, page_no, zoom=3.0):
    import fitz
    from PIL import Image
    import io

    doc = fitz.open(path)
    pix = doc[page_no - 1].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    return np.asarray(img, dtype=np.int16), pix


def outside_mask(rgb, ink):
    """Everything reachable from the frame border without crossing INK.

    **The stopping condition is ink, not "the background colour", and that was a
    real defect.** The first version flooded across pixels near the border's own
    colour, so it halted at any colour change — including the editor's white
    bounding-box rectangle, which is painted under the plan and is NOT the
    building. Checked by arithmetic: `plate_px × m_per_px²` came to **1597 m²**
    against a plate whose polygon is **930 m²** and whose wall bounding box is
    **1594.9 m²**. It was measuring the box. Two thirds of the "dead space" it
    reported was floor outside the building.

    Ink is the only thing a drawing uses to say "the building stops here", and it
    is the one classification this instrument already owns, so the flood uses it.
    """
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    near_bg = ~ink
    out = np.zeros((h, w), dtype=bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near_bg[y, x] and not out[y, x]:
                out[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near_bg[y, x] and not out[y, x]:
                out[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and near_bg[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                q.append((ny, nx))
    return out, bg


#: How far below the page background a pixel must sit to count as ink.
#:
#: **Luminance only, and the chroma clause was REMOVED because the palette moved
#: under it.** The first version also counted "strongly coloured" pixels
#: (chroma > 60) as ink, which was true of line-work and false of the washes —
#: until the washes were corrected to the reference's saturation band and their
#: chroma crossed 62. Ink jumped 59 438 -> 220 545 px on an unchanged drawing:
#: the instrument had started counting the floor as the thing standing on it.
#:
#: A threshold a palette can cross is calibrated on the population under test
#: (`.claude/rules/gate-independence.md`). Luminance is not: architectural
#: line-work is DARK by convention in both the reference and here (our furniture
#: stroke is L 37, the darkest wash is L 83), and every programme wash in the
#: reference's own band (L 80-92) sits far above this line. 55/255 falls in the
#: gap between those two populations, not near either.
INK_LUMA_BELOW_BG = 55


def ink_mask(rgb, bg):
    """Line-work and furniture outlines: markedly darker than the page.

    A zone wash is NOT ink — it is floor with a colour on it, and counting it
    would let a plan hide an empty wing under a big flat fill.
    """
    lum = rgb.mean(axis=2)
    bg_lum = float(np.mean(bg))
    return lum < bg_lum - INK_LUMA_BELOW_BG


def distance_to_ink(ink):
    """Chamfer distance in pixels — two passes, 3/4 weights."""
    BIG = 1 << 24
    d = np.where(ink, 0, BIG).astype(np.int32)
    h, w = d.shape
    for y in range(h):
        row = d[y]
        if y > 0:
            prev = d[y - 1]
            np.minimum(row, prev + 3, out=row)
            np.minimum(row[1:], prev[:-1] + 4, out=row[1:])
            np.minimum(row[:-1], prev[1:] + 4, out=row[:-1])
        for x in range(1, w):
            if row[x - 1] + 3 < row[x]:
                row[x] = row[x - 1] + 3
    for y in range(h - 1, -1, -1):
        row = d[y]
        if y < h - 1:
            nxt = d[y + 1]
            np.minimum(row, nxt + 3, out=row)
            np.minimum(row[1:], nxt[:-1] + 4, out=row[1:])
            np.minimum(row[:-1], nxt[1:] + 4, out=row[:-1])
        for x in range(w - 2, -1, -1):
            if row[x + 1] + 3 < row[x]:
                row[x] = row[x + 1] + 3
    return d / 3.0


def measure(rgb, m_per_px, radius_m, dump=None, expect_area=None):
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    ink_all = ink_mask(rgb, bg)
    if ink_all.sum() < 100:
        raise SystemExit("under 100 ink px — the instrument is the finding, not the plan")
    out, _ = outside_mask(rgb, ink_all)
    plate = ~out & ~ink_all
    if plate.sum() < 1000:
        raise SystemExit("plate is under 1000 px — the flood fill found no drawing")
    ink = ink_all & ~out
    if expect_area is not None:
        got = plate.sum() * m_per_px * m_per_px
        if abs(got - expect_area) > 0.25 * expect_area:
            raise SystemExit(
                f"plate measures {got:.0f} m² against an expected {expect_area:.0f} m² — "
                "the flood fill is not finding the building, and every number below "
                "would be a fraction of the wrong denominator"
            )
    dist_px = distance_to_ink(ink)
    dist_m = dist_px * m_per_px
    dead = plate & (dist_m > radius_m)
    if dump:
        # WHERE, not just how much. A fraction cannot tell a ring of thin
        # boundary ribbons from one large empty wing, and those need different
        # fixes in different files.
        from PIL import Image

        out = rgb.astype(np.uint8).copy()
        out[dead] = (np.array([255, 60, 60]) * 0.55 + out[dead] * 0.45).astype(np.uint8)
        Image.fromarray(out).save(dump)
        print(f"dead-space map -> {dump}")
    return {
        "plate_px": int(plate.sum()),
        "ink_px": int(ink.sum()),
        "dead_px": int(dead.sum()),
        "dead_frac": float(dead.sum()) / float(plate.sum()),
        "m_per_px": m_per_px,
        "radius_m": radius_m,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--png")
    ap.add_argument("--pdf")
    ap.add_argument("--page", type=int, default=3)
    ap.add_argument("--zoom", type=float, default=3.0)
    ap.add_argument("--m-per-px", type=float)
    ap.add_argument("--radius", type=float, default=3.0)
    ap.add_argument("--max-dead", type=float, help="fail above this dead fraction")
    ap.add_argument("--dump", help="write a PNG showing WHERE the dead space is")
    ap.add_argument(
        "--expect-area",
        type=float,
        help="known plate area (m²); the run aborts if the flood fill disagrees by >25%%. "
        "This is a SELF-CHECK on the instrument, not an input to the measurement — "
        "it changes no number, it only refuses to report one taken over the wrong region.",
    )
    a = ap.parse_args()

    if a.pdf:
        rgb, _ = load_pdf_page(a.pdf, a.page, a.zoom)
        # The reference's own scale: 1 pt = 10/32.5 × 304.8 mm (the measured
        # anchor is the 7.2 × 14.4 pt bench desk position = 675 × 1350 mm).
        mm_per_pt = 10.0 / 32.5 * 304.8
        m_per_px = (mm_per_pt / 1000.0) / a.zoom
    elif a.png:
        rgb = load_png(a.png)
        if not a.m_per_px:
            raise SystemExit("--m-per-px is required with --png")
        m_per_px = a.m_per_px
    else:
        raise SystemExit("give --png or --pdf")

    r = measure(rgb, m_per_px, a.radius, dump=a.dump, expect_area=a.expect_area)
    print(
        f"plate {r['plate_px']} px · ink {r['ink_px']} px · "
        f"dead (>{r['radius_m']} m from ink) {r['dead_px']} px = {r['dead_frac']*100:.1f}%"
    )
    if a.max_dead is not None and r["dead_frac"] > a.max_dead:
        print(f"DEADSPACE FAIL: {r['dead_frac']*100:.1f}% > {a.max_dead*100:.1f}%")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
