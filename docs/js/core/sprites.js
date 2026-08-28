// kit/arena_ui/core/sprites.js
//
// COLOSSEUM — string-encoded pixel-art sprite sheets for the arena HUD
// (CONTRACTS.md §10, FINAL-PLAN.md §8.1/§8.2). Byte-identical between
// Day26-Colosseum-Agent-Arena-Kit and Day26-Colosseum-Agent-Arena. Native ES module, no
// build step, no bundler, no npm, no CDN, no binary asset — see
// core/theme.js's header for why that is safe under both a browser
// `<script type="module">` and plain `node file.js` (this file follows suit:
// importing it under Node never throws, it just skips the eager canvas
// decode — see the `decoded` export below).
//
// FORMAT — "1990s fighting-game HUD, chunky pixels, hard edges": every
// sprite is a SHEET, i.e. a plain array of equal-length strings, one
// character per pixel. "." is always transparent. Every other character
// indexes into PALETTE via its position in CHARS (CHARS[i] <-> PALETTE[i]),
// so a sprite row never embeds a raw hex colour — this is what keeps the
// pixel data itself small, readable, and diffable in git. All sprites in
// this file are 16x16.
//
// TEAM COLOUR SYNC — sprites.js is intentionally a LEAF module (no imports,
// safe to load first or in isolation, matching theme.js's own stance) even
// though four PALETTE entries are chosen to match core/theme.js's COLORS,
// so an agent avatar's chest stripe never clashes with its own HP bar on
// the same screen:
//   PALETTE[0]  'K' == theme.js COLORS.bg       ('#0a0e16')
//   PALETTE[1]  'k' == theme.js COLORS.panelBg  ('#111a2c')
//   PALETTE[13] 'A' == theme.js COLORS.sideA    ('#3ddc97', "teal")
//   PALETTE[15] 'B' == theme.js COLORS.sideB    ('#ff9d3d', "amber")
// If theme.js's palette ever changes, update these four literals to match —
// deliberately not a live import (see DATA-EXTRACTION CONTRACT below: a
// computed value here would stop being valid JSON and break
// tools/preview_sprites.py, and the async timing of a dynamic import would
// not even be resolved by the time this file's own eager decode runs).
// 'K' is also chosen to sit almost exactly ON TOP of the HUD background on
// purpose: a sprite edge drawn in 'K' blends into the backdrop for a soft
// silhouette, which is why core/CHAIN below uses 'S' instead of 'K' for its
// ring outlines — a shape made ENTIRELY of 'K' linework (nothing else
// adjacent) would otherwise vanish. (Confirmed by rendering a scratch
// preview before this comment was written — worth remembering if you add a
// new icon that is mostly outline.)
//
// DATA-EXTRACTION CONTRACT (read by tools/preview_sprites.py, Python
// stdlib-only, deliberately never shells out to Node): PALETTE, CHARS and
// SHEETS below are each written as valid JSON between sentinel comments —
//   // BEGIN-DATA:<NAME> ... export const <NAME> = <JSON>; ... // END-DATA:<NAME>
// The Python tool slices the text between the markers, strips the
// `export const <NAME> = ` prefix and the trailing `;`, and feeds the rest
// to json.loads(). Keep every object key double-quoted and never leave a
// trailing comma inside a marked block, and keep the char-legend prose in
// this header (not inside the block) — that prose is not valid JSON.
//
// Exports:
//   PALETTE, CHARS, SHEETS   — the raw sprite data (see above)
//   BG                       — the HUD background colour sprites are
//                              authored against (matches theme.js COLORS.bg)
//   decodeSprite(sheet, palette) -> HTMLCanvasElement
//                              Decodes ONE sprite (a string[] "sheet", one
//                              of SHEETS' leaves) to a detached <canvas> —
//                              "offscreen" in the conventional canvas-game
//                              sense (never appended to the DOM), not the
//                              newer OffscreenCanvas API, so this keeps
//                              working in every browser context a student
//                              might run the spar/projector view in.
//   decodeAll(node, palette) -> mirrors the shape of `node` (a SHEETS leaf
//                              becomes a canvas; a nested object of leaves
//                              becomes the same nested object of canvases)
//   drawSprite(ctx, sprite, x, y, scale = 4)
//                              Blits a decoded canvas with
//                              imageSmoothingEnabled = false and integer
//                              scaling/positioning, so pixels stay crisp at
//                              any zoom level a projector or laptop needs.
//   decoded                  — SHEETS already run through decodeAll(SHEETS,
//                              PALETTE) once, at module load, when a DOM is
//                              present (`decoded.agentA.idle`, `.shield`,
//                              etc.) On import under Node (no `document`)
//                              this is `null` instead of throwing — the
//                              "catch, log, continue" degrade-gracefully
//                              rule from the task brief, applied to our own
//                              module's own optional DOM dependency.
//
// Sprite catalogue (all 16x16): agentA/agentB, each {idle, attack, hurt} —
// a server-rack / daemon look (antenna "power" light, vent-grille mouth,
// chest stripe in the team's colour, drive-bay slots) — plus six single
// icons: shield (gateway denial), chain (a broken link, for
// enforcement_failure), scales (the prosecution cut-in), flag (a latent
// violation), skull (KO), cardback (the attack-card reveal).

// BEGIN-DATA:PALETTE
export const PALETTE = [
  "#0a0e16",
  "#111a2c",
  "#1b232b",
  "#57626d",
  "#333c44",
  "#aab4bf",
  "#f5f8fa",
  "#ffb238",
  "#3ee089",
  "#ff3b3b",
  "#6e1414",
  "#48e0ff",
  "#0d5c66",
  "#3ddc97",
  "#1a5c40",
  "#ff9d3d",
  "#8a4f14",
  "#ffd966",
  "#8a6a16"
]
;
// END-DATA:PALETTE

// BEGIN-DATA:CHARS
export const CHARS = "KkoSsLWGgRrCcAaBbFf";
// END-DATA:CHARS

// BEGIN-DATA:SHEETS
export const SHEETS = {
  "agentA": {
    "idle": [
      ".......gg.......",
      ".......KK.......",
      "....KKKKKKKK....",
      "....KLLSSLLK....",
      "....KSSSSSSK....",
      "....KSCSSCSK....",
      "....KSCSSCSK....",
      "....KCSCCSCK....",
      "....KSSKKSSK....",
      "...KSSSSSSSSK...",
      "..KSSSSSSSSSSK..",
      "..KAAAAAAAAAAK..",
      "..KSsSsSSsSsSK..",
      "..KSsSsSSsSsSK..",
      "..KSSSSSSSSSSK..",
      "..kkkkkkkkkkkk.."
    ],
    "attack": [
      ".......gg.......",
      ".......KK.......",
      "....KKKKKKKK....",
      "....KLLSSLLK....",
      "....KSSSSSSK....",
      "....KSASSASK....",
      "....KSASSASK....",
      "....KWSWWSWK....",
      "....KSSKKSSK....",
      "...KSSSSSSSSKSSW",
      "..KSSSSSSSSSSK.A",
      "..KAAAAAAAAAAK..",
      "..KSsSsSSsSsSK..",
      "..KSsSsSSsSsSK..",
      "..KSSSSSSSSSSK..",
      "..kkkkkkkkkkkk.."
    ],
    "hurt": [
      ".......gg.......",
      ".......KK.......",
      ".R..KKKKKKKK..R.",
      "....KLLSSLLK....",
      "....KSSSSSSK....",
      "....KSRSSRSK....",
      "....KSRSSRSK....",
      "....KCSCCSCK....",
      "....KSSKKSSK....",
      "r..KSSSSSSSSK...",
      "..KSSSSSSSSSSK..",
      "..KssssssssssK..",
      "..KSsSsSSsSsSK..",
      "..KSsSsSSsSsSK..",
      "..KSSSSSSSSSSK..",
      "..kkkkkkkkkkkk.."
    ]
  },
  "agentB": {
    "idle": [
      ".......gg.......",
      ".......KK.......",
      "....KKKKKKKK....",
      "....KLLSSLLK....",
      "....KSSSSSSK....",
      "....KSCSSCSK....",
      "....KSCSSCSK....",
      "....KCSCCSCK....",
      "....KSSKKSSK....",
      "...KSSSSSSSSK...",
      "..KSSSSSSSSSSK..",
      "..KBBBBBBBBBBK..",
      "..KSsSsSSsSsSK..",
      "..KSsSsSSsSsSK..",
      "..KSSSSSSSSSSK..",
      "..kkkkkkkkkkkk.."
    ],
    "attack": [
      ".......gg.......",
      ".......KK.......",
      "....KKKKKKKK....",
      "....KLLSSLLK....",
      "....KSSSSSSK....",
      "....KSBSSBSK....",
      "....KSBSSBSK....",
      "....KWSWWSWK....",
      "....KSSKKSSK....",
      "WSSKSSSSSSSSK...",
      "B.KSSSSSSSSSSK..",
      "..KBBBBBBBBBBK..",
      "..KSsSsSSsSsSK..",
      "..KSsSsSSsSsSK..",
      "..KSSSSSSSSSSK..",
      "..kkkkkkkkkkkk.."
    ],
    "hurt": [
      ".......gg.......",
      ".......KK.......",
      ".R..KKKKKKKK..R.",
      "....KLLSSLLK....",
      "....KSSSSSSK....",
      "....KSRSSRSK....",
      "....KSRSSRSK....",
      "....KCSCCSCK....",
      "....KSSKKSSK....",
      "...KSSSSSSSSK..r",
      "..KSSSSSSSSSSK..",
      "..KssssssssssK..",
      "..KSsSsSSsSsSK..",
      "..KSsSsSSsSsSK..",
      "..KSSSSSSSSSSK..",
      "..kkkkkkkkkkkk.."
    ]
  },
  "shield": [
    "....KKKKKKKK....",
    "..KSSSSSSSSSSK..",
    ".KSSSSSSSSSSSSK.",
    ".KSLLLLSSLLLLSK.",
    ".KSSCCSSSSCCSSK.",
    ".KSSCCSSSSCCSSK.",
    ".KSSCCSSSSCCSSK.",
    ".KSSSSSSSSSSSSK.",
    "..KSSSSSSSSSSK..",
    "..KSsSsSSsSsSK..",
    "...KSSSSSSSSK...",
    "...KsSsSSsSsK...",
    "....KSSSSSSK....",
    ".....KSSSSK.....",
    "......KSSK......",
    ".......KK......."
  ],
  "chain": [
    "................",
    "................",
    "................",
    "................",
    "................",
    "SSSSSSS....SSSSS",
    "S...SS..R..S...S",
    "S...S..W.R.S...S",
    "S...S..R..SS...S",
    "SSSSS....SSSSSSS",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................"
  ],
  "scales": [
    ".......FF.......",
    ".FFFFFFFFFFFFFF.",
    ".f.....ff.....f.",
    ".f.....ff.....f.",
    ".f.....ff.....f.",
    "fff....ff....fff",
    "fFf....ff....fFf",
    ".......ff.......",
    ".......ff.......",
    ".......ff.......",
    "..ffffffffffff..",
    "..ffffffffffff..",
    "................",
    "................",
    "................",
    "................"
  ],
  "flag": [
    "..KK............",
    "..SSKKKKKKKK....",
    "..SSKFFFFFFK....",
    "..SSKFFFFFFK....",
    "..SSKFFFFFFK....",
    "..SSKFFFFFFK....",
    "..SSKKKKKKKK....",
    "..SS............",
    "..SS............",
    "..SS............",
    "..SS............",
    "..SS............",
    "..SS............",
    "..SS............",
    ".KKKK...........",
    "................"
  ],
  "skull": [
    "....KKKKKKKK....",
    "...KSSSSSSSSK...",
    "..KSSSSSSSSSSK..",
    ".KSSSSSSSSSSSSK.",
    ".KSkkSSSSSSkkSK.",
    ".KSkkSSSSSSkkSK.",
    "..KSSSSSSSSSSK..",
    "..KSSSSkkSSSSK..",
    "..KSSSSSSSSSSK..",
    "...KWKWKKWKWK...",
    "....KKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................"
  ],
  "cardback": [
    "................",
    "..KKKKKKKKKKKK..",
    "..KssSsssSsssK..",
    "..KsssSsssSssK..",
    "..KSsssSsssSsK..",
    "..KsSssFFsssSK..",
    "..KssSFffFsssK..",
    "..KssFSffsFssK..",
    "..KSssFffFsSsK..",
    "..KsSssFFsssSK..",
    "..KssSsssSsssK..",
    "..KsssSsssSssK..",
    "..KSsssSsssSsK..",
    "..KsSsssSsssSK..",
    "..KKKKKKKKKKKK..",
    "................"
  ]
}
;
// END-DATA:SHEETS

// ---------------------------------------------------------------------------
// BG — the HUD backdrop these sprites are authored against (see the header's
// TEAM COLOUR SYNC note). Not part of PALETTE: it is never indexed by a
// sprite pixel, only used by preview/host code that wants to paint the same
// backdrop these sprites were designed to sit on.
// ---------------------------------------------------------------------------
export const BG = '#0a0e16'; // == theme.js COLORS.bg

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

const charIndex = new Map();
for (let i = 0; i < CHARS.length; i++) charIndex.set(CHARS[i], i);

/**
 * Decode one sprite's rows into a detached <canvas>, painted once via
 * ImageData (no per-pixel fillRect calls — this runs once per sprite at
 * load, not per frame). Transparent pixels ('.') get alpha 0; every other
 * character is looked up via CHARS -> PALETTE.
 * @param {string[]} sheet - one sprite: equal-length rows, one char/pixel.
 * @param {string[]} palette - hex colour strings, indexed by CHARS position.
 * @returns {HTMLCanvasElement}
 */
export function decodeSprite(sheet, palette) {
  const h = sheet.length;
  const w = h > 0 ? sheet[0].length : 0;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (w === 0 || h === 0) return canvas;
  const img = ctx.createImageData(w, h);
  for (let ry = 0; ry < h; ry++) {
    const row = sheet[ry];
    for (let rx = 0; rx < w; rx++) {
      const ch = row[rx];
      const o = (ry * w + rx) * 4;
      if (ch === '.') {
        img.data[o + 3] = 0; // transparent; RGB left at 0 does not matter
        continue;
      }
      const idx = charIndex.get(ch);
      const hex = idx === undefined ? undefined : palette[idx];
      if (hex === undefined) {
        // Unknown char in sprite data: render as fully transparent rather
        // than throwing — a malformed sheet should never crash the HUD.
        img.data[o + 3] = 0;
        continue;
      }
      img.data[o] = parseInt(hex.slice(1, 3), 16);
      img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Walk a SHEETS-shaped tree, decoding every leaf sprite (string[]) into a
 * canvas via decodeSprite, and preserving the tree's own nesting otherwise —
 * so decodeAll(SHEETS, PALETTE).agentA.idle is a canvas, while
 * decodeAll(SHEETS, PALETTE).shield is also a canvas (no nesting there).
 */
export function decodeAll(node, palette) {
  if (Array.isArray(node)) return decodeSprite(node, palette);
  const out = {};
  for (const k of Object.keys(node)) out[k] = decodeAll(node[k], palette);
  return out;
}

// ---------------------------------------------------------------------------
// draw
// ---------------------------------------------------------------------------

/**
 * Blit a decoded sprite (an HTMLCanvasElement from decodeSprite/decodeAll)
 * at integer scale, nearest-neighbour, so "real pixel art" stays crisp on a
 * projector or a laptop at any zoom. `x`/`y` are rounded before drawing so
 * the sprite never lands on a half pixel.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} sprite - a decoded canvas, not a raw sheet.
 * @param {number} x
 * @param {number} y
 * @param {number} [scale=4]
 */
export function drawSprite(ctx, sprite, x, y, scale) {
  const k = Math.max(1, Math.round(scale || 4));
  const dx = Math.round(x);
  const dy = Math.round(y);
  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    sprite, 0, 0, sprite.width, sprite.height,
    dx, dy, sprite.width * k, sprite.height * k,
  );
  ctx.imageSmoothingEnabled = prevSmoothing;
}

// ---------------------------------------------------------------------------
// eager decode — once, at load, when a DOM is present (task brief: "drawing
// to an OFFSCREEN canvas once at load"). Under plain `node file.js` (no
// `document`), this degrades to `null` instead of throwing, exactly like
// core/decode.js and core/reduce.js are written to keep working headless.
// ---------------------------------------------------------------------------
export const decoded = typeof document !== 'undefined'
  ? decodeAll(SHEETS, PALETTE)
  : null;
