// kit/arena_ui/core/reduce.js
//
// COLOSSEUM — the pure event -> MatchState reducer (CONTRACTS.md §5,
// §10.2; FINAL-PLAN.md §8). Byte-identical between Day26-Colosseum-Agent-Arena-Kit
// and Day26-Colosseum-Agent-Arena. Native ES module, no build step — see
// core/theme.js's header.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: reduce(state, event) is a PURE
// FUNCTION. The same sequence of events, folded from the same starting
// state, always produces the same MatchState — byte for byte. That is what
// makes replay free (CONTRACTS §10.1: "the same view, pointed at a finished
// runs/<id>/ directory... There is no second code path"): a scrubber seeking
// backward and re-folding forward must land on exactly what a live viewer
// saw, and two viewers of the same run must agree.
//
// OWNERSHIP / COPY-ON-WRITE: this file NEVER mutates the `state` object (or
// the `event` object) it is given. Every touched branch — `state.sides.A`,
// `state.choreography`, etc. — is replaced with a shallow copy; everything
// untouched is shared by reference with the input. A caller may safely keep
// a reference to a prior MatchState (for a diff, an undo, a "what did round
// 4 look like" scrubber) without a later reduce() call clobbering it.
//
// THE UI NEVER COMPUTES A SCORE (CONTRACTS §10.2, restated verbatim here
// because it is the rule most likely to get "helpfully" violated by a future
// edit): `sides.X.hp`, `sides.X.credits`, and every field inside a
// `claims[]` entry are copied from the L3 `hp` / L2 `claim_outcome` events
// AS THE REFEREE PUBLISHED THEM. This file never derives, sums, or
// recomputes a weight × round_scale, a damage total, or an HP delta from
// claim data. If this reducer's numbers and the arena's ledger ever
// disagree, THE LEDGER IS RIGHT AND THIS FILE HAS A BUG — that is not a
// hypothetical, it is the literal test: CONTRACTS §5 layers truth
// one-directionally (L1 -> L2 -> L3 -> L4) specifically so a UI producer can
// never inject an authoritative-looking outcome, and a test elsewhere in
// this repo asserts the ledger module imports nothing that can read an L3 or
// L4 event. This file is that L3/L4 consumer; it must stay a pure
// projection, never a second scorer.
//
// This file only ever HANDLES the 25-type catalogue in CONTRACTS §5.2
// (kept in sync with decode.js's KNOWN_TYPES by hand — that section is the
// single source of truth for both). It does not import decode.js: reduce()
// is meant to be usable directly against a hand-built event object in a
// test, or fed a raw object that bypassed decode.js entirely, so its own
// unknown-v / unknown-type guards are a second, independent line of
// defence, not a re-export of the first.
//
// WHAT THIS FILE DELIBERATELY DOES NOT CARRY: `from`/`to`/`changedAt`-style
// wall-clock animation bookkeeping for a tween (see core/widgets.js's hpBar
// / creditBar / claimCutIn doc comments for that shape). MatchState here is
// a pure, replay-deterministic projection of domain facts — it has no
// concept of "the real time the browser happened to render this frame", and
// folding the same events twice must give identical output regardless of
// how long that took on a real clock. Turning a MatchState value that just
// changed into a tween's `from -> to` over `changedAt` is a VIEW-LAYER
// concern: diff two successive MatchState snapshots, stamp `performance.now()`
// when a watched field changes, and feed *that* derived object to widgets.js.
// That adapter is out of this file's scope; this comment exists so whoever
// writes it next knows where the seam is.

// ---------------------------------------------------------------------------
// the catalogue — CONTRACTS.md §5.2 (see decode.js's copy; both must track it)
// ---------------------------------------------------------------------------

const KNOWN_VERSIONS = new Set([1]);

const KNOWN_TYPES = new Set([
  'exchange_start', 'model_turn', 'command', 'decision', 'enforced',
  'tool_call', 'tool_result', 'mutation', 'answer', 'integrity', 'own_telemetry',
  'claim_filed', 'claim_outcome', 'latent_violation', 'recoil', 'penalty',
  'hp', 'credits', 'round_end', 'duel_end', 'standings',
  'reveal', 'cutin', 'shake', 'ticker',
]);

// L1 types that, absent any more specific handling below, become exactly one
// combat-log line on the acting side and mark the exchange as "in combat".
// (`enforced` pairs with the `command` immediately before it: CONTRACTS
// §5.2 gives `enforced.p` no `cmd_id` or other back-reference, so that
// pairing is ADJACENCY-ONLY — "the enforced event right after this command
// describes what happened to it." This file does not try to invent a link
// that is not in the schema; it logs both as separate, ordered entries and
// leaves pairing-by-adjacency to whatever renders the log, same as the
// spar.html mockup in FINAL-PLAN.md §8.2 shows them as consecutive lines.)
const SIMPLE_COMBAT_LOG_TYPES = new Set([
  'model_turn', 'command', 'decision', 'enforced', 'tool_result',
  'mutation', 'integrity', 'own_telemetry', 'recoil', 'penalty',
]);

const LOG_BOUND = 200; // CONTRACTS §10.1: "the last 200 combat-log lines"
// CHOREOGRAPHY_BOUND is NOT a CONTRACTS requirement (§10.1 only names the
// 200-line combat log) — it is this file's own defensive mirror of the same
// "memory stays flat regardless of run length" goal, for a renderer that is
// slow to call drainChoreography(). It is generous enough (200) that a
// renderer draining every animation frame will never come close to it.
const CHOREOGRAPHY_BOUND = 200;

// ---------------------------------------------------------------------------
// small predicates / helpers
// ---------------------------------------------------------------------------

function isPlainObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isSide(x) {
  return x === 'A' || x === 'B';
}

function otherSide(side) {
  return side === 'A' ? 'B' : 'A';
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * Display-only round-scale lookup (FINAL-PLAN.md §1: "Round scale ×1.0
 * (r1–3) · ×1.25 (r4–7) · ×1.5 (r8–10)"). This is a PUBLIC RULE CONSTANT,
 * not a derived result — it never multiplies into hp/credits/claim math
 * anywhere in this file, it only feeds `state.roundScale`, which exists so
 * the "×1.25 SCALE" badge in the spar mockup (FINAL-PLAN.md §8.2) has
 * something to render. Reading it off `round` is not "computing a score";
 * it is redisplaying a constant every player already knows from the rules.
 */
function roundScaleFor(round) {
  const r = num(round);
  if (r === null || r < 1) return 1;
  if (r <= 3) return 1;
  if (r <= 7) return 1.25;
  return 1.5;
}

function createSide() {
  return {
    team: null,
    // 100 HP / 100 credits are the known starting constants (FINAL-PLAN.md
    // §1 "♥100 each"; §4 "100 credits per duel side") — a reasonable initial
    // display before the first real `hp`/`tool_call`/`credits` event
    // arrives, exactly the way the spar mockup opens fully healthy. The
    // first authoritative event for either field overwrites this.
    hp: 100,
    credits: 100,
    latent: 0,
    claims: [],
    log: [],
    // The five stages of ONE exchange, kept separate so the HUD can show what
    // actually happened in order instead of asking a viewer to reconstruct it
    // from an interleaved combat log: the card's QUESTION, every ACTION the
    // agent took and what the gateway decided about it, the ANSWER that came
    // out, the opponent's EVAL of that trace, and the REFEREE's ruling.
    // Rebuilt from scratch at each `exchange_start` for this side.
    pipeline: createPipeline(),
  };
}

/** The empty five-stage view of one exchange. */
function createPipeline() {
  return {
    question: null,   // { type, concept, require[], cardId, attacker }
    actions: [],      // [{ server, tool, kind, verdict, applied, reason, ran }]
    answer: null,     // { spans, anchors, chars }
    evals: [],        // [{ cls, evidence[], argument }]      — filed against THIS side
    verdicts: [],     // [{ cls, outcome, weight, scaled, reasoning }]
  };
}

/** Copy-on-write update of one side's pipeline. */
function updatePipeline(state, side, fn) {
  if (!isSide(side)) return state;
  return updateSide(state, side, (sd) => ({ ...sd, pipeline: fn(sd.pipeline || createPipeline()) }));
}

/** Copy-on-write update of the LAST action recorded on one side. */
function updateLastAction(state, side, fn) {
  return updatePipeline(state, side, (pl) => {
    if (!pl.actions.length) return pl;
    const actions = pl.actions.slice();
    actions[actions.length - 1] = fn(actions[actions.length - 1]);
    return { ...pl, actions };
  });
}

/**
 * The empty MatchState this reducer folds from. Exported so tests, and any
 * caller starting a fresh duel/replay, do not have to hand-roll the shape.
 */
export function createInitialState() {
  return {
    runId: null,
    duelId: null,
    exchangeId: null,
    round: 0,
    roundScale: 1,
    phase: 'idle',
    sides: { A: createSide(), B: createSide() },
    featured: null,
    bracket: null,
    standings: null,
    choreography: [],
  };
}

/** Copy-on-write update of one side. Never mutates `state` or `state.sides`. */
function updateSide(state, side, fn) {
  return { ...state, sides: { ...state.sides, [side]: fn(state.sides[side]) } };
}

function pushBounded(arr, item, bound) {
  const next = arr.length < bound ? arr.concat([item]) : arr.slice(arr.length - bound + 1).concat([item]);
  return next;
}

/** One combat-log entry: a slim, STRUCTURED copy of the envelope + payload —
 *  never a pre-formatted string. Formatting (icons, colour, the "mcp
 *  slides.query fields=[...] -6 cr" text in the FINAL-PLAN.md §8.2 mockup)
 *  is core/widgets.js's job; this file's job is to hand it clean, complete
 *  data and get out of the way. */
function logEntry(event) {
  return {
    seq: event.seq,
    t: event.t,
    round: event.round,
    exchangeId: event.exchange_id,
    side: event.side,
    type: event.type,
    p: event.p,
  };
}

function pushLogTo(state, event, sides) {
  let next = state;
  const entry = logEntry(event);
  for (const side of sides) {
    next = updateSide(next, side, (s) => ({ ...s, log: pushBounded(s.log, entry, LOG_BOUND) }));
  }
  return next;
}

// ---------------------------------------------------------------------------
// reduce — the pure fold
// ---------------------------------------------------------------------------

/**
 * @param {object|null|undefined} state — a prior MatchState, or a falsy
 *   value to fold from a fresh createInitialState().
 * @param {object} event — a decode.js-normalized event (or any object
 *   shaped like one; see the file header on the two independent guards).
 * @returns {object} the next MatchState. `state` is never mutated.
 */
export function reduce(state, event) {
  let s = isPlainObject(state) ? state : createInitialState();

  if (!isPlainObject(event)) return s; // never fatal
  if (!KNOWN_VERSIONS.has(event.v)) return s; // unknown version -> no-op, mirrors decode.js
  if (typeof event.type !== 'string' || !KNOWN_TYPES.has(event.type)) return s; // unknown type -> no-op
  if (!isPlainObject(event.p)) return s;

  const p = event.p;

  // Every event carries `run_id`/`duel_id`/`exchange_id`/`round` (CONTRACTS
  // §5.1's envelope table). Refresh these unconditionally, up front, so
  // every case below can rely on `s.round`/`s.exchangeId` already being
  // current without repeating this per type. A value the event does not
  // carry (null, per decode.js's normalization) leaves the prior one alone.
  if (typeof event.run_id === 'string') s = { ...s, runId: event.run_id };
  if (typeof event.duel_id === 'string') s = { ...s, duelId: event.duel_id };
  if (typeof event.exchange_id === 'string') s = { ...s, exchangeId: event.exchange_id };
  if (num(event.round) !== null) {
    s = { ...s, round: event.round, roundScale: roundScaleFor(event.round) };
  }

  switch (event.type) {
    case 'exchange_start': {
      s = { ...s, phase: 'reveal' };
      const side = event.side;
      if (isSide(side)) {
        // Team-identity inference: within one exchange's own p, `defender`
        // is the side whose turn this defend-exchange is (== envelope
        // `side`) and `attacker` is the opposing team (CONTRACTS §5.2's
        // exchange_start p fields: "attacker, defender, card_id, world_id,
        // ask"; FINAL-PLAN.md's `d03-r06-A` naming ties exchange side to the
        // defender). This is inferred, not a field named "team" anywhere in
        // the schema — documented here because it degrades gracefully: a
        // missing/non-string attacker or defender simply leaves `team` at
        // whatever it already was (or null), never throws.
        const defenderTeam = typeof p.defender === 'string' ? p.defender : null;
        const attackerTeam = typeof p.attacker === 'string' ? p.attacker : null;
        if (defenderTeam !== null) s = updateSide(s, side, (sd) => ({ ...sd, team: defenderTeam }));
        if (attackerTeam !== null) s = updateSide(s, otherSide(side), (sd) => ({ ...sd, team: attackerTeam }));
      }
      // STAGE 1 — QUESTION. A new exchange for this side wipes the previous
      // round's pipeline; a stale answer sitting under a fresh question is
      // worse than an empty panel.
      if (isSide(side)) {
        const ask = isPlainObject(p.ask) ? p.ask : {};
        s = updatePipeline(s, side, () => ({
          ...createPipeline(),
          question: {
            type: typeof ask.type === 'string' ? ask.type : null,
            concept: typeof ask.concept === 'string' ? ask.concept : null,
            require: Array.isArray(ask.require) ? ask.require.slice() : [],
            cardId: typeof p.card_id === 'string' ? p.card_id : null,
            attacker: typeof p.attacker === 'string' ? p.attacker : null,
          },
        }));
      }
      s = pushLogTo(s, event, isSide(side) ? [side] : []);
      break;
    }

    case 'command': {
      // STAGE 2 — ACTION, opened. The gateway's verdict arrives on the NEXT
      // event; pairing is by adjacency because CONTRACTS gives `decision` no
      // `cmd_id` back-reference (see SIMPLE_COMBAT_LOG_TYPES' note).
      const side = event.side;
      s = updatePipeline(s, side, (pl) => ({
        ...pl,
        actions: pushBounded(pl.actions, {
          server: typeof p.server === 'string' ? p.server : null,
          tool: typeof p.tool === 'string' ? p.tool : null,
          kind: typeof p.kind === 'string' ? p.kind : null,
          verdict: null, applied: null, reason: null, ran: false,
        }, 24),
      }));
      s = pushLogTo(s, event, isSide(side) ? [side] : []);
      s = { ...s, phase: 'combat' };
      break;
    }

    case 'decision': {
      // STAGE 2 — what the STUDENT's gateway decided.
      const side = event.side;
      s = updateLastAction(s, side, (a) => ({
        ...a,
        verdict: typeof p.verdict === 'string' ? p.verdict : (p.valid === false ? 'malformed' : a.verdict),
        reason: typeof p.reason === 'string' ? p.reason : a.reason,
      }));
      s = pushLogTo(s, event, isSide(side) ? [side] : []);
      s = { ...s, phase: 'combat' };
      break;
    }

    case 'enforced': {
      // STAGE 2 — what the ARENA actually did about it. Not the same thing as
      // the decision: a malformed Decision is charged as a deny no matter what
      // the student meant.
      const side = event.side;
      s = updateLastAction(s, side, (a) => ({
        ...a,
        applied: typeof p.verdict_applied === 'string' ? p.verdict_applied : a.applied,
      }));
      s = pushLogTo(s, event, isSide(side) ? [side] : []);
      s = { ...s, phase: 'combat' };
      break;
    }

    case 'tool_call': {
      // CONTRACTS §10.2's frozen render mapping: "tool_call (L1) -> credit
      // bar ticks; the cost floats up". `credits_left` is an L1 domain fact
      // the arena publishes directly on this event (not a derived score),
      // so ticking the credit bar from it is reading a given value, not
      // computing one.
      const side = event.side;
      const left = num(p.credits_left);
      if (isSide(side) && left !== null) {
        s = updateSide(s, side, (sd) => ({ ...sd, credits: left }));
      }
      s = updateLastAction(s, side, (a) => ({ ...a, ran: true }));
      s = pushLogTo(s, event, isSide(side) ? [side] : []);
      s = { ...s, phase: 'combat' };
      break;
    }

    case 'answer': {
      // STAGE 3 — ANSWER.
      const side = event.side;
      const spans = Array.isArray(p.spans) ? p.spans.length : null;
      const anchors = Array.isArray(p.cited_anchors) ? p.cited_anchors.slice() : [];
      s = updatePipeline(s, side, (pl) => ({
        ...pl,
        answer: {
          spans,
          anchors,
          chars: typeof p.text === 'string' ? p.text.length : null,
          text: typeof p.text === 'string' ? p.text.slice(0, 240) : null,
        },
      }));
      s = pushLogTo(s, event, isSide(side) ? [side] : []);
      s = { ...s, phase: 'answered' };
      break;
    }

    case 'claim_filed': {
      const side = event.side; // the PROSECUTOR — see claim_outcome's comment below
      if (isSide(side)) {
        const claim = {
          cls: typeof p.cls === 'string' ? p.cls : null,
          evidence: Array.isArray(p.evidence) ? p.evidence.slice() : [],
          expected: p.expected ?? null,
          observed: p.observed ?? null,
          argument: typeof p.argument === 'string' ? p.argument : null,
          outcome: 'pending',
          weight: null,
          scaled: null,
          reasoning: null,
          exchangeId: event.exchange_id,
          seq: event.seq,
        };
        s = updateSide(s, side, (sd) => ({ ...sd, claims: sd.claims.concat([claim]) }));
        // STAGE 4 — EVAL, recorded against the side being PROSECUTED. `side`
        // here is the prosecutor (see this case's own comment), and the trace
        // under examination is the opponent's, so the panel that should light
        // up is the defender's.
        s = updatePipeline(s, otherSide(side), (pl) => ({
          ...pl,
          evals: pushBounded(pl.evals, {
            cls: claim.cls, evidence: claim.evidence, argument: claim.argument,
          }, 8),
        }));
      }
      s = { ...s, phase: 'prosecution' };
      break;
    }

    case 'claim_outcome': {
      // `event.side` on a claim_outcome is the PROSECUTOR (the side that
      // benefits when `outcome === "verified"`), NOT the side whose trace
      // was examined — CONTRACTS §5's worked example has `enforced`/
      // `tool_call` on `"side":"A"` (team A's own defend-exchange, evt:0412
      // living there) and the `claim_outcome` that judges it on
      // `"side":"B"` (team B filed it). `event.exchange_id` stays the
      // EXAMINED exchange's id throughout (same example: both carry
      // "d03-r06-A"), which is exactly the key used below to find the
      // matching pending claim, since `cls` alone repeats every round a
      // team refiles the same class.
      //
      // hp/claim_outcome are rendered AS GIVEN — see this file's header. If
      // this ever disagrees with the referee's own ledger, the ledger is
      // right and this reducer has a bug.
      const side = event.side;
      if (isSide(side)) {
        s = updateSide(s, side, (sd) => {
          const idx = sd.claims.findIndex(
            (c) => c.outcome === 'pending' && c.cls === p.cls && c.exchangeId === event.exchange_id
          );
          const prior = idx >= 0 ? sd.claims[idx] : null;
          const resolved = {
            cls: typeof p.cls === 'string' ? p.cls : (prior ? prior.cls : null),
            evidence: Array.isArray(p.evidence)
              ? p.evidence.slice()
              : (prior ? prior.evidence : []),
            expected: prior ? prior.expected : null,
            observed: prior ? prior.observed : null,
            argument: prior ? prior.argument : null,
            outcome: typeof p.outcome === 'string' ? p.outcome : null,
            weight: num(p.weight),
            scaled: num(p.scaled),
            reasoning: typeof p.reasoning === 'string' ? p.reasoning : null,
            exchangeId: event.exchange_id,
            seq: prior ? prior.seq : event.seq,
          };
          const claims = idx >= 0 ? sd.claims.slice() : sd.claims.concat([resolved]);
          if (idx >= 0) claims[idx] = resolved;
          return { ...sd, claims };
        });
        // STAGE 5 — the REFEREE's ruling, shown on the side whose trace was
        // judged (the defender), so all five stages of one exchange sit in one
        // column instead of the ruling appearing across the screen from the
        // answer it is about.
        s = updatePipeline(s, otherSide(side), (pl) => ({
          ...pl,
          verdicts: pushBounded(pl.verdicts, {
            cls: typeof p.cls === 'string' ? p.cls : null,
            outcome: typeof p.outcome === 'string' ? p.outcome : null,
            weight: num(p.weight),
            scaled: num(p.scaled),
            reasoning: typeof p.reasoning === 'string' ? p.reasoning : null,
          }, 8),
        }));
      }
      s = { ...s, phase: 'prosecution' };
      break;
    }

    case 'latent_violation': {
      // CONTRACTS §10.2: "the ⚑ counter under the HP bar increments" — a
      // pure per-event counter, one flag per referee-published detector
      // hit. Not logged as a combat-log line (the render mapping treats it
      // as its own dedicated counter, distinct from the log stream).
      const side = event.side;
      if (isSide(side)) {
        s = updateSide(s, side, (sd) => ({ ...sd, latent: sd.latent + 1 }));
      }
      break;
    }

    case 'hp': {
      // hp is rendered AS GIVEN — see this file's header note in full.
      const a = num(p.A);
      const b = num(p.B);
      s = {
        ...s,
        sides: {
          A: { ...s.sides.A, hp: a !== null ? a : s.sides.A.hp },
          B: { ...s.sides.B, hp: b !== null ? b : s.sides.B.hp },
        },
      };
      // Observing "either side is already at/under 0" is reading the given
      // hp value, not computing a score — the same way a renderer would
      // notice the bar is empty. `duel_end` (below) is still the
      // authoritative, final word on how the duel ended.
      if (s.sides.A.hp <= 0 || s.sides.B.hp <= 0) s = { ...s, phase: 'ko' };
      break;
    }

    case 'credits': {
      // No worked example pins this event's exact `p` shape the way §8.4
      // pins `hp`'s `{"A":78,"B":61,...}`. Handled defensively in both
      // plausible shapes rather than guessing one and breaking on the
      // other: dual-side (mirroring `hp`) if `p.A`/`p.B` are present,
      // else single-side (mirroring `tool_call`'s own `credits_left`) using
      // the envelope's `side` plus `p.credits` or `p.credits_left`.
      const a = num(p.A);
      const b = num(p.B);
      if (a !== null || b !== null) {
        s = {
          ...s,
          sides: {
            A: { ...s.sides.A, credits: a !== null ? a : s.sides.A.credits },
            B: { ...s.sides.B, credits: b !== null ? b : s.sides.B.credits },
          },
        };
      } else {
        const side = event.side;
        const value = num(p.credits) !== null ? num(p.credits) : num(p.credits_left);
        if (isSide(side) && value !== null) {
          s = updateSide(s, side, (sd) => ({ ...sd, credits: value }));
        }
      }
      break;
    }

    case 'round_end': {
      s = { ...s, phase: 'round_end' };
      s = pushLogTo(s, event, ['A', 'B']);
      break;
    }

    case 'duel_end': {
      s = { ...s, phase: 'duel_end' };
      s = pushLogTo(s, event, ['A', 'B']);
      break;
    }

    case 'standings': {
      // CONTRACTS §5.2 names the `standings` type but pins no payload shape
      // beyond that (unlike `hp`'s worked example in FINAL-PLAN.md §8.4).
      // Treated as an opaque pass-through projection: the whole payload is
      // stored verbatim as `state.standings`, and if it happens to carry a
      // `bracket` key that is *also* mirrored onto `state.bracket` (the
      // projector needs both the table standings and the knockout tree —
      // FINAL-PLAN.md §8.3 — and CONTRACTS §5.2's L3 catalogue has no
      // separate `bracket` event type to carry the latter). Never affects
      // hp/credits/claims.
      s = { ...s, standings: p };
      if (isPlainObject(p) && 'bracket' in p) s = { ...s, bracket: p.bracket };
      break;
    }

    case 'reveal':
    case 'cutin':
    case 'shake':
    case 'ticker': {
      // L4 — UI choreography. "Layer 4 events go into a queue the renderer
      // drains; they never touch scores" (task brief / CONTRACTS §5). Pushed
      // verbatim; drainChoreography() below is how a renderer empties it.
      const entry = { seq: event.seq, t: event.t, type: event.type, side: event.side, p };
      s = { ...s, choreography: pushBounded(s.choreography, entry, CHOREOGRAPHY_BOUND) };
      // `featured` has no dedicated event type either (see `standings`'s
      // comment) — if a `ticker` payload happens to carry a `featured` key
      // (the projector's own way of naming which duel it is spotlighting
      // among the batch — FINAL-PLAN.md §8.3), mirror it verbatim.
      if (event.type === 'ticker' && isPlainObject(p) && 'featured' in p) {
        s = { ...s, featured: p.featured };
      }
      break;
    }

    default: {
      if (SIMPLE_COMBAT_LOG_TYPES.has(event.type)) {
        const side = event.side;
        s = pushLogTo(s, event, isSide(side) ? [side] : []);
        s = { ...s, phase: 'combat' };
      }
      // KNOWN_TYPES is exactly the union of the explicit `case`s above and
      // SIMPLE_COMBAT_LOG_TYPES, so nothing reaches this `if` as false today
      // — the guard above (`!KNOWN_TYPES.has(event.type)` -> early return)
      // already turned away anything not in the 25-type catalogue before the
      // switch ran at all. This `if` is what keeps that merely degrading
      // (silent no-op) instead of throwing, should a future edit ever add to
      // one set without the other.
      break;
    }
  }

  return s;
}

// ---------------------------------------------------------------------------
// drainChoreography — how a renderer empties the L4 queue
// ---------------------------------------------------------------------------

/**
 * Pure drain: returns the queued choreography events (oldest first) and a
 * new state with `choreography` emptied. Does not mutate `state`.
 * @param {object} state
 * @returns {{events: object[], state: object}}
 */
export function drainChoreography(state) {
  const s = isPlainObject(state) ? state : createInitialState();
  return { events: s.choreography, state: { ...s, choreography: [] } };
}
