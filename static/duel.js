/* Chutes & Ladders duel: a small Street-Fighter-style fighter for when two pieces share a square.
 *
 *   var h = Duel.start({ root, p1, p2, control: {p1, p2}, seed, forcedWinner, reducedMotion, sound,
 *                        onFrame, onInput, onEnd });
 *   h.remoteInput(bits); h.pushFrame(snapshot); h.destroy();
 *
 * Plain JS, no modules, no assets, no network. The sim is a fixed 60 Hz step that only uses its seeded
 * RNG, so a seed plus the same inputs gives the same fight. Rendering is a 2D canvas (logical 960 wide)
 * driven by requestAnimationFrame, with a 250 ms interval that keeps the sim ticking in a hidden tab.
 * Instance kinds:
 *   runner  no "mirror" seat. Simulates. Seats are kb1/kb2/kbAny/touch1/touch2/touchAny/ai/remote.
 *           "remote" seats are fed by h.remoteInput(bits); onFrame(snapshot) fires about 10 Hz.
 *   mirror  any "mirror" seat. Renders snapshots from h.pushFrame (interpolated); a local kb/touch seat
 *           only reports its inputs through onInput(bits).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ---------- input bits (shared by both ends of a net duel) ----------
   * Held bits plus TAP_* toggles: each press flips its TAP bit, so a press survives a relay that only
   * keeps the latest input (press and release between two polls). */
  var INPUT = {
    LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, PUNCH: 16, KICK: 32, SPECIAL: 64,
    TAP_UP: 128, TAP_PUNCH: 256, TAP_KICK: 512, TAP_SPECIAL: 1024, MASK: 2047
  };
  var LEFT = 1, RIGHT = 2, UP = 4, DOWN = 8, PUNCH = 16, KICK = 32, SPECIAL = 64;
  var B_HELD = [UP, PUNCH, KICK, SPECIAL];
  var B_TAP = [INPUT.TAP_UP, INPUT.TAP_PUNCH, INPUT.TAP_KICK, INPUT.TAP_SPECIAL];

  /* ---------- constants ---------- */
  var FPS = 60, GROUND = 470, WALL_L = 44, WALL_R = 916, PUSH_HALF = 28;
  var ROUND_F = 25 * FPS, MAXHP = 100, MAXM = 100, PROJ_CD = 80, PROJ_V = 7.2, PROJ_R = 22, PROJ_Y = -112;
  var GRAV = 0.75, JUMP_VY = -15.5, JUMP_VX = 4.3, WALK_F = 3.7, WALK_B = 3.0;
  // fighter states
  var S_IDLE = 0, S_WALK = 1, S_CROUCH = 2, S_PREJUMP = 3, S_JUMP = 4, S_LAND = 5, S_ATK = 6, S_HIT = 7,
    S_BLOCK = 8, S_DOWN = 9, S_GETUP = 10, S_KO = 11, S_WIN = 12, S_GUARD = 13, S_DIZZY = 14, S_LOSE = 15;
  // match phases
  var P_INTRO = 0, P_FIGHT = 1, P_KO = 2, P_TIME = 3, P_END = 4;
  // moves
  var M_LP = 1, M_CP = 2, M_SK = 3, M_SW = 4, M_JP = 5, M_JK = 6, M_SP = 7, M_SU = 8;
  // events
  var E_HITL = 1, E_HITH = 2, E_BLOCK = 3, E_FIRE = 4, E_PHIT = 5, E_CLASH = 6, E_SUPER = 7, E_SHIT = 8,
    E_KO = 9, E_JUMP = 10, E_THUD = 11, E_SWING = 12, E_FIGHT = 13;

  /* Frame data. s = startup, a = active, r = recovery (frames at 60 Hz). box = hitbox [x1, x2, y1, y2]
   * relative to the feet, x toward the opponent. lvl: 0 mid, -1 low (crouch-block), 1 overhead (stand-block).
   * hs/bs = hitstun/blockstun, stop = hitstop frames. */
  var MOVES = {};
  MOVES[M_LP] = { s: 4, a: 3, r: 9, dmg: 5, chip: 0.5, hs: 16, bs: 10, push: 5.5, box: [18, 94, -134, -104], lvl: 0, stop: 4, chain: 1 };
  MOVES[M_CP] = { s: 4, a: 3, r: 9, dmg: 4, chip: 0.5, hs: 15, bs: 9, push: 5, box: [18, 92, -84, -54], lvl: 0, stop: 4, chain: 1, cr: 1 };
  MOVES[M_SK] = { s: 8, a: 4, r: 17, dmg: 10, chip: 1, hs: 21, bs: 14, push: 9, box: [24, 116, -122, -78], lvl: 0, stop: 7, heavy: 1 };
  MOVES[M_SW] = { s: 9, a: 4, r: 20, dmg: 9, chip: 1, hs: 0, bs: 14, push: 6, box: [22, 112, -30, 0], lvl: -1, stop: 7, heavy: 1, kd: 1, cr: 1 };
  MOVES[M_JP] = { s: 4, a: 12, r: 0, dmg: 6, chip: 0.5, hs: 17, bs: 10, push: 4, box: [10, 82, -96, -48], lvl: 1, stop: 5, air: 1 };
  MOVES[M_JK] = { s: 6, a: 12, r: 0, dmg: 9, chip: 1, hs: 20, bs: 12, push: 6, box: [8, 100, -74, -24], lvl: 1, stop: 7, heavy: 1, air: 1 };
  MOVES[M_SP] = { s: 12, a: 0, r: 24, dmg: 8, chip: 2, hs: 20, bs: 12, push: 6, lvl: 0, stop: 5 };
  MOVES[M_SU] = { s: 0, a: 26, r: 30, dmg: 6, chip: 6, lvl: 0, box: [0, 74, -160, -10] };
  var SUPER_HITS = [2, 9, 16, 23, 32];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mulberry(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /* =========================================================
   * Controller: held bits + press counters (presses between two sim frames are never lost)
   * ========================================================= */
  function Ctrl(kind) {
    this.kind = kind; this.held = 0; this.kb = 0; this.tp = 0;
    this.seq = [0, 0, 0, 0]; this.seen = [0, 0, 0, 0]; this.tog = 0;
    this.last = 0; this.lastAt = 0;
  }
  Ctrl.prototype.press = function (i) { this.seq[i]++; this.tog ^= B_TAP[i]; };
  Ctrl.prototype.sync = function () { if (this.kind !== 'ai' && this.kind !== 'remote') this.held = this.kb | this.tp; };
  Ctrl.prototype.remote = function (bits, t) {
    bits = (bits | 0) & INPUT.MASK;
    for (var i = 0; i < 4; i++) {
      var togged = (bits & B_TAP[i]) !== (this.last & B_TAP[i]);
      var rose = (bits & B_HELD[i]) && !(this.last & B_HELD[i]);
      if (togged || rose) this.seq[i]++;
    }
    this.held = bits & 127; this.last = bits; this.lastAt = t;
  };
  Ctrl.prototype.out = function () { return (this.held & 127) | this.tog; };

  /* =========================================================
   * Simulation
   * ========================================================= */
  function mkFighter(id) {
    return {
      id: id, x: 0, y: 0, vx: 0, vy: 0, face: id === 1 ? 1 : -1, st: S_IDLE, sf: 0, hp: MAXHP, meter: 0,
      mv: 0, sub: 0, hit: false, hitAt: 0, chain: 0, cd: 0, stun: 0, cr: false, inv: 0, combo: 0, cc: 0, ccT: 0,
      wd: 0, landT: 3, airUsed: false, pushV: 0, lastBack: -999, buf: [0, 0, 0, 0], held: 0, ko: false,
      atkId: 0, jumpId: 0, recT: 0, bufLen: 8, blockMem: 2, dmgDealt: 0
    };
  }

  function makeSim(o) {
    var rng = mulberry((o.seed ^ 0x5bd1e995) >>> 0);
    var g = {
      f: 0, r: 1, ph: P_INTRO, pt: 0, tm: ROUND_F, w: [0, 0], rw: 0, how: 0, mw: 0, frz: 0, frzBy: 0, hs: 0,
      slow: 0, evId: 0, ev: [], log: [], ended: false, show: !!o.show, plan: null, fightF: 0, koBy: 0,
      pr: [], prId: 0, perfect: false, rm: !!o.reducedMotion, human: !!o.human, tieBreak: 0
    };
    var F = [mkFighter(1), mkFighter(2)];
    var hist = [[], []], HN = 48;
    var meterMul = g.show ? 1.25 : 1;

    function introLen() { if (g.show) return g.r === 1 ? 84 : 54; return g.r === 1 ? (g.human ? 168 : 96) : 72; }
    function koLen() { return g.show ? 78 : (g.rm ? 84 : 104); }
    function endLen() { return g.show ? 96 : 120; }

    function emit(t, x, y, a) {
      var e = { id: ++g.evId, f: g.f, t: t, x: Math.round(x), y: Math.round(y), a: a | 0 };
      g.ev.push(e);
      return e;
    }
    function setSt(fi, st) { if (fi.st !== st) { fi.st = st; fi.sf = 0; } }
    function other(fi) { return fi === F[0] ? F[1] : F[0]; }
    function projOf(fi) { for (var i = 0; i < g.pr.length; i++) if (g.pr[i].o === fi.id) return g.pr[i]; return null; }
    function neutralSt(st) { return st === S_IDLE || st === S_WALK || st === S_CROUCH || st === S_GUARD; }
    function airborne(fi) { return fi.y < -0.01 || fi.vy < 0; }

    function resetRound() {
      for (var i = 0; i < 2; i++) {
        var fi = F[i], keep = fi.meter, mem = fi.blockMem, bl = fi.bufLen, dd = fi.dmgDealt;
        var n = mkFighter(fi.id);
        for (var k in n) fi[k] = n[k];
        fi.meter = keep; fi.blockMem = mem; fi.bufLen = bl; fi.dmgDealt = dd;
        fi.x = i === 0 ? 330 : 630;
      }
      g.pr = []; g.tm = ROUND_F; g.fightF = 0; g.hs = 0; g.frz = 0; g.slow = 0; g.koBy = 0; g.perfect = false;
    }

    /* ----- show-mode director: AI vs AI that always ends with forcedWinner, about 16-19 s total ----- */
    function makePlan(winner) {
      var loser = winner === 1 ? 2 : 1, three = rng() < 0.38;
      var seq = three ? (rng() < 0.5 ? [loser, winner, winner] : [winner, loser, winner]) : [winner, winner];
      var over = 84 + (seq.length - 1) * 54 + seq.length * 78 + 96;
      var total = (three ? 16.9 : 15.5) * FPS + (rng() - 0.5) * 50;
      var each = (total - over) / seq.length, rounds = [], sum = 0, i;
      for (i = 0; i < seq.length; i++) { var wgt = 0.85 + rng() * 0.3; rounds.push({ w: seq[i], T: each * wgt, fw: 22 + rng() * 50 }); sum += wgt; }
      for (i = 0; i < rounds.length; i++) rounds[i].T = Math.max(150, Math.round(rounds[i].T * seq.length / sum));
      return { rounds: rounds };
    }
    function roundPlan() { return g.plan ? g.plan.rounds[Math.min(g.r, g.plan.rounds.length) - 1] : null; }
    function progress() { var rp = roundPlan(); return rp ? g.fightF / rp.T : 0; }
    function directDamage(d, amount) {
      var rp = roundPlan(); if (!rp) return amount;
      var p = g.fightF / rp.T;
      if (d.id === rp.w) {
        var target = 100 - (100 - rp.fw) * Math.min(1, p + 0.1);
        var floor = Math.max(rp.fw * 0.75, 8);
        var k = clamp((d.hp - target) / Math.max(amount, 0.1), 0.15, 1.3);
        return clamp(amount * k, 0, Math.max(0, d.hp - floor));
      }
      var tgt = 100 * Math.max(0, 1 - Math.min(1.25, p * 1.08 + 0.2));
      var kk = clamp((d.hp - tgt) / Math.max(amount, 0.1), 0.6, 3.6);
      if (p >= 1) kk = Math.max(kk, 3.2);
      var out = amount * kk;
      if (p < 0.82) out = Math.min(out, Math.max(0, d.hp - Math.max(2, 100 * (1 - p) - 20)));
      return out;
    }
    function director() {
      var rp = roundPlan(); if (!rp || g.ph !== P_FIGHT) return;
      var p = g.fightF / rp.T, loser = F[rp.w === 1 ? 1 : 0], win = F[rp.w - 1];
      if (p > 1.06 && neutralSt(loser.st) && !airborne(loser)) { setSt(loser, S_DIZZY); loser.vx = 0; loser.stun = 999; }
      if (p > 1.22) {
        emit(E_HITH, loser.x - win.face * 10, GROUND - 110, 1);
        loser.hp = 0; win.dmgDealt += 1; doKO(loser, win);
      }
    }

    /* ----- damage, KO ----- */
    function damage(d, a, amount) {
      if (g.ph !== P_FIGHT) return 0;
      if (g.show) amount = directDamage(d, amount);
      amount = Math.max(0, amount);
      d.hp -= amount; a.dmgDealt += amount;
      if (d.hp <= 0.001) { d.hp = 0; doKO(d, a); }
      return amount;
    }
    function doKO(d, a) {
      if (g.ph !== P_FIGHT) return;
      g.ph = P_KO; g.pt = 0; g.koBy = a.id; g.rw = a.id;
      g.perfect = a.hp >= MAXHP - 0.001; g.how = g.perfect ? 1 : 0;
      g.slow = g.rm ? 18 : 48; g.hs = 0;
      d.ko = true;
      if (d.st !== S_DOWN) knockDown(d, a, true);
      emit(E_KO, d.x, GROUND + d.y - 100, a.id);
    }
    function knockDown(d, a, launch) {
      var dir = d.x >= a.x ? 1 : -1;
      setSt(d, S_DOWN); d.sub = 0; d.stun = 0; d.cr = false;
      d.vy = launch ? -8.5 : -3.2; d.vx = dir * (launch ? 4.2 : 2.4);
      if (d.y >= 0) d.y = -0.5;
      d.inv = 999;
    }
    function knock(d, a, push) {
      var dir = d.x >= a.x ? 1 : -1;
      d.pushV = dir * push;
      var atWall = (dir > 0 && d.x >= WALL_R - 6) || (dir < 0 && d.x <= WALL_L + 6);
      if (atWall && !airborne(a)) a.pushV = -dir * push * 0.85;
    }
    function canBlock(d, srcX, lvl) {
      if (airborne(d)) return false;
      if (!(neutralSt(d.st) || d.st === S_BLOCK)) return false;
      var tow = srcX >= d.x ? RIGHT : LEFT, away = tow === RIGHT ? LEFT : RIGHT;
      var back = d.st === S_BLOCK || ((d.held & away) && !(d.held & tow)) || (g.f - d.lastBack <= d.blockMem);
      if (!back) return false;
      var low = (d.held & DOWN) !== 0 || (d.st === S_BLOCK && d.cr && !(d.held & UP) && d.held === 0);
      if (lvl === -1 && !low) return false;
      if (lvl === 1 && low) return false;
      return true;
    }
    function comboScale(d) { return Math.max(0.5, 1 - 0.1 * (d.combo - 1)); }
    function registerHit(d, a) {
      if (d.st === S_HIT || (d.st === S_DOWN && d.sub === 0)) d.combo++; else d.combo = 1;
      a.cc = d.combo; a.ccT = 80;
    }

    function strike(a, d, m) {
      a.hit = true; a.hitAt = a.sf;
      var px = d.x - (d.x >= a.x ? 1 : -1) * 22, py = GROUND + a.y + (m.box[2] + m.box[3]) / 2;
      if (canBlock(d, a.x, m.lvl)) {
        d.cr = (d.held & DOWN) !== 0;
        damage(d, a, m.chip);
        setSt(d, S_BLOCK); d.sf = 0; d.stun = m.bs; d.vx = 0;
        knock(d, a, m.push * 0.9);
        a.meter = Math.min(MAXM, a.meter + m.dmg * 0.4 * meterMul); d.meter = Math.min(MAXM, d.meter + 1.5 * meterMul);
        g.hs = Math.max(g.hs, 3);
        emit(E_BLOCK, px, py, a.id);
        return;
      }
      var air = airborne(d);
      registerHit(d, a);
      var amt = damage(d, a, m.dmg * comboScale(d));
      a.meter = Math.min(MAXM, a.meter + amt * 1.4 * meterMul); d.meter = Math.min(MAXM, d.meter + amt * 0.8 * meterMul);
      if (g.ph === P_FIGHT) {
        if (air || m.kd) knockDown(d, a, air);
        else { var wasCr = d.cr && (d.held & DOWN); setSt(d, S_HIT); d.sf = 0; d.stun = m.hs; d.cr = !!wasCr; d.vx = 0; knock(d, a, m.push); }
      }
      g.hs = Math.max(g.hs, m.stop);
      emit(m.heavy ? E_HITH : E_HITL, px, py, a.id);
    }

    function startMove(fi, mv) {
      var m = MOVES[mv];
      setSt(fi, S_ATK); fi.sf = 0; fi.mv = mv; fi.sub = 0; fi.hit = false; fi.hitAt = 0; fi.atkId++;
      if (!m.air) fi.vx = 0;
      fi.cr = !!m.cr;
      if (mv === M_LP || mv === M_CP) fi.chain++; else if (mv !== M_SP && mv !== M_SU) fi.chain = 0;
      emit(E_SWING, fi.x, GROUND + fi.y - 100, mv * 4 + fi.id);
    }
    function startSuper(fi) {
      startMove(fi, M_SU);
      fi.meter = 0; fi.inv = 200; fi.chain = 0;
      g.frz = 42; g.frzBy = fi.id;
      emit(E_SUPER, fi.x, GROUND + fi.y - 110, fi.id);
    }
    function tryButtons(fi, crouching, chainFrom) {
      // chainFrom: the move being cancelled (0 = neutral). Returns true when a move started.
      if (fi.buf[3] > 0) {
        fi.buf[3] = 0;
        if (fi.meter >= MAXM) { startSuper(fi); return true; }
        if (fi.cd <= 0 && !projOf(fi)) { startMove(fi, M_SP); return true; }
        if (!chainFrom) return false;
      }
      if (fi.buf[2] > 0 && (!chainFrom || chainFrom === M_LP || chainFrom === M_CP)) {
        fi.buf[2] = 0; startMove(fi, crouching ? M_SW : M_SK); return true;
      }
      if (fi.buf[1] > 0 && (!chainFrom || ((chainFrom === M_LP || chainFrom === M_CP) && fi.chain < 3))) {
        fi.buf[1] = 0; startMove(fi, crouching ? M_CP : M_LP); return true;
      }
      if (!chainFrom) fi.chain = 0;
      return false;
    }
    function threatNear(fi, op) {
      var dist = Math.abs(op.x - fi.x);
      if (op.st === S_ATK) {
        if (op.mv === M_SU) return true;
        if (op.mv !== M_SP && dist < 230) return true;
        if (op.mv === M_SP && op.sf < MOVES[M_SP].s) return true;
      }
      var p = projOf(op);
      if (p && Math.abs(p.x - fi.x) < 300 && (p.x - fi.x) * p.vx < 0) return true;
      if (airborne(op) && dist < 230) return true;
      return false;
    }
    function neutral(fi, op) {
      var h = fi.held, tow = op.x >= fi.x ? RIGHT : LEFT, away = tow === RIGHT ? LEFT : RIGHT, dirT = tow === RIGHT ? 1 : -1;
      var hb = (h & away) && !(h & tow), hf = (h & tow) && !(h & away), dn = (h & DOWN) !== 0;
      if (tryButtons(fi, dn, 0)) return;
      if (fi.buf[0] > 0 || (h & UP)) { fi.buf[0] = 0; setSt(fi, S_PREJUMP); fi.vx = 0; fi.cr = false; return; }
      var threat = threatNear(fi, op);
      if (dn) { setSt(fi, hb && threat ? S_GUARD : S_CROUCH); fi.cr = true; fi.vx = 0; return; }
      if (fi.st === S_CROUCH || (fi.st === S_GUARD && fi.cr)) { fi.st = S_IDLE; fi.sf = 0; }
      fi.cr = false;
      if (hf) { if (fi.st !== S_WALK || fi.wd !== 1) { setSt(fi, S_WALK); } fi.wd = 1; fi.vx = dirT * WALK_F; return; }
      if (hb) {
        if (threat) { setSt(fi, S_GUARD); fi.vx = 0; }
        else { setSt(fi, S_WALK); fi.wd = -1; fi.vx = -dirT * WALK_B; }
        return;
      }
      setSt(fi, S_IDLE); fi.vx = 0;
    }

    function updAtk(fi, op, ctl) {
      var m = MOVES[fi.mv];
      if (fi.mv === M_SU) { updSuper(fi, op); return; }
      if (m.air) {
        // stays airborne until landing (handled by physics)
        if (fi.sf > m.s + m.a) fi.sub = 1;
        return;
      }
      fi.vx *= 0.6;
      if (fi.mv === M_SP && fi.sf === m.s) {
        var pr = { id: ++g.prId, o: fi.id, x: fi.x + fi.face * 64, y: PROJ_Y, vx: fi.face * PROJ_V, age: 0 };
        g.pr.push(pr); fi.cd = PROJ_CD;
        fi.meter = Math.min(MAXM, fi.meter + 3 * meterMul);
        emit(E_FIRE, pr.x, GROUND + pr.y, fi.id);
      }
      var total = m.s + m.a + m.r;
      if (ctl && fi.hit && fi.sf > fi.hitAt && fi.sf <= m.s + m.a + Math.ceil(m.r * 0.75) && (m.chain || m.heavy)) {
        if (tryButtons(fi, (fi.held & DOWN) !== 0, fi.mv)) return;
      }
      if (fi.sf >= total) {
        var dn = ctl && (fi.held & DOWN);
        setSt(fi, dn ? S_CROUCH : S_IDLE); fi.cr = !!dn; fi.mv = 0;
        if (ctl) neutral(fi, op);
      }
    }
    function updSuper(fi, op) {
      if (fi.sub === 0) { fi.sub = 1; fi.sf = 0; }
      if (fi.sub === 1) {
        fi.vx = fi.face * 13; fi.inv = Math.max(fi.inv, 2);
        if (fi.sf > MOVES[M_SU].a) { fi.sub = 3; fi.sf = 0; fi.vx = 0; fi.recT = 30; fi.inv = 0; }
        return;
      }
      if (fi.sub === 2) {
        fi.vx = 0; fi.inv = Math.max(fi.inv, 2);
        var want = fi.x + fi.face * 74;
        if (want > WALL_R || want < WALL_L) { op.x = clamp(want, WALL_L, WALL_R); fi.x = op.x - fi.face * 74; }
        else op.x = want;
        op.y = op.y * 0.7; op.vy = 0;
        var idx = SUPER_HITS.indexOf(fi.sf);
        if (idx >= 0 && g.ph === P_FIGHT) {
          var last = idx === SUPER_HITS.length - 1;
          var amt = damage(op, fi, MOVES[M_SU].dmg * fi.comboK);
          op.combo++; fi.cc = op.combo; fi.ccT = 80;
          op.meter = Math.min(MAXM, op.meter + amt * 0.5 * meterMul);
          g.hs = Math.max(g.hs, last ? 10 : 4);
          emit(E_SHIT, op.x - fi.face * 24, GROUND + op.y - 100 + (idx % 2) * 30, fi.id * 8 + idx);
          if (last && g.ph === P_FIGHT) { knockDown(op, fi, true); op.vx = fi.face * 6; op.vy = -9.5; }
        }
        if (g.ph !== P_FIGHT && op.st !== S_DOWN) { /* KO mid-combo: doKO already knocked down */ }
        if (fi.sf >= 40 || (g.ph !== P_FIGHT && fi.sf > 4)) { fi.sub = 3; fi.sf = 0; fi.recT = 24; fi.inv = 0; if (op.st === S_HIT) knockDown(op, fi, true); }
        return;
      }
      fi.vx *= 0.7;
      if (fi.sf >= fi.recT) { setSt(fi, S_IDLE); fi.mv = 0; fi.sub = 0; }
    }
    function superContact(a, d) {
      if (canBlock(d, a.x, 0)) {
        damage(d, a, MOVES[M_SU].chip);
        d.cr = (d.held & DOWN) !== 0; setSt(d, S_BLOCK); d.sf = 0; d.stun = 28; d.vx = 0; knock(d, a, 12);
        a.sub = 3; a.sf = 0; a.vx = 0; a.recT = 26; a.inv = 0; a.hit = true;
        g.hs = Math.max(g.hs, 8);
        emit(E_BLOCK, d.x - a.face * 22, GROUND + d.y - 100, a.id + 8);
        return;
      }
      registerHit(d, a);
      a.comboK = comboScale(d);
      a.sub = 2; a.sf = 0; a.vx = 0; a.hit = true;
      setSt(d, S_HIT); d.stun = 999; d.vx = 0; d.pushV = 0; d.cr = false;
    }

    function hurt(fi) {
      var x1, x2, y1, y2;
      if (airborne(fi) && fi.st !== S_DOWN) { x1 = -26; x2 = 26; y1 = -150; y2 = -10; }
      else if (fi.cr || fi.st === S_CROUCH) { x1 = -32; x2 = 32; y1 = -112; y2 = 0; }
      else { x1 = -30; x2 = 30; y1 = -176; y2 = 0; }
      var b = [fi.x + x1, fi.x + x2, GROUND + fi.y + y1, GROUND + fi.y + y2];
      if (fi.st === S_ATK && fi.mv !== M_SU && fi.mv !== M_SP) {
        var m = MOVES[fi.mv];
        if (fi.sf > m.s && fi.sf <= m.s + m.a + m.r) {
          var ex = m.box[1] - 26;
          if (fi.face > 0) b[1] = Math.max(b[1], fi.x + ex); else b[0] = Math.min(b[0], fi.x - ex);
        }
      }
      return b;
    }
    function hitbox(fi, box) {
      var xa = fi.x + fi.face * box[0], xb = fi.x + fi.face * box[1];
      return [Math.min(xa, xb), Math.max(xa, xb), GROUND + fi.y + box[2], GROUND + fi.y + box[3]];
    }
    function overlap(a, b) { return a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3]; }
    function hittable(d) { return d.inv <= 0 && d.st !== S_DOWN && d.st !== S_GETUP && d.st !== S_KO; }

    function checkHits() {
      var res = [], i;
      for (i = 0; i < 2; i++) {
        var a = F[i], d = F[1 - i];
        if (a.st !== S_ATK || a.hit) continue;
        if (a.mv === M_SU) {
          if (a.sub === 1 && hittable(d) && overlap(hitbox(a, MOVES[M_SU].box), hurt(d))) res.push([a, d, null]);
          continue;
        }
        var m = MOVES[a.mv];
        if (!m.box || a.sf <= m.s || a.sf > m.s + m.a) continue;
        if (hittable(d) && overlap(hitbox(a, m.box), hurt(d))) res.push([a, d, m]);
      }
      if (res.length === 2 && (g.f & 1)) res.reverse();
      for (i = 0; i < res.length; i++) {
        if (g.ph !== P_FIGHT) break;
        if (!res[i][2]) superContact(res[i][0], res[i][1]); else strike(res[i][0], res[i][1], res[i][2]);
      }
    }

    function updProjectiles() {
      var i, j, p, q, keep = [];
      for (i = 0; i < g.pr.length; i++) {
        p = g.pr[i]; p.x += p.vx; p.age++;
        if (p.x < -60 || p.x > 1020) continue;
        var d = F[p.o === 1 ? 1 : 0], a = F[p.o - 1];
        if (g.ph === P_FIGHT && hittable(d)) {
          var hb = hurt(d), py = GROUND + p.y;
          if (p.x + PROJ_R > hb[0] && p.x - PROJ_R < hb[1] && py + PROJ_R > hb[2] && py - PROJ_R < hb[3]) {
            var m = MOVES[M_SP];
            if (canBlock(d, p.x - p.vx * 20, 0)) {
              d.cr = (d.held & DOWN) !== 0; damage(d, a, m.chip);
              setSt(d, S_BLOCK); d.sf = 0; d.stun = m.bs; d.vx = 0; d.pushV = (p.vx > 0 ? 1 : -1) * 5;
              d.meter = Math.min(MAXM, d.meter + 1.5 * meterMul);
              g.hs = Math.max(g.hs, 4);
              emit(E_BLOCK, p.x, py, a.id + 16);
            } else {
              var air = airborne(d);
              registerHit(d, a);
              var amt = damage(d, a, m.dmg * comboScale(d));
              a.meter = Math.min(MAXM, a.meter + amt * 1.2 * meterMul); d.meter = Math.min(MAXM, d.meter + amt * 0.8 * meterMul);
              if (g.ph === P_FIGHT) {
                if (air) knockDown(d, a, true);
                else { setSt(d, S_HIT); d.sf = 0; d.stun = m.hs; d.vx = 0; d.pushV = (p.vx > 0 ? 1 : -1) * m.push; d.cr = false; }
              }
              g.hs = Math.max(g.hs, m.stop);
              emit(E_PHIT, p.x, py, a.id);
            }
            continue;
          }
        }
        keep.push(p);
      }
      g.pr = keep;
      for (i = 0; i < g.pr.length; i++) for (j = i + 1; j < g.pr.length; j++) {
        p = g.pr[i]; q = g.pr[j];
        if (p.o !== q.o && Math.abs(p.x - q.x) < PROJ_R * 1.8 && Math.abs(p.y - q.y) < PROJ_R * 2) {
          emit(E_CLASH, (p.x + q.x) / 2, GROUND + p.y, 0);
          p.dead = q.dead = true;
        }
      }
      g.pr = g.pr.filter(function (z) { return !z.dead; });
    }

    function physics(fi) {
      var wasAir = airborne(fi);
      if (wasAir) {
        fi.vy += GRAV; fi.y += fi.vy; fi.x += fi.vx;
        if (fi.y >= 0) land(fi);
      } else {
        fi.x += fi.vx;
        if (fi.st === S_HIT || fi.st === S_BLOCK || fi.st === S_DOWN || fi.st === S_KO || fi.st === S_LAND) fi.vx *= 0.8;
      }
      fi.x += fi.pushV; fi.pushV *= 0.8; if (Math.abs(fi.pushV) < 0.05) fi.pushV = 0;
      fi.x = clamp(fi.x, WALL_L, WALL_R);
    }
    function land(fi) {
      fi.y = 0; fi.vy = 0;
      if (fi.st === S_JUMP || (fi.st === S_ATK && MOVES[fi.mv] && MOVES[fi.mv].air)) {
        var atk = fi.st === S_ATK;
        setSt(fi, S_LAND); fi.landT = atk ? 5 : 3; fi.vx = 0; fi.mv = 0; fi.airUsed = false;
      } else if (fi.st === S_DOWN) {
        if (fi.sub === 0) { fi.sub = 1; fi.sf = 0; fi.vx *= 0.3; emit(E_THUD, fi.x, GROUND, fi.id); }
        if (fi.ko) { setSt(fi, S_KO); }
      }
    }
    function separate() {
      var a = F[0], b = F[1];
      var ay1 = airborne(a) ? a.y - 110 : -130, ay2 = airborne(a) ? a.y - 30 : 0;
      var by1 = airborne(b) ? b.y - 110 : -130, by2 = airborne(b) ? b.y - 30 : 0;
      if (!(ay1 < by2 && by1 < ay2)) return;
      var dx = b.x - a.x, ov = 2 * PUSH_HALF - Math.abs(dx);
      if (ov <= 0) return;
      var dir = dx > 0 ? 1 : dx < 0 ? -1 : (a.face > 0 ? 1 : -1);
      var sa = 0.5, sb = 0.5;
      if (airborne(a) && !airborne(b)) { sa = 1; sb = 0; } else if (airborne(b) && !airborne(a)) { sa = 0; sb = 1; }
      a.x -= dir * ov * sa; b.x += dir * ov * sb;
      if (a.x < WALL_L) { b.x += WALL_L - a.x; a.x = WALL_L; } if (a.x > WALL_R) { b.x -= a.x - WALL_R; a.x = WALL_R; }
      if (b.x < WALL_L) { a.x += WALL_L - b.x; b.x = WALL_L; } if (b.x > WALL_R) { a.x -= b.x - WALL_R; b.x = WALL_R; }
    }
    function faceEachOther() {
      for (var i = 0; i < 2; i++) {
        var fi = F[i], op = F[1 - i];
        if (neutralSt(fi.st) || fi.st === S_PREJUMP || fi.st === S_LAND || fi.st === S_WIN || fi.st === S_LOSE || fi.st === S_DIZZY) {
          if (Math.abs(op.x - fi.x) > 4) fi.face = op.x > fi.x ? 1 : -1;
        }
      }
    }

    function updFighter(fi, op, ctl) {
      fi.sf++;
      if (fi.inv > 0 && fi.inv < 900) fi.inv--;
      if (fi.cd > 0) fi.cd--;
      if (fi.ccT > 0) fi.ccT--;
      switch (fi.st) {
        case S_IDLE: case S_WALK: case S_CROUCH: case S_GUARD:
          if (ctl) neutral(fi, op); else { if (fi.st !== S_IDLE) setSt(fi, S_IDLE); fi.vx = 0; fi.cr = false; }
          if (fi.st !== S_HIT && fi.st !== S_BLOCK) fi.combo = 0;
          break;
        case S_PREJUMP:
          if (fi.sf >= 4) {
            var h = fi.held, jd = (h & RIGHT) && !(h & LEFT) ? 1 : (h & LEFT) && !(h & RIGHT) ? -1 : 0;
            setSt(fi, S_JUMP); fi.vy = JUMP_VY; fi.vx = jd * JUMP_VX; fi.y = -0.5; fi.airUsed = false; fi.jumpId++;
            emit(E_JUMP, fi.x, GROUND, fi.id);
          }
          break;
        case S_JUMP:
          if (ctl && !fi.airUsed && fi.sf > 2) {
            if (fi.buf[2] > 0) { fi.buf[2] = 0; fi.airUsed = true; startMove(fi, M_JK); }
            else if (fi.buf[1] > 0) { fi.buf[1] = 0; fi.airUsed = true; startMove(fi, M_JP); }
          }
          break;
        case S_LAND:
          fi.vx = 0;
          if (fi.sf >= fi.landT) { setSt(fi, S_IDLE); if (ctl) neutral(fi, op); }
          break;
        case S_ATK: updAtk(fi, op, ctl); break;
        case S_HIT:
          if (fi.stun < 900 && --fi.stun <= 0) { setSt(fi, S_IDLE); fi.combo = 0; if (ctl) neutral(fi, op); }
          break;
        case S_BLOCK:
          if (--fi.stun <= 0) { setSt(fi, fi.cr ? S_CROUCH : S_IDLE); if (ctl) neutral(fi, op); }
          break;
        case S_DOWN:
          if (fi.sub === 1 && fi.sf >= 40 && !fi.ko) { setSt(fi, S_GETUP); fi.inv = 0; }
          break;
        case S_GETUP:
          fi.inv = 0;
          if (fi.sf >= 24) { setSt(fi, S_IDLE); fi.combo = 0; fi.inv = 6; }
          break;
        default: fi.vx = 0;
      }
    }

    function readInput(fi, c, frozen) {
      var i, n = 0;
      for (i = 0; i < 4; i++) {
        var d = c.seq[i] - c.seen[i];
        c.seen[i] = c.seq[i];
        if (d > 0) fi.buf[i] = fi.bufLen;
        else if (!frozen && fi.buf[i] > 0) fi.buf[i]--;
        n += d;
      }
      fi.held = c.held & 127;
      var tow = F[fi.id === 1 ? 1 : 0].x >= fi.x ? RIGHT : LEFT, away = tow === RIGHT ? LEFT : RIGHT;
      if ((fi.held & away) && !(fi.held & tow)) fi.lastBack = g.f;
      return n;
    }

    function record() {
      for (var i = 0; i < 2; i++) {
        var fi = F[i], p = projOf(fi);
        hist[i][g.f % HN] = {
          x: fi.x, y: fi.y, vx: fi.vx, vy: fi.vy, st: fi.st, sf: fi.sf, mv: fi.mv, sub: fi.sub, atkId: fi.atkId,
          jumpId: fi.jumpId, air: airborne(fi), meter: fi.meter, hit: fi.hit,
          prId: p ? p.id : 0, prx: p ? p.x : 0, prvx: p ? p.vx : 0
        };
      }
    }
    function obs(id, delay) {
      var f = Math.max(0, g.f - Math.min(HN - 2, delay));
      return hist[id - 1][f % HN] || hist[id - 1][g.f % HN];
    }

    function endRound(winner, how) {
      g.log.push({ winner: winner, hp1: Math.ceil(F[0].hp), hp2: Math.ceil(F[1].hp), how: ['ko', 'perfect', 'time', 'draw'][how] || 'ko', secs: Math.round(g.fightF / FPS * 10) / 10 });
      if (winner === 1 || winner === 2) g.w[winner - 1]++;
      if (g.w[0] >= 2 || g.w[1] >= 2 || g.r >= 3) {
        var mw = g.w[0] > g.w[1] ? 1 : g.w[1] > g.w[0] ? 2 : 0;
        if (!mw) { mw = F[0].hp > F[1].hp ? 1 : F[1].hp > F[0].hp ? 2 : F[0].dmgDealt > F[1].dmgDealt ? 1 : F[1].dmgDealt > F[0].dmgDealt ? 2 : (rng() < 0.5 ? 1 : 2); g.tieBreak = 1; }
        if (g.show && g.forced) mw = g.forced;
        g.mw = mw; g.ph = P_END; g.pt = 0;
        var w = F[mw - 1], l = F[mw === 1 ? 1 : 0];
        w.ko = false; setSt(w, S_WIN); w.vx = 0; w.y = 0; w.vy = 0; w.mv = 0;
        if (l.st !== S_KO && l.st !== S_DOWN) { setSt(l, S_LOSE); l.vx = 0; l.y = 0; l.vy = 0; l.mv = 0; }
        g.pr = [];
        return;
      }
      g.r++; resetRound(); g.ph = P_INTRO; g.pt = 0;
    }

    function step(ctrls, ais) {
      g.f++;
      var frozen = g.frz > 0 || g.hs > 0, i;
      for (i = 0; i < 2; i++) if (ais[i]) ais[i]();
      for (i = 0; i < 2; i++) readInput(F[i], ctrls[i], frozen);
      if (g.ph === P_INTRO) {
        g.pt++;
        for (i = 0; i < 2; i++) { F[i].sf++; F[i].buf = [0, 0, 0, 0]; }
        if (g.pt >= introLen()) { g.ph = P_FIGHT; g.pt = 0; emit(E_FIGHT, 480, 200, g.r); }
        record(); return;
      }
      if (g.ph === P_END) {
        g.pt++;
        for (i = 0; i < 2; i++) { var e = F[i]; e.sf++; if (airborne(e)) physics(e); }
        if (g.pt >= endLen()) g.ended = true;
        record(); return;
      }
      // the round clock (and the show director's clock) keep running through hitstop; a super freeze pauses the timer only
      if (g.ph === P_FIGHT) { g.pt++; g.fightF++; if (!g.frz) g.tm = Math.max(0, g.tm - 1); }
      if (g.frz > 0) { g.frz--; F[g.frzBy - 1].sf = 0; record(); return; }
      if (g.hs > 0) { g.hs--; record(); return; }
      var fight = g.ph === P_FIGHT;
      if (!fight) {
        g.pt++;
        if (g.slow > 0) { g.slow--; if (g.slow % 3) { record(); return; } }
      } else if (g.show) director();
      var order = (g.f & 1) ? [1, 0] : [0, 1];
      for (i = 0; i < 2; i++) { var k = order[i]; updFighter(F[k], F[1 - k], fight && g.ph === P_FIGHT); }
      for (i = 0; i < 2; i++) physics(F[i]);
      separate();
      faceEachOther();
      if (g.ph === P_FIGHT) checkHits();
      updProjectiles();
      if (g.ph === P_FIGHT && g.tm <= 0) {
        g.ph = P_TIME; g.pt = 0;
        var w = F[0].hp > F[1].hp + 0.001 ? 1 : F[1].hp > F[0].hp + 0.001 ? 2 : 0;
        if (g.show) { var rp = roundPlan(); w = rp ? rp.w : w; }
        g.rw = w || 3; g.how = w ? 2 : 3;
        emit(E_KO, 480, 200, 0);
      }
      if (g.ph === P_KO) {
        var win = F[g.koBy - 1];
        if (g.pt > 54 && win.st !== S_WIN && (neutralSt(win.st) || win.st === S_LAND || win.st === S_BLOCK || (win.st === S_ATK && !airborne(win) && win.mv !== M_SU))) { setSt(win, S_WIN); win.vx = 0; win.mv = 0; }
        if (g.pt >= koLen()) endRound(g.koBy, g.how);
      } else if (g.ph === P_TIME) {
        if (g.pt === 40) {
          for (i = 0; i < 2; i++) {
            var fi = F[i];
            if (airborne(fi) || fi.st === S_DOWN || fi.st === S_GETUP) continue;
            if (g.rw === fi.id) setSt(fi, S_WIN); else if (g.rw !== 3) setSt(fi, S_LOSE); else setSt(fi, S_IDLE);
            fi.vx = 0; fi.mv = 0;
          }
        }
        if (g.pt >= 110) endRound(g.rw === 3 ? 0 : g.rw, g.how);
      }
      record();
    }

    resetRound();
    if (g.show) { g.forced = o.forcedWinner; g.plan = makePlan(o.forcedWinner); for (var q = 0; q < 2; q++) F[q].meter = 30; }
    record();
    return { g: g, F: F, step: step, obs: obs, projOf: projOf, airborne: airborne, progress: progress, roundPlan: roundPlan, rng: rng };
  }

  /* =========================================================
   * AI: a virtual pad. Sees the opponent with a reaction delay, blocks, anti-airs, zones, combos.
   * ========================================================= */
  function makeAI(sim, idx, ctrl, level, seed, flashy) {
    var rng = mulberry(seed >>> 0), F = sim.F, g = sim.g;
    var me = F[idx], op = F[1 - idx];
    var S = { next: 0, intent: 0, until: 0, seenAtk: -1, seenJump: -1, seenProj: -1, blockUntil: 0, blockLow: false,
      aa: false, jumpProj: 0, jumpAtk: 0, chain: [], chainFor: -1, punished: -1, lastSuperTry: -999 };
    function lv() {
      var L = level;
      if (g.show) {
        var rp = sim.roundPlan(), p = sim.progress();
        if (rp) { if (rp.w === me.id) L = level + 0.1 + Math.max(0, p - 0.7) * 0.6; else L = level - Math.max(0, p - 0.6) * 0.9; }
      }
      return clamp(L, 0, 1);
    }
    function press(i) { ctrl.press(i); }
    function actionable(f) { return f.st === S_IDLE || f.st === S_WALK || f.st === S_CROUCH || f.st === S_GUARD; }
    return function think() {
      if (g.ph !== P_FIGHT) { ctrl.held = 0; S.chain = []; return; }
      if (g.frz > 0 || g.hs > 0) return;
      var L = lv(), react = Math.round(26 - 15 * L) + Math.floor(rng() * 4);
      var o = sim.obs(op.id, react);
      var dirT = o.x >= me.x ? 1 : -1, FWD = dirT > 0 ? RIGHT : LEFT, BACK = dirT > 0 ? LEFT : RIGHT;
      var dist = Math.abs(o.x - me.x), held = 0;
      var blockP = (g.show ? 0.18 : 0.22) + 0.6 * L, aaP = 0.15 + 0.6 * L, punishP = 0.2 + 0.6 * L;
      var canAct = actionable(me);
      // --- defence (reacting to the delayed view) ---
      if (o.st === S_ATK && o.atkId !== S.seenAtk) {
        S.seenAtk = o.atkId;
        var m = MOVES[o.mv];
        if (o.mv === M_SU) { if (rng() < blockP * 0.85) { S.blockUntil = g.f + 46; S.blockLow = false; } }
        else if (o.mv !== M_SP && m && m.box && dist < m.box[1] + 60 && o.sf <= m.s + 1) {
          if (rng() < blockP) { S.blockUntil = g.f + 20 + Math.floor(rng() * 10); S.blockLow = o.mv === M_SW || (o.mv === M_CP && rng() < 0.6); if (m.air) S.blockLow = false; }
        }
      }
      if (o.air && o.jumpId !== S.seenJump && dist < 330) {
        S.seenJump = o.jumpId;
        var r = rng();
        if (r < aaP) S.aa = true;
        else if (r < aaP + blockP * 0.8) { S.blockUntil = g.f + 44; S.blockLow = false; }
      }
      if (!o.air) S.aa = false;
      if (S.aa && canAct && o.air && dist < 118 && o.y > -150 && o.vy > -2) { S.aa = false; press(2); ctrl.held = 0; return; }
      if (o.prId && o.prId !== S.seenProj && (o.prx - me.x) * o.prvx < 0 && Math.abs(o.prx - me.x) < 360) {
        S.seenProj = o.prId;
        var rr = rng(), pd = Math.abs(o.prx - me.x);
        if (rr < 0.12 + 0.3 * L) S.jumpProj = o.prId;
        else if (rr < 0.12 + 0.3 * L + blockP * 0.9) { S.blockUntil = g.f + Math.round(pd / PROJ_V) + 14; S.blockLow = false; }
        else if (me.cd <= 0 && pd > 240 && rng() < 0.6) { press(3); }
      }
      if (S.jumpProj && canAct) {
        var pr = sim.projOf(op);
        if (!pr || pr.id !== S.jumpProj) S.jumpProj = 0;
        else if (Math.abs(pr.x - me.x) < 150 + 40 * rng()) { S.jumpProj = 0; S.jumpAtk = 1; ctrl.held = UP | (dist < 340 ? FWD : 0); press(0); return; }
      }
      // air attack timing
      if (sim.airborne(me) && me.st === S_JUMP && !me.airUsed) {
        var near = Math.abs(op.x - me.x);
        if ((S.jumpAtk || rng() < 0.04) && me.vy > -4 && near < 150 && me.y < -30) { S.jumpAtk = 0; press(rng() < 0.65 ? 2 : 1); }
        ctrl.held = 0; return;
      }
      // combo follow-ups
      if (me.st === S_ATK) {
        if (me.hit && S.chain.length && S.chainFor !== me.atkId && me.sf > me.hitAt) {
          S.chainFor = me.atkId; var nb = S.chain.shift();
          if (nb === 3 && me.cd > 0 && me.meter < MAXM) nb = 2;
          press(nb);
        }
        ctrl.held = (me.mv === M_CP || me.mv === M_SW) ? DOWN : 0;
        return;
      }
      if (me.st === S_BLOCK) { ctrl.held = BACK | (me.cr ? DOWN : 0); return; }
      if (!canAct) { ctrl.held = 0; return; }
      if (g.f < S.blockUntil) { ctrl.held = BACK | (S.blockLow ? DOWN : 0); return; }
      // punish whiffs / recovery
      var ms = o.st === S_ATK ? MOVES[o.mv] : null;
      if (ms && o.atkId !== S.punished && o.mv !== M_SU) {
        var rec = o.sf > ms.s + ms.a && !ms.air;
        if (rec && dist < (o.mv === M_SP ? 330 : 135)) {
          S.punished = o.atkId;
          if (rng() < punishP) {
            if (me.meter >= MAXM && rng() < 0.7) { press(3); ctrl.held = 0; return; }
            if (dist < 125) { S.chain = rng() < 0.5 ? [3] : []; press(2); ctrl.held = rng() < 0.4 ? DOWN : 0; return; }
          }
        }
      }
      // offence
      if (g.f >= S.until) {
        var r2 = rng(), aggr = g.show ? 0.75 : 0.45 + 0.3 * L;
        var full = me.meter >= MAXM;
        S.intent = 0; S.until = g.f + 8 + Math.floor(rng() * 22);
        if (full && dist < 330 && !o.air && o.st !== S_DOWN && o.st !== S_GETUP && r2 < (flashy ? 0.55 : 0.3) + 0.2 * L) S.intent = 9;
        else if (dist > 380) {
          if (me.cd <= 0 && r2 < (flashy ? 0.55 : 0.35)) S.intent = 5;
          else if (r2 < 0.55 + aggr * 0.3) S.intent = 1;
          else if (r2 < 0.8) S.intent = 6;
          else S.intent = 0;
        } else if (dist > 150) {
          if (me.cd <= 0 && r2 < (flashy ? 0.3 : 0.18)) S.intent = 5;
          else if (r2 < 0.3 && dist > 200 && dist < 320) S.intent = 6;
          else if (r2 < 0.3 + aggr * 0.55) S.intent = 1;
          else if (r2 < 0.9) S.intent = 2;
          else S.intent = 0;
        } else {
          if (r2 < 0.36) S.intent = 3;
          else if (r2 < 0.52) S.intent = 4;
          else if (r2 < 0.66) S.intent = 7;
          else if (r2 < 0.76) S.intent = 8;
          else if (r2 < 0.86) S.intent = 2;
          else S.intent = 10;
        }
        if ((me.x < WALL_L + 70 && dirT > 0) || (me.x > WALL_R - 70 && dirT < 0)) { if (S.intent === 2 || S.intent === 10) S.intent = 1; }
      }
      switch (S.intent) {
        case 1: held = FWD; if (dist < 110 && rng() < 0.15) { S.intent = 3; } break;
        case 2: held = BACK; break;
        case 3:
          if (dist < 100) {
            var c = rng();
            S.chain = c < 0.25 + 0.35 * L ? (c < 0.12 + 0.2 * L ? [1, 2, 3] : [1, 2]) : (c < 0.7 ? [2] : []);
            S.chainFor = -1; press(1); S.intent = 0; S.until = g.f + 14;
          } else held = FWD;
          break;
        case 4:
          if (dist < 118) { S.chain = rng() < 0.3 + 0.4 * L ? [3] : []; S.chainFor = -1; press(2); S.intent = 0; S.until = g.f + 18; } else held = FWD;
          break;
        case 5: press(3); S.intent = 0; S.until = g.f + 20; break;
        case 6: held = UP | FWD; press(0); S.jumpAtk = 1; S.intent = 0; S.until = g.f + 50; break;
        case 7:
          if (dist < 115) { held = DOWN; S.chain = rng() < 0.3 + 0.3 * L ? [3] : []; S.chainFor = -1; press(rng() < 0.6 ? 2 : 1); S.intent = 0; S.until = g.f + 22; } else held = FWD;
          break;
        case 8: held = BACK | (rng() < 0.4 ? DOWN : 0); break;
        case 9: if (me.meter >= MAXM) press(3); S.intent = 0; S.until = g.f + 30; break;
        case 10: held = UP | BACK; press(0); S.intent = 0; S.until = g.f + 45; break;
        default: held = rng() < 0.08 ? DOWN : 0;
      }
      ctrl.held = held;
    };
  }

  /* =========================================================
   * Audio: tiny WebAudio synth, no files
   * ========================================================= */
  function makeAudio(enabled) {
    var ac = null, out = null, nbuf = null, dead = false, last = {};
    function ctx() {
      if (!enabled || dead) return null;
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { enabled = false; return null; }
        try {
          ac = new AC();
          out = ac.createGain(); out.gain.value = 0.5;
          var comp = ac.createDynamicsCompressor();
          out.connect(comp); comp.connect(ac.destination);
          var n = Math.floor(ac.sampleRate * 0.6);
          nbuf = ac.createBuffer(1, n, ac.sampleRate);
          var d = nbuf.getChannelData(0), s = 12345;
          for (var i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
        } catch (e) { enabled = false; ac = null; return null; }
      }
      if (ac.state === 'suspended') { try { var pr = ac.resume(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { /* ignore */ } }
      return ac;
    }
    function env(a, g, t0, vol, dur) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    }
    function osc(type, f0, f1, t0, dur, vol) {
      var a = ac, o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t0);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      env(a, g, t0, vol, dur);
      o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + dur + 0.03);
    }
    function nz(t0, dur, vol, ft, f0, f1, q) {
      var a = ac, s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
      s.buffer = nbuf; f.type = ft; f.frequency.setValueAtTime(f0, t0);
      if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      f.Q.value = q || 1;
      env(a, g, t0, vol, dur);
      s.connect(f); f.connect(g); g.connect(out); s.start(t0, Math.random() * 0.2); s.stop(t0 + dur + 0.03);
    }
    var SFX = {
      punch: function (t) { osc('triangle', 210, 70, t, 0.09, 0.5); nz(t, 0.07, 0.35, 'bandpass', 2200, 900, 1.2); },
      kick: function (t) { osc('sine', 140, 42, t, 0.18, 0.7); nz(t, 0.12, 0.4, 'lowpass', 1400, 300, 0.8); },
      block: function (t) { osc('square', 1500, 1100, t, 0.05, 0.12); nz(t, 0.06, 0.25, 'highpass', 3500, 2500, 1); },
      swing: function (t, k) { nz(t, 0.11, 0.09 + k * 0.05, 'bandpass', 600, 1800, 2); },
      fire: function (t) { osc('sawtooth', 180, 520, t, 0.22, 0.16); nz(t, 0.3, 0.22, 'bandpass', 700, 2400, 1.5); },
      phit: function (t) { osc('sine', 120, 40, t, 0.25, 0.6); nz(t, 0.25, 0.4, 'lowpass', 2400, 400, 0.7); },
      clash: function (t) { osc('square', 900, 600, t, 0.18, 0.12); osc('square', 1350, 900, t, 0.18, 0.1); nz(t, 0.2, 0.3, 'bandpass', 3000, 1200, 2); },
      superS: function (t) { osc('sawtooth', 110, 880, t, 0.6, 0.16); osc('square', 220, 1320, t + 0.05, 0.55, 0.08); nz(t, 0.6, 0.18, 'bandpass', 400, 3000, 1.5); },
      shit: function (t, k) { osc('triangle', 260 + k * 30, 80, t, 0.1, 0.5); nz(t, 0.08, 0.35, 'bandpass', 2600, 1000, 1.4); },
      ko: function (t) { osc('sine', 180, 28, t, 1.1, 0.8); nz(t, 1.0, 0.45, 'lowpass', 1800, 120, 0.6); osc('triangle', 660, 330, t + 0.05, 0.8, 0.15); },
      round: function (t) { osc('square', 440, 440, t, 0.12, 0.12); osc('square', 660, 660, t + 0.14, 0.18, 0.12); },
      fight: function (t) { osc('sawtooth', 330, 330, t, 0.3, 0.1); osc('sawtooth', 495, 495, t, 0.3, 0.08); osc('sawtooth', 660, 660, t, 0.35, 0.08); nz(t, 0.25, 0.15, 'highpass', 2000, 4000, 1); },
      tick: function (t) { osc('sine', 1200, 1200, t, 0.04, 0.08); },
      win: function (t) { var n = [523, 659, 784, 1046]; for (var i = 0; i < 4; i++) osc('triangle', n[i], n[i], t + i * 0.11, 0.22, 0.2); osc('triangle', 1318, 1318, t + 0.44, 0.5, 0.18); },
      jump: function (t) { osc('sine', 260, 520, t, 0.09, 0.08); },
      thud: function (t) { osc('sine', 95, 45, t, 0.16, 0.5); nz(t, 0.1, 0.2, 'lowpass', 600, 200, 0.7); },
      time: function (t) { osc('square', 880, 440, t, 0.4, 0.12); }
    };
    return {
      play: function (name, k) {
        var a = ctx(); if (!a || !SFX[name]) return;
        var t = a.currentTime;
        if (last[name] && t - last[name] < 0.035) return;
        last[name] = t;
        try { SFX[name](t + 0.005, k || 0); } catch (e) { /* ignore */ }
      },
      wake: function () { ctx(); },
      state: function () { return ac ? ac.state : (dead ? 'closed' : 'none'); },
      close: function () { dead = true; if (ac) { try { var p = ac.close(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } } }
    };
  }

  /* =========================================================
   * Rendering helpers
   * ========================================================= */
  var FONT = 'Fredoka, "Arial Rounded MT Bold", "Trebuchet MS", system-ui, sans-serif';
  var OUT = '#140a14', GLOVE = '#fff1dc', BOOT = '#2a1b26', ORANGE = '#ff8a2b';
  var probe = null;
  function normColor(c, fb) {
    try {
      if (!probe) probe = document.createElement('canvas').getContext('2d');
      probe.fillStyle = '#000'; probe.fillStyle = fb; probe.fillStyle = String(c || fb);
      var v = probe.fillStyle;
      if (v.charAt(0) === '#' && v.length === 7) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
      var m = v.match(/(\d+(\.\d+)?)/g);
      if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
    } catch (e) { /* ignore */ }
    return [255, 138, 43];
  }
  function rgb(c, k, mixWith) {
    var t = mixWith || [0, 0, 0];
    return 'rgb(' + Math.round(c[0] + (t[0] - c[0]) * k) + ',' + Math.round(c[1] + (t[1] - c[1]) * k) + ',' + Math.round(c[2] + (t[2] - c[2]) * k) + ')';
  }
  function ease(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function blendPose(a, b, t) { var r = {}; for (var k in a) r[k] = lerp(a[k], b[k] === undefined ? a[k] : b[k], t); return r; }

  // Poses: hip (hx, hy) above the feet, torso lean tl (radians, + forward), legs (a = thigh angle from straight
  // down, + forward; k = knee bend), arms (s = upper arm angle from down, + forward/up; e = elbow bend).
  var PZ = {
    guard: { hx: 0, hy: -66, tl: 0.1, a1: 0.38, k1: 0.42, a2: -0.34, k2: 0.3, s1: 0.75, e1: 1.75, s2: 0.5, e2: 2.0, rot: 0, ht: 0 },
    crouch: { hx: 4, hy: -40, tl: 0.32, a1: 1.3, k1: 2.1, a2: 0.3, k2: 2.0, s1: 0.95, e1: 1.6, s2: 0.75, e2: 1.8, rot: 0, ht: 0 },
    squat: { hx: 0, hy: -52, tl: 0.2, a1: 0.8, k1: 1.3, a2: -0.1, k2: 1.1, s1: 0.5, e1: 1.6, s2: 0.3, e2: 1.8, rot: 0, ht: 0 },
    jumpUp: { hx: 0, hy: -66, tl: 0.05, a1: 0.7, k1: 1.0, a2: -0.2, k2: 0.6, s1: 2.6, e1: 0.4, s2: 2.2, e2: 0.6, rot: 0, ht: 0 },
    tuck: { hx: 0, hy: -60, tl: 0.25, a1: 1.5, k1: 2.2, a2: 0.9, k2: 2.0, s1: 1.0, e1: 1.6, s2: 0.8, e2: 1.8, rot: 0, ht: 0 },
    lp: { hx: 14, hy: -62, tl: 0.3, a1: 0.6, k1: 0.5, a2: -0.55, k2: 0.15, s1: 1.62, e1: 0.02, s2: 0.6, e2: 1.9, rot: 0, ht: 2 },
    cp: { hx: 16, hy: -40, tl: 0.42, a1: 1.3, k1: 2.0, a2: 0.2, k2: 1.9, s1: 1.62, e1: 0.02, s2: 0.75, e2: 1.8, rot: 0, ht: 2 },
    skWind: { hx: -4, hy: -68, tl: -0.1, a1: 1.2, k1: 1.9, a2: -0.1, k2: 0.1, s1: 0.4, e1: 1.6, s2: 0.2, e2: 1.6, rot: 0, ht: 0 },
    sk: { hx: 10, hy: -70, tl: -0.38, a1: 1.82, k1: 0.05, a2: -0.12, k2: 0.05, s1: 0.2, e1: 1.5, s2: -0.4, e2: 1.2, rot: 0, ht: -3 },
    sw: { hx: 18, hy: -30, tl: 0.55, a1: 1.52, k1: 0.0, a2: 0.4, k2: 2.4, s1: 0.4, e1: 0.3, s2: 0.2, e2: 0.4, rot: 0, ht: 0 },
    jp: { hx: 0, hy: -62, tl: 0.3, a1: 1.1, k1: 1.7, a2: 0.4, k2: 1.6, s1: 1.3, e1: 0.02, s2: 0.6, e2: 1.8, rot: 0, ht: 2 },
    jk: { hx: 4, hy: -60, tl: -0.15, a1: 1.15, k1: 0.0, a2: 0.2, k2: 1.9, s1: 2.0, e1: 0.8, s2: 1.6, e2: 1.0, rot: 0, ht: 0 },
    spWind: { hx: -6, hy: -60, tl: -0.1, a1: 0.6, k1: 0.6, a2: -0.5, k2: 0.3, s1: -0.5, e1: 1.6, s2: -0.7, e2: 1.7, rot: 0, ht: 0 },
    sp: { hx: 12, hy: -58, tl: 0.32, a1: 0.75, k1: 0.7, a2: -0.6, k2: 0.15, s1: 1.55, e1: 0.05, s2: 1.48, e2: 0.08, rot: 0, ht: 2 },
    rush: { hx: 10, hy: -56, tl: 0.75, a1: 1.1, k1: 0.9, a2: -0.8, k2: 0.8, s1: 1.7, e1: 0.05, s2: -0.4, e2: 1.2, rot: 0, ht: 4 },
    flurryA: { hx: 12, hy: -62, tl: 0.32, a1: 0.6, k1: 0.5, a2: -0.55, k2: 0.15, s1: 1.62, e1: 0.02, s2: 0.6, e2: 1.9, rot: 0, ht: 2 },
    flurryB: { hx: 12, hy: -62, tl: 0.3, a1: 0.6, k1: 0.5, a2: -0.55, k2: 0.15, s1: 0.7, e1: 1.8, s2: 1.65, e2: 0.02, rot: 0, ht: 2 },
    uppercut: { hx: 8, hy: -72, tl: 0.05, a1: 0.3, k1: 0.2, a2: -0.3, k2: 0.1, s1: 2.9, e1: 0.15, s2: 0.6, e2: 1.9, rot: 0, ht: -4 },
    block: { hx: -4, hy: -64, tl: -0.12, a1: 0.42, k1: 0.5, a2: -0.36, k2: 0.35, s1: 1.15, e1: 2.05, s2: 1.3, e2: 1.85, rot: 0, ht: -2 },
    cblock: { hx: 0, hy: -40, tl: 0.15, a1: 1.3, k1: 2.1, a2: 0.3, k2: 2.0, s1: 1.25, e1: 2.0, s2: 1.4, e2: 1.8, rot: 0, ht: -2 },
    hurt: { hx: -8, hy: -64, tl: -0.45, a1: 0.25, k1: 0.3, a2: -0.45, k2: 0.4, s1: 0.3, e1: 0.4, s2: -0.5, e2: 0.5, rot: 0, ht: -8 },
    churt: { hx: -6, hy: -40, tl: -0.1, a1: 1.3, k1: 2.1, a2: 0.3, k2: 2.0, s1: 0.4, e1: 0.5, s2: -0.3, e2: 0.6, rot: 0, ht: -6 },
    lying: { hx: 0, hy: -15, tl: 0, a1: 0.25, k1: 0.15, a2: -0.1, k2: 0.3, s1: 2.6, e1: 0.4, s2: 2.9, e2: 0.2, rot: -1.5708, ht: 0 },
    air: { hx: 0, hy: -60, tl: -0.6, a1: 0.6, k1: 0.5, a2: -0.2, k2: 0.6, s1: 2.4, e1: 0.4, s2: 2.8, e2: 0.3, rot: -0.6, ht: -6 },
    win: { hx: 0, hy: -68, tl: -0.05, a1: 0.25, k1: 0.15, a2: -0.25, k2: 0.15, s1: 2.75, e1: 0.25, s2: 0.55, e2: 2.1, rot: 0, ht: -3, ab: 1 },
    win2: { hx: 0, hy: -68, tl: -0.05, a1: 0.25, k1: 0.15, a2: -0.25, k2: 0.15, s1: 2.55, e1: 0.2, s2: 3.5, e2: -0.2, rot: 0, ht: -3, ab: 1 },
    lose: { hx: 4, hy: -56, tl: 0.7, a1: 0.6, k1: 0.9, a2: -0.2, k2: 0.7, s1: 0.15, e1: 0.2, s2: 0.05, e2: 0.2, rot: 0, ht: 6 },
    dizzy: { hx: 0, hy: -64, tl: -0.15, a1: 0.3, k1: 0.3, a2: -0.3, k2: 0.3, s1: 0.2, e1: 0.3, s2: 0.1, e2: 0.3, rot: 0, ht: 0 }
  };
  var LIMB = { th: 34, sh: 34, ua: 27, fa: 27, torso: 52, head: 30 };

  function poseFor(f, t) {
    var st = f.st, sf = f.sf, P = PZ, b, k, m;
    var bob = Math.sin(t * 0.008 + f.id * 1.7);
    switch (st) {
      case S_IDLE: b = blendPose(P.guard, P.guard, 0); b.hy += bob * 1.6; b.s1 += bob * 0.05; b.s2 -= bob * 0.05; return b;
      case S_WALK: {
        var ph = sf * 0.2 * (f.wd || 1);
        b = blendPose(P.guard, P.guard, 0);
        b.a1 = 0.1 + Math.sin(ph) * 0.5; b.a2 = -0.1 - Math.sin(ph) * 0.5;
        b.k1 = 0.3 + Math.max(0, Math.cos(ph)) * 0.45; b.k2 = 0.3 + Math.max(0, -Math.cos(ph)) * 0.45;
        b.hy += Math.abs(Math.cos(ph)) * 2; b.tl = f.wd < 0 ? 0.0 : 0.16;
        return b;
      }
      case S_CROUCH: b = blendPose(P.crouch, P.crouch, 0); b.hy += bob * 0.8; return b;
      case S_GUARD: return blendPose(f.cr ? P.cblock : P.block, P.block, 0);
      case S_PREJUMP: return blendPose(P.guard, P.squat, ease(sf / 3));
      case S_LAND: return blendPose(P.squat, P.guard, ease(sf / 5));
      case S_JUMP: return f.vy < 3 ? blendPose(P.jumpUp, P.tuck, ease((f.vy + 15) / 14)) : blendPose(P.tuck, P.jumpUp, ease((f.vy - 3) / 12));
      case S_ATK:
        m = MOVES[f.mv];
        if (!m) return P.guard;
        if (f.mv === M_SU) {
          if (f.sub === 0) return blendPose(P.spWind, P.spWind, 0);
          if (f.sub === 1) return P.rush;
          if (f.sub === 2) { if (sf >= 30) return P.uppercut; return (Math.floor(sf / 7) % 2) ? P.flurryB : P.flurryA; }
          return blendPose(P.uppercut, P.guard, ease(sf / Math.max(1, f.recT || 24)));
        }
        var strike = { 1: P.lp, 2: P.cp, 3: P.sk, 4: P.sw, 5: P.jp, 6: P.jk, 7: P.sp }[f.mv];
        var base = m.air ? P.tuck : m.cr ? P.crouch : P.guard;
        var wind = f.mv === M_SK ? P.skWind : f.mv === M_SP ? P.spWind : base;
        if (sf <= m.s) {
          k = sf / Math.max(1, m.s);
          if (wind !== base && k < 0.6) return blendPose(base, wind, ease(k / 0.6));
          return blendPose(wind, strike, ease((k - (wind !== base ? 0.6 : 0)) / (wind !== base ? 0.4 : 1)));
        }
        if (sf <= m.s + m.a || m.air) return strike;
        k = (sf - m.s - m.a) / Math.max(1, m.r);
        return blendPose(strike, base, ease(k));
      case S_HIT:
        if (f.cr) return blendPose(P.churt, P.crouch, ease((sf - 4) / 14));
        return blendPose(P.hurt, P.guard, ease((sf - 6) / 14));
      case S_BLOCK: return f.cr ? P.cblock : P.block;
      case S_DOWN:
        if (f.sub === 0) { b = blendPose(P.air, P.lying, clamp(sf / 26, 0, 1) * 0.8); return b; }
        return P.lying;
      case S_GETUP: return blendPose(P.lying, P.squat, ease(sf / 20));
      case S_KO: return P.lying;
      case S_WIN: {
        var wv = Math.sin(sf * 0.15);
        b = blendPose(P.win, P.win2, (Math.floor(sf / 40) % 2) ? 1 : 0); b.ab = 1;
        b.s1 += wv * 0.12; b.hy += Math.max(0, wv) * -4;
        return b;
      }
      case S_LOSE: b = blendPose(P.lose, P.lose, 0); b.hy += bob; return b;
      case S_DIZZY: b = blendPose(P.dizzy, P.dizzy, 0); b.tl = Math.sin(t * 0.006) * 0.25; b.hx = Math.sin(t * 0.006) * 6; return b;
    }
    return P.guard;
  }

  // forward kinematics in local coords (x toward facing, y down); returns joints
  function solve(p, grounded) {
    var L = LIMB, s = Math.sin, c = Math.cos;
    var hip = [p.hx, p.hy];
    var k1 = [hip[0] + s(p.a1) * L.th, hip[1] + c(p.a1) * L.th], f1 = [k1[0] + s(p.a1 - p.k1) * L.sh, k1[1] + c(p.a1 - p.k1) * L.sh];
    var k2 = [hip[0] + s(p.a2) * L.th, hip[1] + c(p.a2) * L.th], f2 = [k2[0] + s(p.a2 - p.k2) * L.sh, k2[1] + c(p.a2 - p.k2) * L.sh];
    var neck = [hip[0] + s(p.tl) * L.torso, hip[1] - c(p.tl) * L.torso];
    var sh = [neck[0] - s(p.tl) * 6, neck[1] + c(p.tl) * 6];
    var e1 = [sh[0] + s(p.s1) * L.ua, sh[1] + c(p.s1) * L.ua], h1 = [e1[0] + s(p.s1 + p.e1) * L.fa, e1[1] + c(p.s1 + p.e1) * L.fa];
    var e2 = [sh[0] - 6 + s(p.s2) * L.ua, sh[1] + c(p.s2) * L.ua], h2 = [e2[0] + s(p.s2 + p.e2) * L.fa, e2[1] + c(p.s2 + p.e2) * L.fa];
    var head = [neck[0] + s(p.tl) * 30 + (p.ht || 0), neck[1] - c(p.tl) * 30];
    var J = { hip: hip, k1: k1, f1: f1, k2: k2, f2: f2, neck: neck, sh: sh, e1: e1, h1: h1, e2: e2, h2: h2, head: head };
    var key;
    if (p.rot) {
      var cr = Math.cos(p.rot), sr = Math.sin(p.rot);
      for (key in J) { var dx = J[key][0] - hip[0], dy = J[key][1] - hip[1]; J[key] = [hip[0] + dx * cr - dy * sr, hip[1] + dx * sr + dy * cr]; }
    }
    if (grounded) {
      var low = Math.max(J.f1[1], J.f2[1]);
      if (p.rot) { for (key in J) if (key !== 'hip') low = Math.max(low, J[key][1] + (key === 'head' ? 26 : 8)); low -= 8; }
      var shift = -8 - low;
      for (key in J) J[key] = [J[key][0], J[key][1] + shift];
    }
    return J;
  }

  function headSprite(img, col, name) {
    var S = 160, cv = document.createElement('canvas'); cv.width = cv.height = S;
    var g = cv.getContext('2d'), r = S / 2;
    g.save(); g.beginPath(); g.arc(r, r, r - 8, 0, Math.PI * 2); g.closePath(); g.clip();
    g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
    if (img && img.complete && img.naturalWidth) {
      var iw = img.naturalWidth, ih = img.naturalHeight, sc = Math.max((S - 16) / iw, (S - 16) / ih);
      var dw = iw * sc, dh = ih * sc;
      g.drawImage(img, r - dw / 2, 8, dw, dh);
    } else {
      g.fillStyle = rgb(col, 0.55, [255, 255, 255]); g.fillRect(0, 0, S, S);
      g.fillStyle = rgb(col, 0.5);
      g.font = '700 74px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(name || '?').trim().charAt(0).toUpperCase() || '?', r, r + 4);
    }
    g.restore();
    g.lineWidth = 10; g.strokeStyle = rgb(col, 0); g.beginPath(); g.arc(r, r, r - 8, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 4; g.strokeStyle = OUT; g.beginPath(); g.arc(r, r, r - 2.5, 0, Math.PI * 2); g.stroke();
    return cv;
  }

  /* ---------- background (pre-rendered in world coords) ---------- */
  var BG_TOP = -760, BG_BOT = 560, BG_W = 960;
  function drawBackground(scale, seed) {
    var H = BG_BOT - BG_TOP, cv = document.createElement('canvas');
    cv.width = Math.ceil(BG_W * scale); cv.height = Math.ceil(H * scale);
    var g = cv.getContext('2d'), r = mulberry(seed ^ 0xbadc0de), i;
    g.scale(scale, scale); g.translate(0, -BG_TOP);
    var sky = g.createLinearGradient(0, BG_TOP, 0, GROUND);
    sky.addColorStop(0, '#07040d'); sky.addColorStop(0.45, '#1b0e2c'); sky.addColorStop(0.78, '#3d1a3f'); sky.addColorStop(0.93, '#6b2b35'); sky.addColorStop(1, '#8a4329');
    g.fillStyle = sky; g.fillRect(0, BG_TOP, BG_W, GROUND - BG_TOP);
    for (i = 0; i < 90; i++) {
      var sx = r() * BG_W, sy = BG_TOP + r() * (330 - BG_TOP), sz = r() < 0.15 ? 1.8 : 1;
      g.globalAlpha = 0.3 + r() * 0.6; g.fillStyle = '#fff3dd'; g.fillRect(sx, sy, sz, sz);
    }
    g.globalAlpha = 1;
    // moon
    var mx = 742, my = 96, mr = 64;
    var glow = g.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 3.2);
    glow.addColorStop(0, 'rgba(255,200,140,0.35)'); glow.addColorStop(1, 'rgba(255,170,110,0)');
    g.fillStyle = glow; g.fillRect(mx - mr * 3.4, my - mr * 3.4, mr * 6.8, mr * 6.8);
    var moon = g.createRadialGradient(mx - 18, my - 18, 8, mx, my, mr);
    moon.addColorStop(0, '#fff4d6'); moon.addColorStop(1, '#f2c27c');
    g.fillStyle = moon; g.beginPath(); g.arc(mx, my, mr, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(190,130,80,0.28)';
    [[-20, -10, 12], [18, 14, 9], [6, -28, 6], [-14, 26, 7], [28, -6, 5]].forEach(function (c) { g.beginPath(); g.arc(mx + c[0], my + c[1], c[2], 0, Math.PI * 2); g.fill(); });
    // far hills
    g.fillStyle = '#21122d';
    g.beginPath(); g.moveTo(0, 380);
    for (i = 0; i <= 12; i++) g.quadraticCurveTo(i * 80 + 40, 330 + r() * 40, i * 80 + 80, 370 + r() * 20);
    g.lineTo(BG_W, GROUND); g.lineTo(0, GROUND); g.closePath(); g.fill();
    // haunted house on the left hill
    g.fillStyle = '#150b1f';
    g.beginPath(); g.moveTo(90, 360); g.lineTo(90, 270); g.lineTo(130, 236); g.lineTo(170, 270); g.lineTo(170, 300); g.lineTo(200, 300);
    g.lineTo(200, 250); g.lineTo(214, 210); g.lineTo(228, 250); g.lineTo(228, 300); g.lineTo(262, 300); g.lineTo(262, 360); g.closePath(); g.fill();
    g.fillStyle = '#ffb347';
    [[110, 280], [140, 280], [110, 320], [208, 262], [240, 318], [150, 318]].forEach(function (w, k) { g.globalAlpha = k % 3 ? 0.85 : 0.5; g.fillRect(w[0], w[1], 12, 16); });
    g.globalAlpha = 1;
    // dead tree right
    g.strokeStyle = '#120917'; g.lineCap = 'round';
    function branch(x, y, a, len, w, d) {
      if (d > 5 || len < 6) return;
      var x2 = x + Math.sin(a) * len, y2 = y - Math.cos(a) * len;
      g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      branch(x2, y2, a - 0.45 - r() * 0.3, len * 0.72, w * 0.68, d + 1);
      branch(x2, y2, a + 0.35 + r() * 0.35, len * 0.66, w * 0.68, d + 1);
    }
    branch(880, 420, -0.12, 70, 14, 0);
    // tombstones & fence
    g.fillStyle = '#120a19';
    for (i = 0; i < 14; i++) {
      var tx = 30 + i * 68 + r() * 20, tw = 22 + r() * 14, th = 26 + r() * 26, ty = GROUND - 12;
      if (tx > 380 && tx < 560) continue;
      g.beginPath();
      if (r() < 0.5) { g.moveTo(tx, ty); g.lineTo(tx, ty - th + tw / 2); g.arc(tx + tw / 2, ty - th + tw / 2, tw / 2, Math.PI, 0); g.lineTo(tx + tw, ty); }
      else { g.rect(tx + tw / 2 - 4, ty - th, 8, th); g.rect(tx + tw / 2 - 12, ty - th + 8, 24, 7); }
      g.fill();
    }
    g.fillStyle = '#0f0815';
    for (i = 0; i < 48; i++) { var fx = i * 20 + 4; g.fillRect(fx, GROUND - 46, 4, 40); g.beginPath(); g.moveTo(fx - 2, GROUND - 46); g.lineTo(fx + 2, GROUND - 54); g.lineTo(fx + 6, GROUND - 46); g.fill(); }
    g.fillRect(0, GROUND - 38, BG_W, 3); g.fillRect(0, GROUND - 20, BG_W, 3);
    // ground
    var gr = g.createLinearGradient(0, GROUND, 0, BG_BOT);
    gr.addColorStop(0, '#3a2a3f'); gr.addColorStop(0.25, '#261a2c'); gr.addColorStop(1, '#0d0811');
    g.fillStyle = gr; g.fillRect(0, GROUND - 8, BG_W, BG_BOT - GROUND + 8);
    g.fillStyle = 'rgba(255,170,90,0.25)'; g.fillRect(0, GROUND - 8, BG_W, 2);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2;
    for (i = -10; i <= 20; i++) { g.beginPath(); g.moveTo(480 + i * 60, GROUND - 6); g.lineTo(480 + i * 140, BG_BOT); g.stroke(); }
    [GROUND + 16, GROUND + 44, GROUND + 80].forEach(function (y) { g.beginPath(); g.moveTo(0, y); g.lineTo(BG_W, y); g.stroke(); });
    return cv;
  }

  function drawPumpkin(g, x, y, s, lit, flick) {
    g.save(); g.translate(x, y); g.scale(s, s);
    if (lit) {
      var gl = g.createRadialGradient(0, -14, 4, 0, -14, 70);
      gl.addColorStop(0, 'rgba(255,150,40,' + (0.32 + flick * 0.12) + ')'); gl.addColorStop(1, 'rgba(255,120,30,0)');
      g.fillStyle = gl; g.fillRect(-70, -84, 140, 140);
    }
    g.fillStyle = '#e8711c'; g.strokeStyle = '#6b2c06'; g.lineWidth = 2.5;
    g.beginPath(); g.ellipse(0, -16, 24, 18, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(-9, -16, 9, 17, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.ellipse(9, -16, 9, 17, 0, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#4a7a2a'; g.fillRect(-3, -40, 6, 9);
    if (lit) {
      g.fillStyle = 'rgb(255,' + Math.round(210 + flick * 40) + ',90)';
      g.beginPath(); g.moveTo(-13, -22); g.lineTo(-5, -22); g.lineTo(-9, -30); g.fill();
      g.beginPath(); g.moveTo(13, -22); g.lineTo(5, -22); g.lineTo(9, -30); g.fill();
      g.beginPath(); g.moveTo(-14, -12); g.lineTo(14, -12); g.lineTo(10, -5); g.lineTo(5, -9); g.lineTo(0, -4); g.lineTo(-5, -9); g.lineTo(-10, -5); g.closePath(); g.fill();
    }
    g.restore();
  }
  function drawBat(g, x, y, s, flap) {
    g.save(); g.translate(x, y); g.scale(s, s); g.fillStyle = '#0b0610';
    var w = Math.sin(flap) * 10;
    g.beginPath(); g.moveTo(0, 0);
    g.quadraticCurveTo(-10, -8 - w, -22, -4 - w); g.quadraticCurveTo(-16, 0, -18, 4); g.quadraticCurveTo(-10, 2, -6, 6);
    g.lineTo(0, 3); g.lineTo(6, 6); g.quadraticCurveTo(10, 2, 18, 4); g.quadraticCurveTo(16, 0, 22, -4 - w); g.quadraticCurveTo(10, -8 - w, 0, 0);
    g.fill(); g.beginPath(); g.arc(0, 0, 4, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  function textCard(g, text, x, y, size, maxW, alpha, scale, fill2) {
    if (alpha <= 0) return;
    g.save(); g.globalAlpha = clamp(alpha, 0, 1);
    g.font = '700 ' + size + 'px ' + FONT;
    var w = g.measureText(text).width, k = w > maxW ? maxW / w : 1;
    g.translate(x, y); g.scale(k * scale, k * scale);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.lineWidth = size * 0.16; g.strokeStyle = '#1a0d03'; g.strokeText(text, 0, 0);
    var gr = g.createLinearGradient(0, -size / 2, 0, size / 2);
    gr.addColorStop(0, fill2 || '#fff1a8'); gr.addColorStop(0.55, '#ffb347'); gr.addColorStop(1, '#ff6a1a');
    g.fillStyle = gr; g.fillText(text, 0, 0);
    g.restore();
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }

  /* =========================================================
   * Renderer: draws a "view" (live sim or interpolated snapshot)
   * ========================================================= */
  function makeRenderer(cv, opt) {
    var g = cv.getContext('2d');
    var cols = [normColor(opt.p1.color, '#ff8a2b'), normColor(opt.p2.color, '#7c5cff')];
    var names = [String(opt.p1.name || 'Player 1').slice(0, 22), String(opt.p2.name || 'Player 2').slice(0, 22)];
    var imgs = [null, null], heads = [null, null], bg = null, bgScale = 0;
    var rm = !!opt.reducedMotion, audio = opt.audio;
    var fxr = mulberry((opt.seed ^ 0x1234567) >>> 0);
    var parts = [], rings = [], shake = 0, flash = 0, flashCol = '#fff', flashF = [0, 0], trails = [[], []];
    var cam = { x: 480, z: 1, oy: 0, init: false }, LW = 960, LH = 540, u = 1, scale = 1, dpr = 1, portrait = false, gy = 470;
    var bars = [{ v: MAXHP, lag: MAXHP }, { v: MAXHP, lag: MAXHP }], prev = { ph: -1, r: 0, tmS: -1, frz: 0 };
    var bats = [], t0 = nowMs();
    for (var i = 0; i < 4; i++) bats.push({ x: fxr() * 960, y: -80 + fxr() * 260, s: 0.7 + fxr() * 0.6, v: 0.25 + fxr() * 0.35, ph: fxr() * 6 });
    [opt.p1, opt.p2].forEach(function (p, k) {
      heads[k] = headSprite(null, cols[k], names[k]);
      if (p && p.img) {
        var im = new Image();
        im.onload = function () { heads[k] = headSprite(im, cols[k], names[k]); };
        im.src = String(p.img);
        imgs[k] = im;
      }
    });

    function resize(cssW, cssH, isPortrait) {
      dpr = Math.min(3, window.devicePixelRatio || 1);
      var maxPix = 2600000, bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
      if (bw * bh > maxPix) { var k = Math.sqrt(maxPix / (bw * bh)); bw = Math.round(bw * k); bh = Math.round(bh * k); }
      cv.width = bw; cv.height = bh; cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
      LW = 960; LH = Math.round(960 * cssH / cssW); scale = bw / LW; portrait = isPortrait;
      u = clamp(720 / cssW, 1, 2.1);
      gy = LH - (LH > 700 ? 120 : 70);
      var want = Math.min(2, scale);
      if (!bg || Math.abs(want - bgScale) > 0.05) { bgScale = want; bg = drawBackground(bgScale, opt.seed | 0); }
    }

    function spark(x, y, n, col, spd, life, size) {
      for (var i = 0; i < n; i++) {
        var a = fxr() * Math.PI * 2, v = spd * (0.4 + fxr() * 0.8);
        parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1, life: life * (0.6 + fxr() * 0.6), max: life, size: size * (0.6 + fxr() * 0.7), col: col, kind: 0 });
      }
    }
    function ring(x, y, r0, r1, col, life, w) { rings.push({ x: x, y: y, r0: r0, r1: r1, col: col, life: life, max: life, w: w }); }
    function event(e) {
      var heavy = e.t === E_HITH || e.t === E_PHIT, who;
      switch (e.t) {
        case E_HITL: case E_HITH:
          spark(e.x, e.y, heavy ? 16 : 10, heavy ? '#ffe066' : '#fff6c8', heavy ? 9 : 6, 18, heavy ? 5 : 4);
          ring(e.x, e.y, 6, heavy ? 54 : 34, '#fff3b0', 12, heavy ? 6 : 4);
          who = (e.a === 1) ? 1 : 0; flashF[who] = 6;
          if (!rm) shake = Math.max(shake, heavy ? 9 : 4);
          if (audio) audio.play(heavy ? 'kick' : 'punch');
          break;
        case E_BLOCK:
          spark(e.x, e.y, 7, '#9fd8ff', 5, 12, 3);
          ring(e.x, e.y, 10, 30, '#bfe6ff', 10, 3);
          if (!rm) shake = Math.max(shake, (e.a & 8) ? 6 : 2);
          if (audio) audio.play('block');
          break;
        case E_FIRE: if (audio) audio.play('fire'); spark(e.x, e.y, 8, ORANGE, 4, 14, 4); break;
        case E_PHIT:
          spark(e.x, e.y, 22, '#ffb347', 10, 22, 6); ring(e.x, e.y, 8, 70, '#ff8a2b', 16, 7);
          flashF[e.a === 1 ? 1 : 0] = 6;
          if (!rm) shake = Math.max(shake, 10);
          if (audio) audio.play('phit');
          break;
        case E_CLASH: spark(e.x, e.y, 24, '#e6d4ff', 9, 20, 5); ring(e.x, e.y, 10, 80, '#ffffff', 16, 6); if (audio) audio.play('clash'); if (!rm) shake = Math.max(shake, 6); break;
        case E_SUPER: if (audio) audio.play('superS'); if (!rm) { flash = 0.5; flashCol = '#ffffff'; } ring(e.x, e.y, 20, 220, '#ffd36b', 30, 10); break;
        case E_SHIT:
          spark(e.x, e.y, 14, '#ffe066', 9, 18, 5); ring(e.x, e.y, 8, 60, '#ffef9a', 12, 5);
          flashF[(e.a >> 3) === 1 ? 1 : 0] = 5;
          if (!rm) shake = Math.max(shake, (e.a & 7) === 4 ? 16 : 7);
          if (audio) audio.play('shit', e.a & 7);
          break;
        case E_KO:
          if (e.a) { spark(e.x, e.y, 40, '#fff1a8', 14, 34, 6); ring(e.x, e.y, 10, 200, '#ffffff', 26, 10); if (!rm) { flash = 0.85; flashCol = '#ffffff'; shake = 22; } if (audio) audio.play('ko'); }
          else if (audio) audio.play('time');
          break;
        case E_JUMP: if (audio) audio.play('jump'); break;
        case E_THUD: spark(e.x, e.y - 4, 8, '#8a7a90', 3, 18, 4); if (!rm) shake = Math.max(shake, 5); if (audio) audio.play('thud'); break;
        case E_SWING: if (audio) { var mv = e.a >> 2; if (mv !== M_SP && mv !== M_SU) audio.play('swing', (mv === M_SK || mv === M_SW || mv === M_JK) ? 1 : 0); } break;
        case E_FIGHT: if (audio) audio.play('fight'); break;
      }
    }


    function drawFighter(f, k, t, view) {
      var col = cols[k], hf = flashF[k] > 0, inSuper = view.frz > 0 && view.frzBy === f.id;
      var body = hf ? rgb(col, 0.78, [255, 255, 255]) : rgb(col, 0), dark = hf ? rgb(col, 0.7, [255, 255, 255]) : rgb(col, 0.42), light = rgb(col, 0.45, [255, 255, 255]);
      var p = poseFor(f, t), grounded = f.y > -0.5 || f.st === S_DOWN && f.sub === 1 || f.st === S_KO || f.st === S_GETUP;
      if (f.st === S_DOWN && f.sub === 0) grounded = false;
      var J = solve(p, grounded), face = f.face, ox = f.x, oy = GROUND + f.y;
      function P(j) { return [ox + face * j[0], oy + j[1]]; }
      function seg(a, b, w, c) {
        var A = P(a), B = P(b);
        g.strokeStyle = OUT; g.lineWidth = w + 5; g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke();
        g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke();
      }
      function dot(j, r, c) { var A = P(j); g.fillStyle = c; g.strokeStyle = OUT; g.lineWidth = 3; g.beginPath(); g.arc(A[0], A[1], r, 0, Math.PI * 2); g.fill(); g.stroke(); }
      function boot(knee, foot) {
        var A = P(foot), K = P(knee), dx = A[0] - K[0], dy = A[1] - K[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
        var tx = A[0] + face * 9 * (dy / len) * (p.rot ? 0 : 1), ty = A[1] - (p.rot ? 0 : 0);
        g.fillStyle = hf ? '#fff' : BOOT; g.strokeStyle = OUT; g.lineWidth = 3;
        g.beginPath(); g.ellipse((A[0] + tx) / 2, (A[1] + ty) / 2 + 1, 12, 8, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      g.lineCap = 'round'; g.lineJoin = 'round';
      // shadow
      var sh = w2sShadow(f);
      g.fillStyle = 'rgba(0,0,0,' + (0.4 * sh.k) + ')'; g.beginPath(); g.ellipse(f.x, GROUND - 2, 44 * sh.k, 9 * sh.k, 0, 0, Math.PI * 2); g.fill();
      if (inSuper) {
        var a0 = P(J.neck), gl = g.createRadialGradient(a0[0], a0[1], 10, a0[0], a0[1], 150);
        gl.addColorStop(0, 'rgba(255,220,120,0.6)'); gl.addColorStop(1, 'rgba(255,140,40,0)');
        g.fillStyle = gl; g.fillRect(a0[0] - 160, a0[1] - 160, 320, 320);
      }
      // back limbs
      seg(J.sh, J.e2, 12, dark); seg(J.e2, J.h2, 11, dark); dot(J.h2, 9, hf ? '#fff' : rgb([255, 241, 220], 0.15));
      seg(J.hip, J.k2, 16, dark); seg(J.k2, J.f2, 14, dark); boot(J.k2, J.f2);
      seg(J.hip, J.k1, 16, body); seg(J.k1, J.f1, 14, body); boot(J.k1, J.f1);
      // torso
      var H = P(J.hip), N = P(J.neck), dx = N[0] - H[0], dy = N[1] - H[1], len = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / len, ny = dx / len;
      g.fillStyle = body; g.strokeStyle = OUT; g.lineWidth = 3.5;
      g.beginPath(); g.moveTo(H[0] + nx * 15, H[1] + ny * 15); g.lineTo(N[0] + nx * 19, N[1] + ny * 19); g.lineTo(N[0] - nx * 19, N[1] - ny * 19); g.lineTo(H[0] - nx * 15, H[1] - ny * 15); g.closePath(); g.fill(); g.stroke();
      if (!hf) {
        g.strokeStyle = light; g.lineWidth = 6; g.beginPath(); g.moveTo(N[0] + nx * 14 + dx * -0.1, N[1] + ny * 14 + dy * -0.1); g.lineTo(H[0] - nx * 10 + dx * 0.15, H[1] - ny * 10 + dy * 0.15); g.stroke();
        g.strokeStyle = '#1d1220'; g.lineWidth = 7; g.beginPath(); g.moveTo(H[0] + nx * 16 + dx * 0.12, H[1] + ny * 16 + dy * 0.12); g.lineTo(H[0] - nx * 16 + dx * 0.12, H[1] - ny * 16 + dy * 0.12); g.stroke();
      }
      var atkFist = f.st === S_ATK && (f.mv === M_LP || f.mv === M_CP || f.mv === M_JP || f.mv === M_SP || f.mv === M_SU);
      function frontArm() { seg(J.sh, J.e1, 12, body); seg(J.e1, J.h1, 11, body); dot(J.h1, atkFist ? 11 : 9.5, hf ? '#fff' : GLOVE); }
      if (p.ab) frontArm();
      // head
      var HD = P(J.head), hs = heads[k], R = LIMB.head + 4;
      g.save(); g.translate(HD[0], HD[1]); if (p.rot) g.rotate(p.rot * face * 0.9); else g.rotate((f.st === S_HIT ? -0.15 : 0) * face);
      g.drawImage(hs, -R, -R, R * 2, R * 2);
      if (hf) { g.globalAlpha = 0.55; g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, R - 3, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
      g.restore();
      if (!p.ab) frontArm();
      if (f.st === S_ATK && f.mv === M_SP && f.sf >= 8 && f.sf < 22) {
        var hp = P(J.h1), gg = g.createRadialGradient(hp[0], hp[1], 2, hp[0], hp[1], 34);
        gg.addColorStop(0, 'rgba(255,240,180,0.9)'); gg.addColorStop(1, 'rgba(255,140,40,0)');
        g.fillStyle = gg; g.beginPath(); g.arc(hp[0], hp[1], 34, 0, Math.PI * 2); g.fill();
      }
      if (f.st === S_DIZZY) {
        for (var s = 0; s < 3; s++) { var an = t * 0.006 + s * 2.1, sx = HD[0] + Math.cos(an) * 30, sy = HD[1] - 40 + Math.sin(an) * 8; star(sx, sy, 7, '#ffe066'); }
      }
      if ((f.st === S_BLOCK) && f.sf < 10) {
        var gp = P(J.h1);
        g.strokeStyle = 'rgba(160,220,255,' + (0.8 - f.sf * 0.07) + ')'; g.lineWidth = 5;
        g.beginPath(); g.arc(gp[0] - face * 6, gp[1] + 10, 46, face > 0 ? -1.1 : Math.PI - 1.1 + 0.2, face > 0 ? 1.1 : Math.PI + 1.1 + 0.2); g.stroke();
      }
      return J;
    }
    function w2sShadow(f) { return { k: clamp(1 + f.y / 260, 0.35, 1) }; }
    function star(x, y, r, c) {
      g.fillStyle = c; g.beginPath();
      for (var i = 0; i < 10; i++) { var a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
      g.closePath(); g.fill();
    }
    function drawProj(p, t) {
      var col = cols[p.o - 1], x = p.x, y = GROUND + p.y, dir = p.vx > 0 ? 1 : -1, sp = t * 0.02;
      for (var i = 5; i >= 1; i--) {
        g.globalAlpha = 0.12 * (6 - i); g.fillStyle = rgb(col, 0.2, [255, 160, 60]);
        g.beginPath(); g.arc(x - dir * i * 13, y + Math.sin(sp + i) * 3, PROJ_R * (1 - i * 0.12), 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      var gl = g.createRadialGradient(x, y, 4, x, y, PROJ_R * 2.4);
      gl.addColorStop(0, 'rgba(255,230,160,0.8)'); gl.addColorStop(1, 'rgba(255,120,30,0)');
      g.fillStyle = gl; g.beginPath(); g.arc(x, y, PROJ_R * 2.4, 0, Math.PI * 2); g.fill();
      g.save(); g.translate(x, y); g.rotate(dir * Math.sin(sp) * 0.3);
      g.fillStyle = rgb(col, 0.35, [255, 140, 30]); g.strokeStyle = OUT; g.lineWidth = 3;
      g.beginPath(); g.ellipse(0, 0, PROJ_R, PROJ_R * 0.85, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#fff3b0';
      g.beginPath(); g.moveTo(-10, -5); g.lineTo(-3, -5); g.lineTo(-6.5, -12); g.fill();
      g.beginPath(); g.moveTo(10, -5); g.lineTo(3, -5); g.lineTo(6.5, -12); g.fill();
      g.beginPath(); g.moveTo(-11, 3); g.lineTo(11, 3); g.lineTo(7, 9); g.lineTo(3, 6); g.lineTo(0, 10); g.lineTo(-3, 6); g.lineTo(-7, 9); g.closePath(); g.fill();
      g.restore();
    }

    function hud(view, t) {
      var F = view.F, m = 12 * u, pr = 25 * u, bh = 17 * u, tw = 62 * u, th = 46 * u;
      var cx = LW / 2;
      // timer
      var secs = Math.max(0, Math.ceil(view.tm / FPS));
      g.fillStyle = 'rgba(20,10,20,0.82)'; g.strokeStyle = ORANGE; g.lineWidth = 2.5 * u;
      roundRect(g, cx - tw / 2, m, tw, th, 10 * u); g.fill(); g.stroke();
      var low = view.ph === P_FIGHT && secs <= 5;
      g.font = '700 ' + Math.round(30 * u) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = low && (Math.floor(t / 250) % 2) ? '#ff5a4a' : '#ffe9c2';
      g.fillText(view.show ? '∞' === '' ? '' : String(secs) : String(secs), cx, m + th / 2 + 2 * u);
      for (var k = 0; k < 2; k++) {
        var f = F[k], left = k === 0, col = cols[k];
        var pcx = left ? m + pr : LW - m - pr, pcy = m + pr;
        var x0 = left ? m + pr * 2 + 8 * u : cx + tw / 2 + 8 * u, x1 = left ? cx - tw / 2 - 8 * u : LW - m - pr * 2 - 8 * u, bw = x1 - x0;
        var by = m + 3 * u;
        // health bar (drains toward the portrait)
        var B = bars[k]; B.v += (f.hp - B.v) * 0.5; if (B.lag < B.v) B.lag = B.v; else B.lag -= Math.max(0.15, (B.lag - B.v) * 0.04);
        g.fillStyle = 'rgba(10,5,12,0.85)'; roundRect(g, x0 - 3 * u, by - 3 * u, bw + 6 * u, bh + 6 * u, 6 * u); g.fill();
        g.fillStyle = '#3b1414'; g.fillRect(x0, by, bw, bh);
        var lagW = bw * clamp(B.lag / MAXHP, 0, 1), vW = bw * clamp(B.v / MAXHP, 0, 1);
        g.fillStyle = '#ffffff'; g.globalAlpha = 0.85;
        if (left) g.fillRect(x0, by, lagW, bh); else g.fillRect(x1 - lagW, by, lagW, bh);
        g.globalAlpha = 1;
        var frac = B.v / MAXHP, hg = g.createLinearGradient(0, by, 0, by + bh);
        if (frac > 0.3) { hg.addColorStop(0, '#ffe680'); hg.addColorStop(1, '#f2a61c'); } else { hg.addColorStop(0, '#ff8a6a'); hg.addColorStop(1, '#d42a1a'); }
        g.fillStyle = hg;
        if (left) g.fillRect(x0, by, vW, bh); else g.fillRect(x1 - vW, by, vW, bh);
        g.strokeStyle = OUT; g.lineWidth = 2 * u; g.strokeRect(x0, by, bw, bh);
        // portrait
        g.save(); g.beginPath(); g.arc(pcx, pcy, pr + 3 * u, 0, Math.PI * 2); g.fillStyle = rgb(col, 0); g.fill(); g.restore();
        g.drawImage(heads[k], pcx - pr, pcy - pr, pr * 2, pr * 2);
        // name + round pips
        var ny = by + bh + 13 * u;
        g.font = '700 ' + Math.round(14 * u) + 'px ' + FONT; g.textBaseline = 'middle';
        g.lineWidth = 4 * u; g.strokeStyle = OUT; g.fillStyle = '#fff1dc'; g.textAlign = left ? 'left' : 'right';
        var nm = names[k], nmx = left ? x0 : x1, maxNW = bw - 50 * u;
        while (nm.length > 3 && g.measureText(nm).width > maxNW) nm = nm.slice(0, -2) + '…';
        g.strokeText(nm, nmx, ny); g.fillText(nm, nmx, ny);
        for (var w = 0; w < 2; w++) {
          var px = left ? x1 - 9 * u - w * 20 * u : x0 + 9 * u + w * 20 * u, won = view.w[k] > w;
          if (won) drawPumpkin(g, px, ny + 8 * u, 0.36 * u, true, 0.5);
          else { g.strokeStyle = 'rgba(255,200,150,0.45)'; g.lineWidth = 2 * u; g.beginPath(); g.arc(px, ny, 6 * u, 0, Math.PI * 2); g.stroke(); }
        }
        // super meter
        var my = ny + 14 * u, mw = bw * 0.62, mh = 8 * u, mx0 = left ? x0 : x1 - mw, full = f.meter >= MAXM;
        g.fillStyle = 'rgba(10,5,12,0.85)'; roundRect(g, mx0 - 2 * u, my - 2 * u, mw + 4 * u, mh + 4 * u, 4 * u); g.fill();
        var mfw = mw * clamp(f.meter / MAXM, 0, 1);
        g.fillStyle = full ? ((Math.floor(t / 120) % 2) ? '#7ef0ff' : '#c9a2ff') : '#5aa9ff';
        if (left) g.fillRect(mx0, my, mfw, mh); else g.fillRect(mx0 + mw - mfw, my, mfw, mh);
        g.font = '700 ' + Math.round(10 * u) + 'px ' + FONT; g.fillStyle = full ? '#fff' : 'rgba(255,241,220,0.75)';
        g.textAlign = left ? 'left' : 'right'; g.lineWidth = 3 * u; g.strokeStyle = OUT;
        var lab = full ? 'SUPER READY!' : 'SUPER', lx = left ? mx0 + mw + 7 * u : mx0 - 7 * u;
        g.strokeText(lab, lx, my + mh / 2); g.fillText(lab, lx, my + mh / 2);
        // projectile cooldown pip
        var cdx = left ? lx + g.measureText(lab).width + 12 * u : lx - g.measureText(lab).width - 12 * u, cdk = f.cd > 0 ? 1 - f.cd / PROJ_CD : 1;
        g.fillStyle = 'rgba(10,5,12,0.8)'; g.beginPath(); g.arc(cdx, my + mh / 2, 6 * u, 0, Math.PI * 2); g.fill();
        g.fillStyle = cdk >= 1 ? ORANGE : 'rgba(255,138,43,0.45)';
        g.beginPath(); g.moveTo(cdx, my + mh / 2); g.arc(cdx, my + mh / 2, 5 * u, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cdk); g.closePath(); g.fill();
        // combo
        var ccShow = f.ccT !== undefined ? (f.ccT > 0 ? f.cc : 0) : f.cc;
        if (ccShow >= 2 && view.ph !== P_END) {
          var cxk = left ? LW * 0.17 : LW * 0.83, cyk = LH * 0.3 + 10 * u;
          textCard(g, ccShow + ' HITS!', cxk, cyk, Math.round(30 * u), LW * 0.3, 1, 1, '#ffffff');
        }
      }
    }

    function legend(view) {
      var L = opt.legend; if (!L || !L.length) return;
      var lines = [];
      L.forEach(function (s) { lines.push(s); });
      var fs = Math.round(13.5 * u), lh = fs * 1.45, pad = 12 * u, wmax = 0, i;
      g.font = '600 ' + fs + 'px ' + FONT;
      for (i = 0; i < lines.length; i++) wmax = Math.max(wmax, g.measureText(lines[i].text).width);
      var bw = Math.min(LW - 24 * u, wmax + pad * 2), bh = lines.length * lh + pad * 2, bx = (LW - bw) / 2, by = LH - bh - (portrait ? 18 : 14) * u;
      var a = view.ph === P_INTRO ? clamp(view.pt / 12, 0, 1) : clamp(1 - view.pt / 30, 0, 1);
      if (a <= 0) return;
      g.save(); g.globalAlpha = a;
      g.fillStyle = 'rgba(18,10,22,0.88)'; g.strokeStyle = 'rgba(255,138,43,0.7)'; g.lineWidth = 2;
      roundRect(g, bx, by, bw, bh, 10 * u); g.fill(); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (i = 0; i < lines.length; i++) {
        var ln = lines[i];
        g.font = (ln.head ? '700 ' : '600 ') + fs + 'px ' + FONT;
        g.fillStyle = ln.head ? '#ffb347' : '#f1e6d8';
        var tx = ln.text, k = g.measureText(tx).width > bw - pad ? (bw - pad) / g.measureText(tx).width : 1;
        g.save(); g.translate(LW / 2, by + pad + lh * i + lh / 2); g.scale(k, 1); g.fillText(tx, 0, 0); g.restore();
      }
      g.restore();
    }

    function cards(view, t) {
      var ph = view.ph, pt = view.pt, big = Math.round(70 * Math.min(u, 1.6)), cy = LH * (LH < 500 ? 0.31 : portrait ? 0.42 : 0.4);
      function pop(n) { return rm ? 1 : 1 + 0.6 * Math.max(0, 1 - n / 8); }
      if (ph === P_INTRO) {
        if (view.r === 1 && pt < 90) {
          var va = clamp(pt / 10, 0, 1) * clamp((90 - pt) / 12, 0, 1);
          textCard(g, names[0] + '  vs  ' + names[1], LW / 2, cy - big * 0.95, Math.round(34 * Math.min(u, 1.6)), LW * 0.92, va, 1, '#ffffff');
        }
        var s0 = view.r === 1 ? 30 : 4;
        if (pt >= s0) textCard(g, view.r === 3 ? 'FINAL ROUND' : 'ROUND ' + view.r, LW / 2, cy, big, LW * 0.86, clamp((pt - s0) / 6, 0, 1), pop(pt - s0));
      } else if (ph === P_FIGHT && pt < 48) {
        textCard(g, 'FIGHT!', LW / 2, cy, Math.round(big * 1.15), LW * 0.8, clamp((48 - pt) / 14, 0, 1), pop(pt));
      } else if (ph === P_KO) {
        textCard(g, 'K.O.', LW / 2, cy, Math.round(big * 1.3), LW * 0.8, clamp(pt / 4, 0, 1), pop(pt), '#ffffff');
        if (view.how === 1 && pt > 46) textCard(g, 'PERFECT!', LW / 2, cy + big * 1.05, Math.round(big * 0.75), LW * 0.8, clamp((pt - 46) / 8, 0, 1), pop(pt - 46), '#c8f7ff');
      } else if (ph === P_TIME) {
        textCard(g, view.how === 3 ? 'DRAW' : 'TIME!', LW / 2, cy, Math.round(big * 1.1), LW * 0.8, clamp(pt / 4, 0, 1), pop(pt));
      } else if (ph === P_END && view.mw) {
        textCard(g, names[view.mw - 1] + ' WINS!', LW / 2, cy, big, LW * 0.92, clamp(pt / 8, 0, 1), pop(pt));
        var sub = view.w[0] + ' – ' + view.w[1];
        textCard(g, sub, LW / 2, cy + big * 0.95, Math.round(big * 0.5), LW * 0.5, clamp((pt - 10) / 10, 0, 1), 1, '#ffffff');
      }
      if (view.frz > 0) {
        var who = view.frzBy - 1, k2 = 1 - view.frz / 42;
        var slide = rm ? 0 : (1 - ease(Math.min(1, k2 * 4))) * LW * (who ? 1 : -1) * 0.5;
        g.save(); g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, LH * 0.62, LW, 64 * u);
        g.fillStyle = rgb(cols[who], 0); g.fillRect(0, LH * 0.62, LW, 4 * u); g.fillRect(0, LH * 0.62 + 60 * u, LW, 4 * u);
        g.restore();
        textCard(g, names[who] + ': SUPER!', LW / 2 + slide, LH * 0.62 + 32 * u, Math.round(36 * Math.min(u, 1.5)), LW * 0.9, 1, 1, '#ffffff');
      }
      if (view.waiting) textCard(g, view.waiting, LW / 2, LH * 0.55, Math.round(28 * u), LW * 0.9, 0.6 + 0.4 * Math.sin(t / 300), 1, '#ffffff');
      if (opt.badge) {
        g.font = '700 ' + Math.round(11 * u) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
        var bw2 = g.measureText(opt.badge).width + 16 * u, bx = LW / 2 - bw2 / 2, byy = 12 * u + 50 * u;
        g.fillStyle = 'rgba(20,10,20,0.8)'; roundRect(g, bx, byy, bw2, 18 * u, 9 * u); g.fill();
        g.fillStyle = '#ffb347'; g.fillText(opt.badge, LW / 2, byy + 9.5 * u);
      }
    }

    function sounds(view) {
      if (!audio) return;
      if (view.ph !== prev.ph || view.r !== prev.r) {
        if (view.ph === P_INTRO) audio.play('round');
        if (view.ph === P_END) audio.play('win');
      }
      if (view.ph === P_FIGHT) {
        var s = Math.ceil(view.tm / FPS);
        if (s !== prev.tmS && s <= 5 && s > 0) audio.play('tick');
        prev.tmS = s;
      }
      prev.ph = view.ph; prev.r = view.r;
    }

    function render(view, dtMs) {
      var t = nowMs() - t0, k = Math.min(3, dtMs / 16.67), i;
      sounds(view);
      var F = view.F;
      // camera
      var d = Math.abs(F[0].x - F[1].x), mid = (F[0].x + F[1].x) / 2;
      var minW = portrait ? 500 : 760, margin = portrait ? 290 : 420;
      var vw = clamp(d + margin, minW, 960), tz = LW / vw * (portrait ? 1 : 1);
      if (portrait) tz = Math.min(tz, 1.9);
      var halfW = LW / tz / 2, tx = clamp(mid, halfW, 960 - halfW);
      // vertical: keep the highest head on screen below the HUD by sliding the floor down (never past 40% off)
      var topY = Math.min(F[0].y, F[1].y, 0), needUp = 205 - topY, hudPad = 70 * u;
      var ty = Math.max(0, needUp * tz - (gy - hudPad));
      ty = Math.min(ty, (LH - gy) + 60);
      if (!cam.init) { cam.x = tx; cam.z = tz; cam.oy = ty; cam.init = true; }
      var a = 1 - Math.pow(0.88, k);
      cam.z += (tz - cam.z) * a; halfW = LW / cam.z / 2; cam.x += (tx - cam.x) * a; cam.x = clamp(cam.x, halfW, 960 - halfW);
      cam.oy += (ty - cam.oy) * (1 - Math.pow(0.8, k));
      var gyc = gy + cam.oy;
      g.setTransform(scale, 0, 0, scale, 0, 0);
      g.fillStyle = '#0b0710'; g.fillRect(0, 0, LW, LH);
      var sx = 0, sy = 0;
      if (shake > 0.2 && !rm) { sx = (fxr() - 0.5) * shake * 2; sy = (fxr() - 0.5) * shake * 1.4; }
      shake *= Math.pow(0.82, k);
      // world
      g.save();
      g.translate(LW / 2 + sx, gyc + sy); g.scale(cam.z, cam.z); g.translate(-cam.x, -GROUND);
      g.drawImage(bg, 0, BG_TOP, BG_W, BG_BOT - BG_TOP);
      if (view.frz > 0) { g.fillStyle = 'rgba(8,0,16,0.55)'; g.fillRect(-50, BG_TOP, 1060, BG_BOT - BG_TOP); }
      // bats
      for (i = 0; i < bats.length; i++) {
        var b = bats[i];
        if (!rm) { b.x += b.v * k; if (b.x > 1000) { b.x = -40; b.y = -80 + fxr() * 260; } }
        drawBat(g, b.x, b.y + (rm ? 0 : Math.sin(t * 0.002 + b.ph) * 10), b.s, rm ? 0.6 : t * 0.02 + b.ph);
      }
      var flick = rm ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.013) * Math.sin(t * 0.007 + 1);
      drawPumpkin(g, 70, GROUND + 4, 1.1, true, flick);
      drawPumpkin(g, 892, GROUND + 4, 1.0, true, 1 - flick);
      // trails for super rush
      for (i = 0; i < 2; i++) {
        var f = F[i], tr = trails[i];
        if (f.st === S_ATK && f.mv === M_SU && f.sub === 1) { tr.push({ x: f.x, y: f.y }); if (tr.length > 5) tr.shift(); } else if (tr.length) tr.shift();
      }
      // draw order: the one being hit / defending behind
      var order = (F[0].st === S_ATK && F[1].st !== S_ATK) ? [1, 0] : [0, 1];
      for (i = 0; i < 2; i++) {
        var kk = order[i], ff = F[kk];
        for (var q = 0; q < trails[kk].length; q++) {
          g.globalAlpha = 0.12 + q * 0.06;
          drawFighter({ id: ff.id, x: trails[kk][q].x, y: trails[kk][q].y, face: ff.face, st: ff.st, sf: ff.sf, mv: ff.mv, sub: ff.sub, cr: ff.cr, vy: 0, wd: 0, recT: ff.recT }, kk, t, view);
          g.globalAlpha = 1;
        }
        drawFighter(ff, kk, t, view);
      }
      for (i = 0; i < view.pr.length; i++) drawProj(view.pr[i], t);
      if (opt.debug) {
        g.lineWidth = 2;
        for (i = 0; i < 2; i++) {
          var df = F[i], cr = df.cr || df.st === S_CROUCH, air = df.y < -0.5 && df.st !== S_DOWN;
          g.strokeStyle = '#3f3';
          if (air) g.strokeRect(df.x - 26, GROUND + df.y - 150, 52, 140); else if (cr) g.strokeRect(df.x - 32, GROUND + df.y - 112, 64, 112); else g.strokeRect(df.x - 30, GROUND + df.y - 176, 60, 176);
          var dm = df.st === S_ATK ? MOVES[df.mv] : null;
          if (dm && dm.box && (df.mv === M_SU ? df.sub === 1 : (df.sf > dm.s && df.sf <= dm.s + dm.a))) {
            var xa = df.x + df.face * dm.box[0], xb = df.x + df.face * dm.box[1];
            g.strokeStyle = '#f33'; g.strokeRect(Math.min(xa, xb), GROUND + df.y + dm.box[2], Math.abs(xb - xa), dm.box[3] - dm.box[2]);
          }
        }
        for (i = 0; i < view.pr.length; i++) { g.strokeStyle = '#f33'; g.beginPath(); g.arc(view.pr[i].x, GROUND + view.pr[i].y, PROJ_R, 0, Math.PI * 2); g.stroke(); }
      }
      // particles
      for (i = parts.length - 1; i >= 0; i--) {
        var pp = parts[i]; pp.x += pp.vx * k; pp.y += pp.vy * k; pp.vy += 0.25 * k; pp.vx *= Math.pow(0.92, k); pp.life -= k;
        if (pp.life <= 0) { parts.splice(i, 1); continue; }
        g.globalAlpha = clamp(pp.life / pp.max, 0, 1); g.strokeStyle = pp.col; g.lineWidth = pp.size;
        g.beginPath(); g.moveTo(pp.x, pp.y); g.lineTo(pp.x - pp.vx * 2.2, pp.y - pp.vy * 2.2); g.stroke();
      }
      for (i = rings.length - 1; i >= 0; i--) {
        var rg = rings[i]; rg.life -= k;
        if (rg.life <= 0) { rings.splice(i, 1); continue; }
        var rk = 1 - rg.life / rg.max;
        g.globalAlpha = clamp(rg.life / rg.max, 0, 1); g.strokeStyle = rg.col; g.lineWidth = rg.w * (1 - rk * 0.6);
        g.beginPath(); g.arc(rg.x, rg.y, lerp(rg.r0, rg.r1, ease(rk)), 0, Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 1;
      // fog
      var fogA = 0.16;
      for (i = 0; i < 3; i++) {
        var fx0 = ((rm ? i * 320 : (t * 0.012 * (i + 1) + i * 320)) % 1300) - 170;
        var fg = g.createRadialGradient(fx0, GROUND + 6, 10, fx0, GROUND + 6, 220);
        fg.addColorStop(0, 'rgba(190,160,220,' + fogA + ')'); fg.addColorStop(1, 'rgba(190,160,220,0)');
        g.fillStyle = fg; g.fillRect(fx0 - 220, GROUND - 60, 440, 120);
      }
      g.restore();
      for (i = 0; i < 2; i++) if (flashF[i] > 0) flashF[i] -= k;
      // vignette
      var vg = g.createRadialGradient(LW / 2, LH * 0.55, LH * 0.35, LW / 2, LH * 0.55, LW * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
      g.fillStyle = vg; g.fillRect(0, 0, LW, LH);
      hud(view, t);
      legend(view);
      cards(view, t);
      if (flash > 0.01 && !rm) { g.globalAlpha = flash; g.fillStyle = flashCol; g.fillRect(0, 0, LW, LH); g.globalAlpha = 1; flash *= Math.pow(0.82, k); }
    }

    return { render: render, resize: resize, event: event };
  }

  /* =========================================================
   * Snapshots (net mode): compact arrays, interpolated on the mirror
   * ========================================================= */
  function fArr(f) {
    return [Math.round(f.x), Math.round(f.y), f.face, f.st, Math.min(999, f.sf), f.mv, f.sub, Math.round(f.hp * 10),
      Math.round(f.meter), f.ccT > 0 ? f.cc : 0, (f.cr ? 1 : 0) | (f.wd < 0 ? 2 : 0), f.cd, Math.round(f.vy), f.recT | 0];
  }
  function fObj(a, id) {
    return { id: id, x: +a[0] || 0, y: +a[1] || 0, face: a[2] < 0 ? -1 : 1, st: a[3] | 0, sf: a[4] | 0, mv: a[5] | 0, sub: a[6] | 0, hp: (+a[7] || 0) / 10,
      meter: +a[8] || 0, cc: a[9] | 0, cr: !!(a[10] & 1), wd: (a[10] & 2) ? -1 : 1, cd: a[11] | 0, vy: +a[12] || 0, recT: a[13] | 0 };
  }
  function validSnap(s) {
    return s && typeof s === 'object' && typeof s.f === 'number' && isFinite(s.f) && Array.isArray(s.a) && Array.isArray(s.b) && s.a.length >= 12 && s.b.length >= 12;
  }

  /* =========================================================
   * Styles + DOM
   * ========================================================= */
  var styleRefs = 0, styleEl = null;
  function addStyle() {
    styleRefs++;
    if (styleEl) return;
    styleEl = document.createElement('style'); styleEl.id = 'duel-style';
    styleEl.textContent =
      '.duel-wrap{position:absolute;inset:0;overflow:hidden;background:#0b0710 linear-gradient(#07040d,#1b0e2c 45%,#140c18 55%,#0b0710);user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;font-family:Fredoka,system-ui,sans-serif;color:#f1e6d8}' +
      '.duel-wrap canvas{position:absolute;display:block;image-rendering:auto;touch-action:none}' +
      '.duel-pad{position:absolute;touch-action:none;pointer-events:auto}' +
      '.duel-dpad{position:absolute;border-radius:50%;background:radial-gradient(circle at 50% 45%,rgba(70,48,80,.75),rgba(25,15,30,.8));border:2px solid rgba(255,138,43,.45);box-shadow:0 4px 16px rgba(0,0,0,.4)}' +
      '.duel-dpad i{position:absolute;width:0;height:0;border:solid transparent;opacity:.55}' +
      '.duel-dpad i.u{left:50%;top:9%;transform:translateX(-50%);border-width:0 11px 14px;border-bottom-color:#ffe9c2}' +
      '.duel-dpad i.d{left:50%;bottom:9%;transform:translateX(-50%);border-width:14px 11px 0;border-top-color:#ffe9c2}' +
      '.duel-dpad i.l{top:50%;left:9%;transform:translateY(-50%);border-width:11px 14px 11px 0;border-right-color:#ffe9c2}' +
      '.duel-dpad i.r{top:50%;right:9%;transform:translateY(-50%);border-width:11px 0 11px 14px;border-left-color:#ffe9c2}' +
      '.duel-dpad b{position:absolute;left:50%;top:50%;width:38%;height:38%;margin:-19% 0 0 -19%;border-radius:50%;background:rgba(255,138,43,.35);border:2px solid rgba(255,190,120,.6);transition:transform .04s}' +
      '.duel-btn{position:absolute;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:700;color:#1a0d03;border:3px solid rgba(20,10,20,.7);box-shadow:0 4px 12px rgba(0,0,0,.45),inset 0 -4px 0 rgba(0,0,0,.2);line-height:1}' +
      '.duel-btn small{font-size:10px;font-weight:600;opacity:.8;margin-top:2px}' +
      '.duel-btn.p{background:#ffb347}.duel-btn.k{background:#c9a2ff}.duel-btn.s{background:#7ee08a}' +
      '.duel-btn.on{transform:scale(.92);filter:brightness(1.25)}' +
      '.duel-btn.s.ready{background:#7ef0ff;animation:duel-glow .5s ease-in-out infinite alternate}' +
      '.duel-btn.s.cool{filter:saturate(.35) brightness(.75)}' +
      '.duel-tag{position:absolute;font:700 11px Fredoka,system-ui,sans-serif;color:#ffb347;letter-spacing:.6px;text-transform:uppercase;opacity:.8;pointer-events:none}' +
      '@keyframes duel-glow{from{box-shadow:0 0 6px #7ef0ff}to{box-shadow:0 0 22px #7ef0ff}}' +
      '@media (prefers-reduced-motion:reduce){.duel-btn.s.ready{animation:none}}';
    document.head.appendChild(styleEl);
  }
  function dropStyle() {
    styleRefs = Math.max(0, styleRefs - 1);
    if (!styleRefs && styleEl) { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); styleEl = null; }
  }

  var KB1 = { KeyA: LEFT, KeyD: RIGHT, KeyW: UP, KeyS: DOWN, KeyF: PUNCH, KeyG: KICK, KeyH: SPECIAL };
  var KB2 = { ArrowLeft: LEFT, ArrowRight: RIGHT, ArrowUp: UP, ArrowDown: DOWN, KeyK: PUNCH, KeyL: KICK, Semicolon: SPECIAL };
  var KEYNAME = { a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', f: 'KeyF', g: 'KeyG', h: 'KeyH', k: 'KeyK', l: 'KeyL', ';': 'Semicolon',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown' };
  var MODES = { kb1: 1, kb2: 1, kbAny: 1, touch1: 1, touch2: 1, touchAny: 1, ai: 1, remote: 1, mirror: 1 };
  function bitIndex(b) { return b === UP ? 0 : b === PUNCH ? 1 : b === KICK ? 2 : b === SPECIAL ? 3 : -1; }

  /* =========================================================
   * Duel.start
   * ========================================================= */
  function start(o) {
    o = o || {};
    var root = o.root;
    if (!root || typeof root.appendChild !== 'function') throw new Error('Duel.start: root element required');
    var cin = o.control || {};
    var modes = [MODES[cin.p1] ? cin.p1 : 'ai', MODES[cin.p2] ? cin.p2 : 'ai'];
    var isMirror = modes[0] === 'mirror' || modes[1] === 'mirror';
    var seed = (o.seed | 0) || 1;
    var timeScale = clamp(+o.timeScale || 1, 0.1, 32);
    var p1 = o.p1 || {}, p2 = o.p2 || {};
    var rm = !!o.reducedMotion;
    var show = !isMirror && modes[0] === 'ai' && modes[1] === 'ai' && (o.forcedWinner === 1 || o.forcedWinner === 2);
    var dead = false, offs = [], raf = 0, iv = 0, ro = null, ended = false;
    var audio = o.sound ? makeAudio(true) : null;

    function on(t, ty, fn, opt) { t.addEventListener(ty, fn, opt); offs.push(function () { t.removeEventListener(ty, fn, opt); }); }
    function safe(fn, arg) { if (typeof fn !== 'function') return; try { fn(arg); } catch (e) { if (window.console) console.warn('Duel callback failed', e); } }

    addStyle();
    var rootPos = '';
    try { if (getComputedStyle(root).position === 'static') { rootPos = root.style.position || ' '; root.style.position = 'relative'; } } catch (e) { /* ignore */ }
    var wrap = document.createElement('div'); wrap.className = 'duel-wrap';
    wrap.setAttribute('role', 'application'); wrap.setAttribute('aria-label', 'Duel: ' + (p1.name || 'Player 1') + ' versus ' + (p2.name || 'Player 2'));
    var cv = document.createElement('canvas'); wrap.appendChild(cv);
    root.appendChild(wrap);

    // controllers
    var ctrls = [new Ctrl(modes[0]), new Ctrl(modes[1])];
    var local = [false, false];
    for (var i = 0; i < 2; i++) local[i] = /^(kb|touch)/.test(modes[i]);
    var keyMaps = modes.map(function (m) { return m === 'kb1' ? [KB1] : m === 'kb2' ? [KB2] : (m === 'kbAny' || m === 'touchAny') ? [KB1, KB2] : []; });
    var padKind = modes.map(function (m) { return m === 'touch1' || m === 'touch2' || m === 'touchAny' ? m : null; });

    // sim / mirror
    var sim = null, ais = [null, null];
    if (!isMirror) {
      sim = makeSim({ seed: seed, show: show, forcedWinner: o.forcedWinner, reducedMotion: rm, human: local[0] || local[1] });
      var aiLvl = clamp(o.aiLevel == null ? 0.55 : +o.aiLevel, 0, 1);
      for (i = 0; i < 2; i++) {
        if (modes[i] === 'ai') ais[i] = makeAI(sim, i, ctrls[i], show ? 0.62 : aiLvl, seed * 31 + i * 977 + 7, show);
        if (modes[i] === 'remote') { sim.F[i].bufLen = 15; sim.F[i].blockMem = 24; }
      }
    }

    function legendLines() {
      var out = [], i, any = false;
      for (i = 0; i < 2; i++) {
        if (!local[i]) continue; any = true;
        var who = (i === 0 ? 'P1 ' : 'P2 ') + String((i === 0 ? p1 : p2).name || '').slice(0, 16), m = modes[i], kbTxt;
        if (padKind[i]) kbTxt = 'Pad: move, ↑ jump, ↓ crouch · P punch · K kick · S special';
        else if (m === 'kb1') kbTxt = 'W A S D move/jump/crouch · F punch · G kick · H special';
        else if (m === 'kb2') kbTxt = 'Arrows move/jump/crouch · K punch · L kick · ; special';
        else kbTxt = 'WASD or arrows · F/K punch · G/L kick · H/; special';
        out.push({ text: who + (local[0] && local[1] ? '' : ' (you)'), head: true });
        out.push({ text: kbTxt });
      }
      if (any) {
        out.push({ text: 'Hold away from your foe to block (crouch-block sweeps, stand-block jump-ins).' });
        out.push({ text: 'Full SUPER meter: special unleashes your SUPER.' });
      }
      return out;
    }
    var badge = show ? 'CPU SHOWDOWN' : isMirror && !(local[0] || local[1]) ? 'LIVE' : '';
    var rend = makeRenderer(cv, { p1: p1, p2: p2, seed: seed, reducedMotion: rm, audio: audio, legend: legendLines(), badge: badge, debug: !!o.debug });

    /* ----- touch pads ----- */
    var pads = [], pointers = {};
    function buildPads() {
      pads.forEach(function (pd) { if (pd.el.parentNode) pd.el.parentNode.removeChild(pd.el); });
      pads = [];
      for (var i = 0; i < 2; i++) {
        if (!padKind[i]) continue;
        var el = document.createElement('div'); el.className = 'duel-pad';
        var dp = document.createElement('div'); dp.className = 'duel-dpad';
        ['u', 'r', 'd', 'l'].forEach(function (c) { var a = document.createElement('i'); a.className = c; dp.appendChild(a); });
        var knob = document.createElement('b'); dp.appendChild(knob);
        el.appendChild(dp);
        var btns = [];
        [['p', 'P', 'punch', PUNCH], ['k', 'K', 'kick', KICK], ['s', 'S', 'special', SPECIAL]].forEach(function (d) {
          var b = document.createElement('div'); b.className = 'duel-btn ' + d[0];
          b.appendChild(document.createTextNode(d[1])); var sm = document.createElement('small'); sm.textContent = d[2]; b.appendChild(sm);
          el.appendChild(b); btns.push({ el: b, bit: d[3], label: sm, name: d[2] });
        });
        wrap.appendChild(el);
        var pd = { seat: i, el: el, dp: dp, knob: knob, btns: btns, dir: 0, held: {}, mirrored: padKind[i] === 'touch2' && padKind[0] === 'touch1' };
        pads.push(pd);
        bindPad(pd);
      }
    }
    function padBits(pd) {
      var b = pd.dir; for (var k in pd.held) if (pd.held[k]) b |= pd.held[k];
      return b;
    }
    function applyPad(pd) {
      var c = ctrls[pd.seat];
      c.tp = padBits(pd); c.sync();
      var dx = (pd.dir & RIGHT ? 1 : 0) - (pd.dir & LEFT ? 1 : 0), dy = (pd.dir & DOWN ? 1 : 0) - (pd.dir & UP ? 1 : 0);
      pd.knob.style.transform = 'translate(' + dx * 60 + '%,' + dy * 60 + '%)';
      pd.btns.forEach(function (b) { var onB = false; for (var k in pd.held) if (pd.held[k] === b.bit) onB = true; b.el.classList.toggle('on', onB); });
    }
    function dirFrom(pd, cx, cy) {
      var r = pd.dp.getBoundingClientRect(), x = cx - (r.left + r.width / 2), y = cy - (r.top + r.height / 2), R = r.width / 2;
      if (Math.sqrt(x * x + y * y) < R * 0.2) return 0;
      var a = Math.atan2(y, x) * 180 / Math.PI, b = 0;
      if (a > -67.5 && a < 67.5) b |= RIGHT;
      if (a > 112.5 || a < -112.5) b |= LEFT;
      if (a < -22.5 && a > -157.5) b |= UP;
      if (a > 22.5 && a < 157.5) b |= DOWN;
      return b;
    }
    function btnAt(pd, cx, cy) {
      var best = null, bd = 1e9;
      pd.btns.forEach(function (b) {
        var r = b.el.getBoundingClientRect(), x = cx - (r.left + r.width / 2), y = cy - (r.top + r.height / 2), d = Math.sqrt(x * x + y * y);
        if (d < r.width * 0.75 && d < bd) { bd = d; best = b; }
      });
      return best;
    }
    function bindPad(pd) {
      on(pd.el, 'pointerdown', function (e) {
        e.preventDefault(); if (audio) audio.wake();
        var r = pd.dp.getBoundingClientRect(), x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
        var c = ctrls[pd.seat];
        if (Math.sqrt(x * x + y * y) < r.width * 0.68) {
          pointers[e.pointerId] = { pd: pd, kind: 'd' };
          var nd = dirFrom(pd, e.clientX, e.clientY);
          if ((nd & UP) && !(pd.dir & UP)) c.press(0);
          pd.dir = nd;
        } else {
          var b = btnAt(pd, e.clientX, e.clientY); if (!b) return;
          pointers[e.pointerId] = { pd: pd, kind: 'b' };
          pd.held[e.pointerId] = b.bit; c.press(bitIndex(b.bit));
        }
        try { pd.el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        applyPad(pd);
      });
      on(pd.el, 'pointermove', function (e) {
        var P = pointers[e.pointerId]; if (!P || P.pd !== pd) return;
        e.preventDefault();
        var c = ctrls[pd.seat];
        if (P.kind === 'd') { var nd = dirFrom(pd, e.clientX, e.clientY); if ((nd & UP) && !(pd.dir & UP)) c.press(0); if (nd !== pd.dir) { pd.dir = nd; applyPad(pd); } }
        else { var b = btnAt(pd, e.clientX, e.clientY); if (b && b.bit !== pd.held[e.pointerId]) { pd.held[e.pointerId] = b.bit; c.press(bitIndex(b.bit)); applyPad(pd); } }
      });
      function up(e) {
        var P = pointers[e.pointerId]; if (!P || P.pd !== pd) return;
        delete pointers[e.pointerId];
        if (P.kind === 'd') pd.dir = 0; else delete pd.held[e.pointerId];
        applyPad(pd);
      }
      on(pd.el, 'pointerup', up); on(pd.el, 'pointercancel', up); on(pd.el, 'lostpointercapture', up);
      on(pd.el, 'contextmenu', function (e) { e.preventDefault(); });
    }
    function updatePadButtons(view) {
      for (var i = 0; i < pads.length; i++) {
        var pd = pads[i], f = view.F[pd.seat], sb = pd.btns[2];
        var ready = f.meter >= MAXM, cool = !ready && f.cd > 0;
        if (pd.ready !== ready) { pd.ready = ready; sb.el.classList.toggle('ready', ready); sb.label.textContent = ready ? 'SUPER' : 'special'; }
        if (pd.cool !== cool) { pd.cool = cool; sb.el.classList.toggle('cool', cool); }
      }
    }

    /* ----- layout ----- */
    function layout() {
      if (dead) return;
      var W = wrap.clientWidth || root.clientWidth || window.innerWidth, H = wrap.clientHeight || root.clientHeight || window.innerHeight;
      if (W < 50 || H < 50) return;
      var touch = pads.length > 0, isPortrait = H > W * 1.05, cw, ch, cx, cyy, padTop = 0, padH = 0;
      if (touch && isPortrait) {
        padH = clamp(Math.round(H * 0.34), 190, 330);
        var asp = clamp(W / Math.max(100, H - padH - 10), 0.75, 16 / 9);
        cw = W; ch = Math.round(W / asp);
        cx = 0; cyy = Math.max(0, Math.round((H - padH - ch) / 2));
        padTop = H - padH;
      } else {
        // fill the box: anything from a tall phone (0.75) to a wide phone in landscape (2.2)
        var asp2 = clamp(W / H, 0.75, 2.2);
        if (W / H > asp2) { ch = H; cw = Math.round(H * asp2); } else { cw = W; ch = Math.round(W / asp2); }
        cx = Math.round((W - cw) / 2); cyy = Math.round((H - ch) / 2);
        padTop = 0; padH = H;
      }
      cv.style.left = cx + 'px'; cv.style.top = cyy + 'px';
      rend.resize(cw, ch, isPortrait && cw / ch < 1.5);
      // pads
      var n = pads.length;
      for (var i = 0; i < n; i++) {
        var pd = pads[i], areaW = n === 2 ? W / 2 : W, areaX = n === 2 ? (pd.seat === 0 ? 0 : W / 2) : 0;
        var overlay = !(isPortrait && touch);
        var base = overlay ? Math.min(H * 0.42, areaW * (n === 2 ? 0.42 : 0.24)) : Math.min(padH * 0.62, areaW * (n === 2 ? 0.46 : 0.42));
        base = clamp(base, 96, 190);
        var bs = clamp(base * 0.42, 44, 78), gap = 10;
        var areaH = overlay ? H : padH, top = overlay ? 0 : padTop;
        var mir = n === 2 && pd.seat === 1;
        pd.el.style.left = areaX + 'px'; pd.el.style.top = top + 'px'; pd.el.style.width = areaW + 'px'; pd.el.style.height = areaH + 'px';
        pd.el.style.pointerEvents = 'none';
        var dpx = mir ? areaW - base - 14 : 14, dpy = areaH - base - (overlay ? 14 : 22);
        if (!overlay) dpy = Math.round((areaH - base) / 2 + 6);
        pd.dp.style.left = dpx + 'px'; pd.dp.style.top = dpy + 'px'; pd.dp.style.width = base + 'px'; pd.dp.style.height = base + 'px';
        pd.dp.style.pointerEvents = 'auto';
        // three buttons in a triangle, on the other side of the d-pad
        var bxBase = mir ? 14 : areaW - 14 - bs * 2 - gap, byBase = dpy + base / 2 - bs - gap / 2;
        if (n === 2) bxBase = mir ? dpx - bs * 2 - gap - 18 : dpx + base + 18;
        var posB = [[0, bs + gap], [bs + gap, bs + gap], [(bs + gap) / 2 + (mir ? -0 : 0), 0]];
        if (n === 1 || true) posB = mir ? [[bs + gap, bs + gap], [0, bs + gap], [(bs + gap) / 2, 0]] : [[0, bs + gap], [bs + gap, bs + gap], [(bs + gap) / 2, 0]];
        for (var j = 0; j < 3; j++) {
          var be = pd.btns[j].el;
          be.style.width = be.style.height = bs + 'px';
          be.style.left = (bxBase + posB[j][0]) + 'px'; be.style.top = (byBase + posB[j][1]) + 'px';
          be.style.fontSize = Math.round(bs * 0.36) + 'px'; be.style.pointerEvents = 'auto';
        }
      }
    }

    /* ----- keyboard ----- */
    var keysDown = {};
    function kbSync() {
      for (var i = 0; i < 2; i++) {
        var c = ctrls[i], b = 0;
        for (var j = 0; j < keyMaps[i].length; j++) { var mp = keyMaps[i][j]; for (var code in keysDown) if (keysDown[code] && mp[code]) b |= mp[code]; }
        c.kb = b; c.sync();
      }
    }
    function codeOf(e) { var c = e.code; if (c && (KB1[c] || KB2[c])) return c; var k = String(e.key || '').toLowerCase(); return KEYNAME[k] || c || ''; }
    function ownsKey(code) { for (var i = 0; i < 2; i++) for (var j = 0; j < keyMaps[i].length; j++) if (keyMaps[i][j][code]) return true; return false; }
    function typingTarget(e) { var t = e.target; if (!t || !t.tagName) return false; var n = t.tagName; return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || t.isContentEditable; }
    if (keyMaps[0].length || keyMaps[1].length) {
      on(window, 'keydown', function (e) {
        if (e.ctrlKey || e.metaKey || e.altKey || typingTarget(e)) return;
        var code = codeOf(e); if (!ownsKey(code)) return;
        e.preventDefault();
        if (audio) audio.wake();
        if (!keysDown[code]) {
          keysDown[code] = true;
          for (var i = 0; i < 2; i++) for (var j = 0; j < keyMaps[i].length; j++) { var bit = keyMaps[i][j][code]; if (bit) { var bi = bitIndex(bit); if (bi >= 0) ctrls[i].press(bi); } }
        }
        kbSync();
      }, true);
      on(window, 'keyup', function (e) {
        var code = codeOf(e); if (!keysDown[code]) return;
        delete keysDown[code]; kbSync();
      }, true);
      on(window, 'blur', function () { keysDown = {}; kbSync(); });
      // a touch on a keyboard seat's screen means the caller guessed wrong: show pads
      on(wrap, 'pointerdown', function (e) {
        if (e.pointerType !== 'touch' || pads.length) return;
        var changed = false;
        for (var i = 0; i < 2; i++) {
          if (!local[i] || padKind[i]) continue;
          padKind[i] = modes[i] === 'kb1' ? 'touch1' : modes[i] === 'kb2' ? 'touch2' : 'touchAny';
          changed = true;
        }
        if (changed) { buildPads(); layout(); }
      });
    }
    on(document, 'visibilitychange', function () { if (document.hidden) { keysDown = {}; kbSync(); } });
    buildPads();

    if (window.ResizeObserver) { ro = new ResizeObserver(function () { layout(); }); ro.observe(wrap); }
    on(window, 'resize', layout);
    on(window, 'orientationchange', layout);
    layout();

    /* ----- runner bookkeeping ----- */
    var lastEv = 0, sent = [], lastPh = -1;
    function buildSnap() {
      var g = sim.g, F = sim.F, cutoff = g.f - 45, ev = [];
      sent = sent.filter(function (e) { return e.f >= cutoff; });
      for (var i = Math.max(0, sent.length - 14); i < sent.length; i++) { var e = sent[i]; ev.push([e.id, e.f, e.t, e.x, e.y, e.a]); }
      var pr = g.pr.map(function (p) { return [Math.round(p.x), Math.round(p.y), p.o, p.id, p.vx > 0 ? 1 : -1]; });
      return { v: 1, f: g.f, r: g.r, ph: g.ph, pt: Math.min(9999, g.pt), tm: g.tm, w: [g.w[0], g.w[1]], rw: g.rw, hw: g.how, mw: g.mw,
        fz: g.frz, fb: g.frzBy, a: fArr(F[0]), b: fArr(F[1]), p: pr, e: ev, n: g.log.length };
    }
    function result() {
      var g = sim.g, F = sim.F, lr = g.log[g.log.length - 1] || {};
      return { winner: g.mw, hp1: Math.ceil(F[0].hp), hp2: Math.ceil(F[1].hp), rounds: g.log.length, wins: [g.w[0], g.w[1]],
        how: g.tieBreak ? 'decision' : (lr.how || 'ko'), log: g.log.slice(), frames: g.f, secs: Math.round(g.f / FPS * 10) / 10 };
    }
    function runnerView() {
      var g = sim.g;
      return { f: g.f, r: g.r, ph: g.ph, pt: g.pt, tm: g.tm, w: g.w, rw: g.rw, how: g.how, mw: g.mw, frz: g.frz, frzBy: g.frzBy, F: sim.F, pr: g.pr, show: show };
    }
    function stepOnce(tms) {
      var g = sim.g;
      for (var i = 0; i < 2; i++) if (modes[i] === 'remote' && ctrls[i].held && tms - ctrls[i].lastAt > 1500) ctrls[i].held = 0;
      sim.step(ctrls, ais);
      if (g.ev.length) {
        for (var k = 0; k < g.ev.length; k++) { rend.event(g.ev[k]); sent.push(g.ev[k]); }
        g.ev = [];
      }
      if (typeof o.onFrame === 'function' && (g.f % 6 === 0 || g.ph !== lastPh)) safe(o.onFrame, buildSnap());
      lastPh = g.ph;
      if (g.ended && !ended) { ended = true; safe(o.onEnd, result()); }
    }

    /* ----- mirror bookkeeping ----- */
    var M = { buf: [], samples: [], rf: null, lastRecv: 0, seen: {}, seenN: [], endFired: false, last: null };
    function pushFrame(s) {
      if (dead || !isMirror) return;
      if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { return; } }
      if (!validSnap(s)) return;
      var t = nowMs();
      M.lastRecv = t;
      M.samples.push(t * 0.06 - s.f); if (M.samples.length > 40) M.samples.shift();
      var b = M.buf, i = b.length;
      while (i > 0 && b[i - 1].f > s.f) i--;
      if (i > 0 && b[i - 1].f === s.f) return;
      b.splice(i, 0, s);
      if (b.length > 40) b.shift();
    }
    function mirrorClock(dt) {
      if (!M.buf.length) return;
      var sm = M.samples.slice().sort(function (a, b) { return a - b; });
      var off = sm[0], spread = sm[Math.floor((sm.length - 1) * 0.9)] - off;
      var delay = clamp(spread + 8, 9, 48);
      var target = nowMs() * 0.06 - off - delay;
      if (M.rf === null) M.rf = target;
      else {
        M.rf += dt * 0.06;
        var err = target - M.rf;
        if (Math.abs(err) > 50) M.rf = target; else M.rf += clamp(err * 0.06, -0.6, 0.6);
      }
    }
    function mirrorView() {
      var b = M.buf;
      if (!b.length) {
        return { f: 0, r: 1, ph: P_INTRO, pt: 0, tm: ROUND_F, w: [0, 0], rw: 0, how: 0, mw: 0, frz: 0, frzBy: 0, show: false,
          F: [fObj([330, 0, 1, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0], 1), fObj([630, 0, -1, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0], 2)], pr: [], waiting: 'Waiting for the fight…' };
      }
      var rf = M.rf, A = b[0], B = null, i;
      for (i = 0; i < b.length; i++) { if (b[i].f <= rf) A = b[i]; else { B = b[i]; break; } }
      if (A.f > rf) B = null;
      var k = B ? clamp((rf - A.f) / Math.max(1, B.f - A.f), 0, 1) : 0, adv = Math.max(0, Math.round(rf - A.f));
      var ph = A.ph | 0, pt = (A.pt | 0) + adv;
      var F = [fObj(A.a, 1), fObj(A.b, 2)];
      if (B) {
        var FB = [fObj(B.a, 1), fObj(B.b, 2)];
        for (i = 0; i < 2; i++) {
          if (Math.abs(FB[i].x - F[i].x) < 160 && B.r === A.r) { F[i].x = lerp(F[i].x, FB[i].x, k); F[i].y = lerp(F[i].y, FB[i].y, k); F[i].hp = lerp(F[i].hp, FB[i].hp, k); F[i].meter = lerp(F[i].meter, FB[i].meter, k); }
          if (FB[i].st === F[i].st && FB[i].mv === F[i].mv) F[i].sf = Math.min(F[i].sf + adv, FB[i].sf);
          else F[i].sf += Math.min(adv, Math.max(0, B.f - A.f - 1));
        }
      } else if (ph !== P_END && ph !== P_KO) { for (i = 0; i < 2; i++) F[i].sf += Math.min(adv, 12); }
      else for (i = 0; i < 2; i++) F[i].sf += adv;
      var pr = [];
      (A.p || []).forEach(function (pa) {
        var x = +pa[0], y = +pa[1];
        if (B) { (B.p || []).forEach(function (pb) { if (pb[3] === pa[3]) x = lerp(x, +pb[0], k); }); }
        else x += (pa[4] || 1) * PROJ_V * Math.min(adv, 20);
        pr.push({ x: x, y: y, o: pa[2] === 2 ? 2 : 1, id: pa[3], vx: (pa[4] || 1) * PROJ_V });
      });
      var fz = Math.max(0, (A.fz | 0) - adv);
      var waiting = (ph !== P_END && nowMs() - M.lastRecv > 2500) ? 'Reconnecting…' : '';
      return { f: Math.round(rf), r: A.r | 0, ph: ph, pt: pt, tm: Math.max(0, (A.tm | 0) - (ph === P_FIGHT ? adv : 0)), w: Array.isArray(A.w) ? A.w : [0, 0],
        rw: A.rw | 0, how: A.hw | 0, mw: A.mw | 0, frz: fz, frzBy: A.fb | 0, F: F, pr: pr, show: false, waiting: waiting, A: A };
    }
    function mirrorEvents(rf) {
      for (var i = 0; i < M.buf.length; i++) {
        var ev = M.buf[i].e; if (!Array.isArray(ev)) continue;
        for (var j = 0; j < ev.length; j++) {
          var e = ev[j]; if (!Array.isArray(e)) continue;
          var id = e[0] | 0;
          if (M.seen[id] || e[1] > rf) continue;
          M.seen[id] = 1; M.seenN.push(id); if (M.seenN.length > 300) delete M.seen[M.seenN.shift()];
          if (rf - e[1] > 40) continue;
          rend.event({ id: id, f: e[1], t: e[2] | 0, x: +e[3] || 0, y: +e[4] || 0, a: e[5] | 0 });
        }
      }
      while (M.buf.length > 2 && M.buf[1].f < rf - 60) M.buf.shift();
    }
    var lastSent = -1, lastSentAt = 0;
    function mirrorInputs(t) {
      if (typeof o.onInput !== 'function') return;
      for (var i = 0; i < 2; i++) {
        if (!local[i]) continue;
        var bits = ctrls[i].out();
        if (bits !== lastSent || t - lastSentAt > 200) { lastSent = bits; lastSentAt = t; safe(o.onInput, bits); }
      }
    }
    function mirrorEnd(view) {
      if (M.endFired || view.ph !== P_END || !view.mw) return;
      if (view.pt < 120) return;
      M.endFired = true; ended = true;
      var A = view.A || {}, la = A.a || [], lb = A.b || [];
      safe(o.onEnd, { winner: view.mw, hp1: Math.ceil((la[7] | 0) / 10), hp2: Math.ceil((lb[7] | 0) / 10), rounds: A.n | 0, wins: view.w.slice(), how: 'ko', mirror: true });
    }

    /* ----- loop ----- */
    var last = nowMs(), acc = 0, lastRaf = last;
    function tick(t, draw) {
      if (dead) return;
      var dt = clamp(t - last, 0, 1000); last = t;
      var view;
      if (!isMirror) {
        acc += dt * 0.06 * timeScale;
        var maxSteps = Math.ceil(65 * timeScale), n = 0;
        while (acc >= 1 && n < maxSteps) { stepOnce(t); acc -= 1; n++; if (dead) return; }
        if (acc > 6) acc = 0;
        if (!draw || document.hidden) return;
        view = runnerView();
      } else {
        mirrorClock(dt);
        mirrorInputs(t);
        if (dead) return;
        view = mirrorView(); M.last = view;
        mirrorEvents(M.rf === null ? 0 : M.rf);
        mirrorEnd(view);
        if (dead || !draw || document.hidden) return;
      }
      updatePadButtons(view);
      rend.render(view, dt);
    }
    function loop(t) {
      if (dead) return;
      raf = requestAnimationFrame(loop);
      lastRaf = nowMs();
      tick(lastRaf, true);
    }
    raf = requestAnimationFrame(loop);
    iv = setInterval(function () { var t = nowMs(); if (t - lastRaf > 300) tick(t, false); }, 250);

    var handle = {
      remoteInput: function (bits) {
        if (dead || isMirror) return;
        var t = nowMs();
        for (var i = 0; i < 2; i++) if (modes[i] === 'remote') ctrls[i].remote(bits, t);
      },
      pushFrame: pushFrame,
      destroy: function () {
        if (dead) return;
        dead = true;
        cancelAnimationFrame(raf); clearInterval(iv);
        for (var i = 0; i < offs.length; i++) { try { offs[i](); } catch (e) { /* ignore */ } }
        offs = [];
        if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } ro = null; }
        if (audio) audio.close();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (rootPos) root.style.position = rootPos === ' ' ? '' : rootPos;
        dropStyle();
      },
      // test/diagnostic hook: read-only summary of the live state
      debug: function () {
        var out = { mirror: isMirror, dead: dead, ended: ended, audio: audio ? audio.state() : 'off', modes: modes.slice() };
        if (sim) {
          var g = sim.g;
          out.f = g.f; out.phase = g.ph; out.round = g.r; out.wins = g.w.slice(); out.hp = [sim.F[0].hp, sim.F[1].hp]; out.winner = g.mw;
          out.st = [sim.F[0].st, sim.F[1].st]; out.mv = [sim.F[0].mv, sim.F[1].mv]; out.x = [sim.F[0].x, sim.F[1].x]; out.meter = [sim.F[0].meter, sim.F[1].meter];
          out.plan = g.plan; out.proj = g.pr.length; out.frz = g.frz; out.pt = g.pt; out.sub = [sim.F[0].sub, sim.F[1].sub]; out.sf = [sim.F[0].sf, sim.F[1].sf]; out.how = g.how;
        } else {
          out.buf = M.buf.length; out.rf = M.rf; out.latest = M.buf.length ? M.buf[M.buf.length - 1].f : null;
          var v = M.last; if (v) { out.f = v.f; out.phase = v.ph; out.round = v.r; out.wins = v.w.slice(); out.winner = v.mw; out.x = [v.F[0].x, v.F[1].x]; out.y = [v.F[0].y, v.F[1].y]; out.hp = [v.F[0].hp, v.F[1].hp]; out.st = [v.F[0].st, v.F[1].st]; out.mv = [v.F[0].mv, v.F[1].mv]; out.waiting = v.waiting; }
        }
        return out;
      }
    };
    return handle;
  }

  window.Duel = { start: start, INPUT: INPUT, version: 1 };
})();
