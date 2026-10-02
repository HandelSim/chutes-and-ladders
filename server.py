#!/usr/bin/env python3
"""Chutes & Ladders game service: serves the game page and runs every game.

Public on purpose (owner request): https://chutes.129-158-253-250.sslip.io, no login.
The server is authoritative for both modes: online rooms (friends on their own
devices) and one-screen "solo" rooms (every seat owned by one browser, which paces
the turns itself). It owns turn order, every spin, abilities and minigame payouts,
so a browser cannot fake a roll. The rules live in rules.py. Clients poll
GET /api/rooms/<code>?v=<version> (no WebSockets: the owner's corporate proxy
blocks them) and animate the events they have not seen.

Identity is a random 32-hex client id the browser keeps in localStorage and sends
as X-Client-Id. It is a bearer secret for "which seats are mine" and "am I host";
nothing else is stored about a visitor.

Stdlib only. Rooms persist in SQLite so a restart does not kill a game in progress;
a room untouched for ROOM_TTL_HOURS (solo rooms: SOLO_TTL_HOURS) is dropped (app
bookkeeping, not owner data).

Env: CHUTES_HOST (127.0.0.1), CHUTES_PORT (8791), CHUTES_DATA_DIR (./data),
     CHUTES_ROOM_TTL_HOURS (24), CHUTES_SOLO_TTL_HOURS (6), CHUTES_MAX_ROOMS (1000).
"""
import hashlib
import json
import os
import random
import re
import secrets
import sqlite3
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import rules

try:
    import suggest                          # game suggestion box (optional module)
except ImportError:
    suggest = None

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
HOST = os.environ.get("CHUTES_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHUTES_PORT", "8791"))
DATA_DIR = Path(os.environ.get("CHUTES_DATA_DIR", HERE / "data"))
ROOM_TTL = float(os.environ.get("CHUTES_ROOM_TTL_HOURS", "24")) * 3600
SOLO_TTL = float(os.environ.get("CHUTES_SOLO_TTL_HOURS", "6")) * 3600
MAX_ROOMS = int(os.environ.get("CHUTES_MAX_ROOMS", "1000"))
MAX_BODY = 4096
MAX_SEATS = 6
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ"   # no I/L/O: easy to read aloud
CODE_LEN = 5
CLIENT_RE = re.compile(r"^[0-9a-f]{32}$")
CREATE_LIMIT = (20, 600)                    # online rooms per IP per window (seconds)
SOLO_LIMIT = (60, 600)                      # solo rooms per IP per window
BOARD_LIMIT = (120, 600)                    # /api/newboard per IP per window
CPU_DELAY = 1.2                             # online: seconds a computer seat waits after the last animation

COLORS = ["#e63946", "#1d7cf2", "#2a9d55", "#f29e02", "#8e44ad", "#00a6a6"]
CHAR_IDS = re.findall(r'"id":"([a-z0-9-]+)"', (STATIC / "chars.js").read_text())
MAX_EVENTS = 80
MAX_NAME = 20
MINI_PREAMBLE = ("const MINIGAMES = [];\n"
                 "function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);"
                 "t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}\n")
# Python is only re-read on restart, so its hash is taken once; static files are served
# live from disk, so they are hashed on demand (cached by mtime).
PY_HASH = hashlib.sha1((HERE / "server.py").read_bytes() + (HERE / "rules.py").read_bytes()).hexdigest()

lock = threading.Lock()
rooms: dict = {}
hit_log: dict = {}
_build_cache = {"key": None, "build": None}


# ---------- persistence ----------
def db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATA_DIR / "rooms.db", check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, json TEXT NOT NULL, updated REAL NOT NULL)")
    return conn


DB = db()


def upgrade(room):
    """Rooms saved by an older version get every field the current rules expect."""
    room.setdefault("seq", room.get("turn", 0))
    for k, v in (("round", 0), ("abilities", True), ("miniEvery", 3), ("mini", None), ("solo", False),
                 ("miniRecent", []), ("autoSpin", 0), ("readyAt", 0)):
        room.setdefault(k, v)
    room.setdefault("board", dict(rules.CLASSIC))     # v1 games were all on the classic board
    for s in room["seats"]:
        for k, v in (("charges", rules.START_CHARGES), ("shield", 0), ("cpu", False), ("steady", False), ("name", "")):
            s.setdefault(k, v)
    return room


def load_rooms():
    DB.execute("DELETE FROM rooms WHERE updated < ?", (time.time() - max(ROOM_TTL, SOLO_TTL),))
    DB.commit()
    for code, js in DB.execute("SELECT code, json FROM rooms"):
        rooms[code] = upgrade(json.loads(js))


def save(room):
    room["v"] += 1
    room["updated"] = time.time()
    DB.execute("INSERT OR REPLACE INTO rooms (code, json, updated) VALUES (?, ?, ?)",
               (room["code"], json.dumps(room, separators=(",", ":")), room["updated"]))
    DB.commit()


def purge_expired():
    now = time.time()
    gone = [c for c, r in rooms.items() if r["updated"] < now - (SOLO_TTL if r.get("solo") else ROOM_TTL)]
    for code in gone:
        del rooms[code]
    DB.executemany("DELETE FROM rooms WHERE code = ?", [(c,) for c in gone])
    DB.execute("DELETE FROM rooms WHERE updated < ?", (now - max(ROOM_TTL, SOLO_TTL),))
    DB.commit()


def limited(ip, kind, limit):
    """True if this IP is over `limit` = (count, window seconds) for `kind`; else records the hit."""
    now = time.time()
    key = (kind, ip)
    hits = [t for t in hit_log.get(key, []) if now - t < limit[1]]
    if len(hits) >= limit[0]:
        hit_log[key] = hits
        return True
    hit_log[key] = hits + [now]
    return False


# ---------- build id (drives the client's "update available" pill) ----------
def static_files():
    return [STATIC / "index.html", STATIC / "chars.js"] + sorted((STATIC / "minigames").glob("*.js"))


def build_id():
    files = static_files()
    key = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in files)
    if _build_cache["key"] != key:
        h = hashlib.sha1(PY_HASH.encode())
        for p in files:
            h.update(p.read_bytes())
        _build_cache.update(key=key, build=h.hexdigest()[:12])
    return _build_cache["build"]


def rules_js():
    data = {k: getattr(rules, k) for k in ("ABILITIES", "CHAR_AB", "MINIGAMES", "PICK_MAX", "PICK_COST",
                                           "MAX_CHARGES", "START_CHARGES", "MINI_REWARD", "MINI_PLAY",
                                           "MINI_INTRO", "OVERTIME_ROUND", "CLASSIC", "SWAP_RANGE",
                                           "QUAKE_AHEAD")}
    data["BUILD"] = build_id()
    return ("const RULES = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n").encode()


def minigames_js():
    parts = [MINI_PREAMBLE] + [p.read_text() for p in sorted((STATIC / "minigames").glob("*.js"))]
    return "\n;\n".join(parts).encode()


# ---------- game flow ----------
STEP_SECONDS = {"spin": 1.0, "ladder": 1.6, "chute": 1.6, "swap": 1.0, "ability": 0.9,
                "shield": 0.8, "bounce": 0.4, "charge": 0.3}


def anim_seconds(ev):
    """Rough upper bound of the client's animation for this event, so the next
    spin cannot land while everyone is still watching the last one."""
    s = 0.6
    for st in ev.get("steps", []):
        if st["t"] == "move":
            s += 0.13 * abs(st["to"] - st["from"]) + 0.1
        else:
            s += STEP_SECONDS.get(st["t"], 0.3)
    if ev.get("kind") == "mini":
        s += 3.0                                     # results card
    return s


def new_room(code, host, solo=False):
    now = time.time()
    return {"code": code, "host": host, "created": now, "updated": now, "v": 0, "solo": solo,
            "status": "lobby", "game": 0, "seats": [], "current": 0, "turn": 0, "seq": 0, "round": 0,
            "events": [], "winner": None, "autoSpin": 0, "readyAt": 0, "abilities": True, "miniEvery": 3,
            "mini": None, "miniRecent": [], "board": rules.random_board()}


def push_event(room, ev):
    now = time.time()
    ev["at"] = now
    room["events"] = (room["events"] + [ev])[-MAX_EVENTS:]
    room["readyAt"] = max(room["readyAt"], now) + anim_seconds(ev)


def start_mini(room):
    kind = rules.pick_minigame(room)
    humans = [s for s in room["seats"] if not s["cpu"]]
    scores = {s["id"]: rules.sim_score(kind) for s in room["seats"] if s["cpu"]}
    if room["solo"]:
        start, deadline = room["readyAt"], None
    else:
        per_owner = max(Counter(s["owner"] for s in humans).values(), default=1)
        start = room["readyAt"] + rules.MINI_INTRO
        deadline = start + rules.MINI_PLAY + rules.MINI_GRACE + 17 * (per_owner - 1)
    room["mini"] = {"id": secrets.token_hex(4), "kind": kind, "seed": secrets.randbits(31),
                    "startAt": start, "deadline": deadline, "scores": scores}
    if not humans:
        finish_mini(room)


def finish_mini(room):
    ev = rules.resolve_mini(room, dict(room["mini"]["scores"]))
    push_event(room, ev)


def after_turn(room, ev):
    push_event(room, ev)
    if ev.get("mini") and room["status"] == "playing":
        start_mini(room)


def tick(room):
    """Time-driven progress, run on every poll: close a minigame whose deadline
    passed, and let the server play computer seats / auto-spin in online rooms.
    Returns True if the room changed."""
    now = time.time()
    m = room.get("mini")
    if m and m["deadline"] is not None and now > m["deadline"]:
        finish_mini(room)
        return True
    if room["solo"] or room["status"] != "playing" or m:
        return False
    seat = room["seats"][room["current"]]
    delay = CPU_DELAY if seat["cpu"] else (room["autoSpin"] or None)
    if delay is not None and now >= room["readyAt"] + delay:
        after_turn(room, rules.take_turn(room, cpu=True, auto=True))
        return True
    return False


def reset_positions(room):
    for s in room["seats"]:
        s.update(pos=0, spins=0, ladders=0, chutes=0, charges=rules.START_CHARGES, shield=0, steady=False)
    room.update(current=0, turn=0, round=0, events=[], winner=None, readyAt=time.time(), mini=None, miniRecent=[])
    room["game"] += 1


def view(room, client):
    seats = [{k: s[k] for k in ("id", "name", "char", "color", "pos", "spins", "ladders", "chutes", "charges", "cpu")}
             | {"shield": int(s.get("shield") or 0), "mine": s["owner"] == client}
             for s in room["seats"]]
    m = room.get("mini")
    mini = m and {k: m[k] for k in ("id", "kind", "seed", "startAt", "deadline")} | {"submitted": list(m["scores"])}
    return {"code": room["code"], "v": room["v"], "now": time.time(), "build": build_id(), "status": room["status"],
            "game": room["game"], "isHost": room["host"] == client, "solo": room["solo"], "seats": seats,
            "current": room["current"], "turn": room["turn"], "seq": room["seq"], "round": room["round"],
            "events": room["events"], "winner": room["winner"], "autoSpin": room["autoSpin"],
            "readyAt": room["readyAt"], "abilities": room["abilities"], "miniEvery": room["miniEvery"],
            "board": room["board"], "mini": mini}


class Err(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


def free_char(taken):
    left = [c for c in CHAR_IDS if c not in taken]
    return random.choice(left)


def clean_name(raw):
    """Player-chosen display name: printable text only, trimmed, short. Empty means
    "use the character's name"."""
    if not isinstance(raw, str):
        return ""
    raw = "".join(ch for ch in raw if ch.isprintable())
    return " ".join(raw.split())[:MAX_NAME]


def seat_of(room, seat_id):
    for s in room["seats"]:
        if s["id"] == seat_id:
            return s
    raise Err(404, "No such player.")


def new_seat(owner, char, name, color, cpu=False):
    return {"id": secrets.token_hex(4), "owner": owner, "char": char, "name": clean_name(name), "color": color,
            "pos": 0, "spins": 0, "ladders": 0, "chutes": 0, "charges": rules.START_CHARGES, "shield": 0,
            "cpu": bool(cpu), "steady": False}


def solo_seats(client, raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_SEATS:
        raise Err(400, f"Choose 1 to {MAX_SEATS} players.")
    seats, taken = [], set()
    for i, r in enumerate(raw):
        r = r if isinstance(r, dict) else {}
        char = r.get("char")
        if char not in CHAR_IDS or char in taken:
            char = free_char(taken)
        taken.add(char)
        seats.append(new_seat(client, char, r.get("name"), COLORS[i], r.get("cpu", True)))
    return seats


def apply_options(room, body):
    """Board and rule options a new solo game may carry."""
    b = rules.valid_board(body["board"]) if isinstance(body.get("board"), dict) else None
    room["board"] = b or rules.random_board()
    if "abilities" in body:
        room["abilities"] = bool(body["abilities"])
    if "miniEvery" in body:
        room["miniEvery"] = clamp_int(body["miniEvery"], 0, 10, "minigame frequency")


def clamp_int(v, lo, hi, what):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        raise Err(400, f"Bad {what} value.")


# ---------- actions (called under lock) ----------
def act(room, action, client, body):
    host = room["host"] == client
    playing = room["status"] == "playing"
    if action == "join":
        if room["solo"]:
            raise Err(409, "This is a one-screen game.")
        if room["status"] != "lobby":
            raise Err(409, "The game already started. Watch, or ask the host for a new round.")
        if len(room["seats"]) >= MAX_SEATS:
            raise Err(409, "The room is full (6 players).")
        used = {s["color"] for s in room["seats"]}
        taken = {s["char"] for s in room["seats"]}
        char = body.get("char")
        if char not in CHAR_IDS or char in taken:
            char = free_char(taken)
        room["seats"].append(new_seat(client, char, body.get("name"), next(c for c in COLORS if c not in used)))
    elif action == "char":
        seat = seat_of(room, body.get("seat"))
        if seat["owner"] != client:
            raise Err(403, "That is not your piece.")
        if playing:
            raise Err(409, "Characters are locked once the game starts.")
        char = body.get("char")
        if char not in CHAR_IDS:
            raise Err(400, "Unknown character.")
        if any(s["char"] == char and s is not seat for s in room["seats"]):
            raise Err(409, "Someone else already picked that character.")
        seat["char"] = char
    elif action == "name":
        seat = seat_of(room, body.get("seat"))
        if seat["owner"] != client:
            raise Err(403, "That is not your piece.")
        seat["name"] = clean_name(body.get("name"))
    elif action == "cpu":
        seat = seat_of(room, body.get("seat"))
        if seat["owner"] != client and not host:
            raise Err(403, "Only the host or that player can change this.")
        seat["cpu"] = bool(body.get("cpu"))
        m = room.get("mini")
        if m and seat["cpu"] and seat["id"] not in m["scores"]:
            m["scores"][seat["id"]] = rules.sim_score(m["kind"])
        if m and all(s["id"] in m["scores"] for s in room["seats"] if not s["cpu"]):
            finish_mini(room)
    elif action == "leave":
        seat = seat_of(room, body.get("seat"))
        if seat["owner"] != client and not host:
            raise Err(403, "Only the host can remove other players.")
        if playing:
            raise Err(409, "Players cannot leave mid-game. The host can make their piece a computer player instead.")
        room["seats"].remove(seat)
        if room["status"] == "over":
            room["status"] = "lobby"
            reset_positions(room)
    elif action == "start":
        if not host:
            raise Err(403, "Only the host can start.")
        if room["solo"]:
            room["seats"] = solo_seats(client, body.get("seats"))
            apply_options(room, body)
        if not room["seats"]:
            raise Err(409, "Nobody has joined yet.")
        reset_positions(room)
        room["status"] = "playing"
    elif action == "lobby":
        if not host:
            raise Err(403, "Only the host can do that.")
        reset_positions(room)
        room["status"] = "lobby"
    elif action == "board":
        if not host:
            raise Err(403, "Only the host can change the board.")
        if playing:
            raise Err(409, "The board is locked once the game starts.")
        room["board"] = dict(rules.CLASSIC) if body.get("mode") == "classic" else rules.random_board()
    elif action == "spin":
        if not playing:
            raise Err(409, "The game is not running.")
        if room.get("mini"):
            raise Err(409, "Minigame first!")
        seat = room["seats"][room["current"]]
        if seat["owner"] != client and not host:
            raise Err(403, "It is not your turn.")
        if not room["solo"] and time.time() < room["readyAt"] - 0.3:
            raise Err(409, "Hold on, the last move is still animating.")
        if body.get("expect") is not None and body.get("expect") != room["seq"]:
            raise Err(409, "That turn already happened.")
        cpu = seat["cpu"] or seat["owner"] != client
        pick = body.get("pick")
        try:
            ev = rules.take_turn(room, use=bool(body.get("ability")), pick=pick if type(pick) is int else None, cpu=cpu)
        except ValueError as e:
            raise Err(400, str(e))
        after_turn(room, ev)
    elif action == "minigame":
        m = room.get("mini")
        if not m or body.get("id") != m["id"]:
            raise Err(409, "That minigame is already over.")
        seat = seat_of(room, body.get("seat"))
        if seat["owner"] != client:
            raise Err(403, "That is not your piece.")
        if seat["id"] in m["scores"]:
            raise Err(409, "Score already in.")
        now = time.time()
        if m["deadline"] is not None and now > m["deadline"]:
            finish_mini(room)
            save(room)
            raise Err(409, "Time is up for that minigame.")
        if m["deadline"] is not None and now < m["startAt"] - 1:
            raise Err(409, "The minigame has not started yet.")
        m["scores"][seat["id"]] = clamp_int(body.get("score"), 0, rules.MINIGAMES[m["kind"]]["max"], "score")
        if all(s["id"] in m["scores"] for s in room["seats"] if not s["cpu"]):
            finish_mini(room)
    elif action == "settings":
        if not host:
            raise Err(403, "Only the host can change settings.")
        if "autoSpin" in body:
            room["autoSpin"] = clamp_int(body["autoSpin"], 0, 120, "auto-spin")
        for k, new in (("abilities", lambda v: bool(v)), ("miniEvery", lambda v: clamp_int(v, 0, 10, "minigame frequency"))):
            if k in body and new(body[k]) != room[k]:
                if playing:
                    raise Err(409, "Change that before the game starts.")
                room[k] = new(body[k])
    else:
        raise Err(404, "Unknown action.")
    save(room)


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "chutes"
    sys_version = ""

    def log_message(self, fmt, *args):   # quiet: polling would flood the journal
        pass

    def send(self, status, payload=None, ctype="application/json", raw=None, cache="no-store"):
        body = raw if raw is not None else json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_asset(self, raw, ctype):
        """Revalidated every load (so a deploy shows up at once) but cheap: 304 when unchanged."""
        tag = '"%s"' % hashlib.sha1(raw).hexdigest()[:16]
        if self.headers.get("If-None-Match") == tag:
            self.send_response(304)
            self.send_header("ETag", tag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("ETag", tag)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def client(self):
        c = (self.headers.get("X-Client-Id") or "").lower()
        if not CLIENT_RE.match(c):
            raise Err(400, "Missing client id.")
        return c

    def ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            u = urlparse(self.path)
            js = "text/javascript; charset=utf-8"
            if u.path in ("/", "/index.html"):
                return self.send_asset((STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            if u.path == "/chars.js":
                return self.send_asset((STATIC / "chars.js").read_bytes(), js)
            if u.path == "/rules.js":
                return self.send(200, raw=rules_js(), ctype=js)
            if u.path == "/minigames.js":
                return self.send_asset(minigames_js(), js)
            if u.path == "/version":
                return self.send(200, {"build": build_id()})
            if u.path == "/robots.txt":
                return self.send(200, raw=b"User-agent: *\nDisallow: /\n", ctype="text/plain")
            if u.path == "/healthz":
                return self.send(200, {"ok": True, "rooms": len(rooms), "build": build_id()})
            if u.path == "/api/newboard":
                with lock:
                    if limited(self.ip(), "board", BOARD_LIMIT):
                        raise Err(429, "Too many boards. Try again in a few minutes.")
                return self.send(200, rules.random_board())
            if u.path == "/api/suggest":
                if suggest is None:
                    raise Err(404, "Suggestions are not open.")
                return self.send(200, suggest.recent())
            m = re.fullmatch(r"/api/rooms/([A-Za-z]{%d})" % CODE_LEN, u.path)
            if m:
                client = self.client()
                code = m.group(1).upper()
                since = parse_qs(u.query).get("v", [None])[0]
                with lock:
                    room = rooms.get(code)
                    if not room:
                        raise Err(404, "No room with that code. It may have expired.")
                    if tick(room):
                        save(room)
                    if since is not None and since == str(room["v"]):
                        return self.send(200, {"v": room["v"], "now": time.time(), "same": True, "build": build_id()})
                    return self.send(200, view(room, client))
            raise Err(404, "Not found.")
        except Err as e:
            self.send(e.status, {"error": e.msg})

    def do_POST(self):
        try:
            if self.headers.get_content_type() != "application/json":
                raise Err(415, "JSON only.")
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise Err(413, "Too large.")
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                raise Err(400, "Bad JSON.")
            if not isinstance(body, dict):
                raise Err(400, "Bad JSON.")
            client = self.client()
            path = urlparse(self.path).path
            if path == "/api/suggest":
                if suggest is None:
                    raise Err(404, "Suggestions are not open.")
                status, payload = suggest.submit(body.get("text"), self.ip(), client)
                return self.send(status, payload)
            if path == "/api/rooms":
                solo = body.get("solo") is True
                with lock:
                    if limited(self.ip(), "solo" if solo else "room", SOLO_LIMIT if solo else CREATE_LIMIT):
                        raise Err(429, "Too many games created. Try again in a few minutes.")
                    purge_expired()
                    if len(rooms) >= MAX_ROOMS:
                        raise Err(503, "Too many active games right now.")
                    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
                    while code in rooms:
                        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
                    room = new_room(code, client, solo)
                    if solo:
                        act(room, "start", client, body)    # seats, board and options come with it
                    else:
                        act(room, "join", client, body)     # the host joins as player 1
                    rooms[code] = room
                    return self.send(200, view(room, client))
            m = re.fullmatch(r"/api/rooms/([A-Za-z]{%d})/([a-z]+)" % CODE_LEN, path)
            if not m:
                raise Err(404, "Not found.")
            with lock:
                room = rooms.get(m.group(1).upper())
                if not room:
                    raise Err(404, "No room with that code. It may have expired.")
                if tick(room):
                    save(room)
                act(room, m.group(2), client, body)
                return self.send(200, view(room, client))
        except Err as e:
            self.send(e.status, {"error": e.msg})


def main():
    load_rooms()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"chutes: serving on http://{HOST}:{PORT} ({len(rooms)} rooms restored, {len(CHAR_IDS)} characters, "
          f"build {build_id()}, suggestions {'on' if suggest else 'off'})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
