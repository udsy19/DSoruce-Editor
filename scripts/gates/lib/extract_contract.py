#!/usr/bin/env python3
"""Append the generalized `contract` block (formula patterns, legend, anchors)
to docs/reference/qbiq/spec/workbook-spec.json. Derived facts are recomputed
from the spec so they cannot drift from the source workbook."""
import json, os, re, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SPEC = os.path.join(ROOT, "docs/reference/qbiq/spec/workbook-spec.json")
spec = json.load(open(SPEC))
S = spec["sheets"]


def cellv(sheet, ref, key="v"):
    return S[sheet]["cells"].get(ref, {}).get(key)


# ---- Plan legend (recomputed, not hand-typed) -------------------------------
legend = []
for r in range(5, 12):
    chip = S["Plan"]["cells"].get(f"Q{r}", {})
    lab = S["Plan"]["cells"].get(f"R{r}", {})
    legend.append({
        "row": r,
        "chipCell": f"Q{r}", "chipFill": chip.get("fill"),
        "labelCell": f"R{r}", "label": lab.get("v"), "labelFill": lab.get("fill"),
    })

# ---- Inventory thumbnail anchors -------------------------------------------
inv_imgs = [i for i in S["Inventory"]["images"] if i.get("media_px") == [240, 180]]
inv_rows = sorted({i["from"]["row"] + 1 for i in inv_imgs})
inv_data_rows = sorted({int(re.match(r"[A-Z]+(\d+)", k).group(1))
                        for k in S["Inventory"]["cells"] if re.match(r"G\d+$", k)
                        and isinstance(S["Inventory"]["cells"][k].get("v"), (int, float))})

# ---- Furniture Inventory item-description strings --------------------------
descs = [v["v"] for k, v in S["Furniture Inventory"]["cells"].items()
         if re.match(r"F\d+$", k) and isinstance(v.get("v"), str) and int(k[1:]) >= 5]
canon = re.compile(r"^(?P<name>.+?) W(?P<w>\d+) X L(?P<l>\d+)$")
conforming = [d for d in descs if canon.match(d)]

fi_rows = sorted(int(k[1:]) for k in S["Furniture Inventory"]["cells"] if re.match(r"J\d+$", k)
                 and "f" in S["Furniture Inventory"]["cells"][k])
fs_rows = sorted(int(k[1:]) for k in S["Furniture Inventory Summary"]["cells"] if re.match(r"G\d+$", k)
                 and "f" in S["Furniture Inventory Summary"]["cells"][k])

spec["contract"] = {
    "sheetOrder": spec["sheet_order"],
    "gridlinesOff": {n: S[n]["gridlines"] for n in spec["sheet_order"]},

    "logo": {
        "planSheet": {"media": "image1.jpeg", "px": [199, 92], "anchor": "B2"},
        "dataSheets": {"media": "image2.jpeg", "px": [181, 83], "anchor": "B2",
                       "exception": "'BOM - Glass Partitions' anchors the logo at B3 (whole sheet is shifted down one row)"},
        "sheetsWithLogo": [n for n in spec["sheet_order"] if S[n]["images"]],
        "sheetsWithoutLogo": [n for n in spec["sheet_order"] if not S[n]["images"]],
    },

    "planSheet": {
        "masterPlanImage": {
            "media": "image1.png", "px": [1040, 780],
            "anchorFrom": "A1", "anchorTo": "M37",
            "opaqueBBox": [3, 433, 1011, 755],
            "opaqueBBoxSize": [1008, 322],
            "note": "The PNG canvas is 1040x780 but the drawn plate occupies only the "
                    "lower band (bbox above); 71% of the canvas is fully transparent. "
                    "Area-ratio gates must normalise against the OPAQUE BBOX, not the canvas.",
        },
        "legendBlock": {
            "headerCell": "Q4", "headerText": cellv("Plan", "Q4"),
            "headerMerged": S["Plan"]["merged"],
            "headerFill": S["Plan"]["cells"]["Q4"].get("fill"),
            "headerFontColor": S["Plan"]["cells"]["Q4"].get("font", {}).get("color"),
            "rows": legend,
            "labelStrings": [l["label"] for l in legend],
        },
        "planPixelPalette": {
            "note": "Exact RGBA values counted in xl/media/image1.png (1040x780 RGBA).",
            "circulation": {"rgba": [255, 0, 0, 25], "compositedOnWhite": "#FFE6E6",
                            "pixels": 41726, "pctOfOpaqueBBox": 12.86},
            "drywall": {"hex": "#FFDC60", "pixels": 3811},
            "glass": {"hex": "#77DBF1", "pixels": 1245},
            "perimeter_windows": {"hex": "#DCDBEE", "pixels": 5999},
            "perimeter_wall": {"hex": "#AEB6FF", "pixels": 236},
            "door_swing": {"hex": "#FFC393", "pixels": 570},
            "core": {"hex": "#A0A0A0", "pixels": 8640,
                     "warning": "The PLAN draws core as #A0A0A0 but the LEGEND chip Q8 is #D5BDD6. "
                                "The reference is internally inconsistent here; DSource should use "
                                "ONE value for both (palette.json.plan.core)."},
            "half_drywall": {"hex": "#72BDA1", "pixels": 0,
                             "note": "Legend row exists but no pixels in this plan."},
            "roomLabelText": {"hex": "#000000", "pixels": 2346},
            "roomFill": {"hex": "#FFFFFF"},
        },
    },

    "formulaPatterns": {
        "_reading": "{r} = body row. Ranges are LITERAL and must be reproduced verbatim; "
                    "they are what makes the workbook recalculate live in Excel/LibreOffice.",
        "generalLookupTables": {
            "Floors":            {"anchorHeader": "'General'!$B$7", "nameCol": "'General'!B{9..10}",  "table": "'General'!$B$9:$E$10",  "idCol": 2, "unitCol": 3, "priceCol": 4},
            "Ceilings":          {"anchorHeader": "'General'!$F$7", "nameCol": "'General'!F{9..10}",  "table": "'General'!$F$9:$I$10",  "idCol": 2, "unitCol": 3, "priceCol": 4},
            "Walls":             {"anchorHeader": "'General'!$J$7", "nameCol": "'General'!J{9..12}",  "table": "'General'!$J$9:$N$12",  "idCol": 2, "lengthCol": 3, "unitCol": 4, "priceCol": 5},
            "Glass Partitions":  {"anchorHeader": "'General'!$O$7", "nameCol": "'General'!O{9}",      "table": "'General'!$O$9:$S$9",   "idCol": 2, "lengthCol": 3, "unitCol": 4, "priceCol": 5},
            "Doors":             {"anchorHeader": "'General'!$T$7", "nameCol": "'General'!T{9..10}",  "table": "'General'!$T$9:$X$10",  "idCol": 2, "unitCol": 3, "amountCol": 4, "priceCol": 5},
        },
        "generalScalars": {
            "B5": "Floor Height (400)", "D5": "Ceiling Height (3) — MULTIPLIER for wall area",
            "F5": "Door Height (2.1)", "H5": "Glass Partition Height (2.98) — MULTIPLIER for glass area",
            "J5": "Glass Plaster Wall Height (1)",
        },
        "columns": {
            "B_materialCategory": '=IF(ISBLANK(C{r}),"",{anchorHeader})',
            "C_materialName":     "={nameCol}",
            "D_materialId":       '=IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{idCol},FALSE))',
            "E_unitType":         '=IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{unitCol},FALSE))',
            "F_quantity_AREA":    '=ROUND(IF(ISBLANK(C{r}),"",SUMIF(\'Inventory\'!${col}1:${col}78,$C{r},\'Inventory\'!$K1:$K78)),2)',
            "F_quantity_LINEAR":  '=ROUND(IF(ISBLANK(C{r}),"",\'General\'!$D$5*(VLOOKUP(C{r},{table},{lengthCol},FALSE))),2)',
            "F_quantity_GLASS":   '=ROUND(IF(ISBLANK(C{r}),"",\'General\'!$H$5*(VLOOKUP(C{r},{table},{lengthCol},FALSE))),2)',
            "F_quantity_COUNT":   '=IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{amountCol},FALSE))',
            "G_quantityAmount":   "LITERAL 0 (user override slot — the ONLY hardcoded body cell)",
            "H_unitPrice":        '=IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{priceCol},FALSE))',
            "I_totalCost_AREA":   '=IF(ISBLANK(C{r}),"",H{r}*G{r})',
            "I_totalCost_LINEAR": '=IF(ISBLANK(C{r}),"",H{r}*F{r})',
        },
        "sumifSourceColumns": {
            "Floors": "Inventory!$L (Floor Material) summed over Inventory!$K (Area sqf)",
            "Ceilings": "Inventory!$M (Ceiling Material) summed over Inventory!$K (Area sqf)",
        },
        "mainSummaryLayout": {
            "headerRow": 4,
            "bodyRows": "5..15 (11 rows)",
            "rowToCategory": {
                "5": "Floors / General!B9", "6": "Floors / General!B10",
                "7": "Ceilings / General!F9", "8": "Ceilings / General!F10",
                "9": "Walls / General!J9", "10": "Walls / General!J10",
                "11": "Walls / General!J11", "12": "Walls / General!J12",
                "13": "Glass Partitions / General!O9",
                "14": "Doors / General!T9", "15": "Doors / General!T10",
            },
            "note": "Main Summary is the UNION of the five BOM sheets' body rows, in "
                    "Floors→Ceilings→Walls→Glass→Doors order, with identical formulas.",
            "knownBug": "B7/B9/B14 reference C5 and B8/B10/B13/B15 reference C6 instead of "
                        "their own row's C — a copy-paste slip in the reference. Do NOT replicate; "
                        "emit '=IF(ISBLANK(C{r}),\"\",...)' consistently.",
        },
        "bomSheetLayout": {
            "headerRow": 4, "bodyStartRow": 5,
            "exception": "'BOM - Glass Partitions' has headerRow=5, bodyStartRow=6 (shifted one row).",
            "bodyRowCounts": {"BOM - Floors": 2, "BOM - Ceilings": 2, "BOM - Walls": 4,
                              "BOM - Doors": 2, "BOM - Glass Partitions": 1},
        },
    },

    "furnitureInventory": {
        "headerRow": 4,
        "headers": ["Cost Code", "Floor", "Room ID", "Room Type", "Item Description",
                    "Supplier", "Quantity", "Unit Price", "Total Price"],
        "headerCols": ["B", "C", "D", "E", "F", "G", "H", "I", "J"],
        "bodyRows": [min(fi_rows), max(fi_rows)],
        "bodyRowCount": len(fi_rows),
        "totalColumnFormula": "=H{r}*I{r}",
        "totalColumn": "J",
        "seedValues": {"B5": "Can be customized", "G5": "Can be customized",
                       "note": "Cost Code and Supplier are written ONCE on the first body row only."},
        "itemDescriptionFormat": {
            "pattern": "^(?P<name>.+?) W(?P<w_cm>\\d+) X L(?P<l_cm>\\d+)$",
            "composition": "'{Label} {CatalogFamily} W{width_cm} X L{length_cm}' — "
                           "W is the SHORTER side, L the LONGER; both integer centimetres.",
            "examples": ["Desk Table W70 X L140", "Conference Chairs W58 X L55",
                         "Coffee Table Table W40 X L40", "Low Storage Storage W30 X L100"],
            "distinctCount": len(set(descs)),
            "conformingPct": round(100 * len(conforming) / max(1, len(descs)), 2),
            "nonConforming": sorted(set(d for d in descs if not canon.match(d))),
        },
        "unitPriceSeed": 0,
    },

    "furnitureInventorySummary": {
        "headerRow": 4,
        "headers": ["Cost Code", "Item Description", "Supplier", "Quantity", "Unit Price", "Total Price"],
        "headerCols": ["B", "C", "D", "E", "F", "G"],
        "bodyRows": [min(fs_rows), max(fs_rows)],
        "bodyRowCount": len(fs_rows),
        "totalColumnFormula": "=E{r}*F{r}",
        "totalColumn": "G",
        "sortOrder": "Item Description, case-sensitive ASCII ascending (lowercase 'printer' sorts LAST)",
    },

    "inventorySheet": {
        "headerRow": 4,
        "headers": ["Room Image ", "Floor", "Department", "Space Type", "Subcategory",
                    "Room ID", "Program Room Name", "Headcount", "Area (m2)", "Area (sqf)",
                    "Floor Material", "Ceiling Material", "Furniture Elements"],
        "headerCols": ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"],
        "headerNote": "B4 is 'Room Image ' WITH a trailing space in the reference.",
        "bodyRows": [min(inv_data_rows), max(inv_data_rows)],
        "roomCount": len(inv_data_rows),
        "thumbnailAnchoring": {
            "column": "B", "pxSize": [240, 180],
            "extEmu": {"cx": 2286000, "cy": 1714500},
            "anchorKind": "twoCellAnchor, from=B{r} offset 0/0, to=B{r} offset cx/cy "
                          "(i.e. fully contained in the single cell B{r})",
            "rowsWithThumbnails": inv_rows,
            "count": len(inv_imgs),
        },
        "rowHeight": 180.0,
        "colBWidth": S["Inventory"]["col_widths"].get("B"),
        "areaConversion": {
            "observedFactor": 10.76,
            "evidence": "J5=12.58 K5=135.3608 (12.58*10.76=135.3608 exactly); "
                        "J7=25.53 K7=274.7028 (25.53*10.76=274.7028 exactly)",
            "warning": "The true m2->sqft factor is 10.7639. The reference workbook uses a "
                       "rounded 10.76. DSource must pick ONE; gates default to 10.7639 and "
                       "expose --sqf-factor to re-check against the reference.",
        },
        "furnitureElementsFormat": "'{Item Description}: {qty}, {Item Description}: {qty}' "
                                   "(comma+space separated; blank when the room has no furniture)",
    },

    "generalSheet": {
        "scalarHeaderRow": 4, "scalarValueRow": 5,
        "categoryBandRow": 7, "tableHeaderRow": 8, "tableBodyStartRow": 9,
        "mergedCategoryBands": S["General"]["merged"],
        "dataValidations": S["General"]["data_validations"],
    },

    "dropdownsSheet": {
        "headerRow": 1,
        "lists": {
            "A_MaterialCategory": ["Floors", "Ceilings", "Walls", "Doors"],
            "B_LengthUnitType": ["cm", "m", "f", "inch"],
            "C_AreaUnitType": ["cm^2", "m^2", "f^2", "inch^2"],
            "D_VolumeUnitType": ["cm^3", "m^3", "f^3", "inch^3"],
            "E_GeneralUnitType": ["Number"],
            "F_units": ["cm", "m", "feet", "inch"],
        },
        "validationWiring": {
            "note": "The reference does NOT reference this sheet by range. The three data "
                    "validations all live on 'General' and use INLINE literal lists whose "
                    "members mirror these columns.",
            "General!M9:M12,K3,C3,G3,E3,I3,R9": '"cm,m,f,inch"   (= dropdowns!B2:B5)',
            "General!D9:D10,H9:H10": '"cm^2,m^2,f^2,inch^2"  (= dropdowns!C2:C5)',
            "General!V9:V10": '"Number"  (= dropdowns!E2)',
        },
        "recommendation": "DSource SHOULD wire validations to 'dropdowns'!$B$2:$B$5 style ranges "
                          "instead of inline literals — same UX, and the gate can verify the range.",
    },
}

with open(SPEC, "w") as f:
    json.dump(spec, f, indent=1, default=str)

c = spec["contract"]
print("legend:", [(l["chipFill"], l["label"]) for l in c["planSheet"]["legendBlock"]["rows"]])
print("inventory rooms:", c["inventorySheet"]["roomCount"], "thumbs:", c["inventorySheet"]["thumbnailAnchoring"]["count"])
print("FI body rows:", c["furnitureInventory"]["bodyRows"], "=", c["furnitureInventory"]["bodyRowCount"])
print("FIS body rows:", c["furnitureInventorySummary"]["bodyRows"], "=", c["furnitureInventorySummary"]["bodyRowCount"])
print("desc conform %:", c["furnitureInventory"]["itemDescriptionFormat"]["conformingPct"],
      "nonconforming:", c["furnitureInventory"]["itemDescriptionFormat"]["nonConforming"])
print("logo sheets:", len(c["logo"]["sheetsWithLogo"]), "no logo:", c["logo"]["sheetsWithoutLogo"])
