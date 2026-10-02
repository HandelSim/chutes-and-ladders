/* Chutes & Ladders minigames (mg-b):
 *   'memory'    Pad Recall  - Simon-style: watch a seeded pad sequence, repeat it, it grows by one.
 *   'headcount' Head Count  - observation: count one character in a briefly shown crowd, 3 rounds.
 * Plain JS, no modules. Expects the page preamble (MINIGAMES, mulberry32) to exist.
 */
(function () {
  'use strict';

  // ---------- shared helpers ----------
  var STYLE_ID = 'mg-b-style';
  var CSS = [
    /* Pad Recall */
    '.mg-memory{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;max-height:380px;',
    'font-family:system-ui,sans-serif;color:var(--ink);user-select:none;-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent}',
    '.mg-memory-hud,.mg-headcount-hud{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;max-width:480px;min-height:32px}',
    '.mg-memory-pill,.mg-headcount-pill{font:600 14px/1 Fredoka,system-ui,sans-serif;padding:7px 11px;border-radius:999px;background:var(--accent-soft);',
    'color:var(--ink);border:2px solid var(--line);white-space:nowrap}',
    '.mg-memory-pill b,.mg-headcount-pill b{font-weight:700;font-variant-numeric:tabular-nums}',
    '.mg-memory-status{flex:1;text-align:center;font:600 18px/1.1 Fredoka,system-ui,sans-serif;color:var(--ink);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mg-memory-status.go{color:var(--accent)}',
    '.mg-memory-time,.mg-headcount-time{width:100%;max-width:480px;height:10px;border-radius:99px;background:var(--line);overflow:hidden;flex:none}',
    '.mg-memory-time>i,.mg-headcount-time>i{display:block;height:100%;width:100%;border-radius:99px;background:var(--accent);transform-origin:left center}',
    '.mg-memory-time.low>i{background:var(--c1)}',
    '.mg-memory-dots{display:flex;gap:7px;height:14px;align-items:center;justify-content:center}',
    '.mg-memory-dot{width:12px;height:12px;border-radius:50%;border:2px solid var(--muted);box-sizing:border-box;transition:background .08s,border-color .08s}',
    '.mg-memory-dot.on{background:var(--accent);border-color:var(--accent)}',
    '.mg-memory-dot.ok{background:var(--finish);border-color:var(--finish)}',
    '.mg-memory-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;max-width:360px;padding:4px 2px 8px;box-sizing:border-box}',
    '.mg-memory-pad{position:relative;height:118px;border-radius:22px;background:var(--pc);border:4px solid rgba(0,0,0,.28);box-sizing:border-box;',
    'box-shadow:0 6px 0 rgba(0,0,0,.28);cursor:pointer;display:flex;align-items:center;justify-content:center;',
    'filter:saturate(.7) brightness(.78);opacity:.8;transition:filter 60ms linear,transform 60ms linear,opacity 60ms linear,box-shadow 60ms linear;touch-action:none}',
    '.mg-memory-num{width:46px;height:46px;border-radius:50%;background:var(--panel);color:var(--ink);border:3px solid rgba(0,0,0,.3);',
    'display:flex;align-items:center;justify-content:center;font:700 26px/1 Fredoka,system-ui,sans-serif;box-sizing:border-box;transition:transform 60ms linear}',
    '.mg-memory-pad.lit{filter:saturate(1.15) brightness(1.2);opacity:1;transform:translateY(-3px) scale(1.04);',
    'box-shadow:0 9px 0 rgba(0,0,0,.25),0 0 0 4px var(--panel),0 0 26px 8px var(--pc);border-color:#fff}',
    '.mg-memory-pad.lit .mg-memory-num{transform:scale(1.22)}',
    '.mg-memory-pad.press{transform:translateY(4px);box-shadow:0 2px 0 rgba(0,0,0,.28),0 0 0 4px var(--panel);filter:saturate(1.1) brightness(1.15);opacity:1}',
    '.mg-memory-pad.wrong{filter:grayscale(.6) brightness(.7);opacity:1;border-color:var(--ink)}',
    '.mg-memory-pad.wrong::after{content:"\\00d7";position:absolute;right:10px;top:4px;font:700 34px/1 Fredoka,system-ui,sans-serif;color:#fff;text-shadow:0 2px 0 rgba(0,0,0,.55)}',
    '.mg-memory-pad.hint{opacity:1;filter:none;border-color:var(--ink);box-shadow:0 6px 0 rgba(0,0,0,.28),0 0 0 4px var(--accent)}',
    '.mg-memory.wait .mg-memory-pad{cursor:default}',
    '.mg-memory-shake{animation:mg-memory-shake .3s linear}',
    '@keyframes mg-memory-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}',
    /* shared end card */
    '.mg-b-end{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:var(--panel);color:var(--ink);border:3px solid var(--line);',
    'border-radius:18px;padding:14px 26px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:5;min-width:170px}',
    '.mg-b-end small{display:block;font:600 15px/1.2 Fredoka,system-ui,sans-serif;color:var(--muted);margin-bottom:4px}',
    '.mg-b-end strong{display:block;font:700 30px/1.1 Fredoka,system-ui,sans-serif;color:var(--accent)}',
    /* Head Count */
    '.mg-headcount{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;max-height:380px;',
    'font-family:system-ui,sans-serif;color:var(--ink);user-select:none;-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent}',
    '.mg-headcount-target{display:flex;align-items:center;gap:6px;font:600 15px/1 Fredoka,system-ui,sans-serif;min-width:0;overflow:hidden}',
    '.mg-headcount-target span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mg-headcount-arena{position:relative;width:100%;max-width:480px;aspect-ratio:1.6/1;border-radius:18px;border:3px solid var(--line);box-sizing:border-box;',
    'overflow:hidden;background-color:var(--accent-soft);background-image:radial-gradient(var(--line) 1.4px,transparent 1.6px);background-size:22px 22px}',
    '.mg-headcount-face{position:absolute;aspect-ratio:1/1;border-radius:50%;box-sizing:border-box;border:2px solid var(--panel);',
    'box-shadow:0 2px 0 rgba(0,0,0,.25);overflow:hidden;background:var(--panel);will-change:transform}',
    '.mg-headcount-face img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%;pointer-events:none}',
    '.mg-headcount-dot{width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;',
    'font:700 1em/1 Fredoka,system-ui,sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.6)}',
    '.mg-headcount-pop{animation:mg-headcount-pop .12s ease-out}',
    '@keyframes mg-headcount-pop{from{transform:scale(.6);opacity:.3}to{transform:scale(1);opacity:1}}',
    '.mg-headcount-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:10px;box-sizing:border-box;text-align:center}',
    '.mg-headcount-big{width:34%;max-width:120px;aspect-ratio:1/1;position:relative;border-width:4px;box-shadow:0 5px 0 rgba(0,0,0,.25)}',
    '.mg-headcount-title{font:700 22px/1.15 Fredoka,system-ui,sans-serif;color:var(--ink)}',
    '.mg-headcount-q{display:flex;align-items:center;gap:8px;font:600 18px/1.15 Fredoka,system-ui,sans-serif}',
    '.mg-headcount-q .mg-headcount-face{position:relative;width:38px;flex:none}',
    '.mg-headcount-choices{display:flex;gap:8px;width:100%;max-width:400px}',
    '.mg-headcount-btn{position:relative;flex:1;min-height:70px;border-radius:16px;border:3px solid rgba(0,0,0,.22);background:var(--panel);color:var(--ink);',
    'box-shadow:0 5px 0 rgba(0,0,0,.22);font:700 32px/1 Fredoka,system-ui,sans-serif;cursor:pointer;touch-action:none;padding:0;font-variant-numeric:tabular-nums}',
    '.mg-headcount-btn kbd{position:absolute;left:6px;top:5px;font:600 11px/1 system-ui,sans-serif;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:2px 4px;background:var(--bg)}',
    '.mg-headcount-btn.right{background:var(--accent);color:var(--accent-ink);border-color:var(--ink)}',
    '.mg-headcount-btn.right::after{content:"\\2713";position:absolute;right:7px;top:4px;font-size:16px}',
    '.mg-headcount-btn.picked{transform:translateY(3px);box-shadow:0 2px 0 rgba(0,0,0,.22)}',
    '.mg-headcount-btn.miss{text-decoration:line-through;color:var(--muted)}',
    '.mg-headcount-btn.miss::after{content:"\\00d7";position:absolute;right:7px;top:3px;font-size:18px}',
    '.mg-headcount-btn:disabled{cursor:default}',
    '.mg-headcount-banner{font:700 20px/1.2 Fredoka,system-ui,sans-serif;color:var(--ink);background:var(--panel);border:3px solid var(--line);border-radius:14px;padding:6px 14px}',
    '.mg-headcount-banner.warn{border-color:var(--c1)}',
    '.mg-headcount-time.answer>i{background:var(--c2)}'
  ].join('');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Frame loop + listener bookkeeping + guaranteed single resolve.
  function makeSession(ctx, watchdogMs) {
    var S = { done: false, listeners: [], raf: 0, wd: 0, onFrame: null, getScore: function () { return 0; } };
    var resolveFn;
    S.promise = new Promise(function (r) { resolveFn = r; });
    S.on = function (target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      S.listeners.push([target, type, fn, opts]);
    };
    S.finish = function (score) {
      if (S.done) return;
      S.done = true;
      cancelAnimationFrame(S.raf);
      clearTimeout(S.wd);
      for (var i = 0; i < S.listeners.length; i++) {
        var l = S.listeners[i];
        l[0].removeEventListener(l[1], l[2], l[3]);
      }
      S.listeners = [];
      var n = Math.round(Number(score) || 0);
      resolveFn(n < 0 ? 0 : n);
    };
    function loop(now) {
      if (S.done) return;
      S.onFrame(now);
      if (!S.done) S.raf = requestAnimationFrame(loop);
    }
    S.start = function () {
      if (ctx.signal) {
        if (ctx.signal.aborted) { S.finish(0); return S.promise; }
        S.on(ctx.signal, 'abort', function () { S.finish(S.getScore()); });
      }
      // Safety net only (e.g. rAF paused in a hidden tab): never let the promise hang.
      S.wd = setTimeout(function () { S.finish(S.getScore()); }, watchdogMs);
      S.raf = requestAnimationFrame(loop);
      return S.promise;
    };
    return S;
  }

  function endCard(parent, label, score) {
    var c = el('div', 'mg-b-end', parent);
    el('small', null, c, label);
    el('strong', null, c, 'Score: ' + score);
    return c;
  }

  // =====================================================================
  // 1) Pad Recall
  // =====================================================================
  var MEM = {
    CAP: 7,          // longest sequence; completing it ends the game ("Perfect!")
    START: 3,
    BUDGET: 15000,   // hard total, playback included
    LEAD: 450,       // "Watch..." before the first playback
    GAP: 350,        // pause after a completed sequence
    LIT: 0.6,        // fraction of a step the pad is lit (rest is dark so repeats read clearly)
    END: 750         // end card
  };
  function memStep(L) { return Math.max(200, 350 - 35 * (L - 3)); } // 350,315,280,245,210 ms
  // Speed bonus for a completed sequence: up to 2 per step. Full at fast pace, 0 at relaxed pace.
  function memBonus(L, ms) {
    var t = ms / 1000, par = 0.6 + 0.5 * L, fast = 0.3 + 0.2 * L;
    return Math.round(2 * L * clamp((par - t) / (par - fast), 0, 1));
  }
  var MEM_MAX = (function () { var s = 0; for (var L = MEM.START; L <= MEM.CAP; L++) s += 12 * L; return s; })(); // 300

  MINIGAMES.push({
    id: 'memory',
    title: 'Pad Recall',
    icon: '🧠',
    howto: 'Watch the pads light up, then repeat the pattern by tapping them (or keys 1-4). Each round adds one step. One mistake ends it, and the 15 s clock includes the playback.',
    max: MEM_MAX,
    cpu: { mean: 135, sd: 50 },
    play: function (stage, ctx) {
      injectStyle();
      var rng = ctx.rng;
      var reduced = !!ctx.reduced;

      // Seeded challenge: one fixed list; round L shows its first L entries. No triple repeats.
      var seq = [];
      for (var i = 0; i < MEM.CAP; i++) {
        var v;
        do { v = Math.floor(rng() * 4); } while (i >= 2 && v === seq[i - 1] && v === seq[i - 2]);
        seq.push(v);
      }

      stage.textContent = '';
      var wrap = el('div', 'mg-memory wait', stage);
      wrap.dataset.challenge = JSON.stringify(seq);
      var hud = el('div', 'mg-memory-hud', wrap);
      var lenPill = el('div', 'mg-memory-pill', hud);
      var status = el('div', 'mg-memory-status', hud, 'Watch...');
      var scorePill = el('div', 'mg-memory-pill', hud);
      var timeBar = el('div', 'mg-memory-time', wrap);
      var timeFill = el('i', null, timeBar);
      var dotsBox = el('div', 'mg-memory-dots', wrap);
      var grid = el('div', 'mg-memory-grid', wrap);
      var pads = [];
      for (var p = 0; p < 4; p++) {
        var pad = el('div', 'mg-memory-pad', grid);
        pad.style.setProperty('--pc', 'var(--c' + (p + 1) + ')');
        pad.setAttribute('role', 'button');
        pad.setAttribute('aria-label', 'Pad ' + (p + 1));
        el('span', 'mg-memory-num', pad, String(p + 1));
        pads.push(pad);
      }

      var S = makeSession(ctx, MEM.BUDGET + 900);
      var score = 0, L = MEM.START, pos = 0;
      var phase = 'lead', t0 = 0, phaseAt = 0, inputAt = 0, endAt = 0;
      var litPad = -1, pressPad = -1, pressUntil = 0;
      var dots = [];
      S.getScore = function () { return Math.min(MEM_MAX, score); };

      function setHud() {
        lenPill.innerHTML = 'Length <b>' + L + '</b>';
        scorePill.innerHTML = 'Score <b>' + score + '</b>';
      }
      function buildDots() {
        dotsBox.textContent = '';
        dots = [];
        for (var k = 0; k < L; k++) dots.push(el('span', 'mg-memory-dot', dotsBox));
      }
      function setStatus(txt, go) {
        status.textContent = txt;
        status.className = 'mg-memory-status' + (go ? ' go' : '');
      }
      function startPlayback(now) {
        phase = 'play'; phaseAt = now; pos = 0;
        wrap.classList.add('wait');
        buildDots(); setHud(); setStatus('Watch...');
      }
      function end(now, label) {
        phase = 'end'; endAt = now + MEM.END;
        litPad = -1; pressPad = -1;
        wrap.classList.add('wait');
        for (var k = 0; k < 4; k++) pads[k].classList.remove('lit', 'press');
        setHud();
        setStatus(label);
        endCard(wrap, label, S.getScore());
      }

      function tap(i) {
        if (S.done) return;
        var now = performance.now();
        if (phase !== 'input') return; // taps while watching are ignored
        pressPad = i; pressUntil = now + 150;
        if (i === seq[pos]) {
          dots[pos].classList.add('on');
          pos++;
          if (pos === L) {
            var b = memBonus(L, now - inputAt);
            score += 10 * L + b;
            for (var k = 0; k < dots.length; k++) dots[k].classList.add('ok');
            setHud();
            if (L >= MEM.CAP) { end(now, 'Perfect!'); return; }
            phase = 'gap'; phaseAt = now;
            wrap.classList.add('wait');
            setStatus('+' + (10 * L + b) + (b >= L ? ' Speedy!' : ' Nice!'), true);
          }
        } else {
          pads[i].classList.add('wrong');
          pads[seq[pos]].classList.add('hint');
          if (!reduced) grid.classList.add('mg-memory-shake');
          end(now, 'Oops! It was ' + (seq[pos] + 1));
        }
      }

      S.onFrame = function (now) {
        if (!t0) { t0 = now; phaseAt = now; }
        var t = now - t0;
        if (phase === 'end') {
          if (now >= endAt) S.finish(S.getScore());
          return;
        }
        if (t >= MEM.BUDGET) { timeFill.style.transform = 'scaleX(0)'; end(now, "Time's up!"); return; }
        var left = 1 - t / MEM.BUDGET;
        timeFill.style.transform = 'scaleX(' + left.toFixed(4) + ')';
        timeBar.classList.toggle('low', left < 0.25);

        var want = -1;
        if (phase === 'lead') {
          if (now - phaseAt >= MEM.LEAD) startPlayback(now);
        } else if (phase === 'gap') {
          if (now - phaseAt >= MEM.GAP) { L++; startPlayback(now); }
        }
        if (phase === 'play') {
          var step = memStep(L), e = now - phaseAt, k = Math.floor(e / step);
          if (k >= L) {
            phase = 'input'; inputAt = now;
            wrap.classList.remove('wait');
            setStatus('Your turn!', true);
          } else if (e - k * step < step * MEM.LIT) {
            want = seq[k];
          }
        }
        if (want !== litPad) {
          if (litPad >= 0) pads[litPad].classList.remove('lit');
          if (want >= 0) pads[want].classList.add('lit');
          litPad = want;
        }
        for (var q = 0; q < 4; q++) pads[q].classList.toggle('press', q === pressPad && now < pressUntil);
      };

      pads.forEach(function (pd, idx) {
        S.on(pd, 'pointerdown', function (ev) { ev.preventDefault(); tap(idx); });
      });
      S.on(wrap, 'pointerdown', function (ev) { ev.preventDefault(); });
      S.on(wrap, 'contextmenu', function (ev) { ev.preventDefault(); });
      S.on(window, 'keydown', function (ev) {
        if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        var n = '1234'.indexOf(ev.key);
        if (n < 0) return;
        ev.preventDefault();
        tap(n);
      });

      buildDots(); setHud();
      return S.start();
    }
  });

  // =====================================================================
  // 2) Head Count
  // =====================================================================
  var HC = {
    ROUNDS: 3,
    INTRO: 500,      // target card
    CROWD: 2200,     // crowd visible
    ANSWER: 2000,    // answer window after the crowd hides
    FEEDBACK: 350,   // between rounds
    END: 800,        // final card (also shows round-3 result)
    BONUS: 50,       // speed bonus for a correct answer: full <= 0.5 s, 0 at 2.0 s
    N: [[12, 15], [15, 19], [18, 24]],  // crowd size per round
    T: [[4, 6], [5, 8], [6, 9]],        // how many targets per round
    H: 0.625                            // arena height / width (aspect 1.6)
  };
  var HC_MAX = HC.ROUNDS * (100 + HC.BONUS); // 450
  var HC_FALLBACK = [
    { name: 'Red', color: '#e5484d', letter: 'R' },
    { name: 'Blue', color: '#3e7bfa', letter: 'B' },
    { name: 'Green', color: '#2fb67c', letter: 'G' },
    { name: 'Yellow', color: '#e9a800', letter: 'Y' },
    { name: 'Purple', color: '#9b5de5', letter: 'P' }
  ];

  function plural(name) {
    if (/(s|sh|ch|x|z)$/i.test(name)) return name + 'es';
    if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
    return name + 's';
  }
  function randInt(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }

  // Mitchell best-candidate scatter in normalized arena coords (x in [0,1], y in [0,H]).
  function scatter(rng, n) {
    var pts = [], m = 0.06, H = HC.H;
    for (var i = 0; i < n; i++) {
      var best = null, bd = -1;
      for (var c = 0; c < 40; c++) {
        var x = m + rng() * (1 - 2 * m), y = m + rng() * (H - 2 * m), md = 1e9;
        for (var j = 0; j < pts.length; j++) {
          var d = Math.hypot(pts[j].x - x, pts[j].y - y);
          if (d < md) md = d;
        }
        if (md > bd) { bd = md; best = { x: x, y: y }; }
      }
      pts.push(best);
    }
    var minD = 1e9;
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) minD = Math.min(minD, Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y));
    return { pts: pts, minD: minD };
  }

  // 4 distinct ascending choices containing the answer at a seeded slot; neighbours 1 apart (75%) or 2.
  function makeChoices(rng, n) {
    var slot = Math.floor(rng() * 4), out = [n], k, v;
    v = n;
    for (k = slot - 1; k >= 0; k--) { var g = rng() < 0.75 ? 1 : 2; if (v - g < 1) g = 1; v -= g; out.unshift(v); }
    v = n;
    for (k = slot + 1; k < 4; k++) { var g2 = rng() < 0.75 ? 1 : 2; v += g2; out.push(v); }
    return { list: out, slot: slot };
  }

  function makeFace(who, cls) {
    var f = el('div', 'mg-headcount-face' + (cls ? ' ' + cls : ''));
    if (who.img) {
      var im = el('img', null, f);
      im.alt = '';
      im.draggable = false;
      im.src = who.img;
    } else {
      var d = el('div', 'mg-headcount-dot', f, who.letter);
      d.style.background = who.color;
    }
    return f;
  }

  MINIGAMES.push({
    id: 'headcount',
    title: 'Head Count',
    icon: '👀',
    howto: 'A crowd flashes for 2 seconds: count the character shown. Then pick the number (tap or keys 1-4). Faster correct answers score more; off by one gets a little. Tapping before the numbers appear loses the round. 3 rounds.',
    max: HC_MAX,
    cpu: { mean: 225, sd: 80 },
    play: function (stage, ctx) {
      injectStyle();
      var rng = ctx.rng;
      var reduced = !!ctx.reduced;

      // ----- build the whole seeded challenge up front -----
      var chars = Array.isArray(ctx.chars) ? ctx.chars : [];
      var pool;
      if (chars.length >= 3) {
        pool = chars.map(function (c, i) {
          var nm = (c && c.name) ? String(c.name) : 'Player ' + (i + 1);
          var fb = HC_FALLBACK[i % HC_FALLBACK.length];
          return { id: c && c.id != null ? c.id : i, name: nm, img: c && c.img ? c.img : null, color: fb.color, letter: nm.charAt(0).toUpperCase() };
        });
      } else {
        pool = HC_FALLBACK.map(function (f, i) { return { id: 'fb' + i, name: f.name, img: null, color: f.color, letter: f.letter }; });
      }
      var order = shuffle(pool.map(function (_, i) { return i; }), rng);
      var rounds = [];
      for (var r = 0; r < HC.ROUNDS; r++) {
        var target = order[r % order.length];
        var N = randInt(rng, HC.N[r][0], HC.N[r][1]);
        var n = randInt(rng, HC.T[r][0], HC.T[r][1]);
        var others = shuffle(pool.map(function (_, i) { return i; }).filter(function (i) { return i !== target; }), rng);
        var k = Math.min(others.length, 2 + Math.floor(rng() * 3));
        var decoys = others.slice(0, k);
        var counts = decoys.map(function () { return 1; });
        for (var j = 0; j < N - n - k; j++) counts[Math.floor(rng() * k)]++;
        var items = [];
        for (j = 0; j < n; j++) items.push(target);
        decoys.forEach(function (dIdx, di) { for (var c = 0; c < counts[di]; c++) items.push(dIdx); });
        shuffle(items, rng);
        var sc = scatter(rng, N);
        var dFix = Math.min(0.125, 0.6 * Math.sqrt(HC.H / N));
        var d = Math.min(dFix, 0.92 * sc.minD);
        var faces = items.map(function (who, ii) {
          return { who: who, x: sc.pts[ii].x, y: sc.pts[ii].y, ph: rng() * Math.PI * 2, sp: 2.2 + rng() * 1.6 };
        });
        var ch = makeChoices(rng, n);
        rounds.push({ target: target, N: N, n: n, decoys: decoys, counts: counts, d: d, faces: faces, choices: ch.list });
      }

      // ----- DOM -----
      stage.textContent = '';
      var wrap = el('div', 'mg-headcount', stage);
      wrap.dataset.challenge = JSON.stringify(rounds.map(function (R) {
        return {
          target: pool[R.target].id, n: R.n, N: R.N, decoys: R.decoys.map(function (i) { return pool[i].id; }), counts: R.counts, choices: R.choices,
          d: +R.d.toFixed(4), pos: R.faces.map(function (f) { return [+f.x.toFixed(4), +f.y.toFixed(4), pool[f.who].id]; })
        };
      }));
      var hud = el('div', 'mg-headcount-hud', wrap);
      var roundPill = el('div', 'mg-headcount-pill', hud);
      var targetBox = el('div', 'mg-headcount-target', hud);
      var scorePill = el('div', 'mg-headcount-pill', hud);
      var timeBar = el('div', 'mg-headcount-time', wrap);
      var timeFill = el('i', null, timeBar);
      var arena = el('div', 'mg-headcount-arena', wrap);

      var S = makeSession(ctx, 16000);
      var score = 0, ri = 0, phase = 'intro', phaseAt = 0, locked = false, answered = false;
      var faceEls = [], btns = [], endAt = 0, fbUntil = 0;
      S.getScore = function () { return Math.min(HC_MAX, score); };

      function setHud() {
        roundPill.innerHTML = 'Round <b>' + (ri + 1) + '</b>/' + HC.ROUNDS;
        scorePill.innerHTML = 'Score <b>' + score + '</b>';
      }
      function setTarget(R) {
        targetBox.textContent = '';
        var f = makeFace(pool[R.target]);
        f.style.position = 'relative'; f.style.width = '28px'; f.style.flex = 'none'; f.style.fontSize = '13px';
        targetBox.appendChild(f);
        el('span', null, targetBox, pool[R.target].name);
        targetBox.title = 'Count: ' + pool[R.target].name;
      }
      function showIntro(now) {
        var R = rounds[ri];
        phase = 'intro'; phaseAt = now; locked = false; answered = false;
        arena.textContent = '';
        setHud(); setTarget(R);
        var c = el('div', 'mg-headcount-center', arena);
        var big = makeFace(pool[R.target], 'mg-headcount-big');
        big.style.fontSize = '40px';
        c.appendChild(big);
        el('div', 'mg-headcount-title', c, 'Count the ' + plural(pool[R.target].name) + '!');
        timeFill.style.transform = 'scaleX(1)';
        timeBar.classList.remove('answer');
      }
      function showCrowd(now) {
        var R = rounds[ri];
        phase = 'crowd'; phaseAt = now;
        arena.textContent = '';
        faceEls = R.faces.map(function (f) {
          var e = makeFace(pool[f.who], reduced ? '' : 'mg-headcount-pop');
          e.style.width = (R.d * 100) + '%';
          e.style.left = ((f.x - R.d / 2) * 100) + '%';
          e.style.top = ((f.y - R.d / 2) / HC.H * 100) + '%';
          e.style.fontSize = Math.max(10, arena.clientWidth * R.d * 0.45) + 'px';
          arena.appendChild(e);
          return e;
        });
      }
      function showAnswer(now) {
        var R = rounds[ri];
        phase = 'answer'; phaseAt = now;
        arena.textContent = ''; faceEls = [];
        var c = el('div', 'mg-headcount-center', arena);
        if (locked) {
          el('div', 'mg-headcount-banner warn', c, 'Too early! Round lost');
          el('div', 'mg-headcount-q', c, 'There were ' + R.n + '.');
          return;
        }
        timeBar.classList.add('answer');
        var q = el('div', 'mg-headcount-q', c);
        var f = makeFace(pool[R.target]);
        f.style.fontSize = '16px';
        q.appendChild(f);
        el('span', null, q, 'How many ' + plural(pool[R.target].name) + '?');
        var row = el('div', 'mg-headcount-choices', c);
        btns = R.choices.map(function (val, bi) {
          var b = el('button', 'mg-headcount-btn', row, String(val));
          b.type = 'button';
          el('kbd', null, b, String(bi + 1));
          S.on(b, 'pointerdown', function (ev) { ev.preventDefault(); ev.stopPropagation(); answer(bi); });
          return b;
        });
      }
      function feedback(now, pickedIdx, gained, msg) {
        var R = rounds[ri];
        phase = 'feedback'; phaseAt = now; fbUntil = now + HC.FEEDBACK;
        btns.forEach(function (b, bi) {
          b.disabled = true;
          if (R.choices[bi] === R.n) b.classList.add('right');
          else if (bi === pickedIdx) b.classList.add('miss');
          if (bi === pickedIdx) b.classList.add('picked');
        });
        var c = arena.querySelector('.mg-headcount-center');
        if (c && msg) el('div', 'mg-headcount-banner', c, msg);
        score += gained;
        setHud();
        if (ri === HC.ROUNDS - 1) finishGame(now);
      }
      function answer(bi) {
        if (S.done || phase !== 'answer' || locked || answered) return;
        var now = performance.now();
        var R = rounds[ri];
        answered = true;
        var val = R.choices[bi], dt = now - phaseAt, gained, msg;
        if (val === R.n) {
          var bonus = Math.round(HC.BONUS * clamp((HC.ANSWER - dt) / (HC.ANSWER - 500), 0, 1));
          gained = 100 + bonus;
          msg = 'Right! +' + gained;
        } else if (Math.abs(val - R.n) === 1) {
          gained = 30; msg = 'So close! +30 (it was ' + R.n + ')';
        } else {
          gained = 0; msg = 'It was ' + R.n;
        }
        feedback(now, bi, gained, msg);
      }
      function finishGame(now) {
        phase = 'end'; endAt = now + HC.END;
        endCard(wrap, 'Round ' + HC.ROUNDS + ' done', S.getScore()).style.top = '62%';
      }
      function earlyTap() {
        if (phase !== 'crowd' || locked) return;
        locked = true;
        var b = el('div', 'mg-headcount-center', arena);
        b.style.pointerEvents = 'none';
        el('div', 'mg-headcount-banner warn', b, 'Too early!');
      }

      S.onFrame = function (now) {
        if (!phaseAt) showIntro(now);
        var e = now - phaseAt;
        if (phase === 'end') {
          if (now >= endAt) S.finish(S.getScore());
          return;
        }
        if (phase === 'intro') {
          if (e >= HC.INTRO) showCrowd(now);
        } else if (phase === 'crowd') {
          timeFill.style.transform = 'scaleX(' + clamp(1 - e / HC.CROWD, 0, 1).toFixed(4) + ')';
          if (!reduced) {
            var R = rounds[ri], px = arena.clientWidth * R.d * 0.07, ts = e / 1000;
            for (var i = 0; i < faceEls.length; i++) {
              var f = R.faces[i];
              faceEls[i].style.transform = 'translate(' + (Math.cos(ts * f.sp * 0.7 + f.ph) * px).toFixed(2) + 'px,' + (Math.sin(ts * f.sp + f.ph) * px).toFixed(2) + 'px)';
            }
          }
          if (e >= HC.CROWD) showAnswer(now);
        } else if (phase === 'answer') {
          var lim = locked ? 600 : HC.ANSWER;
          timeFill.style.transform = 'scaleX(' + clamp(1 - e / lim, 0, 1).toFixed(4) + ')';
          if (e >= lim) {
            if (locked) {
              if (ri === HC.ROUNDS - 1) finishGame(now);
              else { ri++; showIntro(now); }
            } else {
              answered = true;
              feedback(now, -1, 0, "Time's up! It was " + rounds[ri].n);
            }
          }
        } else if (phase === 'feedback') {
          if (now >= fbUntil) { ri++; showIntro(now); }
        }
      };

      S.on(wrap, 'pointerdown', function (ev) { ev.preventDefault(); earlyTap(); });
      S.on(wrap, 'contextmenu', function (ev) { ev.preventDefault(); });
      S.on(window, 'keydown', function (ev) {
        if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        var n = '1234'.indexOf(ev.key);
        var isGo = ev.key === ' ' || ev.key === 'Enter';
        if (n < 0 && !isGo) return;
        ev.preventDefault();
        if (phase === 'crowd') { earlyTap(); return; }
        if (n >= 0) answer(n);
      });

      return S.start();
    }
  });
})();
