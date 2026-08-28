// docs/js/app.js — Colosseum Web Arena Controller & Canvas HUD Renderer

import { PRESETS } from './presets.js';
import { initPyodideSimulator, runSimulation } from './simulator.js';
import { normalizeEvent } from './core/decode.js';
import { createInitialState, reduce } from './core/reduce.js';
import { decoded as SPRITES, drawSprite } from './core/sprites.js';
import {
  hpBar, creditBar, latentFlags, combatLog, claimCutIn, roundBanner,
  pipelinePanel, screenShake, particleBurst, drawPixelText, measurePixelText,
} from './core/widgets.js';
import { COLORS, SIZES, TIMINGS, outcomeColor } from './core/theme.js';

// ===========================================================================
// 1. Canvas & Logical Dimensions (960x700 with 5-stage pipeline strips)
// ===========================================================================
const LOGICAL_W = 960;
const LOGICAL_H = 700;

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const container = canvas.parentElement;
  const availW = container ? container.clientWidth : 960;
  const scale = Math.max(0.1, Math.min(availW / LOGICAL_W, 1));
  const cssW = Math.floor(LOGICAL_W * scale);
  const cssH = Math.floor(LOGICAL_H * scale);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(LOGICAL_W * dpr);
  canvas.height = Math.round(LOGICAL_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ===========================================================================
// 2. Layout Rects (Integer-aligned over 960x700 logical canvas)
// ===========================================================================
const PAD = 16;
const HALF_W = Math.floor((LOGICAL_W - PAD * 2 - 40) / 2);
const LEFT_X = PAD;
const RIGHT_X = LOGICAL_W - PAD - HALF_W;

const INTEGRITY_BAR_H = 20;
const HUD_Y = INTEGRITY_BAR_H + 6;
const HP_Y = HUD_Y + 18;
const CREDIT_Y = HP_Y + SIZES.hpBarHeight + SIZES.creditBarGapY;

const STAGE_Y = CREDIT_Y + 14;
const STAGE_H = 210;
const LOG_Y = STAGE_Y + STAGE_H + 4;
const LOG_H = 120;
const PIPE_H = 76;
const PIPE_A_Y = LOG_Y + LOG_H + 16;
const PIPE_B_Y = PIPE_A_Y + PIPE_H + 14;
const CUTIN_Y = PIPE_B_Y + PIPE_H + 6;
const CUTIN_H = LOGICAL_H - CUTIN_Y - 12;

const SPRITE_BOX = 112;
const LAYOUT = {
  hpLeft: { x: LEFT_X, y: HP_Y, w: HALF_W, h: SIZES.hpBarHeight },
  hpRight: { x: RIGHT_X, y: HP_Y, w: HALF_W, h: SIZES.hpBarHeight },
  creditLeft: { x: LEFT_X, y: CREDIT_Y, w: HALF_W - 60, h: SIZES.creditBarHeight },
  creditRight: { x: RIGHT_X + 60, y: CREDIT_Y, w: HALF_W - 60, h: SIZES.creditBarHeight },
  latentLeft: { x: LEFT_X + HALF_W - 52, y: CREDIT_Y - 4 },
  latentRight: { x: RIGHT_X, y: CREDIT_Y - 4 },
  roundBanner: { x: LOGICAL_W / 2 - 120, y: STAGE_Y + 6, w: 240, h: SIZES.roundBannerHeight },
  spriteA: { x: LOGICAL_W / 2 - 180 - SPRITE_BOX, y: STAGE_Y + STAGE_H / 2 - SPRITE_BOX / 2, w: SPRITE_BOX, h: SPRITE_BOX },
  spriteB: { x: LOGICAL_W / 2 + 180, y: STAGE_Y + STAGE_H / 2 - SPRITE_BOX / 2, w: SPRITE_BOX, h: SPRITE_BOX },
  log: { x: PAD, y: LOG_Y, w: LOGICAL_W - PAD * 2, h: LOG_H },
  pipelineA: { x: PAD, y: PIPE_A_Y, w: LOGICAL_W - PAD * 2, h: PIPE_H },
  pipelineB: { x: PAD, y: PIPE_B_Y, w: LOGICAL_W - PAD * 2, h: PIPE_H },
  cutin: { x: PAD, y: CUTIN_Y, w: LOGICAL_W - PAD * 2, h: CUTIN_H },
};

// ===========================================================================
// 3. Playback State & FX Choreography
// ===========================================================================
let allEvents = [];
let eventCursor = 0;
let matchState = createInitialState();
let isPlaying = false;
let playbackSpeed = 1.0;
let lastStepTime = 0;
let latestMatchResult = null;

const YOU = 'A';
const OPPONENT = 'B';

const fx = {
  hp: { A: null, B: null },
  credits: { A: null, B: null },
  latent: { A: null, B: null },
  spriteFrame: { A: 'idle', B: 'idle' },
  spriteUntil: { A: 0, B: 0 },
  shake: null,
  burst: null,
  cutin: null,
  reveal: null,
  integrity: null,
  koAt: null,
};

function seenClaimKey(c) {
  return `${c.exchangeId}::${c.cls}::${c.seq}`;
}

function applyFx(prev, next, nowMs, { allowReveal = true } = {}) {
  for (const side of ['A', 'B']) {
    const p = prev.sides[side];
    const n = next.sides[side];
    if (p.hp !== n.hp) {
      fx.hp[side] = { from: p.hp, to: n.hp, changedAt: nowMs };
      if (n.hp < p.hp) {
        fx.spriteFrame[side] = 'hurt';
        fx.spriteUntil[side] = nowMs + TIMINGS.spriteHurt;
        fx.shake = { startedAt: nowMs, magnitude: Math.min(12, Math.max(3, (p.hp - n.hp) * 0.8)) };
        const slot = side === YOU ? 'left' : 'right';
        const bx = slot === 'left' ? LAYOUT.spriteA.x + LAYOUT.spriteA.w / 2 : LAYOUT.spriteB.x + LAYOUT.spriteB.w / 2;
        const by = LAYOUT.spriteA.y + LAYOUT.spriteA.h / 2;
        fx.burst = {
          startedAt: nowMs,
          x: bx,
          y: by,
          color: slot === 'left' ? COLORS.sideA : COLORS.sideB,
          label: `-${p.hp - n.hp}`,
        };
      }
    }
    if (p.credits !== n.credits) {
      fx.credits[side] = { from: p.credits, to: n.credits, changedAt: nowMs, delta: n.credits - p.credits };
    }
    if (p.latent !== n.latent) {
      fx.latent[side] = { changedAt: nowMs };
    }

    for (const c of n.claims) {
      if (c.outcome === 'pending') continue;
      const before = p.claims.find((pc) => seenClaimKey(pc) === seenClaimKey(c));
      if (before && before.outcome === c.outcome) continue;
      fx.cutin = {
        active: true,
        startedAt: nowMs,
        prosecutingTeam: n.team || side,
        cls: c.cls,
        evidence: c.evidence,
        argument: c.argument,
        outcome: c.outcome,
        weight: c.weight,
        scaled: c.scaled,
      };
    }

    const newLines = n.log.slice(p.log.length);
    for (const entry of newLines) {
      if (entry.type === 'mutation' && entry.p && entry.p.applied) {
        fx.shake = { startedAt: nowMs, magnitude: TIMINGS.shakeMagnitudePx };
        const slot = side === YOU ? 'left' : 'right';
        const bx = slot === 'left' ? LAYOUT.spriteA.x + LAYOUT.spriteA.w / 2 : LAYOUT.spriteB.x + LAYOUT.spriteB.w / 2;
        const by = LAYOUT.spriteA.y + LAYOUT.spriteA.h / 2;
        const attackerColor = slot === 'left' ? COLORS.sideA : COLORS.sideB;
        fx.burst = { startedAt: nowMs, x: bx, y: by, color: attackerColor, label: String(entry.p.class || 'mutation') };
        fx.spriteFrame[side] = 'attack';
        fx.spriteUntil[side] = nowMs + 450;
      }
      if (entry.type === 'integrity' && !fx.integrity) {
        fx.integrity = { kind: entry.p.kind, detail: entry.p.detail };
      }
      if (entry.type === 'exchange_start' && allowReveal) {
        fx.reveal = {
          startedAt: nowMs,
          cardId: entry.p.card_id,
          attacker: entry.p.attacker,
          defender: entry.p.defender,
          ask: entry.p.ask,
        };
      }
      if (entry.type === 'duel_end') {
        fx.koAt = nowMs;
      }
    }
  }
}

function ingestStep(nowMs) {
  if (eventCursor >= allEvents.length) {
    isPlaying = false;
    updatePlayPauseButton();
    return;
  }

  const ev = allEvents[eventCursor];
  const next = reduce(matchState, ev);
  applyFx(matchState, next, nowMs, { allowReveal: true });
  matchState = next;
  eventCursor++;
  updateScrubber();
}

function seekToEvent(targetIndex) {
  targetIndex = Math.max(0, Math.min(targetIndex, allEvents.length));
  matchState = createInitialState();
  const nowMs = performance.now();

  for (let i = 0; i < targetIndex; i++) {
    const next = reduce(matchState, allEvents[i]);
    if (i === targetIndex - 1) {
      applyFx(matchState, next, nowMs, { allowReveal: false });
    }
    matchState = next;
  }
  eventCursor = targetIndex;
  updateScrubber();
}

// ===========================================================================
// 4. Combat Log Formatting
// ===========================================================================
function fmtMask(fields) {
  return Array.isArray(fields) && fields.length ? `[${fields.slice().sort().join(',')}]` : '[]';
}

function mergedLog(state) {
  const seen = new Map();
  for (const side of ['A', 'B']) {
    for (const entry of state.sides[side].log) seen.set(entry.seq, entry);
  }
  return Array.from(seen.values()).sort((a, b) => a.seq - b.seq);
}

function buildCombatLogLines(state) {
  const lines = [];
  let pendingCommand = null;
  for (const entry of mergedLog(state)) {
    const p = entry.p || {};
    switch (entry.type) {
      case 'command':
        pendingCommand = entry;
        break;
      case 'enforced': {
        const cmd = pendingCommand ? pendingCommand.p : null;
        pendingCommand = null;
        const denied = p.verdict_applied === 'deny';
        const head = cmd ? `${cmd.kind} ${cmd.server}.${cmd.tool} ${fmtMask(cmd.fields)}` : 'command';
        const tail = denied && p.reason ? ` DENIED: ${p.reason}` : (p.reason ? ` (${p.reason})` : '');
        const cost = typeof p.charged === 'number' ? `-${p.charged} cr` : '';
        lines.push({ seq: entry.seq, text: `${head}${tail}`, costLabel: cost, denied });
        break;
      }
      case 'mutation':
        lines.push({
          seq: entry.seq,
          text: `MUTATION ${p.class} -> ${p.target} (${p.op})${p.applied ? ' APPLIED' : ' fizzled'}`,
          costLabel: '',
          denied: false,
        });
        break;
      case 'integrity':
        lines.push({ seq: entry.seq, text: `INTEGRITY ${p.kind}: ${p.detail || ''}`, costLabel: '', denied: false });
        break;
      case 'answer':
        lines.push({
          seq: entry.seq,
          text: `» answer submitted - ${Array.isArray(p.cited_anchors) ? p.cited_anchors.length : 0} citation(s)`,
          costLabel: '',
          denied: false,
        });
        break;
      case 'penalty':
        lines.push({ seq: entry.seq, text: `PENALTY (${p.reason || 'unknown'})`, costLabel: `-${p.amount || 0} cr`, denied: false });
        break;
      case 'round_end':
        lines.push({ seq: entry.seq, text: `-- round ${p.round} end --`, costLabel: '', denied: false });
        break;
      case 'duel_end':
        lines.push({ seq: entry.seq, text: `-- DUEL END: winner ${p.winner} --`, costLabel: '', denied: false });
        break;
      default:
        break;
    }
  }
  return lines;
}

// ===========================================================================
// 5. Canvas Panel Drawing Helpers
// ===========================================================================
function drawFlatPanel(x, y, w, h, fill, border) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = SIZES.borderWidth;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}

function drawSpritePanel(rect, sheet, side, t) {
  drawFlatPanel(rect.x, rect.y, rect.w, rect.h, COLORS.panelBg, COLORS.panelBorder);
  if (!sheet) return;
  let frame = fx.spriteFrame[side];
  if (t > fx.spriteUntil[side]) frame = 'idle';
  const canvasSprite = sheet[frame] || sheet.idle;
  if (!canvasSprite) return;
  const scale = 6;
  const w = canvasSprite.width * scale;
  const h = canvasSprite.height * scale;
  drawSprite(ctx, canvasSprite, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, scale, side === OPPONENT);
}

function drawReveal(state, t) {
  const r = fx.reveal;
  if (!r) return;
  const elapsed = t - r.startedAt;
  if (elapsed < 0 || elapsed > TIMINGS.revealMs) return;
  const alpha = elapsed > TIMINGS.revealMs - 500 ? Math.max(0, (TIMINGS.revealMs - elapsed) / 500) : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  drawFlatPanel(0, 0, LOGICAL_W, LOGICAL_H, 'rgba(10,14,22,0.92)', null);
  if (SPRITES && SPRITES.cardback) {
    const scale = 8;
    const w = SPRITES.cardback.width * scale;
    const h = SPRITES.cardback.height * scale;
    drawSprite(ctx, SPRITES.cardback, LOGICAL_W / 2 - w / 2, LOGICAL_H / 2 - h / 2 - 40, scale);
  }
  const title = `ROUND ${state.round || 1} — ${(r.attacker || 'ATTACKER').toUpperCase()} ATTACKS`;
  const tw = measurePixelText(ctx, title, 2);
  drawPixelText(ctx, LOGICAL_W / 2 - tw / 2, LOGICAL_H / 2 + 100, title, COLORS.text, 2);
  if (r.ask && r.ask.type) {
    const sub = `card ${r.cardId || '?'} — ask: ${r.ask.type}`;
    const sw = measurePixelText(ctx, sub, 1);
    drawPixelText(ctx, LOGICAL_W / 2 - sw / 2, LOGICAL_H / 2 + 122, sub, COLORS.textDim, 1);
  }
  ctx.restore();
}

function drawIntegrityBanner(t) {
  if (!fx.integrity) return;
  const period = TIMINGS.integrityPulseMs;
  const phase = ((t % period) / period) * Math.PI * 2;
  const alpha = 0.55 + 0.35 * Math.sin(phase);
  ctx.save();
  drawFlatPanel(0, 0, LOGICAL_W, INTEGRITY_BAR_H, `rgba(255,45,85,${alpha.toFixed(3)})`, null);
  const text = `INTEGRITY: ${fx.integrity.kind} — ${fx.integrity.detail || ''}`;
  drawPixelText(ctx, PAD, 6, text.slice(0, 140), COLORS.text, 1);
  ctx.restore();
}

function drawKoOverlay(state, t) {
  if (!fx.koAt) return;
  ctx.save();
  drawFlatPanel(0, 0, LOGICAL_W, LOGICAL_H, 'rgba(10,14,22,0.88)', null);
  if (SPRITES && SPRITES.skull) {
    const scale = 9;
    const w = SPRITES.skull.width * scale;
    const h = SPRITES.skull.height * scale;
    drawSprite(ctx, SPRITES.skull, LOGICAL_W / 2 - w / 2, LOGICAL_H / 2 - h / 2 - 50, scale);
  }
  const koText = 'K.O.';
  const tw = measurePixelText(ctx, koText, 4);
  drawPixelText(ctx, LOGICAL_W / 2 - tw / 2, LOGICAL_H / 2 + 60, koText, COLORS.damageRed, 4);
  ctx.restore();
}

function labelFor(side) {
  if (side === YOU) return matchState.sides.A.team ? String(matchState.sides.A.team).toUpperCase() : 'YOU';
  const team = matchState.sides.B.team;
  return team ? String(team).toUpperCase() : 'OPPONENT';
}

// ===========================================================================
// 6. Main Render Loop
// ===========================================================================
function render(nowMs) {
  // Advance playback steps
  if (isPlaying && allEvents.length > 0) {
    const stepInterval = playbackSpeed >= 999 ? 0 : 320 / playbackSpeed;
    if (playbackSpeed >= 999) {
      while (eventCursor < allEvents.length && isPlaying) {
        ingestStep(nowMs);
      }
    } else if (nowMs - lastStepTime >= stepInterval) {
      ingestStep(nowMs);
      lastStepTime = nowMs;
    }
  }

  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  const shakeOffset = screenShake(fx.shake, nowMs);
  ctx.translate(shakeOffset.dx, shakeOffset.dy);

  // 1. HP Bars
  hpBar(ctx, LAYOUT.hpLeft, {
    side: 'A', hpMax: 100,
    from: fx.hp[YOU] ? fx.hp[YOU].from : matchState.sides[YOU].hp,
    to: matchState.sides[YOU].hp,
    changedAt: fx.hp[YOU] ? fx.hp[YOU].changedAt : nowMs,
  }, nowMs);

  hpBar(ctx, LAYOUT.hpRight, {
    side: 'B', hpMax: 100,
    from: fx.hp[OPPONENT] ? fx.hp[OPPONENT].from : matchState.sides[OPPONENT].hp,
    to: matchState.sides[OPPONENT].hp,
    changedAt: fx.hp[OPPONENT] ? fx.hp[OPPONENT].changedAt : nowMs,
  }, nowMs);

  drawPixelText(ctx, LAYOUT.hpLeft.x, HUD_Y, labelFor(YOU), COLORS.sideA, 2);
  const oppLabel = labelFor(OPPONENT);
  const oppW = measurePixelText(ctx, oppLabel, 2);
  drawPixelText(ctx, LAYOUT.hpRight.x + LAYOUT.hpRight.w - oppW, HUD_Y, oppLabel, COLORS.sideB, 2);

  // 2. Credit Bars
  creditBar(ctx, LAYOUT.creditLeft, {
    side: 'A', creditsMax: 100,
    from: fx.credits[YOU] ? fx.credits[YOU].from : matchState.sides[YOU].credits,
    to: matchState.sides[YOU].credits,
    changedAt: fx.credits[YOU] ? fx.credits[YOU].changedAt : nowMs,
    delta: fx.credits[YOU] ? fx.credits[YOU].delta : 0,
  }, nowMs);

  creditBar(ctx, LAYOUT.creditRight, {
    side: 'B', creditsMax: 100,
    from: fx.credits[OPPONENT] ? fx.credits[OPPONENT].from : matchState.sides[OPPONENT].credits,
    to: matchState.sides[OPPONENT].credits,
    changedAt: fx.credits[OPPONENT] ? fx.credits[OPPONENT].changedAt : nowMs,
    delta: fx.credits[OPPONENT] ? fx.credits[OPPONENT].delta : 0,
  }, nowMs);

  const crLabelL = `cr ${matchState.sides[YOU].credits}/100`;
  drawPixelText(ctx, LAYOUT.creditLeft.x, LAYOUT.creditLeft.y + 8, crLabelL, COLORS.textDim, 1);
  const crLabelR = `cr ${matchState.sides[OPPONENT].credits}/100`;
  drawPixelText(ctx, LAYOUT.creditRight.x, LAYOUT.creditRight.y + 8, crLabelR, COLORS.textDim, 1);

  // 3. Latent Flags
  latentFlags(ctx, LAYOUT.latentLeft, {
    count: matchState.sides[YOU].latent,
    changedAt: fx.latent[YOU] ? fx.latent[YOU].changedAt : -Infinity,
  }, nowMs);
  latentFlags(ctx, LAYOUT.latentRight, {
    count: matchState.sides[OPPONENT].latent,
    changedAt: fx.latent[OPPONENT] ? fx.latent[OPPONENT].changedAt : -Infinity,
  }, nowMs);

  // 4. Stage: Round Banner & Sprites
  roundBanner(ctx, LAYOUT.roundBanner, {
    round: matchState.round || 1, totalRounds: 10, scale: matchState.roundScale || 1,
  }, nowMs);

  drawSpritePanel(LAYOUT.spriteA, SPRITES ? SPRITES.agentA : null, YOU, nowMs);
  drawSpritePanel(LAYOUT.spriteB, SPRITES ? SPRITES.agentB : null, OPPONENT, nowMs);

  // 5. Combat Log
  combatLog(ctx, LAYOUT.log, { lines: buildCombatLogLines(matchState) }, nowMs);

  // 6. Pipeline Panels (5 stages)
  drawPixelText(ctx, LAYOUT.pipelineA.x, LAYOUT.pipelineA.y - 9, `${labelFor(YOU)} DEFENDS`, COLORS.sideA, 1);
  pipelinePanel(ctx, LAYOUT.pipelineA, matchState, YOU, nowMs);

  drawPixelText(ctx, LAYOUT.pipelineB.x, LAYOUT.pipelineB.y - 9, `${labelFor(OPPONENT)} DEFENDS`, COLORS.sideB, 1);
  pipelinePanel(ctx, LAYOUT.pipelineB, matchState, OPPONENT, nowMs);

  // 7. Prosecution Cut-In
  claimCutIn(ctx, LAYOUT.cutin, fx.cutin || { active: false }, nowMs);

  // 8. Particle Burst
  particleBurst(ctx, LAYOUT.spriteA, fx.burst, nowMs);

  ctx.restore();

  drawReveal(matchState, nowMs);
  drawIntegrityBanner(nowMs);
  drawKoOverlay(matchState, nowMs);

  requestAnimationFrame(render);
}

// ===========================================================================
// 7. UI Controls & Fighter State
// ===========================================================================
const fighterState = {
  bundleA: PRESETS.champion.bundleB64,
  nameA: PRESETS.champion.name,
  bundleB: PRESETS.adversary.bundleB64,
  nameB: PRESETS.adversary.name,
};

// Preset Dropdown change listeners
document.getElementById('presetSelectA').addEventListener('change', (e) => {
  const val = e.target.value;
  if (val !== 'custom' && PRESETS[val]) {
    fighterState.bundleA = PRESETS[val].bundleB64;
    fighterState.nameA = PRESETS[val].name;
    document.getElementById('fighterTitleA').textContent = PRESETS[val].title;
    document.getElementById('fileInfoA').textContent = `Đang dùng: ${PRESETS[val].name}`;
  }
});

document.getElementById('presetSelectB').addEventListener('change', (e) => {
  const val = e.target.value;
  if (val !== 'custom' && PRESETS[val]) {
    fighterState.bundleB = PRESETS[val].bundleB64;
    fighterState.nameB = PRESETS[val].name;
    document.getElementById('fighterTitleB').textContent = PRESETS[val].title;
    document.getElementById('fileInfoB').textContent = `Đang dùng: ${PRESETS[val].name}`;
  }
});

// Dropzone file loaders
function setupDropzone(dropzoneId, fileInputId, fileInfoId, presetSelectId, side) {
  const dropzone = document.getElementById(dropzoneId);
  const fileInput = document.getElementById(fileInputId);
  const fileInfo = document.getElementById(fileInfoId);
  const presetSelect = document.getElementById(presetSelectId);

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const arrayBuffer = event.target.result;
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);

      if (side === 'A') {
        fighterState.bundleA = b64;
        fighterState.nameA = file.name.replace(/\.[^/.]+$/, '');
        document.getElementById('fighterTitleA').textContent = `📁 ${file.name}`;
      } else {
        fighterState.bundleB = b64;
        fighterState.nameB = file.name.replace(/\.[^/.]+$/, '');
        document.getElementById('fighterTitleB').textContent = `📁 ${file.name}`;
      }

      presetSelect.value = 'custom';
      fileInfo.textContent = `Tải lên thành công: ${file.name} (${Math.round(file.size / 1024)} KB)`;
    };
    reader.readAsArrayBuffer(file);
  }
}

setupDropzone('dropzoneA', 'fileInputA', 'fileInfoA', 'presetSelectA', 'A');
setupDropzone('dropzoneB', 'fileInputB', 'fileInfoB', 'presetSelectB', 'B');

// ===========================================================================
// 8. Fight Execution Button
// ===========================================================================
const btnFight = document.getElementById('btnFight');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingOverlayText = document.getElementById('loadingOverlayText');

btnFight.addEventListener('click', async () => {
  try {
    btnFight.disabled = true;
    loadingOverlay.classList.remove('hidden');
    loadingOverlayText.textContent = 'Đang mô phỏng 10 hiệp đấu Colosseum...';

    const seed = document.getElementById('seedInput').value || 1;
    const rounds = document.getElementById('roundsInput').value || 10;

    const result = await runSimulation(fighterState.bundleA, fighterState.bundleB, seed, rounds);
    latestMatchResult = result;
    allEvents = result.events || [];

    // Reset playback and start
    seekToEvent(0);
    isPlaying = true;
    lastStepTime = performance.now();
    updatePlayPauseButton();

    // Populate Dashboard
    renderDashboard(result);

    loadingOverlay.classList.add('hidden');
  } catch (err) {
    alert(`Lỗi mô phỏng: ${err.message}`);
    loadingOverlay.classList.add('hidden');
  } finally {
    btnFight.disabled = false;
  }
});

// ===========================================================================
// 9. Playback Bar Controls
// ===========================================================================
const btnPlayPause = document.getElementById('btnPlayPause');
const btnReplay = document.getElementById('btnReplay');
const scrubberSlider = document.getElementById('scrubberSlider');
const timeDisplay = document.getElementById('timeDisplay');

function updatePlayPauseButton() {
  btnPlayPause.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
  btnPlayPause.classList.toggle('active', isPlaying);
}

function updateScrubber() {
  scrubberSlider.max = allEvents.length;
  scrubberSlider.value = eventCursor;
  timeDisplay.textContent = `${eventCursor} / ${allEvents.length}`;
}

btnPlayPause.addEventListener('click', () => {
  isPlaying = !isPlaying;
  if (isPlaying && eventCursor >= allEvents.length) {
    seekToEvent(0);
  }
  updatePlayPauseButton();
});

btnReplay.addEventListener('click', () => {
  seekToEvent(0);
  isPlaying = true;
  updatePlayPauseButton();
});

scrubberSlider.addEventListener('input', (e) => {
  isPlaying = false;
  updatePlayPauseButton();
  seekToEvent(Number(e.target.value));
});

// Jump round buttons
document.getElementById('btnPrevRound').addEventListener('click', () => {
  if (allEvents.length === 0) return;
  const currentRound = matchState.round;
  const targetRound = Math.max(1, currentRound - 1);
  for (let i = eventCursor - 1; i >= 0; i--) {
    if (allEvents[i].type === 'exchange_start' && allEvents[i].round === targetRound) {
      seekToEvent(i);
      return;
    }
  }
  seekToEvent(0);
});

document.getElementById('btnNextRound').addEventListener('click', () => {
  if (allEvents.length === 0) return;
  const currentRound = matchState.round;
  const targetRound = currentRound + 1;
  for (let i = eventCursor; i < allEvents.length; i++) {
    if (allEvents[i].type === 'exchange_start' && allEvents[i].round === targetRound) {
      seekToEvent(i);
      return;
    }
  }
  seekToEvent(allEvents.length);
});

// Speed buttons
document.querySelectorAll('.speed-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    playbackSpeed = Number(btn.dataset.speed);
  });
});

// ===========================================================================
// 10. Dashboard & Analytics Renderer
// ===========================================================================
function renderDashboard(result) {
  const winnerEl = document.getElementById('summaryWinner');
  if (result.winner === 'A') {
    winnerEl.textContent = `🏆 ${result.name_a} THẮNG!`;
    winnerEl.className = 'stat-value winner-a';
  } else if (result.winner === 'B') {
    winnerEl.textContent = `🏆 ${result.name_b} THẮNG!`;
    winnerEl.className = 'stat-value winner-b';
  } else {
    winnerEl.textContent = '⚖️ HÒA (TIE)';
    winnerEl.className = 'stat-value winner-tie';
  }

  document.getElementById('summaryScore').textContent = `${result.hp_a} — ${result.hp_b}`;
  const lastRound = result.rounds[result.rounds.length - 1] || {};
  document.getElementById('summaryCredits').textContent = `${lastRound.credits_a || 100} / ${lastRound.credits_b || 100}`;
  document.getElementById('summaryEvents').textContent = `${result.events_count} events`;

  // Render Table
  const tbody = document.getElementById('roundsTableBody');
  tbody.innerHTML = result.rounds
    .map(
      (r) => `
      <tr>
        <td><span class="badge-round">Hiệp ${r.round}</span></td>
        <td>x${r.multiplier}</td>
        <td><code>${r.card_a}</code></td>
        <td><code>${r.card_b}</code></td>
        <td class="badge-dmg-a">+${r.dmg_dealt_a} dmg</td>
        <td class="badge-dmg-b">+${r.dmg_dealt_b} dmg</td>
        <td><strong>${r.hp_a}</strong> / <strong>${r.hp_b}</strong></td>
        <td>${r.credits_a} / ${r.credits_b}</td>
      </tr>
    `
    )
    .join('');
}

// Export trace.jsonl
document.getElementById('btnExportJsonl').addEventListener('click', () => {
  if (!latestMatchResult) {
    alert('Chưa có dữ liệu trận đấu. Hãy nhấn "START BATTLE!" trước!');
    return;
  }
  const blob = new Blob([latestMatchResult.jsonl], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `colosseum_duel_${latestMatchResult.duel_id}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
});

// Export JSON report
document.getElementById('btnExportReport').addEventListener('click', () => {
  if (!latestMatchResult) {
    alert('Chưa có dữ liệu trận đấu. Hãy nhấn "START BATTLE!" trước!');
    return;
  }
  const blob = new Blob([JSON.stringify(latestMatchResult, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `colosseum_report_${latestMatchResult.duel_id}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ===========================================================================
// 11. Boot & Auto-load Pyodide
// ===========================================================================
async function initApp() {
  const statusBadge = document.getElementById('engineStatusBadge');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  try {
    await initPyodideSimulator((progress) => {
      statusText.textContent = progress.message;
    });
    statusDot.classList.add('ready');
    statusText.textContent = 'Pyodide Sẵn sàng ⚔️';
    loadingOverlay.classList.add('hidden');
  } catch (err) {
    statusDot.style.background = '#ff0055';
    statusText.textContent = 'Lỗi nạp engine';
    console.error(err);
  }

  // Start Canvas animation loop
  requestAnimationFrame(render);
}

initApp();
