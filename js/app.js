// 新宿駅 乗り換え3D — メイン
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Graph } from './route.js';

const $ = (s) => document.querySelector(s);
const EYE = 1.55;
const SPEEDS = { 1: 5, 2: 10, 4: 20 };           // 再生倍率（実時間に対して）
const KIND = { WALK: 0, STAIRS: 1, ESC: 2, ELEV: 3, PLAT: 4, RAMP: 5 };

const state = {
  data: null, graph: null, from: null, to: null, speed: 2, bf: false,
  route: null, mode: 'plan', pov: null, focusLv: null,
};

// ---------------------------------------------------------------- 起動
const loadMsg = $('#loadMsg');
let data;
try {
  const res = await fetch('data/station.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(res.status);
  data = await res.json();
} catch (e) {
  loadMsg.textContent = '駅データを読み込めませんでした（' + e.message + '）';
  throw e;
}
state.data = data;
state.graph = new Graph(data, (x, y, z) => new THREE.Vector3(x, y, z));
const lineByKey = Object.fromEntries(data.lines.map((l) => [l.key, l]));
const exitByKey = Object.fromEntries(data.exits.map((x) => [x.key, x]));
const levelY = new Map(data.levels.map((l) => [l.lv, l.y]));
const levelName = (lv) => (data.levels.find((l) => l.lv === lv) || {}).name || `${lv}`;

// ---------------------------------------------------------------- three.js
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0a0d12);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0a0d12, 500, 1500);
const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 4000);
camera.position.set(-260, 330, 380);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 30;
controls.maxDistance = 1400;
controls.target.set(0, -6, 0);
controls.screenSpacePanning = false;
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x101418, 1.25));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(-200, 400, 150);
scene.add(sun);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- 模型
const N = data.nodes;
const P = (i) => new THREE.Vector3(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
const lvColor = (lv) => {
  if (lv >= 1) return new THREE.Color().setHSL(0.09, 0.55, 0.62 - Math.min(lv, 4) * 0.03);
  if (lv >= 0) return new THREE.Color(0xb9c4d4);
  return new THREE.Color().setHSL(0.53 + Math.min(-lv, 7) * 0.025, 0.55, 0.6 - Math.min(-lv, 7) * 0.035);
};
const levelGroups = new Map(); // lv -> {group, mats:[]}
function lvGroup(lv) {
  const k = Math.round(lv);
  if (!levelGroups.has(k)) {
    const g = new THREE.Group();
    g.name = 'lv' + k;
    scene.add(g);
    levelGroups.set(k, { group: g, mats: [] });
  }
  return levelGroups.get(k);
}
function trackMat(lv, mat) {
  mat.userData.baseOpacity = mat.opacity;
  lvGroup(lv).mats.push(mat);
  return mat;
}

// 地面
{
  const g = new THREE.PlaneGeometry(4000, 4000);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({ color: 0x121821, transparent: true, opacity: 0.55, depthWrite: false });
  const ground = new THREE.Mesh(g, m);
  ground.position.y = -0.15;
  ground.renderOrder = -2;
  scene.add(ground);
  const grid = new THREE.GridHelper(1600, 80, 0x1c2533, 0x161d28);
  grid.position.y = -0.1;
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  scene.add(grid);
}

// 道路（地上の参考線）
if (data.roads?.length) {
  const pos = [];
  for (const r of data.roads) {
    for (let i = 0; i + 3 < r.length; i += 2) pos.push(r[i], 0, r[i + 1], r[i + 2], 0, r[i + 3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2b3546, transparent: true, opacity: 0.8 })));
}

// 建物
{
  const geos = [];
  for (const b of data.buildings) {
    const pts = [];
    for (let i = 0; i < b.r.length; i += 2) pts.push(new THREE.Vector2(b.r[i], -b.r[i + 1]));
    if (pts.length < 3) continue;
    const shape = new THREE.Shape(pts);
    const h = Math.max(2, b.h - b.b);
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, b.b, 0);
    geos.push(g);
  }
  if (geos.length) {
    const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    geos.forEach((g) => g.dispose());
    const mat = new THREE.MeshLambertMaterial({ color: 0x3a4a63, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.renderOrder = 3;
    scene.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30),
      new THREE.LineBasicMaterial({ color: 0x5c6f8f, transparent: true, opacity: 0.22, depthWrite: false }));
    edges.renderOrder = 3;
    scene.add(edges);
    state.buildingMeshes = [mesh, edges];
  }
}

// 線路
if (data.rails?.length) {
  const byColor = new Map();
  for (const r of data.rails) {
    const k = r.c || '#6b7790';
    if (!byColor.has(k)) byColor.set(k, []);
    const arr = byColor.get(k);
    for (let i = 0; i + 5 < r.p.length; i += 3) arr.push(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], r.p[i + 4], r.p[i + 5]);
  }
  for (const [c, pos] of byColor) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.55 })));
  }
}

const elevMats = [];
// 歩行ネットワーク（帯）
function ribbon(a, b, w) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz) || 1;
  const nx = (-dz / L) * w / 2, nz = (dx / L) * w / 2;
  return [
    a.x + nx, a.y, a.z + nz, a.x - nx, a.y, a.z - nz, b.x + nx, b.y, b.z + nz,
    a.x - nx, a.y, a.z - nz, b.x - nx, b.y, b.z - nz, b.x + nx, b.y, b.z + nz,
  ];
}
{
  const E = data.edges;
  const buckets = new Map(); // key -> {pos:[], color, lv}
  const wallPos = [], wallLine = [];
  const elevPos = [];
  for (let i = 0; i < E.length; i += 3) {
    const a = E[i], b = E[i + 1], k = E[i + 2];
    const pa = P(a), pb = P(b);
    if (k === KIND.ELEV) { elevPos.push(pa, pb); continue; }
    const lv = Math.round(Math.min(data.nodeLv[a], data.nodeLv[b]));
    const key = (k === KIND.STAIRS || k === KIND.ESC ? 'v' : 'f') + lv;
    if (!buckets.has(key)) buckets.set(key, { pos: [], lv, vert: key[0] === 'v' });
    const w = k === KIND.PLAT ? 1.4 : k === KIND.STAIRS || k === KIND.ESC ? 2.6 : 2.2;
    const lift = 0.05;
    pa.y += lift; pb.y += lift;
    buckets.get(key).pos.push(...ribbon(pa, pb, w));
    // POV 用の通路の壁（左右に高さ 2.6m の薄い面）
    if (k === KIND.WALK || k === KIND.RAMP) {
      const dx = pb.x - pa.x, dz = pb.z - pa.z, L = Math.hypot(dx, dz) || 1;
      const nx = (-dz / L) * 1.6, nz = (dx / L) * 1.6;
      for (const sgn of [1, -1]) {
        const ax = pa.x + nx * sgn, az = pa.z + nz * sgn, bx = pb.x + nx * sgn, bz = pb.z + nz * sgn;
        wallPos.push(ax, pa.y, az, bx, pb.y, bz, bx, pb.y + 2.6, bz, ax, pa.y, az, bx, pb.y + 2.6, bz, ax, pa.y + 2.6, az);
        for (const yy of [0, 2.6]) wallLine.push(ax, pa.y + yy, az, bx, pb.y + yy, bz);
      }
    }
  }
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
    const walls = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x8fa3c4, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(wallLine, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x9fb4d6, transparent: true, opacity: 0.22, depthWrite: false }));
    state.povWalls = [walls, lines];
    for (const o of state.povWalls) { o.visible = false; scene.add(o); }
  }
  for (const [, bk] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    const col = bk.vert ? new THREE.Color(0xffcf4a) : lvColor(bk.lv);
    const mat = trackMat(bk.lv, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: bk.vert ? 0.7 : 0.42, side: THREE.DoubleSide, depthWrite: false }));
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 1;
    lvGroup(bk.lv).group.add(mesh);
  }
  // エレベーター（柱）
  const seen = new Set();
  for (let i = 0; i < elevPos.length; i += 2) {
    const a = elevPos[i], b = elevPos[i + 1];
    const key = Math.round(a.x) + ',' + Math.round(a.z);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const g = new THREE.BoxGeometry(2.4, y1 - y0 + 2.4, 2.4);
    const m = new THREE.MeshBasicMaterial({ color: 0xff6fb5, transparent: true, opacity: 0.32, depthWrite: false });
    elevMats.push(m);
    const box = new THREE.Mesh(g, m);
    box.position.set(a.x, (y0 + y1) / 2 + 1.2, a.z);
    scene.add(box);
    seen.add(key);
  }
}

// ホーム
const platMeshes = [];
for (const [pi, p] of data.plats.entries()) {
  const pts = [];
  for (let i = 0; i < p.ring.length; i += 2) pts.push(new THREE.Vector2(p.ring[i], -p.ring[i + 1]));
  if (pts.length < 3) continue;
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.6, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, p.y - 0.62, 0);
  const line = lineByKey[p.lines[0]];
  const color = new THREE.Color(line?.color || '#8b96aa');
  const mat = trackMat(p.lv, new THREE.MeshLambertMaterial({ color: color.clone().lerp(new THREE.Color(0x4a5568), 0.35), transparent: true, opacity: 0.85 }));
  const mesh = new THREE.Mesh(g, mat);
  mesh.userData.plat = pi;
  lvGroup(p.lv).group.add(mesh);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g), trackMat(p.lv, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })));
  lvGroup(p.lv).group.add(edge);
  platMeshes.push(mesh);
}

// 改札
{
  const geo = new THREE.BoxGeometry(3.2, 1.1, 0.6);
  for (const gt of data.gates) {
    const p = P(gt.n);
    const lv = data.nodeLv[gt.n];
    const m = trackMat(lv, new THREE.MeshBasicMaterial({ color: gt.t ? 0xb98cff : 0x38c6ff, transparent: true, opacity: 0.9 }));
    const box = new THREE.Mesh(geo, m);
    box.position.set(p.x, p.y + 0.55, p.z);
    if (gt.dir != null) box.rotation.y = gt.dir;
    lvGroup(lv).group.add(box);
  }
}

// 店舗（点）
if (data.shops?.length) {
  const byLv = new Map();
  for (let i = 0; i < data.shops.length; i += 4) {
    const lv = data.shops[i + 3];
    if (!byLv.has(lv)) byLv.set(lv, []);
    byLv.get(lv).push(data.shops[i], data.shops[i + 1] + 0.4, data.shops[i + 2]);
  }
  for (const [lv, pos] of byLv) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = trackMat(lv, new THREE.PointsMaterial({ color: 0xff9d5c, size: 2.2, sizeAttenuation: true, transparent: true, opacity: 0.75, depthWrite: false }));
    lvGroup(lv).group.add(new THREE.Points(g, m));
  }
}

// ---------------------------------------------------------------- ラベル
const labels = [];
function addLabel(text, pos, cls, extra = {}) {
  const el = document.createElement('div');
  el.className = 'lbl ' + cls;
  el.textContent = text;
  if (extra.color) el.style.setProperty('--c', extra.color);
  document.body.appendChild(el);
  labels.push({ el, pos, cls, lv: extra.lv, always: !!extra.always, route: false });
}
for (const p of data.plats) {
  if (!p.label) continue;
  const line = lineByKey[p.lines[0]];
  let cx = 0, cz = 0;
  for (let i = 0; i < p.ring.length; i += 2) { cx += p.ring[i]; cz += p.ring[i + 1]; }
  cx /= p.ring.length / 2; cz /= p.ring.length / 2;
  addLabel(`${p.short || line?.short || ''} ${p.label}`.trim(), new THREE.Vector3(cx, p.y + 1, cz), 'plat', { color: line?.color, lv: p.lv });
}
for (const gt of data.gates) if (gt.name) addLabel(gt.name, P(gt.n).add(new THREE.Vector3(0, 2.4, 0)), 'gate', { lv: data.nodeLv[gt.n] });
for (const x of data.exits) if (x.n != null) addLabel(x.name, P(x.n).add(new THREE.Vector3(0, 4, 0)), 'exit', { lv: data.nodeLv[x.n] });

const _v = new THREE.Vector3();
const PRIO = { exit: 0, gate: 2, plat: 1 };
function updateLabels() {
  const w = innerWidth, h = innerHeight;
  const placed = [];
  const dist = camera.position.distanceTo(controls.target);
  const pov = state.mode === 'pov';
  const order = labels.slice().sort((a, b) => (b.route - a.route) || (PRIO[a.cls] - PRIO[b.cls]));
  for (const L of order) {
    let show;
    if (pov) show = L.route && L.pos.distanceTo(camera.position) < 90;
    else if (state.route) show = L.route || (L.cls === 'plat' && dist < 380);
    else show = L.cls === 'plat' ? dist < 700 : L.cls === 'exit' ? dist < 900 : dist < 330;
    if (show && state.focusLv != null && L.lv != null && Math.round(L.lv) !== state.focusLv && !L.route) show = false;
    if (show) {
      _v.copy(L.pos).project(camera);
      if (_v.z > 1 || _v.x < -1.1 || _v.x > 1.1 || _v.y < -1.1 || _v.y > 1.1) show = false;
    }
    let sx = 0, sy = 0;
    if (show) {
      sx = ((_v.x + 1) / 2) * w; sy = ((1 - _v.y) / 2) * h;
      if (!L.w) L.w = L.el.textContent.length * 11 + 16;
      const r = [sx - L.w / 2, sy - 30, sx + L.w / 2, sy - 6];
      if (!L.route && placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) show = false;
      else placed.push(r);
    }
    if (!show) { if (L.vis !== false) { L.el.style.display = 'none'; L.vis = false; } continue; }
    if (L.vis !== true) { L.el.style.display = ''; L.vis = true; }
    L.el.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-120%)`;
  }
}

// ---------------------------------------------------------------- レベル切替
{
  const box = $('#levelBtns');
  const lvs = data.levels.map((l) => l.lv).sort((a, b) => b - a);
  const mk = (txt, lv, col) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = (col ? `<i style="background:${col}"></i>` : '') + txt;
    b.onclick = () => setFocus(lv);
    b.dataset.lv = lv == null ? 'all' : lv;
    box.appendChild(b);
  };
  mk('全体', null);
  for (const lv of lvs) mk(levelName(lv), lv, '#' + lvColor(lv).getHexString());
  setFocus(null);
}
function setFocus(lv) {
  state.focusLv = lv;
  for (const b of document.querySelectorAll('#levelBtns button')) b.classList.toggle('on', b.dataset.lv === (lv == null ? 'all' : String(lv)));
  for (const [k, g] of levelGroups) {
    const f = lv == null || k === lv ? 1 : 0.12;
    for (const m of g.mats) m.opacity = m.userData.baseOpacity * f;
  }
  if (lv != null && state.mode !== 'pov') {
    const y = levelY.get(lv) ?? 0;
    flyTo(new THREE.Vector3(controls.target.x, y, controls.target.z), null, 600);
  }
}

// ---------------------------------------------------------------- 選択UI
const sheet = $('#sheet');
let sheetSide = 'from';
function optionMeta(key) {
  if (!key) return null;
  if (key.startsWith('x:')) {
    const x = exitByKey[key.slice(2)];
    return x && { name: x.name, sub: x.sub || '改札・出口', color: null, exit: true };
  }
  const l = lineByKey[key];
  return l && { name: l.name, sub: l.sub || '', color: l.color, exit: false };
}
function renderSelect(btn, key) {
  const m = optionMeta(key);
  btn.classList.toggle('unset', !m);
  const dot = btn.querySelector('.dot');
  dot.className = 'dot' + (m?.exit ? ' exit' : '');
  dot.style.background = m?.color || '';
  btn.querySelector('b').textContent = m ? m.name + (m.sub ? '（' + m.sub + '）' : '') : '選択してください';
}
function openSheet(side) {
  sheetSide = side;
  $('#sheetTitle').textContent = side === 'from' ? '乗ってきた路線・出発地' : '乗り換える路線・行き先';
  const body = $('#sheetBody');
  body.innerHTML = '';
  const groups = [];
  for (const op of data.ops) {
    const ls = data.lines.filter((l) => l.op === op.key);
    if (ls.length) groups.push([op.name, ls.map((l) => ['' + l.key, l.name, l.sub, l.color, false])]);
  }
  groups.push(['改札・出口', data.exits.map((x) => ['x:' + x.key, x.name, x.sub, null, true])]);
  const cur = side === 'from' ? state.from : state.to;
  const other = side === 'from' ? state.to : state.from;
  for (const [title, items] of groups) {
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.innerHTML = `<h3>${title}</h3><div class="list"></div>`;
    const list = grp.querySelector('.list');
    for (const [key, name, sub, color, exit] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt' + (key === cur ? ' sel' : '');
      b.innerHTML = `<i class="dot${exit ? ' exit' : ''}" style="${color ? 'background:' + color : ''}"></i><span><b></b><small></small></span>`;
      b.querySelector('b').textContent = name;
      b.querySelector('small').textContent = sub || '';
      if (key === other || (exit && other?.startsWith('x:'))) b.disabled = true;
      b.onclick = () => { setPick(side, key); closeSheet(); };
      list.appendChild(b);
    }
    body.appendChild(grp);
  }
  sheet.hidden = false;
}
function closeSheet() { sheet.hidden = true; }
$('#sheetClose').onclick = closeSheet;
sheet.querySelector('.sheet-bg').onclick = closeSheet;
$('#fromBtn').onclick = () => openSheet('from');
$('#toBtn').onclick = () => openSheet('to');
$('#swapBtn').onclick = () => { const f = state.from; setPick('from', state.to); setPick('to', f); };
function setPick(side, key) {
  state[side] = key;
  renderSelect(side === 'from' ? $('#fromBtn') : $('#toBtn'), key);
  $('#goBtn').disabled = !(state.from && state.to && state.from !== state.to);
  $('#err').hidden = true;
  saveHash();
}
renderSelect($('#fromBtn'), null);
renderSelect($('#toBtn'), null);

for (const b of document.querySelectorAll('#speedSeg button')) {
  b.onclick = () => {
    state.speed = +b.dataset.v;
    for (const x of document.querySelectorAll('#speedSeg button')) x.classList.toggle('on', x === b);
  };
}
$('#bfChk').onchange = (e) => { state.bf = e.target.checked; if (state.route) runRoute(false); };

// プリセット
for (const [f, t] of data.presets || []) {
  const a = optionMeta(f), b = optionMeta(t);
  if (!a || !b) continue;
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'chip';
  c.innerHTML = `<i style="background:${a.color || '#c9d2df'}"></i><span></span><i style="background:${b.color || '#c9d2df'}"></i>`;
  c.querySelector('span').textContent = `${a.name} → ${b.name}`;
  c.onclick = () => { setPick('from', f); setPick('to', t); runRoute(true); };
  $('#presets').appendChild(c);
}

$('#goBtn').onclick = () => runRoute(true);
$('#menuBtn').onclick = () => backToPlan();
$('#playBtn2').onclick = () => startPov();
$('#overviewBtn').onclick = () => fitRoute();

function saveHash() {
  if (state.from && state.to) history.replaceState(null, '', '#' + encodeURIComponent(state.from) + '>' + encodeURIComponent(state.to));
}

// ---------------------------------------------------------------- 経路
let routeObj = null;
function clearRoute() {
  if (routeObj) { scene.remove(routeObj); routeObj.traverse((o) => { o.geometry?.dispose(); }); routeObj = null; }
  for (const L of labels) L.route = false;
}
function runRoute(play) {
  const r = state.graph.route(state.from, state.to, { bf: state.bf });
  if (!r) {
    $('#err').textContent = state.bf
      ? 'エレベーターだけで行けるルートが見つかりませんでした（地図データ不足の可能性があります）。'
      : 'ルートが見つかりませんでした（地図データ不足の可能性があります）。';
    $('#err').hidden = false;
    return;
  }
  state.route = r;
  clearRoute();
  buildRouteMesh(r);
  showSummary(r);
  saveHash();
  if (play) startPov(); else fitRoute();
}

function buildRouteMesh(r) {
  const g = new THREE.Group();
  const pts = r.nodes.map((n) => P(n).add(new THREE.Vector3(0, 0.6, 0)));
  const color = state.bf ? 0xff6fb5 : 0x37e2a0;
  // チューブ（区間ごとに直線で）
  const pos = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.distanceTo(b) < 0.01) continue;
    const seg = new THREE.CylinderGeometry(0.9, 0.9, a.distanceTo(b), 8, 1, true);
    seg.translate(0, a.distanceTo(b) / 2, 0);
    seg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    seg.translate(a.x, a.y, a.z);
    pos.push(seg.toNonIndexed());
    const j = new THREE.SphereGeometry(0.9, 8, 6);
    j.translate(b.x, b.y, b.z);
    pos.push(j.toNonIndexed());
  }
  if (pos.length) {
    const merged = mergeGeometries(pos.map((p) => { p.deleteAttribute('uv'); return p; }), false);
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }));
    mesh.renderOrder = 9;
    g.add(mesh);
    const front = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color }));
    front.renderOrder = 10;
    g.add(front);
    g.userData.tube = [mesh, front];
  }
  // POV 用: 床に引いた案内線
  {
    const fp = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i].clone(), b = pts[i + 1].clone();
      a.y -= 0.52; b.y -= 0.52;
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.05) continue;
      fp.push(...ribbon(a, b, 0.7));
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    const floor = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }));
    floor.renderOrder = 8;
    floor.visible = false;
    g.add(floor);
    g.userData.floor = floor;
  }
  // 始点・終点の柱
  g.userData.pillars = [];
  for (const [p, c] of [[pts[0], 0xffffff], [pts[pts.length - 1], color]]) {
    const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 30, 6), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.6 }));
    pil.position.set(p.x, p.y + 15, p.z);
    g.add(pil);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.25, 6, 32), new THREE.MeshBasicMaterial({ color: c }));
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(p);
    g.add(ring);
    g.userData.pillars.push(pil, ring);
  }
  // 移動マーカー
  const marker = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  marker.position.copy(pts[0]);
  g.add(marker);
  g.userData.marker = marker;
  scene.add(g);
  routeObj = g;
  // 経路上のラベルを強調
  const onRoute = new Set(r.nodes);
  for (const gt of data.gates) if (onRoute.has(gt.n) && gt.name) {
    const L = labels.find((l) => l.cls === 'gate' && l.el.textContent === gt.name && l.pos.distanceTo(P(gt.n)) < 5);
    if (L) L.route = true;
  }
  for (const L of labels) if (L.cls === 'plat') {
    const pi = data.plats.findIndex((p) => p.label && L.el.textContent.endsWith(p.label) && Math.abs(p.y + 1 - L.pos.y) < 0.01);
    if (pi === r.fromPlat || pi === r.toPlat) L.route = true;
  }
}

function showSummary(r) {
  $('#planner').hidden = true;
  $('#summary').hidden = false;
  document.body.classList.remove('planning');
  const a = optionMeta(state.from), b = optionMeta(state.to);
  const lab = (m, plat) => `<div><i class="dot${m.exit ? ' exit' : ''}" style="${m.color ? 'background:' + m.color : ''}"></i><span></span></div>` + (plat ? `<small>${plat}</small>` : '');
  const fp = r.fromPlat != null ? data.plats[r.fromPlat].label : '';
  const tp = r.toPlat != null ? data.plats[r.toPlat].label : '';
  $('#sumRoute').innerHTML = lab(a, fp) + lab(b, tp);
  const spans = $('#sumRoute').querySelectorAll('div span');
  spans[0].textContent = a.name; spans[1].textContent = '→ ' + b.name;
  $('#sumTime').textContent = Math.max(1, Math.round(r.time / 60));
  $('#sumDist').textContent = Math.round(r.dist);
  $('#sumUp').textContent = r.vertCount;
  const warn = $('#sumWarn');
  if (state.bf && r.bfStairs) {
    warn.textContent = 'エレベーターだけでつながる経路が地図データに見つからず、階段・エスカレーターを含む経路を表示しています。';
    warn.hidden = false;
  } else warn.hidden = true;
  const ol = $('#steps');
  ol.innerHTML = '';
  for (const s of r.steps) {
    const li = document.createElement('li');
    li.className = s.cls || '';
    li.innerHTML = `<span class="k">${s.icon}</span><span><b></b><small></small></span><em class="mono"></em>`;
    li.querySelector('b').textContent = s.text;
    li.querySelector('small').textContent = s.sub || '';
    li.querySelector('em').textContent = s.dist ? Math.round(s.dist) + 'm' : '';
    li.onclick = () => { const p = r.pts[s.i]; flyTo(p.clone(), p.clone().add(new THREE.Vector3(-35, 45, 55)), 700); };
    ol.appendChild(li);
  }
}

function backToPlan() {
  stopPov();
  clearRoute();
  state.route = null;
  $('#summary').hidden = true;
  $('#planner').hidden = false;
  document.body.classList.add('planning');
  flyTo(new THREE.Vector3(0, -6, 0), new THREE.Vector3(-260, 330, 380), 900);
}

function fitRoute() {
  stopPov();
  const r = state.route;
  if (!r) return;
  const box = new THREE.Box3();
  for (const p of r.pts) box.expandByPoint(p);
  const c = box.getCenter(new THREE.Vector3());
  const size = Math.max(150, box.getSize(new THREE.Vector3()).length());
  const mobile = innerWidth < 640;
  const off = new THREE.Vector3(-0.55, 0.85, 0.75).normalize().multiplyScalar(size * (mobile ? 1.55 : 1.15));
  if (!mobile && innerWidth > 900) c.add(new THREE.Vector3(-size * 0.18, 0, 0)); // パネル分ずらす
  if (mobile) c.add(new THREE.Vector3(0, -size * 0.15, size * 0.2));
  flyTo(c, c.clone().add(off), 900);
}

// ---------------------------------------------------------------- カメラ移動
let fly = null;
function flyTo(target, pos, ms) {
  fly = { t0: performance.now(), ms, ft: controls.target.clone(), tt: target, fp: camera.position.clone(), tp: pos || camera.position.clone().add(target.clone().sub(controls.target)) };
}
function stepFly(now) {
  if (!fly) return;
  let t = Math.min(1, (now - fly.t0) / fly.ms);
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  controls.target.lerpVectors(fly.ft, fly.tt, e);
  camera.position.lerpVectors(fly.fp, fly.tp, e);
  if (t >= 1) fly = null;
}

// ---------------------------------------------------------------- POV
function startPov() {
  const r = state.route;
  if (!r) return;
  stopPov();
  state.mode = 'pov';
  document.body.classList.add('pov');
  $('#hud').hidden = false;
  $('#summary').hidden = true;
  controls.enabled = false;
  fly = null;
  const fader = $('#fader');
  fader.style.opacity = 1;
  setTimeout(() => (fader.style.opacity = 0), 250);
  state.pov = { t: 0, paused: false, last: performance.now(), look: null, done: false };
  if (state.buildingMeshes) state.buildingMeshes.forEach((m) => (m.visible = false));
  povVisuals(true);
  scene.fog.near = 40; scene.fog.far = 260;
}
function povVisuals(on) {
  for (const o of state.povWalls || []) o.visible = on;
  for (const m of elevMats) m.opacity = on ? 0.1 : 0.32;
  if (!routeObj) return;
  const u = routeObj.userData;
  for (const o of [...(u.tube || []), ...(u.pillars || []), u.marker]) if (o) o.visible = !on;
  if (u.floor) u.floor.visible = on;
}
function stopPov() {
  if (state.mode !== 'pov') return;
  state.mode = 'view';
  state.pov = null;
  document.body.classList.remove('pov');
  $('#hud').hidden = true;
  $('#summary').hidden = false;
  controls.enabled = true;
  if (state.buildingMeshes) state.buildingMeshes.forEach((m) => (m.visible = true));
  povVisuals(false);
  setFocus(state.focusLv);
  scene.fog.near = 500; scene.fog.far = 1500;
  camera.fov = 50; camera.updateProjectionMatrix();
}
$('#exitPov').onclick = (e) => { e.stopPropagation(); fitRoute(); };
$('#pauseBtn').onclick = (e) => { e.stopPropagation(); togglePause(); };
function togglePause() {
  const pv = state.pov;
  if (!pv) return;
  if (pv.done) { pv.t = 0; pv.done = false; pv.paused = false; }
  else pv.paused = !pv.paused;
  $('#pauseBtn').textContent = pv.paused ? '▶' : '❚❚';
}
// タップ / スワイプ
{
  let sx = null, st = 0, moved = false;
  canvas.addEventListener('pointerdown', (e) => { if (state.mode !== 'pov') return; sx = e.clientX; st = state.pov.t; moved = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (state.mode !== 'pov' || sx == null) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 8) moved = true;
    if (moved) {
      const T = state.route.vtime;
      state.pov.t = Math.max(0, Math.min(T, st + (dx / innerWidth) * T * 0.6));
      state.pov.done = false;
    }
  });
  canvas.addEventListener('pointerup', () => { if (state.mode !== 'pov') return; if (!moved) togglePause(); sx = null; });
  $('#bar').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    state.pov.t = ((e.clientX - r.left) / r.width) * state.route.vtime;
    state.pov.done = false;
  });
}

const _look = new THREE.Vector3();
function stepPov(now) {
  const pv = state.pov, r = state.route;
  const dt = Math.min(0.1, (now - pv.last) / 1000);
  pv.last = now;
  if (!pv.paused && !pv.done) {
    pv.t += dt * SPEEDS[state.speed];
    if (pv.t >= r.vtime) { pv.t = r.vtime; pv.done = true; $('#pauseBtn').textContent = '↺'; }
  }
  const s = r.sAtVtime(pv.t);
  const pos = r.at(s);
  // 見る方向：少し先（階段では縦方向も）
  const ahead = r.at(Math.min(r.dist, s + 7));
  const tgt = ahead.clone();
  if (r.dist - s < 2) tgt.copy(r.at(r.dist)).add(r.dirAt(r.dist).multiplyScalar(5));
  tgt.y = tgt.y + EYE - 0.25;
  if (!pv.look) pv.look = tgt.clone();
  pv.look.lerp(tgt, 1 - Math.exp(-dt * 5));
  camera.position.set(pos.x, pos.y + EYE, pos.z);
  camera.lookAt(pv.look);
  if (camera.fov !== 72) { camera.fov = 72; camera.updateProjectionMatrix(); }
  routeObj.userData.marker.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0));
  // HUD
  const st = r.nextManeuver(s);
  $('#navIcon').textContent = st.icon;
  $('#navIcon').className = st.cls || '';
  $('#navText').textContent = st.text;
  $('#navSub').textContent = st.sub || '';
  $('#navDist').textContent = st.d > 0.5 ? Math.round(st.d) + 'm' : '';
  $('#bar i').style.width = (pv.t / r.vtime) * 100 + '%';
  $('#remain').textContent = Math.round(r.dist - s) + 'm';
  drawMinimap(pos, r.dirAt(s), s);
  // 現在の階にフォーカス
  const lv = Math.round(r.lvAt(s));
  if (lv !== pv.lv) {
    pv.lv = lv;
    for (const [k, g] of levelGroups) {
      const f = Math.abs(k - lv) <= 0 ? 1 : 0.25;
      for (const m of g.mats) m.opacity = m.userData.baseOpacity * f;
    }
  }
}

// ミニマップ（進行方向が上）
const mm = $('#minimap'), mctx = mm.getContext('2d');
const mmEdges = [];
for (let i = 0; i < data.edges.length; i += 3) mmEdges.push(data.edges[i], data.edges[i + 1], data.edges[i + 2]);
function drawMinimap(pos, dir, s) {
  const W = mm.width, H = mm.height, scale = 1.6;
  mctx.clearRect(0, 0, W, H);
  const ang = Math.atan2(dir.x, -dir.z);
  mctx.save();
  mctx.translate(W / 2, H / 2 + 30);
  mctx.rotate(-ang);
  const E = mmEdges;
  mctx.lineCap = 'round';
  for (let i = 0; i < E.length; i += 3) {
    const a = E[i], b = E[i + 1];
    const ya = N[a * 3 + 1], yb = N[b * 3 + 1];
    const near = Math.abs((ya + yb) / 2 - pos.y) < 3;
    const ax = (N[a * 3] - pos.x) * scale, az = (N[a * 3 + 2] - pos.z) * scale;
    if (Math.abs(ax) > 260 || Math.abs(az) > 260) continue;
    const bx = (N[b * 3] - pos.x) * scale, bz = (N[b * 3 + 2] - pos.z) * scale;
    mctx.strokeStyle = near ? 'rgba(185,196,212,.55)' : 'rgba(120,135,160,.12)';
    mctx.lineWidth = near ? 4 : 2;
    mctx.beginPath(); mctx.moveTo(ax, az); mctx.lineTo(bx, bz); mctx.stroke();
  }
  // ホーム
  for (const p of data.plats) {
    if (Math.abs(p.y - pos.y) > 3) continue;
    mctx.fillStyle = (lineByKey[p.lines[0]]?.color || '#888') + '66';
    mctx.beginPath();
    for (let i = 0; i < p.ring.length; i += 2) {
      const x = (p.ring[i] - pos.x) * scale, z = (p.ring[i + 1] - pos.z) * scale;
      i ? mctx.lineTo(x, z) : mctx.moveTo(x, z);
    }
    mctx.fill();
  }
  const r = state.route;
  mctx.strokeStyle = state.bf ? '#ff6fb5' : '#37e2a0';
  mctx.lineWidth = 5;
  mctx.beginPath();
  r.pts.forEach((p, i) => { const x = (p.x - pos.x) * scale, z = (p.z - pos.z) * scale; i ? mctx.lineTo(x, z) : mctx.moveTo(x, z); });
  mctx.stroke();
  mctx.restore();
  // 自分
  mctx.fillStyle = '#fff';
  mctx.beginPath();
  mctx.moveTo(W / 2, H / 2 + 30 - 14); mctx.lineTo(W / 2 - 9, H / 2 + 30 + 9); mctx.lineTo(W / 2 + 9, H / 2 + 30 + 9);
  mctx.closePath(); mctx.fill();
}

// ---------------------------------------------------------------- ループ
function loop(now) {
  requestAnimationFrame(loop);
  if (state.mode === 'pov' && state.pov) stepPov(now);
  else {
    stepFly(now);
    controls.update();
    if (routeObj && state.route) {
      const r = state.route;
      const k = ((now / 1000) * 0.12) % 1;
      routeObj.userData.marker.position.copy(r.at(k * r.dist)).add(new THREE.Vector3(0, 0.6, 0));
    }
  }
  renderer.render(scene, camera);
  updateLabels();
}
document.body.classList.add('planning');
requestAnimationFrame(loop);
$('#loading').style.opacity = 0;
setTimeout(() => $('#loading').remove(), 500);

// URL から復元
if (location.hash.includes('>')) {
  const [f, t] = location.hash.slice(1).split('>').map(decodeURIComponent);
  if (optionMeta(f) && optionMeta(t)) { setPick('from', f); setPick('to', t); runRoute(false); }
}
window.__app = { state, data, camera, controls, scene, runRoute, setPick, startPov, fitRoute };
