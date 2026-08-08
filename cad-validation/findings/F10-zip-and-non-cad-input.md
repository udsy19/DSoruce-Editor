# F10 — `.zip` uploads are unsupported, and one supplied archive contains no CAD at all

**Severity: Low** · **Files affected: 4 archives**

---

## What was supplied vs. what the app accepts

The uploader accepts `DXF / DWG … or PNG / JPG`. Four of the 24 items the user supplied are `.zip`
archives, which the app has no path for — they must be extracted by hand before anything can happen.
Contents:

| Archive | Contents | Usable? |
|---|---|---|
| `Hospital-equipment.zip` | `MOBILIARIO HOSPITAL.dwg` (683 KB) | yes, after manual extraction |
| `Office-furniture-blocks.zip` | `cad33.dwg` (922 KB) | yes, after manual extraction |
| `Various-furniture-blocks.zip` | `muebles varios.dwg` (922 KB) | yes, after manual extraction |
| `Library-of-furniture.zip` | **2 JPEGs**, 5.3 MB + 5.4 MB, no CAD | **no** |

## Two distinct observations

### 1. Single-file archives are the common CAD distribution format

Three of the four archives wrap exactly one `.dwg`. Every CAD block library the user sourced arrived
this way. Unwrapping a single-entry archive is unambiguous and needs no user choice.

### 2. `Library-of-furniture.zip` is a scanned catalogue, not a drawing

Both entries are JPEG page scans (`…furniturelibrary-page-1.jpg`, `-page-2.jpg`). This is not a CAD
file in a wrapper — it is reference imagery.

The app **does** have a raster path (`web/src/import/rasterImport.ts`; the dropzone advertises
"PNG / JPG (set the scale, then trace)"), so the individual JPEGs could be uploaded manually. But
these particular images are furniture *catalogue pages*, not a floor plan, so the scale-and-trace
flow has nothing meaningful to trace. Worth stating plainly so it is not mistaken for a defect: this
file is out of scope for the product, and the correct behaviour is to say so.

## Filename handling

Two extracted files carry **spaces** in their names (`MOBILIARIO HOSPITAL.dwg`,
`muebles varios.dwg`). Both round-tripped through the upload path and the `/api/dwg` conversion
without incident — no defect found, recorded because it is the kind of thing that breaks and it was
checked.

## Reproduce

```bash
unzip -l ~/Downloads/Library-of-furniture.zip
# → 55049v5333470_mueblesdebibliotecafurniturelibrary-page-{1,2}.jpg
```
