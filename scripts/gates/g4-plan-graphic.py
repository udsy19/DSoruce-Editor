#!/usr/bin/env python3
"""G4 — Plan graphic.

The master plan PNG is the single most visible page of the deliverable. It must
carry the qbiq colour language exactly, and it must be deterministic.

  * canvas dimensions within spec (default 1040x780, tolerance +/-2%)
  * >2% of the PLATE area painted in the pink circulation band
    (reference measures 12.86% of its opaque bbox)
  * drywall-yellow pixels present
  * glass-cyan pixels present whenever the plan contains glass
  * the workbook's Plan-sheet legend chip fills equal palette.json EXACTLY
  * determinism: two independent renders of the same input are byte-identical

Area ratios normalise against the OPAQUE BOUNDING BOX, not the canvas: the
reference plate fills only the lower band of its 1040x780 canvas.

Usage: g4-plan-graphic.py [--plan out/plan.png] [--plan2 out/plan.repeat.png]
                          [--workbook out/quantity-takeoff.xlsx]
                          [--width 1040] [--height 780] [--dim-tol-pct 2]
                          [--min-circulation-pct 2] [--no-glass]
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402

LEGEND_ROWS = [  # (chip cell, palette.plan key, label)
    ("Q5", "drywall", "Drywall"),
    ("Q6", "half_drywall", "Half Drywall"),
    ("Q7", "glass", "Glass"),
    ("Q8", "core", "Core"),
    ("Q9", "perimeter_windows", "Perimeter windows"),
    ("Q10", "perimeter_wall", "Perimeter wall"),
    ("Q11", "door_swing", "Door_length"),
]


def near(a, b, tol):
    return all(abs(a[i] - b[i]) <= tol for i in range(3))


def body(g: G.Gate):
    planp = G.arg("--plan", G.DEFAULTS["plan"])
    plan2p = G.arg("--plan2", G.DEFAULTS["plan_repeat"])
    wbp = G.arg("--workbook", G.DEFAULTS["workbook"])
    want_w = int(G.arg("--width", "1040"))
    want_h = int(G.arg("--height", "780"))
    dim_tol = float(G.arg("--dim-tol-pct", "2")) / 100.0
    min_circ = float(G.arg("--min-circulation-pct", "2"))
    expect_glass = not G.has_flag("--no-glass")

    pal = G.palette()["plan"]
    im = G.open_rgb(planp, "plan png")

    W, H = im.size
    g.check(abs(W - want_w) <= want_w * dim_tol,
            f"plan width {W} outside {want_w} +/-{dim_tol*100:.0f}%")
    g.check(abs(H - want_h) <= want_h * dim_tol,
            f"plan height {H} outside {want_h} +/-{dim_tol*100:.0f}%")

    rgba = im.convert("RGBA")
    px = rgba.load()

    # Plate = opaque bounding box if the image has real transparency, else canvas.
    alpha = rgba.split()[-1]
    bbox = alpha.getbbox() if alpha.getextrema()[0] < 255 else (0, 0, W, H)
    if not bbox:
        g.fail("plan png is fully transparent")
        return
    bx0, by0, bx1, by1 = bbox
    plate_area = (bx1 - bx0) * (by1 - by0)
    g.check(plate_area > 0, "plan plate bounding box is empty")

    # Composite over white so alpha-blended fills (the circulation wash) are
    # comparable with the flat legend hexes.
    from PIL import Image
    flat = Image.new("RGB", (W, H), (255, 255, 255))
    flat.paste(rgba, mask=alpha)
    fpx = flat.load()

    circ = G.hex_to_rgb(pal["circulation"])
    dry = G.hex_to_rgb(pal["drywall"])
    glass = G.hex_to_rgb(pal["glass"])
    core = G.hex_to_rgb(pal["core"])

    n_circ = n_dry = n_glass = n_core = 0
    for y in range(by0, by1):
        for x in range(bx0, bx1):
            c = fpx[x, y]
            if near(c, circ, 12):
                n_circ += 1
            elif near(c, dry, 8):
                n_dry += 1
            elif near(c, glass, 8):
                n_glass += 1
            elif near(c, core, 8):
                n_core += 1

    pct_circ = 100.0 * n_circ / plate_area
    g.check(pct_circ > min_circ,
            f"circulation band covers {pct_circ:.2f}% of the plate "
            f"({n_circ}px of {plate_area}), need >{min_circ}% — "
            f"expected hue {pal['circulation']} (reference: 12.86%)")
    g.check(n_dry > 0, f"no drywall pixels ({pal['drywall']}) in the plan")
    if expect_glass:
        g.check(n_glass > 0,
                f"no glass pixels ({pal['glass']}) in the plan "
                "(pass --no-glass if this plan genuinely has no glazed partitions)")
    g.note(f"plate {bx1-bx0}x{by1-by0} circ={pct_circ:.2f}% drywall={n_dry} "
           f"glass={n_glass} core={n_core}")

    # ---- legend chips must equal palette.json exactly -----------------------
    G.require_file(wbp, "workbook")
    wb = G.load_wb(wbp)
    if "Plan" not in wb.sheetnames:
        g.fail("workbook has no 'Plan' sheet to read legend chips from")
    else:
        ws = wb["Plan"]
        for cell, key, label in LEGEND_ROWS:
            want = pal.get(key)
            got = G.fill_hex(ws[cell])
            g.check(got is not None and want is not None and got.upper() == want.upper(),
                    f"legend chip {cell} ('{label}') fill is {got!r}, "
                    f"palette.json plan.{key} is {want!r} — must match exactly")

    # ---- determinism --------------------------------------------------------
    if not os.path.isfile(plan2p):
        raise G.Missing(
            f"determinism twin {plan2p} — the generator must render the same "
            "seed twice and write the second render there")
    h1 = hashlib.sha256(open(planp, "rb").read()).hexdigest()
    h2 = hashlib.sha256(open(plan2p, "rb").read()).hexdigest()
    g.check(h1 == h2,
            f"plan render is NOT deterministic: {os.path.basename(planp)} sha {h1[:12]} "
            f"!= {os.path.basename(plan2p)} sha {h2[:12]}")


G.run_gate("G4", body)
