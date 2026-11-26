# Export raw PNG pages -> webp pages + per-issue thumbnail atlas into the repo.
import os, sys, glob, math, json
from PIL import Image
RAW, OUT = sys.argv[1], sys.argv[2]
Q = int(sys.argv[3]) if len(sys.argv) > 3 else 78
info = {}
for iss in ['00', '01']:
    fs = sorted(glob.glob(f'{RAW}/{iss}/*.png'))
    os.makedirs(f'{OUT}/{iss}', exist_ok=True)
    tot = 0
    for f in fs:
        im = Image.open(f).convert('RGB')
        dst = f'{OUT}/{iss}/' + os.path.basename(f).replace('.png', '.webp')
        im.save(dst, 'WEBP', quality=Q, method=6)
        tot += os.path.getsize(dst)
    w, h = Image.open(fs[0]).size
    ch = 128; cw = round(w * ch / h)
    n = len(fs); cols = math.ceil(math.sqrt(n * ch / cw)); rows = math.ceil(n / cols)
    atlas = Image.new('RGB', (cols * cw, rows * ch), 'white')
    for i, f in enumerate(fs):
        atlas.paste(Image.open(f).convert('RGB').resize((cw, ch), Image.LANCZOS), ((i % cols) * cw, (i // cols) * ch))
    atlas.save(f'{OUT}/{iss}-atlas.webp', 'WEBP', quality=72, method=6)
    info[iss] = dict(pages=n, w=w, h=h, cols=cols, rows=rows, cw=cw, ch=ch, bytes=tot, atlas=os.path.getsize(f'{OUT}/{iss}-atlas.webp'))
print(json.dumps(info, indent=1))
