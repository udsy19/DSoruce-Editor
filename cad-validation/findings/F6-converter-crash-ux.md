# F6 — `dwg2dxf` segfaults; the API reports `"dwg2dxf exited null"` plus 3 KB of raw C stderr

**Severity: Medium** · **Files affected: 2 (`BUSNSS-Offcs-Trdtnl_AC.dwg`, `BUSNSS-Offcs-Trdtnl_AF.dwg`)**

---

## Evidence

```
$ dwg2dxf -o /tmp/a1.dxf BUSNSS-Offcs-Trdtnl_AC.dwg ; echo "exit=$?"
ERROR: Invalid type 0x13, expected 0x5 ENDBLK      (×20)
exit=139

$ dwg2dxf -o /tmp/a2.dxf BUSNSS-Offcs-Trdtnl_AF.dwg ; echo "exit=$?"
Warning: stale VERTEX_2D subentity
ERROR: Invalid type 0x4d, expected 0x5 ENDBLK
exit=139
```

`139 = 128 + 11` — **SIGSEGV**. LibreDWG 0.13.3 crashes on both files after writing a partial DXF
(592 KB and 4.7 MB respectively).

## Two separable problems

### 1. The signal is reported as `null`

`dwgConvert.ts:43`:

```ts
else reject(new Error(`dwg2dxf exited ${code}: ${stderr.trim()}`))
```

When a child is killed by a signal, Node's `close` event delivers `code === null` and the signal in
the second argument, which this handler does not accept. The user-facing string becomes:

```
dwg2dxf exited null: Warning: Unstable Class object 504 TABLESTYLE (0xfff) 34/0 …
```

`exited null` is meaningless, and the one diagnostic fact — that it *crashed* — is discarded.

### 2. Raw C stderr is forwarded verbatim into the response

Measured against the live endpoint:

```
$ curl -X POST --data-binary @BUSNSS-Offcs-Trdtnl_AC.dwg http://localhost:5174/api/dwg
HTTP 500  3077 bytes
{"error":"dwg2dxf exited null: Warning: Unstable Class object 504 TABLESTYLE (0xfff) 34/0\n
Warning: Unstable Class object 505 MATERIAL (0x481) 37/0\n…"}
```

A **3 KB** error payload of LibreDWG internals. When probing the DOM after upload, the accumulated
error text measured **98 410 characters**.

The wizard's Space step does sanitise this before display — the user sees the same clean
"Could not read that file. Check it is a valid DXF/DWG drawing."
(`findings/screens/AC-segfault-error.png`) — so the blast radius is contained in the UI. But the raw
payload still crosses the network on every failure, and as with [F5](F5-converter-integrity.md) the
message blames the user's file for our converter's crash.

## Note on partial output

Both crashes leave a substantial partial DXF on disk (AC: 592 KB, AF: 4.7 MB) which the current code
discards. That is the **correct** behaviour and should be kept — the integrity check proposed in
[F5](F5-converter-integrity.md) must reject these too, not attempt to salvage them.

## Reproduce

```bash
for f in BUSNSS-Offcs-Trdtnl_AC BUSNSS-Offcs-Trdtnl_AF; do
  rm -f /tmp/o.dxf; dwg2dxf -o /tmp/o.dxf ~/Downloads/$f.dwg >/dev/null 2>&1; echo "$f exit=$?"
done
```
