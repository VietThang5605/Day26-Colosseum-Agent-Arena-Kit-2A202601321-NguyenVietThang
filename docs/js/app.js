// docs/js/app.js — Colosseum Web Arena Controller & Canvas Renderer

import { PRESETS } from './presets.js';
import { initPyodideSimulator, runSimulation } from './simulator.js';
import { normalizeEvent } from './core/decode.js';
import { createInitialState, reduce } from './core/reduce.js';
import { decoded as SPRITES, drawSprite } from './core/sprites.js';
import {
  hpBar, creditBar, latentFlags, combatLog, claimCutIn, roundBanner, scrubber,
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
  const availH = 700;
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
// 2. Playback State & FX Choreography
// ===========================================================================
let allEvents = [];
let eventCursor = 0;
let matchState = createInitialState();
let isPlaying = false;
let playbackSpeed = 1.0;
let lastStepTime = 0;
let latestMatchResult = null;

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

function applyFx(prev, next, nowMs, { allowReveal = true } = {}) {
  for (const side of ['A', 'B']) {
    const pHP = prev.hp[side];
    const nHP = next.hp[side];
    if (pHP !== nHP) {
      fx.hp[side] = { from: pHP, to: nHP, changedAt: nowMs };
      if (nHP < pHP) {
        fx.spriteFrame[side] = 'hurt';
        fx.spriteUntil[side] = nowMs + TIMINGS.spriteHurt;
        fx.shake = { startedAt: nowMs, magnitude: Math.min(12, Math.max(3, (pHP - nHP) * 0.8)) };
        const isA = side === 'A';
        fx.burst = {
          startedAt: nowMs,
          x: isA ? SIZES.agentSpriteA.x + 32 : SIZES.agentSpriteB.x + 32,
          y: SIZES.agentSpriteA.y + 32,
          color: isA ? COLORS.agentA : COLORS.agentB,
          label: `-${pHP - nHP}`,
        };
      }
    }

    const pCr = prev.credits[side];
    const nCr = next.credits[side];
    if (pCr !== nCr) {
      fx.credits[side] = { from: pCr, to: nCr, changedAt: nowMs, delta: nCr - pCr };
    }

    if (prev.latent[side] !== next.latent[side]) {
      fx.latent[side] = { changedAt: nowMs };
    }
  }

  // Handle cut-in for verified prosecution claims
  if (next.claims.length > prev.claims.length) {
    const newest = next.claims[next.claims.length - 1];
    fx.cutin = {
      startedAt: nowMs,
      claim: newest,
    };
    fx.shake = { startedAt: nowMs, magnitude: 8 };
  }

  // Check KO condition
  if ((next.hp.A === 0 || next.hp.B === 0) && prev.hp.A > 0 && prev.hp.B > 0) {
    fx.koAt = nowMs;
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
// 3. Render Loop (Canvas HUD 960x700)
// ===========================================================================
function render(nowMs) {
  // Advance playback
  if (isPlaying && allEvents.length > 0) {
    const stepInterval = playbackSpeed >= 999 ? 0 : 350 / playbackSpeed;
    if (playbackSpeed >= 999) {
      while (eventCursor < allEvents.length && isPlaying) {
        ingestStep(nowMs);
      }
    } else if (nowMs - lastStepTime >= stepInterval) {
      ingestStep(nowMs);
      lastStepTime = nowMs;
    }
  }

  // Screen shake transform
  ctx.save();
  if (fx.shake && nowMs - fx.shake.startedAt < TIMINGS.shakeDuration) {
    const elapsed = nowMs - fx.shake.startedAt;
    const progress = elapsed / TIMINGS.shakeDuration;
    const mag = fx.shake.magnitude * (1 - progress);
    const ox = (Math.sin(elapsed * 0.08) * mag);
    const oy = (Math.cos(elapsed * 0.11) * mag);
    ctx.translate(ox, oy);
  }

  // Clear Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // 1. HP Bars
  hpBar(ctx, SIZES.hpBarA.x, SIZES.hpBarA.y, SIZES.hpBarA.w, SIZES.hpBarA.h, matchState.hp.A, fx.hp.A, nowMs, 'A', matchState.nameA || 'Team A');
  hpBar(ctx, SIZES.hpBarB.x, SIZES.hpBarB.y, SIZES.hpBarB.w, SIZES.hpBarB.h, matchState.hp.B, fx.hp.B, nowMs, 'B', matchState.nameB || 'Team B');

  // 2. Credit Bars
  creditBar(ctx, SIZES.creditBarA.x, SIZES.creditBarA.y, SIZES.creditBarA.w, SIZES.creditBarA.h, matchState.credits.A, fx.credits.A, nowMs, 'A');
  creditBar(ctx, SIZES.creditBarB.x, SIZES.creditBarB.y, SIZES.creditBarB.w, SIZES.creditBarB.h, matchState.credits.B, fx.credits.B, nowMs, 'B');

  // 3. Latent Flags
  latentFlags(ctx, SIZES.latentA.x, SIZES.latentA.y, matchState.latent.A, fx.latent.A, nowMs, 'A');
  latentFlags(ctx, SIZES.latentB.x, SIZES.latentB.y, matchState.latent.B, fx.latent.B, nowMs, 'B');

  // 4. Sprites
  const spriteA = (fx.spriteUntil.A > nowMs) ? fx.spriteFrame.A : 'idle';
  const spriteB = (fx.spriteUntil.B > nowMs) ? fx.spriteFrame.B : 'idle';
  drawSprite(ctx, SPRITES.agentA[spriteA] || SPRITES.agentA.idle, SIZES.agentSpriteA.x, SIZES.agentSpriteA.y, 4);
  drawSprite(ctx, SPRITES.agentB[spriteB] || SPRITES.agentB.idle, SIZES.agentSpriteB.x, SIZES.agentSpriteB.y, 4, true);

  // 5. Round Banner
  roundBanner(ctx, SIZES.roundBanner.x, SIZES.roundBanner.y, matchState.round, matchState.multiplier, SIZES.roundBanner.w, SIZES.roundBanner.h);

  // 6. Combat Log
  combatLog(ctx, SIZES.combatLog.x, SIZES.combatLog.y, SIZES.combatLog.w, SIZES.combatLog.h, matchState.log, nowMs);

  // 7. Pipeline Strips (Bottom 160px)
  pipelinePanel(ctx, SIZES.pipelineA.x, SIZES.pipelineA.y, SIZES.pipelineA.w, SIZES.pipelineA.h, matchState.pipeline.A, 'A', nowMs);
  pipelinePanel(ctx, SIZES.pipelineB.x, SIZES.pipelineB.y, SIZES.pipelineB.w, SIZES.pipelineB.h, matchState.pipeline.B, 'B', nowMs);

  // 8. Claim Cut-In overlay
  if (fx.cutin) {
    claimCutIn(ctx, 0, 0, LOGICAL_W, LOGICAL_H, fx.cutin.claim, fx.cutin.startedAt, nowMs);
    if (nowMs - fx.cutin.startedAt > TIMINGS.cutinDuration) {
      fx.cutin = null;
    }
  }

  // 9. Particle Burst / Damage Pop
  if (fx.burst && nowMs - fx.burst.startedAt < 900) {
    particleBurst(ctx, fx.burst.x, fx.burst.y, fx.burst.color, fx.burst.label, fx.burst.startedAt, nowMs);
  }

  ctx.restore();
  requestAnimationFrame(render);
}

// ===========================================================================
// 4. UI Controls & Fighter State
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
// 5. Fight Execution Button
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

    // Reset playback
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
// 6. Playback Bar Controls
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
// 7. Dashboard & Analytics Renderer
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
// 8. Boot & Auto-load Pyodide
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
