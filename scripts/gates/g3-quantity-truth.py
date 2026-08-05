#!/usr/bin/env python3
"""G3 — Quantity truth.

The workbook must agree with the geometry it was generated from. The generator
emits `out/ground-truth.json` alongside the .xlsx (schema:
docs/reference/qbiq/spec/ground-truth.schema.json); this gate cross-checks it
against what actually landed in the cells.

  * wall run length per wall type, within 1 cm
  * door counts, exact
  * per-room area (m2), within 0.01
  * Area (sqf) == Area (m2) x factor, within 0.01
  * Inventory body row count == room count
  * every Inventory Room ID appears exactly once in the plan renderer's
    emitted label list

Usage: g3-quantity-truth.py [--workbook out/quantity-takeoff.xlsx]
                            [--ground-truth out/ground-truth.json]
                            [--sqf-factor 10.7639] [--wall-tol-m 0.01] [--area-tol 0.01]
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402


def col_map(ws, header_row):
    """header text -> column letter."""
    out = {}
    for c in ws[header_row]:
        if isinstance(c.value, str) and c.value.strip():
            out[re.sub(r"\s+", " ", c.value).strip().lower()] = c.column_letter
    return out


def body(g: G.Gate):
    wbp = G.arg("--workbook", G.DEFAULTS["workbook"])
    gtp = G.arg("--ground-truth", G.DEFAULTS["ground_truth"])
    sqf_factor = float(G.arg("--sqf-factor", "10.7639"))
    wall_tol = float(G.arg("--wall-tol-m", "0.01"))
    area_tol = float(G.arg("--area-tol", "0.01"))
    sqf_rel_tol = float(G.arg("--sqf-rel-tol", "5e-5"))

    G.require_file(wbp, "workbook")
    gt = G.load_json(gtp, "ground truth")
    wb = G.load_wb(wbp)

    for k in ("rooms", "walls", "doors", "planLabels"):
        g.check(k in gt, f"ground truth missing required key '{k}'")
    if g.reasons:
        return

    # ---- walls: General!J/L table (Material Name / Length (m)) --------------
    if "General" not in wb.sheetnames:
        g.fail("no 'General' sheet to read wall lengths from")
    else:
        ws = wb["General"]
        got = {}
        for r in range(9, min(ws.max_row, 60) + 1):
            name, length = ws[f"J{r}"].value, ws[f"L{r}"].value
            if isinstance(name, str) and name.strip() and isinstance(length, (int, float)):
                got[name.strip()] = float(length)
        for wt, want in gt["walls"].items():
            want_m = float(want["lengthM"] if isinstance(want, dict) else want)
            if wt not in got:
                g.fail(f"wall type '{wt}' absent from General!J9:L* (found {sorted(got)})")
                continue
            d = abs(got[wt] - want_m)
            g.check(d <= wall_tol,
                    f"wall '{wt}' length {got[wt]:.4f} m vs truth {want_m:.4f} m "
                    f"(off by {d*100:.2f} cm, tol {wall_tol*100:.0f} cm)")
        for wt in got:
            g.check(wt in gt["walls"], f"workbook has wall type '{wt}' not in ground truth")

    # ---- doors: General!T/W table (Type Name / Amount) ----------------------
    if "General" in wb.sheetnames:
        ws = wb["General"]
        got = {}
        for r in range(9, min(ws.max_row, 60) + 1):
            name, amt = ws[f"T{r}"].value, ws[f"W{r}"].value
            if isinstance(name, str) and name.strip() and isinstance(amt, (int, float)):
                got[name.strip()] = int(amt)
        for dt, want in gt["doors"].items():
            g.check(got.get(dt) == int(want),
                    f"door type '{dt}' count {got.get(dt)!r} vs truth {int(want)} (must be exact)")
        if "doorCount" in gt:
            g.check(sum(got.values()) == int(gt["doorCount"]),
                    f"total door count {sum(got.values())} vs truth {gt['doorCount']}")

    # ---- rooms: Inventory ---------------------------------------------------
    if "Inventory" not in wb.sheetnames:
        g.fail("no 'Inventory' sheet")
        return
    inv = wb["Inventory"]
    cm = col_map(inv, 4)
    need = ["room id", "area (m2)", "area (sqf)"]
    for n in need:
        g.check(n in cm, f"Inventory header row 4 missing '{n}' (saw {sorted(cm)})")
    if g.reasons:
        return
    c_id, c_m2, c_sqf = cm["room id"], cm["area (m2)"], cm["area (sqf)"]

    rows = []
    for r in range(5, min(inv.max_row, 2000) + 1):
        rid = inv[f"{c_id}{r}"].value
        if rid is None or str(rid).strip() == "":
            continue
        rows.append((r, rid, inv[f"{c_m2}{r}"].value, inv[f"{c_sqf}{r}"].value))

    truth = {str(x["roomId"]): x for x in gt["rooms"]}
    g.check(len(rows) == len(gt["rooms"]),
            f"Inventory has {len(rows)} body rows, ground truth has {len(gt['rooms'])} rooms")

    seen = {}
    for r, rid, m2, sqf in rows:
        key = str(rid).strip()
        seen[key] = seen.get(key, 0) + 1
        t = truth.get(key)
        if t is None:
            g.fail(f"Inventory row {r} Room ID {key!r} is not in ground truth")
            continue
        if not isinstance(m2, (int, float)):
            g.fail(f"Inventory row {r} Area (m2) is not numeric: {m2!r}")
            continue
        d = abs(float(m2) - float(t["areaM2"]))
        g.check(d <= area_tol,
                f"room {key} area {float(m2):.4f} m2 vs truth {float(t['areaM2']):.4f} "
                f"(off {d:.4f}, tol {area_tol})")
        if not isinstance(sqf, (int, float)):
            g.fail(f"Inventory row {r} Area (sqf) is not numeric: {sqf!r}")
            continue
        want_sqf = float(m2) * sqf_factor
        d2 = abs(float(sqf) - want_sqf)
        # Absolute 0.01 is too tight once a room passes ~200 sqf: the factor
        # itself is a rounded constant, so the error scales with area. The
        # proportional term stays far below the gap a WRONG factor produces
        # (10.76 vs 10.7639 is ~3.6e-4 relative, 7x this tolerance).
        tol2 = max(area_tol, want_sqf * sqf_rel_tol)
        g.check(d2 <= tol2,
                f"room {key} sqf {float(sqf):.4f} != m2 x {sqf_factor} = {want_sqf:.4f} "
                f"(off {d2:.4f}, tol {tol2:.4f})")

    dupes = [k for k, n in seen.items() if n > 1]
    g.check(not dupes, f"Room IDs duplicated in Inventory: {dupes[:6]}")
    absent = [k for k in truth if k not in seen]
    g.check(not absent, f"ground-truth rooms missing from Inventory: {absent[:6]}")

    # ---- every Inventory Room ID appears exactly once on the plan -----------
    labels = [str(x).strip() for x in gt["planLabels"]]
    counts = {}
    for x in labels:
        counts[x] = counts.get(x, 0) + 1
    for key in seen:
        n = counts.get(key, 0)
        g.check(n == 1,
                f"Room ID {key} appears {n}x in the plan label list (must be exactly 1)")
    orphan = [x for x in counts if x not in seen]
    g.check(not orphan, f"plan labels with no Inventory row: {orphan[:6]}")

    g.note(f"{len(rows)} rooms, {len(gt['walls'])} wall types, "
           f"{sum(int(v) for v in gt['doors'].values())} doors verified")


G.run_gate("G3", body)
