// Integrity check on what the DWG→DXF converter actually produced.
//
// Pure string analysis, no Node APIs — imported by BOTH `/api/dwg`
// implementations (the dev middleware in `dwgConvert.ts` and the VPS service in
// `deploy/server.ts`), so the two can never drift apart on what counts as a
// successful conversion. See CLAUDE.md "Lockstep".
//
// Why this exists: `dwg2dxf` decides success by exit code, and the exit code
// lies. On `Apartment-1.dwg` it printed
//
//     ERROR: BLOCK_HEADER A$C72CD3181 first_owned_entity missing
//
// wrote a 300 KB file that ends partway through the BLOCKS section — no
// ENTITIES section, no EOF marker — and **exited 0**. `/api/dwg` returned
// HTTP 200 with that file, and the failure surfaced three layers later as
// `dxf-parser` throwing "Unexpected end of input", which the UI rendered as
// "Could not read that file. Check it is a valid DXF/DWG drawing" — blaming a
// file that AutoCAD opens fine for our converter's truncation.
//
// The producer's status code is not evidence about the producer's output. The
// bytes are, and a complete DXF has a structure that a partial write cannot
// fake: an ENTITIES section, and an EOF terminator after it.

/** Why a conversion was rejected. `null` when the DXF is structurally sound. */
export type DxfDefect =
  | 'empty'
  | 'no-entities-section'
  | 'no-eof-marker'
  | 'entities-after-eof'

export interface DxfVerdict {
  ok: boolean
  defect: DxfDefect | null
  /** Plain-language, user-facing. Empty when ok. */
  message: string
}

const DEFECT_MESSAGE: Record<DxfDefect, string> = {
  empty: 'the converter produced an empty file',
  'no-entities-section':
    'the converted drawing contains no ENTITIES section — the conversion stopped before reaching the drawing’s geometry',
  'no-eof-marker':
    'the converted drawing is truncated — it has no end-of-file marker, so the conversion did not finish',
  'entities-after-eof': 'the converted drawing is malformed — content continues past its end-of-file marker',
}

/**
 * Structural check on converted DXF text.
 *
 * Deliberately cheap and deliberately shallow: this is a truncation detector,
 * not a validator. It answers "did the converter finish?", which is the
 * question the exit code was being asked and answering wrongly. Whether the
 * geometry is *good* is `parseDrawing`'s business.
 */
export function verifyDxf(text: string): DxfVerdict {
  const verdict = (defect: DxfDefect | null): DxfVerdict =>
    defect === null
      ? { ok: true, defect: null, message: '' }
      : { ok: false, defect, message: DEFECT_MESSAGE[defect] }

  if (!text || text.trim().length === 0) return verdict('empty')

  // Group codes sit on their own line, values on the next; both may carry
  // leading spaces and CRLF line endings (LibreDWG emits CRLF).
  const lines = text.split(/\r?\n/)

  let entitiesAt = -1
  let eofAt = -1
  for (let i = 0; i < lines.length - 1; i++) {
    const code = lines[i].trim()
    const value = lines[i + 1].trim()
    if (entitiesAt < 0 && code === '2' && value === 'ENTITIES') entitiesAt = i
    if (code === '0' && value === 'EOF') eofAt = i
  }

  if (entitiesAt < 0) return verdict('no-entities-section')
  if (eofAt < 0) return verdict('no-eof-marker')
  if (eofAt < entitiesAt) return verdict('entities-after-eof')
  return verdict(null)
}

/**
 * A child process's outcome, in words a user can act on.
 *
 * `close` delivers `(code, signal)` and a signalled child reports `code === null`
 * — which the previous single-argument handler stringified into
 * "dwg2dxf exited null", discarding the one useful fact (that it crashed).
 * Both corpus files that fail this way die on SIGSEGV.
 */
export function describeExit(
  bin: string,
  code: number | null,
  signal: string | null,
): string {
  if (signal) {
    return `${bin} crashed (${signal}) while converting this drawing. The file may use a DWG feature the converter cannot read.`
  }
  return `${bin} failed with exit code ${code} while converting this drawing.`
}

/**
 * Converter stderr is for the server log, not the response. LibreDWG emits
 * kilobytes of internal warnings per failure — one corpus file produced a 3 KB
 * error payload, and the accumulated text in the page DOM measured 98 410
 * characters. Keep a bounded tail for diagnosis; drop the rest.
 */
export function trimStderr(stderr: string, max = 400): string {
  const s = (stderr || '').trim()
  if (s.length <= max) return s
  return `…${s.slice(-max)}`
}
