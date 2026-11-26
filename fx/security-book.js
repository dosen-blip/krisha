/*
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
export const ISSUES = {
  "00": {
    "id": "00",
    "title": "SILKEN BOUNDARIES",
    "pages": 115,
    "w": 920,
    "h": 1200,
    "atlas": {
      "src": "00-atlas.webp",
      "w": 1274,
      "h": 1152,
      "cw": 98,
      "ch": 128,
      "cols": 13
    }
  },
  "01": {
    "id": "01",
    "title": "THE BOOTLEG ISSUE",
    "pages": 88,
    "w": 880,
    "h": 1200,
    "atlas": {
      "src": "01-atlas.webp",
      "w": 1034,
      "h": 1024,
      "cw": 94,
      "ch": 128,
      "cols": 11
    }
  }
};
export const SCANS = {
  "security-00-01.webp": {
    "issue": "00",
    "spread": 56,
    "score": 0.603,
    "how": "auto"
  },
  "security-00-02.webp": {
    "issue": "00",
    "spread": 54,
    "score": 0.577,
    "how": "auto"
  },
  "security-00-03.webp": {
    "issue": "00",
    "spread": 51,
    "score": 0.774,
    "how": "auto"
  },
  "security-00-04.webp": {
    "issue": "00",
    "spread": 46,
    "score": 0.284,
    "how": "verified"
  },
  "security-00-05.webp": {
    "issue": "00",
    "spread": 40,
    "score": 0.657,
    "how": "auto"
  },
  "security-00-06.webp": {
    "issue": "00",
    "spread": 26,
    "score": 0.583,
    "how": "auto"
  },
  "security-00-07.webp": {
    "issue": "00",
    "spread": 20,
    "score": 0.699,
    "how": "auto"
  },
  "security-00-08.webp": {
    "issue": "00",
    "spread": 16,
    "score": 0.706,
    "how": "auto"
  },
  "security-00-09.webp": {
    "issue": "00",
    "spread": 11,
    "score": 0.429,
    "how": "auto"
  },
  "security-00-10.webp": {
    "issue": "00",
    "spread": 6,
    "score": 0.51,
    "how": "auto"
  },
  "security-00-11.webp": {
    "issue": "00",
    "spread": 3,
    "score": 0.544,
    "how": "verified"
  },
  "security-00-12.webp": {
    "issue": "00",
    "spread": 1,
    "score": 0.734,
    "how": "auto"
  },
  "security-01-01.webp": {
    "issue": "01",
    "spread": 39,
    "score": 0.629,
    "how": "auto"
  },
  "security-01-02.webp": {
    "issue": "01",
    "spread": 35,
    "score": 0.726,
    "how": "auto"
  },
  "security-01-03.webp": {
    "issue": "01",
    "spread": 31,
    "score": 0.766,
    "how": "auto"
  },
  "security-01-04.webp": {
    "issue": "01",
    "spread": 25,
    "score": 0.602,
    "how": "auto"
  },
  "security-01-05.webp": {
    "issue": "01",
    "spread": 22,
    "score": 0.685,
    "how": "auto"
  },
  "security-01-06.webp": {
    "issue": "01",
    "spread": 18,
    "score": 0.708,
    "how": "auto"
  },
  "security-01-07.webp": {
    "issue": "01",
    "spread": 10,
    "score": 0.717,
    "how": "auto"
  },
  "security-01-08.webp": {
    "issue": "01",
    "spread": 6,
    "score": 0.573,
    "how": "auto"
  },
  "security-01-09.webp": {
    "issue": "01",
    "spread": 2,
    "score": 0.684,
    "how": "auto"
  },
  "security-01-10.webp": {
    "issue": "01",
    "spread": 1,
    "score": 0.474,
    "how": "auto"
  },
  "security-01-11.webp": {
    "issue": "01",
    "spread": null,
    "score": 0.484,
    "how": "none"
  }
};
