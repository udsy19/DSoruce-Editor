// SG6 — DETERMINISM + GATE INDEPENDENCE.  The harness renders the same bytes
// every time, and no sheet gate is reading the producer's account of its own
// work.
//
//   node scripts/gates/sheets/sg6-determinism.mjs
//
// PART A — DETERMINISM.  A second, independent full render must be
// byte-identical to the one on disk, per PNG, for all 33 sheets. (Digests, not
// a whole-file image compare: `reports/sheets-S0-1.md` §7.1 — font substitution
// is machine-local, so a digest is only ever compared against ANOTHER RUN ON
// THIS MACHINE, never against a recorded constant. No gate here hashes a sheet
// against a checked-in value.)
//
// PART B — INDEPENDENCE, in the `floorRectPurity` shape
// (`.claude/rules/gate-independence.md` §"The required demonstration").
// Three copies of the harness output:
//
//   A  pristine
//   B  every producer-supplied hint CORRUPTED — both `index.json` manifests
//      replaced with garbage, and inside every `geometry.json` the fields the
//      harness MEASURED or NAMED rather than derived (`page.wPx/hPx`, `image`,
//      `title`, `id`, `no`, `kind`, `index`, `derivedFrom`, `units`, `note`)
//      replaced with impossible values
//   C  the same hints DELETED outright
//
// Each of SG1-SG4 is run against all three and its complete output — stdout and
// stderr, byte for byte — must be identical. An assertion that the gates "still
// pass" would prove nothing (they are red); identical bytes prove those fields
// were never consulted.
//
// PART C — THE COMPLEMENT.  What the gates DO consume must be load-bearing and
// must fail loudly:
//   * delete a `geometry.json` → SG1 fails with a named missing-input error,
//     never a skip;
//   * move the `titleBlock` rect → SG1 fails with the template-drift error,
//     because geometry.json is admissible only as VALIDATED metadata.
//
// ---------------------------------------------------------------------------
// FAIL-FIRST — this gate, like SG5, must be GREEN at HEAD, and is:
//
//   $ node scripts/gates/sheets/sg6-determinism.mjs
//   SG6 PASS (16 checks)
//     A: 33/33 PNGs byte-identical across two independent renders
//     B: SG1 identical over {pristine, corrupted, deleted} (2060 B each)
//     B: SG2 identical over {pristine, corrupted, deleted} (860 B each)
//     B: SG3 identical over {pristine, corrupted, deleted} (2686 B each)
//     B: SG4 identical over {pristine, corrupted, deleted} (684 B each)
//     C: a deleted geometry.json fails SG1 by name; a moved titleBlock rect
//        fails SG1 with the template-drift message
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { REPO, SHEETS_DIR, PACKS, runGate, GateError } from './lib/sheetlib.mjs'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

/** Producer-supplied hints a gate could plausibly be reading, but must not. */
const MEASURED_FIELDS = ['image', 'title', 'id', 'no', 'kind', 'index', 'derivedFrom', 'units', 'note']

function pngDigests(dir) {
  const out = new Map()
  for (const pack of PACKS) {
    const d = path.join(dir, pack)
    if (!fs.existsSync(d)) throw new GateError(`missing input: ${d} — render the sheets first`)
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.png')).sort()) {
      out.set(`${pack}/${f}`, sha(fs.readFileSync(path.join(d, f))))
    }
  }
  if (out.size === 0) throw new GateError(`${dir}: no PNGs`)
  return out
}

function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })
}

function sabotage(dir, mode) {
  for (const f of ['index.json', ...PACKS.map((p) => path.join(p, 'index.json'))]) {
    const file = path.join(dir, f)
    if (!fs.existsSync(file)) throw new GateError(`missing input: ${file} — the harness manifest should exist`)
    if (mode === 'corrupt') fs.writeFileSync(file, '{"packs":"NOT A MANIFEST","sheetCount":-1,"sha256":"0"}\n')
    else fs.rmSync(file)
  }
  for (const pack of PACKS) {
    for (const f of fs.readdirSync(path.join(dir, pack)).filter((x) => x.endsWith('.geometry.json'))) {
      const file = path.join(dir, pack, f)
      const g = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (mode === 'corrupt') {
        g.page.wPx = 1
        g.page.hPx = 1
        g.page.note = 'CORRUPTED'
        for (const k of MEASURED_FIELDS) g[k] = 'CORRUPTED'
      } else {
        delete g.page.wPx
        delete g.page.hPx
        delete g.page.note
        for (const k of MEASURED_FIELDS) delete g[k]
      }
      fs.writeFileSync(file, JSON.stringify(g, null, 2) + '\n')
    }
  }
}

function runGateAt(gate, sheetsDir) {
  const file = path.join(REPO, 'scripts/gates/sheets', gate)
  try {
    const out = execFileSync('node', [file], {
      cwd: REPO,
      encoding: 'buffer',
      env: { ...process.env, SHEETS_OUT: sheetsDir },
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return Buffer.concat([out])
  } catch (err) {
    return Buffer.concat([err.stdout ?? Buffer.alloc(0), err.stderr ?? Buffer.alloc(0)])
  }
}

const GATES = ['sg1-panel-containment.mjs', 'sg2-plate-confinement.mjs', 'sg3-label-integrity.mjs', 'sg4-name-uniqueness.mjs']

async function main() {
  return runGate('SG6', (c) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg6-'))
    try {
      // --- A: two independent renders ------------------------------------
      const second = path.join(tmp, 'render2')
      execFileSync('node', [path.join(REPO, 'scripts/sheets/render-all.mjs'), '--pack', 'all', '--out', second], {
        cwd: REPO,
        stdio: 'pipe',
        maxBuffer: 64 << 20,
      })
      const a = pngDigests(SHEETS_DIR)
      const b = pngDigests(second)
      c.ok('the second render has the same sheets', a.size === b.size, `${a.size} vs ${b.size} PNGs`)
      const drift = [...a.entries()].filter(([k, v]) => b.get(k) !== v)
      c.ok(
        `all ${a.size} PNGs are byte-identical across two independent renders`,
        drift.length === 0,
        drift.map(([k]) => k).join(' '),
      )
      c.note(`A: ${a.size - drift.length}/${a.size} PNGs byte-identical across two independent renders`)

      // --- B: independence under sabotage ---------------------------------
      const A = path.join(tmp, 'A')
      const B = path.join(tmp, 'B')
      const C = path.join(tmp, 'C')
      copyTree(SHEETS_DIR, A)
      copyTree(SHEETS_DIR, B)
      copyTree(SHEETS_DIR, C)
      sabotage(B, 'corrupt')
      sabotage(C, 'delete')
      for (const gate of GATES) {
        const oa = runGateAt(gate, A)
        const ob = runGateAt(gate, B)
        const oc = runGateAt(gate, C)
        const id = gate.slice(0, 3).toUpperCase()
        c.ok(`${id} output is non-empty`, oa.length > 0, 'the gate printed nothing')
        c.ok(
          `${id} is byte-identical with every producer hint CORRUPTED`,
          oa.equals(ob),
          `pristine ${oa.length} B (${sha(oa).slice(0, 12)}), corrupted ${ob.length} B (${sha(ob).slice(0, 12)})`,
        )
        c.ok(
          `${id} is byte-identical with every producer hint DELETED`,
          oa.equals(oc),
          `pristine ${oa.length} B (${sha(oa).slice(0, 12)}), deleted ${oc.length} B (${sha(oc).slice(0, 12)})`,
        )
        c.note(`B: ${id} identical over {pristine, corrupted, deleted} (${oa.length} B each)`)
      }

      // --- C: what IS consumed must be load-bearing ------------------------
      const D = path.join(tmp, 'D')
      copyTree(SHEETS_DIR, D)
      fs.rmSync(path.join(D, 'seeded', 'A02.geometry.json'))
      const missing = runGateAt(GATES[0], D).toString('utf8')
      c.ok(
        'a deleted geometry.json fails SG1 by name, never a skip',
        /SG1 FAIL/.test(missing) && /missing input: .*A02\.geometry\.json/.test(missing),
        missing.split('\n').filter((l) => /missing|SG1/.test(l)).slice(0, 2).join(' | '),
      )

      const E = path.join(tmp, 'E')
      copyTree(SHEETS_DIR, E)
      const gf = path.join(E, 'seeded', 'A02.geometry.json')
      const g = JSON.parse(fs.readFileSync(gf, 'utf8'))
      g.titleBlock.pt.y -= 200
      g.titleBlock.px.y -= 400
      fs.writeFileSync(gf, JSON.stringify(g, null, 2) + '\n')
      const moved = runGateAt(GATES[0], E).toString('utf8')
      c.ok(
        'a moved titleBlock rect fails SG1 with the template-drift message',
        /SG1 FAIL/.test(moved) && /but the template says/.test(moved),
        moved.split('\n').filter((l) => /template|SG1/.test(l)).slice(0, 2).join(' | '),
      )
      c.note('C: a deleted geometry.json fails SG1 by name; a moved titleBlock rect fails SG1 with the template-drift message')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}

process.exit((await main()) ? 0 : 1)
