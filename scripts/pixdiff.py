#!/usr/bin/env python3
"""Per-pixel diff of two screenshots — the honest way to claim "nothing changed".

    scripts/pixdiff.py before.png after.png [out-diff.png]

Prints the number of differing pixels, the worst per-channel delta, and where
the differences are. Writes a diff image (changed pixels in magenta) when a
third path is given. Exit code 1 when anything differs, so it can gate a commit.

Used by the component-migration slices: a migration that only moves declarations
from inline styles into a stylesheet must be pixel-identical, and "it looks the
same to me" is not a measurement.
"""
import sys
from PIL import Image, ImageChops


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    a = Image.open(sys.argv[1]).convert('RGBA')
    b = Image.open(sys.argv[2]).convert('RGBA')
    if a.size != b.size:
        print(f'SIZE DIFFERS: {a.size} vs {b.size}')
        return 1
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    px = list(diff.getdata())
    changed = [i for i, p in enumerate(px) if p[0] or p[1] or p[2]]
    worst = max((max(p[:3]) for p in px), default=0)
    total = a.size[0] * a.size[1]
    print(f'size          {a.size[0]}x{a.size[1]} ({total} px)')
    print(f'differing     {len(changed)} px ({len(changed) / total * 100:.4f}%)')
    print(f'worst delta   {worst}/255')
    print(f'bbox          {bbox}')
    if len(sys.argv) > 3 and changed:
        out = a.copy()
        w = a.size[0]
        for i in changed:
            out.putpixel((i % w, i // w), (255, 0, 255, 255))
        out.save(sys.argv[3])
        print(f'diff image    {sys.argv[3]}')
    return 1 if changed else 0


if __name__ == '__main__':
    sys.exit(main())
