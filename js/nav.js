// 地図アプリのような視点操作（Google マップ・Apple マップにならう）
//
//  スマホ:  1本指ドラッグ = 移動（指の下の場所がついてくる）
//           2本指ピンチ   = 拡大縮小（指の間を中心に）＋ ひねると回転
//           2本指を上下に平行スワイプ = 傾き（見下ろす角度）
//           ダブルタップ  = その場所を拡大
//  PC:      左ドラッグ = 移動 / 右ドラッグ（または Shift・Ctrl＋ドラッグ）= 回転・傾き
//           ホイール・トラックパッドのピンチ = カーソル位置を中心に拡大縮小 / ダブルクリック = 拡大
//
// 動きを混ぜないように、2本指はジェスチャーの最初の数ピクセルで「傾き」か「ピンチ（拡大・回転）」かを決める。
// 回転は、ひねりがはっきりしてから効くようにして、ピンチ中に意図せず回らないようにしている。
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export class MapNav {
  constructor(camera, dom, opt = {}) {
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3();
    this.enabled = true;
    this.minDistance = opt.minDistance ?? 12;
    this.maxDistance = opt.maxDistance ?? 1600;
    this.minPolarAngle = opt.minPolarAngle ?? 0.04;      // 0 = 真上から
    this.maxPolarAngle = opt.maxPolarAngle ?? Math.PI * 0.47;
    this.bounds = opt.bounds || null;                       // {xmin,xmax,zmin,zmax}
    this.onStart = opt.onStart || (() => {});
    this.pointers = new Map();
    this.vel = new THREE.Vector3();                         // 指を離した後の慣性
    this.zoomAnim = null;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane();
    this._sph = new THREE.Spherical();
    this._lastMove = 0;
    this._lastTap = { t: 0, x: 0, y: 0 };
    const o = { passive: false };
    dom.addEventListener('pointerdown', (e) => this._down(e), o);
    dom.addEventListener('pointermove', (e) => this._move(e), o);
    dom.addEventListener('pointerup', (e) => this._up(e), o);
    dom.addEventListener('pointercancel', (e) => this._up(e), o);
    dom.addEventListener('wheel', (e) => this._wheel(e), o);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('dblclick', (e) => { if (this.enabled && e.pointerType !== 'touch') this._zoomTo(e.clientX, e.clientY, 2.2); });
  }

  // ---------------------------------------------------------------- 基本の操作
  // 画面上の点が指す、注視点の高さの水平面上の位置
  hit(x, y, out = new THREE.Vector3()) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(ndc, this.camera);
    this._plane.set(UP, -this.target.y);
    const d = this._ray.ray.direction;
    // 地平線より上を指したときは、遠すぎない位置で止める
    if (d.y > -0.05) { out.copy(this._ray.ray.origin).addScaledVector(new THREE.Vector3(d.x, 0, d.z).normalize(), this.camera.position.distanceTo(this.target) * 1.5); out.y = this.target.y; return out; }
    return this._ray.ray.intersectPlane(this._plane, out) || out.copy(this.target);
  }
  translate(dv) { this.target.add(dv); this.camera.position.add(dv); }
  // 点 P を中心に拡大（scale > 1 で近づく）
  zoomAbout(P, scale) {
    const dist = this.camera.position.distanceTo(this.target);
    const nd = THREE.MathUtils.clamp(dist / scale, this.minDistance, this.maxDistance);
    const k = nd / dist;
    if (Math.abs(k - 1) < 1e-6) return;
    this.target.sub(P).multiplyScalar(k).add(P);
    this.camera.position.sub(P).multiplyScalar(k).add(P);
  }
  // 点 P を通る縦軸のまわりに回転
  rotateAbout(P, ang) {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, ang);
    this.target.sub(P).applyQuaternion(q).add(P);
    this.camera.position.sub(P).applyQuaternion(q).add(P);
  }
  // 注視点のまわりで方位・傾きを変える
  orbit(dTheta, dPhi) {
    const off = this.camera.position.clone().sub(this.target);
    this._sph.setFromVector3(off);
    this._sph.theta += dTheta;
    this._sph.phi = THREE.MathUtils.clamp(this._sph.phi + dPhi, this.minPolarAngle, this.maxPolarAngle);
    off.setFromSpherical(this._sph);
    this.camera.position.copy(this.target).add(off);
  }

  // ---------------------------------------------------------------- 毎フレーム
  update(dt = 1 / 60) {
    if (this.vel.lengthSq() > 1e-4 && this.pointers.size === 0) {
      this.translate(this.vel.clone().multiplyScalar(dt));
      this.vel.multiplyScalar(Math.exp(-dt * 5));
    }
    if (this.zoomAnim) {
      const z = this.zoomAnim, step = Math.min(1, dt * 9);
      const s = Math.exp(z.remain * step);
      z.remain -= z.remain * step;
      this.zoomAbout(z.P, s);
      if (Math.abs(z.remain) < 1e-3) this.zoomAnim = null;
    }
    // 範囲と角度の制限
    if (this.bounds) {
      const b = this.bounds;
      const cx = THREE.MathUtils.clamp(this.target.x, b.xmin, b.xmax), cz = THREE.MathUtils.clamp(this.target.z, b.zmin, b.zmax);
      if (cx !== this.target.x || cz !== this.target.z) { this.translate(new THREE.Vector3(cx - this.target.x, 0, cz - this.target.z)); this.vel.set(0, 0, 0); }
    }
    const off = this.camera.position.clone().sub(this.target);
    this._sph.setFromVector3(off);
    this._sph.phi = THREE.MathUtils.clamp(this._sph.phi, this.minPolarAngle, this.maxPolarAngle);
    this._sph.radius = THREE.MathUtils.clamp(this._sph.radius, this.minDistance, this.maxDistance);
    off.setFromSpherical(this._sph);
    this.camera.position.copy(this.target).add(off);
    this.camera.lookAt(this.target);
  }

  // ---------------------------------------------------------------- 入力
  _down(e) {
    if (!this.enabled) return;
    this.dom.setPointerCapture?.(e.pointerId);
    this.vel.set(0, 0, 0);
    this.zoomAnim = null;
    this.onStart();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.button, t0: performance.now() });
    const n = this.pointers.size;
    if (n === 1) {
      const rot = e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey);
      this.mode = rot ? 'orbit' : 'pan';
      this.grab = this.hit(e.clientX, e.clientY);
      this.samples = [];
    } else if (n === 2) {
      const [a, b] = [...this.pointers.values()];
      this.g2 = { d0: Math.hypot(b.x - a.x, b.y - a.y), a0: Math.atan2(b.y - a.y, b.x - a.x), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, decided: null, rotOn: false };
      this.mode = 'two';
    } else this.mode = 'none';
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    e.preventDefault();
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.mode === 'pan' && this.pointers.size === 1) {
      const h = this.hit(p.x, p.y);
      const dv = this.grab.clone().sub(h);
      dv.y = 0;
      this.translate(dv);
      const now = performance.now();
      this.samples.push({ t: now, v: dv.clone() });
      while (this.samples.length && now - this.samples[0].t > 90) this.samples.shift();
    } else if (this.mode === 'orbit' && this.pointers.size === 1) {
      this.orbit(-(p.x - px) * 0.006, -(p.y - py) * 0.005);
    } else if (this.mode === 'two' && this.pointers.size === 2) {
      this._two(e.pointerId, px, py);
    }
  }

  _two(id, px, py) {
    const pts = [...this.pointers.entries()];
    const [ia, a] = pts[0], [ib, b] = pts[1];
    // 動く前の2点
    const pa = ia === id ? { x: px, y: py } : a, pb = ib === id ? { x: px, y: py } : b;
    const dPrev = Math.hypot(pb.x - pa.x, pb.y - pa.y), dNow = Math.hypot(b.x - a.x, b.y - a.y);
    const angPrev = Math.atan2(pb.y - pa.y, pb.x - pa.x), angNow = Math.atan2(b.y - a.y, b.x - a.x);
    const mPrev = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, mNow = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const g = this.g2;
    if (!g.decided) {
      // 最初の 10px ほどで、傾き（2本指を同じ向きに上下）か、ピンチ・回転かを決める
      const da = { x: a.x - a.x0, y: a.y - a.y0 }, db = { x: b.x - b.x0, y: b.y - b.y0 };
      const moved = Math.max(Math.hypot(da.x, da.y), Math.hypot(db.x, db.y));
      if (moved < 10) return;
      const scaleCh = Math.abs(dNow / g.d0 - 1);
      const sameVertical = Math.sign(da.y) === Math.sign(db.y) && Math.abs(da.y) > Math.abs(da.x) * 1.4 && Math.abs(db.y) > Math.abs(db.x) * 1.4;
      g.decided = sameVertical && scaleCh < 0.08 ? 'tilt' : 'pinch';
      return;
    }
    if (g.decided === 'tilt') {
      this.orbit(0, -(mNow.y - mPrev.y) * 0.006);
      return;
    }
    // ピンチ: 指の中心の移動 → 平行移動、間隔 → 拡大縮小、ひねり → 回転（はっきりひねったときだけ）
    const h0 = this.hit(mPrev.x, mPrev.y), h1 = this.hit(mNow.x, mNow.y);
    const dv = h0.sub(h1); dv.y = 0;
    this.translate(dv);
    const P = this.hit(mNow.x, mNow.y);
    if (dPrev > 0) this.zoomAbout(P, dNow / dPrev);
    let dAng = angNow - angPrev;
    if (dAng > Math.PI) dAng -= 2 * Math.PI;
    if (dAng < -Math.PI) dAng += 2 * Math.PI;
    if (!g.rotOn) {
      let tot = angNow - g.a0;
      if (tot > Math.PI) tot -= 2 * Math.PI;
      if (tot < -Math.PI) tot += 2 * Math.PI;
      if (Math.abs(tot) > 0.26) g.rotOn = true; // 約15度ひねったら回転を有効に
    }
    if (g.rotOn) this.rotateAbout(P, -dAng);
  }

  _up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this.dom.releasePointerCapture?.(e.pointerId);
    if (!this.enabled) return;
    const now = performance.now();
    if (this.mode === 'pan' && this.pointers.size === 0) {
      // 投げるように離したら少し滑る
      if (this.samples?.length >= 2 && now - this.samples[this.samples.length - 1].t < 60) {
        const dt = (this.samples[this.samples.length - 1].t - this.samples[0].t) / 1000 || 1 / 60;
        const sum = this.samples.reduce((acc, s) => acc.add(s.v), new THREE.Vector3());
        this.vel.copy(sum.multiplyScalar(1 / Math.max(dt, 1 / 60)));
        const maxV = this.camera.position.distanceTo(this.target) * 3;
        if (this.vel.length() > maxV) this.vel.setLength(maxV);
      }
      // ダブルタップで拡大
      const tap = Math.hypot(p.x - p.x0, p.y - p.y0) < 8 && now - p.t0 < 250;
      if (tap && e.pointerType === 'touch') {
        const L = this._lastTap;
        if (now - L.t < 320 && Math.hypot(p.x - L.x, p.y - L.y) < 30) { this._zoomTo(p.x, p.y, 2.2); L.t = 0; } else { L.t = now; L.x = p.x; L.y = p.y; }
      }
    }
    if (this.pointers.size === 1) {
      // 2本指から1本指に戻ったら、その指で移動を続ける
      const [q] = [...this.pointers.values()];
      this.mode = 'pan';
      this.grab = this.hit(q.x, q.y);
      this.samples = [];
    } else if (this.pointers.size === 0) this.mode = 'none';
  }

  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.onStart();
    this.vel.set(0, 0, 0);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    // トラックパッドのピンチ（ctrlKey 付き）は細かい値で来るので強めに
    const s = Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0016));
    this.zoomAbout(this.hit(e.clientX, e.clientY), s);
  }

  _zoomTo(x, y, factor) {
    this.onStart();
    this.zoomAnim = { P: this.hit(x, y), remain: Math.log(factor) };
  }
}
