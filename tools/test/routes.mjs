// 全路線ペア＋出口の経路を計算して要約を表示する: node tools/test/routes.mjs [from] [to]
import fs from 'node:fs';
import { Graph } from '../../js/route.js';
const data = JSON.parse(fs.readFileSync(new URL('../../data/station.json', import.meta.url)));
const g = new Graph(data);
const keys = [...data.lines.map((l) => l.key), ...data.exits.map((x) => 'x:' + x.key)];
const [f, t, bf] = process.argv.slice(2);
if (f && t) {
  const r = g.route(f, t, { bf: bf === 'bf' });
  if (!r) { console.log('NO ROUTE'); process.exit(1); }
  console.log(`${Math.round(r.dist)}m ${Math.round(r.time / 60)}min vert=${r.vertCount}`);
  for (const s of r.steps) console.log(' ', s.icon, s.text, s.sub || '', s.dist ? Math.round(s.dist) + 'm' : '');
  console.log(' maneuvers:', r.man.map((m) => `${Math.round(m.s0)}:${m.text}`).join(' / '));
  process.exit(0);
}
let fail = 0, n = 0;
const rows = [];
for (const a of keys) for (const b of keys) {
  if (a === b || (a.startsWith('x:') && b.startsWith('x:'))) continue;
  n++;
  const r = g.route(a, b, {});
  if (!r) { fail++; rows.push(`FAIL ${a} -> ${b}`); continue; }
  const gates = r.steps.filter((s) => s.cls === 'gate').map((s) => s.text.replace('を通る', '')).join(',');
  rows.push(`${a} -> ${b}: ${Math.round(r.dist)}m ${(r.time / 60).toFixed(1)}min gates[${gates}]`);
}
console.log(rows.join('\n'));
console.log(`\n${n - fail}/${n} ok`);
