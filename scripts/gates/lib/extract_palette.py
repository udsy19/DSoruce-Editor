#!/usr/bin/env python3
"""Re-measure every number claimed in docs/reference/qbiq/spec/palette.json.

Prints the measurements and, with --verify, exits non-zero if the plan hexes in
palette.json no longer match the reference plan PNG's actual pixels. palette.json
itself is curated (names, usedFor, ranges) and is NOT overwritten.

    python3 scripts/gates/lib/extract_palette.py            # report
    python3 scripts/gates/lib/extract_palette.py --verify   # report + assert
"""
import json
import os
import statistics
import sys
from collections import Counter

from PIL import Image, ImageStat

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SPEC = os.path.join(ROOT, "docs/reference/qbiq/spec")
PLAN_PNG = os.path.join(SPEC, "media/image1.png")
RENDERS = os.path.join(ROOT, "docs/reference/qbiq/media")

# name -> (render, fractional rect, mode)
PATCHES = {
    "herringbone_parquet": [
        ("Reception", (0.72, 0.74, 0.92, 0.88), "med"),
        ("Open_space", (0.80, 0.86, 0.95, 0.98), "med"),
        ("Work_stations", (0.72, 0.80, 0.88, 0.95), "med"),
        ("Conference_room", (0.60, 0.88, 0.75, 0.98), "med"),
    ],
    "light_gray_carpet": [
        ("Conference_room", (0.14, 0.84, 0.42, 0.94), "med"),
        ("Reception", (0.05, 0.68, 0.16, 0.75), "med"),
    ],
    "sage_green_feature_wall": [
        ("Reception", (0.60, 0.48, 0.67, 0.62), "med"),
        ("Conference_room", (0.94, 0.25, 0.99, 0.55), "med"),
        ("Open_space", (0.60, 0.72, 0.72, 0.80), "med"),
    ],
    "perforated_bronze_screen": [("Work_stations", (0.42, 0.22, 0.58, 0.32), "med")],
    "white_oak_furniture": [
        ("Reception", (0.21, 0.30, 0.27, 0.60), "med"),
        ("Conference_room", (0.62, 0.30, 0.70, 0.60), "med"),
        ("Open_space", (0.16, 0.60, 0.34, 0.66), "med"),
    ],
    "black_ring_luminaire": [
        ("Reception", (0.24, 0.09, 0.48, 0.20), "p05"),
        ("Open_space", (0.32, 0.02, 0.55, 0.17), "p05"),
    ],
    "ceiling_white": [("Reception", (0.62, 0.03, 0.76, 0.09), "med")],
    "upholstery_charcoal": [("Reception", (0.24, 0.74, 0.34, 0.88), "med")],
    "glass_partition": [("Conference_room", (0.50, 0.15, 0.52, 0.55), "med")],
}


def sample(render, rect, mode):
    im = Image.open(os.path.join(RENDERS, f"{render}.png")).convert("RGB")
    W, H = im.size
    cr = im.crop((int(rect[0] * W), int(rect[1] * H), int(rect[2] * W), int(rect[3] * H)))
    cr.thumbnail((300, 300))
    f = getattr(cr, "get_flattened_data", None)
    d = list(f()) if callable(f) else list(cr.getdata())
    if mode == "p05":
        d = sorted(d, key=lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2])
        d = d[: max(1, len(d) // 20)]
    return tuple(int(statistics.median([p[i] for p in d])) for i in range(3))


def hexs(rgb):
    return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


def hls(rgb):
    import colorsys
    h, l, s = colorsys.rgb_to_hls(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
    return h * 360, l, s


def main():
    verify = "--verify" in sys.argv
    pal = json.load(open(os.path.join(SPEC, "palette.json")))
    problems = []

    # ---- plan pixels ------------------------------------------------------
    im = Image.open(PLAN_PNG)
    W, H = im.size
    px = im.load()
    alpha = im.split()[-1]
    bbox = alpha.getbbox()
    plate = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    print(f"PLAN {os.path.basename(PLAN_PNG)} {W}x{H}  opaque bbox {bbox} "
          f"= {bbox[2]-bbox[0]}x{bbox[3]-bbox[1]} ({plate:,} px)")

    exact = Counter()
    circ = 0
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if (r, g, b) == (255, 0, 0):
                circ += 1
            if a == 255:
                exact[(r, g, b)] += 1

    print(f"\n  circulation rgba(255,0,0,*)      {circ:>8,}  {100*circ/plate:6.2f}% of plate")
    for key in ("drywall", "half_drywall", "glass", "core", "perimeter_windows",
                "perimeter_wall", "door_swing", "room_label_text"):
        want = pal["plan"].get(key)
        if not want:
            continue
        rgb = tuple(int(want.lstrip("#")[i:i+2], 16) for i in (0, 2, 4))
        n = exact.get(rgb, 0)
        flag = "" if n or key == "half_drywall" else "   <-- NOT PRESENT"
        print(f"  {key:32s} {n:>8,}  {want}{flag}")
        if verify and n == 0 and key not in ("half_drywall",):
            problems.append(f"palette.plan.{key}={want} matches zero pixels in the plan PNG")

    print("\n  top opaque colours actually present:")
    for rgb, n in exact.most_common(10):
        print(f"    {hexs(rgb)}  {n:>8,}")

    # ---- material patches -------------------------------------------------
    print("\nMATERIALS (median of targeted patches; p05 = 5th-percentile luminance)")
    for name, patches in PATCHES.items():
        print(f"\n  {name}")
        m = pal["materials"].get(name, {})
        for render, rect, mode in patches:
            rgb = sample(render, rect, mode)
            h, l, s = hls(rgb)
            inband = ""
            if "hueRange" in m:
                h0, h1 = m["hueRange"]; s0, s1 = m["satRange"]; l0, l1 = m["lumRange"]
                ok = h0 <= h <= h1 and s0 <= s <= s1 and l0 <= l <= l1
                inband = "  IN-BAND" if ok else "  OUT-OF-BAND"
                if verify and not ok:
                    problems.append(
                        f"{name} sample from {render} {hexs(rgb)} (H={h:.1f} S={s:.2f} "
                        f"L={l:.2f}) is outside palette.json's declared range")
            print(f"    {render:18s} {hexs(rgb)}  H={h:5.1f} S={s:.2f} L={l:.2f}{inband}")
        if "hex" in m:
            print(f"    declared: {m['hex']}  hue{m.get('hueRange')} sat{m.get('satRange')} lum{m.get('lumRange')}")

    # ---- render mood ------------------------------------------------------
    print("\nRENDER MOOD (grayscale mean/255 after thumbnail 800)")
    lo, hi = pal["renderMood"]["meanLuminanceBand"]
    for n in ("Reception", "Open_space", "Work_stations", "Conference_room"):
        g = Image.open(os.path.join(RENDERS, f"{n}.png")).convert("L")
        g.thumbnail((800, 800))
        st = ImageStat.Stat(g)
        mean, sd = st.mean[0] / 255, st.stddev[0] / 255
        declared = pal["renderMood"]["referenceMeanLuminance"].get(n)
        print(f"  {n:18s} mean={mean:.4f} sd={sd:.4f}  declared={declared}  "
              f"band[{lo},{hi}] {'ok' if lo <= mean <= hi else 'OUT'}")
        if verify and declared is not None and abs(mean - declared) > 0.002:
            problems.append(f"renderMood.referenceMeanLuminance.{n} declared {declared}, measured {mean:.4f}")

    if verify:
        print()
        if problems:
            for p in problems:
                print("PALETTE DRIFT:", p)
            sys.exit(1)
        print("palette.json verified against the reference artifacts.")


if __name__ == "__main__":
    main()
