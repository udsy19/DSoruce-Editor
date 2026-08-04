#!/usr/bin/env python3
"""G5 — Per-room thumbnails.

qbiq's 'Inventory' sheet gives every room a 240x180 plan crop anchored inside
its own row's column B. That is what makes the sheet readable as a room
schedule rather than a spreadsheet. This gate proves we reproduce it.

  * exactly one image anchored in column B of each Inventory body row
  * each thumbnail ~240x180 (tolerance +/-15% by default)
  * the row is tall enough to show it (default >=120pt; reference uses 180)
  * no two rooms OF DIFFERENT TYPES share byte-identical image data
    (identical thumbnails mean the renderer is emitting a placeholder)

Usage: g5-thumbnails.py [--workbook out/quantity-takeoff.xlsx]
                        [--thumb-w 240] [--thumb-h 180] [--size-tol-pct 15]
                        [--min-row-height 120]
"""
import hashlib
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import gatelib as G  # noqa: E402


def col_map(ws, header_row):
    out = {}
    for c in ws[header_row]:
        if isinstance(c.value, str) and c.value.strip():
            out[re.sub(r"\s+", " ", c.value).strip().lower()] = c.column_letter
    return out


def img_bytes(img):
    """Raw bytes behind an openpyxl image, however openpyxl stored it."""
    ref = getattr(img, "ref", None)
    if hasattr(ref, "getvalue"):
        return ref.getvalue()
    if hasattr(ref, "read"):
        pos = ref.tell()
        ref.seek(0)
        b = ref.read()
        ref.seek(pos)
        return b
    if isinstance(ref, (bytes, bytearray)):
        return bytes(ref)
    d = getattr(img, "_data", None)
    if callable(d):
        return d()
    return None


def body(g: G.Gate):
    wbp = G.arg("--workbook", G.DEFAULTS["workbook"])
    tw = int(G.arg("--thumb-w", "240"))
    th = int(G.arg("--thumb-h", "180"))
    tol = float(G.arg("--size-tol-pct", "15")) / 100.0
    min_rh = float(G.arg("--min-row-height", "120"))

    G.require_file(wbp, "workbook")
    wb = G.load_wb(wbp)
    if "Inventory" not in wb.sheetnames:
        g.fail("no 'Inventory' sheet")
        return
    ws = wb["Inventory"]

    cm = col_map(ws, 4)
    c_id = cm.get("room id")
    c_type = cm.get("space type") or cm.get("room type") or cm.get("subcategory")
    if not g.check(c_id, "Inventory row 4 has no 'Room ID' header"):
        return

    rows = []
    for r in range(5, min(ws.max_row, 2000) + 1):
        rid = ws[f"{c_id}{r}"].value
        if rid is None or str(rid).strip() == "":
            continue
        rtype = ws[f"{c_type}{r}"].value if c_type else None
        rows.append((r, str(rid).strip(), str(rtype).strip() if rtype else ""))
    if not g.check(rows, "Inventory has no body rows"):
        return

    # Bucket images by their anchor row, keeping only column-B anchors.
    by_row = {}
    off_col = []
    for img in getattr(ws, "_images", []):
        a = img.anchor
        frm = getattr(a, "_from", None)
        if frm is None:
            continue
        row1, col1 = frm.row + 1, frm.col  # col is 0-based; B == 1
        w, h = int(img.width or 0), int(img.height or 0)
        if abs(w - tw) > tw * tol or abs(h - th) > th * tol:
            continue  # the sheet logo and other chrome, not a room thumbnail
        if col1 != 1:
            off_col.append((row1, col1))
            continue
        by_row.setdefault(row1, []).append(img)

    g.check(not off_col,
            f"{len(off_col)} thumbnail(s) anchored outside column B: {off_col[:4]}")

    hashes = {}
    for r, rid, rtype in rows:
        imgs = by_row.get(r, [])
        if not g.check(len(imgs) == 1,
                       f"Inventory row {r} (Room ID {rid}) has {len(imgs)} thumbnail(s) "
                       "in column B, need exactly 1"):
            continue
        img = imgs[0]
        w, h = int(img.width or 0), int(img.height or 0)
        g.check(abs(w - tw) <= tw * tol and abs(h - th) <= th * tol,
                f"row {r} thumbnail is {w}x{h}, want ~{tw}x{th} (+/-{tol*100:.0f}%)")
        rh = ws.row_dimensions[r].height
        g.check(rh is not None and rh >= min_rh,
                f"row {r} height is {rh!r}, need >={min_rh} so the thumbnail is visible")
        b = img_bytes(img)
        if b:
            hashes.setdefault(hashlib.sha256(b).hexdigest(), []).append((r, rid, rtype))
        else:
            g.fail(f"row {r} thumbnail has no readable image data")

    extra = sorted(set(by_row) - {r for r, _, _ in rows})
    g.check(not extra, f"column-B thumbnails on non-body rows: {extra[:6]}")

    # Identical bytes across DIFFERENT room types == placeholder renderer.
    for h, group in hashes.items():
        types = {t for _, _, t in group if t}
        if len(group) > 1 and len(types) > 1:
            g.fail(f"byte-identical thumbnail shared by different room types "
                   f"{sorted(types)} at rows {[r for r, _, _ in group]} — "
                   "the room renderer is emitting a placeholder")

    g.note(f"{len(rows)} rooms, {sum(len(v) for v in by_row.values())} column-B thumbnails, "
           f"{len(hashes)} distinct images")


G.run_gate("G5", body)
