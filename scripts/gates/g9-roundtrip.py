#!/usr/bin/env python3
"""G9 — Round-trip robustness.

A workbook that only survives our own reader is not a deliverable. This gate
opens each produced workbook in headless LibreOffice and demands ZERO repair
warnings, then re-runs G1-G5 against it. It does this for three independent
inputs so we know the generator is not tuned to one lucky plan:

    seeded   — a deterministic generated plan
    dwg      — a plan imported from the DWG/DXF sample
    testfit  — an autonomous test-fit result

Each case is a directory holding the same artifact names as out/:
    <case>/quantity-takeoff.xlsx, ground-truth.json, plan.png, plan.repeat.png

STALENESS IS A FAILURE (defect E5, reports/defects-2.md). These twelve files are
written ONLY by `node scripts/export-pack.mjs`; nothing in the suite used to run
it, and they are not part of the pack the app's one-action export writes. Measured
across two consecutive green boards, they were 27 minutes old and byte-identical
throughout — the scoreboard said "unchanged since G10 produced it", which was true
of the ten pack files and silent about the twelve carrying 21 of the checks. Change
the generator, run the suite, and G9 would certify the PREVIOUS generator's
workbooks. So: `run-all.sh` now regenerates all three cases before it grades
anything (they cost ~1.3 s), and this gate independently refuses to grade a case
artifact older than the newest file in the generator's own import closure (see
`generator_closure`), so a case cannot be stale even when the gate is run alone.

Usage: g9-roundtrip.py [--cases out/cases] [--case-names seeded,dwg,testfit]
                       [--only-open]
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SUBGATES = [
    ("G1", ["python3", os.path.join(HERE, "g1-sheet-structure.py")]),
    ("G2", ["python3", os.path.join(HERE, "g2-formula-liveness.py")]),
    ("G3", ["python3", os.path.join(HERE, "g3-quantity-truth.py")]),
    ("G4", ["python3", os.path.join(HERE, "g4-plan-graphic.py")]),
    ("G5", ["python3", os.path.join(HERE, "g5-thumbnails.py")]),
]

CASE_ARTIFACTS = ("quantity-takeoff.xlsx", "ground-truth.json", "plan.png", "plan.repeat.png")

# What decides the BYTES of a case, computed rather than listed. The three
# ENTRY_POINTS are literally the modules `export-pack.mjs` and `demo-doc.mjs`
# bundle (`buildQtoPack` + `classifyWalls`, and the DXF/test-fit import path);
# `generator_closure` walks their relative imports transitively, so the watched
# set is exactly the code that runs, and it maintains itself as imports change.
#
# This precision matters: a blanket "anything under web/src" would call every
# workbook stale the moment a camera moved, and a guard that cries wolf gets
# switched off. Measured, the walk resolves to 64 files. It reaches
# `three/sectionRender.ts` + `three/{theme,furniture3d,Viewer3D}.ts`, because the
# workbook really does embed a section render, and it does NOT reach
# `export/roomRenders.ts`, `export/walkthrough.ts` or `three/interiorStill.ts` —
# those are the hero-still and video entry points, never on `buildQtoPack`, so a
# camera change correctly does not age a workbook.
ENTRY_POINTS = (
    "web/src/export/qtoWorkbook.ts",
    "web/src/export/wallTypes.ts",
    "web/src/import/dxf.ts",
    "web/src/import/testfit.ts",
)
# Inputs the walk cannot see: the drivers themselves, the sample plans, the core.
EXTRA_SOURCES = (
    "scripts/export-pack.mjs",
    "scripts/lib",
    "web/src/editor/samplePlan.json",
    "web/src/wasm",
    "samples/furniture-plan.dwg",
)
_SKIP_DIRS = {"node_modules", "__pycache__", ".git"}
_SPEC_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]""")
_EXTS = ("", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.js")


def generator_closure():
    """Every file the case generator reads, from the entry points outward."""
    seen, queue = set(), []
    for rel in ENTRY_POINTS:
        p = os.path.join(G.REPO, rel)
        if os.path.isfile(p):
            queue.append(p)
    while queue:
        p = queue.pop()
        if p in seen:
            continue
        seen.add(p)
        if os.path.splitext(p)[1] not in (".ts", ".tsx", ".js", ".mjs"):
            continue
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                src = f.read()
        except OSError:
            continue
        for spec in _SPEC_RE.findall(src):
            if not spec.startswith("."):
                continue  # node_modules: pinned by the lockfile, not our source
            spec = spec.split("?", 1)[0]
            base = os.path.normpath(os.path.join(os.path.dirname(p), spec))
            for ext in _EXTS:
                cand = base + ext
                if os.path.isfile(cand):
                    queue.append(cand)
                    break
    for rel in EXTRA_SOURCES:
        root = os.path.join(G.REPO, rel)
        if os.path.isfile(root):
            seen.add(root)
        elif os.path.isdir(root):
            for dp, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
                seen |= {os.path.join(dp, f) for f in files if not f.startswith(".")}
    return seen


def newest_generator_source():
    """(mtime, path, n_files) of the most recently edited file in the closure."""
    files = generator_closure()
    newest, who = 0.0, ""
    for p in files:
        try:
            m = os.stat(p).st_mtime
        except OSError:
            continue
        if m > newest:
            newest, who = m, os.path.relpath(p, G.REPO)
    return newest, who, len(files)


def open_clean(g: G.Gate, xlsx: str, label: str):
    """Convert through soffice and demand no repair/corruption complaints."""
    tmp = tempfile.mkdtemp(prefix="g9-open-")
    profile = tempfile.mkdtemp(prefix="g9-profile-")
    try:
        cmd = [
            G.resolve_soffice(),
            f"-env:UserInstallation=file://{profile}",
            "--headless", "--norestore", "--nolockcheck", "--nodefault",
            "--convert-to", "xlsx:Calc MS Excel 2007 XML",
            "--outdir", tmp, os.path.abspath(xlsx),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
        dest = os.path.join(tmp, os.path.splitext(os.path.basename(xlsx))[0] + ".xlsx")
        if not os.path.isfile(dest):
            why = " ".join((r.stderr or r.stdout or "").split())[:200]
            g.fail(f"[{label}] LibreOffice produced no output (rc={r.returncode}): {why}")
            return
        warns = G.soffice_warnings(r.stderr, r.stdout)
        g.check(not warns, f"[{label}] LibreOffice reported repair warnings: {warns[:2]}")
        # And it must still parse as a workbook afterwards.
        try:
            wb = G.load_wb(dest, data_only=True)
            g.check(len(wb.sheetnames) == 12,
                    f"[{label}] after LibreOffice round-trip the workbook has "
                    f"{len(wb.sheetnames)} sheets, expected 12")
        except Exception as e:  # noqa: BLE001
            g.fail(f"[{label}] round-tripped workbook will not re-open: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


def body(g: G.Gate):
    cases_dir = G.arg("--cases", os.path.join(G.OUT, "cases"))
    names = [n.strip() for n in G.arg("--case-names", "seeded,dwg,testfit").split(",") if n.strip()]
    only_open = G.has_flag("--only-open")

    G.require_dir(cases_dir, "cases directory (one subdirectory per input)")

    src_mtime, src_path, src_n = newest_generator_source()

    for name in names:
        cdir = os.path.join(cases_dir, name)
        if not os.path.isdir(cdir):
            raise G.Missing(f"case directory {cdir}")
        xlsx = os.path.join(cdir, "quantity-takeoff.xlsx")
        if not os.path.isfile(xlsx):
            raise G.Missing(f"{name} workbook {xlsx}")

        # Staleness is a failure, not a silent pass. A case produced before the
        # generator's last edit says nothing about the generator we ship.
        present = [os.path.join(cdir, a) for a in CASE_ARTIFACTS
                   if os.path.isfile(os.path.join(cdir, a))]
        oldest = min(os.stat(p).st_mtime for p in present)
        g.check(oldest >= src_mtime,
                f"[{name}] case artifacts are STALE: the oldest is "
                f"{(src_mtime - oldest) / 60:.1f} min older than {src_path}, so this "
                f"round-trip grades a workbook a PREVIOUS generator wrote. Regenerate "
                f"with `node scripts/export-pack.mjs` (run-all.sh does it for you)")

        open_clean(g, xlsx, name)
        if only_open:
            continue

        args = {
            "G1": ["--workbook", xlsx],
            "G2": ["--workbook", xlsx],
            "G3": ["--workbook", xlsx, "--ground-truth", os.path.join(cdir, "ground-truth.json")],
            "G4": ["--workbook", xlsx,
                   "--plan", os.path.join(cdir, "plan.png"),
                   "--plan2", os.path.join(cdir, "plan.repeat.png")],
            "G5": ["--workbook", xlsx],
        }
        for gid, cmd in SUBGATES:
            r = subprocess.run(cmd + args[gid], capture_output=True, text=True, timeout=600)
            line = (r.stdout or "").strip().splitlines()
            line = line[-1] if line else f"{gid} (no output)"
            g.check(r.returncode == 0, f"[{name}] {line}")

    g.note(f"verified {len(names)} case(s): {', '.join(names)}; generator closure is "
           f"{src_n} files, newest {src_path}")


G.run_gate("G9", body)
