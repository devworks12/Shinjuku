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

export function floorJP(lv) {
  const r = Math.round(lv);
  return r < 0 ? `地下${-r}階` : `${r + 1}階`;
}

export class Graph {
  constructor(data, vec = (x, y, z) => ({ x, y, z })) {
    this.d = data;
    this.vec = vec;
    const N = data.nodes, n = data.nodeLv.length, E = data.edges;
    this.n = n;
    const m = E.length / 3;
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
    this.kind = new Uint8Array(m);
    this.len = new Float32Array(m);
    this.cm = new Float32Array(m);
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

  endpoint(key, side) {
    if (key.startsWith('x:')) {
      const x = this.exits[key.slice(2)];
      return x && { nodes: [x.n], bits: 0, name: x.name, exit: true };
    }
    const l = this.lines[key];
    if (!l) return null;
    const nodes = [];
    const platOf = new Map();
    const plats = side === 'from' && l.arr ? [...new Set([...l.plats, ...l.arr])] : l.plats;
    for (const pi of plats) for (const n of this.d.plats[pi].nodes) { nodes.push(n); platOf.set(n, pi); }
    let bits = this.opBit[l.op] || 0;
    for (const pi of plats) for (const n of this.d.plats[pi].nodes) bits |= this.d.zone[n];
    return { nodes, bits, name: l.name, platOf, line: l };
  }

  route(fromKey, toKey, opt = {}) {
    const A = this.endpoint(fromKey, 'from'), B = this.endpoint(toKey, 'to');
    if (!A || !B) return null;
    const r = this._find(A, B, opt);
    if (!r) return null;
    return this._build(r, A, B, opt);
  }

  _find(A, B, opt) {
    const same = A.bits && B.bits && (A.bits & B.bits);
    let r = null;
    if (same) r = this._search(A, B, opt, (m) => (m & (A.bits & B.bits)) !== 0);
    if (!r) r = this._search(A, B, opt, (m) => m === 0 || (m & (A.bits | B.bits)) !== 0);
    if (!r) r = this._search(A, B, opt, () => true);
    return r;
  }

  // ルート候補: 最短・ベビーカー・別ルート（使った辺を重くして探し直す）
  routes(fromKey, toKey, max = 4) {
    const A = this.endpoint(fromKey, 'from'), B = this.endpoint(toKey, 'to');
    if (!A || !B) return [];
    const out = [];
    const r0 = this._find(A, B, {});
    if (!r0) return [];
    const best = this._build(r0, A, B, {});
    best.label = 'ルート1（最短）';
    best.kind = 'best';
    out.push(best);
    const rb = this._find(A, B, { bf: true });
    if (rb) {
      const bfr = this._build(rb, A, B, { bf: true });
      bfr.label = bfr.bfStairs ? 'ベビーカー・車いす（一部階段あり）' : 'ベビーカー・車いす（階段なし）';
      bfr.kind = 'bf';
      out.push(bfr);
    }
    const pen = new Float32Array(this.kind.length).fill(1);
    const usedSets = [new Set(best.edges)];
    for (const e of best.edges) if (this.kind[e] !== KIND.PLAT) pen[e] *= 2.2;
    let n = 2;
    for (let attempt = 0; attempt < 8 && out.filter((r) => r.kind === 'alt').length < max - 1; attempt++) {
      const r = this._find(A, B, { pen });
      if (!r) break;
      const cand = this._build(r, A, B, {});
      for (const e of cand.edges) if (this.kind[e] !== KIND.PLAT) pen[e] *= 2.2;
      if (cand.time > best.time * 1.9 + 90) continue;
      const share = (S) => {
        let s = 0, t = 0;
        for (let i = 0; i < cand.edges.length; i++) {
          const e = cand.edges[i];
          if (this.kind[e] === KIND.PLAT) continue;
          const L = this.len[e];
          t += L; if (S.has(e)) s += L;
        }
        return t ? s / t : 1;
      };
      if (usedSets.some((S) => share(S) > 0.7)) continue;
      usedSets.push(new Set(cand.edges));
      cand.label = `ルート${n++}`;
      cand.kind = 'alt';
      out.push(cand);
    }
    // 別ルートは時間順
    const alts = out.filter((r) => r.kind === 'alt').sort((a, b) => a.time - b.time);
    alts.forEach((r, i) => { r.label = `ルート${i + 2}`; });
    return [best, ...out.filter((r) => r.kind === 'bf'), ...alts];
  }

  _search(A, B, opt, allow) {
    const n = this.n, zone = this.d.zone;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevE = new Int32Array(n).fill(-1);
    const target = new Set(B.nodes);
    const h = new Heap();
    for (const s of A.nodes) { dist[s] = 0; h.push(0, s); }
    const bf = !!opt.bf, pen = opt.pen;
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
        if (pen) c *= pen[e];
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
    let vert = 0, bfStairs = 0, outdoor = 0;
    for (let i = 0; i < es.length; i++) {
      const a = path[i], b = path[i + 1], e = es[i];
      const t = this.edgeTime(e, a, b, false);
      const L = this.len[e];
      cum.push(cum[i] + L);
      tcum.push(tcum[i] + t + (this.gate.has(b) ? 5 : 0));
      const vt = this.kind[e] === KIND.ELEV ? 5 + Math.abs(N[a * 3 + 1] - N[b * 3 + 1]) / 1.2 : t;
      vcum.push(vcum[i] + vt + (this.gate.has(b) ? 1.5 : 0));
      if (d.ein && !d.ein[e] && this.kind[e] !== KIND.PLAT) outdoor += L;
      if (opt.bf && (this.kind[e] === KIND.STAIRS || this.kind[e] === KIND.ESC)) bfStairs++;
    }
    let inV = false;
    for (const e of es) {
      const v = VERT.has(this.kind[e]);
      if (v && !inV) vert++;
      inV = v;
    }
    const fromPlat = A.platOf ? A.platOf.get(path[0]) : null;
    const toPlat = B.platOf ? B.platOf.get(path[path.length - 1]) : null;
    const res = {
      nodes: path, edges: es, pts, cum, tcum, vcum, A, B,
      dist: cum[cum.length - 1], time: tcum[tcum.length - 1], vtime: Math.max(1, vcum[vcum.length - 1]),
      vertCount: vert, bfStairs, outdoor, fromPlat: fromPlat ?? null, toPlat: toPlat ?? null,
    };
    const self = this;
    const seg = (s) => {
      let lo = 0, hi = cum.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
      return lo;
    };
    res.seg = seg;
    res.at = (s) => {
      s = Math.max(0, Math.min(res.dist, s));
      const i = seg(s);
      const L = cum[i + 1] - cum[i] || 1;
      const f = Math.min(1, (s - cum[i]) / L);
      const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
      return self.vec(N[a * 3] + (N[b * 3] - N[a * 3]) * f, N[a * 3 + 1] + (N[b * 3 + 1] - N[a * 3 + 1]) * f, N[a * 3 + 2] + (N[b * 3 + 2] - N[a * 3 + 2]) * f);
    };
    res.dirAt = (s) => {
      const a = res.at(Math.max(0, s - 3)), b = res.at(Math.min(res.dist, s + 3));
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      return self.vec(dx / L, 0, dz / L);
    };
    res.lvAt = (s) => d.nodeLv[path[seg(s)]];
    res.sAtVtime = (t) => {
      t = Math.max(0, Math.min(res.vtime, t));
      let lo = 0, hi = vcum.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (vcum[m] <= t) lo = m; else hi = m; }
      const span = vcum[lo + 1] - vcum[lo] || 1;
      return cum[lo] + ((t - vcum[lo]) / span) * (cum[lo + 1] - cum[lo]);
    };
    this._describe(res);
    res.navAt = (s) => {
      const segs = res.segs;
      let k = segs.findIndex((g) => s < g.s1 - 0.01);
      if (k < 0) k = segs.length - 1;
      const g = segs[k];
      return { ...g, d: Math.max(0, g.s1 - s), next: segs[k + 1] || null, k };
    };
    return res;
  }

  // 案内: segs（POV 用の区間） / steps（一覧用） / tagline / gates
  _describe(res) {
    const d = this.d, N = d.nodes, path = res.nodes, es = res.edges, cum = res.cum, A = res.A, B = res.B;
    const platLabel = (pi) => (pi != null ? d.plats[pi].label : '');
    const segs = [];
    const steps = [];
    const gatesUsed = [];
    const lvLen = new Map();
    const nameLen = new Map();
    // 1) 辺を「縦移動」「歩き」に分け、改札の位置を拾う
    const runs = [];
    let i = 0;
    while (i < es.length) {
      const k = this.kind[es[i]];
      const v = VERT.has(k) || (k === KIND.RAMP && Math.abs(d.nodeLv[path[i]] - d.nodeLv[path[i + 1]]) > 0.3);
      let j = i;
      while (j < es.length) {
        const kk = this.kind[es[j]];
        const vv = VERT.has(kk) || (kk === KIND.RAMP && Math.abs(d.nodeLv[path[j]] - d.nodeLv[path[j + 1]]) > 0.3);
        if (vv !== v || (v && kk !== k)) break;
        j++;
      }
      runs.push({ i, j, v, k });
      i = j;
    }
    // 2) 歩きの区間の中の「改札」と「曲がり角」
    const turnAt = (s) => {
      const p0 = res.at(s - 5), p1 = res.at(s), p2 = res.at(s + 5);
      if (Math.abs(p0.y - p1.y) > 0.5 || Math.abs(p2.y - p1.y) > 0.5) return 0;
      const ax = p1.x - p0.x, az = p1.z - p0.z, bx = p2.x - p1.x, bz = p2.z - p1.z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la < 3 || lb < 3) return 0;
      return Math.atan2((ax * bz - az * bx) / (la * lb), (ax * bx + az * bz) / (la * lb)) * 180 / Math.PI;
    };
    let lastGate = { s: -1e9, name: '' };
    for (const rn of runs) {
      const s0 = cum[rn.i], s1 = cum[rn.j];
      const lv0 = d.nodeLv[path[rn.i]], lv1 = d.nodeLv[path[rn.j]];
      if (rn.v) {
        const y0 = N[path[rn.i] * 3 + 1], y1 = N[path[rn.j] * 3 + 1];
        const up = y1 > y0;
        const what = rn.k === KIND.ESC ? 'エスカレーター' : rn.k === KIND.ELEV ? 'エレベーター' : rn.k === KIND.RAMP ? 'スロープ' : '階段';
        if (Math.round(lv0) === Math.round(lv1) && rn.k !== KIND.ELEV) {
          segs.push({ s0, s1, icon: up ? '↗' : '↘', text: `${what}を${up ? '上がる' : '下りる'}`, cls: 'vert', type: 'v' });
          continue;
        }
        const text = `${what}で${floorJP(lv1)}へ${rn.k === KIND.ELEV ? '' : up ? '上がる' : '下りる'}`.replace(/へ$/, 'へ');
        segs.push({ s0, s1, icon: up ? '↗' : '↘', text, cls: 'vert', type: 'v' });
        steps.push({ icon: up ? '⇡' : '⇣', text, sub: `${floorJP(lv0)} → ${floorJP(lv1)}`, i: rn.i, cls: 'vert', dist: s1 - s0 });
        continue;
      }
      // 歩き: 改札・曲がり角のイベント
      const ev = [];
      for (let q = rn.i + 1; q <= rn.j; q++) {
        if (!this.gate.has(path[q])) continue;
        const z0 = d.zone[path[Math.max(0, q - 1)]], z1 = d.zone[path[Math.min(path.length - 1, q + 1)]];
        if (z0 === z1) continue;
        const name = this.gate.get(path[q]) || '改札';
        if (cum[q] - lastGate.s < 25 && (name === lastGate.name)) { lastGate.s = cum[q]; continue; }
        lastGate = { s: cum[q], name };
        ev.push({ s: cum[q], q, type: 'gate', name, sub: this._zoneSub(z0, z1) });
        gatesUsed.push(name);
      }
      for (let s = s0 + 6; s < s1 - 6; s += 2) {
        const ang = turnAt(s);
        if (Math.abs(ang) < 55) continue;
        const prev = ev.filter((e) => e.type === 'turn').pop();
        if (prev && s - prev.s < 9) { if (Math.abs(ang) > Math.abs(prev.ang)) { prev.s = s; prev.ang = ang; } continue; }
        if (ev.some((e) => e.type === 'gate' && Math.abs(e.s - s) < 6)) continue;
        ev.push({ s, type: 'turn', ang });
      }
      ev.sort((a, b) => a.s - b.s);
      // 区間の名前
      const lv = Math.round(lv0);
      let nm = '';
      let outdoorRun = 0, platRun = 0;
      const names = new Map();
      for (let q = rn.i; q < rn.j; q++) {
        const e = es[q], L = this.len[e];
        if (this.kind[e] === KIND.PLAT) platRun += L;
        if (d.ein && !d.ein[e] && this.kind[e] !== KIND.PLAT) outdoorRun += L;
        const ni = d.ename ? d.ename[e] : -1;
        if (ni >= 0) names.set(ni, (names.get(ni) || 0) + L);
        lvLen.set(lv, (lvLen.get(lv) || 0) + L);
        if (ni >= 0) nameLen.set(ni, (nameLen.get(ni) || 0) + L);
      }
      if (names.size) {
        const [ni, L] = [...names.entries()].sort((a, b) => b[1] - a[1])[0];
        if (L > 15) nm = d.names[ni];
      }
      const walkText = platRun > (s1 - s0) * 0.6 ? 'ホームを進む' : outdoorRun > (s1 - s0) * 0.5 ? (nm ? `${nm}を歩く` : '外を歩く') : nm ? `${nm}を進む` : `${floorJP(lv)}の通路を進む`;
      let cur = s0;
      for (const e of ev) {
        const pre = e.type === 'gate' ? 4 : 5;
        if (e.s - pre > cur + 0.5) segs.push({ s0: cur, s1: e.s - pre, icon: '↑', text: walkText, cls: '', type: 'w' });
        const a = Math.max(cur, e.s - pre);
        if (e.type === 'gate') {
          segs.push({ s0: a, s1: e.s + 1, icon: '⇥', text: `${e.name}を通る`, sub: e.sub, cls: 'gate', type: 'g' });
          steps.push({ icon: '⇥', text: `${e.name}を通る`, sub: e.sub, i: e.q, cls: 'gate' });
          cur = e.s + 1;
        } else {
          const u = Math.abs(e.ang) > 145, right = e.ang > 0;
          segs.push({ s0: a, s1: e.s + 2, icon: u ? '↶' : right ? '↱' : '↰', text: u ? '折り返す' : right ? '右へ曲がる' : '左へ曲がる', cls: '', type: 't' });
          cur = e.s + 2;
        }
      }
      if (s1 > cur + 0.3) segs.push({ s0: cur, s1, icon: '↑', text: walkText, cls: '', type: 'w' });
      if (s1 - s0 >= 10) steps.push({ icon: '↑', text: walkText, sub: '', dist: s1 - s0, i: rn.i, cls: '' });
    }
    // 小さすぎる区間はまとめる
    const merged = [];
    for (const g of segs) {
      const last = merged[merged.length - 1];
      if (last && last.type === 'w' && g.type === 'w' && last.text === g.text) { last.s1 = g.s1; continue; }
      merged.push(g);
    }
    const endText = B.exit ? `${B.name}に到着` : `${B.name} ${platLabel(res.toPlat)}に到着`;
    merged.push({ s0: res.dist, s1: res.dist + 0.001, icon: '◎', text: endText, cls: 'end', type: 'e' });
    res.segs = merged;
    // 一覧
    steps.sort((a, b) => a.i - b.i);
    const startText = A.exit ? `${A.name}から出発` : `${A.name} ${platLabel(res.fromPlat)}`;
    steps.unshift({ icon: '●', text: startText, sub: A.exit ? '' : (A.line?.sub || '').replace(/\s*[\d・]+番(線|ホーム)$/, ''), i: 0, cls: 'start' });
    steps.push({ icon: '◎', text: endText, sub: B.exit ? (this.exits[B.line?.key]?.sub || '') : (B.line?.sub || '').replace(/\s*[\d・]+番(線|ホーム)$/, ''), i: path.length - 1, cls: 'end' });
    res.steps = steps;
    // タグライン（経由する階・通路名・外を歩くか）
    const lvs = [...lvLen.entries()].filter(([, L]) => L >= 20).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l).sort((a, b) => b - a);
    const nms = [...nameLen.entries()].filter(([, L]) => L >= 25).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([ni]) => d.names[ni]);
    const parts = [];
    if (res.outdoor >= 30) parts.push('外を歩く');
    if (lvs.length) parts.push(lvs.map(floorJP).join('・') + '経由');
    if (nms.length) parts.push(nms.join(' / '));
    res.tagline = parts.join(' / ');
    res.gatesUsed = gatesUsed;
  }

  _zoneSub(z0, z1) {
    const nm = (z) => {
      if (!z) return '改札外';
      return this.d.ops.filter((o) => z & o.bit).map((o) => o.name).join('・') || '改札外';
    };
    if (z0 === z1) return '';
    return `${nm(z0)} → ${nm(z1)}`;
  }
}
