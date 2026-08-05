# Manual session — what needs your display

Everything in the UI/UX overhaul is shipped and verified except two things I cannot do without a
human at the screen: the **3D panel states** and the **naive-user walkthrough**. This document is
the script for both, plus the tone check and a complete change log.

Run the app with `./run.sh`, or against the session server on **:5199** (not 5173 — other worktrees
hold it). Before believing anything you see: `scripts/verify-preflight.sh 5199 <identifier> <module>`.

---

## 1. 3D panel states — checklist

**Why this needs you:** the 3D viewer is WebGL. Driving it headless crashed the context twice during
this run, and a crashed context produces a *dead React root that still answers queries* — the exact
false-green §3.6.1 warns about. I would rather hand you five things to look at than report a green I
do not trust.

**Setup:** open a project floor (`#/p/:pid/f/:planId`), then press the **3D** toggle in the top bar.

| # | What to do | What should happen | Why it matters |
|---|---|---|---|
| 1 | Switch 2D → 3D | The inspector's first card becomes the **View** card (camera / render tier / sun), **not** the 2D *Drawing* card (Presentation toggle, grid, snapping) | In 2D the first card configures the drawing. In 3D there is no drawing to configure; showing it anyway is a control that does nothing |
| 2 | Look at the left tool dock | Every drafting tool is **dimmed**, and hovering one says **"Switch to 2D to draw"** | Slice 3's rule: a disabled control always says why. A dead-looking dock with no explanation is the defect the audit opened with |
| 3 | Look at the status bar | The cursor read-out (`x … y …`) and the `px/m` scale are **hidden** | Both are 2D-plan facts. A cursor coordinate in a perspective view is a number with no referent |
| 4 | Statistics panel | Unchanged from 2D — same Pax, same areas, same cost | The document is the same; only the view changed. If a number moves, the 3D path has its own copy of something |
| 5 | Migrated components in 3D | `SelectionCard` should **not** appear (it is the imported-plan 2D affordance). `Scene3D` has its own card — check it still looks like a sibling of `.selcard`, not a stranger | `three/Scene3D.tsx` carries a comment saying it is a hand-rolled twin of `ui/SelectionCard` "until SelectionCard stabilizes". It has now stabilised into `.selcard*` classes, so this is the moment to decide whether to merge them |

**If #5 looks wrong**, that is a known, filed follow-up, not a regression from this run — the twin
was already there.

---

## 2. Naive-user walkthrough — script

Do this as a first-timer: **no keyboard shortcuts, no console, do not skip a screen.** At each step
I have written what I claim a first-timer can work out unaided. Falsify them.

Sample file: the real DWG you have been testing with (882 m², multi-wing).

| Step | Do | My claim — confirm or falsify |
|---|---|---|
| 1 | Land on `#/` | You can tell this is a workplace test-fit tool, and the single obvious action is starting a project. Existing projects are visible and openable |
| 2 | **Start a project** | The form asks only for what the exports need (property, address, floor). Nothing here is jargon |
| 3 | **Space** — drop the DWG | The plate previews large enough to read, and the read-outs (usable m², components, detected rooms) tell you the import worked. **Claim: you never wonder whether it is still loading** |
| 4 | Try the **area** and **marker** tools | You can find them without being told they exist. *(This is my weakest claim — see the tone check.)* |
| 5 | **Program** | The primary control is **above the fold** — you should not have to scroll to find the thing that decides the plan. Concept vs Detailed reads as "quick" vs "room by room" |
| 6 | In Detailed, set some **team rooms** (2 / 4 / 6 / 8 person) | The label is the contract. **Claim: a room briefed "6 person" produces a plan whose tag says 6 pax and whose table draws 6 chairs.** This is the thing slice 6b fixed — check it end to end |
| 7 | **Generate** | Three options with real numbers and category badges. **Claim: you can tell why one is different from another without reading a manual** |
| 8 | **Reload the page here** (F5) | Three *real* options come back — same plate, same numbers. Before this run, reload produced three empty 0-workstation "options" badged Most seats / Best daylight / Best density, and opening one saved a blank floor over your project pointer |
| 9 | **Open in editor** | The plan is framed and fully visible. The breadcrumb tells you where you are and gets you back |
| 10 | Zoom in on a meeting room, then out, then in | **Claim: the drawing never changes what it says as you zoom** — the same room shows the same seat count at every scale, and nothing pops in or out |
| 11 | Move a desk, then reload | Your edit is still there. (Autosave-to-floor, slice 4a — this used to lose everything.) |
| 12 | Go back to the project library and reopen the project | You land on the floor you were working on, not at "drop the floor plate" |
| 13 | **Export** the report and the takeoff | The PDF carries the real project name/address/floor. **Claim: the seat count in the report equals the tag on the plan equals the desk quantity in the takeoff.** Verified programmatically (22 == 22, 92 == 92) — worth seeing in the actual documents |

**Please note anywhere you hesitated for more than a second.** Hesitation is the measurement; my
claims above are hypotheses.

---

## 3. Tone check — is this a product an architect would pay for?

Asked plainly, answered plainly.

**It is no longer a demo, and it is not yet a product.** The distinction I would draw: a demo
*shows* that something is possible; a product *survives* being used by someone who does not care how
it works. Six weeks ago this fell over on the second thing a real user did — reload the page, come
back to a project, save an edit. It does not fall over on those any more, and that is the actual
change this run made. What is left is not fragility; it is thinness.

The strongest thing here is genuinely strong: **the drawing tells the truth.** A room tag, the
chairs drawn under it, the report line, and the takeoff row are now one number from one owner, and
that property is enforced by tests rather than by care. Most tools in this space cannot say that —
qbiq and Laiout both ship plans where the schedule and the drawing are computed separately and drift.
An architect will not notice this feature. They will notice its absence everywhere else.

### The three defects that would embarrass us in a client demo, in order

**1. The plan is generated but not *designed*.** This is the real one. Open the 45 px/m zoom capture:
the desks are a rigid lattice, the meeting rooms are a band along one edge, and the circulation is a
perimeter loop with spurs. It is dimensionally correct, code-plausible, and obviously machine-made.
An architect reading it will see a *space allocation*, not a *plan* — no hierarchy of movement, no
sense of arrival, no reason for anything to be where it is beyond packing. The numbers that
demonstrate this are in the run itself: on the 843 m² plate the strategies differ by **111 / 109 /
106 seats** — under 5% apart, from generators labelled "Open", "Balanced" and "Cellular". Three
options that differ by 5% are one option with noise. The evaluator can tell you a layout is dense;
it cannot tell you it is *good*.

**2. There is no way to say "not like that."** The whole loop is generate → evaluate → regenerate.
An architect's actual response to a test-fit is "move the boardroom to the corner, keep the rest" —
and the closest we have is anchor pins before generation, then hand-editing after. There is no
"regenerate, but keep this." `keepConfirmed` exists in the core and is not exposed anywhere a user
would find it. In a demo this surfaces the moment someone says "nice, but…" — and that is roughly
sentence three.

**3. Small-plate and irregular-plate results are still uneven.** The generator has a rescue path for
angled plates and a small-plate gate, both added after real failures, both fixed by *adding a case*
rather than by a packer that handles the general problem. The failure mode is not a crash; it is a
plan that is quietly worse on a plate that does not suit it. In front of a client with their own
irregular floor, that is a coin toss, and the tell is that the room band goes flat while the desk
field stays dense.

Two things I want to be honest about in my own report card:

- **My audit's own severity ranking was wrong twice**, and both times the correction came from
  measuring rather than from thinking harder. I called the Program summary a "constant drift" item
  when it was a brief contradicting its own output; I described the empty-plate bug's blast radius
  before checking whether the library could even route there (it cannot). The measurements are
  trustworthy; my first read of what they mean is worth about 80%.
- **"Verified" in this document means what it says.** Where something is real but I have not
  witnessed it, it is marked `[~]` in ROADMAP and it is in this file. The 3D states and this
  walkthrough are the only two.

If you demo this, demo the **truthfulness** — brief a 6-person room, show the tag, the chairs, the
report line and the takeoff row agreeing, then reload the page mid-flow and show nothing breaks.
Do not demo the *quality* of the layout. That is the next body of work, and it is Track B.

---

## 4. Change log — the whole run

23 commits on `ui-fixes`. What a user would notice, grouped by what it fixes.

### Things that were losing or fabricating work

| Commit | What a user sees |
|---|---|
| `2725490` | Keystrokes stop mutating an invisible document — `Delete` was removing components, `⌘S` was writing files from the upload screen |
| `6f5fd1d` | Edits to an open floor are saved. They were not |
| `e2374fc` | Delete confirms tell the truth; Import warns before replacing; unit labels come from the value's source, not the render site |
| `71cca1f` | **Reloading the Generate step no longer invents three empty test-fits, badges them, and lets you save one over your project** |

### Things that were saying two different numbers

| Commit | What moved |
|---|---|
| `55d234f` | A room's seat count has ONE owner — the tag and the chairs drawn under it agree by construction |
| `812ceb6` | Capacity prefers real furniture over an area estimate; old documents backfill on load |
| `9877c23` | `OPEN_SHARE`, wall thickness and the m²→sf factor get one owner each; TS copies deleted |
| `7639e9d` | **A room briefed "8 person" seats 8** (was 10) |
| `3a9b8db` | The AI preview stops warning about density in the engine's name using a threshold the engine never had |

### Things that looked wrong

| Commit | What changed |
|---|---|
| `f3c8956` | One scroll owner per screen; finished floors reachable; the stepper stops claiming steps you never saw |
| `59d82b8` | Breadcrumb navigation, panel hierarchy, disabled controls that say why |
| `3fa86ef`, `8928e24` | Numerics render in a font that is actually loaded, with tabular figures |
| `eecfb57` … `9c6370b` | Six components: 71 inline style objects and 140 hexes into the stylesheet; the AI badge stops being blue-on-amber |
| `f22cd3b` | A display title stops asking for a weight its typeface does not ship |

### Every number that moved in a deliverable

| Metric | Before | After | Cause |
|---|---|---|---|
| Room tag pax vs chairs drawn | disagreed (e.g. 24 m² boardroom tagged "9 pax" over a 12-chair table) | equal by construction | slice 2 — one owner |
| Enclosed-room capacity | area estimate | furniture seats (Chair excluded — counting both double-books) | `812ceb6` |
| Briefed 8-person team room | **10** | **8** | slice 6b clamp |
| `meetingSeats` (real DWG plate, matched A/B) | **26** | **24** | −2, uniform across all 3 strategies |
| Total seats A / B / C | **111 / 109 / 106** | **109 / 107 / 104** | same −2 |
| Density (m²/seat), candidate A | 7.31 | 7.44 | fewer seats over the same NIA |
| Winner badges | A: Most seats + Best density · C: Best daylight | **unchanged** | a uniform −2 cannot move an argmax |
| Workstations | 90 | 90 | untouched |
| Desks the Program summary promises vs the generator lays | 75 vs 80 | equal | slice 6a — `OPEN_SHARE` had two values |
| Badges on an empty plate | "Most seats · Best daylight · Best density" over 0 workstations | **no badges, no cards** | `71cca1f` |

### Tests and guards added

`cargo test -p ds-core` is **135/135**; the JS suites are **24/24**. (I have not measured the
pre-run baselines — `main` has since reorganised the Rust test files, so a before/after count would
be comparing two different things. The tests this run *added* are named below, which is the number
that actually means something.)

- `briefed_room_seats_match_the_brief` — a briefed room seats what it was briefed to seat
- `seats_are_a_property_of_the_object` + `backfill_resolves_seats_on_an_old_document`
- `web/src/editor/symbols.test.mjs` — 46 assertions: seat count constant 8–300 px/m, world-derived
  counts, device-grid pens at DPR 1/1.5/2/3, monotonic LOD
- `web/src/coreParity.test.mjs` — parses values out of the Rust source; **proven red then green**
- `web/src/ui/fonts.test.mjs` — families, and now weights
- `report.test.mjs` — "best of nothing" is not a superlative (3 assertions)
- `plans.test.mjs` — the `chosenPlanId` pointer is checked, not trusted (5 assertions)
- `scripts/verify-preflight.sh` — the dev server you are testing is the worktree you are editing
- `scripts/pixdiff.py` — "nothing changed" is a measurement, not an impression

### Rules written down (`docs/design/ui-system.md`)

- §3.6 — who owns "how many people sit here"
- §3.6.1 — how not to fool yourself in the browser (reload-is-not-goto · the console is a log ·
  run the pre-flight · verify through the app's own module graph)
- §3.6.2 — **a provenance comment is a claim to verify, not documentation**
- §4.1.1 — the canvas/UI colour boundary, as a rule
