#!/usr/bin/env python3
"""DEAD SPACE: how much of a floor plan's plate is far from anything drawn on it.

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

MEASURED, both subjects, radius 3.0 m:

  qbiq reference report page 3          **11.1%** dead   <- the target
  DSource F1, before the spread         19.4%
  DSource F1, after the spread          19.0%

The spread moved it 0.4 points, and that number is the most useful thing this
instrument has produced. It says the dominant wing's field was NOT what the dead
space was made of: the plan's empty floor is the 122 m2 of plate that no region
covers plus two wings whose desk fields are 3.5 m and 2.0 m deep after their room
bands. Fixing the distribution inside a field cannot reach any of that, and
without the measurement the visibly better capture would have been reported as
progress on row 8.

`RATCHET` below is today's number plus a small margin, not the target. It exists
so the gap cannot widen while the remaining mechanisms are fixed; the target is
the reference figure above and is recorded in `research/rubric-q3.md`.
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


def outside_mask(rgb, bg_tol=12):
    """Everything reachable from the border without crossing ink or wash."""
    h, w, _ = rgb.shape
    # Page background = the modal border colour.
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    near_bg = (np.abs(rgb - bg).max(axis=2) <= bg_tol)
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


def ink_mask(rgb, bg, sat_max=60, val_min=None):
    """Line-work and furniture: darker than the background, or strongly coloured.

    A pale zone wash is NOT ink — it is floor with a colour on it, and counting
    it would let a plan hide an empty wing under a big flat fill.
    """
    mx = rgb.max(axis=2).astype(np.int16)
    mn = rgb.min(axis=2).astype(np.int16)
    chroma = mx - mn
    lum = rgb.mean(axis=2)
    bg_lum = float(np.mean(bg))
    dark = lum < bg_lum - 40
    # Saturated marks (a coloured tag, a red wall run) count as ink; a pale wash
    # has low chroma AND high luminance, so it fails both tests.
    vivid = (chroma > sat_max) & (lum < bg_lum - 10)
    return dark | vivid


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


def measure(rgb, m_per_px, radius_m):
    out, bg = outside_mask(rgb)
    plate = ~out
    if plate.sum() < 1000:
        raise SystemExit("plate is under 1000 px — the flood fill found no drawing")
    ink = ink_mask(rgb, bg) & plate
    if ink.sum() < 100:
        raise SystemExit("under 100 ink px — the instrument is the finding, not the plan")
    dist_px = distance_to_ink(ink)
    dist_m = dist_px * m_per_px
    dead = plate & (dist_m > radius_m)
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

    r = measure(rgb, m_per_px, a.radius)
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
