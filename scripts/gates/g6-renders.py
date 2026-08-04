#!/usr/bin/env python3
"""G6 — Per-room renders.

Four hero stills at qbiq's fidelity, and each one must actually show the floor
material the Inventory sheet claims for that room — otherwise the render pack
and the takeoff are telling the client two different stories.

  * four stills exist, each >=1920x1080
  * the sampled floor band's hue/sat/luma sits inside the palette.json envelope
    for that room's Inventory floor material
  * mean luminance inside palette.json renderMood.meanLuminanceBand and stddev
    above minStdDev (rejects black, blown, and flat/empty frames)

Room -> render -> floor material mapping comes from ground-truth.json `renders`
(see docs/reference/qbiq/spec/ground-truth.schema.json). Falls back to the four
reference room names when ground truth omits the block.

Usage: g6-renders.py [--renders out/renders] [--ground-truth out/ground-truth.json]
                     [--min-width 1920] [--min-height 1080] [--floor-rect 0.05,0.80,0.95,0.98]
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402

FALLBACK = ["Reception", "Open_space", "Work_stations", "Conference_room"]

# Inventory floor-material name -> palette.json materials key.
MATERIAL_KEY = {
    "parquet herringbone - dark": "herringbone_parquet",
    "carpet light gray": "light_gray_carpet",
}


def body(g: G.Gate):
    rdir = G.arg("--renders", G.DEFAULTS["renders"])
    gtp = G.arg("--ground-truth", G.DEFAULTS["ground_truth"])
    min_w = int(G.arg("--min-width", "1920"))
    min_h = int(G.arg("--min-height", "1080"))
    fr = [float(x) for x in G.arg("--floor-rect", "0.05,0.80,0.95,0.98").split(",")]

    pal = G.palette()
    mats = pal["materials"]
    mood = pal["renderMood"]
    lo, hi = mood["meanLuminanceBand"]
    min_sd = mood.get("minStdDev", 0.06)

    G.require_dir(rdir, "renders directory")

    entries = []
    if os.path.isfile(gtp):
        gt = G.load_json(gtp, "ground truth")
        for e in gt.get("renders", []) or []:
            entries.append({
                "name": e.get("name") or os.path.splitext(os.path.basename(e.get("file", "")))[0],
                "file": e.get("file"),
                "floorMaterial": e.get("floorMaterial"),
                "floorRect": e.get("floorRect") or fr,
            })
    if not entries:
        g.note("ground-truth 'renders' block absent — falling back to the four "
               "reference room names with no material cross-check")
        entries = [{"name": n, "file": f"{n}.png", "floorMaterial": None, "floorRect": fr}
                   for n in FALLBACK]

    g.check(len(entries) >= 4, f"only {len(entries)} render(s) declared, need 4")

    for e in entries:
        name = e["name"]
        p = e["file"] or f"{name}.png"
        if not os.path.isabs(p):
            cand = os.path.join(rdir, os.path.basename(p))
            p = cand if os.path.isfile(cand) else os.path.join(G.REPO, p)
        if not os.path.isfile(p):
            raise G.Missing(f"render '{name}' at {p}")

        im = G.open_rgb(p, f"render {name}")
        W, H = im.size
        g.check(W >= min_w and H >= min_h,
                f"render '{name}' is {W}x{H}, need >={min_w}x{min_h}")

        mean, sd = G.mean_luma(im)
        g.check(lo <= mean <= hi,
                f"render '{name}' mean luminance {mean:.3f} outside [{lo}, {hi}] "
                "(black / blown / empty frame?)")
        g.check(sd >= min_sd,
                f"render '{name}' stddev {sd:.3f} < {min_sd} — the frame is flat, "
                "probably an empty or single-colour image")

        fm = e.get("floorMaterial")
        if not fm:
            g.note(f"render '{name}': no floorMaterial in ground truth, hue check skipped")
            continue
        key = MATERIAL_KEY.get(str(fm).strip().lower())
        if key is None or key not in mats:
            g.fail(f"render '{name}': floor material {fm!r} maps to no palette.json "
                   f"materials key (known: {sorted(MATERIAL_KEY)})")
            continue
        m = mats[key]
        rgb = G.median_rgb(im, e.get("floorRect") or fr)
        hue, lum, sat = G.rgb_to_hls(rgb)
        hx = f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"
        h0, h1 = m["hueRange"]
        s0, s1 = m["satRange"]
        l0, l1 = m["lumRange"]
        ok = (h0 <= hue <= h1) and (s0 <= sat <= s1) and (l0 <= lum <= l1)
        g.check(ok,
                f"render '{name}' floor sample {hx} (H={hue:.1f} S={sat:.2f} L={lum:.2f}) "
                f"does not match Inventory floor material {fm!r} -> palette '{key}' "
                f"(H {h0}-{h1}, S {s0}-{s1}, L {l0}-{l1})")
        g.note(f"{name}: floor {hx} H={hue:.1f} S={sat:.2f} L={lum:.2f} vs {key}; "
               f"luma {mean:.3f}/sd {sd:.3f}")


G.run_gate("G6", body)
