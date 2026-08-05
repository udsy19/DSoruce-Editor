#!/usr/bin/env python3
"""G6 — Per-room renders.

Four hero stills at qbiq's fidelity, and each one must actually show the floor
material the Inventory sheet claims for that room — otherwise the render pack
and the takeoff are telling the client two different stories.

  * four stills exist, each >=1920x1080, and they are four DIFFERENT PICTURES
    (pairwise dHash distance) — a pack cannot ship one room's photograph twice
  * mean luminance inside palette.json renderMood.meanLuminanceBand and stddev
    above minStdDev (rejects black, blown, and flat/empty frames)
  * EVERY still names the floor material of the room it photographs, and that
    name is the SAME string the workbook's Inventory `Floor Material` column
    carries (`ground-truth.rooms[].floorMaterial`, i.e. FINISH_SPEC/finishTypeFor)
  * THE GATE FINDS THE FLOOR ITSELF and measures it against that material's
    palette.json envelope. What it found must first be ENOUGH OF THE PICTURE to
    be a room floor — area and vertical coverage, both measured, both hard
    fails — and is then judged in three tiers it decides on its own:
      A  tamper      — every load-bearing surface on the ground plane must be
                       SOME material palette.json specifies      (every render)
      B  wrong floor — a still that shows none of its declared finish must not
                       be showing the other floor finish instead (every render)
      C  evidence    — the declared finish must be found on the ground plane at
                       >= EVIDENCE_MIN_AREA          (>= `--min-evidenced` rooms)
    Furniture standing on the floor is the one legitimate reason a room fails C
    — that is what the >=3 bar exists for — and it cannot hide a repaint,
    because a repaint fails A and a substituted finish fails B.

WHY THE GATE LOCATES THE FLOOR (defects D1 and E1, reports/defects-{1,2}.md).
One root cause, three iterations: *the gate trusted metadata supplied by the
thing it was testing.*

  round 0  the producer chose WHETHER `floorMaterial` existed — omit it and the
           only render-to-model assertion switched itself off. Magenta-painted
           floors passed.
  round 1  `floorMaterial` was made mandatory, but the producer still chose
           WHERE the gate sampled, via `floorRect`. The Judge painted the bottom
           34% of all four stills magenta — destroying every visible floor — then
           searched the untouched upper frame for a rect that was legal under the
           gate's geometric rules and happened to land inside the material
           envelope. G6 certified 4/4 while sampling a slat wall, a ceiling
           junction and two walls.
  now      **`floorRect` is not read at all.** The gate segments the image and
           derives the ground plane from the pixels:

           bottom-anchored, gradient-limited connected components. Every seed is
           on the BOTTOM ROW of the frame — the one place an interior camera at
           eye height is always looking at the ground — and a component grows
           only across gentle shading (<= EDGE_TOL per channel between adjacent
           pixels), so it stops at a material boundary. Components below
           COMP_MIN_AREA are specks and are discarded.

           A surface that is not connected to the bottom edge of the frame can
           never be sampled, whatever the manifest says. That is what makes the
           Judge's exploit unrepeatable: paint the bottom of the frame and the
           only regions the gate can reach are the paint.

The producer may still publish `floorRect`/`floorRectPurity` for its own camera
search; the gate ignores both, and computes its own purity (matched ground /
total ground) from the image. A render whose true floor purity is 0 therefore
cannot be certified by declaring a rect — it has to actually show the floor.

Room -> render -> floor material mapping comes from ground-truth.json `renders`
(see docs/reference/qbiq/spec/ground-truth.schema.json). The block is MANDATORY:
dropping it would be the same self-disabling trick as dropping a field.

Usage: g6-renders.py [--renders out/renders] [--ground-truth out/ground-truth.json]
                     [--min-width 1920] [--min-height 1080] [--min-evidenced 3]
"""
import os
import statistics
import sys
from collections import deque

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402

# The mission's bar: the render<->takeoff cross-check must hold for at least this
# many rooms. Explicit and enforced, and the artifact has no say in WHICH rooms
# count — every render is measured, every miss is printed, and a miss still has
# to look like the declared material under shadow (see TOL_* below). Shrinking
# the pack therefore cannot quietly shrink the evidence.
MIN_EVIDENCED = 3

# How far outside its material's envelope a sample may sit and still be read as
# "the right finish, badly lit" rather than "a different material".
#
# Shadow is the one legitimate reason a render misses its envelope: the only
# floor a furnished meeting room leaves visible is the patch under the table, and
# an unlit carpet measures far darker than a lit one. Shadow costs LUMINANCE; it
# does not repaint the floor. So luminance may fall arbitrarily below the
# envelope, while HUE and SATURATION must still be recognisably the declared
# material — which no painted-over or wrong-material frame can be.
TOL_H, TOL_S, TOL_L_HIGH = 10.0, 0.10, 0.18

# --- the gate's own floor segmentation ---------------------------------------
# Working width. The stills are 3840x2160; segmenting at 384 px keeps the whole
# gate under a second and is far above the scale of any real floor patch.
SEG_WIDTH = 384
# Max per-channel step (0-255) between ADJACENT pixels for them to be the same
# surface. Shading across one floor is a gradient of a few levels per pixel; a
# material boundary is a step. Measured on the pack: every conclusion below is
# unchanged for EDGE_TOL anywhere in 6..12 and SEG_WIDTH in 320..480.
EDGE_TOL = 9
# The ground plane cannot reach the top of the frame: a camera at 1.6 m eye
# height in a room with a 2.7-3.0 m ceiling puts the horizon near mid-frame, so
# a region that has climbed above this has leaked onto a wall and is cut off.
SEG_Y_MIN = 0.45
# Hue and saturation are meaningless in crushed shadow and blown highlight, and
# palette.json is qbiq's REFERENCE palette, not an inventory of everything our
# renderer draws (monitor screens, for one, are outside it and measure L 0.12-
# 0.14). So tier A judges only surfaces inside this luminance band. A floor
# painted darker than the floor of the band is near-black and loses tier C
# anyway — and the whole-frame luminance/stddev checks above see it too.
TAMPER_LUM_BAND = (0.15, 0.93)
# Fraction of the frame below which a component is a speck, not a surface.
COMP_MIN_AREA = 0.004
# --- coverage: the gate must not certify a still from a strip of it -----------
# The segmentation reaches only what is connected to the bottom edge, so on its
# own it says nothing about the rest of the picture (defect F1, defects-3.md:69:
# rows 44-85% of every frame — 41% of the picture — repainted with the OTHER
# floor family, and G6 passed 43 checks while the ground it could still reach
# collapsed 27->12%). These two constants assert that what the gate measured is
# a plausible amount of the frame for an eye-height interior camera, so a still
# whose ground plane has been cut down to a strip is a FAIL, not a quiet note.
#
# Measured over 16 renders — the shipped pack plus three independently generated
# packs (seed 11, the imported 31-vertex DWG plate, the autonomous test-fit):
#   ground area   20.7 - 49.0 % of frame      (F1's forgery: 11.4 - 12.4 %)
#   band coverage 79.8 - 100  % of band rows  (F1's forgery: 26.9 %)
# Both bars sit in the gap, nearer the forgery than the worst real render.
GROUND_MIN_AREA = 0.15
# Of the frame rows BELOW the horizon clamp (SEG_Y_MIN..bottom — where an
# eye-height camera in a 2.7-3.0 m room is looking at the ground), this fraction
# must contain segmented ground. Area alone is not enough: a wide, short strip
# can be 15% of frame. This is the assertion that the ground plane runs UP the
# picture the way a real floor recedes, instead of stopping at a painted edge.
GROUND_BAND_COVERAGE = 0.60
#
# The alternative the defect report offered — sweep ABOVE the ground for large
# areas of the OTHER floor family — was implemented and MEASURED, and it is not
# usable even restricted to floor-family hues. On the shipped `Reception` (a
# parquet room) the largest contiguous non-ground surface in the lower band is
# 21.3% of frame at #AA9C88 (H=35 S=0.17 L=0.60), which sits strictly inside
# light_gray_carpet's envelope: the rule reds a good render. Measured across the
# four packs the false-positive runs 0.2-24.8% of frame, i.e. larger than the
# forgery it is meant to catch. The two families' envelopes simply overlap the
# lit-wall colours. So coverage, which needs no palette reasoning at all, is the
# whole of the fix. (A "the ground's top edge is suspiciously straight" test was
# measured too: modal-top-row share is 3-51% on real renders and 34-62% on the
# surviving forgery — not separable. Both rejections are reproducible from
# reports/P-1.md.)
# A ground surface at least this big is load-bearing: it has to be a material
# the design system actually specifies, and it has to not be the WRONG floor.
# ~1% of a 3840x2160 still is ~83,000 px.
SURFACE_MIN_AREA = 0.01
# Ground area that must sit strictly inside the DECLARED material's envelope for
# the render to COUNT as evidence. Measured on the pack: 5.1 / 32.1 / 35.1 %.
EVIDENCE_MIN_AREA = 0.02
# Four stills of four rooms must be four PICTURES. `cp Work_stations.png
# Conference_room.png` used to pass and RAISE the evidence count 3/4 -> 4/4
# (defect F2, defects-3.md:116), and it is producer-reachable: N-1 §3 records two
# rooms converging on literally the same camera before `avoidEyes` was added.
# Minimum pairwise dHash Hamming distance measured over the same 16 renders
# (24 pairs, 4 packs): 23. A byte copy scores 0. The bar sits at 10.
MIN_RENDER_HAMMING = 10


def palette_family(inventory_material: str) -> str:
    """Our Inventory floor name -> the palette.json material family it renders as.

    Mirrors `web/src/three/materialTheme.ts::floorKeyForFinish` exactly: anything
    soft is the light gray carpet, every hard floor (stone, timber, vinyl, tile,
    screed) is the dark herringbone parquet. Expressed as a RULE, not a lookup
    table of expected strings, so a new finish in FINISH_SPEC resolves on its own
    instead of silently falling out of the check.
    """
    return "light_gray_carpet" if "carpet" in inventory_material.lower() else "herringbone_parquet"


# The codomain of that rule: the only two families a DSource floor can render as.
# Anything else in palette.json is furniture, joinery, lighting, ceiling or glass.
FLOOR_FAMILIES = ("light_gray_carpet", "herringbone_parquet")


def in_envelope(m: dict, hue: float, sat: float, lum: float, shadow: bool = False) -> bool:
    """Is this colour that palette family? `shadow=True` allows the exposure
    shortfall a dark corner causes (luminance free to fall) but not a repaint."""
    if "hueRange" not in m:
        return False  # glass_partition carries no envelope
    h0, h1 = m["hueRange"]
    s0, s1 = m["satRange"]
    l0, l1 = m["lumRange"]
    if not shadow:
        return h0 <= hue <= h1 and s0 <= sat <= s1 and l0 <= lum <= l1
    return (h0 - TOL_H <= hue <= h1 + TOL_H and s0 - TOL_S <= sat <= s1 + TOL_S
            and lum <= l1 + TOL_L_HIGH)


def ground_regions(im):
    """Bottom-anchored, gradient-limited surfaces — the gate's own floor finder.

    Seeds are the BOTTOM ROW of the frame only: the one place an interior camera
    at eye height is always looking at the ground. That is what makes a region
    the gate finds a floor candidate rather than any old patch of wall.

    Returns (regions, band_coverage):
      regions        [(area_fraction, median_rgb, bottom_span_fraction), ...],
                     largest first
      band_coverage  fraction of the frame rows from SEG_Y_MIN down to the
                     bottom that contain at least one ground pixel — how far the
                     ground the gate measured actually runs up the picture

    NOTHING here reads the manifest: the only inputs are the pixels and the
    constants above.
    """
    from PIL import Image

    W0, H0 = im.size
    h = max(1, int(round(SEG_WIDTH * H0 / W0)))
    sm = im.convert("RGB").resize((SEG_WIDTH, h), Image.BILINEAR)
    W, H = sm.size
    px = G.pixels(sm)
    y_min = int(SEG_Y_MIN * H)
    seen = bytearray(W * H)   # visited, not labelled: each region is grown whole
    base = (H - 1) * W
    regions = []
    rows = set()              # frame rows any KEPT region reaches
    for seed in range(base, base + W):
        if seen[seed]:
            continue
        seen[seed] = 1
        q = deque([seed])
        idxs = []
        while q:
            i = q.popleft()
            idxs.append(i)
            r, g, b = px[i]
            y, x = divmod(i, W)
            nb = []
            if y > y_min:
                nb.append(i - W)
            if y < H - 1:
                nb.append(i + W)
            if x > 0:
                nb.append(i - 1)
            if x < W - 1:
                nb.append(i + 1)
            for j in nb:
                if seen[j]:
                    continue
                p = px[j]
                if (abs(p[0] - r) <= EDGE_TOL and abs(p[1] - g) <= EDGE_TOL
                        and abs(p[2] - b) <= EDGE_TOL):
                    seen[j] = 1
                    q.append(j)
        area = len(idxs) / float(W * H)
        if area < COMP_MIN_AREA:
            continue
        med = tuple(int(statistics.median([px[i][c] for i in idxs])) for c in range(3))
        span = len({i % W for i in idxs if i >= base}) / float(W)
        regions.append((area, med, span))
        rows.update(i // W for i in idxs)
    regions.sort(key=lambda t: -t[0])
    band = range(y_min, H)
    coverage = len([y for y in band if y in rows]) / float(len(band))
    return regions, coverage


def body(g: G.Gate):
    rdir = G.arg("--renders", G.DEFAULTS["renders"])
    gtp = G.arg("--ground-truth", G.DEFAULTS["ground_truth"])
    min_w = int(G.arg("--min-width", "1920"))
    min_h = int(G.arg("--min-height", "1080"))
    min_evidenced = int(G.arg("--min-evidenced", str(MIN_EVIDENCED)))

    pal = G.palette()
    mats = pal["materials"]
    mood = pal["renderMood"]
    lo, hi = mood["meanLuminanceBand"]
    min_sd = mood.get("minStdDev", 0.06)

    G.require_dir(rdir, "renders directory")
    gt = G.load_json(gtp, "ground truth")

    # The workbook's own Floor Material column, keyed by room id. THIS is the
    # vocabulary every deliverable must agree on.
    inventory_floor = {
        str(r.get("roomId")): r.get("floorMaterial") for r in (gt.get("rooms") or [])
    }
    g.check(bool(inventory_floor),
            "ground truth carries no rooms[] — there is no Inventory floor "
            "vocabulary to check the renders against")

    entries = gt.get("renders") or []
    if not g.check(len(entries) >= 4,
                   f"ground truth declares {len(entries)} render(s), need 4 — the "
                   "`renders` block is mandatory, a still cannot opt out of being checked"):
        return

    evidenced = 0
    fingerprints = []   # (name, dHash) — four rooms must be four pictures
    for e in entries:
        name = e.get("name") or os.path.splitext(os.path.basename(e.get("file", "")))[0]
        p = e.get("file") or f"{name}.png"
        if not os.path.isabs(p):
            cand = os.path.join(rdir, os.path.basename(p))
            p = cand if os.path.isfile(cand) else os.path.join(G.REPO, p)
        if not os.path.isfile(p):
            raise G.Missing(f"render '{name}' at {p}")

        im = G.open_rgb(p, f"render {name}")
        W, H = im.size
        g.check(W >= min_w and H >= min_h,
                f"render '{name}' is {W}x{H}, need >={min_w}x{min_h}")
        # Taken before any `continue` below: a still that fails another tier is
        # still a still, and duplication is checked across ALL of them.
        fingerprints.append((name, G.dhash(im)))

        mean, sd = G.mean_luma(im)
        g.check(lo <= mean <= hi,
                f"render '{name}' mean luminance {mean:.3f} outside [{lo}, {hi}] "
                "(black / blown / empty frame?)")
        g.check(sd >= min_sd,
                f"render '{name}' stddev {sd:.3f} < {min_sd} — the frame is flat, "
                "probably an empty or single-colour image")

        # --- render <-> takeoff: one vocabulary, no opt-out -------------------
        rid = str(e.get("roomId"))
        inv = inventory_floor.get(rid)
        if not g.check(inv is not None,
                       f"render '{name}' declares roomId {rid!r}, which is not a room in "
                       "ground-truth rooms[] — the still cannot be tied to a takeoff row"):
            continue

        fm = e.get("floorMaterial")
        if not g.check(bool(fm),
                       f"render '{name}' declares no floorMaterial. Every still must "
                       "evidence the Inventory floor finish of the room it photographs; "
                       "a shot that cannot show its own floor is a framing defect to be "
                       "fixed in the renderer, not a check to be skipped"):
            continue

        if not g.check(fm == inv,
                       f"render '{name}' claims floor {fm!r} but the Inventory (and the "
                       f"workbook's Floor Material column) says {inv!r} for room {rid} — "
                       "renders and takeoff must name the same finish"):
            continue

        key = palette_family(str(fm))
        if not g.check(key in mats,
                       f"render '{name}': floor material {fm!r} resolves to palette family "
                       f"'{key}', which palette.json does not define "
                       f"(known: {sorted(mats)})"):
            continue

        # --- the sample. Located by the gate, from the pixels, every time. ----
        m = mats[key]
        h0, h1 = m["hueRange"]
        s0, s1 = m["satRange"]
        l0, l1 = m["lumRange"]

        regions, band_cov = ground_regions(im)
        ground = sum(r[0] for r in regions)
        # --- COVERAGE. Everything below measures the ground plane the gate can
        # reach; these two checks say that plane has to BE most of the picture's
        # lower half, so the tiers cannot be satisfied by a strip at the bottom
        # of a frame whose middle is something else entirely (defect F1).
        if not g.check(ground >= GROUND_MIN_AREA,
                       f"render '{name}' shows {ground * 100:.1f}% of frame of ground plane "
                       f"(need >= {GROUND_MIN_AREA * 100:.0f}%): the gate found too little "
                       "surface connected to the bottom of this frame to be a room floor at "
                       "eye height (real renders measure 21-49%), so whatever fills the rest "
                       "of the picture is unmeasured — the still cannot evidence any finish"):
            continue
        if not g.check(band_cov >= GROUND_BAND_COVERAGE,
                       f"render '{name}': the ground plane the gate can reach covers only "
                       f"{band_cov * 100:.0f}% of the frame rows below the horizon "
                       f"(need >= {GROUND_BAND_COVERAGE * 100:.0f}%; real renders measure "
                       f"80-100%). The floor of an eye-height interior camera recedes up the "
                       "picture; this one stops, so the gate is being asked to certify a "
                       "still from a strip of it and the surface above that edge is not the "
                       "floor it segmented"):
            continue

        lo_l, hi_l = TAMPER_LUM_BAND
        strict = 0.0
        best = None
        foreign = []
        wrong_floor = []
        for area, rgb, span in regions:
            hue, lum, sat = G.rgb_to_hls(rgb)
            hx = f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"
            if in_envelope(m, hue, sat, lum):
                strict += area
                if best is None or area > best[0]:
                    best = (area, hx, hue, sat, lum, span)
                continue
            if area < SURFACE_MIN_AREA:
                continue
            # TIER A — tamper. Every load-bearing surface the camera sees AT THE
            # BOTTOM OF THE FRAME has to be a material palette.json specifies.
            # The envelopes are wide and they overlap, so "belongs to nothing"
            # is a strong signal, and it is exactly what a painted-over,
            # composited or otherwise doctored floor looks like.
            if (lo_l <= lum <= hi_l
                    and not any(in_envelope(mm, hue, sat, lum, shadow=True)
                                for mm in mats.values())):
                foreign.append(f"{area * 100:.1f}% {hx} (H={hue:.1f} S={sat:.2f} L={lum:.2f})")
            # TIER B — the wrong floor. Furniture standing on the floor may hide
            # it; a DIFFERENT floor finish in its place is a render/takeoff
            # disagreement, which is the whole point of this gate.
            other = [f for f in FLOOR_FAMILIES
                     if f != key and in_envelope(mats[f], hue, sat, lum)]
            if other:
                wrong_floor.append(f"{area * 100:.1f}% {hx} reads as {other[0]}")

        g.check(not foreign,
                f"render '{name}': the gate segmented {ground * 100:.1f}% of frame of ground "
                f"plane and {len(foreign)} surface(s) on it match NO material in palette.json, "
                f"even allowing +-{TOL_H} hue / +-{TOL_S} sat and any amount of shadow: "
                f"{'; '.join(foreign)}. Nothing in this design is that colour — the floor of "
                "this still has been painted over or replaced")

        g.check(strict > 0 or not wrong_floor,
                f"render '{name}' claims floor {fm!r} -> palette '{key}' but the gate found "
                f"none of it on the ground plane and did find {'; '.join(wrong_floor)} — the "
                "still is photographing a different floor finish from the one its Inventory "
                "row bills")

        if strict >= EVIDENCE_MIN_AREA:
            evidenced += 1
            a, hx, hue, sat, lum, span = best
            g.note(f"{name}: room {rid} floor {fm!r} -> {key}; gate found {strict * 100:.2f}% "
                   f"of frame MATCHING (of {ground * 100:.1f}% ground = purity "
                   f"{strict / ground * 100:.0f}%); widest matching patch {a * 100:.2f}% "
                   f"{hx} H={hue:.1f} S={sat:.2f} L={lum:.2f} spans {span * 100:.0f}% of the "
                   f"bottom edge; ground covers {band_cov * 100:.0f}% of the rows below the "
                   f"horizon; luma {mean:.3f}/sd {sd:.3f}")
        else:
            widest = regions[0]
            wh, wl, ws = G.rgb_to_hls(widest[1])
            g.note(f"{name}: room {rid} floor {fm!r} -> {key}; gate found only "
                   f"{strict * 100:.2f}% of frame strictly inside the envelope "
                   f"(need {EVIDENCE_MIN_AREA * 100:.0f}% to count as evidence) of "
                   f"{ground * 100:.1f}% ground — NOT COUNTED. Its widest ground surface is "
                   f"{widest[0] * 100:.1f}% #{widest[1][0]:02X}{widest[1][1]:02X}"
                   f"{widest[1][2]:02X} (H={wh:.1f} S={ws:.2f} L={wl:.2f}), which is furniture, "
                   f"not floor: this room's floor is under its furniture; ground covers "
                   f"{band_cov * 100:.0f}% of the rows below the horizon; "
                   f"luma {mean:.3f}/sd {sd:.3f}")

    # --- IDENTITY. Four rooms, four pictures. -------------------------------
    # Every tier above is about ONE still against ONE Inventory row, so nothing
    # in it notices that two of the slots hold the same photograph — and three
    # of our four rooms share a floor family, which makes them interchangeable
    # to a per-still check. dHash (the same helper G7 uses on video frames) is
    # cheap, needs no metadata, and a near-duplicate cannot survive it.
    for i in range(len(fingerprints)):
        for j in range(i + 1, len(fingerprints)):
            (na, ha), (nb, hb) = fingerprints[i], fingerprints[j]
            d = G.hamming(ha, hb)
            g.check(d > MIN_RENDER_HAMMING,
                    f"renders '{na}' and '{nb}' are the same picture (dHash Hamming {d} <= "
                    f"{MIN_RENDER_HAMMING}; distinct rooms measure 23-40). The pack must show "
                    f"{len(fingerprints)} different rooms — a duplicated still bills one room's "
                    "finishes against another room's photograph, and it would RAISE the "
                    "evidence count while doing it")

    g.check(evidenced >= min_evidenced,
            f"only {evidenced} of {len(entries)} renders show the floor material their "
            f"Inventory row claims; the render<->takeoff cross-check must hold for at "
            f"least {min_evidenced} rooms (see the notes above for each sample)")


G.run_gate("G6", body)
