"""Shared helpers for the DSource deliverable-pack acceptance gates.

Every gate prints exactly one scoreboard line and exits 0 (pass) or 1 (fail):
    G1 PASS
    G1 FAIL: <first reason>; <second reason>

A MISSING artifact is a normal FAIL, never a traceback — the orchestrator runs
these from day one and watches red turn green.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SPEC_DIR = os.path.join(REPO, "docs/reference/qbiq/spec")
OUT = os.path.join(REPO, "out")

# Default artifact locations. This IS the inter-agent contract — the producing
# agent must write exactly these paths (or every gate must be given --flags).
DEFAULTS = {
    "workbook": os.path.join(OUT, "quantity-takeoff.xlsx"),
    "ground_truth": os.path.join(OUT, "ground-truth.json"),
    "plan": os.path.join(OUT, "plan.png"),
    "plan_repeat": os.path.join(OUT, "plan.repeat.png"),
    "renders": os.path.join(OUT, "renders"),
    "video": os.path.join(OUT, "walkthrough.mp4"),
    "share": os.path.join(OUT, "share.json"),
}

SOFFICE_FALLBACK = "/Applications/LibreOffice.app/Contents/MacOS/soffice"


class Missing(Exception):
    """An input artifact does not exist yet. Reported as a clean FAIL."""


class Gate:
    def __init__(self, gid: str, title: str = ""):
        self.gid = gid
        self.title = title
        self.reasons: list[str] = []
        self.checks = 0
        self.notes: list[str] = []

    def check(self, cond, msg: str):
        """Record a failure reason when `cond` is falsy. Returns bool(cond)."""
        self.checks += 1
        if not cond:
            self.reasons.append(msg)
        return bool(cond)

    def fail(self, msg: str):
        self.reasons.append(msg)

    def note(self, msg: str):
        self.notes.append(msg)

    def finish(self):
        for n in self.notes:
            print(f"  note[{self.gid}] {n}", file=sys.stderr)
        if self.reasons:
            # Cap the line so the scoreboard stays readable.
            shown = self.reasons[:4]
            more = f" (+{len(self.reasons)-4} more)" if len(self.reasons) > 4 else ""
            print(f"{self.gid} FAIL: " + "; ".join(shown) + more)
            sys.exit(1)
        print(f"{self.gid} PASS" + (f"  ({self.checks} checks)" if self.checks else ""))
        sys.exit(0)


def run_gate(gid: str, fn):
    """Wrap a gate body so Missing -> clean FAIL and anything else -> ERROR line."""
    g = Gate(gid)
    try:
        fn(g)
    except Missing as e:
        print(f"{gid} FAIL: artifact missing: {e}")
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 - gates must never dump a traceback
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"{gid} FAIL: gate error: {type(e).__name__}: {e}")
        sys.exit(1)
    g.finish()


def require_file(path: str, what: str = "") -> str:
    if not path or not os.path.isfile(path):
        raise Missing(f"{what or 'file'} {path}")
    return path


def require_dir(path: str, what: str = "") -> str:
    if not path or not os.path.isdir(path):
        raise Missing(f"{what or 'directory'} {path}")
    return path


def load_json(path: str, what: str = ""):
    require_file(path, what)
    with open(path) as f:
        return json.load(f)


def spec() -> dict:
    return load_json(os.path.join(SPEC_DIR, "workbook-spec.json"), "workbook spec")


def palette() -> dict:
    return load_json(os.path.join(SPEC_DIR, "palette.json"), "palette")


def video_spec() -> dict:
    return load_json(os.path.join(SPEC_DIR, "video-spec.json"), "video spec")


# --------------------------------------------------------------- soffice ----
def resolve_soffice() -> str:
    """PATH first, then the macOS bundle. Loud, actionable failure if absent."""
    p = shutil.which("soffice") or shutil.which("libreoffice")
    if p:
        return p
    if os.path.isfile(SOFFICE_FALLBACK) and os.access(SOFFICE_FALLBACK, os.X_OK):
        return SOFFICE_FALLBACK
    raise RuntimeError(
        "LibreOffice (soffice) not found. Looked on PATH and at "
        f"{SOFFICE_FALLBACK}. Install it (brew install --cask libreoffice) — "
        "this gate cannot be skipped, formula recalculation requires it."
    )


def soffice_recalc(xlsx_path: str, outdir: str, timeout: int = 240) -> str:
    """Round-trip a workbook through headless LibreOffice so every formula is
    recalculated and its result cached. Returns the converted file's path.
    Raises RuntimeError with soffice's own stderr on failure."""
    require_file(xlsx_path, "workbook")
    os.makedirs(outdir, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="soffice-profile-")
    cmd = [
        resolve_soffice(),
        f"-env:UserInstallation=file://{profile}",
        "--headless", "--norestore", "--nolockcheck", "--nodefault",
        "--convert-to", "xlsx:Calc MS Excel 2007 XML",
        "--outdir", outdir, os.path.abspath(xlsx_path),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    dest = os.path.join(outdir, os.path.splitext(os.path.basename(xlsx_path))[0] + ".xlsx")
    if not os.path.isfile(dest):
        raise RuntimeError(
            f"soffice conversion produced no output.\ncmd: {' '.join(cmd)}\n"
            f"rc={r.returncode}\nstdout={r.stdout[:800]}\nstderr={r.stderr[:800]}"
        )
    return dest


# Phrases that mean "this file is broken". Deliberately specific: a bare
# "invalid" also matches macOS's routine `Task policy set failed: 4
# ((os/kern) invalid argument)` chatter, which says nothing about the document.
_REPAIR_PHRASES = (
    "repair", "corrupt", "damaged", "cannot be opened", "could not be opened",
    "format error", "unable to load", "general input/output error",
    "general error", "filter not found", "is in an unexpected format",
)
# Lines soffice always emits on macOS that are not about the document at all.
_SOFFICE_NOISE = (
    "task policy set failed",
    "objc[", "warning: ", "javaldx", "gio: ", "dbus", "libgl", "fontconfig",
)


def soffice_warnings(stderr: str, stdout: str) -> list[str]:
    """Repair/corruption complaints from a soffice run, minus platform noise."""
    hits = []
    for line in (stdout + "\n" + stderr).splitlines():
        low = line.lower().strip()
        if not low or any(n in low for n in _SOFFICE_NOISE):
            continue
        if any(b in low for b in _REPAIR_PHRASES):
            hits.append(line.strip()[:200])
    return hits


# ------------------------------------------------------------ xlsx utils ----
def load_wb(path: str, data_only: bool = False):
    require_file(path, "workbook")
    try:
        import openpyxl
    except ImportError as e:
        raise RuntimeError("openpyxl is required: pip3 install openpyxl") from e
    try:
        return openpyxl.load_workbook(path, data_only=data_only)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"workbook will not open ({type(e).__name__}: {e})") from e


def argb_to_hex(color) -> str | None:
    """openpyxl Color -> '#RRGGBB', resolving the workbook's custom indexed palette."""
    if color is None:
        return None
    t = getattr(color, "type", None)
    if t == "rgb" and isinstance(color.rgb, str) and len(color.rgb) == 8:
        return "#" + color.rgb[2:].upper()
    if t == "indexed":
        pal = spec().get("indexed_palette", {})
        return pal.get(f"indexed{color.indexed}")
    return None


def fill_hex(cell) -> str | None:
    f = getattr(cell, "fill", None)
    if f is None or not f.patternType:
        return None
    return argb_to_hex(f.fgColor)


# ------------------------------------------------------------- image ops ----
def open_rgb(path: str, what: str = "image"):
    require_file(path, what)
    try:
        from PIL import Image
    except ImportError as e:
        raise RuntimeError("Pillow is required: pip3 install pillow") from e
    return Image.open(path)


def dhash(im, size: int = 8) -> int:
    """64-bit difference hash of a PIL image."""
    g = im.convert("L").resize((size + 1, size))
    px = g.load()
    bits = 0
    for y in range(size):
        for x in range(size):
            bits = (bits << 1) | (1 if px[x, y] > px[x + 1, y] else 0)
    return bits


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def hex_to_rgb(h: str):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb_to_hls(rgb):
    import colorsys
    h, l, s = colorsys.rgb_to_hls(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
    return h * 360.0, l, s


def pixels(im):
    """Flat list of pixel tuples. Prefers Pillow 12's get_flattened_data() so
    gates do not spray DeprecationWarnings across the scoreboard."""
    f = getattr(im, "get_flattened_data", None)
    if callable(f):
        return list(f())
    return list(im.getdata())


def mean_luma(im):
    from PIL import ImageStat
    g = im.convert("L").copy()
    g.thumbnail((800, 800))
    s = ImageStat.Stat(g)
    return s.mean[0] / 255.0, s.stddev[0] / 255.0


# ------------------------------------------------------------------ misc ----
def arg(flag: str, default=None, argv=None):
    """--flag value  |  --flag=value"""
    argv = argv if argv is not None else sys.argv[1:]
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(flag + "="):
            return a.split("=", 1)[1]
    return default


def has_flag(flag: str, argv=None) -> bool:
    argv = argv if argv is not None else sys.argv[1:]
    return flag in argv


def which(name: str) -> str:
    p = shutil.which(name)
    if not p:
        raise RuntimeError(f"`{name}` not found on PATH — this gate requires it.")
    return p
