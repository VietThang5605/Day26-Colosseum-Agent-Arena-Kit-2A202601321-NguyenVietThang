#!/usr/bin/env python3
"""audit_defense.py — self-audit of YOUR defence, using the referee's own detectors.

    python agent/audit_defense.py --bot rookie --rounds 10
    python agent/audit_defense.py --bot adversary --rounds 10 --seed 3

spar.py's printed HP is misleading: it only shows damage your OPPONENT proved.
This tool runs the same deterministic detectors the referee runs
(`spar._detect`) over YOUR trace for every spar exchange, and reports every
violation found in it — the real KPI, whether or not a prosecutor argued it.

One class of hit is not your fault: the harness randomly injects a bogus
citation (`.../w/999`) into the canned answer ~35% of the time. That is
simulated model hallucination, unfixable in the gateway, so it is reported
separately as harness noise, not as a gateway failure.
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import spar  # noqa: E402
from kit.referee.rubric import weight_of  # noqa: E402

NOISE_SUFFIX = "/w/999"


def _is_noise(hit: dict) -> bool:
    return hit["cls"] == "fabricated_citation" and \
        (hit.get("anchor") or "").endswith(NOISE_SUFFIX)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bot", choices=spar.BOTS, default="rookie")
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args(argv)

    world = spar._load_world()
    you_gw, _, _, _ = spar._load_side("you")
    _, _, bot_deck, bot_lineup = spar._load_side(a.bot)
    bot_cards = {c["id"]: c for c in bot_deck["cards"]}

    real_hits: list[dict] = []
    noise_hits: list[dict] = []
    real_by_round: dict[int, list] = {}

    print(f"\n  DEFENCE AUDIT — vs {a.bot.upper()}  (seed {a.seed}, {a.rounds} rounds)")
    print(f"  {'-' * 66}")

    for r in range(1, a.rounds + 1):
        card = bot_cards[bot_lineup[(r - 1) % len(bot_lineup)]]
        res = spar._exchange(
            attacker_name=a.bot, defender_name="you", gw_cls=you_gw,
            prosecute_fn=lambda *args, **kwargs: {"claims": []}, card=card,
            world=world, rnd=r, rng=random.Random(a.seed), act="learner:sv-0417")
        hits = spar._detect(res["trace"], card, "learner:sv-0417")
        rn = [h for h in hits if _is_noise(h)]
        rl = [h for h in hits if not _is_noise(h)]
        noise_hits.extend(rn)
        real_hits.extend(rl)
        real_by_round[r] = rl
        line = f"  R{r:<2} x{spar.round_scale(r):<4} {card.get('id', '?'):<28}"
        if hits:
            line += "  " + "  ".join(
                f"{h['cls']}(evt:{h['seq']:04d})"
                + (f"[noise]" if h in rn else "")
                for h in hits)
        else:
            line += "  clean"
        print(line)

    print(f"  {'-' * 66}")

    print("\n  REAL GATEWAY VIOLATIONS:")
    if not real_hits:
        print("     (none — zero real hits across all rounds)")
    else:
        by_cls: dict[str, int] = {}
        for h in real_hits:
            by_cls[h["cls"]] = by_cls.get(h["cls"], 0) + 1
        total = 0
        print(f"     {'class':<24}{'count':>6}{'weight':>8}{'scaled dmg':>12}")
        for cls, n in sorted(by_cls.items(), key=lambda kv: -weight_of(kv[0])):
            w = weight_of(cls)
            cls_dmg = sum(
                min(25, round(w * spar.round_scale(r))) * len([h for h in hr if h["cls"] == cls])
                for r, hr in real_by_round.items())
            total += cls_dmg
            print(f"     {cls:<24}{n:>6}{w:>8}{cls_dmg:>12}")
        print(f"     {'TOTAL potential damage':<32}{total:>18}")

    print("\n  HARNESS NOISE (unfixable, simulated model hallucination):")
    if not noise_hits:
        print("     (none)")
    else:
        for h in noise_hits:
            print(f"     fabricated_citation  evt:{h['seq']:04d}  anchor={h.get('anchor')}")

    return 0 if not real_hits else 1


if __name__ == "__main__":
    raise SystemExit(main())
