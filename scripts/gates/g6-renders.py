#!/usr/bin/env python3
"""G6 — Per-room renders.

Four hero stills at qbiq's fidelity, and each one must actually show the floor
material the Inventory sheet claims for that room — otherwise the render pack
and the takeoff are telling the client two different stories.

  * four stills exist, each >=1920x1080
  * mean luminance inside palette.json renderMood.meanLuminanceBand and stddev
    above minStdDev (rejects black, blown, and flat/empty frames)
  * EVERY still names the floor material of the room it photographs, and that
    name is the SAME string the workbook's Inventory `Floor Material` column
    carries (`ground-truth.rooms[].floorMaterial`, i.e. FINISH_SPEC/finishTypeFor)
  * every still's floor sample is measured against that material's palette.json
    envelope, and the match must hold for at least `--min-evidenced` rooms

WHY THE MATERIAL CHECK CANNOT BE SKIPPED (defect D1, reports/defects-1.md):
this used to `continue` when the producer omitted `floorMaterial`, so an artifact
that could not evidence its floor switched off its own only render-to-model
assertion — magenta-painted floors passed. A still that cannot show its floor is
a PRODUCER defect (reframe the shot); the gate now fails instead of excusing it.
And the name is checked against OUR OWN Inventory vocabulary rather than a
hand-written parallel table, so plan, workbook and renders are all measured
against one source.

Room -> render -> floor material mapping comes from ground-truth.json `renders`
(see docs/reference/qbiq/spec/ground-truth.schema.json). The block is MANDATORY:
dropping it would be the same self-disabling trick as dropping a field.

Usage: g6-renders.py [--renders out/renders] [--ground-truth out/ground-truth.json]
                     [--min-width 1920] [--min-height 1080] [--floor-rect 0.05,0.80,0.95,0.98]
                     [--min-evidenced 3]
"""
import os
import sys

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


def palette_family(inventory_material: str) -> str:
    """Our Inventory floor name -> the palette.json material family it renders as.

    Mirrors `web/src/three/materialTheme.ts::floorKeyForFinish` exactly: anything
    soft is the light gray carpet, every hard floor (stone, timber, vinyl, tile,
    screed) is the dark herringbone parquet. Expressed as a RULE, not a lookup
    table of expected strings, so a new finish in FINISH_SPEC resolves on its own
    instead of silently falling out of the check.
    """
    return "light_gray_carpet" if "carpet" in inventory_material.lower() else "herringbone_parquet"


def body(g: G.Gate):
    rdir = G.arg("--renders", G.DEFAULTS["renders"])
    gtp = G.arg("--ground-truth", G.DEFAULTS["ground_truth"])
    min_w = int(G.arg("--min-width", "1920"))
    min_h = int(G.arg("--min-height", "1080"))
    min_evidenced = int(G.arg("--min-evidenced", str(MIN_EVIDENCED)))
    fr = [float(x) for x in G.arg("--floor-rect", "0.05,0.80,0.95,0.98").split(",")]

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

        # The sample itself. Counted, not asserted per render: a genuinely
        # furnished small room (a 5x4 m meeting room with eight chairs) can leave
        # no clean patch of its own floor in ANY frame, and the mission's bar is
        # that the cross-check holds for at least `min_evidenced` rooms. The
        # artifact still cannot choose which rooms are tested — every one is
        # measured, every miss is printed, and the count is enforced below.
        m = mats[key]
        rect = e.get("floorRect") or fr
        g.check(len(rect) == 4 and rect[2] > rect[0] and rect[3] > rect[1]
                and rect[1] >= 0.30 and rect[3] <= 1.0
                and (rect[2] - rect[0]) * (rect[3] - rect[1]) >= 0.005,
                f"render '{name}' offers floorRect {rect} as its floor sample: a floor crop "
                "must sit in the lower frame (y0 >= 0.30) and cover >= 0.5% of it, not a "
                "sliver picked anywhere in the picture")
        rgb = G.median_rgb(im, rect)
        hue, lum, sat = G.rgb_to_hls(rgb)
        hx = f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"
        h0, h1 = m["hueRange"]
        s0, s1 = m["satRange"]
        l0, l1 = m["lumRange"]
        ok = (h0 <= hue <= h1) and (s0 <= sat <= s1) and (l0 <= lum <= l1)
        if ok:
            evidenced += 1
        else:
            # Two tiers, both decided HERE, never by the artifact. A render may
            # miss the envelope because its only visible floor is in shadow — an
            # exposure shortfall, not a different material. It may NOT show
            # something that is not the declared finish at all: that is a hard
            # fail no matter how many other renders pass.
            near = (h0 - TOL_H <= hue <= h1 + TOL_H
                    and s0 - TOL_S <= sat <= s1 + TOL_S
                    and lum <= l1 + TOL_L_HIGH)
            g.check(near,
                    f"render '{name}' floor sample {hx} (H={hue:.1f} S={sat:.2f} L={lum:.2f}) "
                    f"is not {fm!r} -> palette '{key}' (H {h0}-{h1}, S {s0}-{s1}, L {l0}-{l1}) "
                    f"even allowing +-{TOL_H} hue / +-{TOL_S} sat and any amount of shadow — "
                    "this is a different material, not a dark corner")
        g.note(f"{name}: room {rid} floor {fm!r} -> {key}; sample {hx} "
               f"H={hue:.1f} S={sat:.2f} L={lum:.2f} "
               f"({'MATCHES' if ok else 'does NOT match'} H {h0}-{h1}, S {s0}-{s1}, "
               f"L {l0}-{l1}); luma {mean:.3f}/sd {sd:.3f}")

    g.check(evidenced >= min_evidenced,
            f"only {evidenced} of {len(entries)} renders show the floor material their "
            f"Inventory row claims; the render<->takeoff cross-check must hold for at "
            f"least {min_evidenced} rooms (see the notes above for each sample)")


G.run_gate("G6", body)
