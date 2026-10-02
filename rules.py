"""Chutes & Ladders rules engine: board, abilities, minigame scoring.

Pure game logic with no I/O, so server.py and sim.py (the balance simulator) run the
exact same rules. Every mutation happens on a plain-dict room; every visible change is
recorded as an animation "step" on the event so clients can replay it.

Steps (client animates them in order):
  {"t":"ability","seat","ab"}              ability banner
  {"t":"spin","seat","v","dim"?}           spinner lands on v (dim = the discarded lucky roll)
  {"t":"move","seat","from","to"}          hop square by square (either direction)
  {"t":"ladder"|"chute","seat","from","to"}
  {"t":"shield","seat","at"}               a shield ate the chute at square `at`
  {"t":"bounce","seat"}                    overshot 100, stays put
  {"t":"swap","a","b","apos","bpos"}       a and b trade squares (positions after the swap)
  {"t":"charge","seat","n","why"}          seat now holds n ability charges
"""
import random

LADDERS = {1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100}
CHUTES = {16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78}
CLASSIC = {"kind": "classic", "ladders": sorted(map(list, LADDERS.items())), "chutes": sorted(map(list, CHUTES.items()))}

RNG = random.SystemRandom()          # sim.py swaps in a seeded random.Random

# ---------- abilities ----------
# Every character gets one of six archetypes under its own flavor name. One charge per
# use; you start with START_CHARGES, earn one by sliding down a chute (comeback) and one
# for winning a minigame, and hold at most MAX_CHARGES. Tuned with sim.py so every
# archetype wins about the same share of games.
START_CHARGES = 1
MAX_CHARGES = 2
QUAKE_BACK = 10         # squares a quake knocks back each player ahead of you
QUAKE_AHEAD = 1         # 1 = quake only hits players ahead of you
QUAKE_RESOLVE = 0       # 1 = a knocked-back player also takes the chute/ladder they land on
LUCKY_SPINS = 3         # spins to choose the best from
PICK_MAX = 3            # pick any number 1..PICK_MAX
PICK_COST = 2           # charges a Pick costs
SWAP_RANGE = 18         # max squares ahead the swap target may be (0 = any)
SHIELD_HITS = 1         # chutes a raised shield blocks
OVERTIME_ROUND = 50     # from this round on abilities are off, so every game ends (0 = never)
ABILITIES = {
    "boost":  {"label": "Double Spin", "icon": "⏩", "desc": "Spin twice and move the total."},
    "lucky":  {"label": "Lucky Spin", "icon": "🍀", "desc": f"Spin {LUCKY_SPINS} times and keep the best result."},
    "pick":   {"label": "Pick a Number", "icon": "🎯", "desc": f"Costs {PICK_COST} charges: choose your spin, 1 to {PICK_MAX}."},
    "shield": {"label": "Chute Shield", "icon": "🛡️", "desc": "The next chute you land on does nothing. Then spin."},
    "swap":   {"label": "Swap", "icon": "🔄", "desc": f"Trade places with the nearest player ahead (up to {SWAP_RANGE} squares), instead of spinning."},
    "quake":  {"label": "Quake", "icon": "💥", "desc": f"Everyone ahead of you drops back up to {QUAKE_BACK} squares, never behind you. Then you spin."},
}
CHAR_AB = {
    # Double Spin
    "mario": ("boost", "Super Jump"), "sonic": ("boost", "Spin Dash"), "fox": ("boost", "Arwing Boost"),
    "buzz-lightyear": ("boost", "To Infinity"), "mega-man": ("boost", "Rush Jet"), "optimus-prime": ("boost", "Roll Out"),
    "spider-man": ("boost", "Web Swing"), "pac-man": ("boost", "Power Pellet"),
    # Lucky Spin
    "luigi": ("lucky", "Second Try"), "peach": ("lucky", "Royal Fortune"), "toad": ("lucky", "Lucky Mushroom"),
    "isabelle": ("lucky", "Good Fortune"), "villager": ("lucky", "Fortune Cookie"), "scooby-doo": ("lucky", "Scooby Snack"),
    "garfield": ("lucky", "Lasagna Luck"), "patrick-star": ("lucky", "Dumb Luck"),
    # Pick a Number
    "link": ("pick", "Hero's Aim"), "samus": ("pick", "Lock-On"), "yoda": ("pick", "Foresight"),
    "snake": ("pick", "Recon"), "batman": ("pick", "Detective Mode"), "sora": ("pick", "Keyblade Guide"),
    "meta-knight": ("pick", "Dimensional Cape"), "ryu": ("pick", "Focus"),
    # Chute Shield
    "yoshi": ("shield", "Flutter Jump"), "kirby": ("shield", "Stone Form"), "steve": ("shield", "Build a Bridge"),
    "r2-d2": ("shield", "Deflector"), "groot": ("shield", "Branch Out"), "woody": ("shield", "Sheriff's Badge"),
    "inkling": ("shield", "Ink Armor"), "olaf": ("shield", "Ice Bridge"),
    # Swap
    "darth-vader": ("swap", "Force Pull"), "grogu": ("swap", "Force Grab"), "stitch": ("swap", "Mischief"),
    "mickey-mouse": ("swap", "Magic Trick"), "pikachu": ("swap", "Quick Attack"), "minion": ("swap", "Banana Swap"),
    "homer-simpson": ("swap", "Donut Heist"),
    # Quake
    "bowser": ("quake", "Ground Pound"), "donkey-kong": ("quake", "Hand Slap"), "charizard": ("quake", "Flamethrower"),
    "shrek": ("quake", "Ogre Roar"), "spongebob": ("quake", "Bubble Blast"), "kermit": ("quake", "Showstopper"),
}


def cost_of(kind):
    return PICK_COST if kind == "pick" else 1


def quake_targets(room, seat):
    return [s for s in room["seats"] if s is not seat and s["pos"] > 0 and not s.get("steady")
            and (not QUAKE_AHEAD or s["pos"] > seat["pos"])]


def ab_of(seat):
    return CHAR_AB.get(seat["char"], ("boost", "Boost"))[0]


# ---------- minigames ----------
# max = server clamp; mean/sd = simulated score for computer players (casual human).
MINIGAMES = {
    "needle":    {"max": 500, "mean": 295, "sd": 85},
    "quickdraw": {"max": 1000, "mean": 590, "sd": 150},
    "memory":    {"max": 300, "mean": 135, "sd": 50},
    "headcount": {"max": 450, "mean": 225, "sd": 80},
    "gamble":    {"max": 100, "mean": 54, "sd": 20},
    "dodge":     {"max": 180, "mean": 104, "sd": 31},
}
MINI_PLAY = 15            # seconds of play per game
MINI_INTRO = 7            # seconds of rules + countdown before play starts (online)
MINI_GRACE = 8            # network/animation slack after play
MINI_REWARD = [3, 2, 1]   # squares for 1st, 2nd, 3rd. Last place never moves.


def sim_score(kind):
    m = MINIGAMES[kind]
    return int(max(0, min(m["max"], RNG.gauss(m["mean"], m["sd"]))))


# ---------- movement ----------
def board_of(room):
    b = room.get("board") or CLASSIC
    return {int(a): int(z) for a, z in b["ladders"]}, {int(a): int(z) for a, z in b["chutes"]}


def outcome(pos, roll, shield, bd):
    """Final square after moving `roll` from `pos` (no side effects)."""
    lad, chu = bd
    land = pos + roll
    if land > 100:
        return pos
    if land in lad:
        return lad[land]
    if land in chu and not shield:
        return chu[land]
    return land


CHUTE_CHARGE = 1        # 1 = sliding down a chute earns a charge (comeback)


def gain_charge(room, seat, steps, why):
    if why == "chute" and not CHUTE_CHARGE:
        return
    if room.get("abilities", True) and seat["charges"] < MAX_CHARGES:
        seat["charges"] += 1
        steps.append({"t": "charge", "seat": seat["id"], "n": seat["charges"], "why": why})


def after_land(room, seat, steps):
    p = seat["pos"]
    LADDERS, CHUTES = board_of(room)
    if p in LADDERS:
        steps.append({"t": "ladder", "seat": seat["id"], "from": p, "to": LADDERS[p]})
        seat["pos"] = LADDERS[p]
        seat["ladders"] += 1
        return "ladder"
    if p in CHUTES:
        if seat.get("shield"):
            seat["shield"] = int(seat["shield"]) - 1
            steps.append({"t": "shield", "seat": seat["id"], "at": p})
            return "shield"
        steps.append({"t": "chute", "seat": seat["id"], "from": p, "to": CHUTES[p]})
        seat["pos"] = CHUTES[p]
        seat["chutes"] += 1
        gain_charge(room, seat, steps, "chute")
        return "chute"
    return None


def move_by(room, seat, n, steps, resolve=True):
    """Move n squares (negative = backwards), then resolve ladders/chutes (unless
    resolve is False). Overshooting 100 bounces (stay put); backwards stops at square 1."""
    frm = seat["pos"]
    dest = frm + n
    if dest > 100:
        steps.append({"t": "bounce", "seat": seat["id"]})
        return "bounce"
    dest = max(1, dest)
    if dest == frm:
        return None
    steps.append({"t": "move", "seat": seat["id"], "from": frm, "to": dest})
    seat["pos"] = dest
    return after_land(room, seat, steps) if resolve else None


def ahead_of(room, seat):
    """The nearest player strictly ahead (the swap target), or None."""
    ahead = [s for s in room["seats"] if s["pos"] > seat["pos"] and s is not seat
             and (not SWAP_RANGE or s["pos"] - seat["pos"] <= SWAP_RANGE)]
    return min(ahead, key=lambda s: s["pos"]) if ahead else None


def overtime(room):
    return bool(OVERTIME_ROUND) and room.get("round", 0) >= OVERTIME_ROUND


def ability_problem(room, seat, kind):
    """Why the ability cannot be used right now, or None."""
    if not room.get("abilities", True):
        return "Abilities are off in this game."
    if overtime(room):
        return f"Overtime: abilities are off after round {OVERTIME_ROUND}."
    if seat["charges"] < cost_of(kind):
        return ("No ability charges left." if seat["charges"] <= 0 else f"This ability needs {cost_of(kind)} charges.") + \
            " Slide down a chute or win a minigame to earn one."
    if kind == "shield" and seat.get("shield"):
        return "Your shield is already up."
    if kind == "swap" and not ahead_of(room, seat):
        return "Nobody is ahead of you to swap with."
    if kind == "quake" and not quake_targets(room, seat):
        return "Nobody ahead of you to knock back." if QUAKE_AHEAD else "Nobody else is on the board yet."
    return None


def _mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs)


T = {"pick": 6, "boost": 4.5, "lucky": 5, "swap": 9, "quake": 7}
LUCKY_T = 5


def cpu_choice(room, seat):
    """Computer player's decision: (use_ability, pick). Also used for auto-spins."""
    kind = ab_of(seat)
    if ability_problem(room, seat, kind):
        return False, None
    pos, sh = seat["pos"], seat.get("shield", False)
    bd = board_of(room)
    normal = _mean(outcome(pos, r, sh, bd) for r in range(1, 7))
    if kind == "pick":
        best = max(range(1, PICK_MAX + 1), key=lambda r: (outcome(pos, r, sh, bd), r))
        b = outcome(pos, best, sh, bd)
        return (b == 100 or b - normal >= T["pick"]), best
    if kind == "boost":
        ev = _mean(outcome(pos, a + b, sh, bd) for a in range(1, 7) for b in range(1, 7))
        return ev - normal >= T["boost"], None
    if kind == "lucky":
        ev = _mean(max(outcome(pos, a, sh, bd), outcome(pos, b, sh, bd)) for a in range(1, 7) for b in range(1, 7))
        return ev - normal >= LUCKY_T, None
    if kind == "shield":
        return any(pos + r in bd[1] for r in range(1, 7)), None
    if kind == "swap":
        t = ahead_of(room, seat)
        return t["pos"] - normal >= T["swap"], None
    if kind == "quake":
        lead = max(s["pos"] for s in room["seats"] if s is not seat)
        hurt = 0
        for s in quake_targets(room, seat):
            after = _back(seat, s, bd)
            w = 1.5 if s["pos"] == lead else (1.0 if s["pos"] >= pos else 0.4)
            hurt += (s["pos"] - after) * w
        return hurt >= T["quake"], None
    return False, None


def quake_dest(quaker, s):
    """Knocked back QUAKE_BACK squares, but never behind the quaker (no endless quake wars)."""
    return max(1, quaker["pos"], s["pos"] - QUAKE_BACK)


def _back(quaker, s, bd):
    d = quake_dest(quaker, s)
    return outcome(d, 0, s.get("shield"), bd) if QUAKE_RESOLVE else d


def take_turn(room, use=False, pick=None, auto=False, cpu=False):
    """Play the current seat's turn. Returns the event. Raises ValueError(msg) for an
    ability that cannot be used (only for human requests; computer turns just skip it)."""
    seat = room["seats"][room["current"]]
    kind = ab_of(seat)
    if cpu:
        use, pick = cpu_choice(room, seat)
    if use:
        why = ability_problem(room, seat, kind)
        if why:
            raise ValueError(why)
        if kind == "pick":
            if not isinstance(pick, int) or not 1 <= pick <= PICK_MAX:
                raise ValueError(f"Pick a number from 1 to {PICK_MAX}.")
        seat["charges"] -= cost_of(kind)
    room["seq"] = room.get("seq", room["turn"]) + 1
    room["turn"] += 1
    steps = []
    ev = {"n": room["seq"], "kind": "turn", "turn": room["turn"], "seat": seat["id"], "from": seat["pos"],
          "auto": auto, "ab": kind if use else None, "steps": steps}
    if use:
        steps.append({"t": "ability", "seat": seat["id"], "ab": kind})
    if use and kind == "swap":
        t = ahead_of(room, seat)
        seat["pos"], t["pos"] = t["pos"], seat["pos"]
        steps.append({"t": "swap", "a": seat["id"], "b": t["id"], "apos": seat["pos"], "bpos": t["pos"]})
        ev["target"] = t["id"]
    else:
        if use and kind == "quake":
            for s in quake_targets(room, seat):
                move_by(room, s, quake_dest(seat, s) - s["pos"], steps, resolve=bool(QUAKE_RESOLVE))
                s["steady"] = True                  # immune to quakes until after their next turn
        if use and kind == "shield":
            seat["shield"] = SHIELD_HITS
        if use and kind in ("boost", "lucky"):
            a, b = RNG.randint(1, 6), RNG.randint(1, 6)
            if kind == "boost":
                steps += [{"t": "spin", "seat": seat["id"], "v": a}, {"t": "spin", "seat": seat["id"], "v": b}]
                roll = a + b
            else:
                sh = seat.get("shield", False)
                rolls = [a, b] + [RNG.randint(1, 6) for _ in range(LUCKY_SPINS - 2)]
                keep = max(rolls, key=lambda r: (outcome(seat["pos"], r, sh, board_of(room)), r))
                ki = rolls.index(keep)
                steps += [{"t": "spin", "seat": seat["id"], "v": r, "dim": i != ki} for i, r in enumerate(rolls)]
                steps.append({"t": "spin", "seat": seat["id"], "v": keep, "keep": True})
                ev["rolls"] = rolls
                roll = keep
        elif use and kind == "pick":
            roll = pick
            steps.append({"t": "spin", "seat": seat["id"], "v": roll, "picked": True})
        else:
            roll = RNG.randint(1, 6)
            steps.append({"t": "spin", "seat": seat["id"], "v": roll})
        ev["roll"] = roll
        before = seat["pos"]
        ev["via"] = move_by(room, seat, roll, steps)
        ev["land"] = before + roll if before + roll <= 100 else before
    ev["to"] = seat["pos"]
    seat["spins"] += 1
    seat["steady"] = False
    if seat["pos"] == 100:
        room["status"] = "over"
        room["winner"] = seat["id"]
        return ev
    room["current"] = (room["current"] + 1) % len(room["seats"])
    if room["current"] == 0:
        room["round"] = room.get("round", 0) + 1
        every = room.get("miniEvery", 0)
        if every and len(room["seats"]) >= 2 and room["round"] % every == 0:
            ev["mini"] = True                       # caller starts the minigame
    return ev


def pick_minigame(room):
    recent = room.get("miniRecent", [])
    options = [k for k in MINIGAMES if k not in recent[-3:]] or list(MINIGAMES)
    kind = RNG.choice(options)
    room["miniRecent"] = (recent + [kind])[-5:]
    return kind


def resolve_mini(room, scores):
    """Rank everyone by score and pay out. scores: seat_id -> int, or None if absent.
    Ties share a place. Last place (a strictly lowest score) never moves.
    Returns the event."""
    seats = room["seats"]
    vals = {s["id"]: (scores.get(s["id"]) if scores.get(s["id"]) is not None else -1) for s in seats}
    order = sorted(seats, key=lambda s: -vals[s["id"]])
    lowest = min(vals.values())
    all_tied = len(set(vals.values())) == 1
    results, steps = [], []
    room["seq"] = room.get("seq", room["turn"]) + 1
    ev = {"n": room["seq"], "kind": "mini", "turn": room["turn"], "game": room.get("mini", {}).get("kind"),
          "results": results, "steps": steps}
    for s in order:
        rank = sum(1 for v in vals.values() if v > vals[s["id"]])
        absent = scores.get(s["id"]) is None
        last = (vals[s["id"]] == lowest and not all_tied) or absent
        moves = 0 if last or rank >= len(MINI_REWARD) else MINI_REWARD[rank]
        results.append({"seat": s["id"], "score": max(0, vals[s["id"]]), "rank": rank + 1,
                        "moves": moves, "absent": absent, "charge": rank == 0 and not absent and not all_tied})
    for r in results:                               # pay out in finishing order
        s = next(x for x in seats if x["id"] == r["seat"])
        if r["charge"]:
            gain_charge(room, s, steps, "minigame")
        if r["moves"]:
            move_by(room, s, r["moves"], steps)
        if s["pos"] == 100 and room["status"] != "over":
            room["status"] = "over"
            room["winner"] = s["id"]
    room["mini"] = None
    return ev


# ---------- random boards ----------
def expected_spins(ladders, chutes):
    """Expected spins for one player to finish (exact-100 rule), by value iteration."""
    E = [0.0] * 101
    for _ in range(3000):
        prev = E[0]
        for s in range(99, -1, -1):
            tot, stay = 0.0, 0
            for r in range(1, 7):
                n = s + r
                if n > 100:
                    stay += 1
                    continue
                n = ladders.get(n, chutes.get(n, n))
                tot += E[n]
            E[s] = (6 + tot) / (6 - stay)
        if abs(E[0] - prev) < 1e-4:
            return E[0]
    return float("inf")                     # does not converge: some squares trap you


def _row(n):
    return (n - 1) // 10


def random_board(seed=None, lo=30.0, hi=46.0):
    """A fresh, fair-feeling layout: 7-10 ladders, 8-11 chutes, every feature spans at
    least one row, no square is used twice, no chute in the first row, at most three
    feature starts per row, and a single-player game lasts lo..hi spins on average
    (classic is ~39)."""
    rng = random.Random(seed if seed is not None else RNG.getrandbits(32))
    for _ in range(400):
        used, per_row, lad, chu = {100}, {}, {}, {}

        def ok(a, z):
            return (a not in used and z not in used and _row(a) != _row(z)
                    and per_row.get(_row(a), 0) < 3)

        def take(a, z):
            used.update((a, z))
            per_row[_row(a)] = per_row.get(_row(a), 0) + 1

        for _ in range(rng.randint(7, 10)):
            for _ in range(50):
                a = rng.randint(1, 85)
                z = min(100, a + rng.randint(11, 44))
                if ok(a, z) and not (z == 100 and 100 in lad.values()):
                    lad[a] = z
                    take(a, z)
                    if z == 100:
                        used.discard(100)
                    break
        for _ in range(rng.randint(8, 11)):
            for _ in range(50):
                a = rng.randint(11, 99)
                z = max(1, a - rng.randint(11, 58))
                if ok(a, z):
                    chu[a] = z
                    take(a, z)
                    break
        used.add(100)
        if len(lad) < 7 or len(chu) < 8:
            continue
        e = expected_spins(lad, chu)
        if lo <= e <= hi:
            return {"kind": "random", "ladders": sorted(map(list, lad.items())),
                    "chutes": sorted(map(list, chu.items())), "expect": round(e, 1)}
    return dict(CLASSIC)


def valid_board(b):
    """Sanity check a board a client sends back (solo games)."""
    try:
        lad = {int(a): int(z) for a, z in b["ladders"]}
        chu = {int(a): int(z) for a, z in b["chutes"]}
    except (KeyError, TypeError, ValueError):
        return None
    pts = list(lad) + list(lad.values()) + list(chu) + list(chu.values())
    if not (3 <= len(lad) <= 12 and 3 <= len(chu) <= 12):
        return None
    if any(z <= a for a, z in lad.items()) or any(z >= a for a, z in chu.items()):
        return None
    if 100 in lad or 100 in chu or len(set(lad) | set(chu)) != len(lad) + len(chu):
        return None
    if set(lad) & set(lad.values()) or set(chu) & set(chu.values()) or set(lad) & set(chu.values()) or set(chu) & set(lad.values()):
        return None
    if any(not 1 <= p <= 100 for p in pts):
        return None
    return {"kind": b.get("kind") if b.get("kind") in ("classic", "random") else "random",
            "ladders": sorted([a, z] for a, z in lad.items()), "chutes": sorted([a, z] for a, z in chu.items())}
