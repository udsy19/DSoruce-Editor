# F9 — No gate between a failed import and the priced deliverable

**Severity: High** · **Affects every failure mode above**

---

## What was observed

Driven through the real UI in Chrome (Playwright), using the user's actual path —
project → Space → upload → Next → Next.

**With `call-center-offices.dwg`, for which no plate is traced at all:**

1. Space step reports `USABLE AREA — m², no plate traced`, `COMPONENTS 0`, `ROOMS 0`
   (`screens/callcenter-no-plate.png`).
2. **`Next: Program` is enabled.** Clicked → advances to `#/…/program`.
3. Program step accepts a full brief; **`Next: Generate` is enabled.** Clicked → `#/…/generate`.
4. Generate step renders (`screens/callcenter-generate-step.png`):

   > **Pick a test-fit** · "The engine generated a few alternatives against your program."
   > **3 ALTERNATIVES · BEST 41/100**
   > A · Open **27**/100 — B · Balanced **33**/100 — C · Cellular **41**/100

   Three scored candidate cards with **completely blank thumbnails**, each offering "Open in editor"
   into Review → Design → Visualise → Share.

At no point does the UI say the import failed. The step rail shows Property ✓ Space ✓ Program ✓.

## The gap

The wizard gates only on *"has a file been uploaded"*, not on *"did the import produce something
usable"*. Three states are treated identically:

| State | Should be | Actually is |
|---|---|---|
| plate traced, plausible area, furniture placed | proceed | proceeds |
| plate traced, 2.5 m², **0 desks placed** | blocked / warned | proceeds silently ([F4](F4-empty-plan-scored-as-success.md)) |
| **no plate at all** | blocked | proceeds silently |

The information needed for the gate already exists and is already correct — `derivePlate` returned
`null`, `plate.provenance.confidence` is `'low'`, `placed_desks` is `0`. Nothing consumes it as a
precondition.

## Related smaller defects observed on the same path

- **The drawing is lost on backward navigation.** Returning to Space from Generate showed the empty
  "Drop a CAD floor plan" dropzone again, with the uploaded drawing gone — while `Next: Program`
  remained enabled, so the user can advance from a Space step with *no file at all*.
- **`GET /api/dwg` returns 405 into the console** on page load (`Failed to load resource: 405
  (Method Not Allowed)`). Harmless, but it is the only error in a clean console and will mask real
  ones.

## What works and should be preserved

The low-confidence plate path is **correct and well built**, and any fix should route through it
rather than around it. On `BUSNSS-Offcs-Trdtnl_AG.dwg` the UI showed:

> **Check the floor plate.** No closed building shell was found, so this boundary is a best-fit
> outline — 78 % of it was bridged across gaps rather than traced. Confirm or adjust it.
> **[Confirm boundary]**

and refused to print a hard area (`≈ 3 m²`, "approximate — confirm the boundary"). That is
`plateQuality.ts` doing exactly its job, per ADR 0003's discipline of never printing a hard number
for an unverified plate. The gap is that **this mechanism has no equivalent for "the plate is the
wrong size" or "the generator placed nothing"** — see [F1](F1-unit-scale-trusted-blindly.md) and
[F4](F4-empty-plan-scored-as-success.md).

## Reproduce

```bash
cd web && pnpm dev
```
Upload `cad-validation/raw/call-center-offices.dwg` at the Space step, then press Next twice.
