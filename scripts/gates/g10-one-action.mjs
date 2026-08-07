#!/usr/bin/env node
// G10 — One-action UX.
//
// Every earlier gate can pass while the product still requires a designer to
// click six different export buttons. This gate proves the whole pack falls out
// of ONE action: find the "Export deliverable pack" control, click it once, and
// wait for all five artifacts to appear — COMPLETE, not merely touched.
//
//   xlsx + 4 renders + mp4 + a share link, from a single click.
//
// Usage: g10-one-action.mjs [--base http://localhost:5173] [--out out]
//                           [--selector "[data-testid=export-deliverable-pack]"]
//                           [--timeout 300000] [--verify-only]
//
// --verify-only skips the browser and just asserts the artifacts are present
// and complete. `run-all.sh` uses it as the suite's closing integrity pass, so
// the board can never be green about files that were overwritten mid-run.
//
// WHY "COMPLETE" IS THE WHOLE POINT (defect D2, reports/defects-1.md): readiness
// used to be "the mtime moved" plus "the mp4 is over 100 KB". ffmpeg touches the
// mtime on its FIRST byte and passes 100 KB seconds later, so this gate declared
// the pack done ~36 s before the video finished — `ffprobe` answered
// "moov atom not found" at the instant it printed PASS. Now every artifact must
// PARSE: the mp4 must decode and report a duration in the spec's range, the
// workbook must be a complete zip, the images must carry their end markers, and
// the JSON must load. The producer writes atomically (deploy/packStore.ts), so
// "complete" and "published" are the same instant; this is the belt to that
// brace.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as L from './lib/gatelib.mjs'

const RENDERS = ['Reception', 'Open_space', 'Work_stations', 'Conference_room']

function present(p) {
  return fs.existsSync(p) && fs.statSync(p).size > 0
}

/** Tail of a file, for trailer/marker checks. */
function tail(p, n) {
  const size = fs.statSync(p).size
  const len = Math.min(n, size)
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(p, 'r')
  try {
    fs.readSync(fd, buf, 0, len, size - len)
  } finally {
    fs.closeSync(fd)
  }
  return buf
}

function head(p, n) {
  const buf = Buffer.alloc(n)
  const fd = fs.openSync(p, 'r')
  try {
    fs.readSync(fd, buf, 0, n, 0)
  } finally {
    fs.closeSync(fd)
  }
  return buf
}

/** Decoded duration in seconds, or an explanation of why it would not decode. */
function videoDuration(p) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nokey=1', p],
    { encoding: 'utf8' },
  )
  if (r.error) {
    return { error: `ffprobe could not be run (${r.error.code ?? r.error.message}) — the gate ` +
      'cannot confirm the video decoded; install ffmpeg' }
  }
  if (r.status !== 0) {
    const why = String(r.stderr || '').trim().split('\n').pop() || `ffprobe exited ${r.status}`
    return { error: `does not decode: ${why}` }
  }
  const d = Number(String(r.stdout).trim())
  if (!Number.isFinite(d) || d <= 0) return { error: `ffprobe reported no duration (${String(r.stdout).trim()})` }
  return { seconds: d }
}

/**
 * Is this artifact a COMPLETE file of its kind? Returns null when it is, or the
 * reason it is not — a half-written file is the failure mode this gate exists
 * to catch, and every format here has an end-of-file marker that proves it.
 */
function incompleteReason(p) {
  if (!present(p)) return 'missing or empty'
  const ext = path.extname(p).toLowerCase()
  if (ext === '.mp4') {
    const d = videoDuration(p)
    return d.error ?? null
  }
  if (ext === '.xlsx' || ext === '.zip') {
    if (head(p, 2).toString('ascii') !== 'PK') return 'not a zip (no PK header)'
    // End of central directory — the last record a zip writer emits.
    return tail(p, 66_000).lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0
      ? null
      : 'zip has no end-of-central-directory record — still being written?'
  }
  if (ext === '.png') {
    if (head(p, 8).toString('hex') !== '89504e470d0a1a0a') return 'not a PNG'
    return tail(p, 12).includes('IEND') ? null : 'PNG has no IEND chunk — truncated'
  }
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'))
      return null
    } catch (e) {
      return `does not parse as JSON: ${e.message}`
    }
  }
  return null
}

await L.runGate('G10', async (g) => {
  const base = L.arg('--base', process.env.DSOURCE_BASE_URL || 'http://localhost:5173')
  const out = path.resolve(L.arg('--out', L.OUT))
  const selector = L.arg('--selector', '[data-testid="export-deliverable-pack"]')
  const timeout = Number(L.arg('--timeout', '300000'))
  const verifyOnly = L.hasFlag('--verify-only')

  const expected = [
    ['workbook', path.join(out, 'quantity-takeoff.xlsx')],
    ['ground truth', path.join(out, 'ground-truth.json')],
    ['plan', path.join(out, 'plan.png')],
    ...RENDERS.map((r) => [`render ${r}`, path.join(out, 'renders', `${r}.png`)]),
    ['walkthrough', path.join(out, 'walkthrough.mp4')],
    ['share link', path.join(out, 'share.json')],
  ]

  if (!verifyOnly) {
    // ---- drive the single action -----------------------------------------
    const chromium = await L.loadPlaywright()
    let browser
    try {
      browser = await chromium.launch()
    } catch (e) {
      throw new Error(`could not launch Chromium: ${e.message}`)
    }
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
      page.on('pageerror', (e) => g.note(`pageerror: ${String(e.message).slice(0, 140)}`))

      try {
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 })
      } catch (e) {
        throw new L.Missing(
          `app unreachable at ${base} (${e.message}) — start it with ` +
          '`pnpm --dir web dev` before running G10',
        )
      }

      // Snapshot what already exists so we can prove the click produced it.
      const before = new Map(expected.map(([, p]) => [p, present(p) ? fs.statSync(p).mtimeMs : 0]))

      const btn = await page.$(selector)
      if (!btn) {
        g.fail(
          `no single "Export deliverable pack" control found (selector ${selector}). ` +
          'The UI must expose one control carrying data-testid="export-deliverable-pack" ' +
          'that produces the whole pack.',
        )
        return
      }

      const clicks = await page.$$(selector)
      g.check(clicks.length === 1,
        `${clicks.length} controls match ${selector} — the action must be unambiguous`)

      await btn.click()

      // Poll until every artifact is BOTH newer than the click AND a complete
      // file of its kind. "The mtime moved" is not done — see the header note.
      const stale = ([, p]) => !present(p) || fs.statSync(p).mtimeMs <= before.get(p)
      const notReady = () =>
        expected
          .map((e) => [e, stale(e) ? 'not rewritten by this run' : incompleteReason(e[1])])
          .filter(([, why]) => why)
      const deadline = Date.now() + timeout
      let pending = notReady()
      while (pending.length && Date.now() < deadline) {
        await page.waitForTimeout(2000)
        pending = notReady()
      }
      g.check(pending.length === 0,
        `after one click, ${pending.length} artifact(s) were never complete within ` +
        `${Math.round(timeout / 1000)}s: ` +
        pending.map(([[n, p], why]) => `${n} (${path.basename(p)}: ${why})`).join(', '))
    } finally {
      await browser.close()
    }
  }

  // ---- the pack is complete either way -----------------------------------
  for (const [what, p] of expected) {
    if (!present(p)) throw new L.Missing(`${what} ${p}`)
    g.check(!incompleteReason(p), `${what} (${path.basename(p)}) is not a complete file: ${incompleteReason(p)}`)
  }

  const share = L.loadJson(path.join(out, 'share.json'), 'share link')
  g.check(!!(share.url || share.planId),
    'share.json has neither "url" nor "planId" — the pack has no viewer link')

  // The video is the artifact that streams, so it is stated explicitly: a
  // decoded duration inside the spec's range is what "finished" means.
  const mp4 = path.join(out, 'walkthrough.mp4')
  const spec = L.loadJson(path.join(L.SPEC_DIR, 'video-spec.json'), 'video spec')
  // The range is at spec.TARGET.durationRange_s — `reference` is what qbiq's mp4
  // measured, `target` is what we assert. This read used to be
  // `spec.durationRange_s ?? [30, 45]`, which is `undefined ?? [30, 45]` on
  // every run: the spec was never consulted and the hardcoded pair always won.
  // It went unnoticed because the literal happened to equal the spec — so the
  // gate agreed with the spec by coincidence, not by reading it, and editing the
  // spec would have changed nothing. `??` on a misspelt path is a silent skip
  // wearing a default; g7-video.py:83 reads `tgt["durationRange_s"]` and would
  // have thrown. A missing input is a FAILURE, never a default.
  const range = spec.target?.durationRange_s
  if (!Array.isArray(range) || range.length !== 2) {
    throw new L.Missing(
      'video-spec.json has no target.durationRange_s — the duration assertion has no ground truth',
    )
  }
  const [dlo, dhi] = range
  const dur = videoDuration(mp4)
  if (g.check(!dur.error, `walkthrough.mp4 ${dur.error}`)) {
    g.check(dur.seconds >= dlo && dur.seconds <= dhi,
      `walkthrough.mp4 decodes to ${dur.seconds.toFixed(2)}s, outside the spec range ${dlo}-${dhi}s`)
    g.note(`walkthrough.mp4 ${dur.seconds.toFixed(2)}s · ` +
      `${(fs.statSync(mp4).size / 1024 / 1024).toFixed(1)} MB · ` +
      `mtime ${new Date(fs.statSync(mp4).mtimeMs).toISOString()}`)
  }

  const sizes = expected.map(([what, p]) => `${what}=${(fs.statSync(p).size / 1024).toFixed(0)}KB`)
  g.note(sizes.join(' '))
})
