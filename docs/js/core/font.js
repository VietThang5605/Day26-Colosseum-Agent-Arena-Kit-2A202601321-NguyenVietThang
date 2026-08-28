// kit/arena_ui/core/font.js
//
// COLOSSEUM — a hand-drawn 5x7 bitmap font, rendered to <canvas>
// (CONTRACTS.md §10, FINAL-PLAN.md §8.1: "a hand-drawn 5x7 bitmap font...
// No Google Fonts — the arena must run with the wifi down"). Byte-identical
// between Day26-Colosseum-Agent-Arena-Kit and Day26-Colosseum-Agent-Arena. Native ES
// module, no build step — see core/theme.js's header for why that is safe
// under both a browser `<script type="module">` and plain `node file.js`.
//
// Every glyph is an ORIGINAL 5x7 design (7 rows of 5 chars, "#" = ink drawn
// in whatever colour the caller passes, "." = transparent) — the same
// string-encoding convention as core/sprites.js, just monochrome-per-call
// instead of palette-indexed, since drawText/drawTextUnicode take an
// explicit `color` argument rather than baking a colour into the data.
// Lowercase letters are x-height (rows 2-6) except the ascenders
// b/d/f/h/k/l/t (full 7 rows); g/j/p/q/y are BASELINE-TRUNCATED — a 7-row
// cell has no room below the baseline for a true descender, so those five
// sit on the baseline like the rest of the lowercase set rather than
// dropping below it. This is a legibility trade-off, not a bug.
//
// ===========================================================================
// THE VIETNAMESE TRADE-OFF — read this before touching drawText
// ===========================================================================
// A 5x7 cell is too small to carry Vietnamese diacritics legibly: a-breve,
// a-circumflex, d-stroke, e-circumflex, o-circumflex, o-horn, u-horn, and
// the five tone marks (acute/grave/hook-above/tilde/dot-below) would
// collapse into unreadable noise at this resolution. So there are TWO entry
// points, and picking the wrong one for the wrong string is the failure
// mode to design against:
//
//   drawText(ctx, x, y, str, color, scale)
//     ASCII-FOLDS the string first (Vietnamese diacritics stripped to their
//     base Latin letter via Unicode NFD decomposition + combining-mark
//     removal, plus a hand-mapped case for "d with stroke" — see
//     foldAscii()'s comment for why that one letter needs special-casing —
//     and a few typographic substitutions: en/em dash -> "-", middle dot ->
//     ".", ellipsis -> "...", multiplication sign -> "x"), THEN renders
//     every character in the pixel font. This is honestly-imperfect on
//     Vietnamese input (an ASCII-folded word is still readable, just
//     missing its diacritics) and exactly right for HUD chrome you know is
//     plain ASCII already: labels, numbers, card ids, round/HP/credit text.
//
//   drawTextUnicode(ctx, x, y, str, color, scale)
//     Detects any non-ASCII byte in the string BEFORE folding and, if
//     found, renders the WHOLE string with the canvas's built-in system
//     monospace font instead of the pixel font — real diacritics, correctly
//     shaped, at the cost of not being pixel-perfect next to the rest of
//     the HUD. Silently mangling Vietnamese into wrong-looking ASCII soup
//     would be worse than one inconsistent font in the corner of the
//     screen, so this function exists: call it for anything sourced from
//     the corpus or the match (a claim `argument`, an `answer.text`, a
//     glossary term) rather than assuming it is ASCII.
//
// ===========================================================================
// SIGNATURE NOTE — a resolved contract ambiguity, not a typo
// ===========================================================================
// CONTRACTS.md pins core/font.js as a file but not its function signatures,
// so the exact call shape is a local decision (CONTRACTS.md §0: "anything
// not here is a local decision"). This file's own task brief suggested
// `drawText(ctx, str, x, y, scale, colour)`. core/widgets.js — already
// written and committed to this tree by another agent working in
// parallel — instead calls `_font.drawText(ctx, X, Y, s, color, k)` and
// probes for `_font.measureText`. Since widgets.js is the file that
// actually has to load and call this one, THIS file matches widgets.js:
// `drawText(ctx, x, y, str, color, scale)`, and exports `measureText`
// (aliased as `textWidth` too, for anything that imports font.js directly
// without going through widgets.js and expects the task brief's name).
// drawTextUnicode mirrors the same (ctx, x, y, str, color, scale) order for
// one consistent API surface across both entry points.
//
// Both drawText and drawTextUnicode save/restore every ctx property they
// touch (fillStyle, font, textBaseline, textAlign) — widgets.js's own doc
// comment promises callers "both paths leave ctx exactly as they found it",
// and this file is what keeps that promise true for the pixel-font path.
//
// ===========================================================================
// DATA-EXTRACTION CONTRACT (read by tools/preview_sprites.py, Python
// stdlib-only, never shells out to Node)
// ===========================================================================
// GLYPHS below is written as valid JSON between sentinel comments —
//   // BEGIN-DATA:GLYPHS ... export const GLYPHS = <JSON>; ... // END-DATA:GLYPHS
// The Python tool slices the text between the markers, strips the
// `export const GLYPHS = ` prefix and the trailing `;`, and feeds the rest
// to json.loads(). Every key (including punctuation and the space
// character) is double-quoted, matching JSON string syntax exactly, and
// there is no trailing comma inside the block. The char-legend prose above
// stays in this header, never inside the marked block.
//
// Exports:
//   FONT_W, FONT_H  — glyph cell size (5, 7). Mirrors theme.js FONT.glyphW/
//                     glyphH (which owns SIZING; this file owns the actual
//                     glyph bitmaps) — exported here too so a caller that
//                     only imports font.js, without theme.js, still has them.
//   ADVANCE         — per-character horizontal advance in cells (6 = 5 +
//                     1px gap at scale 1), matches theme.js FONT.glyphGap.
//   GLYPHS          — {char: string[7]} — the raw bitmap table.
//   foldAscii(str)  — the Vietnamese/typographic fold drawText applies.
//   drawText(ctx, x, y, str, color, scale)
//   measureText(str, scale) / textWidth(str, scale) — same function, two names.
//   drawTextUnicode(ctx, x, y, str, color, scale, fontFamily?)

// BEGIN-DATA:GLYPHS
export const GLYPHS = {
  "A": [
    ".###.",
    "#...#",
    "#...#",
    "#####",
    "#...#",
    "#...#",
    "#...#"
  ],
  "B": [
    "####.",
    "#...#",
    "#...#",
    "####.",
    "#...#",
    "#...#",
    "####."
  ],
  "C": [
    ".####",
    "#....",
    "#....",
    "#....",
    "#....",
    "#....",
    ".####"
  ],
  "D": [
    "####.",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "####."
  ],
  "E": [
    "#####",
    "#....",
    "#....",
    "####.",
    "#....",
    "#....",
    "#####"
  ],
  "F": [
    "#####",
    "#....",
    "#....",
    "####.",
    "#....",
    "#....",
    "#...."
  ],
  "G": [
    ".####",
    "#....",
    "#....",
    "#.###",
    "#...#",
    "#...#",
    ".####"
  ],
  "H": [
    "#...#",
    "#...#",
    "#...#",
    "#####",
    "#...#",
    "#...#",
    "#...#"
  ],
  "I": [
    "#####",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "#####"
  ],
  "J": [
    "..###",
    "...#.",
    "...#.",
    "...#.",
    "...#.",
    "#..#.",
    ".##.."
  ],
  "K": [
    "#...#",
    "#..#.",
    "#.#..",
    "##...",
    "#.#..",
    "#..#.",
    "#...#"
  ],
  "L": [
    "#....",
    "#....",
    "#....",
    "#....",
    "#....",
    "#....",
    "#####"
  ],
  "M": [
    "#...#",
    "##.##",
    "#.#.#",
    "#...#",
    "#...#",
    "#...#",
    "#...#"
  ],
  "N": [
    "#...#",
    "##..#",
    "#.#.#",
    "#..##",
    "#...#",
    "#...#",
    "#...#"
  ],
  "O": [
    ".###.",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    ".###."
  ],
  "P": [
    "####.",
    "#...#",
    "#...#",
    "####.",
    "#....",
    "#....",
    "#...."
  ],
  "Q": [
    ".###.",
    "#...#",
    "#...#",
    "#...#",
    "#.#.#",
    "#..#.",
    ".##.#"
  ],
  "R": [
    "####.",
    "#...#",
    "#...#",
    "####.",
    "#.#..",
    "#..#.",
    "#...#"
  ],
  "S": [
    ".####",
    "#....",
    "#....",
    ".###.",
    "....#",
    "....#",
    "####."
  ],
  "T": [
    "#####",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#.."
  ],
  "U": [
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    ".###."
  ],
  "V": [
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    ".#.#.",
    "..#.."
  ],
  "W": [
    "#...#",
    "#...#",
    "#...#",
    "#.#.#",
    "#.#.#",
    "##.##",
    "#...#"
  ],
  "X": [
    "#...#",
    ".#.#.",
    "..#..",
    "..#..",
    "..#..",
    ".#.#.",
    "#...#"
  ],
  "Y": [
    "#...#",
    ".#.#.",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#.."
  ],
  "Z": [
    "#####",
    "....#",
    "...#.",
    "..#..",
    ".#...",
    "#....",
    "#####"
  ],
  "a": [
    ".....",
    ".....",
    ".###.",
    "....#",
    ".####",
    "#...#",
    ".####"
  ],
  "b": [
    "#....",
    "#....",
    "####.",
    "#...#",
    "#...#",
    "#...#",
    "####."
  ],
  "c": [
    ".....",
    ".....",
    ".###.",
    "#....",
    "#....",
    "#....",
    ".###."
  ],
  "d": [
    "....#",
    "....#",
    ".####",
    "#...#",
    "#...#",
    "#...#",
    ".####"
  ],
  "e": [
    ".....",
    ".....",
    ".###.",
    "#...#",
    "#####",
    "#....",
    ".###."
  ],
  "f": [
    "..##.",
    ".#...",
    "####.",
    ".#...",
    ".#...",
    ".#...",
    ".#..."
  ],
  "g": [
    ".....",
    ".....",
    ".####",
    "#...#",
    "#...#",
    ".####",
    "....#"
  ],
  "h": [
    "#....",
    "#....",
    "####.",
    "#...#",
    "#...#",
    "#...#",
    "#...#"
  ],
  "i": [
    "..#..",
    ".....",
    ".##..",
    "..#..",
    "..#..",
    "..#..",
    ".###."
  ],
  "j": [
    "...#.",
    ".....",
    "..##.",
    "...#.",
    "...#.",
    "#..#.",
    ".##.."
  ],
  "k": [
    "#....",
    "#..#.",
    "#.#..",
    "##...",
    "#.#..",
    "#..#.",
    "#...#"
  ],
  "l": [
    ".##..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    ".###."
  ],
  "m": [
    ".....",
    ".....",
    "##.##",
    "#.#.#",
    "#.#.#",
    "#...#",
    "#...#"
  ],
  "n": [
    ".....",
    ".....",
    "####.",
    "#...#",
    "#...#",
    "#...#",
    "#...#"
  ],
  "o": [
    ".....",
    ".....",
    ".###.",
    "#...#",
    "#...#",
    "#...#",
    ".###."
  ],
  "p": [
    ".....",
    ".....",
    "####.",
    "#...#",
    "#...#",
    "####.",
    "#...."
  ],
  "q": [
    ".....",
    ".....",
    ".####",
    "#...#",
    "#...#",
    ".####",
    "....#"
  ],
  "r": [
    ".....",
    ".....",
    "#.##.",
    "##...",
    "#....",
    "#....",
    "#...."
  ],
  "s": [
    ".....",
    ".....",
    ".####",
    "#....",
    ".###.",
    "....#",
    "####."
  ],
  "t": [
    ".#...",
    ".#...",
    "####.",
    ".#...",
    ".#...",
    ".#...",
    "..##."
  ],
  "u": [
    ".....",
    ".....",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    ".####"
  ],
  "v": [
    ".....",
    ".....",
    "#...#",
    "#...#",
    "#...#",
    ".#.#.",
    "..#.."
  ],
  "w": [
    ".....",
    ".....",
    "#...#",
    "#...#",
    "#.#.#",
    "#.#.#",
    ".#.#."
  ],
  "x": [
    ".....",
    ".....",
    "#...#",
    ".#.#.",
    "..#..",
    ".#.#.",
    "#...#"
  ],
  "y": [
    ".....",
    ".....",
    "#...#",
    "#...#",
    "#...#",
    ".####",
    "....#"
  ],
  "z": [
    ".....",
    ".....",
    "#####",
    "...#.",
    "..#..",
    ".#...",
    "#####"
  ],
  "0": [
    ".###.",
    "#...#",
    "#..##",
    "#.#.#",
    "##..#",
    "#...#",
    ".###."
  ],
  "1": [
    "..#..",
    ".##..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    ".###."
  ],
  "2": [
    ".###.",
    "#...#",
    "....#",
    "...#.",
    "..#..",
    ".#...",
    "#####"
  ],
  "3": [
    ".###.",
    "#...#",
    "....#",
    "..##.",
    "....#",
    "#...#",
    ".###."
  ],
  "4": [
    "...#.",
    "..##.",
    ".#.#.",
    "#..#.",
    "#####",
    "...#.",
    "...#."
  ],
  "5": [
    "#####",
    "#....",
    "####.",
    "....#",
    "....#",
    "#...#",
    ".###."
  ],
  "6": [
    "..##.",
    ".#...",
    "#....",
    "####.",
    "#...#",
    "#...#",
    ".###."
  ],
  "7": [
    "#####",
    "....#",
    "...#.",
    "..#..",
    ".#...",
    ".#...",
    ".#..."
  ],
  "8": [
    ".###.",
    "#...#",
    "#...#",
    ".###.",
    "#...#",
    "#...#",
    ".###."
  ],
  "9": [
    ".###.",
    "#...#",
    "#...#",
    ".####",
    "....#",
    "...#.",
    ".##.."
  ],
  " ": [
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    "....."
  ],
  ".": [
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    "..#.."
  ],
  ",": [
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    "..#..",
    ".#..."
  ],
  ":": [
    ".....",
    ".....",
    "..#..",
    ".....",
    "..#..",
    ".....",
    "....."
  ],
  ";": [
    ".....",
    ".....",
    "..#..",
    ".....",
    "..#..",
    ".#...",
    "....."
  ],
  "!": [
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    ".....",
    "..#.."
  ],
  "?": [
    ".###.",
    "#...#",
    "....#",
    "...#.",
    "..#..",
    ".....",
    "..#.."
  ],
  "-": [
    ".....",
    ".....",
    ".....",
    ".###.",
    ".....",
    ".....",
    "....."
  ],
  "_": [
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
    "#####"
  ],
  "/": [
    "....#",
    "...#.",
    "...#.",
    "..#..",
    ".#...",
    ".#...",
    "#...."
  ],
  "\\": [
    "#....",
    ".#...",
    ".#...",
    "..#..",
    "...#.",
    "...#.",
    "....#"
  ],
  "(": [
    "..#..",
    ".#...",
    "#....",
    "#....",
    "#....",
    ".#...",
    "..#.."
  ],
  ")": [
    "..#..",
    "...#.",
    "....#",
    "....#",
    "....#",
    "...#.",
    "..#.."
  ],
  "[": [
    "..##.",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..##."
  ],
  "]": [
    ".##..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    ".##.."
  ],
  "{": [
    "...##",
    "..#..",
    "..#..",
    ".#...",
    "..#..",
    "..#..",
    "...##"
  ],
  "}": [
    "##...",
    "..#..",
    "..#..",
    "...#.",
    "..#..",
    "..#..",
    "##..."
  ],
  "'": [
    "..#..",
    ".#...",
    ".....",
    ".....",
    ".....",
    ".....",
    "....."
  ],
  "\"": [
    ".#.#.",
    ".#.#.",
    ".....",
    ".....",
    ".....",
    ".....",
    "....."
  ],
  "`": [
    "..#..",
    "...#.",
    ".....",
    ".....",
    ".....",
    ".....",
    "....."
  ],
  "=": [
    ".....",
    ".....",
    "#####",
    ".....",
    "#####",
    ".....",
    "....."
  ],
  "+": [
    ".....",
    "..#..",
    "..#..",
    "#####",
    "..#..",
    "..#..",
    "....."
  ],
  "*": [
    ".....",
    "#.#.#",
    ".###.",
    "#.#.#",
    ".....",
    ".....",
    "....."
  ],
  "%": [
    "#...#",
    "...#.",
    "..#..",
    "..#..",
    "..#..",
    ".#...",
    "#...#"
  ],
  "#": [
    ".#.#.",
    "#####",
    ".#.#.",
    "#####",
    ".#.#.",
    ".....",
    "....."
  ],
  "@": [
    ".###.",
    "#...#",
    "#.###",
    "#.#.#",
    "#.##.",
    "#....",
    ".###."
  ],
  "&": [
    ".##..",
    "#..#.",
    "#..#.",
    ".##..",
    "#.#.#",
    "#..#.",
    ".##.#"
  ],
  "~": [
    ".....",
    ".....",
    ".....",
    ".##..",
    "#..##",
    ".....",
    "....."
  ],
  "<": [
    "...#.",
    "..#..",
    ".#...",
    "#....",
    ".#...",
    "..#..",
    "...#."
  ],
  ">": [
    ".#...",
    "..#..",
    "...#.",
    "....#",
    "...#.",
    "..#..",
    ".#..."
  ],
  "|": [
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#.."
  ],
  "^": [
    "..#..",
    ".#.#.",
    ".....",
    ".....",
    ".....",
    ".....",
    "....."
  ],
  "$": [
    "..#..",
    ".####",
    "#.#..",
    ".###.",
    "..#.#",
    "####.",
    "..#.."
  ],
  "�": [
    "#####",
    "#...#",
    "#.#.#",
    "#...#",
    "#.#.#",
    "#...#",
    "#####"
  ]
}
;
// END-DATA:GLYPHS

// ---------------------------------------------------------------------------
// sizing
// ---------------------------------------------------------------------------
export const FONT_W = 5;
export const FONT_H = 7;
export const ADVANCE = 6; // FONT_W + 1px gap at scale 1

// U+FFFD REPLACEMENT CHARACTER — never something a caller types on purpose;
// used internally as the "hollow box" fallback glyph for any character that
// survives foldAscii() but still is not in GLYPHS (a visible signal, per
// review, rather than a silently skipped/blank cell).
const UNKNOWN = '�';

// ---------------------------------------------------------------------------
// foldAscii — the Vietnamese + typographic fold drawText applies
// ---------------------------------------------------------------------------
//
// Order matters: "d with stroke" (đ/Đ, U+0111/U+0110) has NO Unicode
// canonical decomposition — unlike every other Vietnamese base letter, it
// is not "a + combining mark" under NFD, it is its own letter — so it is
// hand-mapped to plain d/D BEFORE normalising. Every other Vietnamese
// diacritic (breve â̆, circumflex, horn, and the five tone marks: acute,
// grave, hook above, tilde, dot below) DOES have a canonical decomposition
// under NFD into base-letter + a combining mark in U+0300..U+036F
// (including the Vietnamese-specific COMBINING HORN, U+031B, and COMBINING
// DOT BELOW, U+0323, both of which fall inside that range) — so NFD +
// stripping that one Unicode block handles all of them in one regex, with
// no per-letter table to keep in sync.
export function foldAscii(str) {
  const s = str == null ? '' : String(str);
  return s
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks: breve, circumflex, horn, 5 tones
    .replace(/[–—]/g, '-') // en dash, em dash
    .replace(/[·]/g, '.') // middle dot
    .replace(/[…]/g, '...') // ellipsis
    .replace(/[×]/g, 'x'); // multiplication sign
}

function hasNonAscii(str) {
  return /[^\x00-\x7f]/.test(str);
}

function glyphRows(ch) {
  return GLYPHS[ch] || GLYPHS[UNKNOWN];
}

// ---------------------------------------------------------------------------
// draw
// ---------------------------------------------------------------------------

function drawGlyph(ctx, rows, x, y, scale) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '#') {
        ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
      }
    }
  }
}

/**
 * Draw `str` in the pixel font, top-left anchored at (x, y). ASCII-folds
 * first (see the Vietnamese trade-off in the header). Integer-aligned;
 * saves and restores every ctx property it touches.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {string} str
 * @param {string} color
 * @param {number} [scale=1]
 * @returns {number} the width drawn, in device px (== measureText's value)
 */
export function drawText(ctx, x, y, str, color, scale) {
  const k = Math.max(1, Math.round(scale || 1));
  const folded = foldAscii(str);
  const X = Math.round(x);
  const Y = Math.round(y);

  const prevFill = ctx.fillStyle;
  ctx.fillStyle = color;
  let cx = X;
  for (const ch of folded) {
    drawGlyph(ctx, glyphRows(ch), cx, Y, k);
    cx += ADVANCE * k;
  }
  ctx.fillStyle = prevFill;

  return cx - X;
}

/**
 * The pixel width drawText(..., str, ..., scale) would occupy, without
 * drawing anything. Same value drawText itself returns.
 * @param {string} str
 * @param {number} [scale=1]
 */
export function measureText(str, scale) {
  const k = Math.max(1, Math.round(scale || 1));
  // Code-point count, not .length (UTF-16 code units) - drawText iterates
  // `for...of` (code points), so an astral character (rare after folding,
  // but foldAscii does not strip everything non-Latin) must count as the
  // same single cell here that it draws as, or this stops matching what it
  // documents itself as measuring.
  return [...foldAscii(str)].length * ADVANCE * k;
}
export const textWidth = measureText; // alias — see the header's signature note

/**
 * Draw `str` correctly regardless of script: pure-ASCII input goes through
 * the pixel font (drawText); anything containing a non-ASCII character —
 * Vietnamese diacritics included — is rendered WHOLE with the canvas's
 * built-in monospace font instead, so it is never mangled. See the header's
 * "THE VIETNAMESE TRADE-OFF" section before choosing this over drawText.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {string} str
 * @param {string} color
 * @param {number} [scale=1]
 * @param {string} [fontFamily] - defaults to a system monospace stack; no
 *   webfont is ever loaded here (CONTRACTS: "the arena must run with the
 *   wifi down").
 * @returns {number} the width drawn, in device px
 */
export function drawTextUnicode(ctx, x, y, str, color, scale, fontFamily) {
  const s = str == null ? '' : String(str);
  const k = Math.max(1, Math.round(scale || 1));
  if (!hasNonAscii(s)) {
    return drawText(ctx, x, y, s, color, k);
  }

  const px = Math.max(1, Math.round(FONT_H * k));
  const prevFont = ctx.font;
  const prevBaseline = ctx.textBaseline;
  const prevAlign = ctx.textAlign;
  const prevFill = ctx.fillStyle;

  ctx.font = `${px}px ${fontFamily || 'ui-monospace, Menlo, Consolas, monospace'}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  ctx.fillText(s, Math.round(x), Math.round(y));
  const w = ctx.measureText(s).width;

  ctx.font = prevFont;
  ctx.textBaseline = prevBaseline;
  ctx.textAlign = prevAlign;
  ctx.fillStyle = prevFill;

  return w;
}
