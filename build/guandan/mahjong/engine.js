/* ============================================================
   Mahjong engine — Chinese 4-player rules, 144 tiles (with flowers)
   Pure logic, no DOM. Exposes global MJ (browser) / module.exports (node).
   Tile kinds 0..33: 0-8 万(wan) 1-9, 9-17 筒(tong) 1-9, 18-26 条(tiao) 1-9,
   27-30 winds 東南西北, 31-33 dragons 中發白. Flowers 34..41 (春夏秋冬梅蘭竹菊).
   ============================================================ */
(function (root) {
  'use strict';

  const WAN = 0, TONG = 9, TIAO = 18, WIND = 27, DRAGON = 31, FLOWER = 34;
  const WINDS = ['E', 'S', 'W', 'N'];

  function isSuit(k) { return k >= 0 && k < 27; }
  function isHonor(k) { return k >= 27 && k < 34; }
  function isFlower(k) { return k >= 34 && k < 42; }
  function suitOf(k) { return isSuit(k) ? Math.floor(k / 9) : -1; }
  function numOf(k) { return isSuit(k) ? (k % 9) + 1 : 0; }
  function isTerminal(k) { return isSuit(k) && (k % 9 === 0 || k % 9 === 8); }

  // ---------- RNG (seedable, for reproducible tests) ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildWall(rng) {
    const wall = [];
    for (let k = 0; k < 34; k++) for (let i = 0; i < 4; i++) wall.push(k);
    for (let k = 34; k < 42; k++) wall.push(k);
    for (let i = wall.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [wall[i], wall[j]] = [wall[j], wall[i]];
    }
    return wall;
  }

  function countsOf(hand) {
    const c = new Array(34).fill(0);
    for (const k of hand) c[k]++;
    return c;
  }

  // ---------- Win detection ----------
  function canMeldAll(c, i) {
    while (i < 34 && c[i] === 0) i++;
    if (i >= 34) return true;
    if (c[i] >= 3) {
      c[i] -= 3;
      if (canMeldAll(c, i)) { c[i] += 3; return true; }
      c[i] += 3;
    }
    if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      if (canMeldAll(c, i)) { c[i]++; c[i + 1]++; c[i + 2]++; return true; }
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
    return false;
  }

  // hand: concealed tiles only (must be 3n+2 total with melds filling the rest)
  function canWinStandard(hand) {
    if (hand.length % 3 !== 2) return false;
    const c = countsOf(hand);
    for (let p = 0; p < 34; p++) {
      if (c[p] >= 2) {
        c[p] -= 2;
        if (canMeldAll(c, 0)) { c[p] += 2; return true; }
        c[p] += 2;
      }
    }
    return false;
  }

  function isSevenPairs(hand) {
    if (hand.length !== 14) return false;
    const c = countsOf(hand);
    let pairs = 0;
    for (let k = 0; k < 34; k++) {
      if (c[k] % 2 !== 0) return false;
      pairs += c[k] / 2;
    }
    return pairs === 7;
  }

  const ORPHANS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  function isThirteenOrphans(hand) {
    if (hand.length !== 14) return false;
    const c = countsOf(hand);
    let hasPair = false;
    for (const k of ORPHANS) {
      if (c[k] === 0) return false;
      if (c[k] >= 2) hasPair = true;
    }
    let total = 0;
    for (const k of ORPHANS) total += c[k];
    return total === 14 && hasPair;
  }

  function isWinningHand(hand) {
    return canWinStandard(hand) || isSevenPairs(hand) || isThirteenOrphans(hand);
  }

  // ---------- Shanten ----------
  // concealed counts + number of fixed (claimed) melds. -1 = complete.
  function shantenStandard(c, fixedMelds) {
    const need = 4 - fixedMelds;
    let best = 8;
    function evalNode(melds, partials, pair) {
      let m = Math.min(melds, need);
      let p = partials;
      if (m + p > need) p = need - m;
      const sh = (need - m) * 2 - p - (pair ? 1 : 0);
      if (sh < best) best = sh;
    }
    function run(i, melds, partials, pair) {
      evalNode(melds, partials, pair);
      if (best === -1) return;
      while (i < 34 && c[i] === 0) i++;
      if (i >= 34) return;
      // upper-bound prune: every remaining tile could at best join a meld
      if (melds + partials >= need + 1 && pair) { /* nothing more helps */ }
      if (c[i] >= 3) {
        c[i] -= 3; run(i, melds + 1, partials, pair); c[i] += 3;
      }
      if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
        c[i]--; c[i + 1]--; c[i + 2]--;
        run(i, melds + 1, partials, pair);
        c[i]++; c[i + 1]++; c[i + 2]++;
      }
      if (melds + partials < need || !pair) {
        if (c[i] >= 2) {
          c[i] -= 2;
          if (!pair) run(i, melds, partials, true);
          run(i, melds, partials + 1, pair);
          c[i] += 2;
        }
        if (i < 27 && i % 9 <= 7 && c[i + 1] > 0) {
          c[i]--; c[i + 1]--; run(i, melds, partials + 1, pair); c[i]++; c[i + 1]++;
        }
        if (i < 27 && i % 9 <= 6 && c[i + 2] > 0) {
          c[i]--; c[i + 2]--; run(i, melds, partials + 1, pair); c[i]++; c[i + 2]++;
        }
      }
      // skip: leave remaining copies of kind i as floaters
      const saved = c[i]; c[i] = 0;
      run(i + 1, melds, partials, pair);
      c[i] = saved;
    }
    run(0, 0, 0, false);
    return best;
  }

  function shantenSevenPairs(c, fixedMelds) {
    if (fixedMelds > 0) return 99; // melds break qidui
    let pairs = 0, kinds = 0;
    for (let k = 0; k < 34; k++) {
      if (c[k] > 0) kinds++;
      if (c[k] >= 2) pairs++;
    }
    let sh = 6 - pairs;
    if (kinds < 7) sh += (7 - kinds);
    return sh;
  }

  function shantenOrphans(c, fixedMelds) {
    if (fixedMelds > 0) return 99;
    let kinds = 0, hasPair = false;
    for (const k of ORPHANS) {
      if (c[k] > 0) kinds++;
      if (c[k] >= 2) hasPair = true;
    }
    return 13 - kinds - (hasPair ? 1 : 0);
  }

  function shanten(hand, fixedMelds) {
    const c = countsOf(hand);
    let sh = shantenStandard(c, fixedMelds);
    const s7 = shantenSevenPairs(c, fixedMelds);
    if (s7 < sh) sh = s7;
    const s13 = shantenOrphans(c, fixedMelds);
    if (s13 < sh) sh = s13;
    return sh;
  }

  // kinds worth testing as draws for ukeire (near tiles in hand)
  function relevantKinds(hand) {
    const rel = new Set();
    for (const k of hand) {
      if (isSuit(k)) {
        const n = k % 9, s = k - n;
        for (let d = -2; d <= 2; d++) {
          const nn = n + d;
          if (nn >= 0 && nn <= 8) rel.add(s + nn);
        }
      } else rel.add(k);
    }
    return [...rel];
  }

  // number of distinct useful draw kinds weighted by copies left
  function ukeire(hand, fixedMelds, seenCounts) {
    const base = shanten(hand, fixedMelds);
    let count = 0;
    const c = countsOf(hand);
    for (const k of relevantKinds(hand)) {
      const left = 4 - c[k] - (seenCounts ? (seenCounts[k] || 0) : 0);
      if (left <= 0) continue;
      hand.push(k);
      if (shanten(hand, fixedMelds) < base) count += left;
      hand.pop();
    }
    return count;
  }

  // ---------- Fan scoring ----------
  const FAN_NAMES = {
    win: ['底分', 'Base', 1],
  };

  // ctx: { zimo, gangKai, haidi, qiangGang, tianHu, menqing }
  function computeFan(hand14, melds, flowers, seat, dealerSeat, roundWind, winKind, ctx) {
    const items = [];
    const add = (zh, en, v) => items.push({ zh, en, fan: v });

    add('底', 'Base', 1);

    const c = countsOf(hand14);
    const allTiles = hand14.slice();
    for (const m of melds) for (const t of m.tiles) allTiles.push(t);

    const qidui = isSevenPairs(hand14) && melds.length === 0;
    const orphans = isThirteenOrphans(hand14) && melds.length === 0;

    // suits present
    let suits = new Set(), hasHonor = false;
    for (const t of allTiles) {
      if (isFlower(t)) continue;
      if (isSuit(t)) suits.add(suitOf(t)); else hasHonor = true;
    }

    if (orphans) {
      add('十三幺', 'Thirteen Orphans', 13);
    } else if (qidui) {
      add('七对', 'Seven Pairs', 4);
    }

    // all pungs: every meld is pung/kong AND concealed part decomposes into triplets+pair
    if (!qidui && !orphans) {
      const meldOk = melds.every(m => m.type !== 'chi');
      if (meldOk && decomposesAllTriplets(c)) add('碰碰胡', 'All Pungs', 2);
    }

    if (suits.size === 1 && !hasHonor) add('清一色', 'Full Flush', 4);
    else if (suits.size === 1 && hasHonor) add('混一色', 'Half Flush', 2);
    else if (suits.size === 0 && hasHonor && !orphans) add('字一色', 'All Honors', 8);

    // dragons / winds pungs (in melds or concealed triplets)
    // a seven-pairs hand has no pungs — a concealed quad there is two pairs
    const pungKind = k => {
      if (qidui || orphans) return false;
      if (c[k] >= 3) return true;
      return melds.some(m => m.type !== 'chi' && m.tiles[0] === k);
    };
    let dragonPungs = 0, dragonPair = false;
    for (let k = 31; k <= 33; k++) {
      if (pungKind(k)) dragonPungs++;
      else if (c[k] === 2) dragonPair = true;
    }
    if (dragonPungs === 3) add('大三元', 'Big Three Dragons', 8);
    else if (dragonPungs === 2 && dragonPair) add('小三元', 'Little Three Dragons', 4);
    else if (dragonPungs > 0) add('箭刻', 'Dragon Pung', dragonPungs);

    const seatWind = 27 + ((seat - dealerSeat + 4) % 4);
    const roundWindKind = 27 + roundWind;
    if (pungKind(seatWind)) add('门风刻', 'Seat Wind Pung', 1);
    if (pungKind(roundWindKind)) add('圈风刻', 'Round Wind Pung', 1);

    // no terminals/honors
    if (!orphans && !qidui) {
      const noTerm = allTiles.every(t => isFlower(t) ? true : (isSuit(t) && !isTerminal(t)));
      if (noTerm) add('断幺九', 'All Simples', 1);
    }

    // kongs
    let gangFan = 0;
    for (const m of melds) {
      if (m.type === 'angang') gangFan += 2;
      else if (m.type === 'gang' || m.type === 'jiagang') gangFan += 1;
    }
    if (gangFan) add('杠', 'Kongs', gangFan);

    if (ctx.menqing) add('门清', 'Concealed Hand', 1);
    if (ctx.zimo) add('自摸', 'Self-Draw', 1);
    if (ctx.gangKai) add('杠上开花', 'Kong Bloom', 2);
    if (ctx.haidi) add(ctx.zimo ? '海底捞月' : '河底捞鱼', 'Last Tile', 1);
    if (ctx.qiangGang) add('抢杠', 'Robbing the Kong', 2);
    if (ctx.tianHu) add('天胡', 'Heavenly Hand', 8);
    if (flowers.length) add('花牌', 'Flowers', flowers.length);

    let total = 0;
    for (const it of items) total += it.fan;
    return { items, total };
  }

  function decomposesAllTriplets(c) {
    // concealed tiles must be triplets + exactly one pair
    let pair = 0;
    for (let k = 0; k < 34; k++) {
      if (c[k] === 0) continue;
      if (c[k] === 2) pair++;
      else if (c[k] === 3) continue;
      else if (c[k] === 4) return false; // 4 concealed of a kind can't be pung+single in a win
      else return false;
    }
    return pair === 1;
  }

  function fanValue(totalFan) {
    return Math.pow(2, Math.min(totalFan, 8));
  }

  // ---------- Game ----------
  const TILE_NAMES_ZH = (() => {
    const n = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const out = {};
    for (let i = 0; i < 9; i++) { out[WAN + i] = n[i] + '万'; out[TONG + i] = n[i] + '筒'; out[TIAO + i] = n[i] + '条'; }
    ['东', '南', '西', '北'].forEach((w, i) => out[WIND + i] = w + '风');
    out[31] = '红中'; out[32] = '发财'; out[33] = '白板';
    ['春', '夏', '秋', '冬', '梅', '兰', '竹', '菊'].forEach((f, i) => out[FLOWER + i] = f);
    return out;
  })();

  class Game {
    /**
     * opts: { seed, agents: [4 x agent], delayFn(ms), listener(event), roundLimit }
     * agent: {
     *   chooseDiscard(game, seat) -> Promise<kind>          (hand has 3n+2)
     *   decideSelf(game, seat, options) -> Promise<action>  (options: {zimo, angangs[], jiagangs[]}) -> {type:'zimo'|'angang'|'jiagang'|'pass', kind}
     *   decideClaim(game, seat, tile, options) -> Promise<action> (options: {hu, peng, gang, chis[][]}) -> {type:'hu'|'peng'|'gang'|'chi'|'pass', chi:[k1,k2]}
     * }
     */
    constructor(opts) {
      this.rng = mulberry32(opts.seed != null ? opts.seed : ((Math.floor(Date.now ? Date.now() : 0) ^ 0x9e3779b9) >>> 0));
      this.agents = opts.agents;
      this.delayFn = opts.delayFn || (() => Promise.resolve());
      this.listener = opts.listener || (() => {});
      this.scores = [0, 0, 0, 0];
      this.dealer = 0;
      this.roundWind = 0;      // 0=E 1=S 2=W 3=N
      this.handNumber = 1;     // 1-based within round
      this.roundLimit = opts.roundLimit != null ? opts.roundLimit : 4; // rounds (E,S,W,N)
      this.dealerRepeats = 0;
      this.finished = false;
      this.aborted = false;
    }

    emit(type, data) { this.listener({ type, ...(data || {}) }); }

    seatWind(seat) { return (seat - this.dealer + 4) % 4; }

    async delay(ms) { if (this.aborted) throw new Error('aborted'); return this.delayFn(ms); }

    // ----- hand lifecycle -----
    initHand() {
      this.wall = buildWall(this.rng);
      this.players = [];
      for (let s = 0; s < 4; s++) {
        this.players.push({ hand: [], melds: [], flowers: [], discards: [] });
      }
      this.turn = this.dealer;
      this.lastDiscard = null;       // { seat, kind }
      this.pendingKongSeat = -1;
      this.anyDiscardYet = false;
      this.seenCounts = new Array(34).fill(0); // discards + exposed melds, for AI
      this.result = null;
      this.drawnKind = null;         // most recently drawn tile of current player
      this.justKonged = false;       // next draw is a replacement
    }

    drawFront(seat) {
      if (this.wall.length === 0) return null;
      return this.wall.shift();
    }
    drawBack(seat) {
      if (this.wall.length === 0) return null;
      return this.wall.pop();
    }

    sortHand(seat) { this.players[seat].hand.sort((a, b) => a - b); }

    // draw with flower auto-replacement (from back). Returns kind or null (wall empty)
    takeTile(seat, fromBack) {
      let k = fromBack ? this.drawBack(seat) : this.drawFront(seat);
      while (k != null && isFlower(k)) {
        this.players[seat].flowers.push(k);
        this.emit('flower', { seat, kind: k });
        k = this.drawBack(seat);
      }
      return k;
    }

    async dealAll() {
      this.emit('handStart', {
        dealer: this.dealer, roundWind: this.roundWind,
        handNumber: this.handNumber, wallSize: this.wall.length,
      });
      await this.delay(300);
      // deal 13 each, in 4s then 1 (traditional), flowers replaced after
      for (let block = 0; block < 3; block++) {
        for (let i = 0; i < 4; i++) {
          const s = (this.dealer + i) % 4;
          for (let j = 0; j < 4; j++) this.players[s].hand.push(this.drawFront(s));
        }
      }
      for (let i = 0; i < 4; i++) {
        const s = (this.dealer + i) % 4;
        this.players[s].hand.push(this.drawFront(s));
      }
      // replace flowers, dealer first, loop until clean
      let replaced = true;
      while (replaced) {
        replaced = false;
        for (let i = 0; i < 4; i++) {
          const s = (this.dealer + i) % 4;
          const p = this.players[s];
          for (let j = p.hand.length - 1; j >= 0; j--) {
            if (isFlower(p.hand[j])) {
              const f = p.hand.splice(j, 1)[0];
              p.flowers.push(f);
              this.emit('flower', { seat: s, kind: f });
              const nk = this.drawBack(s);
              if (nk != null) { p.hand.push(nk); replaced = true; }
            }
          }
        }
      }
      for (let s = 0; s < 4; s++) this.sortHand(s);
      this.emit('deal', {});
      await this.delay(200);
    }

    exposedMeldTiles(seat) {
      const out = [];
      for (const m of this.players[seat].melds) for (const t of m.tiles) out.push(t);
      return out;
    }

    // options available to the player holding 3n+2 tiles (just drew / just claimed kong replacement)
    selfOptions(seat, isReplacement, isFirstTurn) {
      const p = this.players[seat];
      const opt = { zimo: false, angangs: [], jiagangs: [], isReplacement, isFirstTurn };
      if (isWinningHand(p.hand)) opt.zimo = true;
      // kongs need a live wall to draw the replacement from
      if (this.wall.length > 0) {
        const c = countsOf(p.hand);
        for (let k = 0; k < 34; k++) if (c[k] === 4) opt.angangs.push(k);
        for (const m of p.melds) {
          if (m.type === 'peng' && c[m.tiles[0]] >= 1) opt.jiagangs.push(m.tiles[0]);
        }
      }
      return opt;
    }

    claimOptions(seat, tile) {
      const p = this.players[seat];
      const c = countsOf(p.hand);
      const opt = { hu: false, peng: false, gang: false, chis: [] };
      const withTile = p.hand.concat([tile]);
      if (isWinningHand(withTile)) opt.hu = true;
      if (c[tile] >= 2) opt.peng = true;
      if (c[tile] >= 3 && this.wall.length > 0) opt.gang = true;
      // chi only from left neighbor
      if (this.lastDiscard && (this.lastDiscard.seat + 1) % 4 === seat && isSuit(tile)) {
        const n = tile % 9, s = tile - n;
        const has = k => k >= s && k <= s + 8 && c[k] > 0;
        if (n >= 2 && has(tile - 2) && has(tile - 1)) opt.chis.push([tile - 2, tile - 1]);
        if (n >= 1 && n <= 7 && has(tile - 1) && has(tile + 1)) opt.chis.push([tile - 1, tile + 1]);
        if (n <= 6 && has(tile + 1) && has(tile + 2)) opt.chis.push([tile + 1, tile + 2]);
      }
      return opt;
    }

    removeFromHand(seat, kind, n) {
      const h = this.players[seat].hand;
      let removed = 0;
      for (let i = h.length - 1; i >= 0 && removed < n; i--) {
        if (h[i] === kind) { h.splice(i, 1); removed++; }
      }
      if (removed < n) throw new Error(`removeFromHand: missing ${kind}`);
    }

    // ----- win / payment -----
    settleWin(winSeat, winKind, ctx) {
      const p = this.players[winSeat];
      const hand14 = p.hand.slice();
      if (!ctx.zimo) hand14.push(winKind);
      hand14.sort((a, b) => a - b);
      const menqing = p.melds.every(m => m.type === 'angang');
      const fan = computeFan(hand14, p.melds, p.flowers, winSeat, this.dealer, this.roundWind, winKind, { ...ctx, menqing });
      const value = fanValue(fan.total);
      const delta = [0, 0, 0, 0];
      if (ctx.zimo) {
        for (let s = 0; s < 4; s++) if (s !== winSeat) { delta[s] -= value; delta[winSeat] += value; }
      } else {
        delta[ctx.fromSeat] -= value;
        delta[winSeat] += value;
      }
      for (let s = 0; s < 4; s++) this.scores[s] += delta[s];
      this.result = {
        type: 'win', seat: winSeat, kind: winKind, zimo: !!ctx.zimo, fromSeat: ctx.fromSeat,
        hand: hand14, melds: p.melds.slice(), flowers: p.flowers.slice(),
        fan, value, delta,
      };
      this.emit('win', this.result);
    }

    settleDraw() {
      this.result = { type: 'draw' };
      this.emit('drawGame', {});
    }

    advanceHand() {
      // dealer repeats if dealer won or draw; else pass dealership
      const r = this.result;
      const dealerWon = r && r.type === 'win' && r.seat === this.dealer;
      const wasDraw = !r || r.type === 'draw';
      if (dealerWon || wasDraw) {
        this.dealerRepeats++;
      } else {
        this.dealer = (this.dealer + 1) % 4;
        this.handNumber++;
        this.dealerRepeats = 0;
        if (this.handNumber > 4) {
          this.handNumber = 1;
          this.roundWind++;
          if (this.roundWind >= this.roundLimit) {
            this.finished = true;
          }
        }
      }
    }

    // ----- main loop for one hand -----
    async playHand() {
      this.initHand();
      await this.dealAll();

      let firstTurn = true;
      let isReplacement = false;

      while (true) {
        const seat = this.turn;
        const p = this.players[seat];

        // draw unless the player just claimed chi/peng (hand already 3n+2)
        const mod = p.hand.length % 3;
        if (mod === 0) throw new Error('bad hand size');
        const needsDraw = mod === 1;

        if (needsDraw) {
          const k = this.takeTile(seat, isReplacement);
          if (k == null) { this.settleDraw(); return; }
          p.hand.push(k);
          this.drawnKind = k;
          this.emit('draw', { seat, kind: k, wallSize: this.wall.length, replacement: isReplacement });
          await this.delay(150);
        } else {
          this.drawnKind = null;
        }

        // self actions (zimo / kongs) — only after an actual draw (or the dealer's
        // dealt 14th on the very first turn); never right after a chi/peng claim.
        let acted = needsDraw || (firstTurn && seat === this.dealer);
        let wasReplacement = isReplacement;
        isReplacement = false;
        while (acted) {
          acted = false;
          const opts = this.selfOptions(seat, wasReplacement, firstTurn);
          if (opts.zimo || opts.angangs.length || opts.jiagangs.length) {
            const action = await this.agents[seat].decideSelf(this, seat, opts);
            if (action && action.type === 'zimo' && opts.zimo) {
              this.settleWin(seat, this.drawnKind, {
                zimo: true, fromSeat: -1,
                gangKai: wasReplacement,
                haidi: this.wall.length === 0,
                tianHu: firstTurn && seat === this.dealer && !this.anyDiscardYet
                  && !wasReplacement && p.melds.length === 0,
              });
              return;
            }
            if (action && action.type === 'angang' && opts.angangs.includes(action.kind)) {
              this.removeFromHand(seat, action.kind, 4);
              p.melds.push({ type: 'angang', tiles: [action.kind, action.kind, action.kind, action.kind], from: seat });
              this.emit('meld', { seat, meld: p.melds[p.melds.length - 1] });
              await this.delay(250);
              const nk = this.takeTile(seat, true);
              if (nk == null) { this.settleDraw(); return; }
              p.hand.push(nk);
              this.drawnKind = nk;
              this.emit('draw', { seat, kind: nk, wallSize: this.wall.length, replacement: true });
              wasReplacement = true;
              acted = true;
              continue;
            }
            if (action && action.type === 'jiagang' && opts.jiagangs.includes(action.kind)) {
              // robbing the kong: others may hu on this tile
              const robber = await this.checkRobKong(seat, action.kind);
              if (robber >= 0) {
                // tile leaves the peng owner's hand and goes to robber
                this.removeFromHand(seat, action.kind, 1);
                const rp = this.players[robber];
                this.settleWinForRob(robber, action.kind, seat);
                return;
              }
              this.removeFromHand(seat, action.kind, 1);
              const meld = p.melds.find(m => m.type === 'peng' && m.tiles[0] === action.kind);
              meld.type = 'jiagang';
              meld.tiles.push(action.kind);
              this.seenCounts[action.kind] = 4;
              this.emit('meld', { seat, meld });
              await this.delay(250);
              const nk = this.takeTile(seat, true);
              if (nk == null) { this.settleDraw(); return; }
              p.hand.push(nk);
              this.drawnKind = nk;
              this.emit('draw', { seat, kind: nk, wallSize: this.wall.length, replacement: true });
              wasReplacement = true;
              acted = true;
              continue;
            }
          }
        }

        // discard
        this.sortHandKeepDrawn(seat);
        const discardKind = await this.agents[seat].chooseDiscard(this, seat);
        this.removeFromHand(seat, discardKind, 1);
        this.sortHand(seat);
        p.discards.push(discardKind);
        this.seenCounts[discardKind]++;
        this.lastDiscard = { seat, kind: discardKind };
        this.anyDiscardYet = true;
        this.drawnKind = null;
        this.emit('discard', { seat, kind: discardKind, wallSize: this.wall.length });
        firstTurn = false;
        await this.delay(120);

        // claims
        const claim = await this.gatherClaims(seat, discardKind);
        if (claim) {
          const { claimSeat, action } = claim;
          // remove from discards pile (tile is taken)
          const dp = this.players[seat].discards;
          dp.pop();
          this.seenCounts[discardKind]--;
          this.lastDiscard = null; // the tile left the pile — nothing to highlight/claim

          if (action.type === 'hu') {
            this.settleWin(claimSeat, discardKind, {
              zimo: false, fromSeat: seat,
              haidi: this.wall.length === 0,
            });
            return;
          }
          const cp = this.players[claimSeat];
          if (action.type === 'peng') {
            this.removeFromHand(claimSeat, discardKind, 2);
            cp.melds.push({ type: 'peng', tiles: [discardKind, discardKind, discardKind], from: seat });
            this.seenCounts[discardKind] = Math.min(4, this.seenCounts[discardKind] + 3);
            this.emit('meld', { seat: claimSeat, meld: cp.melds[cp.melds.length - 1] });
            this.turn = claimSeat;
            await this.delay(250);
            continue; // claimant discards (no draw)
          }
          if (action.type === 'gang') {
            this.removeFromHand(claimSeat, discardKind, 3);
            cp.melds.push({ type: 'gang', tiles: [discardKind, discardKind, discardKind, discardKind], from: seat });
            this.seenCounts[discardKind] = 4;
            this.emit('meld', { seat: claimSeat, meld: cp.melds[cp.melds.length - 1] });
            this.turn = claimSeat;
            isReplacement = true;
            await this.delay(250);
            continue; // claimant draws replacement then discards
          }
          if (action.type === 'chi') {
            const [a, b] = action.chi;
            this.removeFromHand(claimSeat, a, 1);
            this.removeFromHand(claimSeat, b, 1);
            const tiles = [discardKind, a, b].sort((x, y) => x - y);
            cp.melds.push({ type: 'chi', tiles, from: seat, claimed: discardKind });
            this.seenCounts[a]++; this.seenCounts[b]++; this.seenCounts[discardKind]++;
            this.emit('meld', { seat: claimSeat, meld: cp.melds[cp.melds.length - 1] });
            this.turn = claimSeat;
            await this.delay(250);
            continue;
          }
        }

        // no claim → next player
        this.turn = (seat + 1) % 4;
      }
    }

    sortHandKeepDrawn(seat) {
      // sort but keep drawnKind conceptually last — engine keeps sorted; UI handles display
      this.sortHand(seat);
    }

    async gatherClaims(discardSeat, tile) {
      // priority: hu (closest seat after discarder wins ties) > peng/gang > chi
      const candidates = [];
      for (let i = 1; i < 4; i++) {
        const s = (discardSeat + i) % 4;
        const opts = this.claimOptions(s, tile);
        if (opts.hu || opts.peng || opts.gang || opts.chis.length) {
          candidates.push({ seat: s, opts, order: i });
        }
      }
      if (!candidates.length) return null;
      const decisions = [];
      for (const cand of candidates) {
        const action = await this.agents[cand.seat].decideClaim(this, cand.seat, tile, cand.opts);
        if (action && action.type !== 'pass') decisions.push({ seat: cand.seat, action, order: cand.order, opts: cand.opts });
      }
      if (!decisions.length) return null;
      const rank = a => a.action.type === 'hu' ? 3 : (a.action.type === 'peng' || a.action.type === 'gang') ? 2 : 1;
      decisions.sort((x, y) => rank(y) - rank(x) || x.order - y.order);
      for (const chosen of decisions) {
        const o = chosen.opts;
        const t = chosen.action.type;
        if (t === 'hu' && !o.hu) continue;
        if (t === 'peng' && !o.peng) continue;
        if (t === 'gang' && !o.gang) continue;
        if (t === 'chi' && !(chosen.action.chi && o.chis.some(c2 => c2[0] === chosen.action.chi[0] && c2[1] === chosen.action.chi[1]))) continue;
        return { claimSeat: chosen.seat, action: chosen.action };
      }
      return null;
    }

    async checkRobKong(kongSeat, kind) {
      for (let i = 1; i < 4; i++) {
        const s = (kongSeat + i) % 4;
        const withTile = this.players[s].hand.concat([kind]);
        if (isWinningHand(withTile)) {
          const action = await this.agents[s].decideClaim(this, s, kind, { hu: true, peng: false, gang: false, chis: [], robKong: true });
          if (action && action.type === 'hu') return s;
        }
      }
      return -1;
    }

    settleWinForRob(winSeat, kind, fromSeat) {
      this.settleWin(winSeat, kind, { zimo: false, fromSeat, qiangGang: true });
    }
  }

  // ---------- AI agent ----------
  function makeAI(opts) {
    opts = opts || {};
    const thinkMs = opts.thinkMs != null ? opts.thinkMs : 0;

    function bestDiscard(game, seat) {
      const p = game.players[seat];
      const fixed = p.melds.length;
      const hand = p.hand;
      const uniq = [...new Set(hand)];
      let best = null;
      for (const k of uniq) {
        const idx = hand.indexOf(k);
        hand.splice(idx, 1);
        const sh = shanten(hand, fixed);
        let uk = 0;
        if (best == null || sh <= best.sh) uk = ukeire(hand, fixed, game.seenCounts);
        hand.splice(idx, 0, k);
        // safety: prefer discarding kinds already seen (less likely to feed wins late)
        const seen = game.seenCounts[k] || 0;
        const isolated = isHonor(k) && countsOf(hand)[k] === 1 ? 1 : 0;
        const score = { sh, uk, seen, isolated, k };
        if (best == null ||
          sh < best.sh ||
          (sh === best.sh && uk > best.uk) ||
          (sh === best.sh && uk === best.uk && (isolated > best.isolated ||
            (isolated === best.isolated && seen > best.seen)))) {
          best = score;
        }
      }
      return best.k;
    }

    return {
      async chooseDiscard(game, seat) {
        await game.delay(thinkMs);
        return bestDiscard(game, seat);
      },
      async decideSelf(game, seat, o) {
        await game.delay(thinkMs ? thinkMs / 2 : 0);
        if (o.zimo) return { type: 'zimo' };
        const p = game.players[seat];
        const fixed = p.melds.length;
        // angang if it doesn't hurt shanten
        for (const k of o.angangs) {
          const before = shanten(p.hand, fixed);
          const h2 = p.hand.filter(t => t !== k);
          const after = shanten(h2, fixed + 1);
          if (after <= before) return { type: 'angang', kind: k };
        }
        for (const k of o.jiagangs) {
          const before = shanten(p.hand, fixed);
          const h2 = p.hand.slice(); h2.splice(h2.indexOf(k), 1);
          const after = shanten(h2, fixed);
          if (after <= before) return { type: 'jiagang', kind: k };
        }
        return { type: 'pass' };
      },
      async decideClaim(game, seat, tile, o) {
        await game.delay(thinkMs ? thinkMs / 2 : 0);
        if (o.hu) return { type: 'hu' };
        const p = game.players[seat];
        const fixed = p.melds.length;
        const before = shanten(p.hand, fixed);
        if (o.gang) {
          const h2 = p.hand.filter(t => t !== tile);
          if (shanten(h2, fixed + 1) <= before) return { type: 'gang' };
        }
        if (o.peng) {
          const h2 = p.hand.slice();
          h2.splice(h2.indexOf(tile), 1); h2.splice(h2.indexOf(tile), 1);
          const after = shanten(h2, fixed + 1);
          if (after < before || (after === before && before <= 1)) return { type: 'peng' };
        }
        if (o.chis && o.chis.length) {
          let bestChi = null, bestSh = before;
          for (const chi of o.chis) {
            const h2 = p.hand.slice();
            h2.splice(h2.indexOf(chi[0]), 1);
            h2.splice(h2.indexOf(chi[1]), 1);
            const after = shanten(h2, fixed + 1);
            if (after < bestSh) { bestSh = after; bestChi = chi; }
          }
          if (bestChi) return { type: 'chi', chi: bestChi };
        }
        return { type: 'pass' };
      },
    };
  }

  const MJ = {
    WAN, TONG, TIAO, WIND, DRAGON, FLOWER, WINDS, ORPHANS,
    isSuit, isHonor, isFlower, suitOf, numOf, isTerminal,
    mulberry32, buildWall, countsOf,
    canWinStandard, isSevenPairs, isThirteenOrphans, isWinningHand,
    shanten, shantenStandard, shantenSevenPairs, shantenOrphans, ukeire,
    computeFan, fanValue, decomposesAllTriplets,
    Game, makeAI, TILE_NAMES_ZH,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MJ;
  root.MJ = MJ;
})(typeof globalThis !== 'undefined' ? globalThis : this);
