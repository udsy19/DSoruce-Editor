"""IFC semantics acceptance check (ADR 0006 Part A).

Reads an exported IFC with IfcOpenShell — a strict, independent consumer — and
asserts the four numbers Part A was scoped against. Two are goals (spaces,
quantities); two are REGRESSION GUARDS that already passed before the change and
must keep passing (category via ObjectType, identity via Description).

Usage:  python3 ifc_semantics_check.py <model.ifc> <expected-zones> <expected-bound>
Exit 0 on pass, 1 on failure.
"""
import sys
import ifcopenshell


def main() -> int:
    path, want_zones, want_bound = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    f = ifcopenshell.open(path)

    prods = [p for p in f.by_type("IfcProduct")
             if p.is_a("IfcWall") or p.is_a("IfcFurnishingElement")]
    furn = [p for p in prods if p.is_a("IfcFurnishingElement")]
    spaces = f.by_type("IfcSpace")
    qsets = f.by_type("IfcElementQuantity")

    # Quantities must be REACHABLE from the element, not merely present in the
    # file — a floating quantity set is invisible to a cost engine.
    related = set()
    for rel in f.by_type("IfcRelDefinesByProperties"):
        rp = getattr(rel, "RelatingPropertyDefinition", None)
        if rp is not None and rp.is_a("IfcElementQuantity"):
            for o in rel.RelatedObjects:
                related.add(o.id())
    with_q = sum(1 for p in prods if p.id() in related)

    typed = sum(1 for p in furn if getattr(p, "ObjectType", None))
    ident = sum(1 for p in furn
                if (getattr(p, "Description", None) or "").startswith("product:"))

    checks = [
        ("IfcSpace per zone", len(spaces), want_zones, len(spaces) == want_zones),
        ("elements with reachable quantities", with_q, len(prods),
         len(prods) > 0 and with_q / len(prods) >= 0.95),
        ("category via ObjectType (regression guard)", typed, len(furn), typed == len(furn)),
        ("identity via Description (regression guard)", ident, want_bound, ident == want_bound),
    ]
    ok = True
    for label, got, want, passed in checks:
        print(f"{'PASS' if passed else 'FAIL'}  {label}: {got} / {want}")
        ok = ok and passed
    print(f"\n(quantity sets in file: {len(qsets)})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
