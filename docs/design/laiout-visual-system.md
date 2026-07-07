# DSource — Laiout-inspired Light Visual System

Status: proposed design system. Supersedes the dark "drafting-instrument" theme
(`styles.css` `:root`, `EditorCanvas.ts` `const C`). Intent source: laiout.co product
screenshots + the brief in this task (authoritative). This document is implementable as-is.

The feel: **white, airy, precise, friendly**. A white floor plate with soft pastel zone
fills, hairline borders, one restrained blue accent, and a clean humanist sans for BOTH
text and numbers (numbers use tabular figures — never monospace). The plan is the hero;
chrome recedes.

---

## 1. Palette — CSS custom properties

Drop this into `:root` in `web/src/styles.css`, replacing the current dark block.

```css
:root {
  /* ---- surfaces (light) ---- */
  --app-bg:        #F7F8FA;   /* app chrome / rails / panels backdrop */
  --surface:       #FFFFFF;   /* cards, panels, top bar */
  --surface-2:     #FBFCFD;   /* subtly recessed inner fills, table stripes */
  --canvas-bg:     #FFFFFF;   /* the floor plate */
  --canvas-mat:    #F2F4F7;   /* area OUTSIDE the building footprint (mat) */
  --overlay-scrim: rgba(23, 26, 30, 0.06); /* hovers, pressed states */

  /* ---- borders / hairlines ---- */
  --hairline:      #E6E8EC;   /* default 1px dividers, card borders */
  --hairline-strong:#D7DBE0;  /* input borders, stronger separation */
  --hairline-focus:#B7C4D6;   /* resting focus-adjacent edges */

  /* ---- ink / text ---- */
  --text:          #1A1D21;   /* primary near-black headlines & values */
  --text-2:        #3A4048;   /* secondary body */
  --muted:         #5C6670;   /* labels, captions (AA on white, ~5.1:1) */
  --eyebrow:       #6E7A84;   /* uppercase letter-spaced eyebrow (AA large) */
  --faint:         #9AA2AD;   /* de-emphasized meta, placeholder */

  /* ---- accent (single, restrained) ---- */
  --accent:        #2D5BD6;   /* indigo-blue: primary actions, selection */
  --accent-hover:  #244CBB;
  --accent-ink:    #FFFFFF;   /* text/icon on accent */
  --accent-soft:   #E8EEFC;   /* accent-tinted fills (selected row, chip halo) */
  --accent-ring:   rgba(45, 91, 214, 0.35); /* focus ring */

  /* ---- semantic ---- */
  --ok:            #2FA36B;   /* confirmed / pass */
  --ok-soft:       #E0F1E8;
  --review:        #E0952B;   /* in-review / caution (amber, used sparingly) */
  --review-soft:   #FBEFD9;
  --danger:        #DE5147;   /* delete / fail */
  --danger-soft:   #FBE6E4;

  /* ---- metric chip solids (white icon on each) ---- */
  --chip-efficiency:#3B6FE0;  /* blue  — efficiency / power */
  --chip-people:    #F0665F;  /* coral — people / capacity */
  --chip-carbon:    #43A96B;  /* green — carbon / leaf */
  --chip-cost:      #2AA1A0;  /* teal  — cost / $ */

  /* ---- ZONE FILLS (pastel) : fill + darker stroke/label per zone ---- */
  /* circulation — soft blue */
  --zone-circ:        #DCEBFB;  --zone-circ-line:      #4A82C4;
  /* open workspace / desks — pale cream-yellow */
  --zone-workspace:   #FBF3D6;  --zone-workspace-line: #B99527;
  /* meeting rooms — pale lavender */
  --zone-meeting:     #E9E3F7;  --zone-meeting-line:   #7E63C0;
  /* collaboration / breakout — pale green */
  --zone-collab:      #DEF1E2;  --zone-collab-line:    #4B9E66;
  /* core / service (WC, stairs, lifts) — light gray */
  --zone-core:        #ECEEF1;  --zone-core-line:      #8B939E;
  /* closed offices — pale peach */
  --zone-office:      #FCE6D6;  --zone-office-line:    #CB8150;
  /* amenity (kitchen, lounge) — pale mint-teal */
  --zone-amenity:     #D9F0EF;  --zone-amenity-line:   #3F9C95;

  /* ---- plan linework ---- */
  --wall:          #2E343B;   /* interior walls (thin dark gray) */
  --wall-ext:      #1E2329;   /* exterior/structural walls (heavier) */
  --furniture:     #8A9099;   /* thin gray furniture line-icons */
  --furniture-2:   #B4B9C1;   /* secondary furniture detail (chair arcs) */
  --grid-minor:    rgba(23, 26, 30, 0.035);
  --grid-major:    rgba(23, 26, 30, 0.075);
  --dim-line:      #2D5BD6;   /* live dimensions use accent */
  --label:         #1A1D21;   /* room labels / dimension text */

  /* ---- rulers ---- */
  --ruler-bg:      #FFFFFF;
  --ruler-text:    #9AA2AD;
  --ruler-tick:    rgba(23, 26, 30, 0.18);

  /* ---- elevation ---- */
  --shadow-sm: 0 1px 2px rgba(23,26,30,0.06), 0 1px 3px rgba(23,26,30,0.04);
  --shadow-md: 0 4px 12px rgba(23,26,30,0.08), 0 1px 3px rgba(23,26,30,0.05);
  --shadow-lg: 0 12px 32px rgba(23,26,30,0.14), 0 2px 8px rgba(23,26,30,0.06);

  /* ---- type ---- */
  --font-ui:  'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif;
  --font-display: 'Schibsted Grotesk', var(--font-ui);
  /* NO mono family. Data = --font-ui with tabular figures (see §2). */

  /* ---- radii ---- */
  --r-xs: 6px; --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-pill: 999px;

  /* ---- layout metrics (kept from current shell) ---- */
  --rail: 56px; --inspector: 340px; --topbar: 52px; --status: 30px;
}
```

### Contrast notes (WCAG)
- `--text #1A1D21` on white ≈ 15.4:1 (AAA).
- `--muted #5C6670` on white ≈ 5.1:1 (AA normal text). Use for labels/captions.
- `--eyebrow #6E7A84` on white ≈ 4.0:1 — only for **large** (>=14px) uppercase letter-spaced
  eyebrows; do not use for small dense text.
- `--accent #2D5BD6` on white ≈ 5.6:1 (AA for text and UI). White on `--accent` ≈ 5.6:1 (AA).
- Zone `*-line` tokens are all >=3:1 on their own pastel fill — safe for 1px strokes and for
  bold zone labels set in the line color.

---

## 2. Typography

Two families, both on `@fontsource` (self-host, matching the current setup):

| Role | Family | @fontsource package | Weights to import |
|------|--------|---------------------|-------------------|
| UI, body, **all data/numbers** | Hanken Grotesk | `@fontsource/hanken-grotesk` | 400, 500, 600, 700 |
| Large display headlines (optional flourish) | Schibsted Grotesk | `@fontsource/schibsted-grotesk` | 500, 700 |

Both ship real **tabular figures**. Numbers stay in the same family as text — enable
`font-feature-settings: 'tnum' 1, 'cv01' 1;` on any element rendering data so columns of
digits align. This replaces IBM Plex Mono everywhere.

```css
/* main.tsx / index: */
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/700.css';

.num { font-feature-settings: 'tnum' 1; font-variant-numeric: tabular-nums; }
```

If you prefer a single family, Hanken Grotesk alone covers everything — set `--font-display`
to `var(--font-ui)` at weight 700. Schibsted is only for the biggest numbers/headlines.

### Type scale

| Token | Use | Size / line | Weight | Letter-spacing | Family |
|-------|-----|-------------|--------|----------------|--------|
| eyebrow | uppercase section labels ("STATISTICS") | 11px / 14 | 600 | +0.09em | ui |
| headline | page/section hero, big metric total | 30px / 34 | 700 | -0.01em | display |
| title | panel titles, selected element name | 17px / 22 | 600 | -0.005em | ui |
| body | descriptions, help text | 14px / 20 | 400 | 0 | ui |
| body-strong | emphasized body | 14px / 20 | 600 | 0 | ui |
| label | metric row labels, field labels | 13px / 16 | 500 | 0 | ui |
| data | metric values, dimensions, coords | 14px / 18 | 600 | 0, **tnum** | ui |
| data-lg | featured numbers (donut center, area/person) | 22px / 26 | 700 | -0.01em, **tnum** | ui |
| caption | meta, vendor, units | 11.5px / 14 | 500 | +0.01em | ui |

Eyebrows are `--eyebrow` colored; headlines/titles/data are `--text`; labels/captions are
`--muted`.

---

## 3. Component specs

### 3.1 App shell
Grid unchanged conceptually: `topbar / [rail | stage | inspector] / statusbar`.

- **Background:** `--app-bg` for the whole shell; cards/panels sit on `--surface` with
  `--hairline` borders and `--shadow-sm`. This gives the layered off-white/white contrast
  Laiout uses (chrome slightly gray, content white).

**Top bar** (`--topbar` = 52px, `background:--surface`, `border-bottom:1px --hairline`):
- Left: brand mark (accent rounded square, 16px) + wordmark in `--font-display` 700, 15px,
  `letter-spacing:0.5px`, `--text`; then a `·` and the document name in `--muted`.
- Center: 2D / 3D segmented control (pill, `--surface-2` track, active = `--surface` chip
  with `--shadow-sm` + `--text`; NOT accent-filled — keep accent for real actions).
- Right: **Export dropdown** (§3.6) + a primary `Generate` button (accent).

**Left rail** (`--rail` = 56px, `background:--surface`, `border-right:1px --hairline`,
flex column, centered):
- Top: round **avatar** (32px, `--r-pill`, `--hairline` ring).
- **Hamburger** icon button (opens nav/menus).
- Divider hairline.
- Tool icon buttons (select, wall, place, dimension…): 40px square, `--r-sm`, icon in
  `--muted`; hover → `--overlay-scrim` bg + `--text`; **active → `--accent-soft` bg,
  `--accent` icon, `1px --accent` inset**.
- **Compass / scale-lock** icon toward the bottom.
- Spacer, then a round **"+" FAB** near the bottom: 44px circle, `--accent` fill, white "+",
  `--shadow-md`; hover `--accent-hover` + lift. This is the "add / generate element" affordance.

Rail tooltips: light popover — `--surface`, `--hairline`, `--shadow-md`, `--text` name +
`--faint` hint. (Current dark tooltip must be re-skinned.)

### 3.2 Right Statistics panel (`--inspector` = 340px)
`background:--surface`, `border-left:1px --hairline`, scrollable.

- **Header tabs:** `Statistics | Regulations` — underline tabs. Active tab: `--text` label +
  2px `--accent` underline; inactive: `--muted`, no underline. Eyebrow-cased is optional; use
  title weight 600, 14px.
- **Metric rows** (Gross External Area, Net Internal Area, Number of Workstations, Area per
  Workstation, Efficiency %, Carbon Footprint kgCO2e, Total Cost $):
  ```
  .metric-row { display:flex; justify-content:space-between; align-items:baseline;
                padding:11px 0; border-bottom:1px solid var(--hairline); }
  .metric-row .label { font: 500 13px/16 var(--font-ui); color:var(--muted); }
  .metric-row .value { font: 600 14px/18 var(--font-ui); color:var(--text);
                       font-variant-numeric: tabular-nums; }
  .metric-row .unit  { color:var(--faint); font-weight:500; margin-left:4px; }
  ```
  Featured rows (Efficiency, Area/Workstation) may lead with a metric chip (§3.4).
- **Sub-tab row:** `Areas | Zones | CO2 | Costs` — a pill segmented control on `--surface-2`.
- **Donut chart** (§3.5) with a **legend list** below: each row = colored square (zone fill,
  1px zone-line border) + zone name (`--text`, 13px) + right-aligned `%` (`--muted`, tnum).

### 3.3 Cards
`background:--surface; border:1px solid var(--hairline); border-radius:var(--r-md);
padding:14px 16px; box-shadow:var(--shadow-sm);`. Section eyebrow at top (`--eyebrow`,
eyebrow scale). Nested recessed blocks use `--surface-2`. Corners soft (12–16px). Never use
hard black borders — hairlines only.

### 3.4 Metric chips
Solid colored circle, white glyph, optional value beside it.
```css
.chip { width:34px; height:34px; border-radius:var(--r-pill);
        display:grid; place-items:center; color:#fff; box-shadow:var(--shadow-sm); }
.chip svg { width:18px; height:18px; }
.chip.efficiency{ background:var(--chip-efficiency); }
.chip.people    { background:var(--chip-people); }
.chip.carbon    { background:var(--chip-carbon); }
.chip.cost      { background:var(--chip-cost); }
```
Pair with a `data-lg` value + `caption` label stacked to the right. Optionally add a faint
same-hue halo `box-shadow: 0 0 0 4px color-mix(in srgb, <hue> 14%, transparent)`.

### 3.5 Donut chart (Areas/Zones/CO2/Costs)
- SVG, ~148px, stroke-based ring, `stroke-width:22`, rounded caps, 2px gaps between segments.
- Segment colors = the **zone fill** tokens (`--zone-*`); on hover raise to the `-line`
  variant. Track/remainder = `--hairline`.
- Center label: `data-lg` total (e.g. NIA m² or total kgCO2e) + `caption` unit under it.
- Legend as described in §3.2. Keep the donut and legend colors identical to the on-canvas
  zone fills so the chart reads as a key to the plan.

### 3.6 Buttons
```css
.btn-primary { background:var(--accent); color:var(--accent-ink); border:0;
  border-radius:var(--r-sm); padding:9px 16px; font:600 13px var(--font-ui);
  box-shadow:var(--shadow-sm); }
.btn-primary:hover { background:var(--accent-hover); }

.btn-secondary { background:var(--surface); color:var(--text);
  border:1px solid var(--hairline-strong); border-radius:var(--r-sm);
  padding:9px 16px; font:600 13px var(--font-ui); }
.btn-secondary:hover { background:var(--surface-2); border-color:var(--faint); }

.btn-ghost { background:transparent; color:var(--accent); border:0;
  padding:8px 12px; font:600 13px var(--font-ui); }
.btn-ghost:hover { background:var(--accent-soft); border-radius:var(--r-sm); }

.btn-danger { color:var(--danger); background:var(--danger-soft); border:0; }
```
Inputs/search: `--surface` bg, `1px --hairline-strong`, `--r-sm`, focus →
`border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-ring)`.

### 3.7 Export dropdown (top-right)
A `.btn-secondary` labeled "Export" with a caret. Opens a `--surface` menu card
(`--r-md`, `--hairline`, `--shadow-lg`, 6px padding). Menu items: 8px radius rows, hover
`--accent-soft`, `--text` label + `--faint` right-hint. Structure with nested submenus:
```
Export CSV
Export PDF
Export 2D ▸   DWG · DXF
Export 3D ▸   IFC · OBJ · RVT
Share…
```
Group separators are `--hairline`. Icons in `--muted`.

### 3.8 The 2D canvas (EditorCanvas rendering)
- **Floor plate:** `--canvas-bg` (white) for the building footprint; area outside the
  footprint painted `--canvas-mat` so the plate reads as a lit sheet on a gray mat.
- **Zone fills:** each room/zone painted with its `--zone-*` fill (flat, ~1.0 alpha — these
  are already pale). Optional 1px inset border in the matching `--zone-*-line`. Zone **label**
  set in the `-line` color, `--font-ui` 600, uppercase small (or title case), placed
  top-left of the zone.
- **Walls:** interior `--wall` at ~1.5px device-independent; exterior/structural `--wall-ext`
  at ~3px. Thin, crisp, dark gray — never pure black.
- **Furniture line-icons:** stroke `--furniture` ~1px, secondary detail (chair arcs, monitor)
  `--furniture-2`. No fills — line drawings, matching Laiout's technical furniture glyphs.
  Desks render as a rectangle + a chair arc.
- **Grid:** `--grid-minor` / `--grid-major` (dark-on-light, very low alpha). Origin axis in
  `--accent` at low alpha.
- **Selection:** 1.5px `--accent` outline + `--accent-ring` glow; drag handles = white
  squares with `--accent` border.
- **Live dimensions:** `--dim-line` (accent) witness/extension lines; dimension text in
  `--label`, tnum.
- **Decision state dots:** Confirmed `--ok`, InReview `--review`, Open `--faint`.
- **Rulers:** `--ruler-bg` gutter, `--ruler-text` numerals (tnum), `--ruler-tick` marks.

---

## 4. Migration note (concrete)

### 4.1 `web/src/styles.css`
1. Replace the entire `:root{…}` dark block (lines ~1–32) with the **§1** token block.
2. Global find-and-map the old tokens to new (same variable names reused where possible so
   most rules keep working):
   - `--shell` → remove; use `--app-bg` (chrome) or `--surface` (bars). Update `.topbar`,
     `.rail`, `.statusbar` `background` from `--shell` to `--surface`.
   - `--panel`, `--panel-2` → `--surface` / `--surface-2`.
   - `--line`, `--line-soft` → `--hairline` / `--hairline` (soft dividers).
   - `--text`, `--muted`, `--faint` → keep names (values now dark-on-light).
   - `--accent`, `--accent-ink`, `--accent-soft` → keep names (now blue, white, `#E8EEFC`).
   - `--ok`, `--review`, `--danger` → keep names (new light-theme hexes).
3. `body`: `background:var(--app-bg)`. Remove `-webkit-font-smoothing:antialiased`? keep it.
4. Delete `--font-mono` and the `.mono` rule; replace `.mono` usages with a `.num` class:
   `font-family:var(--font-ui); font-variant-numeric:tabular-nums;`. Grep `class="mono"` /
   `mono` in `web/src` and swap. (`EditorCanvas.ts` `.loading` uses `--font-mono` — switch to
   `--font-ui`.)
5. Re-skin the two things that assumed dark: `.rail-tip` (was `#0a0b0d` bg) → `--surface` bg,
   `--hairline` border, `--shadow-md`; `.seg.on` in the mode toggle → use the light segmented
   pattern (§3.1) instead of accent fill.
6. Active states that filled with accent (`.seg.on`, tool `.rail-btn.on`) already reference
   `--accent`/`--accent-soft` — they now render correctly against light; just verify the
   accent-ink text stays white where the background is solid accent.
7. Swap fonts in the entry file (main.tsx): remove the IBM Plex Mono + Space Grotesk
   `@fontsource` imports; add the Hanken Grotesk (400/500/600/700) and Schibsted Grotesk
   (500/700) imports from **§2**. Update `package.json` deps accordingly.

### 4.2 `web/src/editor/EditorCanvas.ts`
Replace the `const C` palette (lines ~86–100) and `DECISION_DOT` (lines ~102–106). Prefer
reading CSS variables via `getComputedStyle(document.documentElement).getPropertyValue(…)`
so the canvas and CSS share one source of truth; or hardcode the mapped hexes:

```ts
// Light "floor-plate" palette — mirrors styles.css tokens.
const C = {
  surface:    '#FFFFFF',   // floor plate
  mat:        '#F2F4F7',   // outside footprint
  gridMinor:  'rgba(23,26,30,0.035)',
  gridMajor:  'rgba(23,26,30,0.075)',
  axis:       'rgba(45,91,214,0.20)',
  wall:       '#2E343B',
  wallExt:    '#1E2329',
  furniture:  '#8A9099',
  preview:    'rgba(45,91,214,0.70)',
  accent:     '#2D5BD6',
  label:      '#1A1D21',
  rulerBg:    '#FFFFFF',
  rulerCorner:'#F7F8FA',
  rulerText:  '#9AA2AD',
  rulerTick:  'rgba(23,26,30,0.18)',
}
const DECISION_DOT: Record<string, string> = {
  Confirmed: '#2FA36B',
  InReview:  '#E0952B',
  Open:      '#9AA2AD',
}
// Zone fills (add): map layout category → { fill, line }
const ZONE: Record<string, { fill: string; line: string }> = {
  circulation: { fill:'#DCEBFB', line:'#4A82C4' },
  workspace:   { fill:'#FBF3D6', line:'#B99527' },
  meeting:     { fill:'#E9E3F7', line:'#7E63C0' },
  collab:      { fill:'#DEF1E2', line:'#4B9E66' },
  core:        { fill:'#ECEEF1', line:'#8B939E' },
  office:      { fill:'#FCE6D6', line:'#CB8150' },
  amenity:     { fill:'#D9F0EF', line:'#3F9C95' },
}
```

- In `drawBackground`, fill the viewport with `C.mat`, then fill the footprint rect with
  `C.surface`. Grid strokes now use the dark-on-light `gridMinor/Major`.
- `hexA(color, alpha)` for component fills: current code fills components at 0.4/0.9 alpha of
  their `catalog` color. Under the light theme, either (a) keep component color fills but
  lower alpha (~0.18 resting) so they read as pastel, or (b) migrate `catalog.ts` colors to
  the `ZONE` fills and draw furniture as line-icons in `C.furniture`. Recommended: **(b)** —
  update `web/src/editor/catalog.ts` colors to the pastel zone fills so 2D/3D and the donut
  legend stay in sync (Desk→workspace, MeetingRoom→meeting, Table→collab, Chair→furniture
  line, FallCeiling→core).
- Wall rendering: split interior vs exterior stroke widths using `C.wall` / `C.wallExt`.

### 4.3 `web/src/three/` (3D)
Match materials to the same tokens: floor `--canvas-bg`, zone floor tints from `--zone-*`,
walls `--wall-ext`, a soft neutral studio background (`--app-bg`). Keep the read-only
walkthrough but light it warm-neutral to match the 2D plate.

---

## 5. Summary of decisions
- **Light theme, layered off-white chrome (`#F7F8FA`) over white content/plate (`#FFFFFF`).**
- **One accent:** indigo-blue `#2D5BD6` (actions + selection). Amber demoted to the `--review`
  semantic only.
- **Zone pastels** are the visual signature — 7 zones, each a fill + darker line/label, reused
  identically on canvas, in the donut, and in 3D.
- **Fonts:** Hanken Grotesk (UI + all numbers, tabular figures) + optional Schibsted Grotesk
  for big headlines. **Monospace removed.**
- **Metric chips:** four solid circles (blue/coral/green/teal) with white glyphs.
- Hairline borders, soft 12–16px radii, subtle layered shadows; the plan stays the hero.
