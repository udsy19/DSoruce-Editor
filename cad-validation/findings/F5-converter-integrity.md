# F5 — `dwg2dxf` truncates its output while exiting 0; the API returns 200 OK with a broken DXF

**Severity: High** · **Files affected: 1 proven (`Apartment-1.dwg`) — but the check is missing for all**

---

## The defect

`web/src/import/dwgConvert.ts:40-45` (dev) and `deploy/apiCore.ts` (prod) decide success from the
child process's **exit code alone**:

```ts
proc.on('close', (code) => {
  // dwg2dxf prints warnings to stderr but still exits 0 on success.
  if (code === 0) resolve()
  else reject(new Error(`dwg2dxf exited ${code}: ${stderr.trim()}`))
})
```

The comment states the assumption exactly: *exit 0 means success*. It does not hold.

## Evidence

```
$ dwg2dxf -o /tmp/ap1.dxf Apartment-1.dwg
Warning: Object handle not found 57439/0xE05F
ERROR: BLOCK_HEADER A$C72CD3181 first_owned_entity missing
$ echo $?
0
$ ls -la /tmp/ap1.dxf
300K
$ tail -c 40 /tmp/ap1.dxf
...AcDbBlockEnd..  0..ENDSEC..
```

The file ends at the close of the **BLOCKS** section. There is **no `ENTITIES` section** — the
drawing's actual content — and no `EOF` marker. LibreDWG hit a structural error, wrote a partial
file, and exited 0.

Against the live dev endpoint:

```
$ curl -X POST --data-binary @Apartment-1.dwg http://localhost:5174/api/dwg
HTTP 200  403241 bytes
{"dxf":"999\r\nLibreDWG 0.13.3\r\n  0\r\nSECTION\r\n  2\r\nHEADER\r\n..."}
```

**HTTP 200.** The client accepts it, hands it to `parseDrawing`, and `dxf-parser` throws deep inside
the app:

```
Unexpected end of input: EOF group not read before end of file. Ended on code undefined
```

## What the user sees

`findings/screens/apartment1-parse-error.png`:

> ⚠ Could not read that file. Check it is a valid DXF/DWG drawing.

The message is clean and well-presented — but it is **wrong about the cause and blames the user's
file**. `Apartment-1.dwg` is a valid DWG that AutoCAD opens; *our converter* truncated it. The user
is told to check a file that is fine, with no path forward.

## Why this is the gate-independence pattern

Per `.claude/rules/gate-independence.md` — *"the scoreboard trusted a status code supplied by the
thing it was summarising"*. This is the same shape one layer down: the conversion step's only check
on whether conversion worked is a status code emitted by the converter. The DXF text is right there
in the response, and nothing looks at it.

The check that would have caught it is structural and cheap: **a DXF that converted successfully has
an `ENTITIES` section and terminates with `EOF`.** That is derivable from the bytes, needs no
cooperation from `dwg2dxf`, and cannot be faked by a partial write.

## Reproduce

```bash
dwg2dxf -o /tmp/ap1.dxf ~/Downloads/Apartment-1.dwg; echo "exit=$?"
grep -c '^ENTITIES' /tmp/ap1.dxf     # → 0
tail -c 20 /tmp/ap1.dxf              # → ENDSEC, not EOF
```
