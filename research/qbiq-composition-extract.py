#!/usr/bin/env python3
"""Extract the reference's COMPOSITION constants — programme mix and field rhythm.

    python3 research/qbiq-composition-extract.py            # writes the JSON
    python3 research/qbiq-composition-extract.py --print     # measure, print, write nothing

Output: `research/qbiq-composition-spec.json`, frozen like the plate fixture.
Re-running it after a reference change is a re-registration event.

WHY BOTH NUMBERS COME FROM HERE
-------------------------------
The standing brief says the composition constants must come from the reference's
own geometry before any allocator code moves, and it offers two starting guesses:
that our programme is "one cabin, one boardroom, one reception", and that the
reference "never runs more than ~3 desk rows without punctuation". Neither
survived measurement, and that is the point of measuring:

  * our plan already carries **12 rooms**, not 3. The shortfall is specific:
    conference rooms, where we sit at 38% of the reference's ratio. Offices we
    already EXCEED.
  * the reference's longest unpunctuated run is **5 rows**, not 3.

TWO SOURCES, DELIBERATELY
-------------------------
1. **The mix** comes from the report's own STATED summary (page 6): three
   alternatives, each with seats / open space / offices / conf rooms against a
   15 360 USF floor. Stated facts, not inferred from pixels or paths — the
   strongest anchor available, and it covers three plans rather than one.
2. **The rhythm** has no stated form, so it comes from the vector geometry on
   page 3: the bench desk POSITION is a 7.2 x 14.4 pt filled rect (675 x 1350 mm
   at the measured scale `pt x 10/32.5 x 304.8`), and 168 of them are present.
   That size anchor is checked, not assumed — the run aborts if the histogram
   does not put it first.

THE RHYTHM MEASUREMENT, STATED SO IT IS FALSIFIABLE
---------------------------------------------------
Desks come in two orientation families and they must be measured separately: a
portrait desk (1350 deep in y) sits side by side along X, so its rows stack along
Y; a landscape desk stacks along X. Measuring the mixed population clusters desk
POSITIONS as if they were rows and produces nonsense — the first attempt did
exactly that and reported a 0.67 m "row pitch", which is the 675 mm position
pitch wearing the wrong name.

Within a family: cluster centres into row bands, take the gaps, and call a gap a
PUNCTUATION when it exceeds 1.6x the median gap. 1.6 is not tuned to either
population — bench rows repeat at the pitch and an aisle is a different animal,
so any multiplier between roughly 1.3 and 2 lands in the same gap. The measured
median pitch is 1.35 m, which is the desk's own 1350 mm depth: back-to-back rows
touching, the same convention as our own `SPINE_GAP = 0`.
"""
import json
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "docs/reference/qbiq/extracted/Sample Report/Crystal Tower  Modern-2024-08-11-07-17-04.pdf"
OUT = ROOT / "research/qbiq-composition-spec.json"

#: 1 pt in mm at the reference plan's measured scale.
MM_PER_PT = 10 / 32.5 * 304.8
#: A gap wider than this multiple of the median row pitch is a punctuation.
PUNCTUATION_FACTOR = 1.6
#: The bench desk position, in mm, as the brief's anchor states it.
DESK_POSITION_MM = (675, 1350)

# The report's own summary table (page 6), transcribed. Stated facts.
ALTERNATIVES = [
    {"id": "A", "usf_sqft": 15360, "seats": 149, "open_space": 141, "offices": 7, "conf_rooms": 12, "density_sqft": 103.09},
    {"id": "B", "usf_sqft": 15360, "seats": 148, "open_space": 138, "offices": 5, "conf_rooms": 11, "density_sqft": 103.78},
    {"id": "C", "usf_sqft": 15360, "seats": 138, "open_space": 128, "offices": 7, "conf_rooms": 12, "density_sqft": 111.30},
]

# Room kinds the plan pages label in-place, beyond the summary's four counts.
# Evidence that the reference's support programme is far broader than its table.
IN_PLAN_ROOM_TAGS = ["COAT.", "IT", "CLEA.", "STOR.", "WELL."]
LEGEND_CATEGORIES = [
    "Executive", "Conf Room", "Amenities", "Office", "Reception",
    "Comfort Zone", "Open Space", "Pantry", "IT Room",
]


def verify_stated_table():
    """The transcription must reproduce the report's own density arithmetic."""
    for a in ALTERNATIVES:
        m2 = a["usf_sqft"] * 0.092903
        got = a["usf_sqft"] / a["seats"]
        if abs(got - a["density_sqft"]) > 0.2:
            sys.exit(
                f"alternative {a['id']}: transcribed seats/USF give {got:.2f} sqft/person "
                f"against the report's stated {a['density_sqft']} — the transcription is wrong"
            )
        a["usf_m2"] = round(m2, 1)
        a["density_m2"] = round(m2 / a["seats"], 2)


def desk_positions(page):
    """Filled rects matching the bench desk position, split by orientation."""
    plan_x0 = page.rect.width * 0.30  # the left third is the stats card
    lo_mm, hi_mm = DESK_POSITION_MM
    lo_pt, hi_pt = lo_mm / MM_PER_PT, hi_mm / MM_PER_PT
    tol = 0.20
    portrait, landscape, sizes = [], [], {}
    for d in page.get_drawings():
        r = d["rect"]
        if r.x1 < plan_x0:
            continue
        w, h = r.width, r.height
        if not (abs(min(w, h) - lo_pt) <= tol * lo_pt and abs(max(w, h) - hi_pt) <= tol * hi_pt):
            continue
        key = (round(w, 1), round(h, 1))
        sizes[key] = sizes.get(key, 0) + 1
        (portrait if h > w else landscape).append((r.x0 + w / 2, r.y0 + h / 2))
    return portrait, landscape, sizes


def runs_between_punctuations(pts, axis):
    """Row bands along `axis`, their gaps, and the runs the punctuations cut."""
    if len(pts) < 4:
        return None
    vals = sorted(p[axis] for p in pts)
    bands, cur = [], [vals[0]]
    for v in vals[1:]:
        if v - cur[-1] <= 2.0:
            cur.append(v)
        else:
            bands.append(sum(cur) / len(cur))
            cur = [v]
    bands.append(sum(cur) / len(cur))
    gaps = [(bands[i + 1] - bands[i]) * MM_PER_PT / 1000 for i in range(len(bands) - 1)]
    if not gaps:
        return None
    med = sorted(gaps)[len(gaps) // 2]
    thr = PUNCTUATION_FACTOR * med
    runs, n = [], 1
    for g in gaps:
        if g > thr:
            runs.append(n)
            n = 1
        else:
            n += 1
    runs.append(n)
    return {
        "rows": len(bands),
        "median_row_pitch_m": round(med, 2),
        "punctuation_threshold_m": round(thr, 2),
        "gaps_m": [round(g, 2) for g in gaps],
        "runs": runs,
        "max_run": max(runs),
    }


def main():
    verify_stated_table()
    doc = fitz.open(PDF)
    page = doc[2]
    portrait, landscape, sizes = desk_positions(page)

    # SIZE ANCHOR, checked rather than assumed. If the dominant matched size is
    # not the stated bench position, the scale is wrong and every metre below is
    # wrong with it.
    if not sizes:
        sys.exit("no desk positions matched — the scale anchor or the page index is wrong")
    top = max(sizes.items(), key=lambda kv: kv[1])[0]
    top_mm = tuple(sorted(round(v * MM_PER_PT) for v in top))
    want = tuple(sorted(DESK_POSITION_MM))
    if any(abs(a - b) > 0.1 * b for a, b in zip(top_mm, want)):
        sys.exit(f"dominant matched size is {top_mm} mm, expected {want} mm — scale anchor failed")
    total = len(portrait) + len(landscape)
    if total < 100:
        sys.exit(f"only {total} desk positions found — the extraction is the finding, not the plan")

    # Portrait desks stack along y; landscape along x. See the module docstring.
    fams = {
        "portrait": runs_between_punctuations(portrait, 1),
        "landscape": runs_between_punctuations(landscape, 0),
    }
    max_run = max(f["max_run"] for f in fams.values() if f)

    open_total = sum(a["open_space"] for a in ALTERNATIVES)
    spec = {
        "note": "FROZEN. Generated by research/qbiq-composition-extract.py. Re-running is a re-registration event.",
        "source": str(PDF.relative_to(ROOT)),
        "scale": {"mm_per_pt": round(MM_PER_PT, 3), "anchor_desk_position_mm": list(DESK_POSITION_MM)},
        "programme_mix": {
            "$comment": "From the report's own summary page. Ratios are per 100 OPEN-SPACE seats — "
                        "the denominator that scales with plate size, unlike a raw count.",
            "alternatives": ALTERNATIVES,
            "offices_per_100_open": round(100 * sum(a["offices"] for a in ALTERNATIVES) / open_total, 2),
            "conf_rooms_per_100_open": round(100 * sum(a["conf_rooms"] for a in ALTERNATIVES) / open_total, 2),
            "density_m2_per_person": round(sum(a["density_m2"] for a in ALTERNATIVES) / len(ALTERNATIVES), 2),
            "in_plan_room_tags": IN_PLAN_ROOM_TAGS,
            "legend_categories": LEGEND_CATEGORIES,
        },
        "field_rhythm": {
            "$comment": "Measured from page 3's vector desk positions. MAX_UNPUNCTUATED_ROWS is the "
                        "contract; the brief's guess was ~3.",
            "desk_positions_found": total,
            "families": fams,
            "max_unpunctuated_rows": max_run,
        },
    }

    if "--print" in sys.argv:
        print(json.dumps(spec, indent=2))
        return
    OUT.write_text(json.dumps(spec, indent=2) + "\n")
    back = json.loads(OUT.read_text())
    if back["field_rhythm"]["max_unpunctuated_rows"] != max_run:
        sys.exit("write did not take — refusing to report success")
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  offices/100 open      {spec['programme_mix']['offices_per_100_open']}")
    print(f"  conf rooms/100 open   {spec['programme_mix']['conf_rooms_per_100_open']}")
    print(f"  density m2/person     {spec['programme_mix']['density_m2_per_person']}")
    print(f"  max unpunctuated rows {max_run}  (from {total} desk positions)")


if __name__ == "__main__":
    main()
