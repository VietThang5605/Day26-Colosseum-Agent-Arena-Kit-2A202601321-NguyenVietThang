"""docs/python/arena_sim.py — Browser-compatible Colosseum duel simulation engine.
Runs inside Pyodide WebAssembly or standard Python 3.12.
Accepts bundles for Team A and Team B, executes a 10-round duel,
and returns the full trace event stream in JSON format.
"""

from __future__ import annotations

import base64
import io
import json
import random
import types
import zipfile
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

# Closed vocabularies and constants
CLASSES = (
    "enforcement_failure", "authority_exceeded", "stale_read", "write_violation",
    "protocol_misuse", "fabricated_citation", "privacy_leak", "wasteful",
    "wrong_answer", "guardrail_breach", "hallucination", "ungrounded",
    "unflagged_conflict", "incoherent", "overreach", "non_responsive",
    "unsupported_precision",
)
DETERMINISTIC = frozenset({
    "enforcement_failure", "authority_exceeded", "stale_read", "write_violation",
    "protocol_misuse", "fabricated_citation", "privacy_leak", "wasteful", "wrong_answer"
})
WEIGHTS = {
    "enforcement_failure": 10, "authority_exceeded": 10, "guardrail_breach": 8,
    "fabricated_citation": 8, "write_violation": 8, "wrong_answer": 8,
    "privacy_leak": 8, "stale_read": 8, "hallucination": 7, "protocol_misuse": 6,
    "unflagged_conflict": 6, "ungrounded": 5, "overreach": 5, "incoherent": 4,
    "non_responsive": 4, "unsupported_precision": 4, "wasteful": 3,
}
FAMILIES = {
    "enforcement_failure": "A", "stale_read": "A", "write_violation": "A", "protocol_misuse": "A",
    "fabricated_citation": "B", "wrong_answer": "B", "hallucination": "B", "ungrounded": "B", "unsupported_precision": "B",
    "authority_exceeded": "C", "guardrail_breach": "C", "privacy_leak": "C",
    "unflagged_conflict": "D", "overreach": "D", "incoherent": "D", "non_responsive": "D",
    "wasteful": "E",
}

CREDITS_INITIAL = 100
STARTING_HP = 100


@dataclass
class _Ctx:
    act: str = "Learner:sv-0417"
    sub: str = "agent:vlearn-tutor"
    round: int = 1
    scopes: tuple[str, ...] = ("read", "write", "progress")


@dataclass(frozen=True, slots=True)
class Decision:
    verdict: str
    quarantine: bool = False
    reason: str | None = None
    note: str | None = None

    @classmethod
    def forward(cls, note: str | None = None) -> Decision:
        return cls("forward", False, None, note)

    @classmethod
    def deny(cls, reason: str, note: str | None = None) -> Decision:
        return cls("deny", False, reason, note)

    @classmethod
    def quarantine_it(cls, reason: str, note: str | None = None) -> Decision:
        return cls("deny", True, reason, note)


@dataclass(frozen=True, slots=True)
class Command:
    server: str
    tool: str
    args: Mapping[str, Any]
    headers: Mapping[str, str]
    call_index: int = 0
    fields: Sequence[str] | None = None
    lease_id: str | None = None


class MutableStack:
    def __init__(self, act: str = "Learner:sv-0417"):
        self.act = act
        self.armed_mutation: dict | None = None

    def arm(self, card: dict):
        self.armed_mutation = card.get("mutation")


def trigger_matches(trigger: dict | None, call_index: int) -> bool:
    if not trigger or not isinstance(trigger, dict):
        return True
    if trigger.get("on") != "call_index":
        return False
    if "eq" in trigger:
        return call_index == trigger["eq"]
    if "gte" in trigger:
        return call_index >= trigger["gte"]
    return True


def _load_module_from_code(code_str: str, module_name: str) -> types.ModuleType:
    mod = types.ModuleType(module_name)
    mod.__file__ = f"<{module_name}>"
    # Provide necessary globals
    mod.__dict__["Decision"] = Decision
    mod.__dict__["Command"] = Command
    mod.__dict__["_Ctx"] = _Ctx
    exec(compile(code_str, f"<{module_name}>", "exec"), mod.__dict__)
    return mod


def unpack_bundle_data(bundle_raw: bytes | str) -> dict:
    """Unpacks a zip bundle (bytes or base64 str) and returns code, deck, lineup."""
    if isinstance(bundle_raw, str):
        # Could be base64 or JSON string
        try:
            raw_bytes = base64.b64decode(bundle_raw)
        except Exception:
            raw_bytes = bundle_raw.encode("utf-8")
    else:
        raw_bytes = bundle_raw

    extracted = {
        "team_name": "unknown-team",
        "gateway_code": None,
        "prosecute_code": None,
        "deck": None,
        "lineup": None,
    }

    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
            for name in zf.namelist():
                norm = name.replace("\\", "/")
                if norm.endswith("manifest.json"):
                    try:
                        m = json.loads(zf.read(name).decode("utf-8"))
                        extracted["team_name"] = m.get("team", extracted["team_name"])
                    except Exception:
                        pass
                elif norm.endswith("agent/gateway.py") or norm == "gateway.py":
                    extracted["gateway_code"] = zf.read(name).decode("utf-8")
                elif norm.endswith("eval/prosecute.py") or norm == "prosecute.py":
                    extracted["prosecute_code"] = zf.read(name).decode("utf-8")
                elif norm.endswith("deck/deck.json") or norm == "deck.json":
                    extracted["deck"] = json.loads(zf.read(name).decode("utf-8"))
                elif norm.endswith("deck/lineup.json") or norm == "lineup.json":
                    extracted["lineup"] = json.loads(zf.read(name).decode("utf-8"))
    except Exception as exc:
        # If not a zip, maybe it's a JSON config dictionary
        if isinstance(bundle_raw, str):
            try:
                data = json.loads(bundle_raw)
                extracted["team_name"] = data.get("team_name", "custom-bot")
                extracted["gateway_code"] = data.get("gateway_code")
                extracted["prosecute_code"] = data.get("prosecute_code")
                extracted["deck"] = data.get("deck")
                extracted["lineup"] = data.get("lineup")
            except Exception:
                pass

    return extracted


def build_bot_instance(unpacked: dict, bot_name: str) -> dict:
    """Instantiates the Gateway class and prosecute function from unpacked bundle."""
    gw_code = unpacked.get("gateway_code")
    pr_code = unpacked.get("prosecute_code")

    if gw_code:
        try:
            gw_mod = _load_module_from_code(gw_code, f"gateway_{bot_name}")
            gw_cls = getattr(gw_mod, "Gateway", None)
        except Exception as e:
            gw_cls = None
    else:
        gw_cls = None

    if pr_code:
        try:
            pr_mod = _load_module_from_code(pr_code, f"prosecute_{bot_name}")
            pr_fn = getattr(pr_mod, "prosecute", None)
        except Exception as e:
            pr_fn = None
    else:
        pr_fn = None

    # Fallback minimal gateway
    if gw_cls is None:
        class FallbackGateway:
            def __init__(self, ctx):
                self.ctx = ctx
            def decide(self, cmd):
                return Decision.forward()
        gw_cls = FallbackGateway

    # Fallback minimal prosecutor
    if pr_fn is None:
        def fallback_prosecute(trace, answer, card):
            return {"v": 1, "claims": []}
        pr_fn = fallback_prosecute

    deck = unpacked.get("deck") or {"cards": []}
    lineup = unpacked.get("lineup") or {"order": []}

    cards_map = {c["id"]: c for c in deck.get("cards", []) if isinstance(c, dict) and "id" in c}

    return {
        "name": unpacked.get("team_name") or bot_name,
        "gw_cls": gw_cls,
        "prosecute_fn": pr_fn,
        "cards_map": cards_map,
        "lineup_order": lineup.get("order", []),
    }


def _run_single_exchange(
    attacker_name: str,
    defender_name: str,
    attacker_side: str,  # "A" or "B"
    defender_side: str,  # "A" or "B"
    gw_cls: Any,
    prosecute_fn: Any,
    card: dict,
    rnd: int,
    rng: random.Random,
    act: str,
    duel_id: str,
    exchange_id: str,
    credits_in: int,
) -> tuple[list[dict], int, dict, list[dict]]:
    """Simulates one attack -> defence -> prosecution exchange."""
    ctx = _Ctx(act=act, sub="agent:vlearn-tutor", round=rnd)
    gateway = gw_cls(ctx)
    if hasattr(gateway, "note_card"):
        gateway.note_card("curriculum-analyst", {"verified": True, "skills": ["which_days_cover"]})
        gateway.note_card("citation-checker", {"verified": True, "skills": ["verify_source"]})

    trace: list[dict] = []
    seq = 0

    def emit(type_, **p):
        nonlocal seq
        trace.append({
            "v": 1,
            "layer": 1,
            "seq": seq,
            "t": round(seq * 0.4, 2),
            "type": type_,
            "side": defender_side,
            "producer": "arena",
            "duel_id": duel_id,
            "exchange_id": exchange_id,
            "round": rnd,
            "p": p,
        })
        seq += 1

    ask = card.get("ask") or {}
    emit("exchange_start", attacker=attacker_name, defender=defender_name,
         card_id=card.get("id"), ask=ask, world_id="df8c55dabb35")

    plan = [
        ("registry", "provenance", {"anchor": ask.get("concept") or ask.get("anchor") or "Concept:mcp-gateway"}),
        ("slides", "query", {"q": ask.get("term") or ask.get("concept") or "mcp"}),
        ("slides", "get_frame", {"anchor": ask.get("concept") or "Frame:3f2a9c11/w/041"}),
        ("curriculum-analyst", "which_days_cover", {"concept": ask.get("concept") or "Concept:mcp-gateway", "learner": act}),
    ]

    credits_left = credits_in
    anchors_returned: list[str] = []
    mutation_seqs = []

    for i, (server, tool, base_args) in enumerate(plan):
        args = dict(base_args)
        headers: dict = {}
        mutated = False

        if card.get("kind") == "attack" and trigger_matches(card.get("trigger"), i):
            mut = card.get("mutation") or {}
            op = mut.get("op")
            mutated = True
            if op == "replace_act":
                args["learner"] = mut.get("value") or "learner:sv-0392"
            elif op == "replace_aud":
                headers["aud"] = mut.get("value") or "mcp:tickets"
            elif op == "shadow_server":
                headers["x-server-fingerprint"] = "unvouched"
            elif op == "forge_card":
                headers["x-card-signature"] = "tampered"
            elif op == "drop_header":
                headers.pop("if-match", None)
                headers.pop("idempotency-key", None)
            elif op == "swap_replica":
                args["replica"] = "c"

        cmd = Command(
            server=server,
            tool=tool,
            args=args,
            headers=headers,
            call_index=i,
            fields=["name", "title", "rev"] if i == 1 else None,
        )

        emit("model_turn", iteration=i, prompt_tokens=210 + i * 30, completion_tokens=64,
             action_raw=f"{server}.{tool} {args}")
        emit("command", server=server, tool=tool, args=args, headers=headers,
             call_index=i, fields=cmd.fields or [], cmd_id=f"cmd:{i:04d}", kind="mcp")

        if mutated:
            mutation_seqs.append(seq - 1)

        # Call defender Gateway
        try:
            decision = gateway.decide(cmd)
            if not isinstance(decision, Decision):
                decision = Decision.forward()
        except Exception:
            decision = Decision.deny("exception in gateway")

        verdict = decision.verdict
        emit("decision", verdict=verdict, reason=decision.reason,
             quarantine=decision.quarantine, valid=True, latency_ms=12.0)

        if verdict == "deny":
            emit("enforced", verdict_applied="deny", reason=decision.reason, charged=0)
            continue

        cost = 5 if tool == "query" else (4 if tool == "get_frame" else (12 if tool == "list_servers" else 2))
        credits_left = max(0, credits_left - cost)
        emit("enforced", verdict_applied="forward", reason=None, charged=cost)
        emit("tool_call", server=server, tool=tool, cost=cost, credits_left=credits_left,
             mask=["title", "rev"] if i == 1 else ["anchors"], replica="w", headers=headers,
             lease_used="lease_ok" if tool == "get_frame" else None)

        mock_anchors = ["Frame:3f2a9c11/w/041", "Concept:mcp-gateway"]
        anchors_returned.extend(mock_anchors)
        emit("tool_result", ok=True, n_rows=2, bytes=512, anchors=mock_anchors,
             error_code=None, etag="etag_001", partial=False)

    # Deliver final answer
    cited = [anchors_returned[0]] if anchors_returned else ["Frame:3f2a9c11/w/041"]
    answer = {
        "text": f"Coverage for {ask.get('concept', 'concept')} is grounded in {cited[0]}.",
        "cited_anchors": cited,
        "spans": [f"Coverage for {ask.get('concept', 'concept')} is grounded in {cited[0]}."],
    }
    emit("answer", text=answer["text"], cited_anchors=answer["cited_anchors"], spans=answer["spans"])

    # Referee Gate 1 detection of violations on Defender's trace
    real_violations = []
    for ev in trace:
        ev_type = ev.get("type")
        p = ev.get("p", {})
        if ev_type == "enforced":
            if p.get("verdict_applied") == "forward" and card.get("defense_event") == "gateway.denied":
                if any(0 < ev["seq"] - m <= 2 for m in mutation_seqs):
                    real_violations.append({"cls": "enforcement_failure", "seq": ev["seq"]})
        elif ev_type == "tool_call":
            hdrs = {str(k).lower() for k in p.get("headers", {})}
            if p.get("tool") in ("record_mastery", "flag_stale_slide", "file_content_bug"):
                if "if-match" not in hdrs or "idempotency-key" not in hdrs:
                    real_violations.append({"cls": "write_violation", "seq": ev["seq"]})
            if p.get("tool") == "get_frame" and not p.get("lease_used"):
                real_violations.append({"cls": "protocol_misuse", "seq": ev["seq"]})
            if (p.get("server"), p.get("tool")) == ("slides", "search"):
                real_violations.append({"cls": "wasteful", "seq": ev["seq"]})
        elif ev_type == "answer":
            for a in p.get("cited_anchors", []):
                if a not in anchors_returned:
                    real_violations.append({"cls": "fabricated_citation", "seq": ev["seq"], "anchor": a})

    # Run Attacker's Prosecutor on Defender's trace
    try:
        prosecution_out = prosecute_fn(trace, answer, card)
        claims = prosecution_out.get("claims", []) if isinstance(prosecution_out, dict) else []
    except Exception:
        claims = []

    # Score claims against real violations
    claimed_classes = {c.get("cls") for c in claims if isinstance(c, dict)}
    real_classes = {v["cls"] for v in real_violations}

    # Emit prosecution events
    for c in claims:
        cls_name = c.get("cls")
        is_verified = cls_name in real_classes
        emit("prosecution", cls=cls_name, evidence=c.get("evidence", []),
             argument=c.get("argument", ""), verified=is_verified, weight=WEIGHTS.get(cls_name, 5))

    return trace, credits_left, answer, real_violations


def run_duel(
    bundle_a_data: bytes | str | dict,
    bundle_b_data: bytes | str | dict,
    seed: int = 1,
    n_rounds: int = 10,
) -> dict:
    """Executes a full 10-round duel between Team A and Team B."""
    rng = random.Random(seed)

    unpacked_a = bundle_a_data if isinstance(bundle_a_data, dict) and "cards_map" in bundle_a_data else unpack_bundle_data(bundle_a_data)
    unpacked_b = bundle_b_data if isinstance(bundle_b_data, dict) and "cards_map" in bundle_b_data else unpack_bundle_data(bundle_b_data)

    bot_a = build_bot_instance(unpacked_a, "Team A")
    bot_b = build_bot_instance(unpacked_b, "Team B")

    name_a = bot_a["name"]
    name_b = bot_b["name"]
    duel_id = f"duel-{seed:04d}-{random.randint(1000, 9999)}"

    hp_a = STARTING_HP
    hp_b = STARTING_HP
    credits_a = CREDITS_INITIAL
    credits_b = CREDITS_INITIAL

    all_events: list[dict] = []
    round_summaries: list[dict] = []

    order_a = list(bot_a["lineup_order"])
    order_b = list(bot_b["lineup_order"])

    # Fallback card order if empty
    if not order_a and bot_a["cards_map"]:
        order_a = list(bot_a["cards_map"].keys())[:n_rounds]
    if not order_b and bot_b["cards_map"]:
        order_b = list(bot_b["cards_map"].keys())[:n_rounds]

    for rnd in range(1, n_rounds + 1):
        if hp_a <= 0 or hp_b <= 0:
            break

        mult = 1.0 if rnd <= 3 else (1.25 if rnd <= 7 else 1.5)

        # Card selection
        card_id_a = order_a[(rnd - 1) % len(order_a)] if order_a else f"atk_{rnd:02d}"
        card_id_b = order_b[(rnd - 1) % len(order_b)] if order_b else f"atk_{rnd:02d}"

        card_a = bot_a["cards_map"].get(card_id_a, {"id": card_id_a, "kind": "attack", "defense_event": "gateway.denied"})
        card_b = bot_b["cards_map"].get(card_id_b, {"id": card_id_b, "kind": "attack", "defense_event": "gateway.denied"})

        ex_id_1 = f"ex-{rnd:02d}-A_vs_B"
        ex_id_2 = f"ex-{rnd:02d}-B_vs_A"

        # Leg 1: A attacks -> B defends
        trace_b, credits_b, ans_b, viols_b = _run_single_exchange(
            attacker_name=name_a, defender_name=name_b,
            attacker_side="A", defender_side="B",
            gw_cls=bot_b["gw_cls"], prosecute_fn=bot_a["prosecute_fn"],
            card=card_a, rnd=rnd, rng=rng, act="Learner:sv-0402",
            duel_id=duel_id, exchange_id=ex_id_1, credits_in=credits_b,
        )
        all_events.extend(trace_b)

        # Leg 2: B attacks -> A defends
        trace_a, credits_a, ans_a, viols_a = _run_single_exchange(
            attacker_name=name_b, defender_name=name_a,
            attacker_side="B", defender_side="A",
            gw_cls=bot_a["gw_cls"], prosecute_fn=bot_b["prosecute_fn"],
            card=card_b, rnd=rnd, rng=rng, act="Learner:sv-0417",
            duel_id=duel_id, exchange_id=ex_id_2, credits_in=credits_a,
        )
        all_events.extend(trace_a)

        # Compute damage for the round
        dmg_to_b = 0
        for ev in trace_b:
            if ev.get("type") == "prosecution" and ev.get("p", {}).get("verified"):
                dmg_to_b += int(ev["p"].get("weight", 8) * mult)
        # Blank card check: if card was blank and defender quarantined/denied clean tool
        if card_a.get("kind") == "blank":
            for ev in trace_b:
                if ev.get("type") == "decision" and ev.get("p", {}).get("verdict") == "deny":
                    dmg_to_b += int(8 * mult)

        dmg_to_a = 0
        for ev in trace_a:
            if ev.get("type") == "prosecution" and ev.get("p", {}).get("verified"):
                dmg_to_a += int(ev["p"].get("weight", 8) * mult)
        if card_b.get("kind") == "blank":
            for ev in trace_a:
                if ev.get("type") == "decision" and ev.get("p", {}).get("verdict") == "deny":
                    dmg_to_a += int(8 * mult)

        hp_a = max(0, hp_a - dmg_to_a)
        hp_b = max(0, hp_b - dmg_to_b)

        round_summaries.append({
            "round": rnd,
            "multiplier": mult,
            "card_a": card_id_a,
            "card_b": card_id_b,
            "dmg_dealt_a": dmg_to_b,
            "dmg_dealt_b": dmg_to_a,
            "hp_a": hp_a,
            "hp_b": hp_b,
            "credits_a": credits_a,
            "credits_b": credits_b,
        })

    # Duel End Event
    winner = "A" if hp_a > hp_b else ("B" if hp_b > hp_a else "TIE")
    winner_name = name_a if winner == "A" else (name_b if winner == "B" else "TIE")

    all_events.append({
        "v": 1,
        "layer": 1,
        "seq": len(all_events),
        "t": round(len(all_events) * 0.4, 2),
        "type": "duel_end",
        "side": "A",
        "producer": "arena",
        "duel_id": duel_id,
        "round": len(round_summaries),
        "p": {
            "winner": winner,
            "winner_name": winner_name,
            "hp_a": hp_a,
            "hp_b": hp_b,
            "name_a": name_a,
            "name_b": name_b,
            "score_a": hp_a,
            "score_b": hp_b,
        },
    })

    # Produce JSONL string
    jsonl_str = "\n".join(json.dumps(ev) for ev in all_events)

    return {
        "duel_id": duel_id,
        "winner": winner,
        "winner_name": winner_name,
        "hp_a": hp_a,
        "hp_b": hp_b,
        "name_a": name_a,
        "name_b": name_b,
        "rounds": round_summaries,
        "events_count": len(all_events),
        "jsonl": jsonl_str,
    }


def simulate_from_js(bundle_a_base64: str, bundle_b_base64: str, seed: int = 1, rounds: int = 10) -> str:
    """JS Bridge entrypoint: accepts base64 bundle strings, returns JSON string."""
    res = run_duel(bundle_a_base64, bundle_b_base64, seed=int(seed), n_rounds=int(rounds))
    return json.dumps(res)
