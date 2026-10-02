/* Chutes & Ladders minigames (mg-a):
 *   - 'needle'    Needle Stop  (timing: stop a sweeping needle inside a shrinking green zone, 5 tries)
 *   - 'quickdraw' Quick Draw   (reaction: tap on the green SPIN!, ignore decoys, 4 rounds)
 * Requires the page preamble: const MINIGAMES = []; function mulberry32(a){...}
 * All challenge randomness comes from ctx.rng(); timing is performance.now()-based (frame-rate independent).
 */
(function () {
  'use strict';

  /* ---------- shared helpers (private to this IIFE) ---------- */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = v && v.trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  // Prefer the event's own timestamp (same clock as performance.now() in modern browsers);
  // fall back to performance.now() if it looks like an epoch timestamp or is otherwise off.
  function evTime(e) {
    var now = performance.now();
    var t = e && typeof e.timeStamp === 'number' ? e.timeStamp : 0;
    if (t > 0 && t <= now + 5 && now - t < 250) return t;
    return now;
  }
  // rough luminance test for '#rgb', '#rrggbb' or 'rgb(...)' strings; unknown formats count as light
  function isDarkColor(c) {
    var r, g, b, m;
    c = String(c || '').trim();
    if ((m = c.match(/^#([0-9a-f]{3})$/i))) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
    else if ((m = c.match(/^#([0-9a-f]{6})/i))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
    else if ((m = c.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i))) { r = +m[1]; g = +m[2]; b = +m[3]; }
    else return false;
    return (0.299 * r + 0.587 * g + 0.114 * b) < 110;
  }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function isGoKey(e) {
    return e.code === 'Space' || e.key === ' ' || e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
  }
  function findCharImg(ctx) {
    try {
      var p = ctx.player, chars = ctx.chars || [];
      if (!p) return null;
      var id = p.char && typeof p.char === 'object' ? p.char.id : p.char;
      for (var i = 0; i < chars.length; i++) if (chars[i].id === id) return chars[i].img || null;
      if (p.char && p.char.img) return p.char.img;
    } catch (e) { /* ignore */ }
    return null;
  }

  var STYLE_ID = 'mg-a-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.mg-needle-root,.mg-quickdraw-root{position:relative;width:100%;user-select:none;-webkit-user-select:none;',
      '  touch-action:none;-webkit-tap-highlight-color:transparent;cursor:pointer;outline:none;font-family:system-ui,sans-serif;}',
      '.mg-needle-root canvas{display:block;width:100%;}',
      '.mg-quickdraw-root{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;}',
      '.mg-quickdraw-hud{display:flex;align-items:center;justify-content:space-between;gap:8px;height:34px;flex:0 0 auto;',
      '  font-family:Fredoka,system-ui,sans-serif;font-weight:600;color:var(--ink,#222);}',
      '.mg-quickdraw-hud .mg-quickdraw-tag{background:var(--accent-soft,#e8eefc);color:var(--ink,#222);border-radius:999px;padding:4px 12px;font-size:15px;white-space:nowrap;}',
      '.mg-quickdraw-pips{display:flex;gap:6px;}',
      '.mg-quickdraw-pip{width:14px;height:14px;border-radius:50%;border:2px solid var(--line,#ccc);box-sizing:border-box;}',
      '.mg-quickdraw-pip.cur{border-color:var(--accent,#3b82f6);}',
      '.mg-quickdraw-pip.ok{background:#22c55e;border-color:#15803d;}',
      '.mg-quickdraw-pip.top{background:#f59e0b;border-color:#b45309;}',
      '.mg-quickdraw-pip.bad{background:#ef4444;border-color:#b91c1c;}',
      '.mg-quickdraw-cue{flex:1 1 auto;min-height:0;border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;',
      '  text-align:center;box-sizing:border-box;border:4px solid transparent;padding:8px;overflow:hidden;}',
      '.mg-quickdraw-cue .mg-quickdraw-icon{line-height:0;}',
      '.mg-quickdraw-cue .mg-quickdraw-big{font-family:Fredoka,system-ui,sans-serif;font-weight:700;line-height:1.02;letter-spacing:.5px;}',
      '.mg-quickdraw-cue .mg-quickdraw-sub{font-weight:600;margin-top:6px;opacity:.95;}',
      '.mg-quickdraw-cue[data-s="wait"]{background:var(--bg,#f4f4f4);border:4px dashed var(--line,#ccc);color:var(--muted,#666);}',
      '.mg-quickdraw-cue[data-s="decoy-wait"]{background:#facc15;border-color:#a16207;color:#3b2500;}',
      '.mg-quickdraw-cue[data-s="decoy-chute"]{background:#dc2626;border-color:#7f1d1d;color:#fff;}',
      '.mg-quickdraw-cue[data-s="go"]{background:#16a34a;border-color:#14532d;color:#fff;box-shadow:0 0 0 6px rgba(34,197,94,.35);}',
      '.mg-quickdraw-cue[data-s="res"]{background:var(--panel,#fff);border:4px solid var(--line,#ccc);color:var(--ink,#222);}',
      '.mg-quickdraw-cue[data-s="bad"]{background:var(--panel,#fff);border:4px solid #ef4444;color:var(--ink,#222);}',
      '.mg-quickdraw-cue[data-s="bad"] .mg-quickdraw-big{color:#ef4444;}',
      '.mg-quickdraw-cue[data-s="end"]{background:var(--accent-soft,#e8eefc);border:4px solid var(--accent,#3b82f6);color:var(--ink,#222);}',
      '.mg-quickdraw-pop{animation:mg-quickdraw-pop .14s ease-out;}',
      '@keyframes mg-quickdraw-pop{from{transform:scale(.88)}to{transform:scale(1)}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  /* ======================================================================
   * NEEDLE STOP
   * ==================================================================== */
  var N_TRIES = 5;
  var N_TRAVERSE = [1.10, 0.95, 0.82, 0.72, 0.64];   // seconds for one full left->right sweep
  var N_WIDTH = [0.20, 0.17, 0.145, 0.125, 0.11];    // zone width as fraction of the arc
  var N_TRY_MS = 2000;                               // per-try time limit
  var N_SHOW_MS = 700;                               // result display per try
  var N_END_MS = 850;                                // final "Score: N"
  var N_HARD_MS = 14600;                             // absolute safety cap

  function needleScore(d, hw) {
    if (d > hw) return 0;
    var r = d / hw;
    if (r <= 0.25) return 100;                        // bullseye
    return Math.round(100 - 65 * (r - 0.25) / 0.75);  // 100 .. 35 at the zone edge
  }
  function needleLabel(pts) {
    if (pts >= 100) return 'Perfect!';
    if (pts >= 75) return 'Great!';
    if (pts > 0) return 'Close';
    return 'Miss';
  }
  function triPos(phi) { phi = phi % 2; if (phi < 0) phi += 2; return phi < 1 ? phi : 2 - phi; }

  function needleChallenge(rng) {
    var out = [];
    for (var i = 0; i < N_TRIES; i++) {
      var hw = N_WIDTH[i] / 2;
      var lo = hw + 0.06, hi = 1 - hw - 0.06;
      var c = lo + rng() * (hi - lo);
      // needle start: at least 0.35 of the arc away from the zone centre
      var gap = 0.35;
      var aLen = Math.max(0, c - gap), bLen = Math.max(0, 1 - (c + gap));
      var u = rng() * (aLen + bLen);
      var p0 = u < aLen ? u : c + gap + (u - aLen);
      var right = rng() < 0.5;
      var phi0 = right ? p0 : 2 - p0;
      if (p0 <= 0.0001) phi0 = 0; else if (p0 >= 0.9999) phi0 = 1;
      out.push({ c: +c.toFixed(5), w: N_WIDTH[i], T: N_TRAVERSE[i], p0: +p0.toFixed(5), phi0: +phi0.toFixed(5), dir: right ? 1 : -1 });
    }
    return out;
  }

  function playNeedle(stage, ctx) {
    return new Promise(function (resolve) {
      injectStyle();
      var rng = ctx.rng;
      var tries = needleChallenge(rng);

      var W = Math.max(300, Math.round(stage.clientWidth || 520));
      var H = Math.round(Math.min(380, W * 0.62));
      var dpr = Math.min(3, window.devicePixelRatio || 1);

      var root = document.createElement('div');
      root.className = 'mg-needle-root';
      root.tabIndex = 0;
      root.setAttribute('role', 'button');
      root.setAttribute('aria-label', 'Needle Stop: tap or press Space to stop the needle');
      root.setAttribute('data-mg-challenge', JSON.stringify(tries));
      var cv = document.createElement('canvas');
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.height = H + 'px';
      root.appendChild(cv);
      stage.innerHTML = '';
      stage.appendChild(root);
      var g = cv.getContext('2d');

      var col = {
        ink: cssVar('--ink', '#1f2937'), muted: cssVar('--muted', '#6b7280'), line: cssVar('--line', '#d1d5db'),
        panel: cssVar('--panel', '#ffffff'), bg: cssVar('--bg', '#f3f4f6'), accent: cssVar('--accent', '#3b82f6'),
        soft: cssVar('--accent-soft', '#dbeafe'),
        c: [cssVar('--c1', '#ef4444'), cssVar('--c2', '#f59e0b'), cssVar('--c3', '#10b981'), cssVar('--c4', '#3b82f6'), cssVar('--c5', '#8b5cf6')]
      };
      var playerColor = (ctx.player && ctx.player.color) || col.accent;
      var trackAlpha = isDarkColor(col.bg) ? 0.5 : 0.3;
      var avatar = null;
      var imgSrc = findCharImg(ctx);
      if (imgSrc) { avatar = new Image(); avatar.src = imgSrc; }

      // geometry
      var cx = W / 2, py = H - 30;
      var R = Math.min(W / 2 - 20, py - 50);
      var Ro = R, Ri = R * 0.74;
      var M = 0.05, A0 = Math.PI + M, SPAN = Math.PI - 2 * M;
      function ang(p) { return A0 + clamp(p, 0, 1) * SPAN; }

      var total = 0, results = [], idx = 0;
      var phase = 'run';         // run | show | end | done
      var t0 = 0, phaseStart = 0, stopP = null, lastPts = 0;
      var gameStart = performance.now();
      var raf = 0, done = false;

      function startTry(now) {
        phase = 'run'; t0 = now; phaseStart = now; stopP = null;
        root.setAttribute('data-mg-try', JSON.stringify({ i: idx, t0: t0 }));
      }
      function posAt(i, t) { var tr = tries[i]; return triPos(tr.phi0 + Math.max(0, t - t0) / 1000 / tr.T); }

      function resolveTry(p, now) {
        var tr = tries[idx];
        var pts = p == null ? 0 : needleScore(Math.abs(p - tr.c), tr.w / 2);
        lastPts = pts; total += pts;
        results.push({ p: p, pts: pts, label: p == null ? 'Too slow' : needleLabel(pts) });
        stopP = p == null ? posAt(idx, now) : p;
        phase = 'show'; phaseStart = now;
        root.setAttribute('data-mg-results', JSON.stringify(results));
      }

      function onPress(t) {
        if (done || phase !== 'run') return;
        var now = performance.now();
        var tt = clamp(t, t0, now);
        resolveTry(posAt(idx, tt), now);
      }
      function onPointer(e) {
        if (e.isPrimary === false) return;
        if (e.cancelable) e.preventDefault();
        onPress(evTime(e));
      }
      function onKey(e) {
        if (!isGoKey(e)) return;
        e.preventDefault();
        if (e.repeat) return;
        onPress(evTime(e));
      }
      function onAbort() { finish(true); }

      function cleanup() {
        cancelAnimationFrame(raf);
        root.removeEventListener('pointerdown', onPointer);
        window.removeEventListener('keydown', onKey, true);
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      }
      function finish(immediate) {
        if (done) return;
        done = true; phase = 'done';
        cleanup();
        resolve(Math.max(0, Math.round(total)) | 0);
      }

      /* ---- drawing ---- */
      function ring(a1, a2, r1, r2) {
        g.beginPath(); g.arc(cx, py, r2, a1, a2, false); g.arc(cx, py, r1, a2, a1, true); g.closePath();
      }
      function roundRect(x, y, w, h, r) {
        g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
        g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
        g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
      }
      function font(wt, px) { return wt + ' ' + px + 'px Fredoka, system-ui, sans-serif'; }
      function resultColor(pts) { return pts >= 100 ? '#f59e0b' : pts > 0 ? '#22c55e' : '#ef4444'; }

      function draw(now) {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        var tr = tries[Math.min(idx, N_TRIES - 1)];

        // gauge face
        g.beginPath(); g.arc(cx, py, Ro + 12, Math.PI, 2 * Math.PI); g.lineTo(cx + Ro + 12, py + 14);
        g.lineTo(cx - Ro - 12, py + 14); g.closePath();
        g.fillStyle = col.bg; g.fill(); g.lineWidth = 2; g.strokeStyle = col.line; g.stroke();

        // cheerful segmented track
        var segs = 10;
        for (var k = 0; k < segs; k++) {
          ring(A0 + SPAN * k / segs, A0 + SPAN * (k + 1) / segs, Ri, Ro);
          g.globalAlpha = trackAlpha; g.fillStyle = col.c[k % 5]; g.fill(); g.globalAlpha = 1;
        }
        ring(A0, A0 + SPAN, Ri, Ro); g.lineWidth = 2; g.strokeStyle = col.line; g.stroke();

        // ticks
        g.strokeStyle = col.muted; g.lineCap = 'round';
        for (var q = 0; q <= 20; q++) {
          var a = A0 + SPAN * q / 20, big = q % 5 === 0;
          g.lineWidth = big ? 2.5 : 1.5;
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * (Ri - 4), py + Math.sin(a) * (Ri - 4));
          g.lineTo(cx + Math.cos(a) * (Ri - (big ? 14 : 9)), py + Math.sin(a) * (Ri - (big ? 14 : 9)));
          g.stroke();
        }

        // target zone + bullseye core
        if (phase !== 'end' && phase !== 'done') {
          var hw = tr.w / 2;
          ring(ang(tr.c - hw), ang(tr.c + hw), Ri - 5, Ro + 5);
          g.fillStyle = '#22c55e'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#15803d'; g.stroke();
          ring(ang(tr.c - hw * 0.25), ang(tr.c + hw * 0.25), Ri - 5, Ro + 5);
          g.fillStyle = '#dcfce7'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#15803d'; g.stroke();
        }

        // needle
        var p = phase === 'run' ? posAt(idx, now) : (stopP == null ? 0.5 : stopP);
        var na = ang(p);
        var tipR = Ro + 8;
        g.lineCap = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 8;
        g.beginPath(); g.moveTo(cx + 2, py + 3); g.lineTo(cx + Math.cos(na) * tipR + 2, py + Math.sin(na) * tipR + 3); g.stroke();
        g.strokeStyle = phase === 'show' ? resultColor(lastPts) : col.ink; g.lineWidth = 6;
        g.beginPath(); g.moveTo(cx, py); g.lineTo(cx + Math.cos(na) * tipR, py + Math.sin(na) * tipR); g.stroke();

        // hub (player avatar if available)
        var hubR = Math.max(14, Math.min(22, R * 0.11));
        g.beginPath(); g.arc(cx, py, hubR + 3, 0, 2 * Math.PI); g.fillStyle = col.panel; g.fill();
        g.beginPath(); g.arc(cx, py, hubR, 0, 2 * Math.PI); g.fillStyle = playerColor; g.fill();
        if (avatar && avatar.complete && avatar.naturalWidth) {
          g.save(); g.beginPath(); g.arc(cx, py, hubR - 2, 0, 2 * Math.PI); g.clip();
          try { g.drawImage(avatar, cx - hubR + 2, py - hubR + 2, 2 * hubR - 4, 2 * hubR - 4); } catch (e) { /* ignore */ }
          g.restore();
        }

        // HUD
        var fs = W < 400 ? 15 : 17;
        g.textBaseline = 'middle';
        g.font = font(600, fs); g.fillStyle = col.ink; g.textAlign = 'left';
        g.fillText('TRY ' + Math.min(idx + 1, N_TRIES) + '/' + N_TRIES, 10, 18);
        g.textAlign = 'right';
        g.fillText('SCORE ' + total, W - 10, 18);
        // pips
        var pipR = 6, pipGap = 18, px0 = cx - pipGap * (N_TRIES - 1) / 2;
        for (var j = 0; j < N_TRIES; j++) {
          g.beginPath(); g.arc(px0 + j * pipGap, 18, pipR, 0, 2 * Math.PI);
          if (j < results.length) { g.fillStyle = resultColor(results[j].pts); g.fill(); }
          else { g.lineWidth = 2; g.strokeStyle = j === idx ? col.accent : col.line; g.stroke(); }
        }

        // per-try time bar
        if (phase === 'run') {
          var frac = clamp(1 - (now - t0) / N_TRY_MS, 0, 1);
          var bw = W - 40;
          roundRect(20, H - 9, bw, 6, 3); g.fillStyle = col.line; g.fill();
          if (frac > 0) { roundRect(20, H - 9, Math.max(6, bw * frac), 6, 3); g.fillStyle = frac < 0.3 ? '#ef4444' : col.accent; g.fill(); }
        }

        // result / end overlay
        if (phase === 'show' || phase === 'end') {
          var isEnd = phase === 'end';
          var big = isEnd ? 'Score: ' + total : results[results.length - 1].label;
          var sub = isEnd ? '' : (lastPts > 0 ? '+' + lastPts : '+0');
          var bfs = Math.round(clamp(W * 0.062, 22, 38));
          var oy = py - Ri * 0.48;
          g.font = font(700, bfs);
          var tw = g.measureText(big).width;
          var bwid = Math.min(W - 16, tw + 36), bh = isEnd ? bfs + 22 : bfs + 34;
          roundRect(cx - bwid / 2, oy - bh / 2, bwid, bh, 16);
          g.fillStyle = col.panel; g.globalAlpha = 0.94; g.fill(); g.globalAlpha = 1;
          g.lineWidth = 3; g.strokeStyle = isEnd ? col.accent : resultColor(lastPts); g.stroke();
          g.textAlign = 'center'; g.fillStyle = isEnd ? col.ink : resultColor(lastPts);
          if (!isEnd && lastPts > 0 && lastPts < 100) g.fillStyle = '#16a34a';
          g.fillText(big, cx, isEnd ? oy + 1 : oy - 9);
          if (sub) { g.font = font(600, Math.round(bfs * 0.55)); g.fillStyle = col.ink; g.fillText(sub, cx, oy + bfs * 0.55); }
        }
      }

      function frame(now) {
        if (done) return;
        now = performance.now();
        if (now - gameStart > N_HARD_MS) { finish(); return; }
        if (phase === 'run' && now - t0 >= N_TRY_MS) resolveTry(null, t0 + N_TRY_MS);
        if (phase === 'show' && now - phaseStart >= N_SHOW_MS) {
          idx++;
          if (idx >= N_TRIES) { idx = N_TRIES - 1; phase = 'end'; phaseStart = now; root.setAttribute('data-mg-final', String(total)); }
          else startTry(now);
        }
        if (phase === 'end' && now - phaseStart >= N_END_MS) { draw(now); finish(); return; }
        draw(now);
        raf = requestAnimationFrame(frame);
      }

      if (ctx.signal) {
        if (ctx.signal.aborted) { done = true; resolve(0); return; }
        ctx.signal.addEventListener('abort', onAbort);
      }
      root.addEventListener('pointerdown', onPointer);
      window.addEventListener('keydown', onKey, true);
      startTry(performance.now());
      draw(performance.now());
      raf = requestAnimationFrame(frame);
    });
  }

  MINIGAMES.push({
    id: 'needle',
    title: 'Needle Stop',
    icon: '🎯',
    howto: 'Tap or press Space to stop the needle in the green zone. Dead centre scores most. 5 tries, one stop each; the zone shrinks and the needle speeds up.',
    max: 500,
    cpu: { mean: 295, sd: 85 },
    play: playNeedle
  });

  /* ======================================================================
   * QUICK DRAW
   * ==================================================================== */
  var Q_ROUNDS = 4;
  var Q_PTS = 250;              // per round max
  var Q_WAIT_BUDGET = 8.4;      // seconds, sum of all pre-GO waits
  var Q_GO_MS = 700;            // reaction window after GO
  var Q_RES_MS = 650;           // result display (hit or slow)
  var Q_BAD_MS = 850;           // result display after a false start
  var Q_END_MS = 850;
  var Q_HARD_MS = 14600;
  var Q_MIN_RT = 100;           // faster than this after GO = anticipation = false start
  var Q_DECOY_MS = 550;

  function qdPoints(ms) { return Math.round(Q_PTS * clamp((600 - ms) / 400, 0, 1)); } // <=200ms full, 600ms zero
  function qdLabel(ms) { return ms <= 230 ? 'Lightning!' : ms <= 300 ? 'Great!' : ms <= 400 ? 'Good' : 'Slow'; }

  function qdChallenge(rng) {
    // 1 or 2 decoys, only in rounds 2-4, so round 1 teaches the GO cue.
    var nDecoy = rng() < 0.5 ? 1 : 2;
    var pool = [1, 2, 3], decoyRounds = {};
    for (var k = 0; k < nDecoy; k++) { var j = Math.floor(rng() * pool.length); decoyRounds[pool[j]] = true; pool.splice(j, 1); }
    var mins = [], maxs = [], raw = [];
    for (var i = 0; i < Q_ROUNDS; i++) {
      var dec = !!decoyRounds[i];
      mins.push(dec ? 2.0 : 1.2); maxs.push(3.5); raw.push(rng());
    }
    var slack = Q_WAIT_BUDGET - mins.reduce(function (a, b) { return a + b; }, 0);
    var want = 0; for (i = 0; i < Q_ROUNDS; i++) want += raw[i] * (maxs[i] - mins[i]);
    var kf = want > slack ? slack / want : 1;
    var rounds = [];
    for (i = 0; i < Q_ROUNDS; i++) {
      var delay = mins[i] + raw[i] * (maxs[i] - mins[i]) * kf;
      var r = { delay: +delay.toFixed(3), decoy: null };
      if (decoyRounds[i]) {
        var type = rng() < 0.5 ? 'wait' : 'chute';
        var lo = 0.45, hi = delay - Q_DECOY_MS / 1000 - 0.5;
        var at = lo + rng() * Math.max(0, hi - lo);
        r.decoy = { type: type, at: +at.toFixed(3), dur: Q_DECOY_MS / 1000 };
      }
      rounds.push(r);
    }
    return rounds;
  }

  var SVG_SPIN = '<svg viewBox="0 0 48 48" width="S" height="S" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="4"/>' +
    '<path d="M24 24 L24 7 A17 17 0 0 1 40 19 Z" fill="currentColor" opacity=".9"/><path d="M24 24 L8 29 A17 17 0 0 1 12 12 Z" fill="currentColor" opacity=".55"/>' +
    '<circle cx="24" cy="24" r="4" fill="currentColor"/></svg>';
  var SVG_HAND = '<svg viewBox="0 0 48 48" width="S" height="S" aria-hidden="true"><rect x="6" y="6" width="36" height="36" rx="18" fill="none" stroke="currentColor" stroke-width="4"/>' +
    '<rect x="17" y="15" width="5" height="18" rx="2.5" fill="currentColor"/><rect x="26" y="15" width="5" height="18" rx="2.5" fill="currentColor"/></svg>';
  var SVG_CHUTE = '<svg viewBox="0 0 48 48" width="S" height="S" aria-hidden="true"><path d="M8 8 C 30 10, 14 30, 40 40" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>' +
    '<path d="M8 8 C 30 10, 14 30, 40 40" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2" stroke-dasharray="3 4"/></svg>';
  var SVG_WATCH = '<svg viewBox="0 0 48 48" width="S" height="S" aria-hidden="true"><circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="6 5"/></svg>';

  function playQuickdraw(stage, ctx) {
    return new Promise(function (resolve) {
      injectStyle();
      var rounds = qdChallenge(ctx.rng);

      var W = Math.max(300, Math.round(stage.clientWidth || 520));
      var H = Math.round(Math.min(380, W * 0.62));
      var bigPx = Math.round(clamp(W * 0.17, 54, 92));
      var midPx = Math.round(clamp(W * 0.085, 26, 46));
      var subPx = Math.round(clamp(W * 0.036, 13, 18));
      var iconPx = Math.round(clamp(W * 0.13, 40, 72));

      var root = document.createElement('div');
      root.className = 'mg-quickdraw-root';
      root.style.height = H + 'px';
      root.tabIndex = 0;
      root.setAttribute('role', 'button');
      root.setAttribute('aria-label', 'Quick Draw: tap or press Space when SPIN appears');
      root.setAttribute('data-mg-challenge', JSON.stringify(rounds));
      root.innerHTML =
        '<div class="mg-quickdraw-hud"><span class="mg-quickdraw-tag mg-quickdraw-round"></span>' +
        '<div class="mg-quickdraw-pips"></div><span class="mg-quickdraw-tag mg-quickdraw-score"></span></div>' +
        '<div class="mg-quickdraw-cue" data-s="wait" aria-live="assertive"><div class="mg-quickdraw-icon"></div>' +
        '<div class="mg-quickdraw-big"></div><div class="mg-quickdraw-sub"></div></div>';
      stage.innerHTML = '';
      stage.appendChild(root);
      var elRound = root.querySelector('.mg-quickdraw-round');
      var elScore = root.querySelector('.mg-quickdraw-score');
      var elPips = root.querySelector('.mg-quickdraw-pips');
      var cue = root.querySelector('.mg-quickdraw-cue');
      var elIcon = cue.querySelector('.mg-quickdraw-icon');
      var elBig = cue.querySelector('.mg-quickdraw-big');
      var elSub = cue.querySelector('.mg-quickdraw-sub');
      elSub.style.fontSize = subPx + 'px';
      var pips = [];
      for (var i = 0; i < Q_ROUNDS; i++) { var d = document.createElement('div'); d.className = 'mg-quickdraw-pip'; elPips.appendChild(d); pips.push(d); }

      var total = 0, idx = 0, results = [];
      var phase = 'wait';          // wait | go | res | end | done
      var roundStart = 0, goT = 0, phaseStart = 0, phaseDur = 0, shown = '';
      var gameStart = performance.now();
      var raf = 0, done = false;

      function icon(svg) { return svg.replace(/width="S" height="S"/, 'width="' + iconPx + '" height="' + iconPx + '"'); }
      function setCue(state, iconSvg, big, bigSize, sub) {
        if (shown === state + '|' + big + '|' + sub) return;
        shown = state + '|' + big + '|' + sub;
        cue.setAttribute('data-s', state);
        elIcon.innerHTML = iconSvg ? icon(iconSvg) : '';
        elBig.textContent = big;
        elBig.style.fontSize = bigSize + 'px';
        elSub.textContent = sub || '';
        if (!ctx.reduced && (state === 'go' || state.indexOf('decoy') === 0)) {
          cue.classList.remove('mg-quickdraw-pop'); void cue.offsetWidth; cue.classList.add('mg-quickdraw-pop');
        }
      }
      function hud() {
        elRound.textContent = 'Round ' + Math.min(idx + 1, Q_ROUNDS) + '/' + Q_ROUNDS;
        elScore.textContent = 'Score ' + total;
        for (var k = 0; k < Q_ROUNDS; k++) {
          var r = results[k];
          pips[k].className = 'mg-quickdraw-pip' + (r ? (r.pts <= 0 ? ' bad' : r.pts >= Q_PTS * 0.85 ? ' top' : ' ok') : (k === idx && phase !== 'end' ? ' cur' : ''));
        }
      }
      function decoyActive(now) {
        var dc = rounds[idx].decoy; if (!dc) return null;
        var t = (now - roundStart) / 1000;
        return t >= dc.at && t < dc.at + dc.dur ? dc : null;
      }
      function startRound(now) {
        phase = 'wait'; roundStart = now; phaseStart = now;
        root.setAttribute('data-mg-round', JSON.stringify({ i: idx, start: now }));
        root.removeAttribute('data-mg-go');
        hud();
        setCue('wait', SVG_WATCH, 'Wait for SPIN!', midPx, "Don't tap yet");
      }
      function endRound(res, now, dur) {
        results.push(res); total += res.pts;
        root.setAttribute('data-mg-results', JSON.stringify(results));
        phase = 'res'; phaseStart = now; phaseDur = dur;
        hud();
        if (res.kind === 'hit') setCue('res', null, Math.round(res.ms) + ' ms', midPx, (res.pts > 0 ? '+' + res.pts + '  ' : '+0  ') + qdLabel(res.ms));
        else if (res.kind === 'slow') setCue('bad', null, 'Too slow!', midPx, '+0');
        else setCue('bad', null, 'Too soon!', midPx, res.kind === 'decoy' ? 'That was a decoy. +0' : 'Wait for the green SPIN! +0');
      }
      function onPress(t) {
        if (done) return;
        var now = performance.now();
        if (phase === 'wait') {
          endRound({ kind: decoyActive(t) ? 'decoy' : 'early', pts: 0 }, now, Q_BAD_MS);
        } else if (phase === 'go') {
          var ms = Math.max(0, Math.min(t, now) - goT);
          if (ms < Q_MIN_RT) endRound({ kind: 'early', ms: ms, pts: 0 }, now, Q_BAD_MS);
          else if (ms >= Q_GO_MS) endRound({ kind: 'slow', pts: 0 }, now, Q_RES_MS);
          else endRound({ kind: 'hit', ms: Math.round(ms), pts: qdPoints(ms) }, now, Q_RES_MS);
        }
        // presses during result/end screens are ignored
      }
      function onPointer(e) {
        if (e.isPrimary === false) return;
        if (e.cancelable) e.preventDefault();
        onPress(evTime(e));
      }
      function onKey(e) {
        if (!isGoKey(e)) return;
        e.preventDefault();
        if (e.repeat) return;
        onPress(evTime(e));
      }
      function onAbort() { finish(); }
      function cleanup() {
        cancelAnimationFrame(raf);
        root.removeEventListener('pointerdown', onPointer);
        window.removeEventListener('keydown', onKey, true);
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      }
      function finish() {
        if (done) return;
        done = true; phase = 'done';
        cleanup();
        resolve(Math.max(0, Math.round(total)) | 0);
      }

      function frame() {
        if (done) return;
        var now = performance.now();
        if (now - gameStart > Q_HARD_MS) { finish(); return; }
        if (phase === 'wait') {
          var r = rounds[idx];
          if (now - roundStart >= r.delay * 1000) {
            phase = 'go'; goT = now; phaseStart = now;
            setCue('go', SVG_SPIN, 'SPIN!', bigPx, 'TAP NOW!');
            root.setAttribute('data-mg-go', String(goT));
          } else {
            var dc = decoyActive(now);
            if (dc && dc.type === 'wait') setCue('decoy-wait', SVG_HAND, 'WAIT...', bigPx * 0.8 | 0, 'Not yet!');
            else if (dc) setCue('decoy-chute', SVG_CHUTE, 'CHUTE!', bigPx * 0.8 | 0, 'Not yet!');
            else setCue('wait', SVG_WATCH, 'Wait for SPIN!', midPx, "Don't tap yet");
          }
        } else if (phase === 'go') {
          if (now - goT >= Q_GO_MS) endRound({ kind: 'slow', pts: 0 }, now, Q_RES_MS);
        } else if (phase === 'res') {
          if (now - phaseStart >= phaseDur) {
            idx++;
            if (idx >= Q_ROUNDS) {
              idx = Q_ROUNDS - 1; phase = 'end'; phaseStart = now; hud();
              setCue('end', null, 'Score: ' + total, midPx, results.filter(function (x) { return x.kind === 'hit'; }).length + ' of ' + Q_ROUNDS + ' clean draws');
              root.setAttribute('data-mg-final', String(total));
            } else startRound(now);
          }
        } else if (phase === 'end') {
          if (now - phaseStart >= Q_END_MS) { finish(); return; }
        }
        raf = requestAnimationFrame(frame);
      }

      if (ctx.signal) {
        if (ctx.signal.aborted) { done = true; resolve(0); return; }
        ctx.signal.addEventListener('abort', onAbort);
      }
      root.addEventListener('pointerdown', onPointer);
      window.addEventListener('keydown', onKey, true);
      startRound(performance.now());
      raf = requestAnimationFrame(frame);
    });
  }

  MINIGAMES.push({
    id: 'quickdraw',
    title: 'Quick Draw',
    icon: '⚡',
    howto: 'Tap or press Space the instant the big green SPIN! appears. Ignore yellow WAIT and red CHUTE decoys: tapping early scores 0 for that round. 4 rounds.',
    max: 1000,
    cpu: { mean: 590, sd: 150 },
    play: playQuickdraw
  });
})();
