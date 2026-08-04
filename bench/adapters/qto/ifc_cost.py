"""ifc-cost runner: read our IFC with IfcOpenShell, build a cost schedule.

Answers the two pre-registered questions separately (ADR 0004):
  (a) does the file carry DECLARED quantities (IfcElementQuantity)?
  (b) can quantities be DERIVED from the geometry anyway?

Prints a CostSchedule as JSON on stdout. Diagnostics go to stderr so they never
corrupt the result.
"""
import json
import sys

import ifcopenshell


def profile_dims(rep):
    """XDim/YDim of a rectangle-profile extrusion, plus its depth, if present."""
    try:
        for r in rep.Representations:
            for item in r.Items:
                if item.is_a("IfcExtrudedAreaSolid"):
                    prof = item.SweptArea
                    depth = float(item.Depth)
                    if prof.is_a("IfcRectangleProfileDef"):
                        return float(prof.XDim), float(prof.YDim), depth
    except Exception:
        pass
    return None


def main():
    ifc_path, bindings_path = sys.argv[1], sys.argv[2]
    with open(bindings_path) as fh:
        bindings = json.load(fh)

    f = ifcopenshell.open(ifc_path)

    products = [p for p in f.by_type("IfcProduct")
                if p.is_a("IfcWall") or p.is_a("IfcFurnishingElement")]

    # --- (a) declared quantities -------------------------------------------
    declared = f.by_type("IfcElementQuantity")
    psets = f.by_type("IfcPropertySet")
    print(f"[a] IfcElementQuantity={len(declared)} IfcPropertySet={len(psets)}"
          f" products={len(products)}", file=sys.stderr)

    # --- (b) derivable from geometry ---------------------------------------
    spaces = f.by_type("IfcSpace")
    print(f"[b] IfcSpace={len(spaces)} (room attribution requires these)", file=sys.stderr)

    lines = []
    derivable = 0
    by_category = {}
    for p in products:
        name = getattr(p, "Name", None) or p.is_a()
        rep = getattr(p, "Representation", None)
        dims = profile_dims(rep) if rep else None
        if dims:
            derivable += 1
            x, y, depth = dims
            area, volume = x * y, x * y * depth
            # Report COUNT as the quantity so per-category accuracy compares
            # like with like; the derived magnitudes ride alongside. Reporting
            # volume here made a correct engine look 90% wrong.
            kind, qty, basis = "count", 1.0, "derived"
        else:
            area = volume = 0.0
            kind, qty, basis = "count", 1.0, "counted"

        # Category is inferred from the element's Name, because the export
        # carries no classification — itself a finding.
        cat = "Wall" if p.is_a("IfcWall") else str(name).split()[0]
        by_category.setdefault(cat, []).append(
            {"label": str(name), "quantityKind": kind, "quantity": qty,
             "basis": basis, "areaM2": area}
        )
        lines.append({"label": str(name), "category": cat, "quantityKind": kind,
                      "quantity": qty, "basis": basis,
                      "derivedAreaM2": area, "derivedVolumeM3": volume})

    # --- pricing -----------------------------------------------------------
    # Nothing in the IFC identifies a bound product: the export writes no
    # productId, no classification and no property sets, so a binding cannot be
    # matched back to an element. Recorded honestly as zero priced lines rather
    # than faked by index.
    priced = 0
    grand = 0.0

    children = []
    for cat, items in sorted(by_category.items()):
        children.append({
            "kind": "category", "label": cat, "children": [],
            "lines": [{"label": i["label"], "category": cat,
                       "quantityKind": i["quantityKind"],
                       "quantity": i["quantity"], "basis": i["basis"]} for i in items],
            "subtotalInr": 0.0, "itemCount": len(items),
        })

    schedule = {
        "root": {"kind": "level", "label": "Level 1", "children": children,
                 "lines": [], "subtotalInr": grand, "itemCount": len(products)},
        "allLines": lines,
        "grandTotalInr": grand,
        "itemCount": len(products),
        "hierarchical": len(children) > 1,
        "_diagnostics": {
            "declaredQuantitySets": len(declared),
            "propertySets": len(psets),
            "ifcSpaces": len(spaces),
            "products": len(products),
            "geometryDerivable": derivable,
            "derivableFraction": (derivable / len(products)) if products else 0.0,
            "pricedLines": priced,
            "bindingsOffered": len(bindings),
        },
    }
    json.dump(schedule, sys.stdout)


if __name__ == "__main__":
    main()
