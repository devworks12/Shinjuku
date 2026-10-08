// 駅の3D模型をデータから組み立てる（床・壁・天井・階段・エスカレーター・エレベーター・ホーム・改札・案内サイン・街）
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const KIND = { WALK: 0, STAIRS: 1, ESC: 2, ELEV: 3, PLAT: 4, RAMP: 5 };
export const WALL_H = 3.0;

export function floorJP(lv) {
  const r = Math.round(lv);
  return r < 0 ? `地下${-r}階` : `${r + 1}階`;
}

// ---------------------------------------------------------------- テクスチャ（キャンバスで作る）
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
const TEX = {};
function tileTex() { // 白いタイル（1枚=0.5m、テクスチャ1枚=1m）
  return TEX.tile ||= canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#eef0f2'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#c9cdd3'; g.lineWidth = 3;
    for (let i = 0; i <= 2; i++) {
      g.beginPath(); g.moveTo(i * w / 2, 0); g.lineTo(i * w / 2, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * h / 2); g.lineTo(w, i * h / 2); g.stroke();
    }
  });
}
function floorTex() { // 床（大きめの石目、1枚=2m）
  return TEX.floor ||= canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#c8ccd2'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#b2b7be'; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke();
    }
  });
}
function ceilTex() { // 天井と照明（1枚=4m）
  return TEX.ceil ||= canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#e3e6ea'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#d0d4d9'; g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * w / 8, 0); g.lineTo(i * w / 8, h); g.stroke(); }
    g.fillStyle = '#ffffff';
    g.fillRect(w * 0.1, h * 0.44, w * 0.8, h * 0.12);
  });
}
function lightTex() { // 天井照明（発光部分だけ）
  return TEX.light ||= canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.fillRect(w * 0.1, h * 0.44, w * 0.8, h * 0.12);
  });
}
export function textTex(lines, opt = {}) {
  const W = opt.w || 512, H = opt.h || 128;
  return canvasTex(W, H, (g) => {
    g.fillStyle = opt.bg || '#1d2a44'; g.fillRect(0, 0, W, H);
    if (opt.stripe) { g.fillStyle = opt.stripe; g.fillRect(0, 0, Math.round(H * 0.14), H); }
    g.fillStyle = opt.fg || '#ffffff';
    g.textBaseline = 'middle';
    const n = lines.length;
    lines.forEach((t, i) => {
      const size = i === 0 ? (opt.size || 54) : (opt.size2 || 34);
      g.font = `700 ${size}px "Zen Kaku Gothic New","Hiragino Sans","Noto Sans JP",sans-serif`;
      let tw = g.measureText(t).width;
      const maxW = W - (opt.stripe ? H * 0.4 : 24);
      if (tw > maxW) { g.font = `700 ${Math.floor(size * maxW / tw)}px "Zen Kaku Gothic New","Hiragino Sans",sans-serif`; tw = maxW; }
      const y = n === 1 ? H / 2 : H * (i === 0 ? 0.36 : 0.74);
      g.fillText(t, opt.stripe ? H * 0.26 : (W - tw) / 2, y);
    });
  }, false);
}

// 法線（面積0の三角形で NaN になったものは上向きに。NaN はブルームで画面全体を黒くする）
function fixNormals(g) {
  g.computeVertexNormals();
  const n = g.attributes.normal.array;
  for (let i = 0; i < n.length; i += 3) {
    if (!(isFinite(n[i]) && isFinite(n[i + 1]) && isFinite(n[i + 2])) || (n[i] === 0 && n[i + 1] === 0 && n[i + 2] === 0)) { n[i] = 0; n[i + 1] = 1; n[i + 2] = 0; }
  }
}

// ---------------------------------------------------------------- マス目の復元
function decodeGrid(L) {
  const arr = new Uint8Array(L.w * L.h);
  let p = 0;
  const r = L.rle;
  for (let i = 0; i < r.length; i += 2) { if (r[i]) arr.fill(r[i], p, p + r[i + 1]); p += r[i + 1]; }
  return arr;
}

// ---------------------------------------------------------------- 本体
export class StationModel {
  constructor(data, scene) {
    this.d = data;
    this.scene = scene;
    this.levels = new Map(); // lv -> { group, mats:[], y }
    this.ceilings = [];      // POV 中だけ見せるもの
    this.povOnly = [];
    this.overviewOnly = [];
    this.gateObjs = [];
    this.labels = [];        // {text, pos, cls, lv, color}
    const g = data.grid;
    this.theta = g.theta;
    this.ct = Math.cos(g.theta); this.st = Math.sin(g.theta);
    this.mats = this._materials();
    this.root = new THREE.Group();
    scene.add(this.root);
    this._grids = new Map();
    this._buildGrid();
    this._buildVertical();
    this._buildPlatforms();
    this._buildRails();
    this._buildGates();
    this._buildSigns();
    this._buildCity();
  }

  _materials() {
    const tile = tileTex(), fl = floorTex(), ce = ceilTex(), li = lightTex();
    return {
      wall: new THREE.MeshStandardMaterial({ map: tile, color: 0xffffff, roughness: 0.6, metalness: 0, side: THREE.DoubleSide }),
      wallCap: new THREE.MeshStandardMaterial({ color: 0xf4f5f7, roughness: 0.8 }),
      floor: new THREE.MeshStandardMaterial({ map: fl, color: 0xffffff, roughness: 0.75 }),
      ceil: new THREE.MeshStandardMaterial({ map: ce, emissiveMap: li, emissive: 0xffffff, emissiveIntensity: 1.1, color: 0xffffff, roughness: 0.9, side: THREE.BackSide }),
      step: new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.7 }),
      stepNose: new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.5 }),
      esc: new THREE.MeshStandardMaterial({ color: 0x5b626d, roughness: 0.35, metalness: 0.6 }),
      escSide: new THREE.MeshStandardMaterial({ color: 0x9fd2ff, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      rail: new THREE.MeshStandardMaterial({ color: 0x6a717c, roughness: 0.4, metalness: 0.7 }),
      elev: new THREE.MeshStandardMaterial({ color: 0x8fd0ff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      elevFrame: new THREE.MeshStandardMaterial({ color: 0x48505c, roughness: 0.5, metalness: 0.6 }),
      plat: new THREE.MeshStandardMaterial({ color: 0xbfc3c9, roughness: 0.85 }),
      platEdge: new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.7 }),
      ballast: new THREE.MeshStandardMaterial({ color: 0x3b3a38, roughness: 1 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.9 }),
      pillar: new THREE.MeshStandardMaterial({ color: 0xe6e8eb, roughness: 0.6 }),
      roof: new THREE.MeshStandardMaterial({ color: 0xd9dce0, roughness: 0.8, side: THREE.DoubleSide }),
      gate: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.5, metalness: 0.2 }),
      gateTop: new THREE.MeshStandardMaterial({ color: 0x2a3446, roughness: 0.4 }),
      gateLight: new THREE.MeshBasicMaterial({ color: 0x35d0ff }),
      building: new THREE.MeshStandardMaterial({ color: 0x5d6778, roughness: 0.9, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
      buildingSolid: new THREE.MeshStandardMaterial({ color: 0xc4c9d0, roughness: 0.9 }),
      landmark: new THREE.MeshStandardMaterial({ color: 0x9a5a43, roughness: 0.9, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
      ground: new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 1, transparent: true, opacity: 0.72, depthWrite: false }),
      road: new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 1, transparent: true, opacity: 0.85, depthWrite: false }),
    };
  }

  // グリッド座標(u,v) -> ワールド(x,z)
  toWorld(u, v) { return [u * this.ct - v * this.st, u * this.st + v * this.ct]; }
  toGrid(x, z) { return [x * this.ct + z * this.st, -x * this.st + z * this.ct]; }

  level(lv) {
    const k = Math.round(lv);
    if (!this.levels.has(k)) {
      const group = new THREE.Group();
      group.name = 'lv' + k;
      this.root.add(group);
      this.levels.set(k, { group, mats: new Set(), y: (this.d.levels.find((l) => l.lv === k) || {}).y ?? k * 5.5 });
    }
    return this.levels.get(k);
  }

  lvOfY(y) {
    let best = 0, bd = 1e9;
    for (const l of this.d.levels) { const dd = Math.abs(l.y - y); if (dd < bd) { bd = dd; best = l.lv; } }
    return best;
  }

  // マス目の値（ワールド座標で問い合わせ）
  cellAt(lv, x, z) {
    const G = this._grids.get(Math.round(lv));
    if (!G) return 0;
    const g = this.d.grid;
    const [u, v] = this.toGrid(x, z);
    const i = Math.floor((u - g.u0) / g.res) - G.i0, j = Math.floor((v - g.v0) / g.res) - G.j0;
    if (i < 0 || j < 0 || i >= G.w || j >= G.h) return 0;
    return G.arr[j * G.w + i];
  }

  _buildGrid() {
    const g = this.d.grid, R = g.res;
    for (const L of g.levels) {
      const arr = decodeGrid(L);
      this._grids.set(L.lv, { arr, i0: L.i0, j0: L.j0, w: L.w, h: L.h });
      const y = (this.d.levels.find((l) => l.lv === L.lv) || {}).y ?? 0;
      const W = L.w, H = L.h;
      const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : arr[j * W + i]);
      const U = (i) => g.u0 + (L.i0 + i) * R, V = (j) => g.v0 + (L.j0 + j) * R;
      const floorPos = [], floorUv = [], ceilPos = [], ceilUv = [], wallPos = [], wallUv = [], capPos = [];
      const outdoor = L.lv === 0; // 地上階は天井を付けない（屋外・ホームが多い）
      // 床・天井: 行ごとの連続区間を縦にまとめて長方形に
      const used = new Uint8Array(W * H);
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          if (at(i, j) !== 1 || used[j * W + i]) continue;
          let i2 = i;
          while (i2 + 1 < W && at(i2 + 1, j) === 1 && !used[j * W + i2 + 1]) i2++;
          let j2 = j;
          outer: while (j2 + 1 < H) {
            for (let k = i; k <= i2; k++) if (at(k, j2 + 1) !== 1 || used[(j2 + 1) * W + k]) break outer;
            j2++;
          }
          for (let jj = j; jj <= j2; jj++) for (let k = i; k <= i2; k++) used[jj * W + k] = 1;
          const u0 = U(i), u1 = U(i2 + 1), v0 = V(j), v1 = V(j2 + 1);
          quadH(floorPos, floorUv, u0, v0, u1, v1, y, true, 2);
          if (!outdoor) quadH(ceilPos, ceilUv, u0, v0, u1, v1, y + WALL_H, false, 4);
        }
      }
      // 壁: 床(1)と何もない(0)の境目。向きごとに連続区間をまとめる
      const wallRun = (horizontal) => {
        // horizontal: 上下の境界（u方向に延びる）
        const n1 = horizontal ? H : W, n2 = horizontal ? W : H;
        for (let a = 0; a < n1; a++) {
          for (const side of [-1, 1]) {
            let start = -1;
            for (let b = 0; b <= n2; b++) {
              let on = false;
              if (b < n2) {
                const i = horizontal ? b : a, j = horizontal ? a : b;
                const ni = horizontal ? i : i + side, nj = horizontal ? j + side : j;
                on = at(i, j) === 1 && at(ni, nj) === 0;
              }
              if (on && start < 0) start = b;
              if (!on && start >= 0) {
                // 区間 [start, b)
                if (horizontal) {
                  const v = side < 0 ? V(a) : V(a + 1);
                  wallQuad(wallPos, wallUv, capPos, U(start), v, U(b), v, y, side < 0 ? 1 : -1, 0);
                } else {
                  const u = side < 0 ? U(a) : U(a + 1);
                  wallQuad(wallPos, wallUv, capPos, u, V(start), u, V(b), y, 0, side < 0 ? 1 : -1);
                }
                start = -1;
              }
            }
          }
        }
      };
      wallRun(true);
      wallRun(false);
      const lvRec = this.level(L.lv);
      const grp = new THREE.Group();
      grp.rotation.y = -this.theta;
      lvRec.group.add(grp);
      const mk = (pos, uv, mat, extra) => {
        if (!pos.length) return null;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        fixNormals(geo);
        const m = new THREE.Mesh(geo, mat);
        Object.assign(m.userData, extra || {});
        grp.add(m);
        return m;
      };
      const fm = mk(floorPos, floorUv, this.mats.floor);
      const wm = mk(wallPos, wallUv, this.mats.wall);
      const cm = mk(capPos, null, this.mats.wallCap);
      const ce = mk(ceilPos, ceilUv, this.mats.ceil);
      if (ce) { ce.visible = false; this.ceilings.push(ce); }
      for (const m of [fm, wm, cm]) if (m) lvRec.mats.add(m.material);
      lvRec.meshes = [fm, wm, cm].filter(Boolean);
    }

    function quadH(pos, uv, u0, v0, u1, v1, y, up, tile) {
      // 上向き（床）/下向き（天井）の長方形。三角形の巻き順で向きを決める
      if (up) pos.push(u0, y, v0, u0, y, v1, u1, y, v1, u0, y, v0, u1, y, v1, u1, y, v0);
      else pos.push(u0, y, v0, u1, y, v1, u0, y, v1, u0, y, v0, u1, y, v0, u1, y, v1);
      const a = u0 / tile, b = u1 / tile, c = v0 / tile, d = v1 / tile;
      if (up) uv.push(a, c, a, d, b, d, a, c, b, d, b, c);
      else uv.push(a, c, b, d, a, d, a, c, b, c, b, d);
    }
    function wallQuad(pos, uv, cap, u0, v0, u1, v1, y, nu, nv) {
      const y1 = y + WALL_H;
      pos.push(u0, y, v0, u1, y, v1, u1, y1, v1, u0, y, v0, u1, y1, v1, u0, y1, v0);
      const L = Math.hypot(u1 - u0, v1 - v0), s0 = (u0 + v0) * 2, s1 = s0 + L * 2, hh = WALL_H * 2;
      uv.push(s0, 0, s1, 0, s1, hh, s0, 0, s1, hh, s0, hh);
      // 上から見たときの壁の厚み（外側へ 0.35m）
      const t = 0.35, ou = -nu * t, ov = -nv * t;
      cap.push(u0, y1, v0, u0 + ou, y1, v0 + ov, u1 + ou, y1, v1 + ov, u0, y1, v0, u1 + ou, y1, v1 + ov, u1, y1, v1);
    }
  }

  // 階段・エスカレーター・スロープ・エレベーター
  _buildVertical() {
    const d = this.d, N = d.nodes, E = d.edges;
    const P = (i) => new THREE.Vector3(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    const bins = new Map();
    const bin = (lv) => {
      const k = Math.round(lv);
      if (!bins.has(k)) bins.set(k, { steps: [], noses: [], escs: [], escSides: [], sideWalls: [], sideUv: [], ceil: [], ceilUv: [], elev: [], elevTop: [] });
      return bins.get(k);
    };
    const elevDone = new Set();
    const box = (arr, cx, cy, cz, sx, sy, sz, yaw) => {
      const gg = new THREE.BoxGeometry(sx, sy, sz);
      gg.rotateY(yaw);
      gg.translate(cx, cy, cz);
      arr.push(gg);
    };
    for (let e = 0; e < E.length / 3; e++) {
      const a = E[e * 3], b = E[e * 3 + 1], k = E[e * 3 + 2];
      const B = bin(Math.min(d.nodeLv[a], d.nodeLv[b]));
      const { steps, noses, escs, escSides, sideWalls, sideUv, ceil, ceilUv } = B;
      if (k === KIND.ELEV) {
        const pa = P(a), pb = P(b);
        const key = Math.round(pa.x * 2) + ',' + Math.round(pa.z * 2);
        const y0 = Math.min(pa.y, pb.y), y1 = Math.max(pa.y, pb.y) + WALL_H;
        const g = new THREE.BoxGeometry(2.0, y1 - y0, 2.0);
        g.translate(pa.x, (y0 + y1) / 2, pa.z);
        B.elev.push(g);
        if (!elevDone.has(key)) {
          elevDone.add(key);
          const f = new THREE.BoxGeometry(2.2, 0.15, 2.2);
          f.translate(pa.x, y1, pa.z);
          B.elevTop.push(f);
        }
        continue;
      }
      if (k !== KIND.STAIRS && k !== KIND.ESC && k !== KIND.RAMP) continue;
      let top = P(a), bot = P(b);
      if (top.y < bot.y) [top, bot] = [bot, top];
      const dy = top.y - bot.y;
      if (dy < 0.15) continue;
      const hx = bot.x - top.x, hz = bot.z - top.z;
      const run = Math.hypot(hx, hz);
      if (run < 0.2) continue;
      const yaw = Math.atan2(hx, hz); // ローカルz(奥行き)を下り方向へ
      const w = k === KIND.ESC ? 1.3 : 3.0;
      if (k === KIND.RAMP) {
        // 斜面: 薄い板
        const g = new THREE.BoxGeometry(w, 0.12, Math.hypot(run, dy));
        g.rotateX(Math.atan2(dy, run));
        g.rotateY(yaw);
        g.translate((top.x + bot.x) / 2, (top.y + bot.y) / 2 - 0.06, (top.z + bot.z) / 2);
        steps.push(g);
        continue;
      }
      const n = Math.max(2, Math.round(dy / 0.18));
      const tread = run / n, rise = dy / n;
      for (let s = 0; s < n; s++) {
        const f = (s + 0.5) / n;
        const cx = top.x + hx * f, cz = top.z + hz * f;
        const yTop = top.y - rise * (s + 1);
        // 段（踏み面と蹴上げを1つの箱で）
        box(k === KIND.ESC ? escs : steps, cx, yTop - 0.1, cz, w, 0.2 + rise, tread, yaw);
        if (k === KIND.STAIRS && s % 1 === 0) box(noses, cx - Math.sin(yaw) * tread * 0.45, yTop + 0.005, cz - Math.cos(yaw) * tread * 0.45, w, 0.02, 0.06, yaw);
      }
      // 側壁（階段は天井まで、エスカレーターは手すり＋ガラス）
      const nx = Math.cos(yaw), nz = -Math.sin(yaw); // 横方向
      // 側壁: 上の階では腰壁(1.1m)、下に行くほど天井まで
      const hTop = k === KIND.ESC ? 1.0 : 1.1, hBot = k === KIND.ESC ? 1.0 : WALL_H;
      for (const sgn of [-1, 1]) {
        const ox = nx * sgn * (w / 2 + 0.05), oz = nz * sgn * (w / 2 + 0.05);
        const arr = k === KIND.ESC ? escSides : sideWalls;
        const t0 = [top.x + ox, top.y, top.z + oz], b0 = [bot.x + ox, bot.y, bot.z + oz];
        const tY = top.y + hTop, bY = Math.max(bot.y + hBot, bot.y + 1.0);
        arr.push(t0[0], t0[1] - 0.6, t0[2], b0[0], b0[1], b0[2], b0[0], bY, b0[2],
          t0[0], t0[1] - 0.6, t0[2], b0[0], bY, b0[2], t0[0], tY, t0[2]);
        if (k !== KIND.ESC) {
          const L = Math.hypot(run, dy) * 2;
          sideUv.push(0, 0, L, 0, L, (bY - bot.y) * 2, 0, 0, L, (bY - bot.y) * 2, 0, (tY - top.y + 0.6) * 2);
        }
      }
      if (k === KIND.STAIRS && dy > 2.6) {
        // 斜めの天井（上の階の床下から、下の階の天井高さへ）
        const lx = nx * w / 2, lz = nz * w / 2, yT = top.y - 0.25, yB = bot.y + WALL_H;
        ceil.push(top.x - lx, yT, top.z - lz, bot.x + lx, yB, bot.z + lz, bot.x - lx, yB, bot.z - lz,
          top.x - lx, yT, top.z - lz, top.x + lx, yT, top.z + lz, bot.x + lx, yB, bot.z + lz);
        const L = Math.hypot(run, dy) / 4;
        ceilUv.push(0, 0, 1, L, 0, L, 0, 0, 1, 0, 1, L);
      }
    }
    for (const [lv, B] of bins) {
      const grp = this.level(lv).group;
      const add = (geos, mat) => {
        if (!geos.length) return null;
        const m = new THREE.Mesh(mergeGeometries(geos, false), mat);
        geos.forEach((g) => g.dispose());
        grp.add(m);
        return m;
      };
      const flat = (pos, uv, mat) => {
        if (!pos.length) return null;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        fixNormals(g);
        const m = new THREE.Mesh(g, mat);
        grp.add(m);
        return m;
      };
      add(B.steps, this.mats.step);
      add(B.noses, this.mats.stepNose);
      add(B.escs, this.mats.esc);
      add(B.elev, this.mats.elev);
      add(B.elevTop, this.mats.elevFrame);
      flat(B.sideWalls, B.sideUv, this.mats.wall);
      flat(B.escSides, null, this.mats.escSide);
      const c = flat(B.ceil, B.ceilUv, this.mats.ceil);
      if (c) { c.visible = false; this.ceilings.push(c); }
    }
  }

  _buildPlatforms() {
    const d = this.d;
    const lineBy = Object.fromEntries(d.lines.map((l) => [l.key, l]));
    for (const p of d.plats) {
      const ring = [];
      for (let i = 0; i < p.ring.length; i += 2) ring.push(new THREE.Vector2(p.ring[i], -p.ring[i + 1]));
      if (ring.length < 3) continue;
      const shape = new THREE.Shape(ring);
      const thick = 1.1;
      const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.translate(0, p.y - thick, 0);
      const lv = this.level(p.lv);
      const m = new THREE.Mesh(g, this.mats.plat);
      lv.group.add(m);
      lv.mats.add(this.mats.plat);
      // 点字ブロック（縁から 0.7m 内側の黄色い帯）
      const edge = [];
      const pts = [];
      for (let i = 0; i < p.ring.length; i += 2) pts.push([p.ring[i], p.ring[i + 1]]);
      let area = 0;
      for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; area += x1 * z2 - x2 * z1; }
      const sgn = area > 0 ? 1 : -1;
      for (let i = 0; i < pts.length; i++) {
        const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
        const L = Math.hypot(x2 - x1, z2 - z1);
        if (L < 6) continue; // 短い辺（ホームの端）は付けない
        const ix = (-(z2 - z1) / L) * sgn, iz = ((x2 - x1) / L) * sgn; // 内向き
        const o0 = 0.55, o1 = 0.85, y = p.y + 0.012;
        const A = [x1 + ix * o0, z1 + iz * o0], B = [x2 + ix * o0, z2 + iz * o0], Cc = [x2 + ix * o1, z2 + iz * o1], D = [x1 + ix * o1, z1 + iz * o1];
        edge.push(A[0], y, A[1], B[0], y, B[1], Cc[0], y, Cc[1], A[0], y, A[1], Cc[0], y, Cc[1], D[0], y, D[1]);
      }
      if (edge.length) {
        const eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
        fixNormals(eg);
        const em = new THREE.Mesh(eg, this.mats.platEdge);
        em.material.side = THREE.DoubleSide;
        lv.group.add(em);
      }
      // 柱と屋根/天井、ホームの番線サイン
      const N = d.nodes;
      const spine = p.nodes;
      const line = lineBy[p.lines[0]];
      const pillars = [];
      let acc = 0;
      for (let s = 1; s < spine.length; s++) {
        const a = spine[s - 1], b = spine[s];
        acc += Math.hypot(N[b * 3] - N[a * 3], N[b * 3 + 2] - N[a * 3 + 2]);
        if (acc >= 14) {
          acc = 0;
          const pg = new THREE.BoxGeometry(0.5, 4.2, 0.5);
          pg.translate(N[b * 3], p.y + 2.1, N[b * 3 + 2]);
          pillars.push(pg);
          // 番線サイン（吊り下げ）
          if (s % 4 === 0 || s === Math.floor(spine.length / 2)) {
            const dir = Math.atan2(N[b * 3] - N[a * 3], N[b * 3 + 2] - N[a * 3 + 2]);
            this._hangSign([`${p.label}`, line ? `${line.name}` : p.short], new THREE.Vector3(N[b * 3], p.y + 2.9, N[b * 3 + 2]), dir, { stripe: line?.color, w: 2.6, lv: p.lv, group: lv.group });
          }
        }
      }
      if (pillars.length) {
        const pm = new THREE.Mesh(mergeGeometries(pillars, false), this.mats.pillar);
        lv.group.add(pm);
      }
      const roofY = p.y + 4.3;
      const rg = new THREE.ShapeGeometry(shape);
      rg.rotateX(Math.PI / 2);
      rg.translate(0, roofY, 0);
      const roof = new THREE.Mesh(rg, this.mats.roof);
      roof.visible = false;
      lv.group.add(roof);
      this.ceilings.push(roof);
      this.labels.push({ text: `${p.short} ${p.label}`, pos: centroid(p.ring, p.y + 1.2), cls: 'plat', lv: p.lv, color: line?.color });
    }
    function centroid(r, y) {
      let x = 0, z = 0;
      for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; }
      return new THREE.Vector3(x / (r.length / 2), y, z / (r.length / 2));
    }
  }

  _buildRails() {
    const geos = [], steel = [];
    for (const r of this.d.rails || []) {
      for (let i = 0; i + 5 < r.p.length; i += 3) {
        const x1 = r.p[i], y1 = r.p[i + 1], z1 = r.p[i + 2], x2 = r.p[i + 3], y2 = r.p[i + 4], z2 = r.p[i + 5];
        const L = Math.hypot(x2 - x1, z2 - z1);
        if (L < 0.5) continue;
        const yaw = Math.atan2(x2 - x1, z2 - z1);
        const g = new THREE.BoxGeometry(3.0, 0.3, L);
        g.rotateY(yaw);
        g.translate((x1 + x2) / 2, (y1 + y2) / 2 - 0.15, (z1 + z2) / 2);
        geos.push(g);
        for (const s of [-0.53, 0.53]) {
          const sg = new THREE.BoxGeometry(0.08, 0.16, L);
          sg.rotateY(yaw);
          const ox = Math.cos(yaw) * s, oz = -Math.sin(yaw) * s;
          sg.translate((x1 + x2) / 2 + ox, (y1 + y2) / 2 + 0.08, (z1 + z2) / 2 + oz);
          steel.push(sg);
        }
      }
    }
    const byLv = (arr) => {
      const m = new Map();
      for (const g of arr) {
        g.computeBoundingBox();
        const y = g.boundingBox.min.y + 1;
        let best = 0, bd = 1e9;
        for (const l of this.d.levels) { const dd = Math.abs(l.y - y); if (dd < bd) { bd = dd; best = l.lv; } }
        (m.get(best) || m.set(best, []).get(best)).push(g);
      }
      return m;
    };
    for (const [lv, arr] of byLv(geos)) this.level(lv).group.add(new THREE.Mesh(mergeGeometries(arr, false), this.mats.ballast));
    for (const [lv, arr] of byLv(steel)) this.level(lv).group.add(new THREE.Mesh(mergeGeometries(arr, false), this.mats.steel));
  }

  // 改札: 通路を横切るように改札機を並べ、上に名前の看板
  _buildGates() {
    const d = this.d, N = d.nodes;
    const adj = new Map();
    for (let e = 0; e < d.edges.length; e += 3) {
      const a = d.edges[e], b = d.edges[e + 1];
      (adj.get(a) || adj.set(a, []).get(a)).push(b);
      (adj.get(b) || adj.set(b, []).get(b)).push(a);
    }
    const gb = new Map();
    const gbin = (lv) => { const k = Math.round(lv); if (!gb.has(k)) gb.set(k, { machines: [], tops: [], lights: [] }); return gb.get(k); };
    const placed = [];
    const opColor = { 1: '#2f8f3a', 2: '#1e6fbf', 4: '#c1186a', 8: '#d4202b', 16: '#2a7f3a', 32: '#2e6db4' };
    for (const gt of d.gates) {
      const n = gt.n;
      const x = N[n * 3], y = N[n * 3 + 1], z = N[n * 3 + 2];
      const lv = d.nodeLv[n];
      if (placed.some((q) => Math.hypot(q[0] - x, q[2] - z) < 3.5 && Math.abs(q[1] - y) < 1)) continue;
      placed.push([x, y, z]);
      const nb = adj.get(n) || [];
      if (!nb.length) continue;
      // 通る向き: 改札の前後で「改札内/外」が変わる隣どうしを結ぶ向き
      let dx = 0, dz = 0, best = -1;
      for (let i = 0; i < nb.length; i++) for (let j = 0; j < nb.length; j++) {
        if (i === j || d.zone[nb[i]] === d.zone[nb[j]]) continue;
        const ux = N[nb[j] * 3] - N[nb[i] * 3], uz = N[nb[j] * 3 + 2] - N[nb[i] * 3 + 2], L = Math.hypot(ux, uz);
        if (L > best) { best = L; dx = ux; dz = uz; }
      }
      if (best < 0) {
        if (nb.length >= 2) { dx = N[nb[1] * 3] - N[nb[0] * 3]; dz = N[nb[1] * 3 + 2] - N[nb[0] * 3 + 2]; }
        else { dx = N[nb[0] * 3] - x; dz = N[nb[0] * 3 + 2] - z; }
      }
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const cx = -dz, cz = dx; // 横方向
      // 横方向に壁までの距離を測る（最大7m）
      const reach = (s) => { let t = 0; for (; t < 7; t += 0.4) if (this.cellAt(lv, x + cx * t * s, z + cz * t * s) !== 1 && Math.abs(lv) > 0.1) break; return Math.max(1.2, Math.min(t, 7)); };
      const r1 = reach(1), r2 = reach(-1);
      const yaw = Math.atan2(dx, dz);
      const { machines, tops, lights } = gbin(lv);
      const count = Math.max(2, Math.round((r1 + r2) / 0.95));
      for (let i = 0; i <= count; i++) {
        const s = -r2 + (i / count) * (r1 + r2);
        const px = x + cx * s, pz = z + cz * s;
        const g = new THREE.BoxGeometry(0.22, 1.0, 1.4);
        g.rotateY(yaw); g.translate(px, y + 0.5, pz);
        machines.push(g);
        const t = new THREE.BoxGeometry(0.24, 0.05, 1.42);
        t.rotateY(yaw); t.translate(px, y + 1.02, pz);
        tops.push(t);
        const l = new THREE.BoxGeometry(0.25, 0.08, 0.2);
        l.rotateY(yaw); l.translate(px + dx * 0.55, y + 1.0, pz + dz * 0.55);
        lights.push(l);
      }
      const name = gt.name || '改札';
      const bit = d.zone[n] || 0;
      const col = Object.entries(opColor).find(([b]) => bit & +b)?.[1] || '#24324a';
      this._hangSign([name], new THREE.Vector3(x, y + 2.55, z), yaw, { bg: col, w: Math.min(5, Math.max(2.4, name.length * 0.45)), group: this.level(lv).group });
      if (!this.labels.some((L) => L.cls === 'gate' && L.text === name && L.pos.distanceTo(new THREE.Vector3(x, y + 3.2, z)) < 40)) {
        this.labels.push({ text: name, pos: new THREE.Vector3(x, y + 3.2, z), cls: 'gate', lv, node: n, nodes: [n] });
      } else {
        const L = this.labels.find((L) => L.cls === 'gate' && L.text === name && L.pos.distanceTo(new THREE.Vector3(x, y + 3.2, z)) < 40);
        L.nodes.push(n);
      }
    }
    for (const [lv, B] of gb) {
      const grp = this.level(lv).group;
      const add = (geos, mat) => { if (geos.length) grp.add(new THREE.Mesh(mergeGeometries(geos, false), mat)); };
      add(B.machines, this.mats.gate);
      add(B.tops, this.mats.gateTop);
      add(B.lights, this.mats.gateLight);
    }
  }

  _hangSign(lines, pos, yaw, opt = {}) {
    const w = opt.w || 2.4, h = w / 4;
    const key = lines.join('|') + (opt.stripe || '') + (opt.bg || '') + (opt.fg || '');
    this._signMats ||= new Map();
    let mat = this._signMats.get(key);
    if (!mat) {
      const tex = textTex(lines, { stripe: opt.stripe, bg: opt.bg || '#1d2a44', fg: opt.fg, w: 384, h: 96, size: lines.length > 1 ? 38 : 46, size2: 26 });
      mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false });
      this._signMats.set(key, mat);
    }
    this.signCount = (this.signCount || 0) + 1;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos);
    m.rotation.y = yaw;
    (opt.group || this.root).add(m);
    return m;
  }

  _buildSigns() {
    const d = this.d;
    const lineBy = Object.fromEntries(d.lines.map((l) => [l.key, l]));
    for (const s of d.signs || []) {
      const p = d.plats[s.plat];
      if (!p) continue;
      const line = lineBy[p.lines[0]];
      const names = [...new Set(p.lines.map((k) => lineBy[k]?.name).filter(Boolean))].join('・');
      const yaw = Math.atan2(s.dx, s.dz);
      const L = Math.hypot(s.dx, s.dz) || 1;
      const pos = new THREE.Vector3(s.x - (s.dx / L) * 2.2, s.y + 2.7, s.z - (s.dz / L) * 2.2);
      this._hangSign([`${p.short} ${p.label}`, names || ''], pos, yaw, { stripe: line?.color, w: 2.8, group: this.level(this.lvOfY(s.y)).group });
    }
    // 通路名の看板（屋内）と通りの名前（屋外、模型のラベル）
    if (d.ename) {
      const N = d.nodes, E = d.edges;
      const placed = new Map();
      const streetBest = new Map();
      for (let e = 0; e < E.length / 3; e++) {
        const ni = d.ename[e];
        if (ni < 0) continue;
        const a = E[e * 3], b = E[e * 3 + 1];
        const ax = N[a * 3], ay = N[a * 3 + 1], az = N[a * 3 + 2], bx = N[b * 3], bz = N[b * 3 + 2];
        const L = Math.hypot(bx - ax, bz - az);
        const name = d.names[ni];
        if (!d.ein[e]) {
          const cur = streetBest.get(ni);
          if (!cur || L > cur.L) streetBest.set(ni, { L, pos: new THREE.Vector3((ax + bx) / 2, 1, (az + bz) / 2) });
          continue;
        }
        if (L < 6 || Math.abs(ay - N[b * 3 + 1]) > 0.3) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const list = placed.get(ni) || [];
        if (list.some(([x, y, z]) => Math.hypot(x - mx, z - mz) < 70 && Math.abs(y - ay) < 2)) continue;
        list.push([mx, ay, mz]);
        placed.set(ni, list);
        this._hangSign([name], new THREE.Vector3(mx, ay + 2.6, mz), Math.atan2(bx - ax, bz - az), { bg: '#f4f5f7', fg: '#1b2433', w: Math.min(4.5, Math.max(2.2, name.length * 0.42)), group: this.level(d.nodeLv[a]).group });
      }
      for (const [ni, v] of streetBest) if (v.L > 8) this.labels.push({ text: d.names[ni], pos: v.pos, cls: 'street', lv: 0 });
    }
    for (const x of d.exits) {
      const N = d.nodes;
      this.labels.push({ text: x.name, pos: new THREE.Vector3(N[x.n * 3], N[x.n * 3 + 1] + 4, N[x.n * 3 + 2]), cls: 'exit', lv: d.nodeLv[x.n] });
    }
  }

  _buildCity() {
    const d = this.d;
    // 地面
    const gg = new THREE.PlaneGeometry(3000, 3000);
    gg.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(gg, this.mats.ground);
    ground.position.y = -0.2;
    ground.renderOrder = -1;
    this.root.add(ground);
    this.ground = ground;
    // 道路（帯）
    const pos = [];
    for (const r of d.roads || []) {
      for (let i = 0; i + 3 < r.length; i += 2) {
        const x1 = r[i], z1 = r[i + 1], x2 = r[i + 2], z2 = r[i + 3];
        const L = Math.hypot(x2 - x1, z2 - z1) || 1, w = 5;
        const nx = (-(z2 - z1) / L) * w, nz = ((x2 - x1) / L) * w;
        pos.push(x1 + nx, -0.1, z1 + nz, x2 + nx, -0.1, z2 + nz, x2 - nx, -0.1, z2 - nz, x1 + nx, -0.1, z1 + nz, x2 - nx, -0.1, z2 - nz, x1 - nx, -0.1, z1 - nz);
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      fixNormals(g);
      const m = new THREE.Mesh(g, this.mats.road);
      m.material.side = THREE.DoubleSide;
      m.renderOrder = -1;
      this.root.add(m);
    }
    // 建物
    const plain = [], marks = [];
    for (const b of d.buildings) {
      const pts = [];
      for (let i = 0; i < b.r.length; i += 2) pts.push(new THREE.Vector2(b.r[i], -b.r[i + 1]));
      if (pts.length < 3) continue;
      const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: Math.max(3, b.h), bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.deleteAttribute('uv');
      (b.name ? marks : plain).push(g);
      if (b.name) {
        let cx = 0, cz = 0;
        for (let i = 0; i < b.r.length; i += 2) { cx += b.r[i]; cz += b.r[i + 1]; }
        this.labels.push({ text: b.name, pos: new THREE.Vector3(cx / (b.r.length / 2), Math.max(3, b.h) + 2, cz / (b.r.length / 2)), cls: 'bldg', lv: null });
      }
    }
    const addB = (geos, mat) => {
      if (!geos.length) return null;
      const m = new THREE.Mesh(mergeGeometries(geos, false), mat);
      m.renderOrder = 2;
      this.root.add(m);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 35), new THREE.LineBasicMaterial({ color: 0x9aa6b8, transparent: true, opacity: 0.18, depthWrite: false }));
      edges.renderOrder = 2;
      this.root.add(edges);
      return [m, edges];
    };
    this.buildings = [...(addB(plain, this.mats.building) || []), ...(addB(marks, this.mats.landmark) || [])];
  }

  // 階ごとの見え方（null=全体）
  setFocus(lv) {
    for (const [k, rec] of this.levels) {
      const on = lv == null || k === lv;
      rec.group.visible = lv == null || Math.abs(k - lv) <= 0 || k < lv; // 上の階は隠す
      rec.group.traverse((o) => { if (o.isMesh && o.material && 'opacity' in o.material) { /* 同じマテリアルを共有しているので触らない */ } });
      rec.dim = !on;
    }
  }

  // 駅の明るさ（1=そのまま）。全体表示では少し落として、経路の光を目立たせる
  setTone(f) {
    if (!this._base) {
      this._base = {};
      for (const k of ['wall', 'wallCap', 'floor', 'step', 'stepNose', 'plat', 'pillar', 'gate', 'esc']) this._base[k] = this.mats[k].color.clone();
    }
    for (const k in this._base) this.mats[k].color.copy(this._base[k]).multiplyScalar(f);
  }

  setPov(on) {
    for (const c of this.ceilings) c.visible = on;
    for (const b of this.buildings || []) b.material.opacity = on ? 0.9 : (b.isLineSegments ? 0.18 : b.material === this.mats.landmark ? 0.28 : 0.12);
    this.mats.building.depthWrite = on; this.mats.landmark.depthWrite = on;
    this.mats.ground.opacity = on ? 1 : 0.72;
    this.mats.ground.color.set(on ? 0x8a9099 : 0x23272e);
    this.mats.road.color.set(on ? 0x5a6069 : 0x3a3f47);
    this.mats.ground.depthWrite = on;
    this.mats.road.depthWrite = on;
  }
}
