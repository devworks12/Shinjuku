// 経路探索と案内文の生成（three.js に依存しない。Node でもテストできる）
export const KIND = { WALK: 0, STAIRS: 1, ESC: 2, ELEV: 3, PLAT: 4, RAMP: 5 };
const VERT = new Set([KIND.STAIRS, KIND.ESC, KIND.ELEV]);

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export function levelName(lv) {
  const r = Math.round(lv);
  return r >= 0 ? `${r + 1}F` : `B${-r}`;
}

export class Graph {
  constructor(data, vec = (x, y, z) => ({ x, y, z })) {
    this.d = data;
    this.vec = vec;
    const N = data.nodes, n = data.nodeLv.length, E = data.edges;
    this.n = n;
    const deg = new Int32Array(n + 1);
    for (let i = 0; i < E.length; i += 3) { deg[E[i]]++; deg[E[i + 1]]++; }
    const off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
    const fill = off.slice();
    const to = new Int32Array(off[n]), eid = new Int32Array(off[n]);
    for (let i = 0, e = 0; i < E.length; i += 3, e++) {
      const a = E[i], b = E[i + 1];
      to[fill[a]] = b; eid[fill[a]++] = e;
      to[fill[b]] = a; eid[fill[b]++] = e;
    }
    this.off = off; this.to = to; this.eid = eid;
    this.kind = new Uint8Array(E.length / 3);
    this.len = new Float32Array(E.length / 3);
    this.cm = new Float32Array(E.length / 3);
    for (let i = 0, e = 0; i < E.length; i += 3, e++) {
      const a = E[i], b = E[i + 1];
      this.kind[e] = E[i + 2];
      this.cm[e] = data.cost ? data.cost[e] : 1;
      const dx = N[a * 3] - N[b * 3], dy = N[a * 3 + 1] - N[b * 3 + 1], dz = N[a * 3 + 2] - N[b * 3 + 2];
      this.len[e] = Math.hypot(dx, dy, dz);
    }
    this.gate = new Map();
    for (const g of data.gates) if (!this.gate.has(g.n) || g.name) this.gate.set(g.n, g.name || '');
    this.opBit = Object.fromEntries(data.ops.map((o) => [o.key, o.bit]));
    this.opName = Object.fromEntries(data.ops.map((o) => [o.bit, o.name]));
    this.lines = Object.fromEntries(data.lines.map((l) => [l.key, l]));
    this.exits = Object.fromEntries(data.exits.map((x) => [x.key, x]));
  }

  P(i) { const N = this.d.nodes; return this.vec(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]); }

  // 1辺を歩く秒数
  edgeTime(e, a, b, bf) {
    const k = this.kind[e], L = this.len[e];
    const dy = this.d.nodes[b * 3 + 1] - this.d.nodes[a * 3 + 1];
    switch (k) {
      case KIND.STAIRS: return ((dy > 0 ? L / 0.45 : L / 0.55) + 1) * (bf ? 40 : 1);
      case KIND.ESC: return (L / 0.75 + 4) * (bf ? 40 : 1);
      case KIND.ELEV: return 35 + Math.abs(dy) / 1.0;
      case KIND.PLAT: return L / 1.15;
      case KIND.RAMP: return L / 1.1;
      default: return (L / 1.25) * this.cm[e];
    }
  }

  endpoint(key) {
    if (key.startsWith('x:')) {
      const x = this.exits[key.slice(2)];
      return x && { nodes: [x.n], bits: 0, name: x.name, exit: true };
    }
    const l = this.lines[key];
    if (!l) return null;
    const nodes = [];
    const platOf = new Map();
    for (const pi of l.plats) for (const n of this.d.plats[pi].nodes) { nodes.push(n); platOf.set(n, pi); }
    let bits = this.opBit[l.op] || 0;
    for (const pi of l.plats) for (const n of this.d.plats[pi].nodes) bits |= this.d.zone[n];
    return { nodes, bits, name: l.name, platOf, line: l };
  }

  route(fromKey, toKey, opt = {}) {
    const A = this.endpoint(fromKey), B = this.endpoint(toKey);
    if (!A || !B) return null;
    const same = A.bits && B.bits && (A.bits & B.bits);
    let r = null;
    if (same) r = this._search(A, B, opt, (m) => (m & (A.bits & B.bits)) !== 0, 0);
    if (!r) r = this._search(A, B, opt, (m) => m === 0 || (m & (A.bits | B.bits)) !== 0, 0);
    if (!r) r = this._search(A, B, opt, () => true, 0);
    if (!r) return null;
    return this._build(r, A, B, opt);
  }

  _search(A, B, opt, allow, _x) {
    const n = this.n, zone = this.d.zone;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevE = new Int32Array(n).fill(-1);
    const target = new Set(B.nodes);
    const h = new Heap();
    for (const s of A.nodes) { dist[s] = 0; h.push(0, s); }
    const bf = !!opt.bf;
    while (h.size) {
      const u = h.pop();
      if (target.has(u)) return { end: u, prev, prevE, dist };
      const du = dist[u];
      for (let j = this.off[u]; j < this.off[u + 1]; j++) {
        const v = this.to[j];
        if (!allow(zone[v]) && !target.has(v)) continue;
        const e = this.eid[j];
        let c = this.edgeTime(e, u, v, bf);
        if (!isFinite(c)) continue;
        if (this.gate.has(v)) c += 5;
        const nd = du + c;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; prevE[v] = e; h.push(nd, v); }
      }
    }
    return null;
  }

  _build(r, A, B, opt) {
    const path = [], es = [];
    for (let u = r.end; u !== -1; u = r.prev[u]) { path.push(u); if (r.prevE[u] >= 0) es.push(r.prevE[u]); }
    path.reverse(); es.reverse();
    const d = this.d, N = d.nodes;
    const pts = path.map((i) => this.P(i));
    const cum = [0], tcum = [0], vcum = [0];
    let vert = 0;
    let bfStairs = 0;
    if (opt.bf) for (const e of es) if (this.kind[e] === KIND.STAIRS || this.kind[e] === KIND.ESC) bfStairs++;
    for (let i = 0; i < es.length; i++) {
      const a = path[i], b = path[i + 1], e = es[i];
      const t = this.edgeTime(e, a, b, false);
      const dx = N[a * 3] - N[b * 3], dz = N[a * 3 + 2] - N[b * 3 + 2];
      cum.push(cum[i] + Math.hypot(dx, dz, N[a * 3 + 1] - N[b * 3 + 1]));
      tcum.push(tcum[i] + t + (this.gate.has(b) ? 5 : 0));
      // 再生用の時間: エレベーター待ちは短縮
      const vt = this.kind[e] === KIND.ELEV ? 5 + Math.abs(N[a * 3 + 1] - N[b * 3 + 1]) / 1.2 : t;
      vcum.push(vcum[i] + vt + (this.gate.has(b) ? 1.5 : 0));
    }
    // 縦移動の回数
    let inV = false;
    for (const e of es) {
      const v = VERT.has(this.kind[e]);
      if (v && !inV) vert++;
      inV = v;
    }
    const fromPlat = A.platOf ? A.platOf.get(path[0]) : null;
    const toPlat = B.platOf ? B.platOf.get(path[path.length - 1]) : null;
    const res = {
      nodes: path, edges: es, pts, cum, tcum, vcum,
      dist: cum[cum.length - 1], time: tcum[tcum.length - 1], vtime: Math.max(1, vcum[vcum.length - 1]),
      vertCount: vert, bfStairs, fromPlat: fromPlat ?? null, toPlat: toPlat ?? null,
    };
    const self = this;
    const seg = (s) => {
      let lo = 0, hi = cum.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
      return lo;
    };
    res.at = (s) => {
      s = Math.max(0, Math.min(res.dist, s));
      const i = seg(s);
      const L = cum[i + 1] - cum[i] || 1;
      const f = (s - cum[i]) / L;
      const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
      return self.vec(N[a * 3] + (N[b * 3] - N[a * 3]) * f, N[a * 3 + 1] + (N[b * 3 + 1] - N[a * 3 + 1]) * f, N[a * 3 + 2] + (N[b * 3 + 2] - N[a * 3 + 2]) * f);
    };
    res.dirAt = (s) => {
      const a = res.at(Math.max(0, s - 3)), b = res.at(Math.min(res.dist, s + 3));
      let dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      return self.vec(dx / L, 0, dz / L);
    };
    res.lvAt = (s) => {
      const i = seg(s);
      return d.nodeLv[path[i]];
    };
    res.sAtVtime = (t) => {
      t = Math.max(0, Math.min(res.vtime, t));
      let lo = 0, hi = vcum.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (vcum[m] <= t) lo = m; else hi = m; }
      const span = vcum[lo + 1] - vcum[lo] || 1;
      return cum[lo] + ((t - vcum[lo]) / span) * (cum[lo + 1] - cum[lo]);
    };
    const { steps, man } = this._instructions(res, A, B);
    res.steps = steps;
    res.man = man;
    res.nextManeuver = (s) => {
      for (const m of man) {
        if (m.s1 != null && s >= m.s0 - 1 && s <= m.s1) return { ...m, d: 0 };
        if (m.s0 > s - 0.5) return { ...m, d: m.s0 - s };
      }
      const last = man[man.length - 1];
      return { ...last, d: 0 };
    };
    return res;
  }

  _instructions(res, A, B) {
    const d = this.d, N = d.nodes, path = res.nodes, es = res.edges, cum = res.cum;
    const steps = [], man = [];
    const platLabel = (pi) => (pi != null ? d.plats[pi].label : '');
    const lineSub = (ep, pi) => (ep.exit ? '' : [platLabel(pi), ep.line?.sub?.replace(/\s*\d.*番線$/, '')].filter(Boolean).join(' · '));
    steps.push({ icon: '●', text: A.exit ? `${A.name}から出発` : `${A.name}を降りる`, sub: lineSub(A, res.fromPlat), i: 0, cls: 'start' });

    // 区間をまとめる
    let i = 0;
    let lastGateS = -1e9, lastGateName = null;
    let walkStart = 0, walkLen = 0;
    const flushWalk = (iEnd) => {
      if (walkLen >= 8) steps.push({ icon: '↑', text: '通路を進む', sub: '', dist: walkLen, i: walkStart });
      walkLen = 0;
      walkStart = iEnd;
    };
    const gateHere = (q) => {
      const name = this.gate.get(path[q]) || '改札';
      const s = cum[q];
      const z0 = d.zone[path[Math.max(0, q - 1)]], z1 = d.zone[path[Math.min(path.length - 1, q + 1)]];
      if (z0 === z1) return; // 改札の脇を通り過ぎるだけ
      if (!(s - lastGateS < 25 && (name === lastGateName || name === '改札'))) {
        flushWalk(q);
        const sub = this._zoneSub(z0, z1);
        steps.push({ icon: '⇥', text: `${name}を通る`, sub, i: q, cls: 'gate' });
        man.push({ s0: s, icon: '⇥', text: `${name}を通る`, sub, cls: 'gate' });
        lastGateName = name;
      }
      lastGateS = s;
    };
    while (i < es.length) {
      const e = es[i], k = this.kind[e];
      if (VERT.has(k)) {
        let j = i;
        while (j < es.length && this.kind[es[j]] === k) j++;
        for (let q = i + 1; q <= j; q++) if (this.gate.has(path[q])) gateHere(q);
        const lv0 = d.nodeLv[path[i]], lv1 = d.nodeLv[path[j]];
        const y0 = N[path[i] * 3 + 1], y1 = N[path[j] * 3 + 1];
        const up = y1 > y0;
        const what = k === KIND.STAIRS ? '階段' : k === KIND.ESC ? 'エスカレーター' : 'エレベーター';
        const verb = k === KIND.ELEV ? `${what}で${levelName(lv1)}へ` : `${what}を${up ? '上る' : '下りる'}`;
        const sub = `${levelName(lv0)} → ${levelName(lv1)}`;
        if (Math.round(lv0) !== Math.round(lv1) || k === KIND.ELEV) {
          flushWalk(i);
          steps.push({ icon: up ? '⇡' : '⇣', text: verb, sub, i, cls: 'vert', dist: cum[j] - cum[i] });
          man.push({ s0: cum[i], s1: cum[j], icon: up ? '⇡' : '⇣', text: verb, sub, cls: 'vert' });
        } else {
          walkLen += cum[j] - cum[i];
        }
        if (Math.round(lv0) !== Math.round(lv1) || k === KIND.ELEV) walkStart = j;
        i = j;
        continue;
      }
      walkLen += cum[i + 1] - cum[i];
      if (this.gate.has(path[i + 1])) gateHere(i + 1);
      i++;
    }
    flushWalk(es.length);
    steps.push({ icon: '◎', text: B.exit ? `${B.name}に到着` : `${B.name}に乗る`, sub: lineSub(B, res.toPlat), i: path.length - 1, cls: 'end' });

    // 曲がり角（POV用）
    const turns = [];
    const at = res.at;
    for (let s = 6; s < res.dist - 6; s += 2) {
      const p0 = at(s - 5), p1 = at(s), p2 = at(s + 5);
      if (Math.abs(p0.y - p1.y) > 0.5 || Math.abs(p2.y - p1.y) > 0.5) continue;
      const ax = p1.x - p0.x, az = p1.z - p0.z, bx = p2.x - p1.x, bz = p2.z - p1.z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la < 3 || lb < 3) continue;
      const cr = (ax * bz - az * bx) / (la * lb), dt = (ax * bx + az * bz) / (la * lb);
      const ang = Math.atan2(cr, dt) * 180 / Math.PI;
      if (Math.abs(ang) < 50) continue;
      const prevT = turns[turns.length - 1];
      if (prevT && s - prevT.s0 < 8) { if (Math.abs(ang) > Math.abs(prevT.ang)) { prevT.s0 = s - 2; prevT.ang = ang; } continue; }
      turns.push({ s0: s - 2, ang });
    }
    for (const t of turns) {
      if (man.some((m) => m.s1 != null ? t.s0 >= m.s0 - 4 && t.s0 <= m.s1 + 4 : Math.abs(m.s0 - t.s0) < 5)) continue;
      const u = Math.abs(t.ang) > 145;
      const right = t.ang > 0;
      man.push({ s0: t.s0, icon: u ? '↶' : right ? '↱' : '↰', text: u ? '折り返す' : right ? '右へ曲がる' : '左へ曲がる', sub: '', cls: '' });
    }
    man.sort((a, b) => a.s0 - b.s0);
    man.push({ s0: res.dist, icon: '◎', text: B.exit ? `${B.name}に到着` : `${B.name} ${platLabel(res.toPlat)}`, sub: B.exit ? '' : 'ホームに到着', cls: 'end' });
    return { steps, man };
  }

  _zoneSub(z0, z1) {
    const nm = (z) => {
      if (!z) return '改札外';
      const names = this.d.ops.filter((o) => z & o.bit).map((o) => o.name);
      return names.join('・') || '改札外';
    };
    if (z0 === z1) return '';
    return `${nm(z0)} → ${nm(z1)}`;
  }
}
