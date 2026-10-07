import fs from 'node:fs';
import { Graph } from '../../js/route.js';
const data = JSON.parse(fs.readFileSync(new URL('../../data/station.json', import.meta.url)));
const osm = JSON.parse(fs.readFileSync(new URL('../../data/debug_osm.json', import.meta.url)));
const g = new Graph(data);
const r = g.route(process.argv[2], process.argv[3], { bf: process.argv[4] === 'bf' });
const N = data.nodes;
let lastZ = null;
r.nodes.forEach((n, i) => {
  const z = data.zone[n];
  if (z !== lastZ || g.gate.has(n) || i === 0 || i === r.nodes.length - 1 || true)
    console.log(i, Math.round(r.cum[i]), `(${N[n*3].toFixed(0)},${N[n*3+2].toFixed(0)}) lv${data.nodeLv[n]} z${z}`, osm[n] ?? '-', g.gate.has(n) ? 'GATE ' + g.gate.get(n) : '');
  lastZ = z;
});
