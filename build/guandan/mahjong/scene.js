/* ============================================================
   Scene builder — the sunroom, the city, the automatic table.
   Generates SVG/DOM procedurally. No game logic here.
   ============================================================ */
'use strict';

const SCENE = (() => {

  // ---------- tile glyphs ----------
  const RED = '#a63528', BLUE = '#1e3a6e', GREEN = '#2a6b3c', INK = '#22314f';
  const NUM_ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const KAI = `'Kaiti SC','STKaiti','KaiTi','DFKai-SB','BiauKai',serif`;

  function engraveText(x, y, size, color, ch, weight) {
    return `<text x="${x}" y="${y + 1.2}" font-size="${size}" fill="rgba(60,40,20,.35)" text-anchor="middle" font-family=${JSON.stringify(KAI)} font-weight="${weight || 700}">${ch}</text>` +
      `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="middle" font-family=${JSON.stringify(KAI)} font-weight="${weight || 700}">${ch}</text>`;
  }

  function dot(x, y, r, color) {
    // engraved coin-style dot: ring + core
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="${r * 0.32}"/>` +
      `<circle cx="${x}" cy="${y}" r="${r * 0.38}" fill="${color}"/>`;
  }

  function rosette(x, y, r) {
    let s = `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${GREEN}" stroke-width="${r * 0.18}"/>`;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      s += `<circle cx="${x + Math.cos(a) * r * 0.68}" cy="${y + Math.sin(a) * r * 0.68}" r="${r * 0.13}" fill="${i % 2 ? BLUE : GREEN}"/>`;
    }
    s += `<circle cx="${x}" cy="${y}" r="${r * 0.42}" fill="none" stroke="${RED}" stroke-width="${r * 0.16}"/>`;
    s += `<circle cx="${x}" cy="${y}" r="${r * 0.2}" fill="${RED}"/>`;
    return s;
  }

  function stick(x, y, h, color) {
    // bamboo stick: two segments with a waist
    const w = h * 0.30;
    const seg = (yy, hh) => `<rect x="${x - w / 2}" y="${yy}" width="${w}" height="${hh}" rx="${w * 0.45}" fill="${color}"/>`;
    return seg(y - h / 2, h * 0.44) + seg(y + h * 0.06, h * 0.44) +
      `<circle cx="${x}" cy="${y}" r="${w * 0.28}" fill="${color}"/>`;
  }

  function bird(cx, cy, s) {
    // the 1-bamboo sparrow, stylized
    return `<g transform="translate(${cx},${cy}) scale(${s})">
      <path d="M -8,6 C -14,2 -14,-6 -7,-9 C -3,-11 2,-10 4,-6 L 10,-9 L 6,-3 C 9,1 6,7 0,8 Z" fill="${GREEN}"/>
      <path d="M -7,-2 C -3,-5 2,-5 4,-1 C 1,2 -4,2 -7,-2 Z" fill="${BLUE}"/>
      <path d="M -8,6 L -15,12 L -9,11 L -12,16 L -4,9 Z" fill="${RED}"/>
      <circle cx="3" cy="-7" r="1.1" fill="#fff"/>
      <path d="M 9,-8 L 14,-7 L 9,-5 Z" fill="${RED}"/>
    </g>`;
  }

  // Returns inner SVG markup for a tile face, in a 60x84 viewBox
  function glyphInner(kind) {
    const W = 60, H = 84, cx = W / 2, cy = H / 2;
    if (kind < 9) { // wan
      return engraveText(cx, 32, 30, INK, NUM_ZH[kind]) + engraveText(cx, 68, 32, RED, '萬');
    }
    if (kind < 18) { // tong (dots)
      const n = kind - 9 + 1;
      const P = [];
      const L = (x, y, r, c) => P.push(dot(x, y, r, c));
      switch (n) {
        case 1: return rosette(cx, cy, 22);
        case 2: L(cx, 24, 11, BLUE); L(cx, 60, 11, GREEN); break;
        case 3: L(18, 20, 9.5, BLUE); L(cx, cy, 9.5, RED); L(42, 64, 9.5, GREEN); break;
        case 4: L(19, 23, 9.5, BLUE); L(41, 23, 9.5, GREEN); L(19, 61, 9.5, GREEN); L(41, 61, 9.5, BLUE); break;
        case 5: L(17, 20, 8.5, BLUE); L(43, 20, 8.5, GREEN); L(cx, cy, 8.5, RED); L(17, 64, 8.5, GREEN); L(43, 64, 8.5, BLUE); break;
        case 6: L(19, 18, 8, GREEN); L(41, 18, 8, GREEN); L(19, 45, 8, RED); L(41, 45, 8, RED); L(19, 68, 8, RED); L(41, 68, 8, RED); break;
        case 7: L(14, 14, 7, GREEN); L(30, 20, 7, GREEN); L(46, 26, 7, GREEN); L(19, 48, 7.5, RED); L(41, 48, 7.5, RED); L(19, 68, 7.5, RED); L(41, 68, 7.5, RED); break;
        case 8: for (let r = 0; r < 4; r++) { L(19, 14 + r * 19, 7.5, BLUE); L(41, 14 + r * 19, 7.5, BLUE); } break;
        case 9: { const cols = [14, 30, 46], colors = [GREEN, RED, BLUE]; for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) L(cols[i], 18 + r * 24, 7.5, colors[r]); break; }
      }
      return P.join('');
    }
    if (kind < 27) { // tiao (bamboo)
      const n = kind - 18 + 1;
      const P = [];
      const S = (x, y, h, c) => P.push(stick(x, y, h, c));
      switch (n) {
        case 1: return bird(cx, cy, 2.5);
        case 2: S(cx, 24, 24, BLUE); S(cx, 60, 24, GREEN); break;
        case 3: S(cx, 20, 22, BLUE); S(19, 60, 22, GREEN); S(41, 60, 22, GREEN); break;
        case 4: S(20, 23, 24, BLUE); S(40, 23, 24, GREEN); S(20, 61, 24, GREEN); S(40, 61, 24, BLUE); break;
        case 5: S(17, 21, 22, GREEN); S(43, 21, 22, BLUE); S(cx, cy, 22, RED); S(17, 63, 22, BLUE); S(43, 63, 22, GREEN); break;
        case 6: for (let i = 0; i < 3; i++) { S(16 + i * 14, 23, 22, GREEN); S(16 + i * 14, 61, 22, GREEN); } break;
        case 7: S(cx, 15, 18, RED); for (let i = 0; i < 3; i++) { S(16 + i * 14, 44, 19, GREEN); S(16 + i * 14, 69, 19, GREEN); } break;
        case 8: for (let i = 0; i < 4; i++) { S(13 + i * 11.3, 23, 22, i % 2 ? GREEN : BLUE); S(13 + i * 11.3, 61, 22, i % 2 ? BLUE : GREEN); } break;
        case 9: for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) S(16 + i * 14, 17 + r * 25, 20, r === 1 ? RED : GREEN); break;
      }
      return P.join('');
    }
    if (kind < 31) { // winds
      return engraveText(cx, cy + 15, 44, INK, ['東', '南', '西', '北'][kind - 27]);
    }
    if (kind === 31) return engraveText(cx, cy + 15, 44, RED, '中');
    if (kind === 32) return engraveText(cx, cy + 15, 44, GREEN, '發');
    if (kind === 33) { // white dragon: double frame
      return `<rect x="12" y="14" width="36" height="56" rx="3" fill="none" stroke="${BLUE}" stroke-width="4"/>
        <rect x="19" y="22" width="22" height="40" rx="2" fill="none" stroke="${BLUE}" stroke-width="2.4"/>`;
    }
    // flowers 34..41
    const fi = kind - 34;
    const zh = ['春', '夏', '秋', '冬', '梅', '蘭', '竹', '菊'][fi];
    const col = fi < 4 ? RED : BLUE;
    const num = (fi % 4) + 1;
    return engraveText(cx, cy + 12, 36, col, zh) +
      `<text x="12" y="18" font-size="14" fill="${RED}" font-family=${JSON.stringify(KAI)} font-weight="700">${num}</text>`;
  }

  function glyphSVG(kind) {
    return `<svg viewBox="0 0 60 84" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${glyphInner(kind)}</svg>`;
  }

  // ---------- tile cuboid ----------
  // sizeClass sets --w/--h/--d in CSS.
  function tileBox(kind, sizeClass, faceUp) {
    const el = document.createElement('div');
    el.className = 't3 ' + sizeClass;
    el.innerHTML = `
      <div class="tf tface">${kind != null && faceUp ? glyphSVG(kind) : ''}</div>
      <div class="tf tback"></div>
      <div class="tf tsideL"></div><div class="tf tsideR"></div>
      <div class="tf tsideT"></div><div class="tf tsideB"></div>`;
    return el;
  }

  // flat 2D tile chip (for overlays / result screens)
  function tileChip(kind, cls) {
    const el = document.createElement('div');
    el.className = 'chip ' + (cls || '');
    el.innerHTML = glyphSVG(kind);
    return el;
  }

  // ---------- textures ----------
  const feltNoise = (() => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>
      <filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='7'/>
      <feColorMatrix type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.4 0.25 0 0 0'/></filter>
      <rect width='160' height='160' filter='url(#n)'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  })();

  const woodNoise = (() => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='60'>
      <filter id='w'><feTurbulence type='fractalNoise' baseFrequency='0.012 0.28' numOctaves='3' seed='11'/>
      <feColorMatrix type='matrix' values='0 0 0 0 0.35  0 0 0 0 0.18  0 0 0 0 0.04  0.35 0.2 0 0 0'/></filter>
      <rect width='240' height='60' filter='url(#w)'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  })();

  // ---------- backdrop: the sunroom ----------
  function cityScape() {
    // one skyline SVG visible through all panes. viewBox 0 0 1340 520 mapped to window interior
    let s = '';
    // sky
    s += `<defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#c8d4da"/><stop offset=".55" stop-color="#dbe0d8"/><stop offset="1" stop-color="#e9e2cd"/>
      </linearGradient>
      <linearGradient id="pitch" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4a9a50"/><stop offset="1" stop-color="#3d8443"/>
      </linearGradient>
      <pattern id="win1" width="14" height="18" patternUnits="userSpaceOnUse">
        <rect width="14" height="18" fill="#e3d5a4"/><rect x="2.5" y="3" width="9" height="11" fill="#a09468" opacity=".8"/>
      </pattern>
      <pattern id="win2" width="12" height="15" patternUnits="userSpaceOnUse">
        <rect width="12" height="15" fill="#d3c491"/><rect x="2" y="2.5" width="8" height="9.5" fill="#8f855f" opacity=".75"/>
      </pattern>
      <pattern id="win3" width="16" height="14" patternUnits="userSpaceOnUse">
        <rect width="16" height="14" fill="#e8e0cd"/><rect x="2.5" y="2.5" width="11" height="8.5" fill="#9a917d" opacity=".7"/>
      </pattern>
    </defs>`;
    s += `<rect width="1340" height="520" fill="url(#sky)"/>`;
    // distant ridge full width
    s += `<path d="M0,258 C120,236 260,246 380,232 C540,214 660,238 800,222 C980,204 1120,232 1340,212 L1340,320 L0,320 Z" fill="#8ba181" opacity=".55"/>`;
    // right green hills (closer)
    s += `<path d="M760,258 C880,208 1000,196 1120,214 C1220,228 1300,222 1340,232 L1340,400 L760,400 Z" fill="#5d7c58"/>`;
    s += `<path d="M900,268 C1000,238 1120,242 1230,262 C1290,272 1330,268 1340,272 L1340,400 L900,400 Z" fill="#4c6a49"/>`;
    // left wooded hill
    s += `<path d="M0,250 C60,222 150,214 230,230 C300,244 330,252 360,258 L360,360 L0,360 Z" fill="#547252"/>`;
    // lattice towers (red/white)
    const tower = (x, y, h, w) => {
      let t = `<g stroke="#b8574a" stroke-width="2.4" opacity=".92">`;
      t += `<line x1="${x - w / 2}" y1="${y + h}" x2="${x}" y2="${y}"/><line x1="${x + w / 2}" y1="${y + h}" x2="${x}" y2="${y}"/>`;
      for (let i = 1; i <= 4; i++) {
        const yy = y + h * i / 4.6, ww = w * i / 4.6;
        t += `<line x1="${x - ww / 2}" y1="${yy}" x2="${x + ww / 2}" y2="${yy}"/>`;
        if (i > 1) {
          const yp = y + h * (i - 1) / 4.6, wp = w * (i - 1) / 4.6;
          t += `<line x1="${x - wp / 2}" y1="${yp}" x2="${x + ww / 2}" y2="${yy}"/><line x1="${x + wp / 2}" y1="${yp}" x2="${x - ww / 2}" y2="${yy}"/>`;
        }
      }
      t += `</g><line x1="${x}" y1="${y}" x2="${x}" y2="${y - 12}" stroke="#b8574a" stroke-width="2.4"/>`;
      return t;
    };
    s += tower(150, 86, 190, 74);
    s += tower(212, 118, 158, 60);
    s += tower(872, 96, 178, 64);
    // apartment tower cluster (left-center, yellow-cream)
    const bldg = (x, y, w, h, fill, stroke) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke || 'rgba(90,80,50,.35)'}" stroke-width="1"/>`;
    const cluster = [
      [340, 170, 44, 260, 'url(#win1)'], [392, 150, 52, 280, 'url(#win1)'], [452, 186, 40, 244, 'url(#win2)'],
      [498, 132, 56, 298, 'url(#win1)'], [560, 168, 46, 262, 'url(#win2)'], [612, 190, 40, 240, 'url(#win1)'],
      [658, 146, 50, 284, 'url(#win1)'], [714, 200, 38, 230, 'url(#win2)'],
    ];
    for (const b of cluster) s += bldg(...b);
    // rooftop caps
    for (const b of cluster) s += `<rect x="${b[0] - 2}" y="${b[1] - 6}" width="${b[2] + 4}" height="6" fill="#c9b985"/>`;
    // right mid-rise slabs
    s += bldg(950, 300, 120, 110, 'url(#win2)');
    s += bldg(1080, 320, 90, 96, 'url(#win1)');
    s += bldg(1180, 306, 110, 104, 'url(#win2)');
    // big pale slab center-right (behind chair in photo)
    s += bldg(770, 236, 150, 200, 'url(#win3)');
    s += `<rect x="768" y="228" width="154" height="8" fill="#bdb49d"/>`;
    // red-roof walk-ups (front row)
    for (let i = 0; i < 6; i++) {
      const x = 60 + i * 118, y = 372 + (i % 2) * 10, w = 96, h = 64;
      s += bldg(x, y, w, h, '#ded2b4');
      s += `<path d="M${x - 5},${y} L${x + w / 2},${y - 18} L${x + w + 5},${y} Z" fill="#b04438"/>`;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++)
        s += `<rect x="${x + 7 + c * 15}" y="${y + 8 + r * 18}" width="9" height="11" fill="#8f8468" opacity=".8"/>`;
    }
    // rainbow mural nod
    s += `<g transform="translate(560,470)">
      <rect x="-34" y="-6" width="68" height="30" fill="#cfc4a8"/>
      ${['#c94f43', '#d98f3c', '#d9c53c', '#4f9a4f', '#4f6fc9'].map((c, i) =>
        `<path d="M -26,18 A ${26 - i * 4},${26 - i * 4} 0 0 1 26,18" fill="none" stroke="${c}" stroke-width="3.4" transform="scale(1,0.72)"/>`).join('')}
    </g>`;
    // sports field bottom right
    s += `<g transform="translate(960,436)" opacity=".85">
      <ellipse cx="130" cy="60" rx="205" ry="62" fill="#a35544"/>
      <ellipse cx="130" cy="60" rx="168" ry="47" fill="none" stroke="#e8ddc8" stroke-width="1.4" opacity=".6"/>
      <rect x="30" y="28" width="200" height="64" rx="30" fill="url(#pitch)"/>
      <rect x="60" y="38" width="140" height="44" fill="none" stroke="#e8f2e2" stroke-width="1.4" opacity=".7"/>
      <line x1="130" y1="38" x2="130" y2="82" stroke="#e8f2e2" stroke-width="1.4" opacity=".7"/>
      <rect x="-70" y="14" width="86" height="94" fill="#4a6d9c" opacity=".8"/>
      <rect x="-58" y="26" width="62" height="70" fill="none" stroke="#dce8f2" stroke-width="1.4" opacity=".6"/>
    </g>`;
    // trees / road bottom left
    s += `<path d="M0,430 C120,420 260,436 400,446 L400,520 L0,520 Z" fill="#77736a"/>`;
    s += `<path d="M0,452 C140,444 260,456 400,466 L400,520 L0,520 Z" fill="#8a8579"/>`;
    for (let i = 0; i < 9; i++) {
      const x = 24 + i * 44 + (i % 3) * 8, y = 428 + (i % 2) * 14;
      s += `<circle cx="${x}" cy="${y}" r="${15 + (i % 3) * 4}" fill="#3f5c3d" opacity=".95"/>`;
      s += `<circle cx="${x + 9}" cy="${y - 8}" r="${10 + (i % 2) * 3}" fill="#4c6c48"/>`;
    }
    // haze
    s += `<rect y="180" width="1340" height="150" fill="#e8e4d5" opacity=".22"/>`;
    s += `<rect y="0" width="1340" height="520" fill="#f4ead2" opacity=".07"/>`;
    return s;
  }

  // wrought-iron plant stand (white)
  function ironStand(x, y, sc) {
    return `<g transform="translate(${x},${y}) scale(${sc})" stroke="#e8e6e0" fill="none" stroke-width="3" opacity=".95">
      <path d="M0,0 C -18,-30 -6,-58 0,-62 C 6,-58 18,-30 0,0 Z"/>
      <path d="M -26,-20 C -40,-34 -34,-52 -22,-56"/><path d="M 26,-20 C 40,-34 34,-52 22,-56"/>
      <path d="M -22,-56 c -6,-8 2,-14 8,-8"/><path d="M 22,-56 c 6,-8 -2,-14 -8,-8"/>
      <line x1="-20" y1="0" x2="-30" y2="34"/><line x1="20" y1="0" x2="30" y2="34"/>
      <line x1="0" y1="0" x2="0" y2="36"/>
      <path d="M -30,34 c -8,4 -10,10 -4,12"/><path d="M 30,34 c 8,4 10,10 4,12"/>
      <line x1="-26" y1="16" x2="26" y2="16"/>
      <path d="M -8,16 c 0,-8 16,-8 16,0"/>
    </g>`;
  }

  function pot(x, y, w, h, style) {
    const colors = {
      terra: ['#a65b3f', '#8a4832', '#b96a4a'],
      black: ['#31302c', '#232220', '#454440'],
      white: ['#e6e2d8', '#c9c4b6', '#f2efe6'],
    }[style || 'terra'];
    return `<g transform="translate(${x},${y})">
      <path d="M ${-w / 2},0 L ${-w / 2 * 0.74},${h} L ${w / 2 * 0.74},${h} L ${w / 2},0 Z" fill="${colors[0]}"/>
      <path d="M ${-w / 2},0 L ${-w / 2 * 0.74},${h} L ${-w / 2 * 0.4},${h} L ${-w / 2 * 0.62},0 Z" fill="${colors[1]}" opacity=".55"/>
      <rect x="${-w / 2 - 3}" y="-6" width="${w + 6}" height="9" rx="3" fill="${colors[2]}"/>
    </g>`;
  }

  function leafCluster(x, y, n, spread, size, col1, col2, seedO) {
    let s = `<g transform="translate(${x},${y})">`;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (seedO || 0);
      const d = spread * (0.4 + ((i * 7919) % 100) / 160);
      const lx = Math.cos(a) * d, ly = Math.sin(a) * d * 0.7 - size * 0.3;
      const rot = a * 180 / Math.PI + 90;
      s += `<ellipse cx="${lx}" cy="${ly}" rx="${size * 0.38}" ry="${size}" fill="${i % 3 ? col1 : col2}" transform="rotate(${rot} ${lx} ${ly})"/>`;
    }
    return s + '</g>';
  }

  function flower5(x, y, r, col) {
    let s = `<g transform="translate(${x},${y})">`;
    for (let i = 0; i < 5; i++) {
      const a = i * 72;
      s += `<ellipse cx="0" cy="${-r * 0.62}" rx="${r * 0.42}" ry="${r * 0.62}" fill="${col}" transform="rotate(${a})"/>`;
    }
    s += `<circle r="${r * 0.24}" fill="#e8c23c"/></g>`;
    return s;
  }

  function hibiscus(x, y, sc, flowerCol) {
    let s = `<g transform="translate(${x},${y}) scale(${sc})">`;
    s += `<path d="M0,0 C -4,-30 -2,-60 0,-78" stroke="#3f5a35" stroke-width="4" fill="none"/>`;
    s += `<path d="M0,-30 C -16,-42 -24,-58 -26,-70" stroke="#3f5a35" stroke-width="3" fill="none"/>`;
    s += `<path d="M0,-40 C 14,-52 22,-66 26,-80" stroke="#3f5a35" stroke-width="3" fill="none"/>`;
    s += leafCluster(0, -78, 9, 26, 22, '#3d6b38', '#4f8446');
    s += leafCluster(-26, -70, 7, 20, 18, '#35602f', '#487a40');
    s += leafCluster(26, -80, 7, 20, 18, '#3d6b38', '#529049');
    s += flower5(-20, -92, 11, flowerCol);
    s += flower5(24, -64, 9, flowerCol);
    return s + '</g>';
  }

  function jadePlant(x, y, sc) {
    let s = `<g transform="translate(${x},${y}) scale(${sc})">`;
    for (const [bx, by] of [[-14, -18], [0, -26], [14, -16], [-6, -34], [8, -32]]) {
      s += `<path d="M0,0 C ${bx * 0.4},${by * 0.5} ${bx * 0.8},${by * 0.8} ${bx},${by}" stroke="#6b5334" stroke-width="3.4" fill="none"/>`;
      for (let i = 0; i < 6; i++) {
        const a = i * 60 + bx;
        const lx = bx + Math.cos(a) * 9, ly = by + Math.sin(a) * 7;
        s += `<ellipse cx="${lx}" cy="${ly}" rx="5.5" ry="8" fill="${i % 2 ? '#3f6e38' : '#54874a'}" transform="rotate(${a} ${lx} ${ly})"/>`;
      }
    }
    return s + '</g>';
  }

  function palm(x, y, sc, mirror) {
    let s = `<g transform="translate(${x},${y}) scale(${mirror ? -sc : sc},${sc})">`;
    const frond = (a0, len, bend) => {
      const a = a0 * Math.PI / 180;
      const ex = Math.cos(a) * len, ey = Math.sin(a) * len;
      const mx = ex * 0.5 - bend * Math.sin(a), my = ey * 0.5 - bend * Math.cos(a) - 14;
      let f = `<path d="M0,0 Q ${mx},${my} ${ex},${ey}" stroke="#3c6136" stroke-width="3" fill="none"/>`;
      for (let i = 2; i <= 9; i++) {
        const t = i / 10;
        const px = 2 * (1 - t) * t * mx + t * t * ex, py = 2 * (1 - t) * t * my + t * t * ey;
        const dx = (mx + t * (ex - mx)) - (t * mx), dy2 = (my + t * (ey - my)) - (t * my);
        const norm = Math.hypot(dx, dy2) || 1;
        const nx = -dy2 / norm, ny = dx / norm;
        const ll = 16 * (1 - t * 0.55);
        f += `<line x1="${px}" y1="${py}" x2="${px + nx * ll + dx / norm * 6}" y2="${py + ny * ll + dy2 / norm * 6}" stroke="#48793f" stroke-width="2.6"/>`;
        f += `<line x1="${px}" y1="${py}" x2="${px - nx * ll + dx / norm * 6}" y2="${py - ny * ll + dy2 / norm * 6}" stroke="#3f6b38" stroke-width="2.6"/>`;
      }
      return f;
    };
    s += `<path d="M0,0 C -3,-26 -1,-52 0,-70" stroke="#5d4a2e" stroke-width="5" fill="none"/>`;
    for (const [a, l, b] of [[-165, 90, 26], [-135, 105, 30], [-105, 96, 22], [-75, 100, 24], [-45, 104, 30], [-15, 88, 24]]) {
      s += `<g transform="translate(0,-70)">${frond(a, l, b)}</g>`;
    }
    return s + '</g>';
  }

  function chairBack(x, y, sc, opts) {
    // honey-oak ladder-back chair, seen from behind
    const o = opts || {};
    return `<g transform="translate(${x},${y}) scale(${sc})">
      <defs><linearGradient id="chw${x}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#8a5a26"/><stop offset=".25" stop-color="#c98f45"/>
        <stop offset=".55" stop-color="#b57a35"/><stop offset="1" stop-color="#8a5a26"/></linearGradient></defs>
      <rect x="-92" y="-4" width="16" height="230" rx="7" fill="url(#chw${x})"/>
      <rect x="76" y="-4" width="16" height="230" rx="7" fill="url(#chw${x})"/>
      <rect x="-88" y="0" width="176" height="20" rx="9" fill="url(#chw${x})"/>
      <rect x="-84" y="44" width="168" height="15" rx="7" fill="url(#chw${x})"/>
      <rect x="-84" y="84" width="168" height="15" rx="7" fill="url(#chw${x})"/>
      ${o.cushion ? `<rect x="-96" y="196" width="192" height="34" rx="10" fill="#e9e2d2"/>
        <rect x="-96" y="196" width="192" height="34" rx="10" fill="url(#cushionPat)"/>` : ''}
    </g>`;
  }

  function buildBackdrop() {
    // stage: 1600x1000. Window region: x 118..1482, y 30..585
    const W = 1600;
    let s = `<svg id="backdropSvg" viewBox="0 0 1600 1000" width="1600" height="1000" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">`;
    s += `<defs>
      <linearGradient id="wallL" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#e2d2b8"/><stop offset="1" stop-color="#cdbb9a"/>
      </linearGradient>
      <pattern id="cushionPat" width="34" height="30" patternUnits="userSpaceOnUse">
        <rect width="34" height="30" fill="none"/>
        ${flower5(8, 10, 5, '#c98a96')}${flower5(24, 22, 4, '#8ea3c4')}
        <circle cx="26" cy="7" r="1.6" fill="#a8b890"/><circle cx="5" cy="24" r="1.6" fill="#a8b890"/>
      </pattern>
      <linearGradient id="floorG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#c8a878"/><stop offset="1" stop-color="#a8875c"/>
      </linearGradient>
      <linearGradient id="frameV" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#b9b6ac"/><stop offset=".5" stop-color="#eceae2"/><stop offset="1" stop-color="#a5a298"/>
      </linearGradient>
    </defs>`;
    // room base: warm wall + floor
    s += `<rect width="1600" height="1000" fill="#d9c8ac"/>`;
    s += `<rect y="580" width="1600" height="420" fill="url(#floorG)"/>`;
    for (let i = 0; i < 10; i++) s += `<line x1="${i * 178 - 60}" y1="1000" x2="${i * 160 + 140}" y2="580" stroke="#8f7148" stroke-width="1.4" opacity=".35"/>`;
    s += `<line x1="0" y1="640" x2="1600" y2="640" stroke="#8f7148" stroke-width="1.2" opacity=".25"/>`;

    // city through glass
    s += `<g transform="translate(130,30)"><svg width="1340" height="555" viewBox="0 0 1340 520" preserveAspectRatio="xMidYMax slice">${cityScape()}</svg></g>`;
    // glass sheen + rain speckle
    s += `<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/><stop offset=".4" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset=".7" stop-color="#dfe8f0" stop-opacity=".1"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>`;
    s += `<rect x="130" y="30" width="1340" height="555" fill="url(#sheen)"/>`;
    let speck = '';
    let sx = 7;
    for (let i = 0; i < 160; i++) {
      sx = (sx * 16807) % 2147483647;
      const rx = 140 + (sx % 1320); const ry = 40 + ((sx >> 3) % 540);
      speck += `<circle cx="${rx}" cy="${ry}" r="${0.8 + (sx % 3) * 0.5}" fill="#ffffff" opacity=".18"/>`;
    }
    s += speck;

    // window frames (aluminum, like photo)
    const frame = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#frameV)" stroke="#8e8b80" stroke-width="1"/>`;
    s += frame(112, 16, 20, 590);   // far left vertical
    s += frame(468, 16, 16, 590);
    s += frame(1004, 16, 16, 590);
    s += frame(1352, 16, 16, 590);
    s += frame(1466, 16, 20, 590);
    s += frame(112, 10, 1374, 18);  // top
    s += frame(112, 300, 358, 12);  // left transom
    s += frame(1120, 300, 348, 12); // right transom
    s += frame(112, 588, 1374, 24); // sill
    s += `<rect x="112" y="610" width="1374" height="10" fill="#b09468"/>`;

    // left interior wall + curtain
    s += `<rect x="0" y="0" width="118" height="1000" fill="#e6d7bd"/>`;
    s += `<rect x="0" y="0" width="46" height="1000" fill="#efe4cd"/>`;
    s += `<path d="M46,0 L118,0 L118,760 C 96,748 84,700 88,620 C 92,520 74,470 60,430 C 46,380 52,180 46,0 Z" fill="#f4ecd9" opacity=".9"/>`;
    for (let i = 0; i < 4; i++) s += `<path d="M${58 + i * 16},0 C ${52 + i * 16},220 ${66 + i * 16},420 ${58 + i * 16},700" stroke="#dbcba8" stroke-width="2.4" fill="none" opacity=".7"/>`;
    // right interior: lace curtain
    s += `<rect x="1482" y="0" width="118" height="1000" fill="#e6d7bd"/>`;
    s += `<path d="M1482,0 L1600,0 L1600,1000 L1520,1000 C 1536,820 1508,640 1522,460 C 1534,300 1516,140 1482,0 Z" fill="#f2ead6"/>`;
    for (let i = 0; i < 4; i++) s += `<path d="M${1516 + i * 20},0 C ${1524 + i * 20},300 ${1508 + i * 20},640 ${1522 + i * 20},1000" stroke="#ddceac" stroke-width="2.6" fill="none" opacity=".7"/>`;

    // ---- plants ----
    // left rack of small pots
    s += `<g stroke="#d8d5cc" stroke-width="3" fill="none" opacity=".9">
      <line x1="150" y1="470" x2="150" y2="700"/><line x1="298" y1="470" x2="298" y2="700"/>
      <line x1="146" y1="500" x2="302" y2="500"/><line x1="146" y1="600" x2="302" y2="600"/><line x1="146" y1="695" x2="302" y2="695"/>
    </g>`;
    s += jadePlant(190, 494, 1.15) + pot(190, 466, 44, 30, 'black');
    s += leafCluster(258, 462, 8, 18, 14, '#4c7a44', '#5f9152') + flower5(250, 448, 6, '#d477b0') + flower5(268, 452, 5, '#d477b0') + pot(258, 468, 40, 28, 'terra');
    s += jadePlant(196, 596, 1.0) + pot(196, 566, 42, 30, 'terra');
    s += leafCluster(262, 566, 9, 20, 15, '#3f6e38', '#54874a') + pot(262, 568, 44, 30, 'black');
    // hibiscus on white iron stands (photo center-left & center-right)
    s += ironStand(430, 560, 1.15);
    s += hibiscus(430, 502, 1.05, '#d9536b') + pot(430, 470, 52, 36, 'black');
    s += ironStand(700, 556, 1.1);
    s += hibiscus(700, 500, 1.0, '#e0a13e') + pot(700, 468, 50, 34, 'black');
    s += ironStand(905, 556, 1.1);
    s += hibiscus(905, 498, 1.02, '#d9536b') + pot(905, 466, 50, 34, 'black');
    s += ironStand(1105, 560, 1.15);
    s += leafCluster(1105, 470, 10, 24, 18, '#3d6b38', '#4f8446') + pot(1105, 474, 52, 36, 'black');
    // sill row small pots
    s += leafCluster(560, 585, 7, 14, 11, '#4c7a44', '#5f9152') + pot(560, 584, 34, 24, 'terra');
    s += leafCluster(806, 588, 7, 14, 11, '#446e3c', '#578c4c') + pot(806, 586, 34, 24, 'terra');
    s += flower5(646, 574, 7, '#c94f6b') + leafCluster(646, 588, 6, 12, 10, '#4c7a44', '#5f9152') + pot(646, 586, 32, 22, 'white');
    // right: tall palm + bamboo pair
    s += palm(1300, 720, 1.5, false) + pot(1300, 660, 96, 70, 'black');
    s += `<g transform="translate(1210,640)">${['-8', '4', '14'].map((dx, i) =>
      `<path d="M${dx},0 C ${dx},-90 ${+dx + 6},-180 ${+dx + 2},-250" stroke="#5a7a42" stroke-width="4.6" fill="none"/>`).join('')}
      ${leafCluster(-4, -190, 8, 26, 24, '#4a7040', '#5c8a4e')}${leafCluster(14, -250, 8, 24, 22, '#42663a', '#54804a')}
      ${leafCluster(4, -120, 7, 22, 20, '#4a7040', '#5c8a4e')}</g>` + pot(1210, 646, 60, 44, 'terra');
    s += jadePlant(1165, 610, 1.3) + pot(1165, 576, 48, 34, 'black');
    // wooden side cabinet far right
    s += `<g transform="translate(1420,596)"><rect x="0" y="0" width="120" height="150" rx="6" fill="#9a6a3a"/>
      <rect x="8" y="10" width="104" height="60" rx="4" fill="#7c5028"/><rect x="8" y="80" width="104" height="60" rx="4" fill="#7c5028"/>
      <circle cx="60" cy="40" r="4" fill="#d9b878"/><circle cx="60" cy="110" r="4" fill="#d9b878"/></g>`;

    // far chair (behind table) — the empty north seat, peeking above the far rail
    s += chairBack(800, 96, 1.18, {});

    s += `</svg>`;
    const div = document.createElement('div');
    div.id = 'backdrop';
    div.innerHTML = s;
    return div;
  }

  function buildForeground() {
    // side chairs + palm frond overlapping the table, like the photo
    let s = `<svg viewBox="0 0 1600 1000" width="1600" height="1000" xmlns="http://www.w3.org/2000/svg">`;
    s += `<defs><pattern id="cushionPat2" width="34" height="30" patternUnits="userSpaceOnUse">
      ${flower5(8, 10, 5, '#c98a96')}${flower5(24, 22, 4, '#8ea3c4')}
      <circle cx="26" cy="7" r="1.6" fill="#a8b890"/><circle cx="5" cy="24" r="1.6" fill="#a8b890"/>
    </pattern>
    <linearGradient id="chwS" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7c5022"/><stop offset=".3" stop-color="#c08a40"/>
      <stop offset=".6" stop-color="#a87430"/><stop offset="1" stop-color="#7c5022"/></linearGradient></defs>`;
    // left chair, angled, cropped at edge
    s += `<g transform="translate(46,772) rotate(9)">
      <rect x="-30" y="-40" width="20" height="330" rx="9" fill="url(#chwS)"/>
      <rect x="150" y="-52" width="20" height="342" rx="9" fill="url(#chwS)"/>
      <rect x="-26" y="-40" width="192" height="24" rx="10" fill="url(#chwS)"/>
      <rect x="-22" y="14" width="184" height="17" rx="8" fill="url(#chwS)"/>
      <rect x="-22" y="62" width="184" height="17" rx="8" fill="url(#chwS)"/>
      <rect x="-40" y="238" width="220" height="44" rx="14" fill="#ece5d4"/>
      <rect x="-40" y="238" width="220" height="44" rx="14" fill="url(#cushionPat2)"/>
      <rect x="-40" y="278" width="220" height="14" rx="7" fill="#a87430"/>
    </g>`;
    // right chair
    s += `<g transform="translate(1560,764) rotate(-9)">
      <rect x="-146" y="-46" width="20" height="336" rx="9" fill="url(#chwS)"/>
      <rect x="26" y="-36" width="20" height="326" rx="9" fill="url(#chwS)"/>
      <rect x="-142" y="-38" width="188" height="24" rx="10" fill="url(#chwS)"/>
      <rect x="-138" y="16" width="180" height="17" rx="8" fill="url(#chwS)"/>
      <rect x="-138" y="64" width="180" height="17" rx="8" fill="url(#chwS)"/>
      <rect x="-158" y="240" width="220" height="44" rx="14" fill="#ece5d4"/>
      <rect x="-158" y="240" width="220" height="44" rx="14" fill="url(#cushionPat2)"/>
    </g>`;
    s += `</svg>`;
    const div = document.createElement('div');
    div.id = 'foreground';
    div.innerHTML = s;
    return div;
  }

  // ---------- the automatic table ----------
  const PLANE = 1250;         // logical table-top size
  const RAIL = 95;            // rail width
  const FELT_MIN = RAIL, FELT_MAX = PLANE - RAIL;
  const CENTER = PLANE / 2;

  function buildTable() {
    const wrap = document.createElement('div');
    wrap.id = 'scene3d';
    const plane = document.createElement('div');
    plane.id = 'tablePlane';
    wrap.appendChild(plane);

    // felt
    const felt = document.createElement('div');
    felt.id = 'felt';
    felt.style.backgroundImage = `${feltNoise}, radial-gradient(ellipse 70% 60% at 50% 42%, #2f9c56 0%, #1e8145 55%, #14683a 100%)`;
    plane.appendChild(felt);
    // felt guide lines (automatic-table markings)
    const guide = document.createElement('div');
    guide.id = 'feltGuides';
    plane.appendChild(guide);

    // rails: 4 top strips + 4 corners, raised above felt
    const woodBg = `${woodNoise}, linear-gradient(135deg, #d29a52 0%, #b57c38 32%, #c8934b 58%, #9a692e 100%)`;
    for (const side of ['n', 's', 'e', 'w']) {
      const strip = document.createElement('div');
      strip.className = 'railT rt-' + side;
      strip.style.backgroundImage = woodBg;
      plane.appendChild(strip);
    }
    for (const c of ['nw', 'ne', 'sw', 'se']) {
      const corner = document.createElement('div');
      corner.className = 'railC rc-' + c;
      corner.style.backgroundImage = woodBg;
      plane.appendChild(corner);
    }

    // center dispenser
    const disp = document.createElement('div');
    disp.id = 'dispenser';
    disp.innerHTML = `
      <div class="dispRing"></div>
      <div class="dispPanel">
        <div class="dispWind" id="dispWind">東</div>
        <div class="dispCount" id="dispCount">84</div>
        <div class="dispDice" id="dispDice"><span class="die" id="die1"></span><span class="die" id="die2"></span></div>
        <button class="dispBtn" id="dispBtn" title="Start / 开局"></button>
        <div class="turnLED led0" id="led0"></div><div class="turnLED led1" id="led1"></div>
        <div class="turnLED led2" id="led2"></div><div class="turnLED led3" id="led3"></div>
      </div>`;
    plane.appendChild(disp);

    // seat layers (0 = you/bottom, 1 = right, 2 = top, 3 = left)
    for (let s = 0; s < 4; s++) {
      const layer = document.createElement('div');
      layer.className = 'seatLayer';
      layer.id = 'seat' + s;
      layer.style.transform = `rotate(${s * -90}deg)`;
      layer.innerHTML = `
        <div class="zWall" id="wall${s}"></div>
        <div class="zDiscards" id="discards${s}"></div>
        <div class="zMelds" id="melds${s}"></div>
        <div class="zFlowers" id="flowers${s}"></div>
        <div class="zHand" id="hand${s}"></div>`;
      plane.appendChild(layer);
    }
    return wrap;
  }

  // die face pips
  function dieFace(n) {
    const pips = {
      1: [[50, 50]], 2: [[30, 30], [70, 70]], 3: [[28, 28], [50, 50], [72, 72]],
      4: [[30, 30], [70, 30], [30, 70], [70, 70]], 5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
      6: [[30, 26], [70, 26], [30, 50], [70, 50], [30, 74], [70, 74]],
    }[n] || [];
    return `<svg viewBox="0 0 100 100" width="100%" height="100%">${pips.map(([x, y]) =>
      `<circle cx="${x}" cy="${y}" r="11" fill="${(n === 1) ? '#c03a2e' : '#2b3038'}"/>`).join('')}</svg>`;
  }

  return {
    glyphSVG, tileBox, tileChip, dieFace,
    buildBackdrop, buildForeground, buildTable,
    PLANE, RAIL, FELT_MIN, FELT_MAX, CENTER,
    feltNoise, woodNoise, KAI,
    // shared procedural artwork (used by the 3D renderer for textures)
    cityScape, hibiscus, jadePlant, palm, leafCluster, flower5, pot, ironStand,
  };
})();
