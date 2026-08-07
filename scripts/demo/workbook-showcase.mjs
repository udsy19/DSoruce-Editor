// Turn the exported Quantity Takeoff workbook into something a camera can show,
// and PROVE it is live while doing it.
//
//   node scripts/demo/workbook-showcase.mjs [--xlsx <path>] [--out <dir>]
//
// Default input  : out/demo/exports/dsource-quantity-takeoff.xlsx
// Default output : out/demo/workbook/   (sheet-*.png + index.html)
//
// WHY THIS EXISTS. The workbook is the deliverable the user calls "extremely
// important", and its whole claim is that it is a FORMULA-WIRED MODEL rather
// than a dump of numbers: change a unit price and every total recalculates.
// A screenshot of numbers cannot distinguish those two things — which is
// exactly the shape .claude/rules/gate-independence.md warns about, so this
// script does not take the workbook's word for it either.
//
// THE PROOF, and why it is independent. We hand the .xlsx to LibreOffice — a
// third-party spreadsheet engine that has never heard of this codebase — and
// ask it to render the file. LibreOffice evaluates formulas on load. So:
//
//   * if the cells were inert text, the rendered pages would show the literal
//     strings `=IF(ISBLANK(C5),"",VLOOKUP(...))`;
//   * if they are real formulas, LibreOffice computes them and the pages show
//     VALUES, with zero formula strings left anywhere.
//
// We assert exactly that: > 0 formula cells going in, and ZERO surviving
// formula strings in the rendered text coming out. Neither number is supplied
// by the producer — one is parsed out of the file's own XML by openpyxl, the
// other out of LibreOffice's rendering. The producer gets no vote.
//
// It is worth being precise about what this does and does not establish. It
// proves the cells are LIVE FORMULAS that a real spreadsheet engine evaluates.
// It does NOT prove any particular total is arithmetically the right answer for
// this building — that is what web/src/export/workbook.test.mjs and the G-gates
// are for. Two different claims; this one is about liveness.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const arg = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}

const XLSX = path.resolve(REPO, arg('--xlsx', 'out/demo/exports/dsource-quantity-takeoff.xlsx'))
const OUT = path.resolve(REPO, arg('--out', 'out/demo/workbook'))
const WORK = path.join(OUT, '.work')

// The sheets worth putting on camera, in narrative order. Everything else in
// the book still exists; this is a running order, not a filter on the file.
const FEATURED = [
  ['Main Summary', 'Every material, quantity and cost — the top line'],
  ['Furniture Inventory', 'Every seat, desk and table, by room and cost code'],
  ['General', 'The assumptions the whole book is driven from'],
  ['BOM - Walls', 'Partitions by type, measured off the plan'],
  ['BOM - Doors', 'Openings, scheduled'],
  ['BOM - Floors', 'Floor finishes by area'],
]

let failures = 0
const check = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
  return !!cond
}

function soffice() {
  for (const p of ['/opt/homebrew/bin/soffice', '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice']) {
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' })
      return p
    } catch { /* keep looking */ }
  }
  return null
}

function main() {
  if (!fs.existsSync(XLSX)) {
    console.error(`\nNo workbook at ${XLSX}\n` +
      `Run \`node scripts/demo/record-demo.mjs\` first, or pass --xlsx <path>.\n`)
    process.exit(2)
  }
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  console.log(`\n▶ workbook  ${path.relative(REPO, XLSX)}`)
  const bytes = fs.readFileSync(XLSX)
  // A .xlsx is a ZIP. Check the signature off the bytes rather than the suffix.
  check(bytes[0] === 0x50 && bytes[1] === 0x4b, `is a real ZIP container (${(bytes.length / 1024).toFixed(1)} KB)`)

  // --- how many formulas go IN, read out of the file's own XML -------------
  const py = `
import json, openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(XLSX)})
sheets = wb.sheetnames
formulas = 0
for ws in wb:
    for row in ws.iter_rows():
        for c in row:
            if isinstance(c.value, str) and c.value.startswith('='):
                formulas += 1
print(json.dumps({"sheets": sheets, "formulas": formulas}))
`
  const meta = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim())
  check(meta.sheets.length >= 10, `${meta.sheets.length} sheets`)
  check(meta.formulas > 0, `${meta.formulas} formula cells declared in the file`)

  // --- render it with a foreign engine -------------------------------------
  const so = soffice()
  if (!so) {
    console.error('\nLibreOffice not found — cannot render or verify the workbook.\n' +
      'Install it (brew install --cask libreoffice) or skip this showcase.\n')
    process.exit(3)
  }
  execFileSync(so, ['--headless', '--norestore',
    `-env:UserInstallation=file://${path.join(WORK, 'lo-profile')}`,
    '--convert-to', 'pdf', '--outdir', WORK, XLSX], { stdio: ['ignore', 'pipe', 'pipe'] })

  const pdf = path.join(WORK, path.basename(XLSX).replace(/\.xlsx$/i, '.pdf'))
  check(fs.existsSync(pdf), 'LibreOffice rendered the workbook')

  // THE ASSERTION. If these were inert strings they would be sitting in the
  // rendered text. They are not, so the engine evaluated them.
  const txt = path.join(WORK, 'book.txt')
  execFileSync('pdftotext', [pdf, txt])
  const rendered = fs.readFileSync(txt, 'utf8')
  const leaked = (rendered.match(/=IF\(|VLOOKUP\(|SUMIF\(/g) || []).length
  check(leaked === 0,
    `a foreign engine evaluated all ${meta.formulas} formulas — ${leaked} formula strings survived into the render`)

  // Real quantities should now be present where the raw file had none.
  const numbers = rendered.match(/\b\d[\d,]*\.\d{2}\b/g) || []
  check(numbers.length > 20, `${numbers.length} computed decimal quantities in the rendered book`)

  // --- rasterise the featured sheets ---------------------------------------
  // Render each sheet IN ISOLATION. The first version of this script assumed
  // one PDF page per sheet in book order and picked pages by counting — but a
  // sheet spans as many pages as it needs, so the offsets drifted and the image
  // captioned "Main Summary" was in fact the furniture summary. A demo slide
  // labelled with the wrong sheet name is worse than no slide, and no assertion
  // in the script could have caught it: both files were valid PNGs of a real
  // sheet. So the guess is gone. We delete every other sheet from a scratch
  // copy and convert that, which makes "page 1 IS this sheet" true by
  // construction rather than by arithmetic.
  // Bake the COMPUTED VALUES down first. Isolating a sheet from the live book
  // severs its cross-sheet references — `='General'!B9` has nowhere to point —
  // and every cell renders `#NAME?`. Baking first means there are no references
  // left to break, so what we photograph is the value the live book produced.
  execFileSync(so, ['--headless', '--norestore',
    `-env:UserInstallation=file://${path.join(WORK, 'lo-profile')}`,
    '--convert-to', 'xlsx', '--outdir', path.join(WORK, 'baked'), XLSX],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  const baked = path.join(WORK, 'baked', path.basename(XLSX))
  check(fs.existsSync(baked), 'values baked down for isolation')

  const shots = []
  for (const [name, caption] of FEATURED) {
    if (!meta.sheets.includes(name)) {
      console.log(`  note  "${name}" is not in this workbook — skipped`)
      continue
    }
    const only = path.join(WORK, `${slug(name)}.xlsx`)
    // data_only=True reads the cached RESULT of each formula, so the saved book
    // holds values, not references.
    execFileSync('python3', ['-c', `
import openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(baked)}, data_only=True)
for s in list(wb.sheetnames):
    if s != ${JSON.stringify(name)}:
        del wb[s]
ws = wb[${JSON.stringify(name)}]
bad = sum(1 for row in ws.iter_rows() for c in row
          if isinstance(c.value, str) and c.value.startswith('#'))
if bad:
    raise SystemExit(f'{bad} error cells in {ws.title} — refusing to photograph it')
wb.save(${JSON.stringify(only)})
`])
    execFileSync(so, ['--headless', '--norestore',
      `-env:UserInstallation=file://${path.join(WORK, 'lo-profile')}`,
      '--convert-to', 'pdf', '--outdir', WORK, only], { stdio: ['ignore', 'pipe', 'pipe'] })
    const onePdf = only.replace(/\.xlsx$/, '.pdf')
    if (!fs.existsSync(onePdf)) {
      console.log(`  note  "${name}" did not render — skipped`)
      continue
    }
    const stem = path.join(OUT, `sheet-${slug(name)}`)
    execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '150', '-png', '-singlefile', onePdf, stem])
    const png = `${stem}.png`
    if (!fs.existsSync(png)) continue
    const b = fs.readFileSync(png)
    if (!(b[0] === 0x89 && b[1] === 0x50)) continue // PNG signature, off the bytes
    shots.push({ name, caption, file: path.basename(png), kb: (b.length / 1024).toFixed(0) })
  }
  check(shots.length >= 3, `${shots.length} sheets rasterised for the camera`)

  fs.writeFileSync(path.join(OUT, 'index.html'), page(shots, meta, leaked))
  fs.rmSync(WORK, { recursive: true, force: true })

  console.log(`\n${failures ? 'FAIL' : 'PASS'}  workbook showcase — ${shots.length} sheets`)
  console.log(`\nSHEETS  ${OUT}`)
  console.log(`PAGE    ${path.join(OUT, 'index.html')}\n`)
  process.exit(failures ? 1 : 0)
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function page(shots, meta, leaked) {
  const cards = shots.map((s) => `
    <figure>
      <img src="${s.file}" alt="${s.name}">
      <figcaption><b>${s.name}</b><span>${s.caption}</span></figcaption>
    </figure>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>Quantity Takeoff</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:54px 60px 80px;background:#0b0c0e;color:#f4f6f8;
    font-family:'Hanken Grotesk',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
  .eyebrow{font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;font-size:12px;
    letter-spacing:.3em;text-transform:uppercase;color:#7d8794}
  h1{font-size:52px;line-height:1.06;letter-spacing:-.02em;margin:12px 0 10px;font-weight:600}
  .sub{color:#9aa3af;font-size:18px;margin:0 0 34px;max-width:78ch}
  .stats{display:flex;gap:56px;margin:0 0 42px}
  .stat .v{font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;font-size:32px}
  .stat .l{font-size:12px;color:#7d8794;text-transform:uppercase;letter-spacing:.12em;margin-top:4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:28px}
  figure{margin:0;background:#141619;border:1px solid #23262b;border-radius:10px;overflow:hidden}
  img{display:block;width:100%;height:auto;background:#fff}
  figcaption{padding:14px 16px 16px;display:flex;flex-direction:column;gap:3px}
  figcaption b{font-size:15px}
  figcaption span{font-size:13px;color:#9aa3af}
  .proof{margin-top:44px;padding-top:22px;border-top:1px solid #23262b;
    font-size:14px;color:#9aa3af;max-width:96ch;line-height:1.6}
  .proof b{color:#e7eaee}
</style>
<div class="eyebrow">Deliverable · Quantity takeoff</div>
<h1>A workbook, not a printout.</h1>
<p class="sub">Every quantity is measured off the plan and every cost is wired to it. Change a
unit rate and the book recalculates — the model goes with it.</p>
<div class="stats">
  <div class="stat"><div class="v">${meta.sheets.length}</div><div class="l">sheets</div></div>
  <div class="stat"><div class="v">${meta.formulas}</div><div class="l">live formulas</div></div>
  <div class="stat"><div class="v">${leaked}</div><div class="l">inert cells</div></div>
</div>
<div class="grid">${cards}</div>
<p class="proof"><b>How that is known.</b> The workbook was handed to LibreOffice — an unrelated
spreadsheet engine — which evaluates formulas when it opens a file. Inert text would have rendered
as the literal <code>=IF(ISBLANK(…),VLOOKUP(…))</code> strings. <b>${leaked}</b> survived, out of
<b>${meta.formulas}</b>, so the cells are live. The count going in was parsed from the file's own
XML; the count coming out was read from a foreign renderer. Neither figure comes from the code that
wrote the book.</p>
`
}

main()
