#!/usr/bin/env python3
"""Balance simulator: computer players with random characters play many games using
the real rules engine; prints each ability's win rate (fair share = 1/players).

  python3 sim.py [games=20000] [players=4] [miniEvery=3] [seed=1]
"""
import random
import sys
from collections import Counter

import rules

KINDS = list(rules.ABILITIES)
RANDOM_BOARDS = False
import os
FORCE = os.environ.get("FORCE_KIND")
BY_KIND = {k: [c for c, (a, _) in rules.CHAR_AB.items() if a == k] for k in KINDS}


def play(players, mini_every, rng):
    kinds = [FORCE or rng.choice(KINDS) for _ in range(players)]
    room = {"seats": [{"id": str(i), "char": rng.choice(BY_KIND[k]), "pos": 0, "spins": 0, "ladders": 0, "chutes": 0,
                       "charges": rules.START_CHARGES, "shield": False} for i, k in enumerate(kinds)],
            "current": 0, "turn": 0, "seq": 0, "round": 0, "status": "playing", "winner": None,
            "abilities": True, "miniEvery": mini_every,
            "board": rules.random_board(rng.getrandbits(32)) if RANDOM_BOARDS else rules.CLASSIC}
    uses, minis = Counter(), 0
    while room["status"] == "playing" and room["turn"] < 4000:
        ev = rules.take_turn(room, cpu=True)
        if ev["ab"]:
            uses[ev["ab"]] += 1
        if ev.get("mini") and room["status"] == "playing":
            room["mini"] = {"kind": rules.pick_minigame(room)}
            minis += 1
            rules.resolve_mini(room, {s["id"]: rules.sim_score(room["mini"]["kind"]) for s in room["seats"]})
    if room["winner"] is None:
        raise RuntimeError(f"stalled game: {room['board']} {[(s['char'], s['pos']) for s in room['seats']]}")
    win = next(i for i, s in enumerate(room["seats"]) if s["id"] == room["winner"])
    return kinds, win, room["turn"], uses, minis


def main():
    import os
    for k, v in os.environ.items():           # R_PICK_MAX=3 etc. override rules constants
        if k.startswith("R_") and hasattr(rules, k[2:]):
            setattr(rules, k[2:], type(getattr(rules, k[2:]))(float(v)) if not isinstance(getattr(rules, k[2:]), int) else int(v))
    global RANDOM_BOARDS
    RANDOM_BOARDS = os.environ.get("RANDOM_BOARDS") == "1"
    a = sys.argv[1:] + [None] * 4
    games, players = int(a[0] or 20000), int(a[1] or 4)
    mini_every, seed = int(a[2] if a[2] is not None else 3), int(a[3] or 1)
    rules.RNG = random.Random(seed)
    rng = random.Random(seed + 1)
    seats, wins, uses_all, turns, minis = Counter(), Counter(), Counter(), 0, 0
    lengths = []
    for _ in range(games):
        kinds, win, t, uses, m = play(players, mini_every, rng)
        seats.update(kinds)
        wins[kinds[win]] += 1
        uses_all.update(uses)
        turns += t
        lengths.append(t / players)
        minis += m
    fair = 1 / players
    print(f"{games} games, {players} players, minigame every {mini_every} rounds: "
          f"{turns / games / players:.1f} turns per player, {minis / games:.1f} minigames per game")
    lengths.sort()
    print("  turns/player p50 %.0f p90 %.0f p99 %.0f max %.0f" % (tuple(lengths[int(len(lengths) * q)] for q in (.5, .9, .99)) + (lengths[-1],)))
    for k in KINDS:
        if not seats[k]:
            continue
        wr = wins[k] / seats[k]
        print(f"  {k:7s} win {wr:6.1%} ({wr / fair:5.2f}x fair)  uses/game-seat {uses_all[k] / seats[k]:.2f}")


if __name__ == "__main__":
    main()
