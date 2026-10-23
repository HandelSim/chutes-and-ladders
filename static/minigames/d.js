/* Chutes & Ladders minigames (mg-d), the Halloween trio:
 *   'smash'  - Pumpkin Smash: whack pumpkins in a 3x3 patch, leave the ghosts alone.
 *   'candy'  - Candy Catch: slide a basket under falling treats, dodge the spiders.
 *   'oddone' - Odd One Out: spot the one look-alike in a crowded grid, fast.
 * Plain JS, no modules. Relies on the page preamble (MINIGAMES). Every round is generated
 * from the shared seed (ctx.rng), so all players face the same layout.
 */
(function () {
  'use strict';
  if (typeof MINIGAMES === 'undefined') return;

  var ORANGE = '#ff8a2b', GREEN = '#3fb950', RED = '#e5484d';
  var EMOJI_FONT = 'system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function now() { return performance.now() / 1000; }
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
  function hook(L, ctx, score) {
    if (!ctx.signal) return;
    if (ctx.signal.aborted) { L.finish(score()); return; }
    L.on(ctx.signal, 'abort', function () { L.finish(score()); });
  }
  var styled = false;
  function addStyle() {
    if (styled || document.getElementById('mg-hw-style')) { styled = true; return; }
    var s = document.createElement('style'); s.id = 'mg-hw-style';
    s.textContent =
      '.mg-hw-hud{display:flex;justify-content:space-between;align-items:center;gap:8px;font:700 18px Fredoka,system-ui,sans-serif;margin-bottom:6px}' +
      '.mg-hw-hud small{font:600 13px system-ui,sans-serif;color:var(--muted)}' +
      '.mg-hw-bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin-bottom:10px}' +
      '.mg-hw-bar i{display:block;height:100%;width:100%;background:' + ORANGE + ';transform-origin:left center}' +
      '.mg-hw-grid{display:grid;gap:8px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation}' +
      '.mg-hw-cell{aspect-ratio:1;padding:0;min-height:0;display:flex;align-items:center;justify-content:center;font-size:44px;line-height:1;' +
      'border-radius:14px;border:2px solid var(--line);background:radial-gradient(circle at 50% 75%,#33200f,var(--bg));touch-action:manipulation;font-family:' + EMOJI_FONT + '}' +
      '.mg-hw-cell.live{border-color:' + ORANGE + '}' +
      '.mg-hw-cell.good{border-color:' + GREEN + ';background:#1d3a24}' +
      '.mg-hw-cell.bad{border-color:' + RED + ';background:#3d1c1c}' +
      '.mg-hw-cv{display:block;width:100%;border-radius:14px;border:1px solid var(--line);touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer}' +
      '.mg-hw-end{text-align:center;font:700 22px Fredoka,system-ui,sans-serif;margin:18px 0}';
    document.head.appendChild(s); styled = true;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* =========================================================
   * Game 1: Pumpkin Smash
   * ========================================================= */
  var S_DUR = 12, S_N = 22, S_MAX = 400;
  var S_PTS = { pumpkin: 10, gold: 30, ghost: -15 };
  var S_ICON = { pumpkin: '🎃', gold: '🌟', ghost: '👻' };
  var S_KEYS = 'qweasdzxc', S_PAD = '789456123';
  function genSmash(rng) {
    var plan = [], recent = [];
    for (var i = 0; i < S_N; i++) {
      var c;
      do { c = Math.floor(rng() * 9); } while (recent.indexOf(c) >= 0);
      recent.push(c); if (recent.length > 2) recent.shift();
      var u = rng();
      plan.push({ t: 0.6 + i * 0.5, life: i < 8 ? 1.0 : 0.85, cell: c, kind: u < 0.2 ? 'ghost' : u < 0.3 ? 'gold' : 'pumpkin', done: false });
    }
    return plan;
  }

  MINIGAMES.push({
    id: 'smash',
    title: 'Pumpkin Smash',
    icon: '🎃',
    howto: 'Tap the pumpkins as they pop up: 🎃 +10, golden 🌟 +30. Leave the ghosts 👻 alone, they cost 15. ' +
      'Keys: Q W E / A S D / Z X C (or the number pad). 12 seconds.',
    max: S_MAX,
    cpu: { mean: 110, sd: 35 },
    gen: genSmash,
    play: function (stage, ctx) {
      ctx = ctx || {};
      var rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
      var plan = genSmash(rng);
      addStyle();
      stage.innerHTML = '';
      var scoreEl = el('span', '', 'Score 0'), timeEl = el('small', '', '12 s');
      var hud = el('div', 'mg-hw-hud'); hud.appendChild(scoreEl); hud.appendChild(timeEl);
      var barI = el('i'), bar = el('div', 'mg-hw-bar'); bar.appendChild(barI);
      var grid = el('div', 'mg-hw-grid'); grid.style.gridTemplateColumns = 'repeat(3,1fr)';
      var cells = [], fx = [];
      for (var i = 0; i < 9; i++) {
        var b = el('button', 'mg-hw-cell'); b.type = 'button'; b.tabIndex = -1; b.dataset.i = String(i);
        b.setAttribute('aria-label', 'Hole ' + (i + 1));
        cells.push(b); fx.push(null); grid.appendChild(b);
      }
      stage.appendChild(hud); stage.appendChild(bar); stage.appendChild(grid);

      var t0 = now(), score = 0, ended = false, endAt = 0;
      function gnow() { return now() - t0; }
      function active(i, gt) {
        for (var k = 0; k < plan.length; k++) {
          var s = plan[k];
          if (s.cell === i && !s.done && gt >= s.t && gt < s.t + s.life) return s;
        }
        return null;
      }

      return new Promise(function (resolve) {
        var L = makeLife(resolve, S_MAX);
        function tap(i) {
          if (ended) return;
          var gt = gnow(), s = active(i, gt);
          if (!s) return;
          s.done = true;
          var d = S_PTS[s.kind];
          score = Math.max(0, score + d);
          fx[i] = { text: (d > 0 ? '+' : '') + d, good: d > 0, until: gt + 0.35 };
        }
        L.on(grid, 'pointerdown', function (e) {
          var t = e.target && e.target.closest ? e.target.closest('button') : null;
          if (!t || t.dataset.i === undefined) return;
          e.preventDefault();
          tap(+t.dataset.i);
        });
        L.on(window, 'keydown', function (e) {
          if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
          var k = String(e.key || '').toLowerCase(), idx = S_KEYS.indexOf(k);
          if (idx < 0) idx = S_PAD.indexOf(k);
          if (idx < 0) return;
          e.preventDefault();
          tap(idx);
        });
        hook(L, ctx, function () { return score; });
        L.watchdog((S_DUR + 3) * 1000, function () { L.finish(score); });

        function loop() {
          if (L.isDone()) return;
          var gt = gnow();
          if (!ended && gt >= S_DUR) { ended = true; endAt = gt; }
          for (var i = 0; i < 9; i++) {
            var cur = ended ? null : active(i, gt), f = fx[i], txt = '', cls = 'mg-hw-cell';
            if (cur) { txt = S_ICON[cur.kind]; cls += ' live'; }
            else if (f && gt < f.until) { txt = f.text; cls += f.good ? ' good' : ' bad'; }
            if (cells[i].textContent !== txt) cells[i].textContent = txt;
            if (cells[i].className !== cls) cells[i].className = cls;
          }
          scoreEl.textContent = 'Score ' + score;
          var left = clamp(S_DUR - gt, 0, S_DUR);
          timeEl.textContent = Math.ceil(left) + ' s';
          barI.style.transform = 'scaleX(' + (left / S_DUR).toFixed(3) + ')';
          if (ended && gt - endAt >= 0.7) { L.finish(score); return; }
          L.frame(loop);
        }
        L.frame(loop);
      });
    }
  });

  /* =========================================================
   * Game 2: Candy Catch
   * ========================================================= */
  var C_DUR = 13, C_FALL = 1.3, C_N = 24, C_MAX = 450, C_LINE = 0.84, C_HALF = 0.11;
  var C_PTS = { candy: 10, gold: 25, spider: -20 };
  function genCandy(rng) {
    var items = [];
    for (var i = 0; i < C_N; i++) {
      var u = rng(), x = 0.08 + 0.84 * rng();
      items.push({ t: 0.5 + i * 0.45, x: x, kind: u < 0.2 ? 'spider' : u < 0.3 ? 'gold' : 'candy', sym: i % 2 ? '🍬' : '🍭', res: '' });
    }
    return items;
  }

  MINIGAMES.push({
    id: 'candy',
    title: 'Candy Catch',
    icon: '🍬',
    howto: 'Slide the basket (drag, or Left/Right and A/D) under the falling treats: 🍬 +10, golden 🍫 +25. ' +
      'Dodge the spiders 🕷️, each one costs 20. 13 seconds.',
    max: C_MAX,
    cpu: { mean: 120, sd: 40 },
    gen: genCandy,
    play: function (stage, ctx) {
      ctx = ctx || {};
      var rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
      var items = genCandy(rng);
      addStyle();
      stage.innerHTML = '';
      var cv = el('canvas', 'mg-hw-cv');
      cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Candy Catch: move the basket left and right');
      stage.appendChild(cv);
      var W = Math.round(clamp(stage.clientWidth || 480, 280, 520)), H = Math.round(Math.min(420, W * 0.9));
      var dpr = Math.min(3, window.devicePixelRatio || 1);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px';
      var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);

      var t0 = now(), bx = 0.5, tx = 0.5, left = false, right = false, last = 0;
      var score = 0, caught = 0, ended = false, endAt = 0, floats = [], flashT = -9;
      function gnow() { return now() - t0; }

      return new Promise(function (resolve) {
        var L = makeLife(resolve, C_MAX);
        function aim(e) {
          var r = cv.getBoundingClientRect();
          tx = clamp((e.clientX - r.left) / (r.width || W), 0.08, 0.92);
        }
        L.on(cv, 'pointerdown', function (e) { e.preventDefault(); aim(e); });
        L.on(cv, 'pointermove', function (e) { aim(e); });
        L.on(cv, 'contextmenu', function (e) { e.preventDefault(); });
        function key(e, down) {
          var k = e.key;
          if (k === 'ArrowLeft' || k === 'a' || k === 'A') left = down;
          else if (k === 'ArrowRight' || k === 'd' || k === 'D') right = down;
          else return;
          e.preventDefault();
        }
        L.on(window, 'keydown', function (e) { key(e, true); });
        L.on(window, 'keyup', function (e) { key(e, false); });
        hook(L, ctx, function () { return score; });
        L.watchdog((C_DUR + 3) * 1000, function () { L.finish(score); });

        function step(gt) {
          var dt = clamp(gt - last, 0, 0.05); last = gt;
          if (left) tx = clamp(tx - 1.1 * dt, 0.08, 0.92);
          if (right) tx = clamp(tx + 1.1 * dt, 0.08, 0.92);
          bx += (tx - bx) * Math.min(1, dt * 16);
          for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.res || gt < it.t + C_FALL) continue;
            if (ended) { it.res = 'miss'; continue; }
            if (Math.abs(it.x - bx) <= C_HALF) {
              it.res = 'caught';
              var d = C_PTS[it.kind];
              score = Math.max(0, score + d);
              if (d > 0) caught++; else flashT = gt;
              floats.push({ x: it.x * W, t: gt, text: (d > 0 ? '+' : '') + d, col: d > 0 ? GREEN : RED });
            } else it.res = 'miss';
          }
        }
        function emoji(sym, x, y, px) {
          g.font = Math.round(px) + 'px ' + EMOJI_FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(sym, x, y);
        }
        function draw(gt) {
          var sky = g.createLinearGradient(0, 0, 0, H);
          sky.addColorStop(0, '#120a22'); sky.addColorStop(1, '#3a1a2c');
          g.fillStyle = sky; g.fillRect(0, 0, W, H);
          emoji('🌕', W * 0.84, H * 0.14, 46);
          var yLine = H * C_LINE;
          for (var i = 0; i < items.length; i++) {
            var it = items[i], fr = (gt - it.t) / C_FALL;
            if (fr < 0 || fr > 1.25 || it.res === 'caught') continue;
            var y = -20 + (yLine + 20) * fr;
            emoji(it.kind === 'spider' ? '🕷️' : it.kind === 'gold' ? '🍫' : it.sym, it.x * W, y, 32);
          }
          g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, yLine + 26, W, H - yLine - 26);
          emoji('🧺', bx * W, yLine + 12, 58);
          for (var f = 0; f < floats.length; f++) {
            var fl = floats[f], k = (gt - fl.t) / 0.7;
            if (k < 0 || k > 1) continue;
            g.save(); g.globalAlpha = 1 - k; g.font = '700 22px Fredoka, system-ui, sans-serif'; g.textAlign = 'center';
            g.lineWidth = 4; g.strokeStyle = '#120a22'; g.strokeText(fl.text, fl.x, yLine - 20 - k * 26);
            g.fillStyle = fl.col; g.fillText(fl.text, fl.x, yLine - 20 - k * 26); g.restore();
          }
          var fk = (gt - flashT) / 0.35;
          if (fk >= 0 && fk < 1) { g.fillStyle = 'rgba(229,72,77,' + (0.3 * (1 - fk)).toFixed(3) + ')'; g.fillRect(0, 0, W, H); }
          var tl = clamp(1 - gt / C_DUR, 0, 1);
          g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(8, 8, W - 16, 6);
          g.fillStyle = tl < 0.2 ? RED : ORANGE; g.fillRect(8, 8, (W - 16) * tl, 6);
          g.fillStyle = '#f5e6d3'; g.font = '700 18px Fredoka, system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
          g.fillText('Score ' + score, 10, 36);
          if (gt < 2) { g.globalAlpha = 0.7; g.font = '600 13px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('drag or use arrow keys', W / 2, H - 10); g.globalAlpha = 1; }
          if (ended) {
            g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, W, H);
            g.fillStyle = '#f5e6d3'; g.textAlign = 'center'; g.font = '600 15px system-ui, sans-serif';
            g.fillText(caught + ' treats caught', W / 2, H / 2 - 18);
            g.font = '700 32px Fredoka, system-ui, sans-serif'; g.fillText('Score: ' + score, W / 2, H / 2 + 20);
          }
        }
        function loop() {
          if (L.isDone()) return;
          var gt = gnow();
          if (!ended && gt >= C_DUR) { ended = true; endAt = gt; }
          step(gt);
          draw(gt);
          if (ended && gt - endAt >= 0.8) { L.finish(score); return; }
          L.frame(loop);
        }
        L.frame(loop);
      });
    }
  });

  /* =========================================================
   * Game 3: Odd One Out
   * ========================================================= */
  var O_ROUNDS = 5, O_LIMIT = 2.3, O_PAUSE = 0.35, O_SIZES = [3, 4, 4, 5, 5], O_BASE = 30, O_SPEED = 40, O_MAX = 350;
  var O_PAIRS = [['🎃', '🍊'], ['🦇', '🐦'], ['🕷️', '🦂'], ['💀', '😵'], ['🍬', '🍭'], ['🧛', '🧟'], ['🌕', '🌝'], ['👻', '🥶']];
  function genOdd(rng) {
    var rounds = [];
    for (var r = 0; r < O_ROUNDS; r++) {
      var n = O_SIZES[r] * O_SIZES[r];
      var pair = O_PAIRS[Math.floor(rng() * O_PAIRS.length)], flip = rng() < 0.5;
      rounds.push({ size: O_SIZES[r], base: pair[flip ? 1 : 0], odd: pair[flip ? 0 : 1], at: Math.floor(rng() * n) });
    }
    return rounds;
  }

  MINIGAMES.push({
    id: 'oddone',
    title: 'Odd One Out',
    icon: '🔎',
    howto: 'Five crowded grids, 2.3 seconds each. Tap the one look-alike that does not match the rest. ' +
      'Right answers score 30 plus up to 40 for speed; a wrong tap scores nothing.',
    max: O_MAX,
    cpu: { mean: 190, sd: 60 },
    gen: genOdd,
    play: function (stage, ctx) {
      ctx = ctx || {};
      var rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
      var rounds = genOdd(rng);
      addStyle();
      stage.innerHTML = '';
      var roundEl = el('span', '', 'Round 1 of ' + O_ROUNDS), scoreEl = el('small', '', 'Score 0');
      var hud = el('div', 'mg-hw-hud'); hud.appendChild(roundEl); hud.appendChild(scoreEl);
      var barI = el('i'), bar = el('div', 'mg-hw-bar'); bar.appendChild(barI);
      var grid = el('div', 'mg-hw-grid');
      stage.appendChild(hud); stage.appendChild(bar); stage.appendChild(grid);

      var t0 = now(), ri = -1, phase = 'pause', phaseAt = 0, rs = 0, score = 0, cells = [];
      function gnow() { return now() - t0; }

      return new Promise(function (resolve) {
        var L = makeLife(resolve, O_MAX);
        function buildRound(r) {
          grid.replaceChildren();
          cells = [];
          grid.style.gridTemplateColumns = 'repeat(' + r.size + ',1fr)';
          for (var i = 0; i < r.size * r.size; i++) {
            var b = el('button', 'mg-hw-cell', i === r.at ? r.odd : r.base);
            b.type = 'button'; b.tabIndex = -1; b.dataset.i = String(i);
            b.style.fontSize = (r.size === 3 ? 44 : r.size === 4 ? 36 : 30) + 'px';
            b.setAttribute('aria-label', 'Symbol ' + (i + 1));
            cells.push(b); grid.appendChild(b);
          }
        }
        function startRound(gt) {
          ri++;
          if (ri >= O_ROUNDS) {
            phase = 'end'; phaseAt = gt; grid.replaceChildren();
            grid.appendChild(el('p', 'mg-hw-end', 'Score: ' + score));
            return;
          }
          buildRound(rounds[ri]);
          roundEl.textContent = 'Round ' + (ri + 1) + ' of ' + O_ROUNDS;
          phase = 'round'; rs = gt;
        }
        function settle(gt, picked) {
          var r = rounds[ri];
          if (picked === r.at) {
            var rem = clamp(O_LIMIT - (gt - rs), 0, O_LIMIT);
            score += O_BASE + Math.round(O_SPEED * rem / O_LIMIT);
          }
          for (var i = 0; i < cells.length; i++) {
            if (i === r.at) cells[i].className = 'mg-hw-cell good';
            else if (i === picked) cells[i].className = 'mg-hw-cell bad';
          }
          phase = 'pause'; phaseAt = gt;
        }
        L.on(grid, 'pointerdown', function (e) {
          var t = e.target && e.target.closest ? e.target.closest('button') : null;
          if (phase !== 'round' || !t || t.dataset.i === undefined) return;
          e.preventDefault();
          var gt = gnow();
          if (gt - rs >= O_LIMIT) return;
          settle(gt, +t.dataset.i);
        });
        hook(L, ctx, function () { return score; });
        L.watchdog((O_ROUNDS * (O_LIMIT + O_PAUSE) + 4) * 1000, function () { L.finish(score); });

        function loop() {
          if (L.isDone()) return;
          var gt = gnow();
          if (phase === 'round' && gt - rs >= O_LIMIT) settle(gt, -1);
          else if (phase === 'pause' && gt - phaseAt >= O_PAUSE) startRound(gt);
          else if (phase === 'end' && gt - phaseAt >= 0.7) { L.finish(score); return; }
          scoreEl.textContent = 'Score ' + score;
          var frac = phase === 'round' ? clamp(1 - (gt - rs) / O_LIMIT, 0, 1) : 0;
          barI.style.transform = 'scaleX(' + frac.toFixed(3) + ')';
          L.frame(loop);
        }
        L.frame(loop);
      });
    }
  });
})();
