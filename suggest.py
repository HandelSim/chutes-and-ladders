#!/usr/bin/env python3
"""Chutes & Ladders suggestion box: the game-side gate in front of the AI worker.

Players submit free-text game-change ideas. The text is attacker-controlled and is
eventually read by an automated worker, so everything here is deny-by-default:
sanitize, deterministic prescreen (no echo, no rule disclosure), rate limits that
also charge rejected attempts, dedupe, then an atomic hand-off file.

Public API: submit(text, ip, client), recent(), update_status(sid, status, note),
enqueue(sugg). submit() hands off through the module attribute ENQUEUE so a test
(or the server) can swap the transport.

Env (read at call time): CHUTES_DATA_DIR (<module dir>/data),
  CHUTES_SUGGEST_ENABLED (only "1" enables submissions),
  CHUTES_SUGGEST_IP_HOUR (3), CHUTES_SUGGEST_IP_DAY (10),
  CHUTES_SUGGEST_CLIENT_HOUR (3), CHUTES_SUGGEST_CLIENT_DAY (10),
  CHUTES_SUGGEST_GLOBAL_DAY (30, accepted suggestions per day across everyone).

Files under DATA_DIR:
  suggestions.sqlite3           rows (ip/client stored only as salted HMAC)
  .salt                         per-install HMAC salt (0600)
  outbox/<sid>.json             {"v":1,"id","text","at"}  accepted hand-off
  outbox/rejected-<sid>.json    {"v":1,"id","reason","at","prescreen":true}  (no text)
  status/<sid>.json             {"v":1,"id","status","note","at"}  written by oak / update_status

CLI: python3 suggest.py set-status SID STATUS [NOTE]
     python3 suggest.py recent
"""
import difflib
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
from contextlib import closing
from pathlib import Path

HERE = Path(__file__).resolve().parent
SID_RE = re.compile(r"^s[0-9a-f]{10}$")
CLIENT_RE = re.compile(r"^[0-9a-f]{32}$")
STATUSES = ("queued", "rejected", "building", "live", "failed")
MIN_LEN, MAX_LEN = 10, 500
MAX_RAW = 5000                  # refuse to even normalize anything bigger
MAX_IP = 64
NOTE_MAX = 200
RECENT_N = 20
DEDUPE_DAYS = 30
DEDUPE_POOL = 200
DEDUPE_RATIO = 0.9
GLOBAL_ALL_DAY = 1000           # backstop on stored rows/day (bounds disk if ip/client are rotated)
STATUS_FILE_MAX = 8192
HOUR, DAY = 3600.0, 86400.0

ERR_CLOSED = "Suggestions are closed right now."
ERR_BAD = "Bad request."
ERR_LEN = "Suggestions must be 10 to 500 characters."
ERR_REJECT = "That suggestion can't be accepted. Please describe a change to the game itself."
ERR_RATE = "Too many suggestions. Please try again later."
ERR_DUP = "That idea has already been suggested."
ERR_UNAVAILABLE = "Suggestions are temporarily unavailable."
OK_MESSAGE = "Thanks! Your suggestion is queued for review."

_lock = threading.Lock()
_salt_cache = {}


def now():
    return time.time()


# ---------------------------------------------------------------- config

def _int_env(name, default):
    try:
        v = int(os.environ.get(name, ""))
        return v if v >= 0 else default
    except ValueError:
        return default


def data_dir():
    return Path(os.environ.get("CHUTES_DATA_DIR") or (HERE / "data"))


def enabled():
    return os.environ.get("CHUTES_SUGGEST_ENABLED") == "1"


def limits():
    return {
        "ip_hour": _int_env("CHUTES_SUGGEST_IP_HOUR", 3),
        "ip_day": _int_env("CHUTES_SUGGEST_IP_DAY", 10),
        "client_hour": _int_env("CHUTES_SUGGEST_CLIENT_HOUR", 3),
        "client_day": _int_env("CHUTES_SUGGEST_CLIENT_DAY", 10),
        "global_day": _int_env("CHUTES_SUGGEST_GLOBAL_DAY", 30),
    }


# ---------------------------------------------------------------- text

def sanitize(text):
    """NFKC, drop control/format/private/surrogate/unassigned chars, collapse whitespace."""
    if not isinstance(text, str):
        return ""
    text = unicodedata.normalize("NFKC", text)
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        if cat == "Cc":
            out.append(" " if ch.isspace() else "")
        elif cat in ("Cf", "Co", "Cs", "Cn"):
            continue
        else:
            out.append(ch)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def normalize(text):
    t = re.sub(r"[^a-z0-9 ]", "", text.lower())
    return re.sub(r" +", " ", t).strip()


_TLDS = r"com|net|org|io|dev|xyz|ru|cn|co|app|gg|ly|me|sh|ai"
URL_RE = re.compile(
    r"https?://|\bhttps?\b|://|\bwww\.|\b[a-z0-9-]+\.(?:" + _TLDS + r")\b"
    r"|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){3,}",
    re.I)

PRESCREEN = [
    ("url", URL_RE),
    ("injection", re.compile(
        r"ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier)|\bdisregard"
        r"|system prompt|\byou are now\b|\bnew instructions?\b|\bact as\b|\bpretend"
        r"|jailbreak|developer mode|<\||\[/?inst\]|\bassistant\s*:|\bsystem\s*:|\boverrid",
        re.I)),
    ("code", re.compile(
        r"[`<>{}]|\$\(|&&|\|\||;\s*(?:rm|ls|cat|cd|curl|wget|bash|sh|zsh|python3?|perl|echo"
        r"|nc|chmod|chown|sudo|kill|env|printenv|whoami|id|export|source)\b"
        r"|\b(?:sudo|rm -rf|curl|wget|bash|chmod|eval|exec|import os|subprocess|base64"
        r"|powershell)\b",
        re.I)),
    ("paths", re.compile(
        r"~/|\.\./|/home\b|/etc\b|/root\b|/tmp\b|/var\b|\.env\b|\.ssh\b|id_rsa|\\"
        r"|\.(?:py|sh|json|ya?ml|md|txt|db|sqlite3?)\b",
        re.I)),
    ("secrets", re.compile(
        r"\b(?:secrets?|tokens?|passwords?|passwd|api ?keys?|credentials?|env vars?"
        r"|environment variables?|ssh|private keys?|cookies?|session ids?|oauth)\b",
        re.I)),
    ("oak", re.compile(
        r"\b(?:brains?|vaults?|obsidian|oak|discord|claude|anthropic|llms?|ai agents?"
        r"|the agents?|prompts?|workers?|orchestrators?|server files?|source code|repos?"
        r"|repository|github|git)\b",
        re.I)),
    ("exfil", re.compile(
        r"\bread the\b|\bfetch|\bdownload|\bupload|exfiltrat|\bsend (?:me|us|to)\b|\be-?mail"
        r"|\bwebhook|\blog (?:the|all|every)\b|\bcollect|\btrack|analytics|\bip ?address"
        r"|\blocation|personal (?:data|info)|player data|user data"
        r"|external (?:service|api|server)|third.party|api call|http request",
        re.I)),
    ("abuse", re.compile(r"@everyone|@here|discord\.gg|\bmention", re.I)),
]

GAME_RE = re.compile(
    r"\b(?:board|dice|die|roll|chute|ladder|slide|player|piece|pawn|counter|colou?r|sound"
    r"|music|animation|button|square|tile|space|turn|win|move|room|online|theme|speed|mode"
    r"|bot|avatar|mini-?game|game|screen|mobile|phone|font|rule|score|confetti|emoji|name"
    r"|lobby|start|restart|undo|timer|cpu|computer|level|map|number)",
    re.I)


def prescreen(text):
    """Return a reason code if the text is rejected, else None. Internal only."""
    for reason, rx in PRESCREEN:
        if rx.search(text):
            return reason
    if not GAME_RE.search(text):
        return "offtopic"
    return None


def clean_note(note):
    note = sanitize(note if isinstance(note, str) else "")
    note = re.sub(r"\s+", " ", URL_RE.sub("", note)).strip()
    return note[:NOTE_MAX]


# ---------------------------------------------------------------- storage

def _db():
    d = data_dir()
    d.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(d / "suggestions.sqlite3"), timeout=10, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, text TEXT NOT NULL,"
        " norm TEXT NOT NULL, ip_h TEXT NOT NULL, client_h TEXT NOT NULL, status TEXT NOT NULL,"
        " note TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',"
        " created_at REAL NOT NULL, updated_at REAL NOT NULL)")
    conn.execute("CREATE INDEX IF NOT EXISTS sugg_created ON suggestions(created_at)")
    return conn


def _salt():
    path = data_dir() / ".salt"
    key = str(path)
    if key in _salt_cache:
        return _salt_cache[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(16))
    except FileExistsError:
        pass
    salt = ""
    for _ in range(50):                     # another thread may be mid-write
        salt = path.read_text().strip()
        if re.fullmatch(r"[0-9a-f]{32}", salt):
            break
        time.sleep(0.01)
    else:
        raise RuntimeError("suggestion salt file is unreadable")
    _salt_cache[key] = salt
    return salt


def _h(kind, value):
    return hmac.new(_salt().encode(), (kind + ":" + value).encode("utf-8", "replace"),
                    hashlib.sha256).hexdigest()


def _atomic_write_json(dest_dir, name, obj):
    dest_dir = Path(dest_dir)
    tmp_dir = dest_dir / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / (name + "." + secrets.token_hex(4))
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dest_dir / name)
    finally:
        if tmp.exists():
            tmp.unlink()


def enqueue(sugg):
    """Default hand-off: atomically write DATA_DIR/outbox/<sid>.json."""
    sid = sugg["id"]
    if not isinstance(sid, str) or not SID_RE.fullmatch(sid):
        raise ValueError("bad suggestion id")
    _atomic_write_json(data_dir() / "outbox", sid + ".json",
                       {"v": 1, "id": sid, "text": sugg["text"], "at": sugg["at"]})


ENQUEUE = enqueue


def _new_id(conn):
    while True:
        sid = "s" + secrets.token_hex(5)
        if not conn.execute("SELECT 1 FROM suggestions WHERE id=?", (sid,)).fetchone():
            return sid


def _count(conn, where, args):
    return conn.execute("SELECT COUNT(*) FROM suggestions WHERE " + where, args).fetchone()[0]


def _rate_limited(conn, ip_h, client_h, t):
    lim = limits()
    checks = [
        ("ip_h=? AND created_at>?", (ip_h, t - HOUR), lim["ip_hour"]),
        ("ip_h=? AND created_at>?", (ip_h, t - DAY), lim["ip_day"]),
        ("client_h=? AND created_at>?", (client_h, t - HOUR), lim["client_hour"]),
        ("client_h=? AND created_at>?", (client_h, t - DAY), lim["client_day"]),
        ("status!='rejected' AND created_at>?", (t - DAY,), lim["global_day"]),
        ("created_at>?", (t - DAY,), GLOBAL_ALL_DAY),
    ]
    return any(_count(conn, w, a) >= cap for w, a, cap in checks)


def _is_duplicate(conn, norm, t):
    live = "status!='rejected' AND reason!='enqueue_failed'"
    if conn.execute("SELECT 1 FROM suggestions WHERE " + live + " AND norm=? AND created_at>?",
                    (norm, t - DEDUPE_DAYS * DAY)).fetchone():
        return True
    rows = conn.execute("SELECT norm FROM suggestions WHERE " + live +
                        " ORDER BY created_at DESC LIMIT ?", (DEDUPE_POOL,)).fetchall()
    for (other,) in rows:
        m = difflib.SequenceMatcher(None, norm, other, autojunk=False)
        if m.real_quick_ratio() >= DEDUPE_RATIO and m.quick_ratio() >= DEDUPE_RATIO \
                and m.ratio() >= DEDUPE_RATIO:
            return True
    return False


def _insert(conn, sid, text, norm, ip_h, client_h, status, reason, t):
    conn.execute("INSERT INTO suggestions (id, text, norm, ip_h, client_h, status, note, reason,"
                 " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                 (sid, text, norm, ip_h, client_h, status, "", reason, t, t))
    conn.commit()


# ---------------------------------------------------------------- public API

def submit(text, ip, client):
    if not enabled():
        return 503, {"error": ERR_CLOSED}
    if not isinstance(client, str) or not CLIENT_RE.fullmatch(client):
        return 400, {"error": ERR_BAD}
    if not isinstance(text, str) or len(text) > MAX_RAW:
        return 400, {"error": ERR_LEN}
    clean = sanitize(text)
    if not MIN_LEN <= len(clean) <= MAX_LEN:
        return 400, {"error": ERR_LEN}
    reason = prescreen(clean)
    ip = ip.strip()[:MAX_IP] if isinstance(ip, str) else ""
    ip = ip or "unknown"
    try:
        ip_h, client_h = _h("ip", ip), _h("client", client)
        norm = normalize(clean)
        t = now()
        with _lock, closing(_db()) as conn:
            # Over quota always answers 429 (before revealing the prescreen verdict) and
            # stores nothing, so probing costs quota and cannot grow the DB unboundedly.
            if _rate_limited(conn, ip_h, client_h, t):
                return 429, {"error": ERR_RATE}
            sid = _new_id(conn)
            if reason:
                _insert(conn, sid, clean, norm, ip_h, client_h, "rejected", reason, t)
            elif _is_duplicate(conn, norm, t):
                _insert(conn, sid, clean, norm, ip_h, client_h, "rejected", "duplicate", t)
                return 409, {"error": ERR_DUP}
            else:
                _insert(conn, sid, clean, norm, ip_h, client_h, "queued", "", t)
    except Exception:
        return 503, {"error": ERR_UNAVAILABLE}
    if reason:
        try:
            _atomic_write_json(data_dir() / "outbox", "rejected-" + sid + ".json",
                               {"v": 1, "id": sid, "reason": reason, "at": t, "prescreen": True})
        except OSError:
            pass
        return 422, {"error": ERR_REJECT}
    try:
        ENQUEUE({"id": sid, "text": clean, "at": t})
    except Exception:
        try:
            with _lock, closing(_db()) as conn:
                conn.execute("UPDATE suggestions SET status='failed', note=?, reason='enqueue_failed',"
                             " updated_at=? WHERE id=?", ("Could not be queued", now(), sid))
                conn.commit()
        except Exception:
            pass
        return 503, {"error": ERR_UNAVAILABLE}
    return 200, {"ok": True, "id": sid, "message": OK_MESSAGE}


def _read_status_file(sid):
    path = data_dir() / "status" / (sid + ".json")
    try:
        if not path.is_file() or path.stat().st_size > STATUS_FILE_MAX:
            return None
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(obj, dict) or obj.get("id") != sid or obj.get("status") not in STATUSES:
        return None
    return obj


def recent():
    with closing(_db()) as conn:
        rows = conn.execute("SELECT id, text, status, note, created_at FROM suggestions"
                            " ORDER BY created_at DESC, rowid DESC LIMIT ?", (RECENT_N,)).fetchall()
    items = []
    for sid, text, status, note, created in rows:
        if status != "rejected":            # prescreen/dupe verdicts are final for display
            override = _read_status_file(sid)
            if override:
                status, note = override["status"], override.get("note", "")
        if status == "rejected":
            items.append({"id": sid, "text": "", "status": "rejected", "note": "Not accepted",
                          "at": created})
        else:
            items.append({"id": sid, "text": text, "status": status, "note": clean_note(note),
                          "at": created})
    return {"items": items}


def update_status(sid, status, note=""):
    if not isinstance(sid, str) or not SID_RE.fullmatch(sid):
        raise ValueError("bad suggestion id")
    if status not in STATUSES:
        raise ValueError("bad status")
    note = clean_note(note)
    t = now()
    with _lock, closing(_db()) as conn:
        cur = conn.execute("UPDATE suggestions SET status=?, note=?, updated_at=? WHERE id=?",
                           (status, note, t, sid))
        conn.commit()
        if cur.rowcount != 1:
            raise ValueError("unknown suggestion id")
    _atomic_write_json(data_dir() / "status", sid + ".json",
                       {"v": 1, "id": sid, "status": status, "note": note, "at": t})


def main(argv):
    if len(argv) >= 1 and argv[0] == "recent" and len(argv) == 1:
        print(json.dumps(recent(), indent=2, ensure_ascii=False))
        return 0
    if len(argv) in (3, 4) and argv[0] == "set-status":
        try:
            update_status(argv[1], argv[2], argv[3] if len(argv) == 4 else "")
        except ValueError as e:
            print("error: %s" % e, file=sys.stderr)
            return 2
        print("ok")
        return 0
    print("usage: suggest.py set-status SID STATUS [NOTE] | suggest.py recent", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
