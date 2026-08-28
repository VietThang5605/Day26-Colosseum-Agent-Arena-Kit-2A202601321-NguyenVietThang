// kit/arena_ui/core/decode.js
//
// COLOSSEUM — the event envelope decoder (CONTRACTS.md §5, FINAL-PLAN.md
// §8.4). Byte-identical between Day26-Colosseum-Agent-Arena-Kit and
// Day26-Colosseum-Agent-Arena (CONTRACTS.md §10). Native ES module — no
// bundler, no npm, no CDN (see core/theme.js's header for why that is safe
// under both a browser `<script type="module">` and plain `node file.js`).
//
// This file has exactly one job: turn "a JSON line the arena wrote, or a
// JSON object the transport already parsed" into either a validated event
// object or `null`. It never throws on bad input — CONTRACTS §5.1 is
// explicit that an unknown schema version is "a hard error in the ledger and
// a SKIPPED LINE IN THE UI", and the task brief extends that same rule to an
// unknown `type`. Forward compatibility is the whole point: a newer arena
// must be able to emit an event this UI has never heard of, and this file's
// job is to make that a silent no-op, not a crash.
//
// Two entry points, one core:
//
//   normalizeEvent(obj)  — obj is an ALREADY-PARSED plain object (this is
//                           what `GET /events` hands back per CONTRACTS
//                           §10.1: `{"events":[...]}` is a JSON array of
//                           envelope objects, not JSON-lines text). Returns
//                           the validated event or null.
//   parseLine(line)      — line is a raw JSONL line (CONTRACTS §5.3: one
//                           event per line, newline-terminated, in
//                           `runs/<run_id>/<exchange_id>.jsonl`). Thin
//                           JSON.parse-with-catch wrapper over
//                           normalizeEvent. A read that lands on a partial
//                           trailing line (the writer has not committed the
//                           newline yet) throws a SyntaxError from
//                           JSON.parse — that is caught here and treated
//                           exactly like "not committed yet", i.e. null, not
//                           an error. Advancing the byte-offset cursor past
//                           a line is the CALLER's concern (it owns the
//                           newline-splitting), not this function's.
//
// Both return `null` for: invalid JSON, a non-object, a missing/unknown `v`,
// a missing/unknown `type`, or a structurally malformed envelope (bad
// `layer`/`seq`/`t`/`p`). Every other case degrades gracefully rather than
// rejecting: a missing/mistyped `run_id`/`duel_id`/`exchange_id`/`round`/
// `side`/`producer` normalizes to `null` instead of failing the whole event,
// because those fields are context reduce.js can carry forward from a prior
// event rather than a reason to discard a domain fact.

// ---------------------------------------------------------------------------
// the catalogue — CONTRACTS.md §5.2, kept in sync by hand (that section is
// the single source of truth; this Set and reduce.js's copy of it must both
// track it). 11 L1 + 5 L2 + 5 L3 + 4 L4 = 25 known types.
// ---------------------------------------------------------------------------

export const KNOWN_VERSIONS = new Set([1]);

export const KNOWN_TYPES = new Set([
  // L1 — domain facts (trusted, immutable, the only scoring inputs)
  'exchange_start', 'model_turn', 'command', 'decision', 'enforced',
  'tool_call', 'tool_result', 'mutation', 'answer', 'integrity', 'own_telemetry',
  // L2 — referee decisions
  'claim_filed', 'claim_outcome', 'latent_violation', 'recoil', 'penalty',
  // L3 — match state
  'hp', 'credits', 'round_end', 'duel_end', 'standings',
  // `exchange_end` is emitted by arena/exchange.py and was missing here, so BOTH views
  // silently dropped it — EventWriter.emit() validates `layer` and `producer` but never
  // `type`, so a producer/consumer mismatch on a type name is invisible at both ends.
  'exchange_end',
  // L4 — UI choreography
  'reveal', 'cutin', 'shake', 'ticker',
]);

// A blob ref, CONTRACTS §5.3: "the event carries {"ref": "blobs/<sha16>"}".
// `<sha16>` is a 16-hex-character content fingerprint (short form of the
// sha256 etag elsewhere in this spec) — case-insensitive to match, kept
// verbatim in the returned descriptor so a caller can look it up exactly.
const BLOB_REF_RE = /^blobs\/([0-9a-fA-F]{16})$/;

// ---------------------------------------------------------------------------
// small predicates
// ---------------------------------------------------------------------------

function isPlainObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** True iff `x` is exactly the blob-indirection shape `{"ref": "blobs/<sha16>"}`
 *  (extra sibling keys alongside `ref` are tolerated — CONTRACTS says nothing
 *  forbids them, and rejecting on an unexpected extra key would be exactly
 *  the kind of unnecessary fatality this file exists to avoid). */
export function isBlobRef(x) {
  return isPlainObject(x) && typeof x.ref === 'string' && BLOB_REF_RE.test(x.ref);
}

// ---------------------------------------------------------------------------
// normalizeEvent — the core decoder
// ---------------------------------------------------------------------------

/**
 * Validate and normalize an already-parsed envelope object.
 * @param {unknown} raw
 * @returns {object|null} the normalized event, or null if it must be skipped
 *   (unknown version, unknown type, or a structurally malformed envelope).
 */
export function normalizeEvent(raw) {
  if (!isPlainObject(raw)) return null;

  // "AN UNKNOWN v OR AN UNKNOWN type IS SKIPPED, NEVER FATAL" — the task
  // brief's hard requirement, restating CONTRACTS §5.1 for the UI side.
  if (!KNOWN_VERSIONS.has(raw.v)) return null;
  if (typeof raw.type !== 'string' || !KNOWN_TYPES.has(raw.type)) return null;

  // Every event carries these per CONTRACTS §5.1's envelope table. A value
  // present but the wrong TYPE is malformed — not "unknown", genuinely
  // broken — and is skipped the same way, never thrown.
  if (typeof raw.layer !== 'number' || raw.layer < 1 || raw.layer > 4) return null;
  if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq) || raw.seq < 0) return null;
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) return null;
  if (!isPlainObject(raw.p)) return null; // "the typed payload" — always an object, may be {}

  // Context fields: normalize-or-null rather than reject. `side` is legitimately
  // absent/null on a cross-side event (e.g. L3 `hp`, `duel_end`, `standings`) —
  // CONTRACTS §5.1's table lists it as a column every layer shares, not as a
  // value every event necessarily has an A/B answer for.
  return {
    v: raw.v,
    layer: raw.layer,
    seq: raw.seq,
    t: raw.t,
    run_id: typeof raw.run_id === 'string' ? raw.run_id : null,
    duel_id: typeof raw.duel_id === 'string' ? raw.duel_id : null,
    exchange_id: typeof raw.exchange_id === 'string' ? raw.exchange_id : null,
    round: typeof raw.round === 'number' && Number.isFinite(raw.round) ? raw.round : null,
    side: raw.side === 'A' || raw.side === 'B' ? raw.side : null,
    producer: typeof raw.producer === 'string' ? raw.producer : null,
    type: raw.type,
    p: raw.p,
  };
}

// ---------------------------------------------------------------------------
// parseLine — the JSONL entry point
// ---------------------------------------------------------------------------

/**
 * Parse one JSONL line into a normalized event, or null.
 *
 * CONTRACTS §5.3: "The newline is the commit marker. A reader returns only
 * complete lines; a partial trailing line is not an error, it is 'not yet
 * committed'." A line handed in here that is empty, whitespace-only, or not
 * valid JSON (the shape a writer's not-yet-flushed partial line takes) is
 * treated exactly like that: null, not a thrown error. `line` may or may not
 * carry its own trailing `\n`/`\r\n` — either is accepted.
 *
 * @param {unknown} line
 * @returns {object|null}
 */
export function parseLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.replace(/\r?\n$/, '');
  if (trimmed.trim() === '') return null;

  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // Truncated / not-yet-committed text parses as invalid JSON — this is
    // the "partial trailing line" case, not a fatal one.
    return null;
  }
  return normalizeEvent(raw);
}

// ---------------------------------------------------------------------------
// resolveRef — the {"ref": "blobs/<sha16>"} indirection (CONTRACTS §5.3)
// ---------------------------------------------------------------------------

function walkForRefs(node, path, depth, out) {
  if (depth > 8) return; // guard against pathological/cyclical-looking payloads; p is small JSON
  if (isBlobRef(node)) {
    const m = BLOB_REF_RE.exec(node.ref);
    out.push({ path: path.slice(), ref: node.ref, sha16: m[1] });
    return; // a ref node is a leaf — do not also descend into its own keys
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      path.push(i);
      walkForRefs(node[i], path, depth + 1, out);
      path.pop();
    }
    return;
  }
  if (isPlainObject(node)) {
    // Sorted keys: deterministic output order regardless of the object's own
    // insertion order (this file follows the "sort before serialising" spirit
    // of CONTRACTS §11 even though resolveRef never feeds a score).
    for (const k of Object.keys(node).sort()) {
      path.push(k);
      walkForRefs(node[k], path, depth + 1, out);
      path.pop();
    }
  }
}

/**
 * Locate every `{"ref": "blobs/<sha16>"}` indirection inside an event's `p`
 * payload (CONTRACTS §5.3: "action_raw, answer.text, tool rows" over 4 KB
 * are stored this way; this walk is generic rather than hard-coded to those
 * three field names, so a payload shape the arena adds later is still found
 * without an edit here — the same forward-compatibility stance as the rest
 * of this file).
 *
 * PURE AND NEVER FETCHES. Locating a blob is this file's job; retrieving one
 * over HTTP is the transport layer's — core/ must keep working under plain
 * `node` with no network and no DOM (this file has neither `fetch` nor
 * `XMLHttpRequest` in it, on purpose).
 *
 * Two modes, selected by whether `blobs` is passed:
 *
 *   resolveRef(event)         -> [{path, ref, sha16}, ...]   (possibly [])
 *     Every ref found, as a dot/bracket-free path (array of string/number
 *     keys) rooted at the event itself (path[0] is always "p").
 *
 *   resolveRef(event, blobs)  -> a NEW event with every found ref spliced in
 *     `blobs` is a `sha16 -> resolved value` lookup (e.g. `Map` or plain
 *     object with a `.get`/index access — see below). Every located ref
 *     whose sha16 is present in `blobs` is replaced by the resolved value at
 *     its exact path; a ref whose sha16 is NOT in `blobs` is left as-is
 *     (still `{"ref": ...}`) rather than dropped, so a caller can tell "not
 *     fetched yet" from "fetched and empty". `event` itself is never
 *     mutated — every step on the found path is shallow-copied.
 *
 * @param {object} event
 * @param {Map<string, unknown> | Record<string, unknown>} [blobs]
 */
export function resolveRef(event, blobs) {
  if (!isPlainObject(event) || !isPlainObject(event.p)) {
    return blobs === undefined ? [] : event;
  }
  const found = [];
  walkForRefs(event.p, ['p'], 0, found);

  if (blobs === undefined) return found;

  const lookup = (sha16) => (blobs instanceof Map ? blobs.get(sha16) : blobs[sha16]);

  let next = event;
  for (const { path, sha16 } of found) {
    if (lookup(sha16) === undefined) continue; // not resolved yet — leave the ref in place
    next = setAtPath(next, path, lookup(sha16));
  }
  return next;
}

/** Copy-on-write set at a path: every object/array along the way is
 *  shallow-copied, nothing outside the path is touched, and the input is
 *  never mutated. */
function setAtPath(root, path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[head] = setAtPath(root[head], rest, value);
    return copy;
  }
  if (isPlainObject(root)) {
    const copy = { ...root };
    copy[head] = setAtPath(root[head], rest, value);
    return copy;
  }
  // Path expects a container that is not there (a malformed/foreign shape) —
  // degrade gracefully by leaving the original value alone rather than
  // throwing on a hand-built or unexpected object.
  return root;
}
