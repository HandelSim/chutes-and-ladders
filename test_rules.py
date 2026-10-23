"""Tests for rules.py: characters, abilities, jumpscare squares, minigame table.
Run: python3 -m unittest -v test_rules"""
import random
import re
import unittest
from pathlib import Path

import rules

HERE = Path(__file__).resolve().parent


class Fixed:
    """Stand-in for rules.RNG: every spin lands on v, no disaster ever strikes."""
    def __init__(self, v):
        self.v = v

    def randint(self, a, b):
        return self.v

    def random(self):
        return 0.99


def make_room(chars, positions, charges=1, specials=None):
    seats = [{"id": str(i), "char": c, "pos": p, "spins": 0, "ladders": 0, "chutes": 0,
              "charges": charges, "shield": 0} for i, (c, p) in enumerate(zip(chars, positions))]
    board = dict(rules.CLASSIC, boss=False,
                 specials=specials or {"lucky": [], "unlucky": [], "scare": []})
    return {"seats": seats, "current": 0, "turn": 0, "seq": 0, "round": 0, "status": "playing",
            "winner": None, "abilities": True, "miniEvery": 0, "board": board}


class WithRng(unittest.TestCase):
    def setUp(self):
        self._rng = rules.RNG
        rules.RNG = random.Random(7)

    def tearDown(self):
        rules.RNG = self._rng


class TestTables(unittest.TestCase):
    def test_every_character_has_a_known_ability(self):
        for cid, (kind, flavor) in rules.CHAR_AB.items():
            self.assertIn(kind, rules.ABILITIES, cid)
            self.assertTrue(flavor, cid)

    def test_chars_js_and_rules_agree(self):
        ids = re.findall(r'"id":"([a-z0-9-]+)"', (HERE / "static" / "chars.js").read_text())
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), set(rules.CHAR_AB))

    def test_every_ability_has_a_character(self):
        used = {kind for kind, _ in rules.CHAR_AB.values()}
        self.assertEqual(used, set(rules.ABILITIES))

    def test_minigames_exist_in_client_files(self):
        text = "".join(p.read_text() for p in (HERE / "static" / "minigames").glob("*.js"))
        ids = set(re.findall(r"id: '([a-z]+)',\s*\n\s*title:", text))
        self.assertEqual(ids, set(rules.MINIGAMES))

    def test_sim_scores_stay_in_range(self):
        for kind, m in rules.MINIGAMES.items():
            self.assertGreater(m["max"], m["mean"], kind)
            for _ in range(200):
                self.assertTrue(0 <= rules.sim_score(kind) <= m["max"], kind)


class TestAbilities(WithRng):
    def test_turbo_adds_bonus_to_one_spin(self):
        room = make_room(["toaster", "mario"], [72, 0])         # 75..80 holds no chute
        ev = rules.take_turn(room, use=True)
        spins = [s for s in ev["steps"] if s["t"] == "spin"]
        self.assertEqual(ev["ab"], "turbo")
        self.assertEqual(len(spins), 1)
        self.assertEqual(ev["roll"], spins[0]["v"] + rules.TURBO_BONUS)
        self.assertEqual(room["seats"][0]["charges"], 0)

    def test_thief_moves_a_charge(self):
        room = make_room(["sock", "mario"], [5, 5])
        room["seats"][0]["charges"] = 1
        room["seats"][1]["charges"] = 2
        ev = rules.take_turn(room, use=True)
        self.assertEqual(ev["ab"], "thief")
        self.assertEqual(room["seats"][0]["charges"], 1)
        self.assertEqual(room["seats"][1]["charges"], 1)
        self.assertEqual(ev["target"], "1")

    def test_thief_needs_a_victim(self):
        room = make_room(["sock", "mario"], [5, 5])
        room["seats"][1]["charges"] = 0
        with self.assertRaises(ValueError):
            rules.take_turn(room, use=True)

    def test_wild_card_plays_something_real(self):
        seen = set()
        for seed in range(300):
            rules.RNG = random.Random(seed)
            room = make_room(["michael-scott", "mario", "luigi"], [10, 20, 14])
            ev = rules.take_turn(room, use=True)
            self.assertNotIn(ev["ab"], (None, "wild", "pick"))
            self.assertIn(ev["ab"], rules.ABILITIES)
            self.assertEqual(sum(1 for s in ev["steps"] if s["t"] == "wild"), 1)
            self.assertLessEqual(room["seats"][0]["charges"], rules.MAX_CHARGES)
            seen.add(ev["ab"])
        self.assertGreaterEqual(len(seen), 4)

    def test_cpu_can_play_every_character(self):
        for cid in rules.CHAR_AB:
            room = make_room([cid, "mario", "luigi"], [10, 30, 12])
            for _ in range(6):
                if room["status"] != "playing":
                    break
                rules.take_turn(room, cpu=True)


class TestJumpscare(WithRng):
    def test_scare_square_sends_player_back(self):
        rules.RNG = Fixed(6)
        room = make_room(["mario", "luigi"], [24, 0], specials={"lucky": [], "unlucky": [], "scare": [30]})
        ev = rules.take_turn(room)
        self.assertEqual(ev["special"], "scare")
        self.assertEqual(room["seats"][0]["pos"], 30 - rules.SCARE_MOVE)
        self.assertTrue(any(s["t"] == "special" and s["do"] == "scare" for s in ev["steps"]))

    def test_specials_spawn_with_scare_squares(self):
        room = make_room(["mario", "luigi"], [0, 0])
        room["board"] = dict(rules.CLASSIC)
        rules.take_turn(room)
        sp = room["board"]["specials"]
        self.assertEqual(len(sp["scare"]), rules.SCARE_COUNT)
        marked = sp["lucky"] + sp["unlucky"] + sp["scare"]
        self.assertEqual(len(marked), len(set(marked)))

    def test_older_specials_without_scare_still_work(self):
        room = make_room(["mario", "luigi"], [0, 0], specials={"lucky": [3], "unlucky": [5]})
        self.assertEqual(rules.special_at(room, 3), "lucky")
        self.assertEqual(rules.special_at(room, 5), "unlucky")
        self.assertIsNone(rules.special_at(room, 6))


if __name__ == "__main__":
    unittest.main()
