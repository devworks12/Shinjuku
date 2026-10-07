// 新宿駅乗り換え3Dアプリ — 画面・カメラ・POV
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { StationModel, floorJP } from './model.js';
import { Graph } from './route.js';

const $ = (s) => document.querySelector(s);
const EYE = 1.6;
const SPEED = { 1: 4, 2: 8, 3: 14 }; // 実時間に対する再生倍率

const state = { from: null, to: null, speed: 2, routes: [], sel: 0, mode: 'plan', pov: null, focus: null };

// ---------------------------------------------------------------- データ
let data;
try {
  const res = await fetch('data/station.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(res.status);
  data = await res.json();
} catch (e) {
  $('#loadMsg').textContent = '駅データを読み込めませんでした（' + e.message + '）';
  throw e;
}
const graph = new Graph(data, (x, y, z) => new THREE.Vector3(x, y, z));
const lineBy = Object.fromEntries(data.lines.map((l) => [l.key, l]));
const exitBy = Object.fromEntries(data.exits.map((x) => [x.key, x]));
const N = data.nodes;

// ---------------------------------------------------------------- three.js
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
const BG_PLAN = new THREE.Color(0x0b0f16), BG_POV = new THREE.Color(0xdde1e6);
scene.background = BG_PLAN.clone();
scene.fog = new THREE.Fog(0x0b0f16, 700, 2200);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xffffff, 0x404a58, 0.45));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(-300, 500, 200);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(45, 1, 0.2, 5000);
const HOME_T = new THREE.Vector3(10, -4, 20), HOME_P = new THREE.Vector3(-330, 380, 420);
camera.position.copy(HOME_P);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 12;
controls.maxDistance = 1600;
controls.target.copy(HOME_T);
controls.screenSpacePanning = false;
controls.zoomToCursor = true;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- 模型
const model = new StationModel(data, scene);

// ---------------------------------------------------------------- ラベル
const labels = model.labels.map((L) => {
  const el = document.createElement('div');
  el.className = 'lbl ' + L.cls;
  el.textContent = L.text;
  if (L.color) el.style.setProperty('--c', L.color);
  el.style.display = 'none';
  document.body.appendChild(el);
  return { ...L, el, vis: false, w: L.text.length * 11 + 16, route: false };
});
const PRIO = { exit: 0, plat: 1, gate: 2, bldg: 3 };
const _v = new THREE.Vector3();
function updateLabels() {
  const w = innerWidth, h = innerHeight, pov = state.mode === 'pov';
  const dist = camera.position.distanceTo(controls.target);
  const placed = [];
  const order = labels.slice().sort((a, b) => (b.route - a.route) || (PRIO[a.cls] - PRIO[b.cls]));
  for (const L of order) {
    let show = !pov;
    if (show) {
      if (L.route) show = true;
      else if (L.cls === 'plat') show = dist < 650;
      else if (L.cls === 'gate') show = dist < (state.routes.length ? 160 : 260);
      else if (L.cls === 'bldg') show = dist > 250 && dist < 1300;
      if (state.focus != null && L.lv != null && Math.round(L.lv) > state.focus) show = false;
    }
    let sx = 0, sy = 0;
    if (show) {
      _v.copy(L.pos).project(camera);
      if (_v.z > 1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05) show = false;
      else {
        sx = ((_v.x + 1) / 2) * w; sy = ((1 - _v.y) / 2) * h;
        const rc = [sx - L.w / 2, sy - 28, sx + L.w / 2, sy - 6];
        if (!L.route && placed.some((q) => rc[0] < q[2] && rc[2] > q[0] && rc[1] < q[3] && rc[3] > q[1])) show = false;
        else placed.push(rc);
      }
    }
    if (!show) { if (L.vis) { L.el.style.display = 'none'; L.vis = false; } continue; }
    if (!L.vis) { L.el.style.display = ''; L.vis = true; }
    L.el.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-120%)`;
  }
}

// ---------------------------------------------------------------- 階の切り替え
{
  const box = $('#levels');
  const mk = (txt, lv) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = txt;
    b.dataset.lv = lv == null ? 'all' : lv;
    b.onclick = () => setFocus(lv);
    box.appendChild(b);
  };
  mk('全体', null);
  for (const l of data.levels.slice().sort((a, b) => b.lv - a.lv)) mk(floorJP(l.lv), l.lv);
}
function setFocus(lv) {
  state.focus = lv;
  for (const b of document.querySelectorAll('#levels button')) b.classList.toggle('on', b.dataset.lv === (lv == null ? 'all' : String(lv)));
  for (const [k, rec] of model.levels) rec.group.visible = lv == null || k <= lv;
  for (const b of model.buildings || []) b.visible = lv == null || lv >= 0;
  if (lv != null && state.mode !== 'pov') {
    const y = (data.levels.find((l) => l.lv === lv) || {}).y ?? 0;
    flyTo(new THREE.Vector3(controls.target.x, y, controls.target.z), null, 600);
  }
}
setFocus(null);

// ---------------------------------------------------------------- 選択
const opMeta = (key) => {
  if (!key) return null;
  if (key.startsWith('x:')) {
    const x = exitBy[key.slice(2)];
    return x && { name: x.name, sub: x.sub, color: '#e8ebf0', exit: true };
  }
  const l = lineBy[key];
  return l && { name: l.name, sub: l.sub, color: l.color, exit: false };
};
const shortSub = (s) => (s || '').replace(/\s*[\d・〜]+番(線|ホーム)$/, '');
function renderPick(btn, key) {
  const m = opMeta(key);
  btn.classList.toggle('unset', !m);
  btn.querySelector('.sq').style.background = m?.color || '';
  btn.querySelector('b').textContent = m ? m.name + (m.sub && !m.exit ? '（' + shortSub(m.sub) + '）' : '') : 'タップで一覧';
}
function setPick(side, key) {
  state[side] = key;
  renderPick(side === 'from' ? $('#fromBtn') : $('#toBtn'), key);
  $('#goBtn').disabled = !(state.from && state.to && state.from !== state.to);
  $('#err').textContent = '';
}
renderPick($('#fromBtn'), null);
renderPick($('#toBtn'), null);
$('#goBtn').disabled = true;

const sheet = $('#sheet');
function openSheet(side) {
  $('#sheetTitle').textContent = side === 'from' ? '乗ってきた路線' : '乗り換える路線・行き先';
  const body = $('#sheetBody');
  body.innerHTML = '';
  const groups = [];
  for (const op of data.ops) {
    const ls = data.lines.filter((l) => l.op === op.key);
    if (ls.length) groups.push([op.name, ls.map((l) => [l.key, l.name, l.sub, l.color])]);
  }
  groups.push(['改札・出口', data.exits.map((x) => ['x:' + x.key, x.name, x.sub, '#e8ebf0'])]);
  const cur = state[side], other = state[side === 'from' ? 'to' : 'from'];
  for (const [title, items] of groups) {
    const g = document.createElement('div');
    g.className = 'grp';
    g.innerHTML = '<h3></h3><div class="list"></div>';
    g.querySelector('h3').textContent = title;
    for (const [key, name, sub, color] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt' + (key === cur ? ' sel' : '');
      b.innerHTML = '<i class="sq"></i><span><b></b><small></small></span>';
      b.querySelector('.sq').style.background = color;
      b.querySelector('b').textContent = name;
      b.querySelector('small').textContent = sub || '';
      if (key === other || (key.startsWith('x:') && other?.startsWith('x:'))) b.disabled = true;
      b.onclick = () => { setPick(side, key); sheet.hidden = true; };
      g.querySelector('.list').appendChild(b);
    }
    body.appendChild(g);
  }
  sheet.hidden = false;
}
$('#fromBtn').onclick = () => openSheet('from');
$('#toBtn').onclick = () => openSheet('to');
$('#sheetClose').onclick = () => (sheet.hidden = true);
sheet.querySelector('.sheet-bg').onclick = () => (sheet.hidden = true);
$('#swapBtn').onclick = () => { const f = state.from; setPick('from', state.to); setPick('to', f); };
for (const b of document.querySelectorAll('#speedSeg button')) {
  b.onclick = () => {
    state.speed = +b.dataset.v;
    for (const x of document.querySelectorAll('#speedSeg button')) x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
  };
}
for (const [f, t] of data.presets || []) {
  const a = opMeta(f), b = opMeta(t);
  if (!a || !b) continue;
  const c = document.createElement('button');
  c.type = 'button';
  c.textContent = `${a.name} → ${b.name}`;
  c.onclick = () => { setPick('from', f); setPick('to', t); go(true); };
  $('#presets').appendChild(c);
}
$('#controls').addEventListener('submit', (e) => { e.preventDefault(); go(true); });
$('#replayBtn').onclick = () => startPov();
$('#replayBtn2').onclick = () => startPov();
$('#overviewBtn').onclick = () => { stopPov(); fitRoute(); };
$('#overviewBtn2').onclick = () => { stopPov(); fitRoute(); };
$('#menuBtn').onclick = () => { stopPov(); fitRoute(); };

// ---------------------------------------------------------------- 経路
function go(play) {
  if (!state.from || !state.to || state.from === state.to) return;
  const rs = graph.routes(state.from, state.to);
  if (!rs.length) { $('#err').textContent = 'ルートが見つかりませんでした（地図データ不足の可能性があります）。'; return; }
  state.routes = rs;
  state.sel = 0;
  history.replaceState(null, '', '#' + encodeURIComponent(state.from) + '>' + encodeURIComponent(state.to));
  document.body.classList.add('routed');
  renderBoard();
  selectRoute(0, !play);
  if (play) startPov();
}
function renderBoard() {
  const a = opMeta(state.from), b = opMeta(state.to);
  const r0 = state.routes[0];
  const sm = $('#summary');
  sm.innerHTML = `<div class="ln"><span class="c1">■</span><span class="n1"></span> → <span class="c2">■</span><span class="n2"></span></div>
    <div><span class="big mono"></span>　<span class="meta tm"></span></div>
    <div class="meta cnt"></div>`;
  sm.querySelector('.c1').style.color = a.color; sm.querySelector('.c2').style.color = b.color;
  sm.querySelector('.n1').textContent = a.name; sm.querySelector('.n2').textContent = b.name;
  sm.querySelector('.big').textContent = `約${Math.round(r0.dist / 10) * 10}m`;
  sm.querySelector('.tm').textContent = `徒歩の目安 約${Math.max(1, Math.round(r0.time / 60))}分`;
  sm.querySelector('.cnt').textContent = `ルート候補 ${state.routes.length} 本（押すと切り替わります）`;
  const box = $('#ropts');
  box.innerHTML = '';
  state.routes.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ropt' + (r.kind === 'bf' ? ' bf' : '') + (i === state.sel ? ' on' : '');
    btn.innerHTML = '<b></b><span class="tag"></span><span class="mono"></span><span class="gates"></span>';
    btn.querySelector('b').textContent = r.label;
    btn.querySelector('.tag').textContent = r.tagline || '';
    btn.querySelector('.mono').textContent = `約${Math.round(r.dist / 10) * 10}m・屋外${Math.round(r.outdoor / 10) * 10}m・約${Math.max(1, Math.round(r.time / 60))}分`;
    btn.querySelector('.gates').textContent = r.gatesUsed.length ? '改札：' + r.gatesUsed.join(' → ') : '改札：通らない（改札内で乗り換え）';
    btn.onclick = () => { selectRoute(i, state.mode !== 'pov'); if (state.mode === 'pov') startPov(); };
    box.appendChild(btn);
  });
  $('#board').hidden = false;
  $('#viewBtns').hidden = false;
}
function selectRoute(i, fit) {
  state.sel = i;
  for (const [k, b] of [...document.querySelectorAll('.ropt')].entries()) b.classList.toggle('on', k === i);
  const r = state.routes[i];
  buildRouteMesh(r);
  renderSteps(r);
  const onRoute = new Set(r.nodes);
  for (const L of labels) L.route = L.cls === 'gate' && L.node != null && onRoute.has(L.node);
  if (fit) fitRoute();
}
function renderSteps(r) {
  const ol = $('#steps');
  ol.innerHTML = '';
  for (const s of r.steps) {
    const li = document.createElement('li');
    li.className = s.cls || '';
    li.innerHTML = '<span class="k"></span><span><b></b><small></small></span><em class="mono"></em>';
    li.querySelector('.k').textContent = s.icon;
    li.querySelector('b').textContent = s.text;
    li.querySelector('small').textContent = s.sub || '';
    li.querySelector('em').textContent = s.dist ? Math.round(s.dist) + 'm' : '';
    li.onclick = () => {
      if (state.mode === 'pov') stopPov();
      const p = r.pts[Math.max(0, Math.min(r.pts.length - 1, s.i))];
      flyTo(p.clone(), p.clone().add(new THREE.Vector3(-30, 40, 45)), 700);
    };
    ol.appendChild(li);
  }
}

// 経路の光るライン
let routeObj = null;
const routeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.55, 0.35), toneMapped: false });
const routeMatBf = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.0, 1.6), toneMapped: false });
const routeXray = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, toneMapped: false });
function tubeGeo(pts, rad) {
  const pos = [];
  const add = (g) => {
    const p = g.attributes.position.array, idx = g.index ? g.index.array : null;
    const cnt = idx ? idx.length : p.length / 3;
    for (let i = 0; i < cnt; i++) { const k = idx ? idx[i] : i; pos.push(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]); }
    g.dispose();
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = a.distanceTo(b);
    if (L < 0.02) continue;
    const g = new THREE.CylinderGeometry(rad, rad, L, 8, 1, true);
    g.translate(0, L / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate(a.x, a.y, a.z);
    add(g);
    const s = new THREE.SphereGeometry(rad, 8, 6);
    s.translate(b.x, b.y, b.z);
    add(s);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return out;
}
function buildRouteMesh(r) {
  if (routeObj) { scene.remove(routeObj); routeObj.traverse((o) => o.geometry?.dispose()); }
  const g = new THREE.Group();
  const pts = r.pts.map((p) => p.clone().add(new THREE.Vector3(0, 0.9, 0)));
  const tube = new THREE.Mesh(tubeGeo(pts, 0.85), r.kind === 'bf' ? routeMatBf : routeMat);
  const xray = new THREE.Mesh(tube.geometry, routeXray);
  xray.renderOrder = 20;
  g.add(tube, xray);
  // 床の案内線（POV 用）
  const fpos = [];
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    if (L < 0.05) continue;
    const nx = (-dz / L) * 0.22, nz = (dx / L) * 0.22, ya = a.y + 0.03, yb = b.y + 0.03;
    fpos.push(a.x + nx, ya, a.z + nz, b.x + nx, yb, b.z + nz, b.x - nx, yb, b.z - nz, a.x + nx, ya, a.z + nz, b.x - nx, yb, b.z - nz, a.x - nx, ya, a.z - nz);
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  const floor = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: r.kind === 'bf' ? new THREE.Color(1.1, 0.45, 0.75) : new THREE.Color(1.1, 0.68, 0.12), toneMapped: false, side: THREE.DoubleSide }));
  floor.visible = false;
  g.add(floor);
  const ends = [];
  for (const [p, c] of [[pts[0], 0xffffff], [pts[pts.length - 1], r.kind === 'bf' ? 0xff7ab8 : 0xffb020]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.3, 8, 40), new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(p).add(new THREE.Vector3(0, -0.8, 0));
    const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 40, 6), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.5, toneMapped: false }));
    pil.position.copy(p).add(new THREE.Vector3(0, 19, 0));
    g.add(ring, pil);
    ends.push(ring, pil);
  }
  const marker = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3), toneMapped: false }));
  g.add(marker);
  g.userData = { tube, xray, floor, ends, marker };
  scene.add(g);
  routeObj = g;
  if (state.mode === 'pov') povRouteVisuals(true);
}
function povRouteVisuals(on) {
  const u = routeObj?.userData;
  if (!u) return;
  u.tube.visible = u.xray.visible = u.marker.visible = !on;
  u.ends.forEach((o) => (o.visible = !on));
  u.floor.visible = on;
}

function fitRoute() {
  const r = state.routes[state.sel];
  if (!r) return;
  const box = new THREE.Box3();
  for (const p of r.pts) box.expandByPoint(p);
  const c = box.getCenter(new THREE.Vector3());
  const size = Math.max(110, box.getSize(new THREE.Vector3()).length());
  const mobile = innerWidth < 760;
  const off = new THREE.Vector3(-0.5, 0.95, 0.75).normalize().multiplyScalar(size * (mobile ? 1.8 : 1.2));
  if (!mobile) c.add(new THREE.Vector3(size * 0.08, 0, -size * 0.1));
  else c.add(new THREE.Vector3(0, 0, size * 0.3));
  flyTo(c, c.clone().add(off), 900);
}

// ---------------------------------------------------------------- カメラ移動
let fly = null;
function flyTo(target, pos, ms) {
  fly = { t0: performance.now(), ms, ft: controls.target.clone(), tt: target, fp: camera.position.clone(), tp: pos || camera.position.clone().add(target.clone().sub(controls.target)) };
}
function stepFly(now) {
  if (!fly) return;
  const t = Math.min(1, (now - fly.t0) / fly.ms);
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  controls.target.lerpVectors(fly.ft, fly.tt, e);
  camera.position.lerpVectors(fly.fp, fly.tp, e);
  if (t >= 1) fly = null;
}

// ---------------------------------------------------------------- POV
function startPov() {
  const r = state.routes[state.sel];
  if (!r) return;
  state.mode = 'pov';
  document.body.classList.add('pov');
  $('#pov').hidden = false;
  controls.enabled = false;
  fly = null;
  const fader = $('#fader');
  fader.style.opacity = 1;
  setTimeout(() => (fader.style.opacity = 0), 250);
  state.pov = { t: 0, paused: false, last: performance.now(), look: null, done: false, lv: null };
  $('#pauseBtn').textContent = '❚❚';
  model.setPov(true);
  for (const [, rec] of model.levels) rec.group.visible = true;
  for (const b of model.buildings || []) b.visible = true;
  povRouteVisuals(true);
  scene.background.copy(BG_POV);
  scene.fog.color.copy(BG_POV);
  scene.fog.near = 40; scene.fog.far = 220;
  camera.fov = 70; camera.updateProjectionMatrix();
  bloom.strength = 0.35;
}
function stopPov() {
  if (state.mode !== 'pov') return;
  state.mode = 'view';
  state.pov = null;
  document.body.classList.remove('pov');
  $('#pov').hidden = true;
  controls.enabled = true;
  model.setPov(false);
  povRouteVisuals(false);
  scene.background.copy(BG_PLAN);
  scene.fog.color.copy(BG_PLAN);
  scene.fog.near = 700; scene.fog.far = 2200;
  camera.fov = 45; camera.updateProjectionMatrix();
  bloom.strength = 0.7;
  setFocus(state.focus);
}
function togglePause() {
  const pv = state.pov;
  if (!pv) return;
  if (pv.done) { pv.t = 0; pv.done = false; pv.paused = false; } else pv.paused = !pv.paused;
  $('#pauseBtn').textContent = pv.paused ? '▶' : '❚❚';
}
$('#pauseBtn').onclick = (e) => { e.stopPropagation(); togglePause(); };
{
  let sx = null, st = 0, moved = false;
  canvas.addEventListener('pointerdown', (e) => { if (state.mode !== 'pov') return; sx = e.clientX; st = state.pov.t; moved = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (state.mode !== 'pov' || sx == null) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 8) moved = true;
    if (moved) {
      const r = state.routes[state.sel];
      state.pov.t = Math.max(0, Math.min(r.vtime, st - (dx / innerWidth) * r.vtime * 0.5));
      state.pov.done = false;
    }
  });
  canvas.addEventListener('pointerup', () => { if (state.mode !== 'pov') return; if (!moved) togglePause(); sx = null; });
  $('#bar').addEventListener('click', (e) => {
    const r = state.routes[state.sel], rc = e.currentTarget.getBoundingClientRect();
    state.pov.t = ((e.clientX - rc.left) / rc.width) * r.vtime;
    state.pov.done = false;
  });
}
const _tgt = new THREE.Vector3();
function stepPov(now) {
  const pv = state.pov, r = state.routes[state.sel];
  const dt = Math.min(0.1, (now - pv.last) / 1000);
  pv.last = now;
  if (!pv.paused && !pv.done) {
    pv.t += dt * SPEED[state.speed];
    if (pv.t >= r.vtime) { pv.t = r.vtime; pv.done = true; $('#pauseBtn').textContent = '↺'; }
  }
  const s = r.sAtVtime(pv.t);
  const pos = r.at(s);
  _tgt.copy(r.at(Math.min(r.dist, s + 6)));
  if (r.dist - s < 3) _tgt.copy(r.at(r.dist)).add(r.dirAt(r.dist).multiplyScalar(6));
  _tgt.y += EYE - 0.15;
  if (!pv.look) pv.look = _tgt.clone();
  pv.look.lerp(_tgt, 1 - Math.exp(-dt * 4));
  camera.position.set(pos.x, pos.y + EYE, pos.z);
  camera.lookAt(pv.look);
  const nav = r.navAt(s);
  $('#navIcon').textContent = nav.icon;
  $('#navIcon').className = nav.cls || '';
  $('#navText').textContent = nav.text;
  $('#navNext').textContent = nav.next ? '次：' + nav.next.text : (nav.sub || '');
  $('#navDist').textContent = nav.type === 'e' ? '' : Math.max(0, Math.round(nav.d)) + 'm';
  $('#bar i').style.width = (pv.t / r.vtime) * 100 + '%';
  $('#prog').textContent = `${Math.round(s)}m / ${Math.round(r.dist)}m`;
  const lv = Math.round(r.lvAt(s));
  if (lv !== pv.lv) { pv.lv = lv; $('#mapLv').textContent = floorJP(lv); }
  drawMinimap(pos, r.dirAt(s), r);
}

// ミニマップ（進行方向が上）
const mm = $('#minimap'), mctx = mm.getContext('2d');
function drawMinimap(pos, dir, r) {
  const W = mm.width, H = mm.height, sc = 2.2;
  mctx.fillStyle = 'rgba(12,16,24,.92)';
  mctx.fillRect(0, 0, W, H);
  const ang = Math.atan2(dir.x, -dir.z);
  mctx.save();
  mctx.translate(W / 2, H / 2 + 30);
  mctx.rotate(-ang);
  mctx.lineCap = 'round';
  const E = data.edges;
  mctx.strokeStyle = 'rgba(200,208,220,.5)';
  mctx.lineWidth = 7;
  mctx.beginPath();
  for (let i = 0; i < E.length; i += 3) {
    const a = E[i], b = E[i + 1];
    const ax = (N[a * 3] - pos.x) * sc, az = (N[a * 3 + 2] - pos.z) * sc;
    if (Math.abs(ax) > 300 || Math.abs(az) > 300) continue;
    if (Math.abs((N[a * 3 + 1] + N[b * 3 + 1]) / 2 - pos.y) > 2.5) continue;
    mctx.moveTo(ax, az); mctx.lineTo((N[b * 3] - pos.x) * sc, (N[b * 3 + 2] - pos.z) * sc);
  }
  mctx.stroke();
  for (const p of data.plats) {
    if (Math.abs(p.y - pos.y) > 2.5) continue;
    mctx.fillStyle = (lineBy[p.lines[0]]?.color || '#888888') + '88';
    mctx.beginPath();
    for (let i = 0; i < p.ring.length; i += 2) { const x = (p.ring[i] - pos.x) * sc, z = (p.ring[i + 1] - pos.z) * sc; i ? mctx.lineTo(x, z) : mctx.moveTo(x, z); }
    mctx.fill();
  }
  mctx.strokeStyle = r.kind === 'bf' ? '#ff7ab8' : '#ffb020';
  mctx.lineWidth = 6;
  mctx.beginPath();
  r.pts.forEach((p, i) => { const x = (p.x - pos.x) * sc, z = (p.z - pos.z) * sc; i ? mctx.lineTo(x, z) : mctx.moveTo(x, z); });
  mctx.stroke();
  mctx.restore();
  mctx.fillStyle = '#fff';
  mctx.beginPath();
  mctx.moveTo(W / 2, H / 2 + 15); mctx.lineTo(W / 2 - 10, H / 2 + 40); mctx.lineTo(W / 2 + 10, H / 2 + 40);
  mctx.closePath(); mctx.fill();
}

// ---------------------------------------------------------------- ループ
function loop(now) {
  requestAnimationFrame(loop);
  if (state.mode === 'pov' && state.pov) stepPov(now);
  else {
    stepFly(now);
    controls.update();
    const r = state.routes[state.sel];
    if (routeObj && r) {
      const k = ((now / 1000) * 0.1) % 1;
      routeObj.userData.marker.position.copy(r.at(k * r.dist)).add(new THREE.Vector3(0, 0.9, 0));
    }
  }
  composer.render();
  updateLabels();
}
requestAnimationFrame(loop);
$('#loading').style.opacity = 0;
setTimeout(() => $('#loading').remove(), 450);

if (location.hash.includes('>')) {
  const [f, t] = location.hash.slice(1).split('>').map(decodeURIComponent);
  if (opMeta(f) && opMeta(t)) { setPick('from', f); setPick('to', t); go(false); }
}
window.__app = { state, data, camera, controls, scene, renderer, composer, bloom, go, setPick, startPov, stopPov, fitRoute, model, graph, selectRoute };
