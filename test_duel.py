"""Tests for the server side of duels: modes, who may post what, the in-memory relay,
deadlines, the queued minigame, old rooms. In-process (no sockets); the data dir is a
throwaway temp dir. Run: python3 -m unittest -v test_duel"""
import os
import random
import tempfile
import threading
import time
import unittest

os.environ["CHUTES_DATA_DIR"] = tempfile.mkdtemp(prefix="chutes-duel-test-")
import rules    # noqa: E402
import server   # noqa: E402

HOST, GUEST, SPY = "a" * 32, "b" * 32, "c" * 32


class Fixed:
    """rules.RNG stand-in: every spin lands on v, no disasters, first pick, coin says "a"."""
    def __init__(self, v):
        self.v = v

    def randint(self, a, b):
        return self.v

    def random(self):
        return 0.3                                  # >= DISASTER_CHANCE, < 0.5

    def getrandbits(self, n):
        return 1

    def gauss(self, mean, sd):
        return mean

    def choice(self, xs):
        return xs[0]

    def sample(self, xs, n):
        return list(xs)[:n]


def online(cpu_guest=False, cpu_host=False, mini_every=0):
    """Online room: host + guest on their own devices, host at 10, guest at 13, host to move."""
    room = server.new_room("QWERT", HOST)
    server.act(room, "join", HOST, {"char": "mario"})
    server.act(room, "join", GUEST, {"char": "luigi"})
    server.act(room, "settings", HOST, {"miniEvery": mini_every})
    server.act(room, "start", HOST, {})
    room["board"] = dict(rules.CLASSIC, boss=False, specials={"lucky": [], "unlucky": [], "scare": []})
    a, d = room["seats"]
    a["pos"], d["pos"], a["cpu"], d["cpu"] = 10, 13, cpu_host, cpu_guest
    a["charges"] = d["charges"] = 0                 # CPU movers never boost past the rival
    room["readyAt"] = 0
    server.rooms[room["code"]] = room
    return room


def solo(cpu=(True, True)):
    body = {"seats": [{"char": "mario", "cpu": cpu[0]}, {"char": "luigi", "cpu": cpu[1]}], "miniEvery": 0}
    room = server.new_room("ZXCVB", HOST, solo=True)
    server.act(room, "start", HOST, body)
    room["board"] = dict(rules.CLASSIC, boss=False, specials={"lucky": [], "unlucky": [], "scare": []})
    room["seats"][0]["pos"], room["seats"][1]["pos"] = 10, 13
    room["seats"][0]["charges"] = room["seats"][1]["charges"] = 0
    server.rooms[room["code"]] = room
    return room


def spin(room, client=HOST):
    server.act(room, "spin", client, {})
    return room["duel"]


class Base(unittest.TestCase):
    def setUp(self):
        self._rng = rules.RNG
        rules.RNG = Fixed(3)
        server.relays.clear()
        self._min, server.DUEL_MIN = server.DUEL_MIN, -10 ** 9   # tests end fights at once

    def tearDown(self):
        rules.RNG = self._rng
        server.DUEL_MIN = self._min
        server.rooms.clear()
        server.relays.clear()

    def err(self, status, fn, *args, **kw):
        with self.assertRaises(server.Err) as c:
            fn(*args, **kw)
        self.assertEqual(c.exception.status, status, c.exception.msg)


class TestStage(Base):
    def test_modes(self):
        self.assertEqual(spin(online(cpu_guest=True, cpu_host=True))["mode"], "show")
        self.assertEqual(spin(online(cpu_guest=True))["mode"], "local")
        du = spin(online())
        self.assertEqual((du["mode"], du["runner"], du["remote"]), ("net", HOST, GUEST))
        room = online()
        room["seats"][1]["owner"] = HOST                    # two humans sharing one device
        self.assertEqual(spin(room)["mode"], "local")
        self.assertEqual(spin(solo((False, False)))["mode"], "local")

    def test_show_winner_and_deadlines(self):
        du = spin(online(cpu_guest=True, cpu_host=True))
        self.assertIn(du["winner"], ("a", "d"))
        self.assertAlmostEqual(du["deadline"] - du["startAt"], rules.DUEL_SHOW)
        du = spin(online())
        self.assertIsNone(du["winner"])
        self.assertAlmostEqual(du["deadline"] - du["startAt"], rules.DUEL_MAX + rules.DUEL_GRACE)
        du = spin(solo())
        self.assertAlmostEqual(du["deadline"] - du["startAt"], server.DUEL_SOLO_SHOW)
        du = spin(solo((False, True)))
        self.assertAlmostEqual(du["deadline"] - du["startAt"], server.DUEL_SOLO_MAX)

    def test_duel_starts_after_the_landing_animation(self):
        room = online()
        du = spin(room)
        self.assertEqual(du["startAt"], room["readyAt"])
        self.assertGreater(du["startAt"], time.time())

    def test_turn_blocked_and_cpu_not_played_during_duel(self):
        room = online(cpu_guest=True)
        spin(room)
        self.err(409, server.act, room, "spin", GUEST, {})
        room["readyAt"] = 0
        turn = room["turn"]
        self.assertFalse(server.tick(room))
        self.assertEqual(room["turn"], turn)

    def test_duels_off(self):
        room = online()
        room["duels"] = False
        self.assertIsNone(spin(room))
        self.assertEqual(room["seats"][0]["pos"], 13)

    def test_view_hides_client_ids(self):
        room = online()
        spin(room)
        v = server.view(room, HOST)["duel"]
        self.assertEqual((v["runner"], v["remote"]), (True, False))
        self.assertEqual(server.view(room, GUEST)["duel"]["remote"], True)
        self.assertEqual(set(v), {"id", "a", "d", "mode", "seed", "startAt", "deadline", "winner",
                                  "runner", "remote", "miniNext"})
        import json
        text = json.dumps(server.view(room, SPY))
        self.assertNotIn(HOST, text)
        self.assertNotIn(GUEST, text)


class TestEnd(Base):
    def test_no_result_before_a_fight_could_happen(self):
        server.DUEL_MIN = 6
        room = online(cpu_guest=True)
        du = spin(room)
        self.err(409, server.act, room, "duelend", HOST, {"id": du["id"], "winner": "a"})
        du["startAt"] = time.time() - 6
        server.act(room, "duelend", HOST, {"id": du["id"], "winner": "a", "rw": [0, 2]})
        self.assertNotIn("rounds", room["events"][-1])      # rounds that contradict the winner are dropped

    def test_cpu_toggle_keeps_the_cap_and_the_show_winner(self):
        room = online(cpu_guest=True, cpu_host=True)
        du = spin(room)
        for _ in range(3):
            server.act(room, "cpu", HOST, {"seat": du["a"], "cpu": False})
            server.act(room, "cpu", HOST, {"seat": du["a"], "cpu": True})
        self.assertEqual(room["duel"]["winner"], du["winner"])
        self.assertLessEqual(room["duel"]["deadline"], du["cap"])

    def test_frame_with_nan_is_refused(self):
        room = online(cpu_guest=True)
        du = spin(room)
        self.err(400, server.relay_post, room, "duelframe", HOST, {"id": du["id"], "seq": 1, "f": {"x": float("nan")}})

    def test_runner_ends_it_once(self):
        room = online(cpu_guest=True)
        du = spin(room)
        self.err(403, server.act, room, "duelend", GUEST, {"id": du["id"], "winner": "a"})
        self.err(403, server.act, room, "duelend", SPY, {"id": du["id"], "winner": "a"})
        self.err(400, server.act, room, "duelend", HOST, {"id": du["id"], "winner": "x"})
        self.err(400, server.act, room, "duelend", HOST, {"id": du["id"], "winner": ["a"]})
        self.err(409, server.act, room, "duelend", HOST, {"id": "nope", "winner": "a"})
        v = room["v"]
        server.act(room, "duelend", HOST, {"id": du["id"], "winner": "d", "rw": [1, 2]})
        self.assertIsNone(room["duel"])
        self.assertEqual(room["v"], v + 1)
        ev = room["events"][-1]
        self.assertEqual((ev["kind"], ev["winner"], ev["loser"], ev["how"], ev["rounds"]),
                         ("duel", room["seats"][1]["id"], room["seats"][0]["id"], "fight", [1, 2]))
        self.assertEqual(room["seats"][0]["pos"], 13 - rules.DUEL_KNOCK)
        server.act(room, "duelend", HOST, {"id": du["id"], "winner": "a"})     # retry: no-op
        self.assertEqual(len([e for e in room["events"] if e["kind"] == "duel"]), 1)
        self.assertEqual(room["seats"][0]["pos"], 13 - rules.DUEL_KNOCK)

    def test_online_show_ends_by_itself(self):
        room = online(cpu_guest=True, cpu_host=True)
        du = spin(room)
        self.err(409, server.act, room, "duelend", HOST, {"id": du["id"], "winner": "a"})
        self.assertFalse(server.tick(room))
        self.assertIsNotNone(room["duel"])
        du["deadline"] = time.time() - 1
        self.assertTrue(server.tick(room))
        ev = room["events"][-1]
        self.assertEqual((ev["how"], ev["winner"]), ("show", du[du["winner"]]))
        self.assertIsNone(room["duel"])

    def test_solo_show_ended_by_the_solo_client(self):
        room = solo()
        du = spin(room)
        self.err(403, server.act, room, "duelend", SPY, {"id": du["id"]})
        server.act(room, "duelend", HOST, {"id": du["id"], "winner": "x"})  # show: the winner is fixed
        self.assertEqual(room["events"][-1]["winner"], du[du["winner"]])

    def test_deadline_goes_to_whoever_was_ahead(self):
        room = online()
        du = spin(room)
        server.relay_post(room, "duelframe", HOST, {"id": du["id"], "seq": 1, "f": {"t": 1}, "hp": [20, 80]})
        du["deadline"] = time.time() - 1
        server.tick(room)
        ev = room["events"][-1]
        self.assertEqual((ev["how"], ev["winner"]), ("time", room["seats"][1]["id"]))

    def test_rounds_count_before_health(self):
        room = online()
        du = spin(room)
        server.relay_post(room, "duelframe", HOST, {"id": du["id"], "seq": 1, "f": {"hp": [10, 90], "rw": [1, 0]}})
        du["deadline"] = time.time() - 1
        server.tick(room)
        self.assertEqual(room["events"][-1]["winner"], room["seats"][0]["id"])

    def test_deadline_without_frames_is_a_coin(self):
        room = online()
        du = spin(room)
        du["deadline"] = time.time() - 1
        server.tick(room)
        self.assertEqual(room["events"][-1]["how"], "coin")
        self.assertEqual(room["events"][-1]["winner"], room["seats"][0]["id"])   # Fixed coin: "a"

    def test_minigame_waits_for_the_duel(self):
        room = online(cpu_guest=True, mini_every=1)
        room["current"] = 1                                 # guest (CPU) moves last in the round
        room["seats"][1]["pos"] = 7
        room["seats"][0]["pos"] = 10
        server.act(room, "spin", HOST, {})                  # host may spin for the CPU seat
        du = room["duel"]
        self.assertTrue(du and du["mini"])
        self.assertIsNone(room["mini"])
        self.assertTrue(server.view(room, HOST)["duel"]["miniNext"])
        du["deadline"] = time.time() - 1
        server.tick(room)
        self.assertIsNone(room["duel"])
        self.assertIsNotNone(room["mini"])
        kinds = [e["kind"] for e in room["events"]]
        self.assertEqual(kinds[-2:], ["turn", "duel"])
        self.assertGreater(room["mini"]["startAt"], room["events"][-1]["at"])

    def test_cpu_toggle_restages(self):
        room = online()
        du = spin(room)
        server.act(room, "cpu", HOST, {"seat": room["seats"][1]["id"], "cpu": True})
        self.assertNotEqual(room["duel"]["id"], du["id"])
        self.assertEqual((room["duel"]["mode"], room["duel"]["runner"]), ("local", HOST))
        server.act(room, "cpu", HOST, {"seat": room["seats"][0]["id"], "cpu": True})
        self.assertEqual(room["duel"]["mode"], "show")

    def test_lobby_clears_the_duel(self):
        room = online()
        spin(room)
        server.act(room, "lobby", HOST, {})
        self.assertIsNone(room["duel"])


class TestRelay(Base):
    def setUp(self):
        super().setUp()
        self.room = online()
        self.du = spin(self.room)

    def post(self, action, client, **body):
        return server.relay_post(self.room, action, client, {"id": self.du["id"], **body})

    def test_who_may_post(self):
        self.err(403, self.post, "duelframe", GUEST, seq=1, f={})
        self.err(403, self.post, "duelframe", SPY, seq=1, f={})
        self.err(403, self.post, "duelin", HOST, seq=1, k=3)
        self.err(403, self.post, "duelin", SPY, seq=1, k=3)
        self.assertTrue(self.post("duelframe", HOST, seq=1, f={"x": 1})["ok"])
        self.assertTrue(self.post("duelin", GUEST, seq=1, k=4095)["ok"])

    def test_validation(self):
        for bad in (dict(seq=-1, f={}), dict(seq="1", f={}), dict(seq=True, f={}), dict(seq=1, f=[1]),
                    dict(seq=1, f="x"), dict(seq=1, f={"a": [[[[[[[[1]]]]]]]]})):
            self.err(400, self.post, "duelframe", HOST, **bad)
        self.err(413, self.post, "duelframe", HOST, seq=1, f={"x": "y" * 3000})
        for k in (-1, 4096, 1.5, True, "3", None):
            self.err(400, self.post, "duelin", GUEST, seq=1, k=k)
        self.assertEqual(server.relay_post(self.room, "duelframe", HOST, {"id": "old", "seq": 1, "f": {}}),
                         {"ok": False, "over": True})

    def test_relay_keeps_only_the_latest_and_never_saves(self):
        v = self.room["v"]
        for i in range(1, 50):
            self.post("duelframe", HOST, seq=i, f={"i": i})
        self.post("duelin", GUEST, seq=1, k=5)
        self.post("duelin", GUEST, seq=2, k=6)
        self.assertEqual(self.room["v"], v)
        r = server.relay_wait(self.room["code"], self.du["id"], -1, "")
        self.assertEqual((r["frame"], r["frameSeq"], r["input"], r["inputSeq"], r["over"]), ({"i": 49}, 49, 6, 2, False))

    def test_late_packets_dropped_restart_accepted(self):
        self.post("duelframe", HOST, seq=100, f={"i": 100})
        self.assertTrue(self.post("duelframe", HOST, seq=95, f={"i": 95}).get("stale"))
        self.assertFalse(self.post("duelframe", HOST, seq=1, f={"i": 1}).get("stale"))   # runner reloaded
        r = server.relay_wait(self.room["code"], self.du["id"], -1, "frame")
        self.assertEqual(r["frame"], {"i": 1})

    def test_long_poll_wakes_on_a_frame(self):
        code, did = self.room["code"], self.du["id"]
        server.relay_of(code, did)
        out = {}

        def wait():
            out["r"] = server.relay_wait(code, did, 0, "frame")
        th = threading.Thread(target=wait)
        t0 = time.time()
        th.start()
        time.sleep(0.15)
        self.post("duelin", GUEST, seq=1, k=1)              # an input does not wake a frame poll
        time.sleep(0.15)
        self.assertTrue(th.is_alive())
        self.post("duelframe", HOST, seq=1, f={"go": 1})
        th.join(2)
        self.assertLess(time.time() - t0, 0.9)
        self.assertEqual(out["r"]["frame"], {"go": 1})

    def test_long_poll_times_out_and_ends_on_duel_end(self):
        code, did = self.room["code"], self.du["id"]
        server.relay_of(code, did)
        t0 = time.time()
        r = server.relay_wait(code, did, 0, "")
        self.assertGreaterEqual(time.time() - t0, server.DUEL_WAIT - 0.05)
        self.assertFalse(r["over"])
        out = {}
        th = threading.Thread(target=lambda: out.update(r=server.relay_wait(code, did, 0, "")))
        th.start()
        time.sleep(0.1)
        server.act(self.room, "duelend", HOST, {"id": did, "winner": "a"})
        th.join(2)
        self.assertTrue(out["r"]["over"])
        self.assertNotIn(code, server.relays)                # memory freed with the duel
        self.assertTrue(server.relay_wait(code, did, 0, "")["over"])

    def test_waiter_caps(self):
        code, did = self.room["code"], self.du["id"]
        r = server.relay_of(code, did)
        r["waiters"] = server.DUEL_WAITERS
        t0 = time.time()
        self.assertTrue(server.relay_wait(code, did, 0, "")["busy"])
        r["waiters"] = 0
        server.relay_waiting[0] = server.DUEL_WAITERS_ALL
        try:
            self.assertTrue(server.relay_wait(code, did, 0, "")["busy"])
        finally:
            server.relay_waiting[0] = 0
        self.assertLess(time.time() - t0, 0.2)


class TestUpgrade(Base):
    def test_old_rooms_load(self):
        room = online()
        for k in ("duels", "duel", "duelLast"):
            del room[k]
        server.upgrade(room)
        self.assertEqual((room["duels"], room["duel"], room["duelLast"]), (False, None, None))
        self.assertIsNone(spin(room))                        # a game already running keeps its rules
        room = online()
        room["status"] = "lobby"
        for k in ("duels", "duel", "duelLast"):
            del room[k]
        self.assertTrue(server.upgrade(room)["duels"])

    def test_live_duel_survives_a_restart(self):
        import json
        room = online()
        du = spin(room)
        back = server.upgrade(json.loads(json.dumps(room)))
        self.assertEqual(back["duel"], du)
        back["duel"]["deadline"] = time.time() - 1
        self.assertTrue(server.tick(back))
        self.assertIsNone(back["duel"])

    def test_settings_toggle(self):
        room = server.new_room("ASDFG", HOST)
        server.act(room, "join", HOST, {})
        server.act(room, "settings", HOST, {"duels": False})
        self.assertFalse(room["duels"])
        server.act(room, "start", HOST, {})
        self.err(409, server.act, room, "settings", HOST, {"duels": True})
        room = server.new_room("ASDFH", HOST, solo=True)
        server.act(room, "start", HOST, {"seats": [{}, {}], "duels": False})
        self.assertFalse(room["duels"])


if __name__ == "__main__":
    unittest.main()
