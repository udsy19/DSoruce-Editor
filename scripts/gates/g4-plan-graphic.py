#!/usr/bin/env python3
"""G4 — Plan graphic.

The master plan PNG is the single most visible page of the deliverable. It must
carry the qbiq colour language exactly, and it must be deterministic.

  * canvas dimensions within spec (default 1040x780, tolerance +/-2%)
  * >2% of the PLATE area painted in the pink circulation band
    (reference measures 12.86% of its opaque bbox)
  * drywall-yellow pixels present
  * glass-cyan pixels present whenever the plan contains glass
  * THE FACADE IS DRAWN AS THE MODEL BILLS IT: perimeter-window pixels present
    exactly when ground-truth `walls` carries perimeter-window length, absent
    when it does not, and their share of the drawn perimeter agrees with the
    per-type LENGTHS the workbook bills (see PERIMETER_SHARE_TOL)
  * the workbook's Plan-sheet legend chip fills equal palette.json EXACTLY
  * determinism: two independent renders of the same input are byte-identical

WHY THE FACADE IS CONDITIONED ON THE MODEL (defect D5, reports/defects-1.md;
still open as F7 in defects-3.md). The plan is the drawing of a building whose
facade is 123.20 m of glazing — and the Judge recoloured all 11,676
perimeter-window pixels to perimeter wall in BOTH plan.png and plan.repeat.png
and this gate passed 14/14, because it only ever asserted that drywall and glass
were *present somewhere*. The fix conditions on the MODEL (`walls` in
out/ground-truth.json, which is what the workbook's General!L13 bills), never on
a producer flag: a producer that drops a flag switches the check off, which is
the exact D1/E1 failure this mission hit twice.

Area ratios normalise against the OPAQUE BOUNDING BOX, not the canvas: the
reference plate fills only the lower band of its 1040x780 canvas.

Usage: g4-plan-graphic.py [--plan out/plan.png] [--plan2 out/plan.repeat.png]
                          [--workbook out/quantity-takeoff.xlsx]
                          [--ground-truth <plan's own ground-truth.json>]
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


# The two wall types that make up the building's PERIMETER. Every metre of the
# facade is one or the other, so their pixel shares and their billed length
# shares describe the same line and must agree.
#   measured  ours  11,676 px / 432 px  = 96.4% windows vs 123.20/128.00 m = 96.3%
#             dwg    4,265 px / 875 px  = 83.0% windows vs 134.68/170.25 m = 79.1%
# The tolerance is set at 0.15 — 3.8x the worst observed disagreement, and still
# 6x smaller than the 0.96 swing the Judge's window-deletion produces.
PERIMETER_TYPES = (("perimeter_windows", "Perimeter windows"),
                   ("perimeter_wall", "Perimeter wall"))
PERIMETER_SHARE_TOL = 0.15


def near(a, b, tol):
    return all(abs(a[i] - b[i]) <= tol for i in range(3))


def body(g: G.Gate):
    planp = G.arg("--plan", G.DEFAULTS["plan"])
    plan2p = G.arg("--plan2", G.DEFAULTS["plan_repeat"])
    wbp = G.arg("--workbook", G.DEFAULTS["workbook"])
    # The model this plan draws. Defaults to the ground truth SITTING NEXT TO THE
    # PLAN, so `--plan out/cases/dwg/plan.png` is graded against the dwg case's
    # own model and never against out/'s (G9 runs every case through this gate).
    gtp = G.arg("--ground-truth", os.path.join(os.path.dirname(os.path.abspath(planp)),
                                               "ground-truth.json"))
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
    pwin = G.hex_to_rgb(pal["perimeter_windows"])
    pwall = G.hex_to_rgb(pal["perimeter_wall"])

    n_circ = n_dry = n_glass = n_core = n_pwin = n_pwall = 0
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
            elif near(c, pwin, 8):
                n_pwin += 1
            elif near(c, pwall, 8):
                n_pwall += 1

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
           f"glass={n_glass} core={n_core} perimeter_windows={n_pwin} "
           f"perimeter_wall={n_pwall}")

    # ---- the facade: drawn as the MODEL bills it ----------------------------
    gt = G.load_json(gtp, "ground truth (the model this plan draws)")
    walls = gt.get("walls") or {}
    if not g.check(bool(walls),
                   f"{os.path.relpath(gtp)} carries no `walls` block, so there is no billed "
                   "wall length to check the plan's facade against — the plan graphic would "
                   "be unfalsifiable"):
        return
    lengths = {k: float((walls.get(name) or {}).get("lengthM") or 0.0)
               for k, name in PERIMETER_TYPES}
    drawn = {"perimeter_windows": n_pwin, "perimeter_wall": n_pwall}
    for key, name in PERIMETER_TYPES:
        if lengths[key] > 0:
            g.check(drawn[key] > 0,
                    f"the model bills {lengths[key]:.2f} m of '{name}' and the plan draws "
                    f"NONE of it: 0 px of {pal[key]} inside the plate. This page is the "
                    "drawing of that facade — billing a wall type the drawing does not "
                    "contain is the D4/D5 contradiction on the deliverable's most visible "
                    "page")
        else:
            g.check(drawn[key] == 0,
                    f"the model bills no '{name}' at all, yet the plan draws {drawn[key]} px "
                    f"of {pal[key]}: the legend colour and the takeoff disagree about whether "
                    "this wall type exists")

    total_m = sum(lengths.values())
    total_px = n_pwin + n_pwall
    if total_m > 0 and total_px > 0:
        want = lengths["perimeter_windows"] / total_m
        got = n_pwin / float(total_px)
        g.check(abs(got - want) <= PERIMETER_SHARE_TOL,
                f"the plan draws {got * 100:.1f}% of its perimeter as windows "
                f"({n_pwin} of {total_px} px) but the model bills "
                f"{want * 100:.1f}% ({lengths['perimeter_windows']:.2f} of {total_m:.2f} m) — "
                f"outside +-{PERIMETER_SHARE_TOL * 100:.0f} pts. The facade in the drawing is "
                "not the facade in the takeoff")
        g.note(f"facade: windows {got * 100:.1f}% of drawn perimeter px vs "
               f"{want * 100:.1f}% of billed perimeter m")

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
