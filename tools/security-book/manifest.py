# Write fx/security-book.js (page manifest + scan->spread mapping) from the export + matcher output.
import json, sys, glob, os, math
from PIL import Image
REPO = sys.argv[1]
m = json.load(open('match-final.json'))
# Visual check of the low-confidence auto matches (see verify*.jpg / dark.jpg):
#  security-00-04 (very dark scan) is pages 92-93; security-00-11 is pages 6-7 (correct, small margin);
#  security-01-11 (editor's letter + pink figure) is not in the supplied Issue 01 PDF -> no match.
VERIFIED = {'security-00-04.webp': 46, 'security-00-11.webp': 3}
NO_MATCH = {'security-01-11.webp'}
issues = {}
for iss, title in (('00', 'SILKEN BOUNDARIES'), ('01', 'THE BOOTLEG ISSUE')):
    pages = sorted(glob.glob(f'{REPO}/img-webp/security-book/{iss}/*.webp'))
    w, h = Image.open(pages[0]).size
    a = Image.open(f'{REPO}/img-webp/security-book/{iss}-atlas.webp')
    ch = 128; cw = round(w * ch / h)
    issues[iss] = dict(id=iss, title=title, pages=len(pages), w=w, h=h,
                       atlas=dict(src=f'{iss}-atlas.webp', w=a.width, h=a.height, cw=cw, ch=ch, cols=a.width // cw))
scans = {}
for iss, res in m.items():
    for f, r in res.items():
        if f in NO_MATCH: spread, how = None, 'none'
        elif f in VERIFIED: spread, how = VERIFIED[f], 'verified'
        elif r['ok']: spread, how = r['spread'], 'auto'
        else: spread, how = None, 'none'
        scans[f] = dict(issue=iss, spread=spread, score=r['score'], how=how)
js = """/*
 * fx/security-book.js — GENERATED page manifest for the Security flip-book (fx/flipbook.js, fx/flipbook-lite.js).
 * Pages: img-webp/security-book/<issue>/<NNN>.webp (1-based, NNN = 3 digits), rendered from the client PDFs
 * (Issue 00: cover + 57 spreads split into pages; Issue 01: 88 single pages), 1200px tall, webp q78.
 * Atlas: one thumbnail sheet per issue (row-major, cell cw x ch) used as an instant low-res placeholder.
 * Book pagination: page 1 (cover) alone on the right, then spreads [2,3], [4,5], ... => spread k = pages 2k, 2k+1.
 * scans: grid photo (img-webp/<file>) -> spread, matched offline by downsampled grayscale+gradient correlation
 * (plain and histogram-equalised, averaged); 'verified' = low auto-confidence, checked by eye;
 * spread null = no confident match (open at the start of the issue).
 */
export const BASE = 'img-webp/security-book/';
export const ISSUES = %s;
export const SCANS = %s;
""" % (json.dumps(issues, indent=2), json.dumps(scans, indent=2))
open(f'{REPO}/fx/security-book.js', 'w').write(js)
print(js[-1600:])
