/* ============================================================
   ui3d.js — Three.js renderer for the mahjong room.
   Depends on THREE (three.min.js), MJ (engine.js), SCENE (scene.js,
   used for shared SVG artwork + 2D chips in overlays).
   ============================================================ */
'use strict';

(() => {
  const $ = id => document.getElementById(id);

  // ================= tile glyph painting (canvas 2D) =================
  const RED = '#a63528', BLUE = '#1e3a6e', GREEN = '#2a6b3c', INK = '#22314f';
  const NUM_ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const KAI = `"Kaiti SC","STKaiti","KaiTi","DFKai-SB","BiauKai",serif`;

  // draws in a 60x84 logical space
  function paintGlyph(ctx, kind) {
    const cx = 30;
    const text = (x, y, size, color, ch) => {
      ctx.font = `700 ${size}px ${KAI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(60,40,20,.35)';
      ctx.fillText(ch, x + 0.6, y + 1.2);
      ctx.fillStyle = color;
      ctx.fillText(ch, x, y);
    };
    const dot = (x, y, r, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = r * 0.32;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r * 0.38, 0, 7); ctx.fill();
    };
    const rosette = (x, y, r) => {
      ctx.strokeStyle = GREEN; ctx.lineWidth = r * 0.18;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        ctx.fillStyle = i % 2 ? BLUE : GREEN;
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.68, y + Math.sin(a) * r * 0.68, r * 0.13, 0, 7); ctx.fill();
      }
      ctx.strokeStyle = RED; ctx.lineWidth = r * 0.16;
      ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, 7); ctx.stroke();
      ctx.fillStyle = RED;
      ctx.beginPath(); ctx.arc(x, y, r * 0.2, 0, 7); ctx.fill();
    };
    const stick = (x, y, h, color) => {
      const w = h * 0.30;
      ctx.fillStyle = color;
      const seg = (yy, hh) => { ctx.beginPath(); ctx.roundRect(x - w / 2, yy, w, hh, w * 0.45); ctx.fill(); };
      seg(y - h / 2, h * 0.44); seg(y + h * 0.06, h * 0.44);
      ctx.beginPath(); ctx.arc(x, y, w * 0.28, 0, 7); ctx.fill();
    };
    const bird = (bx, by, s) => {
      ctx.save(); ctx.translate(bx, by); ctx.scale(s, s);
      ctx.fillStyle = GREEN;
      ctx.fill(new Path2D('M -8,6 C -14,2 -14,-6 -7,-9 C -3,-11 2,-10 4,-6 L 10,-9 L 6,-3 C 9,1 6,7 0,8 Z'));
      ctx.fillStyle = BLUE;
      ctx.fill(new Path2D('M -7,-2 C -3,-5 2,-5 4,-1 C 1,2 -4,2 -7,-2 Z'));
      ctx.fillStyle = RED;
      ctx.fill(new Path2D('M -8,6 L -15,12 L -9,11 L -12,16 L -4,9 Z'));
      ctx.fill(new Path2D('M 9,-8 L 14,-7 L 9,-5 Z'));
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(3, -7, 1.1, 0, 7); ctx.fill();
      ctx.restore();
    };

    if (kind < 9) { text(cx, 32, 30, INK, NUM_ZH[kind]); text(cx, 68, 32, RED, '萬'); return; }
    if (kind < 18) {
      const n = kind - 9 + 1;
      switch (n) {
        case 1: rosette(cx, 42, 22); break;
        case 2: dot(cx, 24, 11, BLUE); dot(cx, 60, 11, GREEN); break;
        case 3: dot(18, 20, 9.5, BLUE); dot(cx, 42, 9.5, RED); dot(42, 64, 9.5, GREEN); break;
        case 4: dot(19, 23, 9.5, BLUE); dot(41, 23, 9.5, GREEN); dot(19, 61, 9.5, GREEN); dot(41, 61, 9.5, BLUE); break;
        case 5: dot(17, 20, 8.5, BLUE); dot(43, 20, 8.5, GREEN); dot(cx, 42, 8.5, RED); dot(17, 64, 8.5, GREEN); dot(43, 64, 8.5, BLUE); break;
        case 6: dot(19, 18, 8, GREEN); dot(41, 18, 8, GREEN); dot(19, 45, 8, RED); dot(41, 45, 8, RED); dot(19, 68, 8, RED); dot(41, 68, 8, RED); break;
        case 7: dot(14, 14, 7, GREEN); dot(30, 20, 7, GREEN); dot(46, 26, 7, GREEN); dot(19, 48, 7.5, RED); dot(41, 48, 7.5, RED); dot(19, 68, 7.5, RED); dot(41, 68, 7.5, RED); break;
        case 8: for (let r = 0; r < 4; r++) { dot(19, 14 + r * 19, 7.5, BLUE); dot(41, 14 + r * 19, 7.5, BLUE); } break;
        case 9: { const cols = [14, 30, 46], colors = [GREEN, RED, BLUE]; for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) dot(cols[i], 18 + r * 24, 7.5, colors[r]); break; }
      }
      return;
    }
    if (kind < 27) {
      const n = kind - 18 + 1;
      switch (n) {
        case 1: bird(cx, 42, 2.5); break;
        case 2: stick(cx, 24, 24, BLUE); stick(cx, 60, 24, GREEN); break;
        case 3: stick(cx, 20, 22, BLUE); stick(19, 60, 22, GREEN); stick(41, 60, 22, GREEN); break;
        case 4: stick(20, 23, 24, BLUE); stick(40, 23, 24, GREEN); stick(20, 61, 24, GREEN); stick(40, 61, 24, BLUE); break;
        case 5: stick(17, 21, 22, GREEN); stick(43, 21, 22, BLUE); stick(cx, 42, 22, RED); stick(17, 63, 22, BLUE); stick(43, 63, 22, GREEN); break;
        case 6: for (let i = 0; i < 3; i++) { stick(16 + i * 14, 23, 22, GREEN); stick(16 + i * 14, 61, 22, GREEN); } break;
        case 7: stick(cx, 15, 18, RED); for (let i = 0; i < 3; i++) { stick(16 + i * 14, 44, 19, GREEN); stick(16 + i * 14, 69, 19, GREEN); } break;
        case 8: for (let i = 0; i < 4; i++) { stick(13 + i * 11.3, 23, 22, i % 2 ? GREEN : BLUE); stick(13 + i * 11.3, 61, 22, i % 2 ? BLUE : GREEN); } break;
        case 9: for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) stick(16 + i * 14, 17 + r * 25, 20, r === 1 ? RED : GREEN); break;
      }
      return;
    }
    if (kind < 31) { text(cx, 57, 44, INK, ['東', '南', '西', '北'][kind - 27]); return; }
    if (kind === 31) { text(cx, 57, 44, RED, '中'); return; }
    if (kind === 32) { text(cx, 57, 44, GREEN, '發'); return; }
    if (kind === 33) {
      ctx.strokeStyle = BLUE; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.roundRect(12, 14, 36, 56, 3); ctx.stroke();
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.roundRect(19, 22, 22, 40, 2); ctx.stroke();
      return;
    }
    const fi = kind - 34;
    const zh = ['春', '夏', '秋', '冬', '梅', '蘭', '竹', '菊'][fi];
    text(cx, 54, 36, fi < 4 ? RED : BLUE, zh);
    ctx.font = `700 14px ${KAI}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = RED;
    ctx.fillText(String((fi % 4) + 1), 8, 18);
  }

  // ================= textures =================
  const TEX = {};
  function canvasTex(w, h, draw, opts) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    draw(ctx, w, h);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    if (opts && opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(opts.repeat[0], opts.repeat[1]); }
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function ivoryBase(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
    g.addColorStop(0, '#fdf9ee'); g.addColorStop(0.55, '#f3ecd8'); g.addColorStop(1, '#e9dfc4');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // edge shading (fakes the rounded bevel)
    const e = ctx.createLinearGradient(0, 0, 0, h);
    ctx.strokeStyle = 'rgba(120,90,40,.28)'; ctx.lineWidth = Math.max(2, w * 0.03);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = Math.max(1, w * 0.012);
    ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
  }

  function buildTileTextures() {
    // faces
    TEX.face = {};
    for (let k = 0; k < 42; k++) {
      TEX.face[k] = canvasTex(192, 256, (ctx, w, h) => {
        ivoryBase(ctx, w, h);
        ctx.save();
        ctx.translate(6, 8);
        ctx.scale((w - 12) / 60, (h - 16) / 84);
        paintGlyph(ctx, k);
        ctx.restore();
      });
    }
    TEX.blankFace = canvasTex(192, 256, ivoryBase);
    TEX.back = canvasTex(192, 256, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
      g.addColorStop(0, '#8ba872'); g.addColorStop(0.55, '#6e8a58'); g.addColorStop(1, '#566e45');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // molded rounded grooves
      ctx.strokeStyle = 'rgba(40,70,30,.35)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(14, 14, w - 28, h - 28, 14); ctx.stroke();
      ctx.strokeStyle = 'rgba(220,240,205,.30)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(20, 20, w - 40, h - 40, 11); ctx.stroke();
      const hl = ctx.createRadialGradient(w * 0.4, h * 0.28, 10, w * 0.4, h * 0.28, w * 0.9);
      hl.addColorStop(0, 'rgba(255,255,255,.20)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(30,55,22,.5)'; ctx.lineWidth = 5;
      ctx.strokeRect(2.5, 2.5, w - 5, h - 5);
    });
    // sides: ivory / celadon split along tile thickness.
    // For BoxGeometry(w=W,h=D,d=H): ±x faces are D wide (u along -z?) and ±z faces D tall in v.
    // We build both orientations and assign empirically.
    TEX.sideV = canvasTex(64, 64, (ctx, w, h) => { // split along v (vertical)
      ctx.fillStyle = '#eee4c8'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#8ba374'; ctx.fillRect(0, 0, w, h * 0.48);
      ctx.fillStyle = 'rgba(120,90,40,.2)'; ctx.fillRect(0, 0, w, 3); ctx.fillRect(0, h - 3, w, 3);
    });
    TEX.sideVflip = canvasTex(64, 64, (ctx, w, h) => {
      ctx.fillStyle = '#eee4c8'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#8ba374'; ctx.fillRect(0, h * 0.52, w, h * 0.48);
      ctx.fillStyle = 'rgba(120,90,40,.2)'; ctx.fillRect(0, 0, w, 3); ctx.fillRect(0, h - 3, w, 3);
    });
  }

  function feltTexture() {
    return canvasTex(1024, 1024, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h * 0.44, 60, w / 2, h / 2, w * 0.75);
      g.addColorStop(0, '#2b9552'); g.addColorStop(0.55, '#1e8145'); g.addColorStop(1, '#136038');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // noise
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      let s = 12345;
      for (let i = 0; i < d.length; i += 4) {
        s = (s * 16807) % 2147483647;
        const n = ((s % 1000) / 1000 - 0.5) * 22;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
      // faint guide cross + hub ring
      ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(w / 2, 40); ctx.lineTo(w / 2, h - 40); ctx.moveTo(40, h / 2); ctx.lineTo(w - 40, h / 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(w / 2, h / 2, 165, 0, 7); ctx.stroke();
    });
  }

  function woodTexture(light) {
    return canvasTex(512, 512, (ctx, w, h) => {
      ctx.fillStyle = light ? '#b57c38' : '#9a692e';
      ctx.fillRect(0, 0, w, h);
      let s = 777;
      for (let i = 0; i < 46; i++) {
        s = (s * 16807) % 2147483647;
        const y0 = (s % w);
        const amp = 4 + (s % 14);
        const alpha = 0.05 + ((s >> 4) % 10) / 90;
        const tone = (s % 3 === 0) ? '255,225,170' : '80,45,10';
        ctx.strokeStyle = `rgba(${tone},${alpha})`;
        ctx.lineWidth = 1 + (s % 3);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 16) {
          const y = y0 + Math.sin(x / 53 + s) * amp;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // few knots
      for (let i = 0; i < 3; i++) {
        s = (s * 16807) % 2147483647;
        const kx = s % w, ky = (s >> 3) % h;
        ctx.strokeStyle = 'rgba(70,40,10,.25)';
        for (let r = 3; r < 14; r += 3) { ctx.beginPath(); ctx.arc(kx, ky, r, 0, 7); ctx.stroke(); }
      }
    }, { repeat: [1, 1] });
  }

  function floorTexture() {
    return canvasTex(1024, 1024, (ctx, w, h) => {
      ctx.fillStyle = '#c2a271'; ctx.fillRect(0, 0, w, h);
      const plank = w / 6;
      let s = 4242;
      for (let i = 0; i < 6; i++) {
        s = (s * 16807) % 2147483647;
        const tone = 12 - (s % 24);
        ctx.fillStyle = `rgb(${194 + tone},${162 + tone},${113 + tone})`;
        ctx.fillRect(i * plank + 2, 0, plank - 4, h);
        // straight, slightly wavy grain lines running along the plank
        for (let j = 0; j < 7; j++) {
          s = (s * 16807) % 2147483647;
          const gx = i * plank + 8 + (s % (plank - 16));
          ctx.strokeStyle = `rgba(120,85,40,${0.06 + (s % 7) / 110})`;
          ctx.lineWidth = 1 + (s % 2);
          ctx.beginPath();
          for (let y = 0; y <= h; y += 24) {
            const x = gx + Math.sin((y + s % 100) / 70) * 3;
            y === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        // butt joints
        const y1 = (s % 4) * (h / 4) + 30;
        ctx.fillStyle = 'rgba(90,60,25,.5)';
        ctx.fillRect(i * plank + 2, y1, plank - 4, 3);
      }
      for (let i = 0; i <= 6; i++) {
        ctx.fillStyle = 'rgba(90,60,25,.6)';
        ctx.fillRect(i * plank - 1.5, 0, 3, h);
      }
    }, { repeat: [2.4, 2.4] });
  }

  function cushionTexture() {
    return canvasTex(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#ece5d2'; ctx.fillRect(0, 0, w, h);
      const flower = (x, y, r, col) => {
        for (let i = 0; i < 5; i++) {
          const a = i * Math.PI * 2 / 5;
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.ellipse(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.42, r * 0.62, a, 0, 7);
          ctx.fill();
        }
        ctx.fillStyle = '#e8c23c';
        ctx.beginPath(); ctx.arc(x, y, r * 0.24, 0, 7); ctx.fill();
      };
      let s = 99;
      for (let i = 0; i < 9; i++) {
        s = (s * 16807) % 2147483647;
        flower((s % w), ((s >> 3) % h), 10 + s % 6, i % 2 ? '#c98a96' : '#8ea3c4');
        ctx.fillStyle = '#a8b890';
        ctx.beginPath(); ctx.arc(((s >> 5) % w), ((s >> 8) % h), 2.4, 0, 7); ctx.fill();
      }
    }, { repeat: [2, 2] });
  }

  function svgToTexture(svgString, px, py) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = px; c.height = py;
        c.getContext('2d').drawImage(img, 0, 0, px, py);
        const t = new THREE.CanvasTexture(c);
        t.encoding = THREE.sRGBEncoding;
        t.anisotropy = 4;
        resolve(t);
      };
      img.onerror = () => resolve(null);
      img.src = 'data:image/svg+xml,' + encodeURIComponent(svgString);
    });
  }

  // ================= three.js boot =================
  const canvas = $('c3d');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfd6d2);

  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.02, 60);

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  window.addEventListener('resize', onResize);
  onResize();

  // lights
  const hemi = new THREE.HemisphereLight(0xdfe8f0, 0x8a6a45, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe9c4, 1.15);
  sun.position.set(0.9, 2.6, -2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -1.9; sun.shadow.camera.right = 1.9;
  sun.shadow.camera.top = 2.2; sun.shadow.camera.bottom = -1.4;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 8;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  sun.target.position.set(0, 0.7, 0.2);
  scene.add(sun.target);
  const fill = new THREE.PointLight(0xffe0b0, 0.28, 6);
  fill.position.set(0, 2.4, 0.8);
  scene.add(fill);

  // ================= room =================
  const ROOM = { x: 2.6, zBack: 2.3, zWin: -2.35, h: 2.85 };

  function buildRoom() {
    buildTileTextures();
    const g = new THREE.Group();

    // floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.x * 2, ROOM.zBack - ROOM.zWin + 0.4),
      new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.75, metalness: 0.04 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, (ROOM.zBack + ROOM.zWin) / 2);
    floor.receiveShadow = true;
    g.add(floor);

    // ceiling
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.x * 2, ROOM.zBack - ROOM.zWin + 0.4),
      new THREE.MeshStandardMaterial({ color: 0xefe6d4, roughness: 1 })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, ROOM.h, (ROOM.zBack + ROOM.zWin) / 2);
    g.add(ceil);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe4d4b8, roughness: 1 });
    const mkWall = (w, h, x, y, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z);
      m.rotation.y = ry || 0;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    // back wall (behind player)
    mkWall(ROOM.x * 2, ROOM.h, 0, ROOM.h / 2, ROOM.zBack, Math.PI);
    // side walls
    mkWall(ROOM.zBack - ROOM.zWin, ROOM.h, -ROOM.x, ROOM.h / 2, (ROOM.zBack + ROOM.zWin) / 2, Math.PI / 2);
    mkWall(ROOM.zBack - ROOM.zWin, ROOM.h, ROOM.x, ROOM.h / 2, (ROOM.zBack + ROOM.zWin) / 2, -Math.PI / 2);

    // window wall: strips around a big opening (opening x -2.15..2.15, y 0.55..2.6)
    const wz = ROOM.zWin;
    const wseg = (w, h, x, y) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.1), wallMat);
      m.position.set(x, y, wz - 0.05);
      m.receiveShadow = true;
      g.add(m);
    };
    wseg(ROOM.x * 2, 0.55, 0, 0.275);                    // below sill
    wseg(ROOM.x * 2, ROOM.h - 2.6, 0, (ROOM.h + 2.6) / 2); // above lintel
    wseg(ROOM.x - 2.15 + ROOM.x, 2.05, -(2.15 + ROOM.x) / 2, 1.575); // left strip
    wseg(ROOM.x - 2.15 + ROOM.x, 2.05, (2.15 + ROOM.x) / 2, 1.575);  // right strip

    // window frames
    const alu = new THREE.MeshStandardMaterial({ color: 0xd8d5cc, roughness: 0.5, metalness: 0.35 });
    const bar = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), alu);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
    };
    bar(4.34, 0.09, 0.09, 0, 2.6, wz);       // lintel
    bar(4.34, 0.12, 0.16, 0, 0.55, wz);      // sill
    for (const mx of [-2.15, -1.28, -0.45, 0.45, 1.28, 2.15]) bar(0.07, 2.05, 0.07, mx, 1.575, wz);
    bar(1.7, 0.06, 0.06, -1.715, 1.72, wz);  // side transoms
    bar(1.7, 0.06, 0.06, 1.715, 1.72, wz);

    // glass
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(4.3, 2.05),
      new THREE.MeshStandardMaterial({ color: 0xdce8ee, transparent: true, opacity: 0.07, roughness: 0.15, metalness: 0.4 })
    );
    glass.position.set(0, 1.575, wz + 0.01);
    g.add(glass);

    // baseboards
    const bb = new THREE.MeshStandardMaterial({ color: 0x9a6a3a, roughness: 0.7 });
    for (const [w, x, z, ry] of [[ROOM.x * 2, 0, ROOM.zBack - 0.02, Math.PI], [ROOM.zBack - ROOM.zWin, -ROOM.x + 0.02, (ROOM.zBack + ROOM.zWin) / 2, Math.PI / 2], [ROOM.zBack - ROOM.zWin, ROOM.x - 0.02, (ROOM.zBack + ROOM.zWin) / 2, -Math.PI / 2]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, 0.02), bb);
      m.position.set(x, 0.045, z);
      m.rotation.y = ry;
      g.add(m);
    }

    // right lace curtain
    const curt = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 2.4, 24, 1),
      new THREE.MeshStandardMaterial({ color: 0xf4ecda, transparent: true, opacity: 0.85, roughness: 1, side: THREE.DoubleSide })
    );
    const pos = curt.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 14) * 0.05);
    curt.geometry.computeVertexNormals();
    curt.position.set(2.05, 1.55, wz + 0.14);
    g.add(curt);

    scene.add(g);
  }

  // city backdrop outside the window
  async function buildCity() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="795" viewBox="0 0 1340 520">${SCENE.cityScape()}</svg>`;
    const tex = await svgToTexture(svg, 2048, 795);
    if (!tex) return;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(10.4, 4.04),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    plane.position.set(0, 1.72, ROOM.zWin - 3.4);
    scene.add(plane);
  }

  // plants as crossed alpha planes
  async function spritePlant(svgInner, viewBox, wM, hM, x, z, opts) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="${viewBox}">${svgInner}</svg>`;
    const tex = await svgToTexture(svg, 512, 512);
    if (!tex) return null;
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1 });
    const grp = new THREE.Group();
    for (const ry of [0, Math.PI / 2]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), mat);
      m.rotation.y = ry + (opts && opts.yaw || 0);
      m.position.y = hM / 2 + (opts && opts.lift || 0);
      grp.add(m);
    }
    grp.position.set(x, (opts && opts.baseY) || 0, z);
    scene.add(grp);
    return grp;
  }

  function potMesh(x, z, r, h, color, baseY) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.76, h, 20), mat);
    m.position.set(x, (baseY || 0) + h / 2, z);
    m.castShadow = true;
    scene.add(m);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.06, r * 1.06, h * 0.16, 20), mat);
    rim.position.set(x, (baseY || 0) + h - h * 0.08, z);
    scene.add(rim);
  }

  function standMesh(x, z, h) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.5, metalness: 0.4 });
    const grp = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.008, 8, 24), mat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = h;
    grp.add(ring);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, h, 8), mat);
      leg.position.set(Math.cos(a) * 0.12, h / 2, Math.sin(a) * 0.12);
      leg.rotation.z = Math.cos(a) * 0.12;
      leg.rotation.x = -Math.sin(a) * 0.12;
      grp.add(leg);
    }
    grp.position.set(x, 0, z);
    scene.add(grp);
  }

  async function buildPlants() {
    const S = SCENE;
    // three flowering stands along the window
    const stands = [
      { x: -1.55, z: -1.95, svg: S.hibiscus(0, 0, 1.0, '#d9536b'), vb: '-70 -150 140 155', w: 0.62, h: 0.68 },
      { x: 0.0, z: -2.0, svg: S.hibiscus(0, 0, 1.0, '#e0a13e'), vb: '-70 -150 140 155', w: 0.58, h: 0.64 },
      { x: 1.5, z: -1.95, svg: S.hibiscus(0, 0, 1.0, '#d9536b'), vb: '-70 -150 140 155', w: 0.6, h: 0.66 },
    ];
    for (const st of stands) {
      standMesh(st.x, st.z, 0.72);
      potMesh(st.x, st.z, 0.085, 0.14, 0x31302c, 0.72);
      await spritePlant(st.svg, st.vb, st.w, st.h, st.x, st.z, { baseY: 0.84 });
    }
    // left shelf rack with small pots
    const shelfMat = new THREE.MeshStandardMaterial({ color: 0xdad7ce, roughness: 0.6, metalness: 0.2 });
    for (let i = 0; i < 3; i++) {
      const sh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.025, 0.3), shelfMat);
      sh.position.set(-2.15, 0.42 + i * 0.42, -1.6);
      sh.castShadow = true;
      scene.add(sh);
    }
    for (const px of [-2.35, -1.95]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.35, 0.03), shelfMat);
      post.position.set(px, 0.675, -1.6);
      scene.add(post);
    }
    for (let i = 0; i < 3; i++) {
      for (const dx of [-0.22, 0.14]) {
        potMesh(-2.15 + dx, -1.6, 0.055, 0.09, i % 2 ? 0xa65b3f : 0x31302c, 0.445 + i * 0.42);
        await spritePlant(S.jadePlant(0, 0, 1.1), '-45 -55 90 60', 0.26, 0.18, -2.15 + dx, -1.6, { baseY: 0.53 + i * 0.42 });
      }
    }
    // right: tall palm + bamboo + jade
    potMesh(1.95, -1.7, 0.17, 0.3, 0x31302c);
    await spritePlant(S.palm(0, 0, 1.5, false), '-190 -260 380 270', 1.7, 1.25, 1.95, -1.7, { baseY: 0.26 });
    potMesh(2.25, -1.15, 0.12, 0.2, 0xa65b3f);
    await spritePlant(
      `${['-10', '2', '12'].map(dx => `<path d="M${dx},0 C ${dx},-90 ${+dx + 6},-180 ${+dx + 2},-250" stroke="#5a7a42" stroke-width="5" fill="none"/>`).join('')}
       ${S.leafCluster(-4, -190, 8, 26, 24, '#4a7040', '#5c8a4e')}${S.leafCluster(14, -250, 8, 24, 22, '#42663a', '#54804a')}${S.leafCluster(4, -120, 7, 22, 20, '#4a7040', '#5c8a4e')}`,
      '-60 -280 120 285', 0.6, 1.45, 2.25, -1.15, { baseY: 0.18 });
    potMesh(-2.4, 0.35, 0.1, 0.16, 0xa65b3f);
    await spritePlant(S.jadePlant(0, 0, 1.6), '-55 -70 110 75', 0.42, 0.3, -2.4, 0.35, { baseY: 0.15 });
    // a framed print on the west wall
    const frameG = new THREE.Group();
    const pFrame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.86, 0.66),
      new THREE.MeshStandardMaterial({ map: TEX.wood, roughness: 0.6 }));
    frameG.add(pFrame);
    const print = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.76),
      new THREE.MeshStandardMaterial({
        map: canvasTex(256, 340, (ctx, w, h) => {
          ctx.fillStyle = '#e9e2cc'; ctx.fillRect(0, 0, w, h);
          const g2 = ctx.createLinearGradient(0, 0, 0, h * 0.6);
          g2.addColorStop(0, '#dfe6e2'); g2.addColorStop(1, '#e9e2cc');
          ctx.fillStyle = g2; ctx.fillRect(0, 0, w, h * 0.6);
          ctx.fillStyle = '#8ba181'; ctx.beginPath();
          ctx.moveTo(0, h * 0.62); ctx.quadraticCurveTo(w * 0.3, h * 0.44, w * 0.55, h * 0.58);
          ctx.quadraticCurveTo(w * 0.8, h * 0.7, w, h * 0.60); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill();
          ctx.fillStyle = '#5d7c58'; ctx.beginPath();
          ctx.moveTo(0, h * 0.78); ctx.quadraticCurveTo(w * 0.4, h * 0.62, w, h * 0.8); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill();
          ctx.fillStyle = '#c86b52'; ctx.beginPath(); ctx.arc(w * 0.72, h * 0.3, 22, 0, 7); ctx.fill();
        }), roughness: 0.9,
      }));
    print.rotation.y = Math.PI / 2;
    print.position.x = 0.035;
    frameG.add(print);
    frameG.position.set(-2.58, 1.6, 0.3);
    scene.add(frameG);
    // cabinet right back
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.34),
      new THREE.MeshStandardMaterial({ map: TEX.wood, roughness: 0.65 }));
    cab.position.set(2.3, 0.31, 0.6);
    cab.castShadow = true;
    scene.add(cab);
  }

  // ================= the automatic table =================
  const TBL = {
    feltY: 0.752,       // felt surface height
    railTop: 0.768,     // rail top surface
    railW: 0.086,
    feltHalf: 0.437,    // felt half-extent
    outerHalf: 0.523,
    hubR: 0.118,
  };
  const hub = { canvas: null, ctx: null, tex: null, wind: '東', count: 84 };
  const turnLEDs = [];
  let hubBtnMesh = null;
  const diceMeshes = [];

  function roundedRectShape(half, r) {
    const s = new THREE.Shape();
    s.moveTo(-half + r, -half);
    s.lineTo(half - r, -half); s.absarc(half - r, -half + r, r, -Math.PI / 2, 0);
    s.lineTo(half, half - r); s.absarc(half - r, half - r, r, 0, Math.PI / 2);
    s.lineTo(-half + r, half); s.absarc(-half + r, half - r, r, Math.PI / 2, Math.PI);
    s.lineTo(-half, -half + r); s.absarc(-half + r, -half + r, r, Math.PI, Math.PI * 1.5);
    return s;
  }

  function buildTable() {
    TEX.wood = woodTexture(true);
    const woodMat = new THREE.MeshStandardMaterial({ map: TEX.wood, roughness: 0.55, metalness: 0.05 });
    const darkWood = new THREE.MeshStandardMaterial({ map: woodTexture(false), roughness: 0.6 });
    const g = new THREE.Group();

    // rails: extruded frame (outer rounded rect minus felt hole)
    const frame = roundedRectShape(TBL.outerHalf, 0.055);
    frame.holes.push(new THREE.Path(roundedRectShape(TBL.feltHalf, 0.02).getPoints(24).reverse()));
    const railGeo = new THREE.ExtrudeGeometry(frame, { depth: 0.045, bevelEnabled: true, bevelThickness: 0.007, bevelSize: 0.007, bevelSegments: 2, curveSegments: 24 });
    const rail = new THREE.Mesh(railGeo, woodMat);
    rail.rotation.x = -Math.PI / 2;
    rail.position.y = TBL.railTop - 0.045;
    rail.castShadow = true; rail.receiveShadow = true;
    g.add(rail);

    // felt
    const felt = new THREE.Mesh(
      new THREE.PlaneGeometry(TBL.feltHalf * 2, TBL.feltHalf * 2),
      new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 })
    );
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = TBL.feltY;
    felt.receiveShadow = true;
    g.add(felt);

    // body: apron box + drawers + legs
    const apron = new THREE.Mesh(new THREE.BoxGeometry(TBL.outerHalf * 2 - 0.05, 0.15, TBL.outerHalf * 2 - 0.05), woodMat);
    apron.position.y = TBL.feltY - 0.11;
    apron.castShadow = true;
    g.add(apron);
    for (let s = 0; s < 4; s++) {
      const dr = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.02), darkWood);
      const a = s * Math.PI / 2;
      dr.position.set(Math.sin(a) * (TBL.outerHalf - 0.015), TBL.feltY - 0.10, Math.cos(a) * (TBL.outerHalf - 0.015));
      dr.rotation.y = a;
      g.add(dr);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xd9b878, roughness: 0.4, metalness: 0.4 }));
      knob.position.set(Math.sin(a) * (TBL.outerHalf + 0.0), TBL.feltY - 0.10, Math.cos(a) * (TBL.outerHalf + 0.0));
      g.add(knob);
    }
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.075, TBL.feltY - 0.18, 0.075), woodMat);
      leg.position.set(lx * (TBL.outerHalf - 0.09), (TBL.feltY - 0.18) / 2, lz * (TBL.outerHalf - 0.09));
      leg.castShadow = true;
      g.add(leg);
    }
    // centre pedestal (machine housing)
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.5, TBL.feltY - 0.2, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x3a2c1a, roughness: 0.8 }));
    ped.position.y = (TBL.feltY - 0.2) / 2;
    g.add(ped);

    // hub: black ring + panel with dynamic LED texture
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1a, roughness: 0.35, metalness: 0.3 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(TBL.hubR, TBL.hubR, 0.014, 48), ringMat);
    ring.position.y = TBL.feltY + 0.004;
    g.add(ring);

    hub.canvas = document.createElement('canvas');
    hub.canvas.width = hub.canvas.height = 512;
    hub.ctx = hub.canvas.getContext('2d');
    hub.tex = new THREE.CanvasTexture(hub.canvas);
    hub.tex.encoding = THREE.sRGBEncoding;
    drawHub();
    const panel = new THREE.Mesh(
      new THREE.CircleGeometry(TBL.hubR - 0.017, 48),
      new THREE.MeshBasicMaterial({ map: hub.tex })
    );
    panel.rotation.x = -Math.PI / 2;
    panel.rotation.z = Math.PI;   // LED text reads correctly from the player's seat
    panel.position.y = TBL.feltY + 0.0115;
    g.add(panel);

    // red start button (3D, clickable)
    hubBtnMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.019, 0.021, 0.01, 24),
      new THREE.MeshStandardMaterial({ color: 0xc62f1d, emissive: 0x881105, emissiveIntensity: 0.55, roughness: 0.35 })
    );
    hubBtnMesh.position.set(0, TBL.feltY + 0.016, TBL.hubR * 0.56);
    g.add(hubBtnMesh);

    // dice (two small)
    const pip = n => canvasTex(96, 96, (ctx, w, h) => {
      ctx.fillStyle = '#f6f4ea'; ctx.fillRect(0, 0, w, h);
      const P = { 1: [[48, 48]], 2: [[30, 30], [66, 66]], 3: [[27, 27], [48, 48], [69, 69]], 4: [[30, 30], [66, 30], [30, 66], [66, 66]], 5: [[27, 27], [69, 27], [48, 48], [27, 69], [69, 69]], 6: [[30, 26], [66, 26], [30, 48], [66, 48], [30, 70], [66, 70]] }[n];
      for (const [x, y] of P) { ctx.fillStyle = n === 1 ? '#c03a2e' : '#2b3038'; ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.fill(); }
    });
    const dieMats = [3, 4, 1, 6, 2, 5].map(n => new THREE.MeshStandardMaterial({ map: pip(n), roughness: 0.3 }));
    for (const dx of [-0.02, 0.02]) {
      const die = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.016), dieMats);
      die.position.set(dx, TBL.feltY + 0.02, -TBL.hubR * 0.5);
      g.add(die);
      diceMeshes.push(die);
    }

    // 4 turn LEDs on the ring
    for (let s = 0; s < 4; s++) {
      const led = new THREE.Mesh(
        new THREE.CircleGeometry(0.008, 16),
        new THREE.MeshBasicMaterial({ color: 0x224228 })
      );
      led.rotation.x = -Math.PI / 2;
      const a = s * Math.PI / 2;
      led.position.set(Math.sin(a) * (TBL.hubR - 0.008), TBL.feltY + 0.012, Math.cos(a) * (TBL.hubR - 0.008));
      g.add(led);
      turnLEDs.push(led);
    }
    scene.add(g);
  }

  function drawHub() {
    const ctx = hub.ctx, W = 512;
    ctx.clearRect(0, 0, W, W);
    const bg = ctx.createRadialGradient(W * 0.42, W * 0.34, 30, W / 2, W / 2, W * 0.55);
    bg.addColorStop(0, '#23262a'); bg.addColorStop(0.6, '#101214'); bg.addColorStop(1, '#1a1c1f');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(W / 2, W / 2, W / 2, 0, 7); ctx.fill();
    // count (big, centre) + round wind above it — canvas top faces the player
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff3b28';
    ctx.font = `700 120px ui-monospace, Menlo, monospace`;
    ctx.shadowColor = 'rgba(255,60,30,.9)'; ctx.shadowBlur = 24;
    ctx.fillText(String(hub.count).padStart(2, '0'), W / 2, 300);
    ctx.fillStyle = '#ff5540';
    ctx.font = `700 88px ${KAI}`;
    ctx.shadowBlur = 20;
    ctx.fillText(hub.wind, W / 2, 168);
    ctx.shadowBlur = 0;
    hub.tex.needsUpdate = true;
  }

  function setHub(wind, count) {
    hub.wind = wind; hub.count = count;
    drawHub();
  }

  // ================= chairs =================
  function buildChair(angle, dist) {
    const woodMat = new THREE.MeshStandardMaterial({ map: TEX.wood, roughness: 0.6 });
    const g = new THREE.Group();
    const seatH = 0.455, seatW = 0.44, seatD = 0.42;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(seatW, 0.035, seatD), woodMat);
    seat.position.y = seatH;
    seat.castShadow = true;
    g.add(seat);
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(seatW - 0.03, 0.035, seatD - 0.03),
      new THREE.MeshStandardMaterial({ map: cushionTexture(), roughness: 1 }));
    cushion.position.y = seatH + 0.035;
    g.add(cushion);
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.017, seatH, 10), woodMat);
      leg.position.set(lx * (seatW / 2 - 0.03), seatH / 2, lz * (seatD / 2 - 0.03));
      leg.castShadow = true;
      g.add(leg);
    }
    // ladder back (at -z side of chair, i.e. away from table since chair faces +z toward table)
    for (const sx of [-1, 1]) {
      const stile = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.62, 0.03), woodMat);
      stile.position.set(sx * (seatW / 2 - 0.025), seatH + 0.31, -seatD / 2 + 0.015);
      stile.castShadow = true;
      g.add(stile);
    }
    for (let i = 0; i < 3; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(seatW - 0.05, i === 0 ? 0.07 : 0.05, 0.02), woodMat);
      slat.position.set(0, seatH + 0.55 - i * 0.14, -seatD / 2 + 0.015);
      g.add(slat);
    }
    g.position.set(Math.sin(angle) * dist, 0, Math.cos(angle) * dist);
    g.rotation.y = angle + Math.PI;   // face the table
    scene.add(g);
    return g;
  }

  // ================= tiles =================
  const TILE = { W: 0.0375, H: 0.050, D: 0.021 };
  const tileGeo = new THREE.BoxGeometry(TILE.W, TILE.D, TILE.H);
  const sideMatX = new THREE.MeshStandardMaterial({ map: null, roughness: 0.25 });
  const matCache = {};

  function tileMaterials(kind, faceUp) {
    const key = kind == null ? 'blank' : kind;
    if (!matCache[key]) {
      const face = new THREE.MeshStandardMaterial({
        map: kind == null ? TEX.blankFace : TEX.face[kind], roughness: 0.28, metalness: 0.02,
      });
      const back = new THREE.MeshStandardMaterial({ map: TEX.back, roughness: 0.32 });
      const sideX = new THREE.MeshStandardMaterial({ map: TEX.sideV, roughness: 0.28 });
      const sideZ = new THREE.MeshStandardMaterial({ map: TEX.sideV, roughness: 0.28 });
      matCache[key] = [sideX, sideX, face, back, sideZ, sideZ];
    }
    return matCache[key];
  }

  function makeTile(kind, faceUp) {
    const mesh = new THREE.Mesh(tileGeo, tileMaterials(kind, faceUp));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // orientation helpers (within a seat group: +z toward the seat owner)
  function poseFlatUp(m) { m.rotation.set(0, 0, 0); m.quaternion.setFromEuler(m.rotation); }
  function poseFlatDown(m) { m.rotation.set(0, 0, Math.PI); m.quaternion.setFromEuler(m.rotation); }
  const _standEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _rollQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  function poseStanding(m, lean) {
    // face toward +z (the owner), glyph upright, slight backward lean
    _standEuler.set(-Math.PI / 2 + (lean || 0), Math.PI, 0);
    m.quaternion.setFromEuler(_standEuler);
    m.quaternion.multiply(_rollQ); // 180° about the face normal so the glyph reads upright
  }

  // ================= zones & layout =================
  const seatG = [];
  function buildSeatGroups() {
    for (let s = 0; s < 4; s++) {
      const g = new THREE.Group();
      g.rotation.y = s * Math.PI / 2;
      scene.add(g);
      const zones = {};
      for (const z of ['hand', 'wall', 'discards', 'melds', 'flowers']) {
        zones[z] = new THREE.Group();
        g.add(zones[z]);
      }
      seatG.push({ group: g, zones });
    }
  }

  const LAYOUT = {
    handZ: 0.372, handLean: 0.30, handGap: 0.0398,
    wallZ: 0.302, wallGap: 0.0385,
    discRows: [0.140, 0.191, 0.242], discGap: 0.0398, discCols: 9,
    meldZ: 0.404, flowerZ: 0.404,
  };

  function clearZone(seat, zone) {
    const z = seatG[seat].zones[zone];
    while (z.children.length) z.remove(z.children[0]);
  }

  let handMeshes = [];        // my clickable tiles
  let raisedKindIdx = -1;     // index within hand order that is raised
  let lastDiscardMesh = null;

  function layoutHand(seat) {
    clearZone(seat, 'hand');
    const zone = seatG[seat].zones.hand;
    const p = game.players[seat];
    if (!p) return;
    const mine = seat === 0;
    const hand = p.hand.slice();
    let drawn = null;
    if (mine && game.drawnKind != null && game.turn === 0) {
      const idx = hand.indexOf(game.drawnKind);
      if (idx >= 0) { drawn = game.drawnKind; hand.splice(idx, 1); }
    }
    const n = hand.length + (drawn != null ? 1 : 0);
    const gap = LAYOUT.handGap;
    const total = (n - 1) * gap + (drawn != null ? 0.014 : 0);
    if (mine) handMeshes = [];
    const yBase = TBL.feltY + TILE.H / 2 - 0.001;
    hand.forEach((k, i) => {
      const m = makeTile(mine ? k : null, true);
      poseStanding(m, LAYOUT.handLean);
      m.position.set(-total / 2 + i * gap, yBase, LAYOUT.handZ);
      m.userData = { kind: k, handIdx: i, mine };
      zone.add(m);
      if (mine) handMeshes.push(m);
    });
    if (drawn != null) {
      const m = makeTile(drawn, true);
      poseStanding(m, LAYOUT.handLean);
      m.position.set(-total / 2 + hand.length * gap + 0.014, yBase, LAYOUT.handZ);
      m.userData = { kind: drawn, handIdx: hand.length, mine };
      zone.add(m);
      if (mine) handMeshes.push(m);
    }
    if (mine && raisedKindIdx >= 0 && raisedKindIdx < handMeshes.length) {
      handMeshes[raisedKindIdx].position.y += 0.016;
    }
  }

  function layoutDiscards(seat) {
    clearZone(seat, 'discards');
    const zone = seatG[seat].zones.discards;
    const ds = game.players[seat].discards;
    const C = LAYOUT.discCols;
    ds.forEach((k, i) => {
      // rows of 9; anything past 27 keeps extending the last row to the right
      const row = Math.min(Math.floor(i / C), 2);
      const col = row < 2 ? i % C : i - 2 * C;
      const m = makeTile(k, true);
      poseFlatUp(m);
      m.position.set(
        -(C - 1) / 2 * LAYOUT.discGap + col * LAYOUT.discGap,
        TBL.feltY + TILE.D / 2,
        LAYOUT.discRows[row]);
      zone.add(m);
      const isLast = game.lastDiscard && game.lastDiscard.seat === seat &&
        i === ds.length - 1 && k === game.lastDiscard.kind;
      if (isLast) {
        lastDiscardMesh = m;
        m.material = m.material.slice();
        m.material[2] = m.material[2].clone();
        m.material[2].emissive = new THREE.Color(0x8a6a10);
        m.material[2].emissiveIntensity = 0.55;
      }
    });
  }

  function layoutMelds(seat) {
    clearZone(seat, 'melds');
    clearZone(seat, 'flowers');
    const mz = seatG[seat].zones.melds;
    const fz = seatG[seat].zones.flowers;
    const p = game.players[seat];
    let xr = 0.415;
    for (const meld of p.melds) {
      const n = meld.tiles.length;
      meld.tiles.forEach((k, i) => {
        const hidden = meld.type === 'angang' && (i === 1 || i === 2);
        const m = makeTile(hidden ? null : k, !hidden);
        hidden ? poseFlatDown(m) : poseFlatUp(m);
        m.position.set(xr - (n - 1 - i) * (TILE.W + 0.001) - TILE.W / 2, TBL.feltY + TILE.D / 2, LAYOUT.meldZ);
        mz.add(m);
      });
      xr -= n * (TILE.W + 0.001) + 0.014;
    }
    let xf = -0.415;
    for (const k of p.flowers) {
      const m = makeTile(k, true);
      poseFlatUp(m);
      m.scale.setScalar(0.85);
      m.position.set(xf + TILE.W / 2, TBL.feltY + TILE.D / 2, LAYOUT.flowerZ);
      fz.add(m);
      xf += TILE.W * 0.85 + 0.004;
    }
  }

  let wallFront = 0, wallBack = 0;
  function layoutWalls(animate) {
    const startG = game.dealer * 18;
    const fcStacks = Math.floor(wallFront / 2), fcHalf = wallFront % 2;
    const bcStacks = Math.floor(wallBack / 2), bcHalf = wallBack % 2;
    for (let side = 0; side < 4; side++) {
      clearZone(side, 'wall');
      const zone = seatG[side].zones.wall;
      for (let pos = 0; pos < 18; pos++) {
        const gIdx = side * 18 + pos;
        const d = (gIdx - startG + 72) % 72;
        const e = 71 - d;
        let tiles = 2;
        if (d < fcStacks) tiles = 0;
        else if (d === fcStacks && fcHalf) tiles = 1;
        if (tiles > 0) {
          if (e < bcStacks) tiles = 0;
          else if (e === bcStacks && bcHalf && tiles === 2) tiles = 1;
        }
        if (!tiles) continue;
        const x = -(18 - 1) / 2 * LAYOUT.wallGap + pos * LAYOUT.wallGap;
        for (let lvl = 0; lvl < tiles; lvl++) {
          const m = makeTile(null, false);
          poseFlatDown(m);
          const y = TBL.feltY + TILE.D / 2 + lvl * (TILE.D + 0.0005);
          m.position.set(x, y, LAYOUT.wallZ);
          zone.add(m);
          if (animate) {
            m.position.y = y - 0.06;
            tween(m.position, { y }, 420, pos * 14 + side * 60, easeOut);
          }
        }
      }
    }
  }

  // ================= tweens =================
  const tweens = [];
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function tween(obj, to, dur, delay, ease, onDone) {
    const from = {};
    for (const k in to) from[k] = obj[k];
    tweens.push({ obj, from, to, t0: performance.now() + (delay || 0), dur, ease: ease || easeOut, onDone });
  }
  function stepTweens(now) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (now < tw.t0) continue;
      const t = Math.min(1, (now - tw.t0) / tw.dur);
      const e = tw.ease(t);
      for (const k in tw.to) tw.obj[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * e;
      if (t >= 1) { tweens.splice(i, 1); tw.onDone && tw.onDone(); }
    }
  }

  // ================= camera / controls =================
  const SEAT_POS = new THREE.Vector3(0, 1.17, 1.06);
  const SEAT_TARGET = new THREE.Vector3(0, 0.72, -0.10);
  let mode = 'seated';           // 'seated' | 'walk'
  let yaw = 0, pitch = 0;        // walk-mode look
  let seatYaw = 0, seatPitch = 0; // seated look offset (drag)
  let seatDolly = 0;
  const keys = {};
  let dragging = false, dragMoved = false, dragPixels = 0, lastPX = 0, lastPY = 0;
  function clearKeys() { for (const k in keys) keys[k] = false; }
  function overlayOpen() { return !!document.querySelector('.overlay.show'); }

  function seatBaseAngles() {
    const dir = SEAT_TARGET.clone().sub(SEAT_POS).normalize();
    return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(dir.y) };
  }
  const seatBase = { yaw: Math.PI, pitch: -0.42 }; // computed properly below

  function applySeatedCamera() {
    const base = seatBaseAngles();
    const cy = base.yaw + seatYaw;
    const cp = Math.max(-1.2, Math.min(0.5, base.pitch + seatPitch));
    const pos = SEAT_POS.clone();
    // dolly along view dir
    const dir = new THREE.Vector3(-Math.sin(cy) * Math.cos(cp), Math.sin(cp), -Math.cos(cy) * Math.cos(cp));
    pos.addScaledVector(dir, seatDolly);
    camera.position.copy(pos);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(cp, cy, 0);
  }

  function applyWalkCamera(dt) {
    const speed = 1.7 * dt;
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const move = new THREE.Vector3();
    if (keys['KeyW'] || keys['ArrowUp']) move.add(f);
    if (keys['KeyS'] || keys['ArrowDown']) move.sub(f);
    if (keys['KeyA'] || keys['ArrowLeft']) move.sub(r);
    if (keys['KeyD'] || keys['ArrowRight']) move.add(r);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      const nx = camera.position.x + move.x;
      const nz = camera.position.z + move.z;
      // room bounds
      const cl = v => Math.max(-ROOM.x + 0.25, Math.min(ROOM.x - 0.25, v));
      const czl = v => Math.max(ROOM.zWin + 0.3, Math.min(ROOM.zBack - 0.25, v));
      let tx = cl(nx), tz = czl(nz);
      // table AABB block (0.75 half + margin)
      const bx = 0.78, bz = 0.78;
      if (Math.abs(tx) < bx && Math.abs(tz) < bz) {
        if (Math.abs(camera.position.x) >= bx) tx = Math.sign(camera.position.x) * bx;
        else if (Math.abs(camera.position.z) >= bz) tz = Math.sign(camera.position.z) * bz;
        else { tx = camera.position.x; tz = camera.position.z; }
      }
      camera.position.x = tx;
      camera.position.z = tz;
    }
    camera.position.y = 1.62;
    camera.rotation.order = 'YXZ';
    camera.rotation.set(pitch, yaw, 0);
  }

  function enterWalk() {
    if (mode === 'walk') return;
    mode = 'walk';
    dragging = false; dragMoved = false;
    document.body.classList.add('walkmode');
    canvas.classList.add('walk');
    yaw = seatBaseAngles().yaw + seatYaw;
    pitch = Math.max(-0.5, seatBaseAngles().pitch + seatPitch + 0.25);
    tryPointerLock();
    $('btnStand').textContent = '坐下（V）';
    msg('WASD 走动 · 鼠标转头 · V 坐回', 3000);
  }
  function tryPointerLock() {
    try {
      const p = canvas.requestPointerLock && canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
  function exitWalk() {
    if (mode === 'seated') return;
    mode = 'seated';
    document.body.classList.remove('walkmode');
    canvas.classList.remove('walk');
    document.exitPointerLock && document.exitPointerLock();
    seatYaw = 0; seatPitch = 0; seatDolly = 0;
    $('btnStand').textContent = '起身 走动';
  }
  function toggleWalk() { mode === 'seated' ? enterWalk() : exitWalk(); }

  document.addEventListener('pointerlockchange', () => {
    clearKeys();
    if (!document.pointerLockElement && mode === 'walk') {
      // user pressed Esc — sit back down
      exitWalk();
    }
  });
  window.addEventListener('blur', clearKeys);
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (overlayOpen()) return;
    if (e.code === 'KeyV') toggleWalk();
    if (e.code === 'KeyR' && mode === 'seated') { seatYaw = 0; seatPitch = 0; seatDolly = 0; }
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousemove', e => {
    if (mode === 'walk') {
      yaw -= e.movementX * 0.0023;
      pitch = Math.max(-1.3, Math.min(1.3, pitch - e.movementY * 0.0023));
      return;
    }
    if (dragging) {
      if (!(e.buttons & 1)) { dragging = false; return; } // mouseup was lost (left the window)
      dragPixels += Math.abs(e.clientX - lastPX) + Math.abs(e.clientY - lastPY);
      if (dragPixels > 4) dragMoved = true;
      seatYaw -= (e.clientX - lastPX) * 0.0032;
      seatPitch -= (e.clientY - lastPY) * 0.0032;
      seatYaw = Math.max(-2.4, Math.min(2.4, seatYaw));
      seatPitch = Math.max(-0.5, Math.min(0.9, seatPitch));
      lastPX = e.clientX; lastPY = e.clientY;
    } else {
      hoverPick(e);
    }
  });
  canvas.addEventListener('mousedown', e => {
    if (mode === 'walk' || e.button !== 0) return;
    dragging = true; dragMoved = false; dragPixels = 0;
    lastPX = e.clientX; lastPY = e.clientY;
  });
  window.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    if (mode === 'walk') { dragging = false; return; }
    const wasDrag = dragMoved;
    dragging = false; dragMoved = false;
    if (!wasDrag && e.target === canvas) clickPick(e);
  });
  canvas.addEventListener('click', e => {
    if (mode !== 'walk') return;
    if (document.pointerLockElement) clickPickCenter();
    else {
      // lock was refused or dropped: pick where the cursor actually is, then retry the lock
      handleRayClick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      tryPointerLock();
    }
  });
  canvas.addEventListener('wheel', e => {
    if (mode !== 'seated') return;
    seatDolly = Math.max(-0.1, Math.min(0.3, seatDolly + e.deltaY * -0.0004));
  }, { passive: true });

  // ================= picking =================
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoverMesh = null;

  function pickAt(nx, ny, targets) {
    ndc.set(nx, ny);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(targets, false);
    return hits.length ? hits[0].object : null;
  }

  function hoverPick(e) {
    if (!discardMode || !handMeshes.length) { setHover(null); return; }
    const m = pickAt((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1, handMeshes);
    setHover(m);
  }

  function setHover(m) {
    if (hoverMesh === m) return;
    if (hoverMesh && handMeshes.indexOf(hoverMesh) !== raisedKindIdx) {
      const i = handMeshes.indexOf(hoverMesh);
      if (i >= 0 && i !== raisedKindIdx) tween(hoverMesh.position, { y: TBL.feltY + TILE.H / 2 - 0.001 }, 120);
    }
    hoverMesh = m;
    canvas.style.cursor = m ? 'pointer' : 'default';
    if (m) {
      const i = handMeshes.indexOf(m);
      if (i !== raisedKindIdx) tween(m.position, { y: TBL.feltY + TILE.H / 2 - 0.001 + 0.008 }, 120);
    }
  }

  function clickPick(e) {
    const nx = (e.clientX / innerWidth) * 2 - 1;
    const ny = -(e.clientY / innerHeight) * 2 + 1;
    handleRayClick(nx, ny);
  }
  function clickPickCenter() { handleRayClick(0, 0); }

  function handleRayClick(nx, ny) {
    if ($('help').classList.contains('show')) return; // no blind picks behind the help card
    // hub button first
    if (hubBtnMesh) {
      const b = pickAt(nx, ny, [hubBtnMesh]);
      if (b) { hubButtonPress(); return; }
    }
    if (!discardMode || !handMeshes.length) return;
    const m = pickAt(nx, ny, handMeshes);
    if (!m) return;
    const i = handMeshes.indexOf(m);
    AU.play('button');
    if (i === raisedKindIdx) {
      const kind = m.userData.kind;
      raisedKindIdx = -1;
      const resolve = humanResolve;
      humanResolve = null; humanReject = null;
      discardMode = false;
      hideActions();
      resolve && resolve(kind);
    } else {
      if (raisedKindIdx >= 0 && handMeshes[raisedKindIdx]) {
        tween(handMeshes[raisedKindIdx].position, { y: TBL.feltY + TILE.H / 2 - 0.001 }, 120);
      }
      raisedKindIdx = i;
      tween(m.position, { y: TBL.feltY + TILE.H / 2 - 0.001 + 0.016 }, 120);
    }
  }

  function hubButtonPress() {
    AU.play('button');
    tween(hubBtnMesh.position, { y: TBL.feltY + 0.011 }, 70, 0, easeOut, () => {
      tween(hubBtnMesh.position, { y: TBL.feltY + 0.016 }, 90);
    });
    if ($('intro').classList.contains('show')) { $('btnStart').click(); return; }
    if ($('result').classList.contains('show')) {
      const b = $('btnNext') || $('btnAgain');
      b && b.click();
    }
  }

  // ================= audio (same voice as the 2D build) =================
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
      draw()    { const t = ctx.currentTime; burst(t, 0.05, 2600, 1.2, 0.25); },
      discard() { const t = ctx.currentTime; burst(t, 0.045, 2100, 1, 0.5); tone(t, 190, 0.07, 0.3); burst(t + 0.03, 0.06, 3200, 1.5, 0.3); },
      claim()   { const t = ctx.currentTime; burst(t, 0.07, 1600, 0.8, 0.65); tone(t, 150, 0.09, 0.4); },
      button()  { const t = ctx.currentTime; burst(t, 0.03, 3600, 2, 0.2); },
      dice()    { const t = ctx.currentTime; for (let i = 0; i < 4; i++) burst(t + i * 0.09 + Math.random() * 0.02, 0.04, 2400 + i * 300, 1.4, 0.3); },
      win()     { const t = ctx.currentTime; [523, 659, 784, 880, 1047].forEach((f, i) => tone(t + i * 0.11, f, 0.5, 0.22, 'triangle')); },
      lose()    { const t = ctx.currentTime; [392, 330, 262].forEach((f, i) => tone(t + i * 0.14, f, 0.4, 0.18, 'triangle')); },
      shuffle() {
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

  // ================= HUD =================
  const NAMES = ['你', '老王', '張姨', '小陳'];
  const WIND_ZH = ['東', '南', '西', '北'];

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
      { left: '50%', bottom: '260px', transform: 'translateX(-50%)' },
      { right: '160px', top: '42%' },
      { left: '50%', top: '160px', transform: 'translateX(-50%)' },
      { left: '160px', top: '42%' },
    ][seat];
    Object.assign(el.style, pos);
    el.textContent = text;
    $('hud').appendChild(el);
    setTimeout(() => el.remove(), 1150);
    AU.speak(text, seat);
  }

  function renderPlates() {
    if (!game) return;
    for (let s = 0; s < 4; s++) {
      const windI = game.seatWind(s);
      const w = $('wind' + s);
      w.textContent = WIND_ZH[windI];
      w.classList.toggle('dealer', s === game.dealer);
      $('score' + s).textContent = game.scores[s];
      $('plate' + s).classList.toggle('active', running && game.turn === s && !game.result);
      turnLEDs[s].material.color.set(running && game.turn === s && !game.result ? 0x4dff7a : 0x224228);
    }
    const roundZh = WIND_ZH[Math.min(game.roundWind, 3)];
    const numZh = ['一', '二', '三', '四'][game.handNumber - 1] || '一';
    $('roundLabel').textContent = `${roundZh}風局 · 第${numZh}局`;
    setHub(roundZh, game.wall ? game.wall.length : 0);
  }

  function renderAll() {
    if (!game || !game.players) return;
    for (let s = 0; s < 4; s++) {
      layoutHand(s);
      layoutDiscards(s);
      layoutMelds(s);
    }
    layoutWalls(false);
    renderPlates();
  }

  async function diceRoll() {
    AU.play('dice');
    for (const die of diceMeshes) {
      tween(die.rotation, {
        x: die.rotation.x + Math.PI * (2 + Math.random() * 4),
        z: die.rotation.z + Math.PI * (2 + Math.random() * 4),
      }, 650, 0, easeOut);
      tween(die.position, { y: TBL.feltY + 0.06 }, 260, 0, t => Math.sin(t * Math.PI));
      setTimeout(() => {
        die.rotation.x = Math.round(die.rotation.x / (Math.PI / 2)) * Math.PI / 2;
        die.rotation.z = Math.round(die.rotation.z / (Math.PI / 2)) * Math.PI / 2;
        die.position.y = TBL.feltY + 0.02;
      }, 680);
    }
  }

  // ---------- action buttons ----------
  let discardMode = false;
  let humanResolve = null, humanReject = null;

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
        const c = document.createElement('div');
        c.className = 'chip' + (k === tile ? ' win' : '');
        c.innerHTML = SCENE.glyphSVG(k);
        opt.appendChild(c);
      }
      opt.addEventListener('click', () => { AU.play('button'); done(chi); });
      cp.appendChild(opt);
    }
  }

  function humanWait() {
    return new Promise((resolve, reject) => { humanResolve = resolve; humanReject = reject; });
  }

  const humanAgent = {
    async chooseDiscard(g, seat) {
      layoutHand(0);
      renderPlates();
      raisedKindIdx = -1;
      discardMode = true;
      msg('轮到你 · 点击麻将两次打出', 3200);
      return humanWait();
    },
    async decideSelf(g, seat, o) {
      layoutHand(0);
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
      if (o.robKong) msg(`${NAMES[g.turn]} 加杠 ${MJ.TILE_NAMES_ZH[tile]} — 抢杠?`, 0);
      else msg(`${NAMES[g.lastDiscard ? g.lastDiscard.seat : g.turn]} 打出 ${MJ.TILE_NAMES_ZH[tile]}`, 0);
      const a = await p;
      $('msg').classList.remove('show');
      return a;
    },
  };

  // ================= engine events =================
  let game = null;
  let running = false;
  let starting = false;
  const speedMs = ms => new Promise(r => setTimeout(r, ms));

  function onEvent(ev) {
    switch (ev.type) {
      case 'handStart': {
        wallFront = 0; wallBack = 0;
        raisedKindIdx = -1;
        lastDiscardMesh = null;
        for (let s = 0; s < 4; s++) for (const z of ['hand', 'wall', 'discards', 'melds', 'flowers']) clearZone(s, z);
        renderPlates();
        AU.play('shuffle');
        diceRoll();
        layoutWalls(true);
        msg(`${NAMES[game.dealer]} 做庄`, 2600);
        break;
      }
      case 'deal': {
        wallFront += 52; // 13×4 from the front; the dealer's 14th arrives as a normal draw event
        renderAll();
        break;
      }
      case 'flower': {
        wallBack += 1;
        if (game.players) { layoutMelds(ev.seat); renderPlates(); }
        if (ev.seat === 0) msg(`补花 ${MJ.TILE_NAMES_ZH[ev.kind]}`, 1600);
        break;
      }
      case 'draw': {
        if (ev.replacement) wallBack += 1; else wallFront += 1;
        AU.play('draw');
        layoutHand(ev.seat);
        layoutWalls(false);
        renderPlates();
        break;
      }
      case 'discard': {
        AU.play('discard');
        layoutHand(ev.seat);
        // re-render every pile so exactly one tile glows
        for (let s = 0; s < 4; s++) layoutDiscards(s);
        renderPlates();
        break;
      }
      case 'meld': {
        AU.play('claim');
        const t = ev.meld.type;
        shout(ev.seat, t === 'chi' ? '吃' : t === 'peng' ? '碰' : '杠');
        renderAll();
        break;
      }
      case 'win': {
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

  // ================= result overlay =================
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

  let resumeNext = null;
  function waitContinue() { return new Promise(r => { resumeNext = r; }); }

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
      for (const m of r.melds) meldHtml += `<span class="gap"></span>` + chipRow(m.tiles);
      const flowerHtml = r.flowers.length ? `<span class="gap"></span>` + r.flowers.map(k => `<div class="chip small">${SCENE.glyphSVG(k)}</div>`).join('') : '';
      const rows = r.fan.items.map(it => `<tr><td>${it.zh}</td><td>${it.fan} 番</td></tr>`).join('');
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

  // ================= match loop =================
  async function startMatch() {
    if (starting) return;
    starting = true;
    if (game) game.aborted = true;
    if (humanReject) { const rj = humanReject; humanResolve = null; humanReject = null; try { rj(new Error('aborted')); } catch (e) {} }
    const agents = [humanAgent, MJ.makeAI({ thinkMs: 520 }), MJ.makeAI({ thinkMs: 560 }), MJ.makeAI({ thinkMs: 480 })];
    game = new MJ.Game({
      seed: (Math.random() * 0xffffffff) >>> 0,
      agents,
      delayFn: speedMs,
      listener: onEvent,
      roundLimit: 4,
    });
    window.__mj.game = game;
    running = true;
    starting = false;
    try {
      while (!game.finished && !game.aborted) {
        await game.playHand();
        renderAll();
        await speedMs(700);
        showResult();
        await waitContinue();
        game.advanceHand();
      }
      if (!game.aborted) showFinal();
    } catch (e) {
      if (String(e.message) !== 'aborted') { console.error(e); msg('出错了：' + e.message, 6000); }
    }
    running = false;
  }

  // ================= controls wiring =================
  $('btnStart').addEventListener('click', () => {
    if ($('btnStart').disabled || !$('intro').classList.contains('show')) return;
    AU.init(); AU.play('button');
    try { speechSynthesis.getVoices(); } catch (e) {}
    $('intro').classList.remove('show');
    startMatch();
  });
  $('btnHelp').addEventListener('click', () => { AU.play('button'); $('help').classList.add('show'); });
  $('btnCloseHelp').addEventListener('click', () => { AU.play('button'); $('help').classList.remove('show'); });
  $('btnStand').addEventListener('click', toggleWalk);
  $('btnSound').addEventListener('click', function () {
    const m = AU.toggle();
    this.textContent = m ? '♪̸' : '♪';
    this.style.opacity = m ? 0.5 : 1;
  });
  if (AU.muted) { $('btnSound').textContent = '♪̸'; $('btnSound').style.opacity = 0.5; }

  // debug/testing hooks
  window.__mj = {
    game: null,
    pickTile(i) {
      if (!discardMode || !handMeshes[i]) return false;
      const m = handMeshes[i];
      const kind = m.userData.kind;
      raisedKindIdx = -1;
      const resolve = humanResolve;
      humanResolve = null; humanReject = null;
      discardMode = false;
      hideActions();
      resolve && resolve(kind);
      return true;
    },
    get discardMode() { return discardMode; },
    handCount() { return handMeshes.length; },
    setView(x, z, yawDeg, pitchDeg) {   // debug: teleport walk camera
      if (mode !== 'walk') enterWalk();
      camera.position.set(x, 1.62, z);
      yaw = yawDeg * Math.PI / 180;
      pitch = pitchDeg * Math.PI / 180;
    },
  };

  // ================= boot =================
  async function boot() {
    buildRoom();
    buildTable();
    buildSeatGroups();
    for (let s = 0; s < 4; s++) buildChair(s * Math.PI / 2, 0.86);
    await buildCity();
    await buildPlants();
    // idle scene: full walls, closed hub
    game = new MJ.Game({ seed: 7, agents: [], listener: () => {}, delayFn: speedMs });
    game.initHand();
    wallFront = 0; wallBack = 0;
    layoutWalls(false);
    renderPlates();
    const btn = $('btnStart');
    btn.disabled = false;
    btn.textContent = '开 局';
  }

  let lastT = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    stepTweens(now);
    if (mode === 'seated') applySeatedCamera();
    else applyWalkCamera(dt);
    renderer.render(scene, camera);
  }

  boot();
  requestAnimationFrame(animate);
})();
