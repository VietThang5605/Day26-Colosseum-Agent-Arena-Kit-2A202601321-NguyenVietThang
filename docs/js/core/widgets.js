// kit/arena_ui/core/widgets.js
//
// COLOSSEUM — reusable HUD widgets, drawn on <canvas>, shared byte-for-byte
// between Day26-Colosseum-Agent-Arena-Kit and Day26-Colosseum-Agent-Arena (CONTRACTS.md
// §10, FINAL-PLAN.md §8). Every export below is a PURE DRAW FUNCTION:
//
//     widget(ctx, rect, state, t)
//
//   ctx   — a CanvasRenderingContext2D. Every function saves it on entry and
//           restores it on exit, so widgets compose freely in any order with
//           no shared mutable state and no leaked ctx properties between
//           calls (SparView and ProjectorView draw these in different
//           layouts on the same canvas — "the two views compose it
//           differently without conflict" is a hard requirement, not a nice
//           to have).
//   rect  — {x, y, w, h} in canvas pixels, top-left origin. Rounded
//           internally; callers do not need to pre-round.
//   state — the widget's own state SLICE (never the whole MatchState —
//           reduce.js hands each widget just what it needs). Shapes are
//           documented per-function below and are a LOCAL DECISION (not
//           frozen by CONTRACTS.md, which only names the file); reduce.js
//           must conform to them.
//   t     — the current UI clock, in the SAME units and origin as every
//           `changedAt` / `startedAt` field inside `state` (milliseconds,
//           monotonic, e.g. performance.now() or a rAF timestamp — this is
//           an L4 presentation clock, never the scored `t` on an event
//           envelope). A widget never mutates `state`; it only reads it.
//
// No DOM, no CSS, no innerHTML, no webfont — every glyph is either the
// shared 5x7 bitmap font (core/font.js, loaded lazily below) or drawn as
// flat rects. `core/font.js` and `core/sprites.js` are being authored by
// other agents in parallel: this file DEGRADES GRACEFULLY if font.js is not
// there yet (or fails to load) by falling back to a plain monospace canvas
// font, still integer-aligned, and upgrades itself automatically the moment
// font.js becomes available (draw calls happen every animation frame, so
// the upgrade is invisible — no reload needed).
//
// "Everything integer-aligned so nothing renders on a half pixel": every
// coordinate this file computes is passed through r()/rr() before it
// touches ctx.

import { COLORS, SIZES, TIMINGS, sideHpColors, outcomeColor } from './theme.js';

// ---------------------------------------------------------------------------
// tiny numeric / colour helpers
// ---------------------------------------------------------------------------

/** Round to the nearest integer. Never NaN — falls back to 0. */
function r(n) {
  const v = Math.round(n);
  return Number.isFinite(v) ? v : 0;
}

/** Round every field of a {x,y,w,h} rect. */
function rr(rect) {
  return {
    x: r(rect && rect.x), y: r(rect && rect.y),
    w: r(rect && rect.w), h: r(rect && rect.h),
  };
}

function num(v, d) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : d;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

// Deterministic ease — no randomness anywhere in this file (CONTRACTS §11:
// "no unseeded random" is a scoring-code rule, but there is no reason for a
// replay to ever look different on two runs, so the whole file honours it).
function easeOutCubic(x) {
  const k = clamp01(x);
  const inv = 1 - k;
  return 1 - inv * inv * inv;
}

function hexToRgb(hex) {
  const s = typeof hex === 'string' ? hex.replace('#', '') : '000000';
  const n = parseInt(s.length === 3
    ? s.split('').map((c) => c + c).join('')
    : s, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** hex color -> "rgba(r,g,b,a)". Alpha is always applied here, never baked
 *  into theme.js, per that file's header comment. */
function withAlpha(hex, alpha) {
  const { r: R, g: G, b: B } = hexToRgb(hex);
  return `rgba(${R},${G},${B},${clamp01(num(alpha, 1))})`;
}

// ---------------------------------------------------------------------------
// lazy, optional core/font.js — the shared 5x7 bitmap font
// ---------------------------------------------------------------------------
//
// font.js is expected to export drawText(ctx, x, y, str, color, scale) that
// blits hard-edged 5x7 glyphs (CONTRACTS "no webfont"). It may not exist yet
// (another agent is writing it) or may fail to load for any reason; either
// way this module must keep working. We attempt the import exactly once,
// never throw, and fall back to a plain canvas monospace font — still
// integer-aligned — until/unless the real font shows up.

let _font = null;
let _fontLoadStarted = false;

function ensureFontLoading() {
  if (_fontLoadStarted) return;
  _fontLoadStarted = true;
  // Relative to this module's own URL, resolved by the browser/Node ESM
  // loader — never a network fetch off-host either way.
  import('./font.js')
    .then((mod) => {
      if (mod && typeof mod.drawText === 'function') _font = mod;
    })
    .catch((err) => {
      // Expected during early integration: font.js may not exist yet.
      // Log once and keep going — "catch, log, continue" (task brief).
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[arena_ui/widgets] core/font.js unavailable, using fallback text renderer:', err && err.message ? err.message : err);
      }
    });
}
ensureFontLoading();

// The hand-drawn 5x7 bitmap font is very unlikely to cover anything beyond
// printable ASCII, and the deck/course corpus is Vietnamese (CONTRACTS
// §6.1's `argument` is explicitly "EN or VN", <=400 chars, and this project
// has a standing history of VN-glyph rendering defects). Rather than assume
// font.js's glyph coverage, this file only ever routes STRICTLY PRINTABLE
// ASCII through the bitmap font; any string containing anything else
// (Vietnamese diacritics, box-drawing, emoji, ...) always uses the canvas
// fallback font, whose system font stack has real Unicode coverage. This
// also means every literal *this file* generates below is deliberately
// kept plain ASCII, so it is eligible for the pixel font once font.js
// exists — mixed data (an `argument` string) degrades safely instead.
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/**
 * drawPixelText — the one text primitive every widget below uses.
 * Uses the shared 5x7 bitmap font when core/font.js has loaded AND the
 * string is pure printable ASCII; otherwise a bold monospace canvas font at
 * an equivalent cell size (this is also the permanent path for non-ASCII
 * content such as a Vietnamese claim argument). Both paths are
 * integer-aligned and both leave ctx exactly as they found it.
 */
export function drawPixelText(ctx, x, y, str, color, scale) {
  const s = String(str == null ? '' : str);
  const k = Math.max(1, r(num(scale, SIZES.fontScaleBody)));
  const X = r(x), Y = r(y);
  if (_font && typeof _font.drawText === 'function' && ASCII_PRINTABLE.test(s)) {
    _font.drawText(ctx, X, Y, s, color, k);
    return;
  }
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `bold ${7 * k}px "Courier New", ui-monospace, monospace`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(s, X, Y);
  ctx.restore();
}

/** Measures a string as drawPixelText would render it, in integer px. */
export function measurePixelText(ctx, str, scale) {
  const s = String(str == null ? '' : str);
  const k = Math.max(1, r(num(scale, SIZES.fontScaleBody)));
  if (_font && typeof _font.measureText === 'function' && ASCII_PRINTABLE.test(s)) {
    return r(_font.measureText(s, k));
  }
  ctx.save();
  ctx.font = `bold ${7 * k}px "Courier New", ui-monospace, monospace`;
  const w = ctx.measureText(s).width;
  ctx.restore();
  return r(w);
}

// ---------------------------------------------------------------------------
// panel chrome — shared by combatLog / claimCutIn / scrubber / roundBanner
// ---------------------------------------------------------------------------

function drawPanel(ctx, R, { fill = COLORS.panelBg, border = COLORS.panelBorder, borderW = SIZES.borderWidth } = {}) {
  ctx.fillStyle = fill;
  ctx.fillRect(R.x, R.y, R.w, R.h);
  if (borderW > 0) {
    ctx.strokeStyle = border;
    ctx.lineWidth = borderW;
    const inset = borderW / 2;
    ctx.strokeRect(R.x + inset, R.y + inset, R.w - borderW, R.h - borderW);
  }
}

// ---------------------------------------------------------------------------
// small vector glyphs that must NOT depend on font.js (icons, not letters)
// ---------------------------------------------------------------------------

/** A tiny pixel shield, left edge at (x,y), roughly 7x8. Used by combatLog
 *  for a DENIED line and available to callers that want the same glyph
 *  elsewhere (e.g. a persistent "gateway active" indicator). */
function drawShieldGlyph(ctx, x, y, color) {
  const X = r(x), Y = r(y);
  ctx.fillStyle = color;
  // a simple heraldic silhouette built from 1px-cell rects, hand-tuned to
  // read as a shield at 7x8 — same "flat rects, no curves" language as the
  // rest of the pixel art in this file.
  const cells = [
    [1, 0, 5, 1], [0, 1, 7, 1], [0, 2, 7, 2],
    [0, 4, 7, 1], [1, 5, 5, 1], [2, 6, 3, 1], [3, 7, 1, 1],
  ];
  for (const [cx, cy, cw, ch] of cells) {
    ctx.fillRect(X + cx, Y + cy, cw, ch);
  }
}

/** A tiny pixel flag on a pole, top-left at (x,y), roughly 7x7. */
function drawFlagGlyph(ctx, x, y, color) {
  const X = r(x), Y = r(y);
  ctx.fillStyle = color;
  ctx.fillRect(X, Y, 1, 7);        // pole
  ctx.fillRect(X + 1, Y, 5, 4);    // flag body
  ctx.fillRect(X, Y + 7, 3, 1);    // base
}

// ---------------------------------------------------------------------------
// hpBar
// ---------------------------------------------------------------------------
//
// state shape:
// {
//   side: 'A' | 'B',        // 'A' fills left-to-right; 'B' is mirrored
//   hpMax: number,          // default 100
//   from: number,           // HP value the current animation eases FROM
//   to: number,             // HP value the current animation eases TO (truth)
//   changedAt: number,      // t at which `to` last changed; omit/0 => draw `to` static
// }
//
// Fed by the L3 `hp` event (CONTRACTS §5.2 / §10.2: "hp (L3) -> HP bar
// animates over 600 ms"). reduce.js is expected to set `from` to whatever
// was on screen before the change and `changedAt` to the L4 clock time the
// new `hp` event was reduced, then leave `to` fixed until the next `hp`
// event — this function does the tweening, it never advances state itself.

export function hpBar(ctx, rect, state, t) {
  const R = rr(rect);
  const s = state || {};
  const T = num(t, 0);
  const hpMax = Math.max(1, num(s.hpMax, 100));
  const to = clamp(num(s.to, hpMax), 0, hpMax);
  const from = clamp(num(s.from, to), 0, hpMax);
  const changedAt = num(s.changedAt, T);
  const elapsed = Math.max(0, T - changedAt);
  const progress = clamp01(elapsed / TIMINGS.hpAnimMs);
  const eased = easeOutCubic(progress);
  const displayed = lerp(from, to, eased);
  const losingHp = to < from;
  const flashing = losingHp && elapsed < TIMINGS.hpFlashMs;

  const { fill, empty } = sideHpColors(s.side);
  const chunks = Math.max(1, SIZES.hpChunks);
  const gap = SIZES.hpChunkGap;
  const chunkHp = hpMax / chunks;
  const chunkW = Math.max(1, Math.floor((R.w - gap * (chunks - 1)) / chunks));
  const filledChunks = displayed / chunkHp;
  // The band of chunks currently in flux between `from` and `to` — these are
  // the ones that flash red while `flashing` is true.
  const bandLo = Math.floor(Math.min(from, to) / chunkHp);
  const bandHi = Math.ceil(Math.max(from, to) / chunkHp);

  ctx.save();
  ctx.fillStyle = empty;
  ctx.fillRect(R.x, R.y, R.w, R.h);

  for (let i = 0; i < chunks; i++) {
    const chunkX = s.side === 'B'
      ? R.x + R.w - chunkW - i * (chunkW + gap)
      : R.x + i * (chunkW + gap);
    const fillAmount = clamp01(filledChunks - i);
    if (fillAmount <= 0) continue;
    const inBand = i >= bandLo && i < bandHi;
    const color = (flashing && inBand) ? COLORS.damageRed : fill;
    const w = Math.max(0, r(chunkW * fillAmount));
    if (w <= 0) continue;
    // On side A a partial chunk fills from its left edge, staying flush
    // with the fuller chunks to its left. On side B the fuller chunks sit
    // to the RIGHT (mirrored), so a partial chunk must fill from its right
    // edge or the fill visually detaches from the solid block during every
    // damage animation.
    const fillX = s.side === 'B' ? chunkX + (chunkW - w) : chunkX;
    ctx.fillStyle = color;
    ctx.fillRect(fillX, R.y, w, R.h);
  }

  ctx.strokeStyle = COLORS.panelBorder;
  ctx.lineWidth = SIZES.borderWidth;
  ctx.strokeRect(R.x + 1, R.y + 1, R.w - 2, R.h - 2);
  ctx.restore();

  // HP number, in the pixel font, centred on the bar.
  const label = String(Math.max(0, Math.round(displayed)));
  const scale = SIZES.fontScaleBody;
  const tw = measurePixelText(ctx, label, scale);
  const tx = R.x + Math.floor((R.w - tw) / 2);
  const ty = R.y + Math.floor((R.h - 7 * scale) / 2);
  // a 1px dark backing so the number reads over any chunk colour
  ctx.save();
  ctx.fillStyle = withAlpha(COLORS.bg, 0.55);
  ctx.fillRect(tx - 1, ty - 1, tw + 2, 7 * scale + 2);
  ctx.restore();
  drawPixelText(ctx, tx, ty, label, COLORS.text, scale);
}

// ---------------------------------------------------------------------------
// creditBar
// ---------------------------------------------------------------------------
//
// state shape:
// {
//   side: 'A' | 'B',
//   creditsMax: number,     // default 100 (CONTRACTS §4: 100 cr/duel side)
//   from: number,
//   to: number,
//   changedAt: number,      // t at which `to` last changed
//   delta: number | null,   // last charge, e.g. -6; drives the floating label
// }

export function creditBar(ctx, rect, state, t) {
  const R = rr(rect);
  const s = state || {};
  const T = num(t, 0);
  const crMax = Math.max(1, num(s.creditsMax, 100));
  const to = clamp(num(s.to, crMax), 0, crMax);
  const from = clamp(num(s.from, to), 0, crMax);
  const changedAt = num(s.changedAt, T);
  const elapsed = Math.max(0, T - changedAt);
  const eased = easeOutCubic(clamp01(elapsed / TIMINGS.creditTweenMs));
  const displayed = lerp(from, to, eased);
  const frac = clamp01(displayed / crMax);

  ctx.save();
  ctx.fillStyle = COLORS.creditBarBg;
  ctx.fillRect(R.x, R.y, R.w, R.h);
  const w = r(R.w * frac);
  ctx.fillStyle = COLORS.creditBar;
  if (s.side === 'B') {
    ctx.fillRect(R.x + R.w - w, R.y, w, R.h);
  } else {
    ctx.fillRect(R.x, R.y, w, R.h);
  }
  ctx.restore();

  const delta = num(s.delta, 0);
  if (delta !== 0 && elapsed < TIMINGS.creditFloatMs) {
    const fp = clamp01(elapsed / TIMINGS.creditFloatMs);
    const riseY = R.y - r(10 * fp);
    const alpha = 1 - fp;
    const text = `${delta > 0 ? '+' : ''}${Math.round(delta)} cr`;
    const scale = SIZES.fontScaleSmall;
    const anchorX = s.side === 'B'
      ? R.x + R.w - w
      : R.x + w;
    const tw = measurePixelText(ctx, text, scale);
    const tx = clamp(anchorX - tw / 2, R.x, R.x + R.w - tw);
    drawPixelText(ctx, tx, riseY, text, withAlpha(COLORS.creditFloat, alpha), scale);
  }
}

// ---------------------------------------------------------------------------
// latentFlags — the ⚑ counter under each HP bar (CONTRACTS §6.3/§10.2)
// ---------------------------------------------------------------------------
//
// state shape: { count: number, changedAt?: number }
// `count` is `latent_violations` for this side — CONTRACTS §6.4's nine
// deterministically-detected classes minus the ones already verified under
// the same causal event. Never HP; purely informational.

export function latentFlags(ctx, rect, state, t) {
  const R = rr(rect);
  const s = state || {};
  const T = num(t, 0);
  const count = Math.max(0, Math.round(num(s.count, 0)));
  const changedAt = num(s.changedAt, -Infinity);
  const elapsed = T - changedAt;
  const pulsing = elapsed >= 0 && elapsed < 300;
  const scale = pulsing ? SIZES.fontScaleBody + 1 : SIZES.fontScaleSmall;

  ctx.save();
  drawFlagGlyph(ctx, R.x, R.y, COLORS.unprovenGrey);
  drawPixelText(ctx, R.x + 10, R.y, String(count), COLORS.unprovenGrey, scale);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// combatLog
// ---------------------------------------------------------------------------
//
// state shape:
// {
//   lines: [
//     { seq: number, text: string, costLabel?: string, denied?: boolean }
//     ...
//   ]
// }
//
// `text` is already domain-formatted by the caller (e.g.
// "mcp  slides.query  fields=[title,body]"); this widget owns layout,
// scrolling, the seq column, the shield glyph and the cost column only.
// `lines` may be any length — the widget shows however many fit the rect,
// most recent at the bottom, and never assumes it is pre-trimmed (though
// CONTRACTS §10.1 asks the client to bound it to 200 anyway).

export function combatLog(ctx, rect, state, t) {
  const R = rr(rect);
  const s = state || {};
  const rawLines = Array.isArray(s.lines) ? s.lines : [];
  const lines = rawLines.slice().sort((a, b) => num(a && a.seq, 0) - num(b && b.seq, 0));

  ctx.save();
  drawPanel(ctx, R, {});

  const pad = SIZES.combatLogPadding;
  const lineH = SIZES.combatLogLineH;
  const innerW = R.w - pad * 2;
  const visibleCount = Math.max(0, Math.floor((R.h - pad * 2) / lineH));
  const visible = lines.slice(Math.max(0, lines.length - visibleCount));

  ctx.beginPath();
  ctx.rect(R.x, R.y, R.w, R.h);
  ctx.clip();

  let y = R.y + R.h - pad - lineH * visible.length;
  for (const line of visible) {
    const denied = !!(line && line.denied);
    const seq = String(Math.max(0, Math.round(num(line && line.seq, 0)))).padStart(4, '0');
    let x = R.x + pad;
    drawPixelText(ctx, x, y, seq, COLORS.textDim, SIZES.fontScaleSmall);
    x += measurePixelText(ctx, seq, SIZES.fontScaleSmall) + 6;

    if (denied) {
      drawShieldGlyph(ctx, x, y, COLORS.denyBlue);
      x += 10;
    }

    const text = String((line && line.text) || '');
    const costLabel = line && line.costLabel ? String(line.costLabel) : '';
    const costW = costLabel ? measurePixelText(ctx, costLabel, SIZES.fontScaleSmall) : 0;
    const maxTextW = Math.max(0, R.x + pad + innerW - x - (costW ? costW + 8 : 0));
    const truncated = clipTextToWidth(ctx, text, maxTextW, SIZES.fontScaleSmall);
    drawPixelText(ctx, x, y, truncated, denied ? COLORS.denyBlue : COLORS.text, SIZES.fontScaleSmall);

    if (costLabel) {
      const cx = R.x + pad + innerW - costW;
      drawPixelText(ctx, cx, y, costLabel, COLORS.textDim, SIZES.fontScaleSmall);
    }
    y += lineH;
  }
  ctx.restore();
}

function clipTextToWidth(ctx, text, maxW, scale) {
  if (maxW <= 0) return '';
  if (measurePixelText(ctx, text, scale) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = text.slice(0, mid) + '...';
    if (measurePixelText(ctx, candidate, scale) <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '...' : '';
}

// ---------------------------------------------------------------------------
// claimCutIn — THE MOST IMPORTANT WIDGET IN THE UI
// ---------------------------------------------------------------------------
//
// state shape (fed by an L2 `claim_outcome` event — CONTRACTS §5.2/§6):
// {
//   active: boolean,
//   startedAt: number,        // t this cut-in began sliding in
//   prosecutingTeam: string,
//   cls: string,               // one of the 17 defect classes
//   evidence: string[],        // "evt:0412" style refs, 1..4
//   argument: string,          // <= 400 chars, EN or VN
//   outcome: 'verified' | 'unproven' | 'false',
//   weight: number,
//   scaled: number,            // the already round_scale'd magnitude
// }
//
// Draws nothing when inactive, and stops drawing on its own once
// TIMINGS.cutinHoldMs has elapsed since `startedAt` — even if the caller is
// slow to flip `active` back to false, this widget never renders forever.
// reduce.js still owns clearing the state; this is defence in depth so a
// stale cut-in can never wedge the screen.

/** Where the prosecution cut-in is allowed to draw.
 *
 *  The cut-in used to be pinned to the bottom of the featured pane
 *  (`rect.h - 108`), which is exactly where the five-stage strip now lives --
 *  so every prosecution animated straight over QUESTION > ACTION > ANSWER >
 *  EVAL > REFEREE and hid the two stages (eval, referee) it was announcing.
 *  Moving it "up a bit" is not enough: on a short window the clamp can push it
 *  back down again. So the bound is computed, not chosen -- the returned rect
 *  is guaranteed to END above `stripTop`, whatever the pane size.
 *
 *  @param paneRect the featured pane
 *  @param logTop   y of the combat log (the cut-in sits above it)
 *  @param stripTop y of the five-stage strip -- the hard floor
 */
export function cutInRect(paneRect, logTop, stripTop, cutH = 100) {
  const R = rr(paneRect);
  const floor = Math.min(num(logTop, R.y + R.h) - 12, num(stripTop, R.y + R.h) - 8);
  const top = Math.max(R.y + 8, floor - Math.max(24, num(cutH, 100)));
  return { x: R.x + 8, y: top, w: R.w - 16, h: Math.max(24, floor - top) };
}

export function claimCutIn(ctx, rect, state, t) {
  const s = state || {};
  if (!s.active) return;
  const R = rr(rect);
  const T = num(t, 0);
  const startedAt = num(s.startedAt, T);
  const elapsed = T - startedAt;
  if (elapsed < 0 || elapsed > TIMINGS.cutinHoldMs) return;

  const slideK = easeOutCubic(clamp01(elapsed / TIMINGS.cutinSlideMs));
  const offsetY = r(-R.h * (1 - slideK));
  const y0 = R.y + offsetY;

  const outcome = s.outcome === 'verified' || s.outcome === 'false' || s.outcome === 'unproven'
    ? s.outcome : 'unproven';
  const accent = outcomeColor(outcome);

  ctx.save();
  ctx.beginPath();
  ctx.rect(R.x, R.y, R.w, R.h);
  ctx.clip();

  drawPanel(ctx, { x: R.x, y: y0, w: R.w, h: R.h }, { fill: withAlpha(accent, 0.16), border: accent, borderW: SIZES.borderWidth });
  ctx.fillStyle = accent;
  ctx.fillRect(R.x, y0, 4, R.h); // left accent bar — "a special move landing"

  const pad = SIZES.cutinPadding;
  const team = s.prosecutingTeam ? String(s.prosecutingTeam) : 'PROSECUTOR';
  const cls = s.cls ? String(s.cls) : 'unknown_class';
  const evidence = Array.isArray(s.evidence) ? s.evidence.filter(Boolean).join(', ') : '';

  let ty = y0 + pad;
  const header = `${team} PROSECUTES - ${cls}${evidence ? ` @ ${evidence}` : ''}`;
  drawPixelText(ctx, R.x + pad + 6, ty, header, COLORS.text, SIZES.fontScaleSmall);
  ty += 7 * SIZES.fontScaleSmall + 4;

  if (s.argument) {
    const argLines = wrapTextToWidth(ctx, String(s.argument).slice(0, 400), R.w - pad * 2 - 6, SIZES.fontScaleSmall, 2);
    for (const line of argLines) {
      drawPixelText(ctx, R.x + pad + 6, ty, line, COLORS.textDim, SIZES.fontScaleSmall);
      ty += 7 * SIZES.fontScaleSmall + 2;
    }
  }

  const weight = num(s.weight, 0);
  const scaled = Math.round(Math.abs(num(s.scaled, 0)));
  let verdictText;
  if (outcome === 'verified') {
    const mult = weight > 0 ? (scaled / weight) : 1;
    verdictText = `VERIFIED - ${Math.round(weight)} x ${mult.toFixed(2)} = ${scaled} DAMAGE`;
  } else if (outcome === 'false') {
    verdictText = `FALSE - ${team} TAKES ${scaled} RECOIL`;
  } else {
    verdictText = 'UNPROVEN - NO DAMAGE';
  }
  drawPixelText(ctx, R.x + pad + 6, y0 + R.h - pad - 7 * SIZES.fontScaleBody, verdictText, accent, SIZES.fontScaleBody);

  ctx.restore();
}

function wrapTextToWidth(ctx, text, maxW, scale, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (measurePixelText(ctx, candidate, scale) <= maxW || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length >= maxLines) {
    const last = lines[maxLines - 1];
    if (measurePixelText(ctx, last, scale) > maxW) {
      lines[maxLines - 1] = clipTextToWidth(ctx, last, maxW, scale);
    }
  }
  return lines.slice(0, maxLines);
}

// ---------------------------------------------------------------------------
// roundBanner — "ROUND 6/10  x1.25" between rounds
// ---------------------------------------------------------------------------
//
// state shape:
// { round: number, totalRounds?: number, scale?: number, startedAt?: number }
//
// If `startedAt` is omitted the banner is drawn fully opaque and persistent
// (a HUD strip that always shows the current round). If provided, it fades
// out over the last third of TIMINGS.roundBannerMs and then draws nothing —
// matching the transient "between rounds" beat in FINAL-PLAN §8.2.

export function roundBanner(ctx, rect, state, t) {
  const R = rr(rect);
  const s = state || {};
  const T = num(t, 0);
  const round = Math.max(1, Math.round(num(s.round, 1)));
  const total = Math.max(1, Math.round(num(s.totalRounds, 10)));
  const scale = num(s.scale, 1);

  let alpha = 1;
  if (typeof s.startedAt === 'number') {
    const elapsed = T - s.startedAt;
    if (elapsed < 0) return;
    if (elapsed > TIMINGS.roundBannerMs) return;
    const fadeStart = TIMINGS.roundBannerMs * 0.66;
    alpha = elapsed > fadeStart
      ? clamp01(1 - (elapsed - fadeStart) / (TIMINGS.roundBannerMs - fadeStart))
      : 1;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  drawPanel(ctx, R, { fill: withAlpha(COLORS.panelBg, 0.85) });

  const roundText = `ROUND ${round}/${total}`;
  const scaleText = Math.abs(scale - 1) > 1e-9 ? `x${scale.toFixed(2)} SCALE` : '';
  const fscale = SIZES.fontScaleBody;
  const w1 = measurePixelText(ctx, roundText, fscale);
  const x1 = R.x + Math.floor((R.w - w1) / 2);
  const y1 = R.y + Math.floor((R.h - 7 * fscale) / 2) - (scaleText ? 6 : 0);
  drawPixelText(ctx, x1, y1, roundText, COLORS.text, fscale);
  if (scaleText) {
    const w2 = measurePixelText(ctx, scaleText, SIZES.fontScaleSmall);
    const x2 = R.x + Math.floor((R.w - w2) / 2);
    drawPixelText(ctx, x2, y1 + 7 * fscale + 2, scaleText, COLORS.textDim, SIZES.fontScaleSmall);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// scrubber — replay transport
// ---------------------------------------------------------------------------
//
// state shape:
// { playing: boolean, offset: number, total: number, speed: 1 | 2 | 8 }
//
// Canvas has no DOM hit-testing, so this widget (uniquely among the ones
// here) RETURNS a small map of the regions it just drew, in the same
// coordinate space as `rect`, so the composing view can turn a click/tap
// into play/pause, a seek, or a speed change without this file ever
// touching an event listener:
//
//   { playPause, seekTrack, speed1, speed2, speed8 }   // each {x,y,w,h}
//
// `seekTrack` maps to a byte offset as
// `offset = total * clamp01((mouseX - seekTrack.x) / seekTrack.w)`.

export function scrubber(ctx, rect, state, t) {
  const R = rr(rect);
  const s = state || {};
  const total = Math.max(1, num(s.total, 1));
  const offset = clamp(num(s.offset, 0), 0, total);
  const playing = !!s.playing;
  const speed = [1, 2, 8].includes(s.speed) ? s.speed : 1;

  ctx.save();
  drawPanel(ctx, R, {});

  const gap = SIZES.scrubberGap;
  const btn = Math.min(SIZES.scrubberBtnSize, R.h - gap * 2);
  const btnY = R.y + Math.floor((R.h - btn) / 2);
  const playPause = { x: R.x + gap, y: btnY, w: btn, h: btn };

  ctx.fillStyle = COLORS.text;
  if (playing) {
    const bw = Math.max(1, Math.floor(btn / 4));
    ctx.fillRect(playPause.x, playPause.y, bw, btn);
    ctx.fillRect(playPause.x + btn - bw, playPause.y, bw, btn);
  } else {
    ctx.beginPath();
    ctx.moveTo(playPause.x, playPause.y);
    ctx.lineTo(playPause.x + btn, playPause.y + Math.floor(btn / 2));
    ctx.lineTo(playPause.x, playPause.y + btn);
    ctx.closePath();
    ctx.fill();
  }

  const speedLabels = ['1x', '2x', '8x'];
  const speedW = 22;
  const speedsX = R.x + R.w - gap - speedW * speedLabels.length;
  const speedRects = {};
  speedLabels.forEach((label, i) => {
    const sx = speedsX + i * speedW;
    const active = speed === [1, 2, 8][i];
    const rectI = { x: sx, y: R.y + gap, w: speedW - 4, h: R.h - gap * 2 };
    speedRects[`speed${[1, 2, 8][i]}`] = rectI;
    if (active) {
      ctx.fillStyle = withAlpha(COLORS.creditBar, 0.25);
      ctx.fillRect(rectI.x, rectI.y, rectI.w, rectI.h);
    }
    drawPixelText(ctx, rectI.x + 2, rectI.y + Math.floor((rectI.h - 7) / 2), label, active ? COLORS.creditBar : COLORS.textDim, SIZES.fontScaleSmall);
  });

  const trackX = playPause.x + btn + gap * 2;
  const trackW = Math.max(0, speedsX - gap - trackX);
  const trackY = R.y + Math.floor(R.h / 2) - 1;
  const seekTrack = { x: trackX, y: R.y + gap, w: trackW, h: R.h - gap * 2 };

  ctx.fillStyle = COLORS.creditBarBg;
  ctx.fillRect(trackX, trackY, trackW, 2);
  const filled = r(trackW * clamp01(offset / total));
  ctx.fillStyle = COLORS.creditBar;
  ctx.fillRect(trackX, trackY, filled, 2);
  ctx.fillRect(trackX + filled - 1, trackY - 3, 3, 8); // handle

  ctx.restore();

  return { playPause, seekTrack, speed1: speedRects.speed1, speed2: speedRects.speed2, speed8: speedRects.speed8 };
}

// ---------------------------------------------------------------------------
// screenShake — pure transform helper, no ctx, no drawing
// ---------------------------------------------------------------------------
//
// state shape: { startedAt: number, magnitude?: number } | null
// returns { dx: int, dy: int } — the caller ctx.translate()s by this before
// drawing the rest of the frame, and translates back afterwards.
// Deterministic in t (a sine/cosine combination, not Math.random) so the
// same trace always shakes identically on replay.

export function screenShake(state, t) {
  const s = state;
  if (!s || typeof s.startedAt !== 'number') return { dx: 0, dy: 0 };
  const T = num(t, 0);
  const elapsed = T - s.startedAt;
  if (elapsed < 0 || elapsed > TIMINGS.shakeMs) return { dx: 0, dy: 0 };
  const decay = 1 - elapsed / TIMINGS.shakeMs;
  const mag = num(s.magnitude, TIMINGS.shakeMagnitudePx) * decay;
  const dx = r(Math.sin(elapsed * 0.09) * mag);
  const dy = r(Math.cos(elapsed * 0.13) * mag * 0.6);
  return { dx, dy };
}

// ---------------------------------------------------------------------------
// particleBurst — small burst + the mutation class label, in the attacker's
// colour (CONTRACTS §10.2: "mutation applied:true -> screen shake + the
// class name in the attacker's colour")
// ---------------------------------------------------------------------------
//
// state shape:
// { startedAt: number, x: number, y: number, color?: string, label?: string }
// x/y are canvas-absolute coordinates (the point the mutation landed);
// `rect` is only used as a fallback centre when x/y are omitted.

export function particleBurst(ctx, rect, state, t) {
  const s = state;
  if (!s || typeof s.startedAt !== 'number') return;
  const T = num(t, 0);
  const elapsed = T - s.startedAt;
  if (elapsed < 0 || elapsed > TIMINGS.particleMs) return;

  const R = rr(rect);
  const cx = r(num(s.x, R.x + R.w / 2));
  const cy = r(num(s.y, R.y + R.h / 2));
  const color = s.color || COLORS.mutationSpark;
  const progress = elapsed / TIMINGS.particleMs;
  const alpha = 1 - progress;
  const maxRadius = 26;
  const n = SIZES.particleCount;

  ctx.save();
  ctx.fillStyle = withAlpha(color, alpha);
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + i * 0.37;
    const speed = 0.6 + 0.4 * Math.sin(i * 2.4);
    const radius = maxRadius * progress * speed;
    const px = r(cx + Math.cos(angle) * radius);
    const py = r(cy + Math.sin(angle) * radius);
    ctx.fillRect(px, py, SIZES.particleSize, SIZES.particleSize);
  }
  ctx.restore();

  if (s.label) {
    const scale = SIZES.fontScaleSmall;
    const text = String(s.label);
    const tw = measurePixelText(ctx, text, scale);
    drawPixelText(ctx, cx - Math.floor(tw / 2), cy - 10 - r(6 * progress), text, withAlpha(color, alpha), scale);
  }
}

// ---------------------------------------------------------------------------
// pipelinePanel — the five stages of one exchange, left to right
// ---------------------------------------------------------------------------

/** Stage headers, in the order an exchange actually happens. */
const PIPELINE_STAGES = Object.freeze([
  { key: 'question', n: '1', label: 'QUESTION' },
  { key: 'actions',  n: '2', label: 'ACTION'   },
  { key: 'answer',   n: '3', label: 'ANSWER'   },
  { key: 'evals',    n: '4', label: 'EVAL'     },
  { key: 'verdicts', n: '5', label: 'REFEREE'  },
]);

/** Truncate to `max` characters with a trailing ellipsis glyph. */
function clip(str, max) {
  const s = String(str == null ? '' : str);
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** The last path segment of an anchor/concept — `Concept:baggage/w/014`
 *  is unreadable at 5x7; `baggage` is the part a viewer can actually use. */
function shortConcept(s) {
  const str = String(s || '');
  const afterNs = str.includes(':') ? str.slice(str.indexOf(':') + 1) : str;
  return afterNs.split('/')[0] || afterNs;
}

/** Which stages have content yet — used to light the active border. */
function stageFilled(pl, key) {
  if (!pl) return false;
  const v = pl[key];
  return Array.isArray(v) ? v.length > 0 : v != null;
}

/** The body lines for one stage column. Pure: no drawing, so the layout is
 *  testable and the renderer stays a dumb painter. */
function stageLines(pl, key, cols) {
  if (!pl) return [];
  if (key === 'question') {
    const q = pl.question;
    if (!q) return ['(waiting)'];
    return [
      clip(q.type || 'ask', cols),
      clip(shortConcept(q.concept), cols),
      q.require && q.require.length ? clip(`needs ${q.require.join(',')}`, cols) : '',
      q.cardId ? clip(`card ${q.cardId}`, cols) : '',
    ].filter(Boolean);
  }
  if (key === 'actions') {
    const acts = pl.actions || [];
    if (!acts.length) return ['(no calls)'];
    const out = [];
    for (const a of acts.slice(-3)) {
      out.push(clip(`${a.server || '?'}.${a.tool || '?'}`, cols));
      // The ARENA's applied verdict, not the student's stated one: a
      // malformed Decision is charged as a deny whatever the student meant.
      const v = a.applied || a.verdict || '...';
      out.push(clip(`  ${v === 'deny' ? 'X DENIED' : v === 'forward' ? '> forward' : v === 'rewrite' ? '~ rewrite' : v}`, cols));
    }
    if (acts.length > 3) out.push(`  +${acts.length - 3} earlier`);
    return out;
  }
  if (key === 'answer') {
    const a = pl.answer;
    if (!a) return ['(no answer yet)'];
    return [
      a.spans == null ? '' : `${a.spans} span${a.spans === 1 ? '' : 's'}`,
      `${(a.anchors || []).length} anchor${(a.anchors || []).length === 1 ? '' : 's'}`,
      a.chars == null ? '' : `${a.chars} chars`,
      (a.anchors || []).length ? clip(shortConcept(a.anchors[0]), cols) : 'UNCITED',
    ].filter(Boolean);
  }
  if (key === 'evals') {
    const ev = pl.evals || [];
    if (!ev.length) return ['(no claim filed)', 'no claim,', 'no damage'];
    const out = [];
    for (const e of ev.slice(-2)) {
      out.push(clip(e.cls || '?', cols));
      out.push(clip(`  ${(e.evidence || [])[0] || 'no evidence'}`, cols));
    }
    if (ev.length > 2) out.push(`  +${ev.length - 2} more`);
    return out;
  }
  // verdicts
  const vs = pl.verdicts || [];
  if (!vs.length) return ['(not ruled)'];
  const out = [];
  for (const v of vs.slice(-3)) {
    const scaled = v.scaled == null ? '' : ` ${v.scaled > 0 ? '-' : ''}${Math.abs(v.scaled)}hp`;
    out.push(clip(`${String(v.outcome || '?').toUpperCase()}${scaled}`, cols));
    out.push(clip(`  ${v.cls || ''}`, cols));
  }
  return out;
}

/** The colour a stage's body text takes. Referee outcomes carry the frozen
 *  semantics from CONTRACTS §10.2 — red damage, magenta recoil, grey unproven. */
function stageColor(key, pl) {
  if (key !== 'verdicts') return COLORS.text;
  const last = (pl && pl.verdicts && pl.verdicts[pl.verdicts.length - 1]) || null;
  if (!last) return COLORS.textDim;
  if (last.outcome === 'verified') return COLORS.damageRed;
  if (last.outcome === 'false') return COLORS.falseRecoil;
  return COLORS.unprovenGrey;
}

/**
 * The five-stage strip for ONE side's current exchange:
 *
 *   QUESTION -> ACTION -> ANSWER -> EVAL -> REFEREE
 *
 * This exists because the combat log answers "what happened next" but never
 * "what was asked, what did the gateway do about it, and what did that cost" —
 * a viewer had to reconstruct the shape of an exchange from interleaved lines.
 * Each column lights its border once it has content, so the strip also reads as
 * a progress indicator for the round.
 *
 * `side` is 'A' or 'B'; the panel renders that side's `pipeline` state.
 */
export function pipelinePanel(ctx, rect, state, side, t) {
  const R = { x: r(rect.x), y: r(rect.y), w: r(rect.w), h: r(rect.h) };
  const sd = (state && state.sides && state.sides[side]) || null;
  const pl = sd ? sd.pipeline : null;
  const accent = side === 'B' ? COLORS.sideB : COLORS.sideA;

  const gap = 4;
  const colW = Math.floor((R.w - gap * (PIPELINE_STAGES.length - 1)) / PIPELINE_STAGES.length);
  const scale = SIZES.fontScaleSmall;
  const charW = 6 * scale;           // 5px cell + 1px tracking, as drawPixelText lays out
  const cols = Math.max(6, Math.floor((colW - 10) / charW));
  const lineH = SIZES.combatLogLineH;

  PIPELINE_STAGES.forEach((stage, i) => {
    const x = R.x + i * (colW + gap);
    const filled = stageFilled(pl, stage.key);
    drawPanel(ctx, { x, y: R.y, w: colW, h: R.h }, {
      fill: COLORS.panelBg,
      border: filled ? accent : COLORS.panelBorder,
      borderW: SIZES.borderWidth,
    });

    // header: "1 QUESTION", dimmed until the stage has actually happened
    drawPixelText(ctx, x + 5, R.y + 5, `${stage.n} ${clip(stage.label, cols)}`,
                  filled ? accent : COLORS.textDim, scale);
    // a hairline under the header
    ctx.fillStyle = filled ? accent : COLORS.panelBorder;
    ctx.fillRect(x + 4, R.y + 5 + lineH + 1, colW - 8, 1);

    const lines = stageLines(pl, stage.key, cols);
    const bodyColor = filled ? stageColor(stage.key, pl) : COLORS.textDim;
    let y = R.y + 5 + lineH + 6;
    const maxLines = Math.floor((R.h - (y - R.y) - 4) / lineH);
    for (const line of lines.slice(0, Math.max(0, maxLines))) {
      drawPixelText(ctx, x + 5, y, clip(line, cols), bodyColor, scale);
      y += lineH;
    }

    // the arrow between columns, so the ORDER is unmistakable
    if (i < PIPELINE_STAGES.length - 1) {
      drawPixelText(ctx, x + colW + 1, R.y + R.h / 2 - 4, '>', COLORS.textDim, scale);
    }
  });
}
