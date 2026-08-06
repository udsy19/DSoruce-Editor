# C10 / G10 — the naive-user walkthrough

**This is the one gate no machine writes.** Nine automated gates prove the code
does what it was told. This one asks whether the result *reads* right to someone
who has not been in the conversation — which is the only question the whole
workstream was ever about.

The verdict line at the bottom is deliberately blank. An agent filling it in
would be producing the artifact whose entire worth is that a human produced it
(`.claude/rules/gate-independence.md` — *an agent must never perform or simulate
a trusted-human event*).

---

## Setup

```bash
./run.sh                       # or: cd web && pnpm dev --port 5199 --strictPort
```

Use a port that is not 5173 — parallel worktrees hold it and a `--strictPort`
server from another branch answers normally while serving someone else's code.

## Script

Walk it as a first-time user. Do not consult the code, and do not read the rest
of this file until the verdict is written.

1. **Landing → Start a project.** Name it anything.
2. **Space.** Drop `samples/furniture-plan.dxf`. Confirm the inferred boundary
   when prompted.
3. **Program.** Accept the defaults.
4. **Generate.** Look at the three candidate cards *before* opening one.
5. **Open in editor** on any candidate.
6. In the editor: look at the plan at the zoom it opens at. Then zoom in on a
   corner of the floor that carries no furniture.
7. Click on a corridor. Then click on a pale hatched area, if you see one.
8. Toggle **Presentation** (the "Paper" control, or press `p`).
9. Switch to **3D** and orbit once.
10. **Export → PDF** (or the Deliverable pack) and open the sheet.

## The question

> **Does white space read as floor, coloured space as program — with nothing on
> the plan saying "circulation" anywhere?**

Sub-questions, if it helps to be specific. Answer from what you saw, not from
what you expected:

| # | | |
|---|---|---|
| a | At the zoom it opens at, does the plan read as *rooms on a floor*, or as *a diagram of coloured regions*? | |
| b | Is there any text on the plan naming the floor itself (CIRCULATION, CORRIDOR, UNASSIGNED)? | |
| c | On the candidate cards, does any plan read as a grey blob? | |
| d | The faint hatched areas: do they read as *"this floor is wasted"*, or as *a third kind of room*? | |
| e | Could you still select and identify a corridor when you clicked one? | |
| f | On the paper sheet and in 3D, is the floor plain? | |
| g | Anything that looked wrong and is not covered above? | |

## What changed, for context AFTER you have answered

Do not read this before writing the verdict — it describes what was intended,
and knowing it makes (a)–(g) harder to answer honestly.

<details>
<summary>Expand after answering</summary>

Leftover floor used to be labelled `Circulation` wholesale: 170.66 m² on this
plate, 57.7% of everything the plan called circulation, including an 80 m² wing.
It is now classified — `Circulation` only where a pocket can host a ≥1.2 m
code-width path connected to the drawn network over ≥50% of its area and is
path-shaped; otherwise `Unassigned`, which is a finding, not a program.

Split: Circulation 295.89 → 213.16 m²; Unassigned 82.74 m². Workstations
unchanged at 101, efficiency unchanged at 61.63%, published totals byte-exact.
Resting zone tags 24 → 7, of which ground 17 → 0. Candidate cards: 1 226 px of
circulation grey → 0.

</details>

---

## VERDICT

*To be completed by a human. Leave blank until the walkthrough is run.*

- **Date:**
- **Who:**
- **Build / commit:**

**Answer to the question (pass / fail / qualified):**

```
```

**Notes, per sub-question:**

```
a.
b.
c.
d.
e.
f.
g.
```
