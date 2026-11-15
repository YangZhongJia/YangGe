/* ============================================================
   UI — renderer, human agent, audio, bootstrap.
   Depends on MJ (engine.js) and SCENE (scene.js).
   ============================================================ */
'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const stage = $('stage');

  // ---------- layout constants (plane-local coords, 1250x1250, local bottom = seat) ----------
  const C = SCENE.CENTER;              // 625
  const HAND_Y = 1086;                 // bottom edge of standing hand tiles
  const HAND_LEAN = -90;               // rotateX for standing tiles
  const DISC_ROWS = [778, 833, 888];   // discard row tops
  const DISC_W = 44, DISC_ROW_EXTRA = 925;
  const WALL_Y = 946;                  // wall stack top
  const MELD_Y = 1044;                 // meld row top
  const NAMES = ['你', '老王', '張姨', '小陳'];
  const WIND_ZH = ['東', '南', '西', '北'];

  // ---------- build scene ----------
  const room = SCENE.buildBackdrop();
  room.id = 'roomFill';
  $('viewport').insertBefore(room, stage);
  const table = SCENE.buildTable();
  stage.insertBefore(table, $('hud'));
  stage.insertBefore(SCENE.buildForeground(), $('hud'));

  // ---------- audio ----------
  const AU = (() => {
    let ctx = null, master = null;
    let muted = false;
    try { muted = localStorage.getItem('mj_muted') === '1'; } catch (e) {}
    function init() {
      if (ctx) return;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; }
    }
    function noiseBuf(dur) {
      const b = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return b;
    }
    function burst(t0, dur, freq, q, gain) {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf(dur);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + dur);
    }
    function tone(t0, freq, dur, gain, type) {
      const o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur);
    }
    const sounds = {
      draw()   { const t = ctx.currentTime; burst(t, 0.05, 2600, 1.2, 0.25); },
      discard(){ const t = ctx.currentTime; burst(t, 0.045, 2100, 1, 0.5); tone(t, 190, 0.07, 0.3, 'sine'); burst(t + 0.03, 0.06, 3200, 1.5, 0.3); },
      claim()  { const t = ctx.currentTime; burst(t, 0.07, 1600, 0.8, 0.65); tone(t, 150, 0.09, 0.4); },
      button() { const t = ctx.currentTime; burst(t, 0.03, 3600, 2, 0.2); },
      dice()   { const t = ctx.currentTime; for (let i = 0; i < 4; i++) burst(t + i * 0.09 + Math.random() * 0.02, 0.04, 2400 + i * 300, 1.4, 0.3); },
      win()    { const t = ctx.currentTime; [523, 659, 784, 880, 1047].forEach((f, i) => tone(t + i * 0.11, f, 0.5, 0.22, 'triangle')); },
      lose()   { const t = ctx.currentTime; [392, 330, 262].forEach((f, i) => tone(t + i * 0.14, f, 0.4, 0.18, 'triangle')); },
      shuffle(){
        const t = ctx.currentTime;
        for (let i = 0; i < 26; i++) burst(t + Math.random() * 1.3, 0.05, 1500 + Math.random() * 2400, 1, 0.16);
        const src = ctx.createBufferSource(); src.buffer = noiseBuf(1.5);
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.exponentialRampToValueAtTime(0.4, t + 0.25);
        g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
        src.connect(f); f.connect(g); g.connect(master);
        src.start(t); src.stop(t + 1.5);
      },
    };
    function play(name) {
      if (muted) return;
      init();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      try { sounds[name] && sounds[name](); } catch (e) {}
    }
    function speak(text, seat) {
      if (muted) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        const vs = speechSynthesis.getVoices().filter(v => /^zh/i.test(v.lang));
        if (!vs.length) return;
        u.voice = vs[0];
        u.rate = 1.05; u.pitch = [1.0, 0.82, 1.18, 0.95][seat] || 1; u.volume = 0.85;
        speechSynthesis.speak(u);
      } catch (e) {}
    }
    function toggle() {
      muted = !muted;
      try { localStorage.setItem('mj_muted', muted ? '1' : '0'); } catch (e) {}
      return muted;
    }
    return { play, speak, toggle, init, get muted() { return muted; } };
  })();

  // ---------- placement helpers ----------
  function placeStanding(parent, kind, x, yBottom, sizeClass, faceUp, extraClass) {
    const t = SCENE.tileBox(kind, sizeClass, faceUp);
    t.classList.add('stand');
    if (extraClass) t.classList.add(extraClass);
    const wEl = document.createElement('div'); // measure via CSS vars: read from class
    const dims = { 'sz-hand': [58, 80, 32], 'sz-opp': [46, 64, 26], 'sz-disc': [40, 55, 21], 'sz-wall': [44, 60, 23], 'sz-meld': [42, 58, 22] }[sizeClass];
    t.style.left = (x - dims[0] / 2) + 'px';
    t.style.top = (yBottom - dims[1]) + 'px';
    t.style.transformOrigin = '50% 100%';
    t.style.setProperty('--standT', `rotateX(${HAND_LEAN}deg)`);
    t.style.transform = 'var(--standT)';
    parent.appendChild(t);
    return t;
  }

  function placeFlat(parent, kind, x, yTop, sizeClass, faceUp, extraClass) {
    const dims = { 'sz-hand': [58, 80, 32], 'sz-opp': [46, 64, 26], 'sz-disc': [40, 55, 21], 'sz-wall': [44, 60, 23], 'sz-meld': [42, 58, 22] }[sizeClass];
    const wrap = document.createElement('div');
    wrap.className = 'slot ' + (faceUp ? 'lay-flat-up' : 'lay-flat-down');
    wrap.style.left = x + 'px';
    wrap.style.top = yTop + 'px';
    wrap.style.width = dims[0] + 'px';
    wrap.style.height = dims[1] + 'px';
    wrap.style.transform = `translateZ(${dims[2] / 2 + (arguments.length > 7 ? arguments[7] : 0)}px)`;
    const t = SCENE.tileBox(kind, sizeClass, faceUp);
    if (extraClass) t.classList.add(extraClass);
    wrap.appendChild(t);
    parent.appendChild(wrap);
    return wrap;
  }

  function placeFlatZ(parent, kind, x, yTop, sizeClass, faceUp, zLift, extraClass) {
    const dims = { 'sz-wall': [44, 60, 23] }[sizeClass] || [44, 60, 23];
    const wrap = document.createElement('div');
    wrap.className = 'slot ' + (faceUp ? 'lay-flat-up' : 'lay-flat-down');
    wrap.style.left = x + 'px';
    wrap.style.top = yTop + 'px';
    wrap.style.width = dims[0] + 'px';
    wrap.style.height = dims[1] + 'px';
    wrap.style.transform = `translateZ(${dims[2] / 2 + zLift}px)`;
    const t = SCENE.tileBox(kind, sizeClass, faceUp);
    if (extraClass) t.classList.add(extraClass);
    wrap.appendChild(t);
    parent.appendChild(wrap);
    return wrap;
  }

  // ---------- game state ----------
  let game = null;
  let running = false;
  let humanResolve = null;   // pending resolver for human decisions
  let humanReject = null;
  let wallFront = 0, wallBack = 0;   // consumed counts for wall rendering
  let raisedTile = null;
  let discardMode = false;
  let lastDiscardEl = null;
  let lastDeltas = [0, 0, 0, 0];

  const speedMs = ms => new Promise(r => setTimeout(r, ms));

  function msg(text, dur) {
    const m = $('msg');
    m.textContent = text;
    m.classList.add('show');
    clearTimeout(msg._t);
    if (dur !== 0) msg._t = setTimeout(() => m.classList.remove('show'), dur || 2400);
  }

  function shout(seat, text) {
    const el = document.createElement('div');
    el.className = 'shout';
    const pos = [
      { left: '50%', bottom: '300px', transform: 'translateX(-50%)' },
      { right: '190px', top: '44%' },
      { left: '50%', top: '190px', transform: 'translateX(-50%)' },
      { left: '190px', top: '44%' },
    ][seat];
    Object.assign(el.style, pos);
    el.textContent = text;
    $('hud').appendChild(el);
    setTimeout(() => el.remove(), 1150);
    AU.speak(text, seat);
  }

  // ---------- rendering ----------
  function seatZone(seat, zone) { return $(zone + seat); }

  function clearZones() {
    for (let s = 0; s < 4; s++) {
      for (const z of ['wall', 'discards', 'melds', 'flowers', 'hand']) {
        seatZone(s, z).innerHTML = '';
      }
    }
  }

  function renderWalls(animate) {
    // ring of 72 stacks (18/side), front consumes from dealer's side clockwise
    const startG = game.dealer * 18;
    const fcStacks = Math.floor(wallFront / 2), fcHalf = wallFront % 2;
    const bcStacks = Math.floor(wallBack / 2), bcHalf = wallBack % 2;
    for (let side = 0; side < 4; side++) {
      const zone = seatZone(side, 'wall');
      zone.innerHTML = '';
      for (let pos = 0; pos < 18; pos++) {
        const g = side * 18 + pos;
        const d = (g - startG + 72) % 72;
        const e = 71 - d;
        let tiles = 2;
        if (d < fcStacks) tiles = 0;
        else if (d === fcStacks && fcHalf) tiles = 1;
        if (tiles > 0) {
          if (e < bcStacks) tiles = 0;
          else if (e === bcStacks && bcHalf && tiles === 2) tiles = 1;
        }
        if (tiles === 0) continue;
        const x = C - (18 * 44) / 2 + pos * 44;
        for (let lvl = 0; lvl < tiles; lvl++) {
          const w = placeFlatZ(zone, null, x, WALL_Y, 'sz-wall', false, lvl * 23, animate ? 'popIn' : null);
          if (animate) {
            w.style.animation = `wallRise .5s ease-out ${(pos * 18 + side * 40)}ms backwards`;
          }
        }
      }
    }
  }

  function renderDiscards(seat) {
    const zone = seatZone(seat, 'discards');
    zone.innerHTML = '';
    const ds = game.players[seat].discards;
    ds.forEach((k, i) => {
      const row = Math.min(Math.floor(i / 8), 3);
      const col = i % 8 + (row === 3 ? Math.floor(i / 8) - 3 : 0) * 0;
      const y = row < 3 ? DISC_ROWS[row] : DISC_ROW_EXTRA;
      const x = C - (8 * DISC_W) / 2 + (row < 3 ? col : (i - 24) % 8) * DISC_W;
      const isLast = game.lastDiscard && game.lastDiscard.seat === seat && i === ds.length - 1;
      const el = placeFlat(zone, k, x, y, 'sz-disc', true, isLast ? 'lastDiscard' : null);
      if (isLast) lastDiscardEl = el;
    });
  }

  function renderMelds(seat) {
    const zone = seatZone(seat, 'melds');
    zone.innerHTML = '';
    const melds = game.players[seat].melds;
    let xRight = 1155 - 6;
    for (const m of melds) {
      const n = m.tiles.length;
      const w = n * 43 + 8;
      const x0 = xRight - w;
      m.tiles.forEach((k, i) => {
        const hidden = m.type === 'angang' && (i === 1 || i === 2);
        placeFlat(zone, hidden ? null : k, x0 + i * 43, MELD_Y, 'sz-meld', !hidden);
      });
      xRight = x0 - 10;
    }
    // flowers on the left
    const fzone = seatZone(seat, 'flowers');
    fzone.innerHTML = '';
    game.players[seat].flowers.forEach((k, i) => {
      placeFlat(fzone, k, 100 + i * 30, MELD_Y + 8, 'sz-disc', true);
    });
  }

  function renderOppHand(seat) {
    const zone = seatZone(seat, 'hand');
    zone.innerHTML = '';
    const n = game.players[seat].hand.length;
    const w = 48;
    const x0 = C - (n * w) / 2 + w / 2;
    for (let i = 0; i < n; i++) {
      placeStanding(zone, null, x0 + i * w, HAND_Y, 'sz-opp', false);
    }
  }

  function renderMyHand() {
    const zone = seatZone(0, 'hand');
    zone.innerHTML = '';
    const hand = game.players[0].hand.slice();
    // pull one copy of the drawn tile out to the right
    let drawn = null;
    if (game.drawnKind != null && game.turn === 0) {
      const idx = hand.indexOf(game.drawnKind);
      if (idx >= 0) { drawn = game.drawnKind; hand.splice(idx, 1); }
    }
    const n = hand.length + (drawn != null ? 1 : 0);
    const w = 61;
    const total = hand.length * w + (drawn != null ? w + 16 : 0);
    const x0 = C - total / 2 + w / 2;
    hand.forEach((k, i) => {
      const t = placeStanding(zone, k, x0 + i * w, HAND_Y, 'sz-hand', true, 'handTile');
      t.dataset.kind = k;
      attachHandEvents(t, k);
    });
    if (drawn != null) {
      const t = placeStanding(zone, drawn, x0 + hand.length * w + 16, HAND_Y, 'sz-hand', true, 'handTile');
      t.dataset.kind = drawn;
      t.classList.add('popIn');
      attachHandEvents(t, drawn);
    }
    updateHandEnabled();
  }

  function attachHandEvents(t, k) {
    t.addEventListener('click', () => {
      if (!discardMode) return;
      AU.play('button');
      if (raisedTile === t) {
        // confirm discard
        const resolve = humanResolve;
        humanResolve = null; humanReject = null;
        discardMode = false;
        raisedTile = null;
        hideActions();
        resolve && resolve(k);
      } else {
        if (raisedTile) raisedTile.classList.remove('raised');
        raisedTile = t;
        t.classList.add('raised');
      }
    });
  }

  function updateHandEnabled() {
    const zone = seatZone(0, 'hand');
    zone.querySelectorAll('.handTile').forEach(t => {
      t.classList.toggle('disabled', !discardMode);
    });
  }

  function renderPlates() {
    for (let s = 0; s < 4; s++) {
      const windI = game.seatWind(s);
      const w = $('wind' + s);
      w.textContent = WIND_ZH[windI];
      w.classList.toggle('dealer', s === game.dealer);
      $('score' + s).textContent = game.scores[s];
      const d = $('delta' + s);
      if (lastDeltas[s]) {
        d.textContent = (lastDeltas[s] > 0 ? '+' : '') + lastDeltas[s];
        d.className = 'pdelta ' + (lastDeltas[s] > 0 ? 'up' : 'down');
      } else { d.textContent = ''; }
      $('plate' + s).classList.toggle('active', running && game.turn === s && !game.result);
      $('led' + s).classList.toggle('on', running && game.turn === s && !game.result);
    }
    const roundZh = WIND_ZH[Math.min(game.roundWind, 3)];
    const numZh = ['一', '二', '三', '四'][game.handNumber - 1] || '一';
    $('roundLabel').textContent = `${roundZh}風局 · 第${numZh}局`;
    $('dispWind').textContent = roundZh;
    $('dispCount').textContent = String(game.wall ? game.wall.length : 0).padStart(2, '0');
  }

  function renderAll() {
    if (!game || !game.players) return;
    renderMyHand();
    for (let s = 1; s < 4; s++) renderOppHand(s);
    for (let s = 0; s < 4; s++) { renderDiscards(s); renderMelds(s); }
    renderWalls(false);
    renderPlates();
  }

  async function diceRoll() {
    AU.play('dice');
    const d1 = $('die1'), d2 = $('die2');
    for (let i = 0; i < 7; i++) {
      d1.innerHTML = SCENE.dieFace(1 + Math.floor(Math.random() * 6));
      d2.innerHTML = SCENE.dieFace(1 + Math.floor(Math.random() * 6));
      await speedMs(75);
    }
  }

  // ---------- action buttons ----------
  function showActions(buttons) {
    const bar = $('actions');
    bar.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'abtn ' + (b.cls || '');
      el.innerHTML = b.zh;
      el.addEventListener('click', () => { AU.play('button'); b.fn(); });
      bar.appendChild(el);
    }
  }
  function hideActions() { $('actions').innerHTML = ''; $('chiPick').style.display = 'none'; }

  function showChiPicker(chis, tile, done) {
    const cp = $('chiPick');
    cp.innerHTML = '';
    cp.style.display = 'flex';
    for (const chi of chis) {
      const opt = document.createElement('div');
      opt.className = 'chiOpt';
      const kinds = [chi[0], chi[1], tile].sort((a, b) => a - b);
      for (const k of kinds) {
        const c = SCENE.tileChip(k, k === tile ? 'win' : '');
        opt.appendChild(c);
      }
      opt.addEventListener('click', () => { AU.play('button'); done(chi); });
      cp.appendChild(opt);
    }
  }

  // ---------- human agent ----------
  function humanWait() {
    return new Promise((resolve, reject) => { humanResolve = resolve; humanReject = reject; });
  }

  const humanAgent = {
    async chooseDiscard(g, seat) {
      renderMyHand();
      renderPlates();
      discardMode = true;
      updateHandEnabled();
      msg('轮到你 · 点击麻将两次打出', 3200);
      const k = await humanWait();
      return k;
    },
    async decideSelf(g, seat, o) {
      renderMyHand();
      const p = humanWait();
      const btns = [];
      if (o.zimo) btns.push({ zh: '胡', en: 'WIN', cls: 'hu', fn: () => finish({ type: 'zimo' }) });
      for (const k of o.angangs) btns.push({ zh: '暗杠', en: MJ.TILE_NAMES_ZH[k], fn: () => finish({ type: 'angang', kind: k }) });
      for (const k of o.jiagangs) btns.push({ zh: '加杠', en: MJ.TILE_NAMES_ZH[k], fn: () => finish({ type: 'jiagang', kind: k }) });
      btns.push({ zh: '过', en: 'PASS', cls: 'pass', fn: () => finish({ type: 'pass' }) });
      function finish(a) {
        hideActions();
        const r = humanResolve; humanResolve = null; humanReject = null;
        r && r(a);
      }
      showActions(btns);
      return p;
    },
    async decideClaim(g, seat, tile, o) {
      const p = humanWait();
      const btns = [];
      if (o.hu) btns.push({ zh: '胡', en: 'WIN', cls: 'hu', fn: () => finish({ type: 'hu' }) });
      if (o.gang) btns.push({ zh: '杠', en: 'KONG', fn: () => finish({ type: 'gang' }) });
      if (o.peng) btns.push({ zh: '碰', en: 'PUNG', fn: () => finish({ type: 'peng' }) });
      if (o.chis && o.chis.length) btns.push({
        zh: '吃', en: 'CHOW', fn: () => {
          if (o.chis.length === 1) finish({ type: 'chi', chi: o.chis[0] });
          else showChiPicker(o.chis, tile, chi => finish({ type: 'chi', chi }));
        }
      });
      btns.push({ zh: '过', en: 'PASS', cls: 'pass', fn: () => finish({ type: 'pass' }) });
      function finish(a) {
        hideActions();
        const r = humanResolve; humanResolve = null; humanReject = null;
        r && r(a);
      }
      showActions(btns);
      msg(`${NAMES[g.lastDiscard ? g.lastDiscard.seat : 0]} 打出 ${MJ.TILE_NAMES_ZH[tile]}`, 0);
      const a = await p;
      $('msg').classList.remove('show');
      return a;
    },
  };

  // ---------- event listener from engine ----------
  function onEvent(ev) {
    switch (ev.type) {
      case 'handStart': {
        wallFront = 0; wallBack = 0;
        lastDiscardEl = null;
        clearZones();
        renderPlates();
        AU.play('shuffle');
        diceRoll();
        renderWalls(true);
        msg(`${NAMES[game.dealer]} ${game.dealer === 0 ? '' : ''}做庄 · dealer`, 2600);
        break;
      }
      case 'deal': {
        wallFront += 53; // 13*4+1
        renderAll();
        break;
      }
      case 'flower': {
        wallBack += 1;
        if (game.players) { renderMelds(ev.seat); renderPlates(); }
        if (ev.seat === 0) msg(`补花 ${MJ.TILE_NAMES_ZH[ev.kind]}`, 1600);
        break;
      }
      case 'draw': {
        if (ev.replacement) wallBack += 1; else wallFront += 1;
        AU.play('draw');
        if (ev.seat === 0) renderMyHand(); else renderOppHand(ev.seat);
        renderWalls(false);
        renderPlates();
        break;
      }
      case 'discard': {
        AU.play('discard');
        if (ev.seat === 0) renderMyHand(); else renderOppHand(ev.seat);
        renderDiscards(ev.seat);
        renderPlates();
        break;
      }
      case 'meld': {
        AU.play('claim');
        const t = ev.meld.type;
        const zh = t === 'chi' ? '吃' : t === 'peng' ? '碰' : '杠';
        shout(ev.seat, zh);
        renderAll();
        break;
      }
      case 'win': {
        lastDeltas = ev.delta.slice();
        shout(ev.seat, ev.zimo ? '自摸' : '胡');
        AU.play(ev.seat === 0 ? 'win' : 'lose');
        renderAll();
        break;
      }
      case 'drawGame': {
        msg('流局 · 牌墙已空，无人胡牌', 4000);
        break;
      }
    }
  }

  // ---------- result overlay ----------
  function chipRow(kinds, winKind) {
    let html = '';
    let winMarked = false;
    for (const k of kinds) {
      const mark = !winMarked && winKind != null && k === winKind;
      if (mark) winMarked = true;
      html += `<div class="chip${mark ? ' win' : ''}">${SCENE.glyphSVG(k)}</div>`;
    }
    return html;
  }

  function showResult() {
    const r = game.result;
    const card = $('resultCard');
    if (!r || r.type === 'draw') {
      card.innerHTML = `<h2>流局</h2><p>牌墙已空，本局无人胡牌，庄家继续。</p>
        <button class="bigbtn" id="btnNext">继续</button>`;
    } else {
      const name = NAMES[r.seat];
      const how = r.zimo ? '自摸' : `胡 ${NAMES[r.fromSeat]} 的 ${MJ.TILE_NAMES_ZH[r.kind]}`;
      let meldHtml = '';
      for (const m of r.melds) {
        meldHtml += `<span class="gap"></span>` + chipRow(m.tiles);
      }
      let flowerHtml = r.flowers.length ? `<span class="gap"></span>` + r.flowers.map(k => `<div class="chip small">${SCENE.glyphSVG(k)}</div>`).join('') : '';
      // concealed part = hand minus meld tiles? r.hand already is concealed+winKind
      const rows = r.fan.items.map(it =>
        `<tr><td>${it.zh}</td><td>${it.fan} 番</td></tr>`).join('');
      const scoreHtml = [0, 1, 2, 3].map(s => `
        <div class="sc"><div class="nm">${NAMES[s]}</div><div class="vl">${game.scores[s]}</div>
        <div class="dl ${r.delta[s] > 0 ? 'up' : r.delta[s] < 0 ? 'down' : ''}">${r.delta[s] ? (r.delta[s] > 0 ? '+' : '') + r.delta[s] : ''}</div></div>`).join('');
      card.innerHTML = `
        <h2>${name} ${r.zimo ? '自摸' : '胡了'}！</h2>
        <p class="sub">${how}</p>
        <div class="winRow">${chipRow(r.hand, r.kind)}${meldHtml}${flowerHtml}</div>
        <table class="fanTable">${rows}</table>
        <div class="fanTotal">共 <b>${r.fan.total}</b> 番 → ${r.value} 分${r.zimo ? ' × 3家' : ''}</div>
        <div class="scoreRow">${scoreHtml}</div>
        <button class="bigbtn" id="btnNext">继续</button>`;
    }
    $('result').classList.add('show');
    $('btnNext').addEventListener('click', () => {
      AU.play('button');
      $('result').classList.remove('show');
      resumeNext && resumeNext();
    });
  }

  function showFinal() {
    const card = $('resultCard');
    const order = [0, 1, 2, 3].sort((a, b) => game.scores[b] - game.scores[a]);
    const rows = order.map((s, i) =>
      `<tr><td>${['🥇', '🥈', '🥉', ''][i]} ${NAMES[s]}</td><td></td><td>${game.scores[s]} 分</td></tr>`).join('');
    card.innerHTML = `<h2>散场</h2>
      <p class="sub">四圈结束，最终得分：</p>
      <table class="fanTable">${rows}</table>
      <button class="bigbtn" id="btnAgain">再来一局</button>`;
    $('result').classList.add('show');
    $('btnAgain').addEventListener('click', () => {
      $('result').classList.remove('show');
      startMatch();
    });
  }

  let resumeNext = null;
  function waitContinue() { return new Promise(r => { resumeNext = r; }); }

  // ---------- match loop ----------
  async function startMatch() {
    if (game) { game.aborted = true; }
    if (humanReject) { const rj = humanReject; humanResolve = null; humanReject = null; try { rj(new Error('aborted')); } catch (e) {} }
    lastDeltas = [0, 0, 0, 0];
    const agents = [humanAgent, MJ.makeAI({ thinkMs: 520 }), MJ.makeAI({ thinkMs: 560 }), MJ.makeAI({ thinkMs: 480 })];
    game = new MJ.Game({
      seed: (Math.random() * 0xffffffff) >>> 0,
      agents,
      delayFn: speedMs,
      listener: onEvent,
      roundLimit: 4,
    });
    running = true;
    try {
      while (!game.finished && !game.aborted) {
        await game.playHand();
        renderAll();
        await speedMs(700);
        showResult();
        await waitContinue();
        lastDeltas = [0, 0, 0, 0];
        game.advanceHand();
      }
      if (!game.aborted) showFinal();
    } catch (e) {
      if (String(e.message) !== 'aborted') { console.error(e); msg('出错了：' + e.message, 6000); }
    }
    running = false;
  }

  // ---------- controls ----------
  $('btnStart').addEventListener('click', () => {
    AU.init(); AU.play('button');
    try { speechSynthesis.getVoices(); } catch (e) {}
    $('intro').classList.remove('show');
    startMatch();
  });
  $('btnHelp').addEventListener('click', () => { AU.play('button'); $('help').classList.add('show'); });
  $('btnCloseHelp').addEventListener('click', () => { AU.play('button'); $('help').classList.remove('show'); });
  $('btnSound').addEventListener('click', function () {
    const m = AU.toggle();
    this.textContent = m ? '♪̸' : '♪';
    this.style.opacity = m ? 0.5 : 1;
  });
  if (AU.muted) { $('btnSound').textContent = '♪̸'; $('btnSound').style.opacity = 0.5; }
  $('dispBtn').addEventListener('click', () => {
    AU.play('button');
    if ($('intro').classList.contains('show')) { $('btnStart').click(); return; }
    if ($('result').classList.contains('show')) { const b = $('btnNext') || $('btnAgain'); b && b.click(); }
  });

  // ---------- responsive scaling ----------
  function rescale() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const sc = Math.min(vw / 1600, vh / 1000);
    stage.style.transform = `translate(-50%, -50%) scale(${sc})`;
  }
  window.addEventListener('resize', rescale);
  rescale();

  // initial: build an idle table (empty, walls up for looks)
  (function idleScene() {
    game = new MJ.Game({ seed: 7, agents: [], listener: () => {}, delayFn: speedMs });
    game.initHand();
    wallFront = 0; wallBack = 0;
    renderWalls(false);
    renderPlates();
    $('die1').innerHTML = SCENE.dieFace(2);
    $('die2').innerHTML = SCENE.dieFace(5);
    $('dispBtn').classList.add('pulse');
  })();
})();
