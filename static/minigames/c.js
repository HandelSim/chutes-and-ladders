/* Chutes & Ladders minigames (mg-c):
 *   'gamble' - Ladder Gamble: push-your-luck climbing on 3 seeded ladders with hidden snap rungs.
 *   'dodge'  - Chute Dodge: 3-lane endless chute, dodge seeded crates, grab coins.
 * Plain JS, no modules. Relies on the page preamble (MINIGAMES, mulberry32). No globals added.
 */
(function () {
  'use strict';
  if (typeof MINIGAMES === 'undefined') return;

  /* ---------------- shared helpers ---------------- */
  var FONT = 'Fredoka, system-ui, sans-serif';
  function font(px, w) { return (w || 600) + ' ' + Math.round(px) + 'px ' + FONT; }
  function cssv(n, fb) {
    try { var v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || fb; }
    catch (e) { return fb; }
  }
  function readPal() {
    return {
      bg: cssv('--bg', '#f5efe3'), panel: cssv('--panel', '#fffdf8'), ink: cssv('--ink', '#2b2622'),
      muted: cssv('--muted', '#6f655b'), line: cssv('--line', '#e4d9c6'), accent: cssv('--accent', '#2f7d6d'),
      accentInk: cssv('--accent-ink', '#ffffff'), accentSoft: cssv('--accent-soft', '#dcefe9'),
      c: [cssv('--c1', '#fbe6ae'), cssv('--c2', '#d4ebcf'), cssv('--c3', '#cde1f2'), cssv('--c4', '#f5d0cb'), cssv('--c5', '#e3d8f2')],
      finish: cssv('--finish', '#ffd25e'), rail: cssv('--rail', '#9b6430'), rung: cssv('--rung', '#c4884c'),
      grid: cssv('--grid', '#bfae92'), stroke: cssv('--token-stroke', '#ffffff')
    };
  }
  var RED = '#e4572e', GOLD = '#ffc83d', GOLD_D = '#a87400', GREEN = '#3aa66b', YELLOW = '#f2b632';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeIO(t) { t = clamp(t, 0, 1); return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function mixHex(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var r = Math.round(lerp(pa >> 16, pb >> 16, t)), gg = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t)), bb = Math.round(lerp(pa & 255, pb & 255, t));
    return 'rgb(' + r + ',' + gg + ',' + bb + ')';
  }
  function riskColor(p) { return p <= 0.15 ? mixHex(GREEN, YELLOW, p / 0.15) : mixHex(YELLOW, RED, clamp((p - 0.15) / 0.35, 0, 1)); }
  function avatarOf(ctx) {
    try {
      var p = (ctx && ctx.player) || {}, list = (ctx && ctx.chars) || [], id = p.char && typeof p.char === 'object' ? p.char.id : p.char, c = null;
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) { c = list[i]; break; }
      if (!c && p.char && p.char.img) c = p.char;
      if (c && c.img) { var im = new Image(); im.src = c.img; return im; }
    } catch (e) { /* no avatar */ }
    return null;
  }
  function drawToken(g, x, y, r, color, img, pal, initial, rot) {
    g.save();
    g.fillStyle = 'rgba(0,0,0,.2)'; g.beginPath(); g.ellipse(x, y + r * 0.95, r * 0.8, r * 0.25, 0, 0, Math.PI * 2); g.fill();
    g.translate(x, y); if (rot) g.rotate(rot);
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    if (img && img.complete && img.naturalWidth) {
      g.save(); g.beginPath(); g.arc(0, 0, r * 0.78, 0, Math.PI * 2); g.fillStyle = pal.panel; g.fill(); g.clip();
      g.drawImage(img, -r * 0.78, -r * 0.78, r * 1.56, r * 1.56); g.restore();
    } else {
      g.fillStyle = '#fff'; g.font = font(r * 1.05, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(initial, 0, r * 0.06);
    }
    g.lineWidth = Math.max(2, r * 0.13); g.strokeStyle = pal.stroke; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.arc(0, 0, r + Math.max(1, r * 0.065), 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  function setupCanvas(cv, stage, aspect, maxH) {
    var W = Math.round(clamp(stage.clientWidth || 520, 280, 600));
    var H = Math.round(Math.min(maxH, W * aspect));
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = '100%'; cv.style.height = H + 'px';
    var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { W: W, H: H, g: g };
  }
  // lifecycle: listeners, rAF, watchdog, one-shot finish
  function makeLife(resolve, max) {
    var offs = [], raf = 0, wd = 0, done = false;
    return {
      on: function (t, ty, fn, o) { t.addEventListener(ty, fn, o); offs.push(function () { t.removeEventListener(ty, fn, o); }); },
      frame: function (fn) { raf = requestAnimationFrame(fn); },
      watchdog: function (ms, fn) { wd = setTimeout(fn, ms); },
      isDone: function () { return done; },
      finish: function (score) {
        if (done) return; done = true;
        cancelAnimationFrame(raf); clearTimeout(wd);
        for (var i = 0; i < offs.length; i++) { try { offs[i](); } catch (e) { /* ignore */ } }
        var s = Math.round(+score || 0); resolve(s < 0 ? 0 : s > max ? max : s);
      }
    };
  }
  function pill(g, x, y, h, text, bg, fg, align, px) {
    g.font = font(px || h * 0.6, 600);
    var w = g.measureText(text).width + h * 0.9, x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    rr(g, x0, y, w, h, h / 2); g.fillStyle = bg; g.fill();
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, x0 + w / 2, y + h / 2 + 1);
    return w;
  }
  function endCard(g, W, H, pal, k, line1, big) {
    var a = easeOut(k / 0.25);
    g.save(); g.globalAlpha = a; g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, 0, W, H);
    var cw = Math.min(W - 40, 300), ch = Math.min(H - 30, 118), cx = (W - cw) / 2, cy = (H - ch) / 2 + (1 - a) * 12;
    rr(g, cx, cy, cw, ch, 16); g.fillStyle = pal.panel; g.fill(); g.lineWidth = 2; g.strokeStyle = pal.line; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = pal.muted; g.font = '600 ' + Math.round(clamp(W * 0.032, 11, 14)) + 'px system-ui, sans-serif';
    g.fillText(line1, W / 2, cy + ch * 0.27, cw - 16);
    g.fillStyle = pal.ink; g.font = font(clamp(W * 0.075, 26, 38), 700); g.fillText(big, W / 2, cy + ch * 0.65);
    g.restore();
  }

  /* =========================================================
   * Game 1: Ladder Gamble (push your luck)
   * ========================================================= */
  // Height hazard: P(rung n snaps | you reached n-1 safely). Rungs 1-2 never snap, rung 12 always does.
  var G_HZ = [0, 0, 0, 0.04, 0.07, 0.11, 0.15, 0.20, 0.27, 0.35, 0.45, 0.60, 1];
  var G_TOP = 12, G_PC = 0.85, G_PD = 0.08, G_N = 3;
  var G_DUR = 3.7, G_LOCK = 0.14, G_SNAP_T = 0.95, G_BANK_T = 0.6, G_END_T = 0.8, G_HARD = 15.0;
  function tri(r) { return r * (r + 1) / 2; }
  function genGamble(rng) {
    var out = [];
    for (var k = 0; k < G_N; k++) {
      var B = G_TOP;
      for (var b = 3; b < G_TOP; b++) { if (rng() < G_HZ[b]) { B = b; break; } }
      var cracks = [false];
      for (var n = 1; n <= G_TOP; n++) {
        var u = rng();
        // honest tell: the snap rung is cracked 85% of the time; other rungs (3+) show a decoy crack 8% of the time
        cracks.push(n === B ? u < G_PC : (n >= 3 && u < G_PD));
      }
      out.push({ B: B, cracks: cracks });
    }
    return out;
  }
  var gambleStyled = false;
  function gambleStyle() {
    if (gambleStyled || document.getElementById('mg-gamble-style')) { gambleStyled = true; return; }
    var s = document.createElement('style'); s.id = 'mg-gamble-style';
    s.textContent =
      '.mg-gamble-wrap{display:flex;flex-direction:column;gap:8px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '.mg-gamble-cv{display:block;width:100%;border-radius:14px;border:1px solid var(--line);background:var(--bg);touch-action:none;cursor:pointer}' +
      '.mg-gamble-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '.mg-gamble-btn{font:600 18px Fredoka,system-ui,sans-serif;min-height:50px;border-radius:12px;border:2px solid var(--line);' +
      'background:var(--panel);color:var(--ink);cursor:pointer;touch-action:none;display:flex;align-items:center;justify-content:center;' +
      'gap:8px;box-shadow:0 3px 0 var(--line);padding:0 8px;transition:transform .06s,box-shadow .06s}' +
      '.mg-gamble-btn.mg-gamble-down{transform:translateY(2px);box-shadow:0 1px 0 var(--line)}' +
      '.mg-gamble-climb{background:var(--accent-soft);border-color:var(--accent)}' +
      '.mg-gamble-bank{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}' +
      '.mg-gamble-btn kbd{font:600 11px system-ui,sans-serif;opacity:.75;border:1px solid currentColor;border-radius:5px;padding:1px 5px}' +
      '.mg-gamble-btn[aria-disabled=true]{opacity:.5}' +
      '@media (max-width:400px){.mg-gamble-btn kbd{display:none}.mg-gamble-btn{font-size:17px;min-height:48px}}';
    document.head.appendChild(s); gambleStyled = true;
  }

  MINIGAMES.push({
    id: 'gamble',
    title: 'Ladder Gamble',
    icon: '🎲',
    howto: 'Climb (Space or tap the ladder) one rung at a time; rung k is worth k points. Bank (Enter or B) to keep them. ' +
      'One hidden rung on each ladder snaps and that ladder scores 0. The meter shows the honest risk by height, and cracked ' +
      'rungs snap far more often. 3 ladders; score = % of the best possible haul.',
    max: 100,
    cpu: { mean: 54, sd: 20 },
    gen: genGamble,
    play: function (stage, ctx) {
      ctx = ctx || {};
      var rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
      var ladders = genGamble(rng);
      var perfect = 0; for (var q = 0; q < ladders.length; q++) perfect += tri(ladders[q].B - 1);
      var reduced = !!ctx.reduced;
      var player = ctx.player || {};
      var pColor = player.color || '#e63946', initial = String(player.name || '?').charAt(0).toUpperCase();
      var img = avatarOf(ctx);
      var pal = readPal();

      gambleStyle();
      stage.innerHTML = '';
      var wrap = document.createElement('div'); wrap.className = 'mg-gamble-wrap';
      var cv = document.createElement('canvas'); cv.className = 'mg-gamble-cv';
      cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Ladder Gamble: climb or bank');
      var btns = document.createElement('div'); btns.className = 'mg-gamble-btns';
      function mkBtn(cls, label, key) {
        var b = document.createElement('button'); b.type = 'button'; b.tabIndex = -1; b.className = 'mg-gamble-btn ' + cls;
        b.innerHTML = '<span>' + label + '</span><kbd>' + key + '</kbd>'; return b;
      }
      var bClimb = mkBtn('mg-gamble-climb', '&#9650; Climb', 'Space'), bBank = mkBtn('mg-gamble-bank', 'Bank &#10003;', 'Enter');
      btns.appendChild(bClimb); btns.appendChild(bBank);
      wrap.appendChild(cv); wrap.appendChild(btns); stage.appendChild(wrap);

      var S = setupCanvas(cv, stage, 0.66, 310), W = S.W, H = S.H, g = S.g;

      // state (all times in game seconds since start)
      var t0 = performance.now();
      var li = 0, r = 0, phase = 'climb', ladderStart = 0, lockUntil = 0, banked = 0;
      var results = [], anim = null, endAt = 0, msg = null, climbFrom = 0, climbT = -1, cam = 0, lastG = 0, pressFx = [];
      function gnow() { return (performance.now() - t0) / 1000; }
      function score() { return perfect > 0 ? Math.round(100 * banked / perfect) : 0; }

      return new Promise(function (resolve) {
        var L = makeLife(resolve, 100);
        function climb() {
          var gt = gnow(); step(gt);
          if (phase !== 'climb' || gt < lockUntil) return;
          climbFrom = r; r += 1; climbT = gt; lockUntil = gt + G_LOCK;
          if (r === ladders[li].B) {
            phase = 'anim'; results.push({ pts: 0, snap: true });
            anim = { type: 'snap', t0: gt, dur: G_SNAP_T, rung: r };
          }
        }
        function bank(timeout, at) {
          if (phase !== 'climb') return;
          var gt = at != null ? at : gnow();
          if (r === 0 && !timeout) { msg = { text: 'Climb first!', until: gt + 0.9 }; return; }
          var pts = tri(r); banked += pts;
          results.push({ pts: pts, snap: false, timeout: !!timeout });
          phase = 'anim'; anim = { type: 'bank', t0: gt, dur: G_BANK_T, pts: pts, timeout: !!timeout };
        }
        function step(gt) {
          if (L.isDone()) return;
          if (phase === 'climb' && gt - ladderStart >= G_DUR) bank(true, ladderStart + G_DUR);
          if (phase === 'anim' && gt >= anim.t0 + anim.dur) {
            li += 1;
            if (li >= G_N) { phase = 'end'; endAt = anim.t0 + anim.dur; }
            else { phase = 'climb'; r = 0; climbFrom = 0; climbT = -1; ladderStart = anim.t0 + anim.dur; lockUntil = ladderStart + 0.1; anim = null; }
          }
          if (phase === 'end' && gt >= endAt + G_END_T) L.finish(score());
          if (gt >= G_HARD) L.finish(score());
        }
        function press(b) { b.classList.add('mg-gamble-down'); pressFx.push({ b: b, until: gnow() + 0.09 }); }

        L.on(window, 'keydown', function (e) {
          var k = e.key, c = e.code;
          var isClimb = c === 'Space' || k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W';
          var isBank = k === 'Enter' || k === 'b' || k === 'B' || k === 'ArrowDown';
          if (!isClimb && !isBank) return;
          e.preventDefault();
          if (e.repeat) return; // holding a key never auto-climbs
          if (isClimb) { press(bClimb); climb(); } else { press(bBank); bank(false); }
        });
        L.on(cv, 'pointerdown', function (e) {
          e.preventDefault();
          var rect = cv.getBoundingClientRect(), x = (e.clientX - rect.left) * (W / (rect.width || W));
          if (x < W * 0.62) { press(bClimb); climb(); }
        });
        L.on(bClimb, 'pointerdown', function (e) { e.preventDefault(); press(bClimb); climb(); });
        L.on(bBank, 'pointerdown', function (e) { e.preventDefault(); press(bBank); bank(false); });
        L.on(cv, 'contextmenu', function (e) { e.preventDefault(); });
        if (ctx.signal) {
          if (ctx.signal.aborted) { L.finish(score()); return; }
          L.on(ctx.signal, 'abort', function () { L.finish(score()); });
        }
        L.watchdog((G_HARD + 0.4) * 1000, function () { L.finish(score()); });

        /* ---------- drawing ---------- */
        var HUD = 40, groundY = H - 14, sp = (H - HUD - 14 - 12) / 8;
        var cx = W * 0.37, lw = Math.min(34, W * 0.075), pr = Math.min(sp * 0.56, lw * 0.95);
        var panelX = W * 0.63;
        // static chute (cubic bezier) to the left of the ladder
        var C0 = { x: W * 0.235, y: HUD + 14 }, C1 = { x: W * 0.0, y: H * 0.42 }, C2 = { x: W * 0.30, y: H * 0.66 }, C3 = { x: W * 0.075, y: H - 16 };
        function bez(u) {
          var a = 1 - u;
          return { x: a * a * a * C0.x + 3 * a * a * u * C1.x + 3 * a * u * u * C2.x + u * u * u * C3.x,
                   y: a * a * a * C0.y + 3 * a * a * u * C1.y + 3 * a * u * u * C2.y + u * u * u * C3.y };
        }
        function rungY(n) { return groundY - (n - cam) * sp; }

        function drawBoard() {
          g.fillStyle = pal.bg; g.fillRect(0, 0, W, H);
          var ts = Math.max(28, sp * 1.7), off = (cam * sp * 0.5) % ts;
          g.globalAlpha = 0.55;
          for (var yy = -1; yy * ts < H + ts; yy++) {
            for (var xx = 0; xx * ts < W; xx++) {
              var row = yy - Math.floor(cam * sp * 0.5 / ts);
              g.fillStyle = pal.c[((xx + row * 2) % 5 + 5) % 5];
              g.fillRect(xx * ts, yy * ts + off, ts - 1, ts - 1);
            }
          }
          g.globalAlpha = 1;
        }
        function drawChute() {
          g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
          var w = Math.max(16, W * 0.06);
          g.beginPath(); g.moveTo(C0.x, C0.y); g.bezierCurveTo(C1.x, C1.y, C2.x, C2.y, C3.x, C3.y);
          g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = w + 6; g.stroke();
          g.strokeStyle = RED; g.globalAlpha = 0.92; g.lineWidth = w; g.stroke(); g.globalAlpha = 1;
          g.setLineDash([2, 14]); g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = w * 0.32; g.stroke(); g.setLineDash([]);
          g.beginPath(); g.arc(C0.x, C0.y, w * 0.62, 0, Math.PI * 2); g.fillStyle = RED; g.fill();
          g.lineWidth = 2; g.strokeStyle = 'rgba(0,0,0,.3)'; g.stroke();
          g.beginPath(); g.arc(C0.x, C0.y, w * 0.26, 0, Math.PI * 2); g.fillStyle = 'rgba(0,0,0,.35)'; g.fill();
          g.restore();
        }
        function drawCrack(x0, x1, y, seed) {
          g.save(); g.strokeStyle = 'rgba(30,15,5,.9)'; g.lineWidth = 2.2; g.lineCap = 'round'; g.beginPath();
          var mid = lerp(x0, x1, 0.35 + 0.3 * ((seed * 0.618) % 1)), h = Math.max(3, sp * 0.13);
          g.moveTo(mid - h * 1.2, y - h); g.lineTo(mid, y - h * 0.1); g.lineTo(mid - h * 0.6, y + h * 0.4); g.lineTo(mid + h * 0.3, y + h * 1.05);
          g.moveTo(mid, y - h * 0.1); g.lineTo(mid + h * 1.3, y - h * 0.6);
          g.stroke(); g.restore();
        }
        function drawLadder(gt) {
          var L0 = ladders[li] || ladders[G_N - 1], xl = cx - lw, xr = cx + lw;
          var topY = rungY(G_TOP + 0.55), botY = rungY(0) + 6;
          g.save(); g.beginPath(); g.rect(0, HUD, panelX - 4, H - HUD); g.clip();
          // ground pad
          rr(g, cx - lw * 2.2, rungY(0) - 2, lw * 4.4, 14, 6); g.fillStyle = pal.grid; g.globalAlpha = 0.6; g.fill(); g.globalAlpha = 1;
          var rw = Math.max(4, Math.min(8, sp * 0.24));
          var snapK = anim && anim.type === 'snap' ? clamp((gt - anim.t0 - G_LOCK) / 0.5, 0, 1) : -1;
          g.lineCap = 'round';
          for (var n = 1; n <= G_TOP; n++) {
            var y = rungY(n); if (y < HUD - 10 || y > H + 10) continue;
            var revealed = n <= r + 1 && phase !== 'end';
            if (snapK >= 0 && n === anim.rung) {
              // broken rung: two halves swing down
              var a = snapK * 1.1, dy = snapK * snapK * sp * 2.2;
              g.strokeStyle = pal.rung; g.lineWidth = rw;
              g.save(); g.translate(xl, y); g.rotate(a); g.beginPath(); g.moveTo(0, 0); g.lineTo(lw * 0.9, dy * 0.2); g.stroke(); g.restore();
              g.save(); g.translate(xr, y); g.rotate(-a); g.beginPath(); g.moveTo(0, 0); g.lineTo(-lw * 0.9, dy * 0.2); g.stroke(); g.restore();
              continue;
            }
            g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = rw + 2; g.beginPath(); g.moveTo(xl, y + 1); g.lineTo(xr, y + 1); g.stroke();
            var crk = revealed && L0.cracks[n];
            g.strokeStyle = crk ? '#c0532c' : pal.rung; g.lineWidth = rw; g.beginPath(); g.moveTo(xl, y); g.lineTo(xr, y); g.stroke();
            if (crk) drawCrack(xl, xr, y, n + li * 3);
            // value label
            var isNext = n === r + 1 && phase === 'climb';
            g.font = font(clamp(sp * 0.5, 9, 13), isNext ? 700 : 600); g.textAlign = 'left'; g.textBaseline = 'middle';
            g.fillStyle = isNext ? pal.ink : pal.muted; g.globalAlpha = n <= r ? 0.45 : 1;
            g.fillText('+' + n, xr + 8, y); g.globalAlpha = 1;
          }
          for (var s = -1; s <= 1; s += 2) {
            var x = cx + s * lw;
            g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = rw + 4; g.beginPath(); g.moveTo(x, botY); g.lineTo(x, topY); g.stroke();
            g.strokeStyle = pal.rail; g.lineWidth = rw + 1; g.beginPath(); g.moveTo(x, botY); g.lineTo(x, topY); g.stroke();
          }
          g.restore();
        }
        function piecePos(gt) {
          var pos = r;
          if (climbT >= 0 && gt - climbT < G_LOCK) pos = lerp(climbFrom, r, easeOut((gt - climbT) / G_LOCK));
          return { x: cx, y: rungY(pos) - pr * 0.15, rot: 0 };
        }
        function drawPiece(gt) {
          if (phase === 'end' && li >= G_N) { /* keep last pose */ }
          var p = piecePos(gt), sc = 1;
          if (anim && anim.type === 'snap') {
            var k = (gt - anim.t0 - G_LOCK) / (anim.dur - G_LOCK - 0.08);
            if (k > 0) {
              k = clamp(k, 0, 1);
              var sy = rungY(anim.rung) - pr * 0.15, u0 = 0;
              for (var u = 0; u <= 1; u += 0.02) { if (bez(u).y >= sy) { u0 = u; break; } u0 = u; }
              var entry = bez(u0);
              if (k < 0.25) { var f = easeIO(k / 0.25); p = { x: lerp(cx, entry.x, f), y: lerp(sy, entry.y, f) - Math.sin(f * Math.PI) * sp * 0.6, rot: f * 2 }; }
              else { var b = bez(lerp(u0, 1, easeIO((k - 0.25) / 0.75))); p = { x: b.x, y: b.y - pr * 0.3, rot: 2 + k * 9 }; }
            }
          } else if (anim && anim.type === 'bank') {
            var kb = (gt - anim.t0) / anim.dur; sc = 1 + 0.18 * Math.sin(clamp(kb, 0, 1) * Math.PI);
          }
          drawToken(g, p.x, p.y, pr * sc, pColor, img, pal, initial, reduced ? 0 : p.rot);
        }
        function drawPanel(gt) {
          var x0 = panelX, pw = W - x0 - 8, top = HUD + 4, bot = H - 8;
          rr(g, x0, top, pw, bot - top, 12); g.fillStyle = pal.panel; g.globalAlpha = 0.94; g.fill(); g.globalAlpha = 1;
          g.lineWidth = 1; g.strokeStyle = pal.line; g.stroke();
          var barX = x0 + 9, barW = Math.max(11, W * 0.03), bTop = top + 24, bBot = bot - 10, seg = (bBot - bTop) / G_TOP;
          g.fillStyle = pal.muted; g.font = '700 ' + Math.round(clamp(W * 0.026, 9, 11)) + 'px system-ui, sans-serif';
          g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('SNAP RISK', barX, top + 12);
          var next = r + 1, live = phase === 'climb';
          for (var n = 1; n <= G_TOP; n++) {
            var y1 = bBot - n * seg;
            rr(g, barX, y1 + 1, barW, seg - 2, 3);
            g.fillStyle = G_HZ[n] === 0 ? pal.accentSoft : riskColor(G_HZ[n]);
            g.globalAlpha = n <= r ? 0.25 : 1; g.fill(); g.globalAlpha = 1;
            if (n === next && live) {
              g.lineWidth = 2; g.strokeStyle = pal.ink; rr(g, barX - 2, y1 - 1, barW + 4, seg + 2, 4); g.stroke();
              g.fillStyle = pal.ink; g.beginPath(); var ay = y1 + seg / 2;
              g.moveTo(barX + barW + 4, ay); g.lineTo(barX + barW + 10, ay - 5); g.lineTo(barX + barW + 10, ay + 5); g.closePath(); g.fill();
            }
          }
          var tx = barX + barW + 16, tw = x0 + pw - tx - 6, s = (bot - top) / 180;
          var hz = G_HZ[Math.min(next, G_TOP)], cracked = live && ladders[li] && ladders[li].cracks[next];
          g.textAlign = 'left';
          g.fillStyle = pal.muted; g.font = '600 ' + Math.round(clamp(11 * s, 10, 13)) + 'px system-ui, sans-serif';
          var snapped = anim && anim.type === 'snap' && phase !== 'climb';
          g.fillText(live ? 'rung ' + next + ' by height' : snapped ? 'ladder' : 'ladder ' + Math.min(li + 1, G_N), tx, top + 34 * s, tw);
          g.fillStyle = live ? riskColor(hz) : snapped ? RED : pal.accent; g.font = font(clamp(26 * s, 20, 34), 700);
          g.fillText(live ? Math.round(hz * 100) + '%' : snapped ? 'SNAP' : 'SAFE', tx, top + 60 * s, tw);
          if (cracked) {
            var bw = Math.min(tw, 78 * Math.max(1, s * 0.9)), bh = clamp(17 * s, 16, 22);
            var wob = reduced ? 0 : Math.sin(gt * 30) * 1.2;
            rr(g, tx + wob, top + 76 * s, bw, bh, bh / 2); g.fillStyle = RED; g.fill();
            g.fillStyle = '#fff'; g.font = font(bh * 0.62, 700); g.textAlign = 'center'; g.fillText('CRACKED!', tx + wob + bw / 2, top + 76 * s + bh / 2 + 1, bw - 6);
            g.textAlign = 'left';
          } else if (live) {
            g.fillStyle = pal.muted; g.font = '600 ' + Math.round(clamp(11 * s, 10, 13)) + 'px system-ui, sans-serif';
            g.fillText(next <= 2 ? 'always safe' : 'looks solid', tx, top + 85 * s, tw);
          }
          g.fillStyle = pal.line; g.fillRect(tx, top + 104 * s, tw, 1);
          g.fillStyle = pal.muted; g.font = '600 ' + Math.round(clamp(11 * s, 10, 13)) + 'px system-ui, sans-serif';
          var shown = snapped ? 0 : tri(r);
          g.fillText(snapped ? 'scores' : live ? 'on rung ' + r + ' =' : 'banked', tx, top + 120 * s, tw);
          g.fillStyle = snapped ? RED : pal.accent; g.font = font(clamp(22 * s, 17, 28), 700);
          g.fillText(shown + (shown === 1 ? ' pt' : ' pts'), tx, top + 142 * s, tw);
          if (live && next <= G_TOP) {
            g.fillStyle = pal.muted; g.font = '600 ' + Math.round(clamp(11 * s, 10, 13)) + 'px system-ui, sans-serif';
            g.fillText('next: ' + tri(next) + ' pts', tx, top + 162 * s, tw);
          }
        }
        function drawHud(gt) {
          rr(g, 6, 5, W - 12, HUD - 9, 12); g.fillStyle = pal.panel; g.globalAlpha = 0.95; g.fill(); g.globalAlpha = 1;
          g.lineWidth = 1; g.strokeStyle = pal.line; g.stroke();
          var cy = 5 + (HUD - 9) / 2, rad = 10.5;
          for (var i = 0; i < G_N; i++) {
            var x = 22 + i * 27, res = results[i];
            g.beginPath(); g.arc(x, cy, rad, 0, Math.PI * 2);
            if (res && res.snap) { g.fillStyle = RED; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2.2; g.beginPath();
              g.moveTo(x - 4, cy - 4); g.lineTo(x + 4, cy + 4); g.moveTo(x + 4, cy - 4); g.lineTo(x - 4, cy + 4); g.stroke(); }
            else if (res) { g.fillStyle = pal.accent; g.fill(); g.fillStyle = pal.accentInk; g.font = font(res.pts >= 10 ? 10 : 12, 700);
              g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(res.pts), x, cy + 1); }
            else { g.fillStyle = pal.bg; g.fill(); g.lineWidth = i === li ? 2.5 : 1.5; g.strokeStyle = i === li ? pal.accent : pal.line; g.stroke();
              g.fillStyle = i === li ? pal.ink : pal.muted; g.font = font(12, 700); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), x, cy + 1); }
          }
          // banked total
          g.textAlign = 'right'; g.textBaseline = 'middle';
          g.fillStyle = pal.ink; g.font = font(18, 700); g.fillText(String(banked), W - 16, cy + 1);
          var nw = g.measureText(String(banked)).width;
          g.fillStyle = pal.muted; g.font = '700 10px system-ui, sans-serif'; g.fillText('BANKED', W - 20 - nw, cy + 1);
          // ladder timer
          var bx = 22 + 2 * 27 + 18, bw = W - 16 - nw - 56 - bx, by = cy - 4;
          if (bw > 20) {
            var left = phase === 'climb' ? clamp(1 - (gt - ladderStart) / G_DUR, 0, 1) : (phase === 'anim' ? 0 : 0);
            rr(g, bx, by, bw, 8, 4); g.fillStyle = pal.line; g.fill();
            if (left > 0) { rr(g, bx, by, Math.max(8, bw * left), 8, 4); g.fillStyle = left < 0.27 ? RED : pal.accent; g.fill(); }
          }
        }
        function drawFx(gt) {
          if (anim && anim.type === 'bank') {
            var k = (gt - anim.t0) / anim.dur, p = piecePos(gt);
            g.save(); g.globalAlpha = 1 - clamp((k - 0.6) / 0.4, 0, 1);
            g.textAlign = 'center'; g.textBaseline = 'middle';
            if (anim.timeout) pill(g, cx, HUD + 8, 22, "Time! Banked", pal.ink, pal.panel, 'center', 12);
            g.fillStyle = pal.accent; g.font = font(clamp(W * 0.06, 20, 30), 700);
            g.fillText('+' + anim.pts, cx, p.y - pr - 10 - easeOut(k) * 22);
            g.restore();
          } else if (anim && anim.type === 'snap') {
            var ks = (gt - anim.t0 - G_LOCK) / 0.6;
            if (ks > 0) {
              g.save(); g.globalAlpha = 1 - clamp((ks - 0.8) / 0.5, 0, 1);
              var sc = reduced ? 1 : 1 + 0.25 * Math.max(0, 1 - ks * 3);
              g.translate(cx, clamp(rungY(anim.rung) - sp * 0.4, HUD + 24, H - 30)); g.scale(sc, sc);
              g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(clamp(W * 0.07, 22, 34), 700);
              g.lineWidth = 5; g.strokeStyle = pal.panel; g.strokeText('SNAP!', 0, 0); g.fillStyle = RED; g.fillText('SNAP!', 0, 0);
              g.restore();
            }
          }
          if (msg && gt < msg.until) pill(g, cx, HUD + 8, 24, msg.text, RED, '#fff', 'center', 13);
          if (li === 0 && phase === 'climb' && r === 0 && gt < 2.2 && !(msg && gt < msg.until))
            pill(g, cx, HUD + 8, 24, W < 420 ? 'Tap ladder to climb' : 'Space / tap ladder = climb', pal.ink, pal.panel, 'center', 12);
        }
        function draw(gt) {
          var tgt = clamp(r - 3, 0, G_TOP - 7), dt = Math.max(0, gt - lastG); lastG = gt;
          if (phase === 'climb' && r === 0) cam = tgt; // new ladder starts at the bottom
          cam = tgt + (cam - tgt) * Math.exp(-dt * 12);
          drawBoard(); drawChute(); drawLadder(gt); drawPiece(gt); drawPanel(gt); drawHud(gt); drawFx(gt);
          if (phase === 'end') endCard(g, W, H, pal, gt - endAt, 'Banked ' + banked + ' of ' + perfect + ' possible', 'Score: ' + score());
        }
        function loop() {
          if (L.isDone()) return;
          var gt = gnow();
          for (var i = pressFx.length - 1; i >= 0; i--) if (gt >= pressFx[i].until) { pressFx[i].b.classList.remove('mg-gamble-down'); pressFx.splice(i, 1); }
          bClimb.setAttribute('aria-disabled', phase === 'climb' ? 'false' : 'true');
          bBank.setAttribute('aria-disabled', phase === 'climb' && r > 0 ? 'false' : 'true');
          step(gt);
          if (L.isDone()) return;
          draw(gt);
          L.frame(loop);
        }
        draw(0);
        L.frame(loop);
      });
    }
  });

  /* =========================================================
   * Game 2: Chute Dodge (3-lane steering)
   * ========================================================= */
  var D_DUR = 12, D_V0 = 0.5, D_V1 = 1.0, D_STUN = 0.6, D_HIT = 15, D_COIN = 10, D_BONUS = 40, D_BSTEP = 10, D_END_T = 0.8, D_NOCOIN = 3;
  function dTimes() { var ts = [], t = 1.2; while (t <= 11.55) { ts.push(Math.round(t * 1e4) / 1e4); t += 0.8 - 0.3 * (t / D_DUR); } return ts; }
  var D_TIMES = dTimes(), D_NC = D_TIMES.length - D_NOCOIN, D_MAX = D_NC * D_COIN + D_BONUS;
  // distance travelled (in stage heights) after t seconds: speed ramps linearly V0 -> V1
  function dDist(t) { return D_V0 * t + (D_V1 - D_V0) * t * t / (2 * D_DUR); }
  function genDodge(rng) {
    var rows = [], p = 1;
    for (var i = 0; i < D_TIMES.length; i++) {
      var t = D_TIMES[i], gap = i ? t - D_TIMES[i - 1] : 9, prog = t / D_DUR, np = p, u = rng();
      if (i === 0) np = u < 0.5 ? 0 : 2; // first row is off-center: idling is never free
      else if (p === 1) np = u < 0.75 ? (rng() < 0.5 ? 0 : 2) : 1;
      else np = u < 0.45 ? 1 : (u < 0.65 && gap >= 0.62 ? 2 - p : p);
      var others = np === 0 ? [1, 2] : np === 1 ? [0, 2] : [0, 1];
      var blocks;
      if (rng() < 0.35 + 0.4 * prog) blocks = others.slice();
      else if (np !== 1) blocks = [rng() < 0.7 ? 1 : 2 - np]; // single crate favors the middle lane
      else blocks = [rng() < 0.5 ? 0 : 2];
      rows.push({ t: t, path: np, blocks: blocks, coin: true });
      p = np;
    }
    var k = 0;
    while (k < D_NOCOIN) { var j = 2 + Math.floor(rng() * (rows.length - 2)); if (rows[j].coin) { rows[j].coin = false; k++; } }
    return rows;
  }

  MINIGAMES.push({
    id: 'dodge',
    title: 'Chute Dodge',
    icon: '💨',
    howto: 'Slide down the chute for 12 s. Steer between 3 lanes with Left/Right (A/D) or tap the left/right half. ' +
      'Coins +10. Crates stun you and cost 15. Survival bonus +40, minus 10 per crash. It speeds up!',
    max: D_MAX,
    cpu: { mean: Math.round(D_MAX * 0.58), sd: Math.round(D_MAX * 0.17) },
    gen: genDodge,
    play: function (stage, ctx) {
      ctx = ctx || {};
      var rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
      var rows = genDodge(rng);
      var reduced = !!ctx.reduced;
      var player = ctx.player || {};
      var pColor = player.color || '#1d7cf2', initial = String(player.name || '?').charAt(0).toUpperCase();
      var img = avatarOf(ctx);
      var pal = readPal();

      stage.innerHTML = '';
      var cv = document.createElement('canvas');
      cv.className = 'mg-dodge-cv';
      cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Chute Dodge: steer left and right');
      cv.style.cssText = 'display:block;width:100%;border-radius:14px;border:1px solid var(--line);background:var(--bg);touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer';
      stage.appendChild(cv);
      var S = setupCanvas(cv, stage, 0.74, 370), W = S.W, H = S.H, g = S.g;
      var tx0 = W * 0.1, tx1 = W * 0.9, laneW = (tx1 - tx0) / 3, PY = H * 0.27;
      var pr = Math.min(laneW * 0.27, H * 0.072), bh = Math.max(18, H * 0.085), coinR = Math.min(laneW * 0.15, H * 0.045);
      function laneX(i) { return tx0 + laneW * (i + 0.5); }

      var t0 = performance.now();
      var lane = 1, fromX = laneX(1), moveT = -1, stunUntil = -1, score = 0, coins = 0, hits = 0, next = 0, phase = 'play', endAt = 0, bonus = 0, final = 0;
      var floats = [], flashT = -9, nudge = null;
      var deco = []; for (var i = 0; i < 14; i++) deco.push({ x: Math.random(), y: Math.random(), l: 0.04 + Math.random() * 0.06 });
      function gnow() { return (performance.now() - t0) / 1000; }

      return new Promise(function (resolve) {
        var L = makeLife(resolve, D_MAX);
        // resolve every row whose crossing time has passed, using the lane held at that moment
        function processUntil(t) {
          while (next < rows.length && rows[next].t <= t) {
            var row = rows[next++], tc = row.t;
            if (tc < stunUntil) { row.skipped = true; continue; }
            if (row.blocks.indexOf(lane) >= 0) {
              hits++; score = Math.max(0, score - D_HIT); stunUntil = tc + D_STUN; row.hit = lane; flashT = tc;
              floats.push({ x: laneX(lane), y: PY + pr * 1.9, t: tc, text: '-' + D_HIT, col: RED });
            } else if (row.coin && lane === row.path) {
              coins++; score += D_COIN; row.got = true;
              floats.push({ x: laneX(lane), y: PY + pr * 1.9, t: tc, text: '+' + D_COIN, col: GOLD_D });
            }
          }
        }
        function move(dir) {
          var gt = gnow();
          if (phase !== 'play') return;
          if (gt >= D_DUR) { tick(gt); return; }
          processUntil(gt);
          if (gt < stunUntil) { nudge = { t: gt, dir: dir }; return; }
          var nl = clamp(lane + dir, 0, 2);
          if (nl === lane) { nudge = { t: gt, dir: dir }; return; }
          fromX = curX(gt); lane = nl; moveT = gt;
        }
        function curX(gt) { return moveT < 0 ? laneX(lane) : lerp(fromX, laneX(lane), easeOut((gt - moveT) / 0.09)); }
        function tick(gt) {
          if (L.isDone()) return;
          if (phase === 'play') {
            processUntil(Math.min(gt, D_DUR));
            if (gt >= D_DUR) {
              processUntil(D_DUR);
              bonus = Math.max(0, D_BONUS - D_BSTEP * hits); final = score + bonus; phase = 'end'; endAt = D_DUR;
            }
          }
          if (phase === 'end' && gt >= endAt + D_END_T) L.finish(final);
          if (gt >= 15) L.finish(phase === 'end' ? final : score);
        }
        L.on(window, 'keydown', function (e) {
          var k = e.key, dir = 0;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') dir = -1;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') dir = 1;
          else if (k === ' ' || e.code === 'Space') { e.preventDefault(); return; }
          if (!dir) return;
          e.preventDefault();
          if (e.repeat) return;
          move(dir);
        });
        L.on(cv, 'pointerdown', function (e) {
          e.preventDefault();
          var rect = cv.getBoundingClientRect();
          move(e.clientX - rect.left < rect.width / 2 ? -1 : 1);
        });
        L.on(cv, 'contextmenu', function (e) { e.preventDefault(); });
        if (ctx.signal) {
          if (ctx.signal.aborted) { L.finish(score); return; }
          L.on(ctx.signal, 'abort', function () { L.finish(phase === 'end' ? final : score); });
        }
        L.watchdog(15400, function () { L.finish(phase === 'end' ? final : score); });

        /* ---------- drawing ---------- */
        function drawTrack(gt) {
          var d = dDist(Math.min(gt, D_DUR)) * H;
          g.fillStyle = pal.bg; g.fillRect(0, 0, W, H);
          // board tiles in the margins
          var ts = W * 0.1, off = d % ts;
          for (var yy = -1; yy * ts < H + ts; yy++) {
            var idx = Math.floor((d - off) / ts) + yy;
            g.fillStyle = pal.c[((idx % 5) + 5) % 5]; g.fillRect(0, yy * ts - off + ts, tx0 - 2, ts - 1);
            g.fillStyle = pal.c[(((idx + 2) % 5) + 5) % 5]; g.fillRect(tx1 + 2, yy * ts - off + ts, W - tx1 - 2, ts - 1);
          }
          // chute bed
          g.fillStyle = pal.panel; g.fillRect(tx0, 0, tx1 - tx0, H);
          for (var l = 0; l < 3; l++) { g.fillStyle = l === lane ? pal.accentSoft : 'transparent'; if (l === lane) { g.globalAlpha = 0.55; g.fillRect(tx0 + l * laneW, 0, laneW, H); g.globalAlpha = 1; } }
          // walls
          var ww = Math.max(7, W * 0.022);
          for (var s = 0; s < 2; s++) {
            var wx = s ? tx1 : tx0 - ww;
            g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(s ? wx : wx - 2, 0, ww + 2, H);
            g.fillStyle = RED; g.fillRect(wx, 0, ww, H);
            g.fillStyle = 'rgba(255,255,255,.55)';
            var st = 26, o = d % st;
            for (var y = -o; y < H; y += st) g.fillRect(wx + ww * 0.3, y, ww * 0.4, 6);
          }
          // lane dividers
          g.strokeStyle = pal.line; g.lineWidth = 2; g.setLineDash([10, 14]); g.lineDashOffset = d % 24;
          for (var k = 1; k < 3; k++) { var x = tx0 + k * laneW; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
          g.setLineDash([]); g.lineDashOffset = 0;
          // speed streaks
          if (!reduced) {
            var sp = D_V0 + (D_V1 - D_V0) * clamp(gt / D_DUR, 0, 1);
            g.strokeStyle = pal.muted; g.globalAlpha = 0.18 + 0.2 * (sp - D_V0) / (D_V1 - D_V0); g.lineWidth = 1.5;
            for (var j = 0; j < deco.length; j++) {
              var dc = deco[j], yy2 = ((dc.y * H * 1.3 - d * 1.4) % (H * 1.3) + H * 1.3) % (H * 1.3) - H * 0.15;
              var xx = tx0 + 6 + dc.x * (tx1 - tx0 - 12);
              g.beginPath(); g.moveTo(xx, yy2); g.lineTo(xx, yy2 + dc.l * H * sp * 1.5); g.stroke();
            }
            g.globalAlpha = 1;
          }
        }
        function drawCrate(x, y, w, h, hitK) {
          g.save(); g.translate(x, y);
          if (hitK >= 0 && !reduced) g.rotate(Math.sin(hitK * 40) * 0.12 * (1 - hitK));
          g.fillStyle = 'rgba(0,0,0,.22)'; rr(g, -w / 2 + 2, -h / 2 + 3, w, h, 5); g.fill();
          rr(g, -w / 2, -h / 2, w, h, 5); g.fillStyle = pal.rail; g.fill();
          g.lineWidth = 2; g.strokeStyle = 'rgba(0,0,0,.35)'; g.stroke();
          g.strokeStyle = pal.rung; g.lineWidth = Math.max(2, h * 0.12);
          g.beginPath(); g.moveTo(-w / 2 + 5, -h / 2 + 5); g.lineTo(w / 2 - 5, h / 2 - 5); g.moveTo(w / 2 - 5, -h / 2 + 5); g.lineTo(-w / 2 + 5, h / 2 - 5); g.stroke();
          g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1.5; rr(g, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 3); g.stroke();
          g.restore();
        }
        function drawCoin(x, y, r, gt) {
          var sq = reduced ? 1 : 0.75 + 0.25 * Math.abs(Math.cos(gt * 4 + x));
          g.save(); g.translate(x, y); g.scale(sq, 1);
          g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = GOLD; g.fill();
          g.lineWidth = Math.max(2, r * 0.18); g.strokeStyle = GOLD_D; g.stroke();
          g.beginPath(); g.arc(0, 0, r * 0.55, 0, Math.PI * 2); g.lineWidth = Math.max(1.2, r * 0.12); g.stroke();
          g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(-r * 0.35, -r * 0.35, r * 0.18, 0, Math.PI * 2); g.fill();
          g.restore();
        }
        function drawRows(gt) {
          var dNow = dDist(Math.min(gt, D_DUR));
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i], y = PY + (dDist(row.t) - dNow) * H;
            if (y > H + bh || y < -bh) continue;
            for (var b = 0; b < row.blocks.length; b++) {
              var hk = row.hit === row.blocks[b] ? clamp((gt - row.t) / 0.5, 0, 1) : -1;
              drawCrate(laneX(row.blocks[b]), y, laneW * 0.7, bh, hk);
            }
            if (row.coin && !row.got) drawCoin(laneX(row.path), y, coinR, gt);
          }
        }
        function drawPlayer(gt) {
          var x = curX(gt), stun = gt < stunUntil && phase === 'play', rot = 0, dx = 0;
          if (nudge && gt - nudge.t < 0.15 && !reduced) dx = nudge.dir * Math.sin((gt - nudge.t) / 0.15 * Math.PI) * 5;
          if (stun && !reduced) rot = Math.sin(gt * 28) * 0.35;
          // slide trail
          g.save(); g.globalAlpha = 0.25; g.fillStyle = pColor;
          rr(g, x - pr * 0.55, PY - pr * 2.6, pr * 1.1, pr * 2.2, pr * 0.55); g.fill(); g.restore();
          if (stun && Math.floor(gt * 14) % 2 === 0) g.globalAlpha = 0.55;
          drawToken(g, x + dx, PY, pr, pColor, img, pal, initial, rot);
          g.globalAlpha = 1;
          if (stun) { // dizzy stars
            for (var s = 0; s < 3; s++) {
              var a = gt * 7 + s * 2.09, sx = x + Math.cos(a) * pr * 1.1, sy = PY - pr * 1.15 + Math.sin(a) * pr * 0.3;
              g.fillStyle = GOLD; g.beginPath(); g.arc(sx, sy, Math.max(2.5, pr * 0.14), 0, Math.PI * 2); g.fill();
            }
          }
        }
        function drawHud(gt) {
          var h = 24, y = 8, tl = clamp(1 - gt / D_DUR, 0, 1);
          // time bar across the chute
          rr(g, tx0 + 4, 4, tx1 - tx0 - 8, 6, 3); g.fillStyle = pal.line; g.fill();
          if (tl > 0) { rr(g, tx0 + 4, 4, Math.max(6, (tx1 - tx0 - 8) * tl), 6, 3); g.fillStyle = tl < 0.2 ? RED : pal.accent; g.fill(); }
          pill(g, tx0 + 6, y + 8, h, 'Score ' + score, pal.ink, pal.panel, 'left', 13);
          var ct = coins + '/' + D_NC; g.font = font(13, 600);
          var cw = g.measureText(ct).width + h * 0.9 + 16, cx0 = tx1 - 6 - cw;
          rr(g, cx0, y + 8, cw, h, h / 2); g.fillStyle = pal.bg; g.fill(); g.lineWidth = 1.5; g.strokeStyle = pal.line; g.stroke();
          g.beginPath(); g.arc(cx0 + 13, y + 8 + h / 2, 6.5, 0, Math.PI * 2); g.fillStyle = GOLD; g.fill(); g.lineWidth = 1.5; g.strokeStyle = GOLD_D; g.stroke();
          g.fillStyle = pal.ink; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ct, cx0 + 16 + (cw - 16) / 2, y + 8 + h / 2 + 1);
        }
        function drawFx(gt) {
          for (var i = 0; i < floats.length; i++) {
            var f = floats[i], k = (gt - f.t) / 0.7; if (k < 0 || k > 1) continue;
            g.save(); g.globalAlpha = 1 - k; g.font = font(clamp(W * 0.05, 16, 24), 700); g.textAlign = 'center'; g.textBaseline = 'middle';
            g.lineWidth = 4; g.strokeStyle = pal.panel; g.strokeText(f.text, f.x, f.y + k * 14); g.fillStyle = f.col; g.fillText(f.text, f.x, f.y + k * 14);
            g.restore();
          }
          var fk = (gt - flashT) / 0.35;
          if (fk >= 0 && fk < 1) { g.fillStyle = 'rgba(228,87,46,' + (0.32 * (1 - fk)).toFixed(3) + ')'; g.fillRect(0, 0, W, H); }
          if (gt < 2) { // tap-zone hint
            var a = 1 - clamp((gt - 1.4) / 0.6, 0, 1), cy = H - 26, sz = 9;
            g.save(); g.globalAlpha = 0.55 * a; g.fillStyle = pal.ink;
            g.beginPath(); g.moveTo(tx0 + 14, cy); g.lineTo(tx0 + 14 + sz * 1.4, cy - sz); g.lineTo(tx0 + 14 + sz * 1.4, cy + sz); g.closePath(); g.fill();
            g.beginPath(); g.moveTo(tx1 - 14, cy); g.lineTo(tx1 - 14 - sz * 1.4, cy - sz); g.lineTo(tx1 - 14 - sz * 1.4, cy + sz); g.closePath(); g.fill();
            g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('tap a side to steer', W / 2, cy);
            g.restore();
          }
        }
        function draw(gt) {
          drawTrack(gt); drawRows(gt); drawPlayer(gt); drawHud(gt); drawFx(gt);
          if (phase === 'end') endCard(g, W, H, pal, gt - endAt, coins + ' coins · ' + hits + (hits === 1 ? ' crash' : ' crashes') + ' · bonus +' + bonus, 'Score: ' + final);
        }
        function loop() {
          if (L.isDone()) return;
          var gt = gnow();
          tick(gt);
          if (L.isDone()) return;
          draw(gt);
          L.frame(loop);
        }
        draw(0);
        L.frame(loop);
      });
    }
  });
})();
