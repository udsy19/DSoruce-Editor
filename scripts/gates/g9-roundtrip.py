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

Usage: g9-roundtrip.py [--cases out/cases] [--case-names seeded,dwg,testfit]
                       [--only-open]
"""
import os
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

    for name in names:
        cdir = os.path.join(cases_dir, name)
        if not os.path.isdir(cdir):
            raise G.Missing(f"case directory {cdir}")
        xlsx = os.path.join(cdir, "quantity-takeoff.xlsx")
        if not os.path.isfile(xlsx):
            raise G.Missing(f"{name} workbook {xlsx}")

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

    g.note(f"verified {len(names)} case(s): {', '.join(names)}")


G.run_gate("G9", body)
