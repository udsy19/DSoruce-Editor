// Shared helpers for the Node-side deliverable gates (G8, G10).
//
// Same contract as lib/gatelib.py: one scoreboard line, exit 0 pass / 1 fail,
// and a MISSING artifact is a clean FAIL rather than a stack trace.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const OUT = path.join(REPO, 'out')
export const SPEC_DIR = path.join(REPO, 'docs/reference/qbiq/spec')

export const DEFAULTS = {
  workbook: path.join(OUT, 'quantity-takeoff.xlsx'),
  groundTruth: path.join(OUT, 'ground-truth.json'),
  plan: path.join(OUT, 'plan.png'),
  renders: path.join(OUT, 'renders'),
  video: path.join(OUT, 'walkthrough.mp4'),
  share: path.join(OUT, 'share.json'),
}

export class Missing extends Error {}

export class Gate {
  constructor(gid) {
    this.gid = gid
    this.reasons = []
    this.notes = []
    this.checks = 0
  }
  check(cond, msg) {
    this.checks++
    if (!cond) this.reasons.push(msg)
    return !!cond
  }
  fail(msg) { this.reasons.push(msg) }
  note(msg) { this.notes.push(msg) }
  finish() {
    for (const n of this.notes) process.stderr.write(`  note[${this.gid}] ${n}\n`)
    if (this.reasons.length) {
      const shown = this.reasons.slice(0, 4).join('; ')
      const more = this.reasons.length > 4 ? ` (+${this.reasons.length - 4} more)` : ''
      console.log(`${this.gid} FAIL: ${shown}${more}`)
      process.exit(1)
    }
    console.log(`${this.gid} PASS${this.checks ? `  (${this.checks} checks)` : ''}`)
    process.exit(0)
  }
}

export async function runGate(gid, fn) {
  const g = new Gate(gid)
  try {
    await fn(g)
  } catch (e) {
    if (e instanceof Missing) {
      console.log(`${gid} FAIL: artifact missing: ${e.message}`)
      process.exit(1)
    }
    process.stderr.write(String(e?.stack || e) + '\n')
    console.log(`${gid} FAIL: gate error: ${e?.name || 'Error'}: ${e?.message || e}`)
    process.exit(1)
  }
  g.finish()
}

export function arg(flag, def = null, argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) return argv[i + 1]
    if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1)
  }
  return def
}

export function hasFlag(flag, argv = process.argv.slice(2)) {
  return argv.includes(flag)
}

export function requireFile(p, what = 'file') {
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Missing(`${what} ${p}`)
  return p
}

export function loadJson(p, what = 'json') {
  requireFile(p, what)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** Load Playwright, or fail loudly with the exact install command. */
export async function loadPlaywright() {
  for (const mod of ['playwright', 'playwright-core', '@playwright/test']) {
    try {
      const m = await import(mod)
      if (m.chromium) return m.chromium
      if (m.default?.chromium) return m.default.chromium
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    'Playwright is not installed — this gate drives a real browser and cannot be skipped. ' +
    'Install it with:  cd web && pnpm add -D playwright && pnpm exec playwright install chromium',
  )
}

/** Resolve the share URL: --url wins, else out/share.json {url} or {planId}. */
export function resolveShareUrl(base) {
  const explicit = arg('--url')
  if (explicit) return explicit
  const sharePath = arg('--share', DEFAULTS.share)
  if (!fs.existsSync(sharePath)) {
    throw new Missing(
      `${sharePath} — the export action must write {"planId": "...", "url": "..."} there`,
    )
  }
  const s = JSON.parse(fs.readFileSync(sharePath, 'utf8'))
  if (s.url) return s.url
  if (s.planId) return `${base.replace(/\/$/, '')}/share/${s.planId}`
  throw new Missing(`${sharePath} has neither "url" nor "planId"`)
}

/** Fraction of non-background pixels in a raw RGBA buffer. */
export function nonBackgroundFraction(rgba, bg = [255, 255, 255], tol = 10) {
  let hit = 0
  const n = rgba.length / 4
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      Math.abs(rgba[i] - bg[0]) > tol ||
      Math.abs(rgba[i + 1] - bg[1]) > tol ||
      Math.abs(rgba[i + 2] - bg[2]) > tol
    ) hit++
  }
  return hit / n
}
