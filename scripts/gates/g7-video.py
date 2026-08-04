#!/usr/bin/env python3
"""G7 — Walkthrough video.

Container facts come from ffprobe; the "is anything actually happening"
check comes from sampling three frames and comparing 64-bit dHashes.

  * mp4 exists and decodes
  * H.264, 1920x1080, >=30 fps, duration 30-45 s
  * first / middle / last frames are non-empty (luminance band + stddev floor)
    and mutually distinct (pHash Hamming > threshold)
  * branding: title-card frame carries the accent colour
    (skipped when video-spec.json target.branding.mode is not 'title_card' —
     the qbiq reference has in-scene branding and NO title card)

Thresholds live in docs/reference/qbiq/spec/video-spec.json (`target`).

Usage: g7-video.py [--video out/walkthrough.mp4] [--keep-frames DIR]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402


def ffprobe(path):
    out = subprocess.run(
        [G.which("ffprobe"), "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", path],
        capture_output=True, text=True, timeout=120)
    if out.returncode != 0 or not out.stdout.strip():
        raise RuntimeError(f"ffprobe failed on {path}: {out.stderr[:400]}")
    return json.loads(out.stdout)


def frame_at(video, t, dest):
    r = subprocess.run(
        [G.which("ffmpeg"), "-v", "error", "-ss", f"{t:.3f}", "-i", video,
         "-frames:v", "1", "-y", dest],
        capture_output=True, text=True, timeout=180)
    if not os.path.isfile(dest):
        raise RuntimeError(f"ffmpeg could not extract a frame at t={t:.2f}s: {r.stderr[:400]}")
    return dest


def ratio(s):
    try:
        n, d = s.split("/")
        return float(n) / float(d) if float(d) else 0.0
    except Exception:
        try:
            return float(s)
        except Exception:
            return 0.0


def body(g: G.Gate):
    vp = G.arg("--video", G.DEFAULTS["video"])
    keep = G.arg("--keep-frames")
    G.require_file(vp, "walkthrough mp4")

    tgt = G.video_spec()["target"]
    probe = ffprobe(vp)

    vs = next((s for s in probe.get("streams", []) if s.get("codec_type") == "video"), None)
    if not g.check(vs, "no video stream in the mp4"):
        return

    g.check(vs.get("codec_name") == tgt["codec"],
            f"codec is {vs.get('codec_name')!r}, need {tgt['codec']!r}")
    g.check(int(vs.get("width", 0)) == tgt["width"] and int(vs.get("height", 0)) == tgt["height"],
            f"resolution {vs.get('width')}x{vs.get('height')}, "
            f"need {tgt['width']}x{tgt['height']}")

    fps = ratio(vs.get("avg_frame_rate") or vs.get("r_frame_rate") or "0/1")
    g.check(fps >= tgt["minFps"], f"frame rate {fps:.2f} fps, need >={tgt['minFps']}")

    dur = float(probe.get("format", {}).get("duration") or vs.get("duration") or 0)
    d0, d1 = tgt["durationRange_s"]
    g.check(d0 <= dur <= d1, f"duration {dur:.2f}s outside [{d0}, {d1}]s")
    g.note(f"{vs.get('codec_name')} {vs.get('width')}x{vs.get('height')} "
           f"{fps:.1f}fps {dur:.2f}s")

    if dur <= 0:
        g.fail("duration is zero — cannot sample frames")
        return

    tmp = keep or tempfile.mkdtemp(prefix="g7-frames-")
    os.makedirs(tmp, exist_ok=True)
    try:
        times = [0.1, dur / 2.0, max(0.0, dur - 0.3)]
        lo, hi = tgt["frameLuminanceBand"]
        min_sd = tgt["minFrameStdDev"]
        hashes = []
        for label, t in zip(("first", "middle", "last"), times):
            p = frame_at(vp, t, os.path.join(tmp, f"{label}.png"))
            im = G.open_rgb(p, f"{label} frame")
            mean, sd = G.mean_luma(im)
            g.check(lo <= mean <= hi,
                    f"{label} frame (t={t:.2f}s) mean luminance {mean:.3f} "
                    f"outside [{lo}, {hi}] — empty or blown frame")
            g.check(sd >= min_sd,
                    f"{label} frame (t={t:.2f}s) stddev {sd:.3f} < {min_sd} — flat frame")
            hashes.append((label, G.dhash(im)))

        thr = tgt["minPHashHamming"]
        for i in range(len(hashes)):
            for j in range(i + 1, len(hashes)):
                (la, ha), (lb, hb) = hashes[i], hashes[j]
                d = G.hamming(ha, hb)
                g.check(d > thr,
                        f"{la} and {lb} frames are perceptually identical "
                        f"(dHash Hamming {d} <= {thr}) — the camera is not moving")

        # ---- branding ------------------------------------------------------
        br = tgt.get("branding", {})
        if br.get("mode") != "title_card":
            g.note(f"branding mode is {br.get('mode')!r}, title-card assertion skipped")
        else:
            p = frame_at(vp, br.get("titleCardAt_s", 0.0), os.path.join(tmp, "titlecard.png"))
            im = G.open_rgb(p, "title card frame").convert("RGB")
            mean, sd = G.mean_luma(im)
            g.check(sd <= br.get("titleCardMaxStdDev", 0.22),
                    f"title-card frame stddev {sd:.3f} > "
                    f"{br.get('titleCardMaxStdDev', 0.22)} — t=0 does not look like a "
                    "flat branded card (set target.branding.mode to 'in_scene' if "
                    "DSource deliberately has no title card)")
            accent = G.hex_to_rgb(br.get("accentHex", "#E8A13C"))
            small = im.copy()
            small.thumbnail((480, 480))
            data = G.pixels(small)
            hit = sum(1 for c in data if all(abs(c[k] - accent[k]) <= 40 for k in range(3)))
            pct = 100.0 * hit / max(1, len(data))
            g.check(pct >= br.get("minAccentPixelPct", 0.05),
                    f"title-card frame has only {pct:.3f}% accent pixels "
                    f"({br.get('accentHex')}), need >={br.get('minAccentPixelPct', 0.05)}% "
                    "— the logo is not detectable")
            g.note(f"title card: sd={sd:.3f} accent={pct:.3f}%")
    finally:
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)


G.run_gate("G7", body)
