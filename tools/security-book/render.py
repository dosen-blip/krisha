# Render every magazine page of both Security PDFs to PNG (raw, high quality) for later webp export.
import fitz, os, sys
from PIL import Image
OUT = sys.argv[1]
H = 1200
srcs = {
  '00': '/Users/matiadosen/Desktop/transfer-01a20fc8/Security Issue 00 2025.pdf',
  '01': '/Users/matiadosen/Desktop/transfer-01a20fc8/Security Issue 01 2026-1-45_compressed 2.pdf',
}
for iss, path in srcs.items():
    d = fitz.open(path)
    os.makedirs(f'{OUT}/{iss}', exist_ok=True)
    n = 0
    for i, pg in enumerate(d):
        z = H / pg.rect.height
        pix = pg.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False)
        im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        if pg.rect.width > pg.rect.height * 1.2:   # spread -> split
            w = im.width // 2
            halves = [im.crop((0, 0, w, im.height)), im.crop((im.width - w, 0, im.width, im.height))]
        else:
            halves = [im]
        for h in halves:
            n += 1
            h.save(f'{OUT}/{iss}/{n:03d}.png')
    print(iss, n, halves[0].size)
