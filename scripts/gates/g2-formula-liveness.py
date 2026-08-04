#!/usr/bin/env python3
"""G2 — Formula liveness.

The whole point of the qbiq workbook is that it RECALCULATES: change a unit
price in 'General' and every BOM sheet plus 'Main Summary' moves. A workbook of
baked-in numbers looks identical and is worthless. This gate proves the wiring.

  1. >=90% of body cells in Main Summary + the five BOM sheets, over columns
     B-E and H-I, are formula strings starting '='.
  2. 'Furniture Inventory' Total Price (col J) is '=H{r}*I{r}' on every body row,
     and 'Furniture Inventory Summary' Total Price (col G) is '=E{r}*F{r}'.
  3. RECALC: bump a 'General' wall unit price by DELTA via openpyxl, round-trip
     through headless LibreOffice, and assert the Main Summary total moved by
     exactly qty x DELTA (qty = ceiling height x wall run length).

Usage: g2-formula-liveness.py [--workbook out/quantity-takeoff.xlsx]
                              [--delta 1000] [--min-formula-pct 90]
                              [--price-cell General!N9] [--qty-cells General!D5,General!L9]
                              [--skip-recalc]
"""
import os
import re
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402

BOM_SHEETS = ["Main Summary", "BOM - Floors", "BOM - Ceilings",
              "BOM - Glass Partitions", "BOM - Doors", "BOM - Walls"]
FORMULA_COLS = ["B", "C", "D", "E", "H", "I"]


def body_rows(ws):
    """Rows below the header band that carry any content in B-I."""
    out = []
    for r in range(2, min(ws.max_row, 400) + 1):
        vals = [ws[f"{c}{r}"].value for c in "BCDEFGHI"]
        if any(v is not None and str(v).strip() != "" for v in vals):
            out.append(r)
    # Drop the header row: the one whose B..I are all plain non-formula strings
    # and that is followed by more rows.
    if out:
        first = out[0]
        vals = [ws[f"{c}{first}"].value for c in "BCDEFGHI"]
        if all(v is None or (isinstance(v, str) and not v.startswith("=")) for v in vals):
            out = out[1:]
    return out


def split_ref(ref: str):
    sheet, cell = ref.split("!", 1)
    return sheet.strip().strip("'"), cell.strip().replace("$", "")


def body(g: G.Gate):
    wbp = G.arg("--workbook", G.DEFAULTS["workbook"])
    delta = float(G.arg("--delta", "1000"))
    min_pct = float(G.arg("--min-formula-pct", "90"))
    price_ref = G.arg("--price-cell", "General!N9")
    qty_refs = G.arg("--qty-cells", "General!D5,General!L9").split(",")
    G.require_file(wbp, "workbook")
    wb = G.load_wb(wbp)

    # ---- 1. formula density over the summary/BOM body -----------------------
    total = live = 0
    for sheet in BOM_SHEETS:
        if sheet not in wb.sheetnames:
            g.fail(f"missing sheet '{sheet}'")
            continue
        ws = wb[sheet]
        rows = body_rows(ws)
        if not g.check(rows, f"'{sheet}' has no body rows"):
            continue
        s_total = s_live = 0
        for r in rows:
            for c in FORMULA_COLS:
                v = ws[f"{c}{r}"].value
                if v is None or str(v).strip() == "":
                    continue
                s_total += 1
                if isinstance(v, str) and v.startswith("="):
                    s_live += 1
        total += s_total
        live += s_live
        pct = 100.0 * s_live / s_total if s_total else 0.0
        g.check(pct >= min_pct,
                f"'{sheet}' only {pct:.1f}% of body cells in B-E,H-I are formulas "
                f"({s_live}/{s_total}), need >={min_pct:.0f}%")
    overall = 100.0 * live / total if total else 0.0
    g.check(total > 0, "no body cells found across Main Summary + BOM sheets")
    g.check(overall >= min_pct,
            f"overall formula density {overall:.1f}% ({live}/{total}), need >={min_pct:.0f}%")
    g.note(f"formula density {overall:.1f}% ({live}/{total} cells)")

    # ---- 2. furniture total columns ----------------------------------------
    for sheet, tcol, a, b in [("Furniture Inventory", "J", "H", "I"),
                              ("Furniture Inventory Summary", "G", "E", "F")]:
        if sheet not in wb.sheetnames:
            g.fail(f"missing sheet '{sheet}'")
            continue
        ws = wb[sheet]
        rows = body_rows(ws)
        bad = []
        for r in rows:
            want = f"={a}{r}*{b}{r}"
            got = ws[f"{tcol}{r}"].value
            if isinstance(got, str):
                got = got.replace(" ", "")
            if got != want:
                bad.append(f"{tcol}{r}={got!r} want {want!r}")
        g.check(not bad,
                f"'{sheet}' Total Price column not all {tcol}=<qty>*<price>: "
                + "; ".join(bad[:3]) + (f" (+{len(bad)-3})" if len(bad) > 3 else ""))

    # ---- 3. recalc round-trip ----------------------------------------------
    if G.has_flag("--skip-recalc"):
        g.note("recalc skipped by --skip-recalc")
        return

    psheet, pcell = split_ref(price_ref)
    if psheet not in wb.sheetnames:
        g.fail(f"recalc: no '{psheet}' sheet to set the unit price on")
        return

    tmp = tempfile.mkdtemp(prefix="g2-recalc-")
    try:
        base_src = os.path.join(tmp, "base.xlsx")
        shutil.copyfile(wbp, base_src)

        # Baseline: recalc as-shipped and read Main Summary total cost column.
        conv0 = G.soffice_recalc(base_src, os.path.join(tmp, "c0"))
        wb0 = G.load_wb(conv0, data_only=True)
        if "Main Summary" not in wb0.sheetnames:
            g.fail("recalc: no 'Main Summary' sheet")
            return
        ms0 = wb0["Main Summary"]
        rows = body_rows(wb["Main Summary"])
        t0 = sum(v for v in (ms0[f"I{r}"].value for r in rows) if isinstance(v, (int, float)))

        # Bump the unit price.
        wb2 = G.load_wb(wbp)
        old = wb2[psheet][pcell].value
        old_n = float(old) if isinstance(old, (int, float)) else 0.0
        wb2[psheet][pcell] = old_n + delta
        bumped = os.path.join(tmp, "bumped.xlsx")
        wb2.save(bumped)

        conv1 = G.soffice_recalc(bumped, os.path.join(tmp, "c1"))
        wb1 = G.load_wb(conv1, data_only=True)
        ms1 = wb1["Main Summary"]
        t1 = sum(v for v in (ms1[f"I{r}"].value for r in rows) if isinstance(v, (int, float)))

        # Expected movement = delta x the quantity driving that price.
        qty = 1.0
        parts = []
        for qr in qty_refs:
            qs, qc = split_ref(qr.strip())
            v = wb0[qs][qc].value if qs in wb0.sheetnames else None
            if not isinstance(v, (int, float)):
                g.fail(f"recalc: quantity cell {qr} is not numeric (got {v!r})")
                return
            qty *= float(v)
            parts.append(f"{qr}={v}")
        expected = delta * qty
        moved = t1 - t0
        tol = max(0.05, abs(expected) * 1e-4)
        g.check(abs(moved - expected) <= tol,
                f"recalc dead: setting {price_ref} +{delta:g} moved the Main Summary "
                f"total by {moved:.4f}, expected {expected:.4f} "
                f"(qty {' x '.join(parts)} = {qty:g}, tol {tol:g}). "
                "The workbook is not formula-wired.")
        g.note(f"recalc: total {t0:.2f} -> {t1:.2f} (delta {moved:.2f}, expected {expected:.2f})")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


G.run_gate("G2", body)
