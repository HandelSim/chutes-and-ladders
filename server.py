#!/usr/bin/env python3
"""Chutes & Ladders game service: serves the game page and runs online rooms.

Public on purpose (owner request): https://chutes.129-158-253-250.sslip.io, no login.
One-computer mode is pure client-side; this server only matters for online rooms,
where it is authoritative: it owns turn order and every spin, so a browser cannot
fake a roll. Clients poll GET /api/rooms/<code>?v=<version> (no WebSockets: the
owner's corporate proxy blocks them) and animate the events they have not seen.

Identity is a random 32-hex client id the browser keeps in localStorage and sends
as X-Client-Id. It is a bearer secret for "which seats are mine" and "am I host";
nothing else is stored about a visitor.

Stdlib only. Rooms persist in SQLite so a restart does not kill a game in progress;
a room untouched for ROOM_TTL_HOURS is dropped (app bookkeeping, not owner data).

Env: CHUTES_HOST (127.0.0.1), CHUTES_PORT (8791), CHUTES_DATA_DIR (./data),
     CHUTES_ROOM_TTL_HOURS (24), CHUTES_MAX_ROOMS (1000).
"""
import json
import os
import random
import re
import secrets
import sqlite3
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
HOST = os.environ.get("CHUTES_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHUTES_PORT", "8791"))
DATA_DIR = Path(os.environ.get("CHUTES_DATA_DIR", HERE / "data"))
ROOM_TTL = float(os.environ.get("CHUTES_ROOM_TTL_HOURS", "24")) * 3600
MAX_ROOMS = int(os.environ.get("CHUTES_MAX_ROOMS", "1000"))
MAX_BODY = 2048
MAX_SEATS = 6
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ"   # no I/L/O: easy to read aloud
CODE_LEN = 5
CLIENT_RE = re.compile(r"^[0-9a-f]{32}$")
CREATE_LIMIT = (20, 600)                    # rooms per IP per window (seconds)

LADDERS = {1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100}
CHUTES = {16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78}
COLORS = ["#e63946", "#1d7cf2", "#2a9d55", "#f29e02", "#8e44ad", "#00a6a6"]
CHAR_IDS = re.findall(r'"id":"([a-z0-9-]+)"', (STATIC / "chars.js").read_text())
MAX_EVENTS = 80
MAX_NAME = 20

lock = threading.Lock()
rooms: dict = {}
create_log: dict = {}


# ---------- persistence ----------
def db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATA_DIR / "rooms.db", check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, json TEXT NOT NULL, updated REAL NOT NULL)")
    return conn


DB = db()


def load_rooms():
    cutoff = time.time() - ROOM_TTL
    DB.execute("DELETE FROM rooms WHERE updated < ?", (cutoff,))
    DB.commit()
    for code, js in DB.execute("SELECT code, json FROM rooms"):
        rooms[code] = json.loads(js)


def save(room):
    room["v"] += 1
    room["updated"] = time.time()
    DB.execute("INSERT OR REPLACE INTO rooms (code, json, updated) VALUES (?, ?, ?)",
               (room["code"], json.dumps(room, separators=(",", ":")), room["updated"]))
    DB.commit()


def purge_expired():
    cutoff = time.time() - ROOM_TTL
    for code in [c for c, r in rooms.items() if r["updated"] < cutoff]:
        del rooms[code]
    DB.execute("DELETE FROM rooms WHERE updated < ?", (cutoff,))
    DB.commit()


# ---------- game rules ----------
def resolve(frm, roll):
    land = frm + roll
    if land > 100:
        return {"land": frm, "to": frm, "via": "bounce"}
    if land in LADDERS:
        return {"land": land, "to": LADDERS[land], "via": "ladder"}
    if land in CHUTES:
        return {"land": land, "to": CHUTES[land], "via": "chute"}
    return {"land": land, "to": land, "via": None}


def anim_seconds(ev):
    """Rough upper bound of the client's animation for this event, so the next
    spin cannot land while everyone is still watching the last one."""
    s = 0.85 + 0.25 + 0.4                      # spinner + settle + slack
    if ev["via"] == "bounce":
        return s + 0.4
    s += 0.13 * (ev["land"] - ev["from"])
    if ev["via"] in ("ladder", "chute"):
        s += 1.6
    return s


def new_room(code, host):
    return {"code": code, "host": host, "created": time.time(), "updated": time.time(), "v": 0,
            "status": "lobby", "game": 0, "seats": [], "current": 0, "turn": 0,
            "events": [], "winner": None, "autoSpin": 0, "readyAt": 0}


def do_spin(room, auto=False):
    seat = room["seats"][room["current"]]
    roll = random.SystemRandom().randint(1, 6)
    ev = {"n": room["turn"] + 1, "seat": seat["id"], "roll": roll, "from": seat["pos"], "auto": auto}
    ev.update(resolve(seat["pos"], roll))
    room["turn"] += 1
    seat["pos"] = ev["to"]
    seat["spins"] += 1
    if ev["via"] == "ladder":
        seat["ladders"] += 1
    elif ev["via"] == "chute":
        seat["chutes"] += 1
    now = time.time()
    ev["at"] = now
    room["events"] = (room["events"] + [ev])[-MAX_EVENTS:]
    room["readyAt"] = now + anim_seconds(ev)
    if seat["pos"] == 100:
        room["status"] = "over"
        room["winner"] = seat["id"]
    else:
        room["current"] = (room["current"] + 1) % len(room["seats"])
    save(room)
    return ev


def maybe_autospin(room):
    if room["status"] == "playing" and room["autoSpin"] > 0 and time.time() >= room["readyAt"] + room["autoSpin"]:
        do_spin(room, auto=True)


def reset_positions(room):
    for s in room["seats"]:
        s.update(pos=0, spins=0, ladders=0, chutes=0)
    room.update(current=0, turn=0, events=[], winner=None, readyAt=time.time())
    room["game"] += 1


def view(room, client):
    seats = [{k: s.get(k, "") if k == "name" else s[k] for k in ("id", "name", "char", "color", "pos", "spins", "ladders", "chutes")} | {"mine": s["owner"] == client}
             for s in room["seats"]]
    return {"code": room["code"], "v": room["v"], "now": time.time(), "status": room["status"], "game": room["game"],
            "isHost": room["host"] == client, "seats": seats, "current": room["current"], "turn": room["turn"],
            "events": room["events"], "winner": room["winner"], "autoSpin": room["autoSpin"], "readyAt": room["readyAt"]}


class Err(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


def free_char(room):
    taken = {s["char"] for s in room["seats"]}
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


# ---------- actions (called under lock) ----------
def act(room, action, client, body):
    host = room["host"] == client
    if action == "join":
        if room["status"] != "lobby":
            raise Err(409, "The game already started. Watch, or ask the host for a new round.")
        if len(room["seats"]) >= MAX_SEATS:
            raise Err(409, "The room is full (6 players).")
        used = {s["color"] for s in room["seats"]}
        char = body.get("char")
        if char not in CHAR_IDS or any(s["char"] == char for s in room["seats"]):
            char = free_char(room)
        room["seats"].append({"id": secrets.token_hex(4), "owner": client, "char": char,
                              "name": clean_name(body.get("name")),
                              "color": next(c for c in COLORS if c not in used),
                              "pos": 0, "spins": 0, "ladders": 0, "chutes": 0})
    elif action == "char":
        seat = seat_of(room, body.get("seat"))
        if seat["owner"] != client:
            raise Err(403, "That is not your piece.")
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
    elif action == "leave":
        seat = seat_of(room, body.get("seat"))
        if seat["owner"] != client and not host:
            raise Err(403, "Only the host can remove other players.")
        if room["status"] == "playing":
            raise Err(409, "Players cannot leave mid-game. The host can turn on auto-spin instead.")
        room["seats"].remove(seat)
        if room["status"] == "over":
            room["status"] = "lobby"
            reset_positions(room)
    elif action == "start":
        if not host:
            raise Err(403, "Only the host can start.")
        if not room["seats"]:
            raise Err(409, "Nobody has joined yet.")
        reset_positions(room)
        room["status"] = "playing"
    elif action == "lobby":
        if not host:
            raise Err(403, "Only the host can do that.")
        reset_positions(room)
        room["status"] = "lobby"
    elif action == "spin":
        if room["status"] != "playing":
            raise Err(409, "The game is not running.")
        seat = room["seats"][room["current"]]
        if seat["owner"] != client and not host:
            raise Err(403, "It is not your turn.")
        if time.time() < room["readyAt"] - 0.3:
            raise Err(409, "Hold on, the last move is still animating.")
        if body.get("expect") is not None and body.get("expect") != room["turn"]:
            raise Err(409, "That turn already happened.")
        do_spin(room)
        return
    elif action == "settings":
        if not host:
            raise Err(403, "Only the host can change settings.")
        try:
            room["autoSpin"] = max(0, min(120, int(body.get("autoSpin", 0))))
        except (TypeError, ValueError):
            raise Err(400, "Bad auto-spin value.")
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
            if u.path in ("/", "/index.html"):
                return self.send(200, raw=(STATIC / "index.html").read_bytes(), ctype="text/html; charset=utf-8", cache="no-cache")
            if u.path == "/chars.js":
                return self.send(200, raw=(STATIC / "chars.js").read_bytes(), ctype="text/javascript; charset=utf-8",
                                 cache="public, max-age=86400")
            if u.path == "/robots.txt":
                return self.send(200, raw=b"User-agent: *\nDisallow: /\n", ctype="text/plain")
            if u.path == "/healthz":
                return self.send(200, {"ok": True, "rooms": len(rooms)})
            m = re.fullmatch(r"/api/rooms/([A-Za-z]{%d})" % CODE_LEN, u.path)
            if m:
                client = self.client()
                code = m.group(1).upper()
                since = parse_qs(u.query).get("v", [None])[0]
                with lock:
                    room = rooms.get(code)
                    if not room:
                        raise Err(404, "No room with that code. It may have expired.")
                    maybe_autospin(room)
                    if since is not None and since == str(room["v"]):
                        return self.send(200, {"v": room["v"], "now": time.time(), "same": True})
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
            if path == "/api/rooms":
                with lock:
                    now = time.time()
                    hits = [t for t in create_log.get(self.ip(), []) if now - t < CREATE_LIMIT[1]]
                    if len(hits) >= CREATE_LIMIT[0]:
                        raise Err(429, "Too many rooms created. Try again in a few minutes.")
                    purge_expired()
                    if len(rooms) >= MAX_ROOMS:
                        raise Err(503, "Too many active rooms right now.")
                    create_log[self.ip()] = hits + [now]
                    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
                    while code in rooms:
                        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
                    room = rooms[code] = new_room(code, client)
                    act(room, "join", client, body)          # the host joins as player 1
                    return self.send(200, view(room, client))
            m = re.fullmatch(r"/api/rooms/([A-Za-z]{%d})/([a-z]+)" % CODE_LEN, path)
            if not m:
                raise Err(404, "Not found.")
            with lock:
                room = rooms.get(m.group(1).upper())
                if not room:
                    raise Err(404, "No room with that code. It may have expired.")
                act(room, m.group(2), client, body)
                return self.send(200, view(room, client))
        except Err as e:
            self.send(e.status, {"error": e.msg})


def main():
    load_rooms()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"chutes: serving on http://{HOST}:{PORT} ({len(rooms)} rooms restored, {len(CHAR_IDS)} characters)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
