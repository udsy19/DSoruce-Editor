#!/usr/bin/env python3
"""G1 — Sheet structure.

Asserts the produced workbook reproduces qbiq's 12-sheet skeleton:
  * exactly the 12 sheet names, in order
  * gridlines off on every sheet
  * the logo image present on all 11 data sheets ('dropdowns' has none)
  * the Plan sheet carries >=2 images, one of them >=1000 px wide
  * the seven wall-type legend label strings live in the Q/R region of Plan

Usage: g1-sheet-structure.py [--workbook out/quantity-takeoff.xlsx]
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402

EXPECTED_ORDER = [
    "Plan",
    "Furniture Inventory",
    "Furniture Inventory Summary",
    "Inventory",
    "General",
    "Main Summary",
    "BOM - Floors",
    "BOM - Ceilings",
    "BOM - Glass Partitions",
    "BOM - Doors",
    "BOM - Walls",
    "dropdowns",
]
LEGEND_LABELS = [
    "Drywall", "Half Drywall", "Glass", "Core",
    "Perimeter windows", "Perimeter wall", "Door_length",
]
NO_LOGO_SHEETS = {"dropdowns"}


def body(g: G.Gate):
    wbp = G.arg("--workbook", G.DEFAULTS["workbook"])
    G.require_file(wbp, "workbook")
    wb = G.load_wb(wbp)

    names = wb.sheetnames
    if not g.check(names == EXPECTED_ORDER, f"sheet order wrong: {names}"):
        missing = [s for s in EXPECTED_ORDER if s not in names]
        extra = [s for s in names if s not in EXPECTED_ORDER]
        if missing:
            g.fail(f"missing sheets {missing}")
        if extra:
            g.fail(f"unexpected sheets {extra}")

    for n in names:
        ws = wb[n]
        g.check(not ws.sheet_view.showGridLines, f"gridlines still on for '{n}'")

    # Logo on every data sheet.
    for n in EXPECTED_ORDER:
        if n not in names or n in NO_LOGO_SHEETS:
            continue
        imgs = getattr(wb[n], "_images", [])
        g.check(len(imgs) >= 1, f"no logo image on '{n}'")

    # Plan sheet: logo + master plan.
    if "Plan" in names:
        plan = wb["Plan"]
        imgs = list(getattr(plan, "_images", []))
        if g.check(len(imgs) >= 2, f"Plan has {len(imgs)} image(s), need >=2 (logo + master plan)"):
            widths = [int(i.width or 0) for i in imgs]
            g.check(max(widths) >= 1000,
                    f"Plan has no image >=1000px wide (widths={widths}); "
                    "the master plan PNG must be embedded at full resolution")

        # Legend labels in the Q/R region (reference puts them at R5:R11).
        region = {}
        for row in plan.iter_rows(min_row=1, max_row=40, min_col=15, max_col=20):
            for c in row:
                if isinstance(c.value, str) and c.value.strip():
                    region[c.coordinate] = c.value.strip()
        found = set(region.values())
        for lab in LEGEND_LABELS:
            g.check(lab in found, f"legend label '{lab}' not found in Plan Q/R region")
        g.check(any(v.lower() == "wall type" for v in found),
                "legend header 'Wall type' not found in Plan Q/R region")
    else:
        g.fail("no 'Plan' sheet")

    # Header rows exist where the reference puts them.
    hdr = {
        "Furniture Inventory": (4, ["Cost Code", "Floor", "Room ID", "Room Type",
                                    "Item Description", "Supplier", "Quantity",
                                    "Unit Price", "Total Price"]),
        "Furniture Inventory Summary": (4, ["Cost Code", "Item Description", "Supplier",
                                            "Quantity", "Unit Price", "Total Price"]),
        "Main Summary": (4, ["Material Category", "Material Name", "Material ID",
                             "Unit Type"]),
    }
    for sheet, (row, cols) in hdr.items():
        if sheet not in names:
            continue
        vals = [str(c.value).strip() if c.value else "" for c in wb[sheet][row]]
        for want in cols:
            g.check(want in vals, f"'{sheet}' row {row} missing header '{want}' (got {vals[:12]})")

    # Inventory headers (B4 may carry the reference's trailing space).
    if "Inventory" in names:
        vals = [re.sub(r"\s+", " ", str(c.value)).strip() if c.value else "" for c in wb["Inventory"][4]]
        for want in ["Room Image", "Room ID", "Area (m2)", "Area (sqf)",
                     "Floor Material", "Ceiling Material"]:
            g.check(want in vals, f"'Inventory' row 4 missing header '{want}' (got {vals[:14]})")


G.run_gate("G1", body)
