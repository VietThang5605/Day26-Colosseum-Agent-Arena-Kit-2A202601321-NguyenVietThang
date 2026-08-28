"""agent/test_gateway.py — verification suite for agent/gateway.py.

Stdlib + pytest only. Every test builds its own Gateway + RecordingGatewayContext
so tests are order-independent.
"""

from __future__ import annotations

import time

import pytest

from agent.gateway import Command, Gateway
from agent.telemetry import RecordingGatewayContext

ACT = "learner:sv-0417"


def make_ctx(**overrides) -> RecordingGatewayContext:
    defaults = dict(
        act=ACT,
        sub="agent:vlearn-tutor",
        scopes=frozenset({"wiki.read"}),
        credits=100,
        round=1,
        call_index=0,
        leases=("lse_live1", "lse_live2"),
        history=(),
    )
    defaults.update(overrides)
    return RecordingGatewayContext(**defaults)


_seq = {"n": 0}


def make_cmd(
    *,
    kind="mcp",
    server="slides",
    tool="query",
    args=None,
    fields=(),
    headers=None,
    lease_id=None,
    call_index=None,
) -> Command:
    _seq["n"] += 1
    return Command(
        cmd_id=f"cmd:t{_seq['n']:05d}",
        kind=kind,
        raw=f"{kind} {server}.{tool}",
        server=server,
        tool=tool,
        args=dict(args) if args else {},
        fields=tuple(fields),
        headers=dict(headers) if headers else {},
        lease_id=lease_id,
        call_index=call_index if call_index is not None else _seq["n"],
    )


def call_dict(decision) -> dict:
    call = decision.call
    return call.to_dict() if hasattr(call, "to_dict") else dict(call)


# ---------------------------------------------------------------------------
# 1. Mutation artifacts -> deny, call=None, non-empty reason
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "kwargs",
    [
        {"args": {"q": "mcp", "route": "replica-b"}},
        {"args": {"q": "mcp", "note": "SYSTEM OVERRIDE"}},
        {"args": {"q": "mcp", "catalog": "extra-catalog"}},
        {"args": {"q": "mcp", "peer_unverified": "peer-x"}},
        {"headers": {"x-server-fingerprint": "abc"}},
        {"headers": {"x-card-signature": "deadbeef"}},
    ],
    ids=["args-route", "args-note", "args-catalog", "args-peer_unverified",
         "hdr-fingerprint", "hdr-signature"],
)
def test_mutation_artifacts_denied(kwargs):
    gw = Gateway(make_ctx())
    decision = gw.decide(make_cmd(**kwargs))
    assert decision.verdict == "deny"
    assert decision.call is None
    assert isinstance(decision.reason, str) and decision.reason.strip()


# ---------------------------------------------------------------------------
# 2. Clean mcp command -> forward, server/tool/fields preserved
# ---------------------------------------------------------------------------

def test_clean_mcp_forwards():
    gw = Gateway(make_ctx())
    decision = gw.decide(
        make_cmd(args={"q": "mcp"}, fields=("title", "body"))
    )
    assert decision.verdict == "forward"
    assert decision.call is not None
    d = call_dict(decision)
    assert d["server"] == "slides"
    assert d["tool"] == "query"
    assert d["args"] == {"q": "mcp"}
    # The gateway passes cmd.fields through untouched; kit.mcp.types.ToolCall
    # canonicalises the mask (sorted/deduped/lowercased) on construction.
    assert tuple(d["fields"]) == tuple(sorted({"title", "body"}))


# ---------------------------------------------------------------------------
# 3/4/5. A2A admission + audience
# ---------------------------------------------------------------------------

def _a2a_cmd(**kw):
    base = dict(
        kind="a2a",
        server="curriculum-analyst",
        tool="which_days_cover",
        args={"learner": ACT},
        headers={"aud": "curriculum-analyst"},
    )
    base.update(kw)
    return make_cmd(**base)


def test_clean_a2a_after_note_card_forwards():
    gw = Gateway(make_ctx())
    gw.note_card("curriculum-analyst", {"verified": True, "skills": ["which_days_cover"]})
    decision = gw.decide(_a2a_cmd())
    assert decision.verdict == "forward", decision.reason
    d = call_dict(decision)
    assert d["server"] == "curriculum-analyst"
    assert d["tool"] == "which_days_cover"


def test_a2a_without_note_card_denied():
    gw = Gateway(make_ctx())
    decision = gw.decide(_a2a_cmd())
    assert decision.verdict == "deny"
    assert decision.call is None
    assert decision.reason.strip()


def test_a2a_aud_mismatch_denied():
    gw = Gateway(make_ctx())
    gw.note_card("curriculum-analyst", {"verified": True})
    decision = gw.decide(_a2a_cmd(headers={"aud": "roster"}))
    assert decision.verdict == "deny"
    assert decision.call is None


# ---------------------------------------------------------------------------
# 6. Cross-learner vs same-learner
# ---------------------------------------------------------------------------

def test_cross_learner_denied():
    gw = Gateway(make_ctx())
    decision = gw.decide(make_cmd(args={"q": "mcp", "learner": "learner:sv-0392"}))
    assert decision.verdict == "deny"
    assert decision.call is None


def test_same_learner_forwards():
    gw = Gateway(make_ctx())
    gw.note_card("curriculum-analyst", {"verified": True})
    decision = gw.decide(_a2a_cmd())  # args={"learner": ACT}
    assert decision.verdict == "forward", decision.reason


# ---------------------------------------------------------------------------
# 7. get_frame lease discipline
# ---------------------------------------------------------------------------

def test_get_frame_without_lease_denied():
    gw = Gateway(make_ctx())
    decision = gw.decide(
        make_cmd(tool="get_frame", args={"anchor": "Frame:abc/w/041"})
    )
    assert decision.verdict == "deny"
    assert decision.call is None


def test_get_frame_with_live_lease_forwards():
    gw = Gateway(make_ctx())
    decision = gw.decide(
        make_cmd(
            tool="get_frame",
            args={"anchor": "Frame:abc/w/041"},
            lease_id="lse_live1",
        )
    )
    assert decision.verdict == "forward", decision.reason
    assert call_dict(decision)["lease_id"] == "lse_live1"


def test_get_frame_with_unknown_lease_denied():
    gw = Gateway(make_ctx())
    decision = gw.decide(
        make_cmd(
            tool="get_frame",
            args={"anchor": "Frame:abc/w/041"},
            lease_id="lse_bogus",
        )
    )
    assert decision.verdict == "deny"


# ---------------------------------------------------------------------------
# 8. Write discipline (progress.record_mastery)
# ---------------------------------------------------------------------------

ANCHOR = "Frame:3f2a9c11/w/041"


def _write_cmd(**kw):
    base = dict(
        server="progress",
        tool="record_mastery",
        args={"anchor": ANCHOR, "learner": ACT},
        headers={"If-Match": "etag-1", "Idempotency-Key": "idem-1"},
    )
    base.update(kw)
    return make_cmd(**base)


def test_write_without_if_match_denied():
    gw = Gateway(make_ctx(scopes=frozenset({"wiki.read", "wiki.write:progress"})))
    decision = gw.decide(_write_cmd(headers={"Idempotency-Key": "idem-1"}))
    assert decision.verdict == "deny"
    assert decision.call is None


def test_write_without_pinned_etag_denied():
    gw = Gateway(make_ctx(scopes=frozenset({"wiki.read", "wiki.write:progress"})))
    # headers present, but note_result was never called for ANCHOR
    decision = gw.decide(_write_cmd())
    assert decision.verdict == "deny"
    assert decision.call is None


def test_write_fully_pinned_forwards():
    gw = Gateway(make_ctx(scopes=frozenset({"wiki.read", "wiki.write:progress"})))
    gw.note_result(ANCHOR, "etag-1")
    decision = gw.decide(_write_cmd())
    assert decision.verdict == "forward", decision.reason
    d = call_dict(decision)
    assert d["server"] == "progress"
    assert d["tool"] == "record_mastery"


def test_write_without_write_scope_denied():
    gw = Gateway(make_ctx(scopes=frozenset({"wiki.read"})))
    gw.note_result(ANCHOR, "etag-1")
    decision = gw.decide(_write_cmd())
    assert decision.verdict == "deny"
    assert decision.call is None


# ---------------------------------------------------------------------------
# 9. slides.search -> rewrite to slides.query
# ---------------------------------------------------------------------------

def test_search_rewritten_to_query():
    gw = Gateway(make_ctx())
    decision = gw.decide(
        make_cmd(tool="search", args={"q": "mcp"}, fields=("title",))
    )
    assert decision.verdict == "rewrite"
    assert decision.call is not None
    d = call_dict(decision)
    assert d["tool"] == "query"
    assert d["server"] == "slides"
    assert d["args"] == {"q": "mcp"}
    assert d["lease_id"] is None
    assert d["call_index"] == _seq["n"]


# ---------------------------------------------------------------------------
# 10. Reserve floor
# ---------------------------------------------------------------------------

def test_budget_floor_provenance_and_query_forward():
    gw = Gateway(make_ctx(credits=20))
    assert gw.decide(make_cmd(server="registry", tool="provenance")).verdict == "forward"
    assert gw.decide(make_cmd(server="slides", tool="query")).verdict == "forward"


def test_budget_floor_other_tools_denied():
    gw = Gateway(make_ctx(credits=20))
    decision = gw.decide(make_cmd(server="glossary", tool="define", args={"term": "mcp"}))
    assert decision.verdict == "deny"
    assert decision.call is None
    assert "reserve floor" in decision.reason


# ---------------------------------------------------------------------------
# 11. Robustness against adversarial arg values
# ---------------------------------------------------------------------------

def test_adversarial_args_return_decision_not_raise():
    gw = Gateway(make_ctx())
    d1 = gw.decide(make_cmd(args={"q": "mcp", "learner": 12345}))
    assert isinstance(d1, object) and d1.verdict in {"forward", "deny", "rewrite"}
    d2 = gw.decide(make_cmd(args={"q": {"nested": "dict"}}))
    assert d2.verdict in {"forward", "deny", "rewrite"}
    d3 = gw.decide(make_cmd(args={"learner": None, "note": 42}))
    assert d3.verdict in {"forward", "deny", "rewrite"}


# ---------------------------------------------------------------------------
# 12. Latency: every one of 200 sequential clean decides < 250 ms
# ---------------------------------------------------------------------------

def test_200_clean_decides_each_under_250ms():
    gw = Gateway(make_ctx())
    gw.note_card("curriculum-analyst", {"verified": True})
    for i in range(200):
        cmd = make_cmd(
            kind="a2a" if i % 2 else "mcp",
            server="curriculum-analyst" if i % 2 else "slides",
            tool="which_days_cover" if i % 2 else "query",
            args={"learner": ACT} if i % 2 else {"q": f"mcp-{i}"},
        )
        t0 = time.perf_counter()
        decision = gw.decide(cmd)
        elapsed = time.perf_counter() - t0
        assert decision.verdict in {"forward", "deny", "rewrite"}
        assert elapsed < 0.250, f"decide #{i} took {elapsed * 1000:.1f} ms"
