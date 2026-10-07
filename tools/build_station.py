#!/usr/bin/env python3
"""OSM 生データ（data/raw/shinjuku.osm.gz）から 3D アプリ用の data/station.json を作る。

標準ライブラリだけで動く:  python3 tools/build_station.py [--report]

やっていること
1. 歩行可能な way（footway/steps/corridor/... と一般道路）から歩行グラフを作る
   - level タグ（無ければ名前の「地下1階」等、tunnel/layer）で各ノードの階を決める
   - 複数階にまたがるノード（エレベーター等）は階ごとに分割し、縦の辺でつなぐ
2. 改札（barrier=turnstile のノード / 線）をグラフ上の「改札ノード」にする
3. ホーム（railway=platform）の内側に歩行用の背骨を作り、周囲の通路とつなぐ
4. ホームから改札を越えずに行ける範囲を、その会社の「改札内」として塗る
5. 建物・道路・線路・店舗など、表示用のデータをまとめる
"""
import gzip
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import station_config as C  # noqa: E402

REPORT = "--report" in sys.argv

# ------------------------------------------------------------------ 読み込み
def load_osm(path):
    nodes, ways, rels = {}, {}, {}
    for _, el in ET.iterparse(gzip.open(path)):
        t = el.tag
        if t == "node":
            nodes[int(el.get("id"))] = (float(el.get("lat")), float(el.get("lon")),
                                        {c.get("k"): c.get("v") for c in el.findall("tag")})
            el.clear()
        elif t == "way":
            ways[int(el.get("id"))] = ([int(c.get("ref")) for c in el.findall("nd")],
                                       {c.get("k"): c.get("v") for c in el.findall("tag")})
            el.clear()
        elif t == "relation":
            rels[int(el.get("id"))] = ([(c.get("type"), int(c.get("ref")), c.get("role")) for c in el.findall("member")],
                                       {c.get("k"): c.get("v") for c in el.findall("tag")})
            el.clear()
    return nodes, ways, rels


nodes, ways, rels = load_osm(ROOT / "data/raw/shinjuku.osm.gz")
LAT0, LON0 = C.ORIGIN
KX = math.cos(math.radians(LAT0)) * 111320.0
KZ = 110574.0


def xz(nid):
    la, lo, _ = nodes[nid]
    return ((lo - LON0) * KX, -(la - LAT0) * KZ)


def inside_clip(x, z, pad=0):
    c = C.CLIP
    return c["xmin"] - pad <= x <= c["xmax"] + pad and c["zmin"] - pad <= z <= c["zmax"] + pad


# ------------------------------------------------------------------ 階の解釈
FLOOR_RE = re.compile(r"(地下)?(\d+)階")


def parse_levels(v):
    if v is None:
        return None
    out = []
    for part in re.split(r"[;,]", v):
        part = part.strip()
        m = re.fullmatch(r"(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)", part)  # 範囲 "-1-6" 等は端だけ
        if m:
            out += [float(m.group(1)), float(m.group(2))]
            continue
        try:
            out.append(float(part))
        except ValueError:
            pass
    return out or None


def floor_from_name(name):
    if not name:
        return None
    for part in name.split(";"):
        m = FLOOR_RE.fullmatch(part.strip())
        if m:
            n = int(m.group(2))
            return float(-n if m.group(1) else n - 1)
    return None


def way_levels(t):
    """way の階リストを返す（不明なら None）"""
    lv = parse_levels(t.get("level"))
    if lv:
        return lv
    lv = parse_levels(t.get("repeat_on"))
    if lv:
        return lv
    f = floor_from_name(t.get("name"))
    if f is not None:
        return [f]
    try:
        layer = float(t.get("layer", "0"))
    except ValueError:
        layer = 0.0
    if layer < 0 and (t.get("tunnel") or t.get("indoor") or t.get("location") == "underground"):
        return [layer]
    if layer >= 1 and (t.get("indoor") or t.get("bridge") or t.get("covered")):
        return [layer]
    return None


# ------------------------------------------------------------------ 歩行 way の抽出
FOOT = {"footway", "pedestrian", "steps", "corridor", "path", "elevator", "living_street", "platform"}
ROAD = {"residential", "unclassified", "service", "tertiary", "secondary", "primary", "trunk",
        "tertiary_link", "secondary_link", "primary_link"}
ROAD_COST = {"residential": 1.15, "unclassified": 1.15, "service": 1.2, "living_street": 1.1,
             "tertiary": 1.3, "secondary": 1.4, "primary": 1.5, "trunk": 1.6}

walk_ways = []  # (wid, nds, kind, levels, costmul, oneway)
for wid, (nds, t) in ways.items():
    hw = t.get("highway")
    if hw is None:
        continue
    if t.get("area") == "yes" and hw in ("pedestrian", "footway"):
        continue  # 広場の外周は通路として扱わない
    if t.get("access") in ("no", "private") or t.get("foot") in ("no", "private"):
        continue
    if hw in FOOT:
        pass
    elif hw in ROAD:
        if t.get("tunnel") in ("yes", "building_passage") and hw != "service":
            continue
        try:
            if float(t.get("layer", "0")) < 0:
                continue
        except ValueError:
            pass
        if t.get("foot") == "no" or t.get("sidewalk") == "no" and hw in ("trunk", "primary"):
            continue
    else:
        continue
    pts = [n for n in nds if n in nodes]
    if len(pts) < 2:
        continue
    if not any(inside_clip(*xz(n), pad=40) for n in pts):
        continue
    kind = "walk"
    if hw == "steps":
        kind = "esc" if t.get("conveying") else "stairs"
    elif hw == "elevator":
        kind = "elev"
    elif t.get("conveying"):
        kind = "esc"
    lv = way_levels(t)  # None = 不明（後で隣の通路から推定）
    if lv is not None and (max(lv) > C.MAX_LEVEL or min(lv) < C.MIN_LEVEL):
        continue  # 商業ビルの上層階などは対象外
    if lv is None and (hw in ROAD or t.get("footway") in ("sidewalk", "crossing")):
        try:
            layer = float(t.get("layer", "0"))
        except ValueError:
            layer = 0.0
        lv = [layer if layer >= 1 and (t.get("bridge") or hw not in ROAD) else 0.0]
    cm = ROAD_COST.get(hw, 1.0)
    walk_ways.append([wid, pts, kind, lv, cm, t])

# ------------------------------------------------------------------ 階が不明な通路の推定
# 階のタグが無い通路は、つながっている「階がわかっている平らな通路」の階を引き継ぐ。
# 両端で違う階につながる場合はスロープとして補間する。どこにもつながらなければ地上(0)。
explicit = set()  # 階が確定した way のインデックス
node_flat = defaultdict(set)  # osm node -> {level} （平らな way から）
for i, (wid, pts, kind, lv, cm, t) in enumerate(walk_ways):
    if lv is not None:
        explicit.add(i)
        if kind == "walk" and len(set(lv)) == 1 or kind in ("stairs", "esc") and len(set(lv)) == 1:
            for n in pts:
                node_flat[n].add(lv[0])
unknown = [i for i, w in enumerate(walk_ways) if w[3] is None]
for _ in range(3):
    changed = False
    for i in unknown:
        w = walk_ways[i]
        if w[3] is not None:
            continue
        pts = w[1]
        la = node_flat.get(pts[0], set())
        lb = node_flat.get(pts[-1], set())
        mid = set()
        for n in pts[1:-1]:
            mid |= node_flat.get(n, set())
        if len(la) == 1 and len(lb) == 1 and la != lb and not mid:
            w[3] = [next(iter(la)), next(iter(lb))]
            w[2] = "ramp" if w[2] == "walk" else w[2]
            w.append("ramp")
        else:
            cand = (la | lb | mid)
            if len(cand) == 1:
                w[3] = [next(iter(cand))]
            elif cand:
                # 複数候補: 地上(0)に一番近いもの（屋外の通路が地下と接している誤りに強い）
                w[3] = [min(cand, key=lambda v: abs(v))]
            else:
                continue
            for n in pts:
                node_flat[n].add(w[3][0])
        explicit.add(i)
        changed = True
    if not changed:
        break
for w in walk_ways:
    if w[3] is None:
        w[3] = [0.0]
# ホームとつないでよい通路ノード: 元から階のタグ/階名がある駅構内の通路だけ（推定した屋外の通路は除く）
explicit_wids = {w[0] for w in walk_ways if way_levels(w[5]) is not None and w[5].get("highway") not in ROAD}
explicit_v = set()
walk_ways = [tuple(w[:6]) for w in walk_ways]

vnodes = []  # [x, y, z, lv]
vkey = {}    # (osm id, lv) -> idx
osm_of = []  # idx -> osm id


def vnode(n, lv):
    k = (n, round(lv, 2))
    if k not in vkey:
        x, z = xz(n)
        vkey[k] = len(vnodes)
        vnodes.append([x, C.level_height(lv), z, lv])
        osm_of.append(n)
    return vkey[k]


def vnode_free(x, z, lv):
    vnodes.append([x, C.level_height(lv), z, lv])
    osm_of.append(None)
    return len(vnodes) - 1


edges = {}  # (a,b) sorted -> [kind, costmul]
KCODE = {"walk": 0, "stairs": 1, "esc": 2, "elev": 3, "plat": 4, "ramp": 5}


edge_way = {}   # 辺 -> 元の OSM way id（表示・案内用）
CUR_WID = None


def add_edge(a, b, kind, cm=1.0):
    if a == b:
        return
    k = (a, b) if a < b else (b, a)
    old = edges.get(k)
    if old is None or KCODE[kind] < KCODE[old[0]]:
        edges[k] = [kind, cm]
    if CUR_WID is not None and k not in edge_way:
        edge_way[k] = CUR_WID


def seg_len(pts):
    L = [0.0]
    for i in range(1, len(pts)):
        (x0, z0), (x1, z1) = xz(pts[i - 1]), xz(pts[i])
        L.append(L[-1] + math.hypot(x1 - x0, z1 - z0))
    return L


way_chain = {}
for wid, pts, kind, lv, cm, t in walk_ways:
    CUR_WID = wid
    levels = sorted(set(lv))
    if kind == "walk" or len(levels) == 1 and kind != "elev":
        L = levels[0]
        chain = [vnode(n, L) for n in pts]
        if wid in explicit_wids:
            explicit_v.update(chain)
        for i in range(1, len(chain)):
            add_edge(chain[i - 1], chain[i], "walk" if kind in ("walk", "ramp") else kind, cm)
        way_chain[wid] = chain
        continue
    if kind == "elev":
        continue  # エレベーター way は後でノード扱い
    # 階段・エスカレーター（複数階）: 端点の階を決めて内側は補間
    a_end, b_end = pts[0], pts[-1]
    lo, hi = levels[0], levels[-1]
    fa, fb = node_flat.get(a_end, set()), node_flat.get(b_end, set())
    la = next((l for l in (lo, hi) if l in fa), None)
    lb = next((l for l in (lo, hi) if l in fb), None)
    if la is None and lb is None:
        inc = t.get("incline", "")
        la, lb = (lo, hi) if inc in ("up", "") else (hi, lo)
    elif la is None:
        la = hi if lb == lo else lo
    elif lb is None:
        lb = hi if la == lo else lo
    if la == lb:
        lb = hi if la == lo else lo
    Ls = seg_len(pts)
    tot = Ls[-1] or 1.0
    idx = []
    for i, n in enumerate(pts):
        if i == 0:
            idx.append(vnode(n, la))
        elif i == len(pts) - 1:
            idx.append(vnode(n, lb))
        else:
            f = Ls[i] / tot
            x, z = xz(n)
            idx.append(vnode_free(x, z, la + (lb - la) * f))
    for i in range(1, len(idx)):
        add_edge(idx[i - 1], idx[i], kind, cm)
    way_chain[wid] = idx
    explicit_v.update(idx)

CUR_WID = None

# 同じ OSM ノードが複数の階にある -> 縦につなぐ（エレベーターなら elev、それ以外は段差扱い）
by_osm = defaultdict(list)
for (n, lv), i in vkey.items():
    by_osm[n].append((lv, i))
elev_nodes = {n for n, (la, lo, t) in nodes.items() if t.get("highway") == "elevator"}
for wid, (nds, t) in ways.items():
    if t.get("highway") == "elevator" or t.get("building:part") == "elevator":
        for n in nds:
            elev_nodes.add(n)
n_vert_fix = 0
for n, lst in by_osm.items():
    if len(lst) < 2:
        continue
    lst.sort()
    for (l0, i0), (l1, i1) in zip(lst, lst[1:]):
        if n in elev_nodes:
            add_edge(i0, i1, "elev")
        else:
            add_edge(i0, i1, "ramp" if abs(l1 - l0) <= 0.5 else "stairs")
            n_vert_fix += 1

# エレベーターノードが1階分にしか無い場合: 近く(4m以内)の別階エレベーターノード同士をつなぐ
elev_v = [i for i, n in enumerate(osm_of) if n in elev_nodes]
for a in elev_v:
    for b in elev_v:
        if a < b and osm_of[a] != osm_of[b]:
            xa, ya, za, la = vnodes[a]
            xb, yb, zb, lb = vnodes[b]
            if la != lb and math.hypot(xa - xb, za - zb) < 4:
                add_edge(a, b, "elev")

# ------------------------------------------------------------------ 改札
gate_osm = {}
for n, (la, lo, t) in nodes.items():
    if t.get("barrier") == "turnstile" or t.get("railway") == "ticket_gate":
        gate_osm[n] = t
gates = []  # dict(n=vidx, name, x,z,lv)


def gate_name(t):
    for k in ("name:ja", "name", "ref"):
        v = t.get(k)
        if v:
            v = v.split(";")[-1]
            return C.GATE_NAMES.get(v, v)
    return ""


for n, nm in C.EXTRA_GATE_NODES.items():
    gate_osm[n] = {"name": nm}
gate_v = set()
for n, t in gate_osm.items():
    for lv, i in by_osm.get(n, []):
        gate_v.add(i)
        gates.append(dict(n=i, name=gate_name(t)))

# 改札の「線」と通路の交差 -> 交点に改札ノードを入れる
def seg_inter(p1, p2, p3, p4):
    d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if abs(d) < 1e-9:
        return None
    t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    if 0 <= t <= 1 and 0 <= u <= 1:
        return t
    return None


gate_lines = []
for wid, (nds, t) in ways.items():
    if t.get("barrier") == "turnstile":
        pts = [xz(n) for n in nds if n in nodes]
        lv = way_levels(t) or [0.0]
        if len(pts) >= 2 and inside_clip(*pts[0], pad=50):
            gate_lines.append((pts, lv[0], gate_name(t)))

n_split = 0
for pts, glv, gname in gate_lines:
    # 改札線を少し延長（通路の端が改札線に届いていないことがある）
    ext = []
    (x0, z0), (x1, z1) = pts[0], pts[-1]
    dx, dz = x1 - x0, z1 - z0
    L = math.hypot(dx, dz) or 1
    ext = [(x0 - dx / L * 1.5, z0 - dz / L * 1.5)] + pts[1:-1] + [(x1 + dx / L * 1.5, z1 + dz / L * 1.5)]
    for (a, b), (kind, cm) in list(edges.items()):
        if kind != "walk":
            continue
        if abs(vnodes[a][3] - glv) > 0.6 or abs(vnodes[b][3] - glv) > 0.6:
            continue
        pa, pb = (vnodes[a][0], vnodes[a][2]), (vnodes[b][0], vnodes[b][2])
        if a in gate_v or b in gate_v:
            continue
        for i in range(1, len(ext)):
            tt = seg_inter(pa, pb, ext[i - 1], ext[i])
            if tt is not None:
                x = pa[0] + (pb[0] - pa[0]) * tt
                z = pa[1] + (pb[1] - pa[1]) * tt
                g = vnode_free(x, z, vnodes[a][3])
                CUR_WID = edge_way.get((a, b))
                del edges[(a, b)]
                add_edge(a, g, kind, cm)
                add_edge(g, b, kind, cm)
                gate_v.add(g)
                gates.append(dict(n=g, name=gname))
                n_split += 1
                break

# 名前が「…;西改札」「…;新南改札(有人通路)」のような通路は改札を通る通路。中ほどに改札ノードを置く
GATE_WAY_RE = re.compile(r"(改札|有人通路|有人窓口)")
n_gate_way = 0
for wid, pts, kind, lv, cm, t in walk_ways:
    name = t.get("name", "")
    last = name.split(";")[-1] if name else ""
    if not GATE_WAY_RE.search(last) or kind != "walk" or wid not in way_chain:
        continue
    chain = way_chain[wid]
    if any(i in gate_v for i in chain):
        continue
    best, bl = None, -1
    for a, b in zip(chain, chain[1:]):
        L = math.hypot(vnodes[a][0] - vnodes[b][0], vnodes[a][2] - vnodes[b][2])
        if L > bl and ((a, b) if a < b else (b, a)) in edges:
            best, bl = (a, b), L
    if best is None:
        continue
    a, b = best
    k = (a, b) if a < b else (b, a)
    kind0, cm0 = edges.pop(k)
    CUR_WID = edge_way.get(k)
    g = vnode_free((vnodes[a][0] + vnodes[b][0]) / 2, (vnodes[a][2] + vnodes[b][2]) / 2, vnodes[a][3])
    add_edge(a, g, kind0, cm0)
    add_edge(g, b, kind0, cm0)
    gate_v.add(g)
    gname = re.sub(r"\(.*?\)|有人窓口|有人通路", "", last).strip() or "改札"
    gates.append(dict(n=g, name=C.GATE_NAMES.get(gname, gname)))
    n_gate_way += 1

CUR_WID = None
# ------------------------------------------------------------------ 補助: 隣接
def build_adj():
    adj = defaultdict(list)
    for (a, b), (kind, cm) in edges.items():
        adj[a].append(b)
        adj[b].append(a)
    return adj


CUR_WID = None
# ------------------------------------------------------------------ ホーム
OPBIT = {k: b for k, _, b in C.OPS}
node_names = defaultdict(list)
for wid, pts, kind, lv, cm, t in walk_ways:
    for n in pts:
        node_names[n].append(t)


def classify(i):
    """-> (自社接頭辞のある会社集合, 改札外の名前があるか)"""
    n = osm_of[i]
    if n is None:
        return set(), False
    ops, pub = set(), False
    for t in node_names.get(n, []):
        name = t.get("name", "")
        if t.get("highway") in ROAD or t.get("footway") in ("sidewalk", "crossing"):
            pub = True
            continue
        if not name:
            continue
        hit = [o for o, pres in C.OP_PREFIX.items() if any(name.startswith(p) for p in pres)]
        if hit and "改札外" not in name.split(";")[0]:
            ops.update(hit)
        else:
            pub = True
    return ops, pub


def way_ring(wid):
    nds = ways[wid][0]
    return [xz(n) for n in nds if n in nodes]


def rel_outer(rid):
    mem, _ = rels[rid]
    rings = []
    for ty, r, ro in mem:
        if ty == "way" and ro == "outer" and r in ways:
            rings.append(way_ring(r))
    return max(rings, key=len) if rings else []


def pip(x, z, ring):
    c = False
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1 + 1e-12) + x1:
            c = not c
    return c


def dist_to_ring(x, z, ring):
    best = 1e9
    for i in range(len(ring)):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % len(ring)]
        dx, dz = x2 - x1, z2 - z1
        L2 = dx * dx + dz * dz or 1e-9
        t = max(0, min(1, ((x - x1) * dx + (z - z1) * dz) / L2))
        best = min(best, math.hypot(x - (x1 + t * dx), z - (z1 + t * dz)))
    return best


def principal_axis(ring):
    cx = sum(p[0] for p in ring) / len(ring)
    cz = sum(p[1] for p in ring) / len(ring)
    sxx = sum((p[0] - cx) ** 2 for p in ring)
    szz = sum((p[1] - cz) ** 2 for p in ring)
    sxz = sum((p[0] - cx) * (p[1] - cz) for p in ring)
    ang = 0.5 * math.atan2(2 * sxz, sxx - szz)
    return cx, cz, math.cos(ang), math.sin(ang)


plats = []
for pid, (label, ops, short) in C.PLATFORMS.items():
    if pid[0] == "w":
        wid = int(pid[1:])
        if wid not in ways:
            print("missing platform", pid)
            continue
        ring = way_ring(wid)
        t = ways[wid][1]
    else:
        rid = int(pid[1:])
        ring = rel_outer(rid)
        t = rels[rid][1]
    if ring and ring[0] == ring[-1]:
        ring = ring[:-1]
    lv = C.PLATFORM_LEVEL.get(pid)
    if lv is None:
        lvs = parse_levels(t.get("level"))
        lv = lvs[0] if lvs else 0.0
    plats.append(dict(id=pid, label=label, ops=ops, short=short, lv=float(lv), ring=ring, nodes=[]))

# 線状のホーム（面でない）は幅 6m の帯にする
for p in plats:
    r = p["ring"]
    closed = len(r) >= 3 and math.hypot(r[0][0] - r[-1][0], r[0][1] - r[-1][1]) < 1.0
    area = 0.0
    for i in range(len(r)):
        area += r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1]
    if len(r) >= 3 and abs(area) > 30:
        continue
    left, right = [], []
    for i, (x, z) in enumerate(r):
        a = r[max(0, i - 1)]
        b = r[min(len(r) - 1, i + 1)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dz) or 1
        left.append((x - dz / L * 3, z + dx / L * 3))
        right.append((x + dz / L * 3, z - dx / L * 3))
    p["ring"] = left + right[::-1]

adj = build_adj()
for p in plats:
    ring = p["ring"]
    cx, cz, ux, uz = principal_axis(ring)
    proj = [(x - cx) * ux + (z - cz) * uz for x, z in ring]
    s0, s1 = min(proj), max(proj)
    # 背骨: 2m 刻みでサンプルし、ホーム内にある点だけ使う（横方向にはホーム内の中点へ寄せる）
    spine = []
    s = s0 + 2
    while s < s1 - 2:
        bx, bz = cx + ux * s, cz + uz * s
        # 法線方向にホーム内の区間を探して中点を取る
        ins = [k for k in [i * 0.5 for i in range(-40, 41)] if pip(bx - uz * k, bz + ux * k, ring)]
        if ins:
            k = (ins[0] + ins[-1]) / 2
            spine.append(vnode_free(bx - uz * k, bz + ux * k, p["lv"]))
        s += 4
    for a, b in zip(spine, spine[1:]):
        add_edge(a, b, "plat")
    p["spine"] = spine
    # ホーム内・周辺(2.5m)にある同じ階の通路ノードを背骨につなぐ
    linked = 0
    for i, (x, y, z, lv) in enumerate(vnodes):
        if i in spine or abs(lv - p["lv"]) > 0.25 or not spine:
            continue
        if not (pip(x, z, ring) or dist_to_ring(x, z, ring) < 2.5):
            continue
        if i not in adj and osm_of[i] is not None and i not in gate_v:
            continue
        if osm_of[i] is not None and i not in explicit_v:
            continue
        ops_i, pub_i = classify(i)
        if pub_i or (ops_i and not ops_i & set(p["ops"])):
            continue  # 改札外の通路や他社の通路はホームにつながない
        j = min(spine, key=lambda k: (vnodes[k][0] - x) ** 2 + (vnodes[k][2] - z) ** 2)
        add_edge(i, j, "plat")
        p["nodes"].append(i)
        linked += 1
    p["linked"] = linked

CUR_WID = None
# OSM で構内通路が描かれていないホームは、指定した地点の地上通路へ改札＋エスカレーターでつなぐ
for pid, (sx, sz), slv, gname in C.SYNTH_LINKS:
    p = next((q for q in plats if q["id"] == pid), None)
    if not p or not p["spine"]:
        continue
    sp = min(p["spine"], key=lambda k: (vnodes[k][0] - sx) ** 2 + (vnodes[k][2] - sz) ** 2)
    cand = [i for i in range(len(vnodes)) if abs(vnodes[i][3] - slv) < 0.3 and osm_of[i] is not None]
    gnd = min(cand, key=lambda i: (vnodes[i][0] - sx) ** 2 + (vnodes[i][2] - sz) ** 2)
    g = vnode_free(vnodes[sp][0], vnodes[sp][2], p["lv"])
    add_edge(sp, g, "plat")
    add_edge(g, gnd, "esc" if abs(p["lv"] - slv) >= 0.5 else "walk")
    gate_v.add(g)
    gates.append(dict(n=g, name=gname))

# ------------------------------------------------------------------ 孤立部分の除去
adj = build_adj()
comp = {}
comps = []
for s in adj:
    if s in comp:
        continue
    q = deque([s])
    comp[s] = len(comps)
    members = [s]
    while q:
        u = q.popleft()
        for v in adj[u]:
            if v not in comp:
                comp[v] = comp[s]
                members.append(v)
                q.append(v)
    comps.append(members)
main = max(range(len(comps)), key=lambda i: len(comps[i]))
platform_comps = {comp[k] for p in plats for k in p["spine"] if k in comp}
keep = set(comps[main])
for c in platform_comps:
    if c != main and REPORT:
        print("platform component not connected to main:", [p["id"] for p in plats if any(comp.get(k) == c for k in p["spine"])], len(comps[c]))

# ------------------------------------------------------------------ 改札内の塗り分け
# ホームから「改札」を越えずに歩ける範囲を、その会社の改札内とする。
# OSM の改札の描き漏れで外に漏れないよう、通路の名前も壁として使う:
#   - 他社の駅名や「…自由通路」「…出入口」など、改札外の名前が付いた通路には入らない
#   - 自社の駅名が付いた通路と、名前の無い通路だけを進む
cls_cache = {}
zone = defaultdict(int)
for p, op in [(p, o) for p in plats for o in p["ops"]]:
    bits = OPBIT[op]
    my = {op}
    q = deque(k for k in p["spine"] if k in keep)
    seen = set(q)
    while q:
        u = q.popleft()
        zone[u] |= bits
        if u in gate_v:
            continue
        if u not in cls_cache:
            cls_cache[u] = classify(u)
        ops_u, pub_u = cls_cache[u]
        if pub_u and not ops_u & my and u not in p["spine"]:
            continue
        if pub_u and ops_u & my:
            continue  # 境目のノード: 入るが先へは広げない
        for v in adj[u]:
            if v in seen or v not in keep:
                continue
            if v not in cls_cache:
                cls_cache[v] = classify(v)
            ops_v, pub_v = cls_cache[v]
            if ops_v and not ops_v & my:
                continue  # 他社の構内
            if pub_v and not ops_v & my:
                continue  # 改札外の名前
            seen.add(v)
            q.append(v)

# 別会社の改札内どうしが名前の無い通路でつながってしまった部分は、改札外（連絡通路）とみなす
legal = {0}
for p in plats:
    b = 0
    for o in p["ops"]:
        b |= OPBIT[o]
    legal.add(b)
    for o in p["ops"]:
        legal.add(OPBIT[o])
spine_bits = {}
for p in plats:
    b = 0
    for o in p["ops"]:
        b |= OPBIT[o]
    for k in p["spine"]:
        spine_bits[k] = b
n_pub = 0
for i in list(zone):
    if i in spine_bits:
        zone[i] = spine_bits[i]
    elif zone[i] not in legal:
        zone[i] = 0
        n_pub += 1

# 改札内と改札外（または別会社の改札内）が改札なしで直接つながっている辺 = 改札の描き漏れ。
# 辺の中ほどに改札ノードを入れる（名前は近くの改札から借りる）
named_gates = [(vnodes[g["n"]][0], vnodes[g["n"]][2], vnodes[g["n"]][3], g["name"], zone[g["n"]])
               for g in gates if g["name"] and g["name"] != "改札"]


def guess_gate_name(x, z, lv, zb=0):
    best, bd = "改札", 45.0
    for k, short in C.OP_GATE.items():
        if zb & OPBIT[k]:
            best = short
            break
    for gx, gz, glv, nm, gz_ in named_gates:
        if abs(glv - lv) > 0.6:
            continue
        if zb and not (gz_ & zb):
            continue
        d = math.hypot(gx - x, gz - z)
        if d < bd:
            best, bd = nm, d
    return best


n_auto = 0
for (a, b), (kind, cm) in list(edges.items()):
    if a not in keep or b not in keep or a in gate_v or b in gate_v:
        continue
    za, zb = zone[a], zone[b]
    if za == zb or (za & zb):
        continue
    CUR_WID = edge_way.get((a, b))
    del edges[(a, b)]
    # 会社どうしが直接つながっている場合は「出る改札」「入る改札」の2つを入れ、間を改札外にする
    fr = [0.5] if not (za and zb) else [0.3, 0.7]
    chain = [a]
    for f in fr:
        x = vnodes[a][0] + (vnodes[b][0] - vnodes[a][0]) * f
        z = vnodes[a][2] + (vnodes[b][2] - vnodes[a][2]) * f
        lv = vnodes[a][3] + (vnodes[b][3] - vnodes[a][3]) * f
        g = vnode_free(x, z, lv)
        vnodes[g][1] = vnodes[a][1] + (vnodes[b][1] - vnodes[a][1]) * f
        side = a if f < 0.5 else b
        if len(fr) == 1:
            side = a if za else b
        zone[g] = zone[side]
        gate_v.add(g)
        keep.add(g)
        nm = None
        for t in node_names.get(osm_of[side], []) if osm_of[side] is not None else []:
            last = t.get("name", "").split(";")[-1]
            if ";" in t.get("name", "") and (last.endswith("口") or last.endswith("改札")) and "出入口" not in last:
                nm = last if last.endswith("改札") else last + "改札"
        gates.append(dict(n=g, name=nm or guess_gate_name(x, z, lv, zone[side]), auto=True))
        chain.append(g)
    if len(fr) == 2:  # 2つの改札の間（改札外）
        m = vnode_free((vnodes[chain[1]][0] + vnodes[chain[2]][0]) / 2, (vnodes[chain[1]][2] + vnodes[chain[2]][2]) / 2,
                       (vnodes[chain[1]][3] + vnodes[chain[2]][3]) / 2)
        vnodes[m][1] = (vnodes[chain[1]][1] + vnodes[chain[2]][1]) / 2
        zone[m] = 0
        keep.add(m)
        chain.insert(2, m)
    chain.append(b)
    for u, v in zip(chain, chain[1:]):
        add_edge(u, v, kind, cm)
    n_auto += 1
CUR_WID = None
adj = build_adj()

# 名前が「改札」だけの改札は、会社名で呼ぶ
for g in gates:
    if (g["name"] or "改札") == "改札":
        zb = zone[g["n"]]
        if not zb:
            nb = [zone[v] for v in adj[g["n"]] if zone[v]]
            zb = nb[0] if nb else 0
        g["name"] = guess_gate_name(vnodes[g["n"]][0], vnodes[g["n"]][2], vnodes[g["n"]][3], zb) if zb else "改札"

if REPORT:
    print(f"vnodes={len(vnodes)} edges={len(edges)} gates={len(gates)} split={n_split} gateways={n_gate_way} auto={n_auto} vertfix={n_vert_fix}")
    print("components:", sorted((len(c) for c in comps), reverse=True)[:10])
    cnt = defaultdict(int)
    for i in keep:
        cnt[zone[i]] += 1
    print("zone sizes:", dict(cnt))
    for p in plats:
        print(p["id"], p["short"], p["label"], "lv", p["lv"], "spine", len(p["spine"]), "linked", p["linked"],
              "main" if p["spine"] and comp.get(p["spine"][0]) == main else "ISOLATED")

# ------------------------------------------------------------------ 出口
def nearest_public(x, z, lv, maxd=80):
    best, bd = None, 1e9
    for i in keep:
        if zone[i] or i in gate_v:
            continue
        vx, vy, vz, vlv = vnodes[i]
        d = math.hypot(vx - x, vz - z) + abs(vlv - lv) * 25
        if d < bd:
            best, bd = i, d
    return best if bd < maxd else None


exits = []
for key, name, sub, (x, z), lv in C.EXITS:
    n = nearest_public(x, z, lv)
    if n is None:
        print("exit not snapped:", key)
        continue
    exits.append(dict(key=key, name=name, sub=sub, n=n))

# ------------------------------------------------------------------ 出力用に番号を詰める
used = sorted(keep)
remap = {o: i for i, o in enumerate(used)}
out_nodes, out_lv, out_zone = [], [], []
for o in used:
    x, y, z, lv = vnodes[o]
    out_nodes += [round(x, 1), round(y, 2), round(z, 1)]
    out_lv.append(round(lv, 2))
    out_zone.append(zone[o])
out_edges = []
out_ekeys = []
for (a, b), (kind, cm) in edges.items():
    if a in remap and b in remap:
        out_edges += [remap[a], remap[b], KCODE[kind]]
        out_ekeys.append((a, b))
out_cost = [round(cm, 2) for (a, b), (kind, cm) in edges.items() if a in remap and b in remap]

# 辺ごとの「屋内か」と「通路名」
FLOOR_PART = re.compile(r"^(地下)?\d+階$|^\d+F$|^B\d+F?$")
PREFIX_PART = re.compile(r"(駅|新宿駅|\(改札外\))$")


def passage_name(t):
    name = t.get("name", "")
    if not name:
        return ""
    parts = [x.strip() for x in name.split(";") if x.strip()]
    keep = [x for x in parts if not FLOOR_PART.match(x)]
    if len(parts) > 1:
        keep = [x for x in keep[1:]] or []  # 先頭は「JR新宿駅」などの駅名
    last = keep[-1] if keep else (parts[0] if len(parts) == 1 else "")
    if re.search(r"(エレベーター|トイレ|番線|ホーム|改札|ロッカー|エリア|券売機|出入口|入口|^[A-Z]?\d+$)", last):
        return ""
    if t.get("highway") in ROAD or t.get("footway") in ("sidewalk", "crossing"):
        return last if len(parts) == 1 else ""
    return last


def is_indoor_way(t):
    if t.get("indoor") or t.get("tunnel") in ("yes", "building_passage") or t.get("covered") == "yes":
        return True
    if t.get("highway") in ROAD or t.get("footway") in ("sidewalk", "crossing"):
        return False
    lv = way_levels(t)
    if lv is not None and any(v != 0 for v in lv):
        return True
    name = t.get("name", "")
    if any(name.startswith(p) for pres in C.OP_PREFIX.values() for p in pres) and "改札外" not in name:
        return True
    return t.get("highway") in ("corridor", "elevator")


names_list = []
name_idx = {}
out_ename, out_ein = [], []
for (a, b) in out_ekeys:
    wid = edge_way.get((a, b))
    t = ways[wid][1] if wid in ways else {}
    nm = passage_name(t) if t else ""
    if nm and nm not in name_idx:
        name_idx[nm] = len(names_list)
        names_list.append(nm)
    out_ename.append(name_idx.get(nm, -1))
    kind = edges[(a, b)][0]
    if kind in ("plat", "elev"):
        out_ein.append(1)
    elif t:
        out_ein.append(1 if is_indoor_way(t) else 0)
    else:
        # 改札や補助の辺: 両端の階で判断（地上以外は屋内）
        out_ein.append(1 if abs(vnodes[a][3]) > 0.1 or abs(vnodes[b][3]) > 0.1 else 0)

# 改札: 同じ名前・近い位置はまとめず、全部出す（経路判定用）。表示は名前ごとに代表1つ
out_gates = []
for g in gates:
    g["name"] = C.FINAL_GATE_NAMES.get(g["name"], g["name"])
    if g["n"] in remap:
        out_gates.append(dict(n=remap[g["n"]], name=g["name"]))

# ホーム
line_of_plat = defaultdict(list)
for key, name, sub, color, op, pls, *rest in C.LINES:
    for pid in pls:
        line_of_plat[pid].append(key)
out_plats = []
pidx = {}
for p in plats:
    sp = [remap[k] for k in p["spine"] if k in remap]
    if not sp:
        print("platform dropped (not connected):", p["id"])
        continue
    pidx[p["id"]] = len(out_plats)
    ring = []
    for x, z in p["ring"]:
        ring += [round(x, 1), round(z, 1)]
    out_plats.append(dict(id=p["id"], label=p["label"], short=p["short"], lv=p["lv"], y=C.level_height(p["lv"]),
                          ring=ring, lines=line_of_plat.get(p["id"], []), nodes=sp))
out_lines = []
for key, name, sub, color, op, pls, *rest in C.LINES:
    ps = [pidx[p] for p in pls if p in pidx]
    if not ps:
        print("line has no platform:", key)
        continue
    ln = dict(key=key, name=name, sub=sub, color=color, op=op, plats=ps)
    if rest:
        ln["arr"] = [pidx[p] for p in rest[0] if p in pidx]
    out_lines.append(ln)

# ------------------------------------------------------------------ 表示用: 建物・道路・線路・店舗
def ring_area(r):
    a = 0
    for i in range(len(r)):
        a += r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1]
    return a / 2


def simplify(r, tol=0.6):
    if len(r) < 4:
        return r
    out = [r[0]]
    for p in r[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= tol:
            out.append(p)
    return out


buildings = []
for wid, (nds, t) in ways.items():
    if not t.get("building") or t.get("building") in ("roof",):
        continue
    if t.get("location") == "underground" or t.get("layer", "0").startswith("-"):
        continue
    r = way_ring(wid)
    if len(r) < 4 or not all(inside_clip(x, z, pad=60) for x, z in r):
        continue
    r = simplify(r[:-1] if r[0] == r[-1] else r)
    if len(r) < 3 or abs(ring_area(r)) < 25:
        continue
    try:
        h = float(re.sub(r"[^0-9.]", "", t.get("height", "")) or 0)
    except ValueError:
        h = 0
    if not h:
        try:
            h = float(t.get("building:levels", "0")) * 3.6
        except ValueError:
            h = 0
    h = h or 10.0
    h = min(h, 260)
    if ring_area(r) > 0:  # 時計回りにそろえる必要はない（Shape が両対応）
        pass
    flat = []
    for x, z in r:
        flat += [round(x, 1), round(z, 1)]
    buildings.append(dict(r=flat, b=0, h=round(h, 1)))

roads = []
for wid, (nds, t) in ways.items():
    hw = t.get("highway")
    if hw not in ("primary", "secondary", "tertiary", "trunk", "residential", "unclassified", "pedestrian", "motorway"):
        continue
    try:
        if float(t.get("layer", "0")) < 0:
            continue
    except ValueError:
        pass
    r = [xz(n) for n in nds if n in nodes]
    if not any(inside_clip(x, z, pad=30) for x, z in r):
        continue
    flat = []
    for x, z in simplify(r, 2):
        flat += [round(x, 1), round(z, 1)]
    if len(flat) >= 4:
        roads.append(flat)

RAIL_COLOR = {"山手線": "#80c241", "中央本線": "#f15a22", "中央緩行線": "#ffd400", "JR中央線": "#f15a22",
              "山手貨物線": "#00ac9a", "JR埼京線": "#00ac9a", "成田エクスプレス": "#c8102e",
              "小田急小田原線": "#1e88d4", "京王電鉄京王線": "#dd0077", "京王新線": "#6cbb5a",
              "都営地下鉄新宿線": "#6cbb5a", "都営地下鉄大江戸線": "#b6007a", "東京メトロ丸ノ内線": "#f62e36",
              "東京メトロ副都心線": "#9c5e31", "西武新宿線": "#2e6db4"}
rails = []
for wid, (nds, t) in ways.items():
    if t.get("railway") not in ("rail", "subway"):
        continue
    if t.get("service") in ("siding", "yard", "spur"):
        continue
    r = [xz(n) for n in nds if n in nodes]
    if not any(inside_clip(x, z, pad=20) for x, z in r):
        continue
    lv = parse_levels(t.get("level"))
    if lv:
        y = C.level_height(lv[0])
    else:
        try:
            layer = float(t.get("layer", "0"))
        except ValueError:
            layer = 0
        y = C.level_height(layer) if layer < 0 else (C.level_height(1) if t.get("bridge") else 0)
    # 近くのホームと同じ高さに合わせる（線路の level はあてにならないことがある）
    mx = sum(p[0] for p in r) / len(r)
    mz = sum(p[1] for p in r) / len(r)
    near = [p for p in plats if any(abs(rx - mx) < 120 and abs(rz - mz) < 120 for rx, rz in p["ring"][:1])]
    name = t.get("name", "")
    for p in plats:
        if p["short"] in ("小田急",) and "小田急" in name or p["short"] == "京王" and name == "京王電鉄京王線" \
                or p["short"] == "京王新線" and name in ("京王新線", "都営地下鉄新宿線") \
                or p["short"] == "大江戸線" and "大江戸" in name or p["short"] == "丸ノ内線" and "丸ノ内" in name:
            if math.hypot(p["ring"][0][0] - mx, p["ring"][0][1] - mz) < 200:
                y = C.level_height(p["lv"]) - 1.2
                break
    pts = []
    for x, z in simplify(r, 3):
        pts += [round(x, 1), round(y, 1), round(z, 1)]
    rails.append(dict(p=pts, c=RAIL_COLOR.get(name, "#6b7790")))

shops = []
for n, (la, lo, t) in nodes.items():
    if not (t.get("shop") or t.get("amenity") in ("restaurant", "cafe", "fast_food", "bar", "pub")):
        continue
    x, z = xz(n)
    if not inside_clip(x, z):
        continue
    lv = parse_levels(t.get("level"))
    lv = lv[0] if lv else 0.0
    if not (C.MIN_LEVEL <= lv <= C.MAX_LEVEL) or lv != int(lv):
        continue
    shops += [round(x, 1), round(C.level_height(lv), 1), round(z, 1), lv]

levels = sorted({round(v) for v in out_lv})

# ------------------------------------------------------------------ 通路の形（階ごとのマス目）
# 駅の向きに合わせて回したマス目（RES m 角）に、歩ける床(1)・吹き抜け/ホーム/階段口(2)を塗る。
# 3D 表示ではこのマス目から床・壁・天井を作る
import numpy as np  # noqa: E402

RES = C.GRID_RES
# 主な向き: 屋内の辺の向き（90度の剰余）の長さ重み付きヒストグラムの山
hist = np.zeros(180)
for i in range(0, len(out_edges), 3):
    a, b = out_edges[i], out_edges[i + 1]
    if not out_ein[i // 3]:
        continue
    dx = out_nodes[b * 3] - out_nodes[a * 3]
    dz = out_nodes[b * 3 + 2] - out_nodes[a * 3 + 2]
    L = math.hypot(dx, dz)
    if L < 2:
        continue
    ang = math.degrees(math.atan2(dz, dx)) % 90
    hist[int(ang * 2) % 180] += L
hist = np.convolve(np.concatenate([hist[-6:], hist, hist[:6]]), np.ones(7), "valid")[3:-3]
THETA = math.radians(int(np.argmax(hist)) / 2)
CT, ST = math.cos(THETA), math.sin(THETA)


def to_grid(x, z):  # ワールド -> 回転座標
    return x * CT + z * ST, -x * ST + z * CT


corners = [to_grid(x, z) for x in (C.CLIP["xmin"], C.CLIP["xmax"]) for z in (C.CLIP["zmin"], C.CLIP["zmax"])]
U0 = math.floor(min(c[0] for c in corners) / RES) * RES
V0 = math.floor(min(c[1] for c in corners) / RES) * RES
GW = int(math.ceil((max(c[0] for c in corners) - U0) / RES))
GH = int(math.ceil((max(c[1] for c in corners) - V0) / RES))
cu = U0 + (np.arange(GW) + 0.5) * RES
cv = V0 + (np.arange(GH) + 0.5) * RES


def paint_segment(mask, p, q, half, val, cap=True, over=None):
    """線分 p-q（回転座標）から half 以内のマスを val に（over 指定時はその値のマスだけ）"""
    (u1, v1), (u2, v2) = p, q
    pad = half + RES
    i0 = max(0, int((min(u1, u2) - pad - U0) / RES)); i1 = min(GW, int((max(u1, u2) + pad - U0) / RES) + 1)
    j0 = max(0, int((min(v1, v2) - pad - V0) / RES)); j1 = min(GH, int((max(v1, v2) + pad - V0) / RES) + 1)
    if i0 >= i1 or j0 >= j1:
        return
    U, V = np.meshgrid(cu[i0:i1], cv[j0:j1])
    du, dv = u2 - u1, v2 - v1
    L2 = du * du + dv * dv or 1e-9
    t = ((U - u1) * du + (V - v1) * dv) / L2
    if cap:
        tc = np.clip(t, 0, 1)
        d = np.hypot(U - (u1 + tc * du), V - (v1 + tc * dv))
        hit = d <= half
    else:
        d = np.hypot(U - (u1 + t * du), V - (v1 + t * dv))
        hit = (d <= half) & (t >= 0) & (t <= 1)
    sub = mask[j0:j1, i0:i1]
    if over is not None:
        hit &= np.isin(sub, over)
    sub[hit] = val


def paint_polygon(mask, ring, val, over=None):
    from matplotlib.path import Path
    pts = [to_grid(x, z) for x, z in ring]
    us = [p[0] for p in pts]; vs = [p[1] for p in pts]
    i0 = max(0, int((min(us) - U0) / RES)); i1 = min(GW, int((max(us) - U0) / RES) + 2)
    j0 = max(0, int((min(vs) - V0) / RES)); j1 = min(GH, int((max(vs) - V0) / RES) + 2)
    if i0 >= i1 or j0 >= j1:
        return
    U, V = np.meshgrid(cu[i0:i1], cv[j0:j1])
    hit = Path(pts).contains_points(np.stack([U.ravel(), V.ravel()], 1)).reshape(U.shape)
    sub = mask[j0:j1, i0:i1]
    if over is not None:
        hit &= np.isin(sub, over)
    sub[hit] = val


WIDE = re.compile(r"(自由通路|コンコース|広場|プロムナード|通路|地下道|モール|サブナード)")
masks = {L: np.zeros((GH, GW), np.uint8) for L in levels}
P3 = lambda i: (out_nodes[i * 3], out_nodes[i * 3 + 1], out_nodes[i * 3 + 2])  # noqa: E731
vert_edges = []
for e in range(len(out_ekeys)):
    a, b, k = out_edges[e * 3], out_edges[e * 3 + 1], out_edges[e * 3 + 2]
    la, lb = out_lv[a], out_lv[b]
    pa, pb = to_grid(P3(a)[0], P3(a)[2]), to_grid(P3(b)[0], P3(b)[2])
    if k in (KCODE["stairs"], KCODE["esc"]) or (k == KCODE["ramp"] and abs(la - lb) > 0.3):
        vert_edges.append(e)
        continue
    if k in (KCODE["plat"], KCODE["elev"]) or not out_ein[e]:
        continue
    if abs(la - lb) > 0.3:
        continue
    L = round(la)
    if abs(la - L) > 0.3 or L not in masks:
        continue
    wid = edge_way.get(out_ekeys[e])
    t = ways[wid][1] if wid in ways else {}
    w = C.CORRIDOR_W
    try:
        w = float(t.get("width", "")) if t.get("width") else w
    except ValueError:
        pass
    if WIDE.search(t.get("name", "")):
        w = max(w, C.WIDE_W)
    w = max(2.5, min(w, 14))
    paint_segment(masks[L], pa, pb, w / 2, 1)

# OSM の屋内エリア（indoor=area/corridor）も床に
n_area = 0
for wid, (nds, t) in ways.items():
    if t.get("indoor") not in ("area", "corridor") and not (t.get("highway") == "pedestrian" and t.get("area") == "yes" and t.get("level")):
        continue
    lv = parse_levels(t.get("level"))
    if not lv or len(nds) < 4:
        continue
    ring = way_ring(wid)
    if not ring or not inside_clip(*ring[0], pad=0):
        continue
    for v in set(round(x) for x in lv):
        if v in masks and v != 0:
            paint_polygon(masks[v], ring, 1)
            n_area += 1

# ホームの範囲は「開いた空間」(2)。床・壁は作らずホームの台を別に描く
for p in out_plats:
    L = round(p["lv"])
    if L in masks:
        ring = [(p["ring"][i], p["ring"][i + 1]) for i in range(0, len(p["ring"]), 2)]
        paint_polygon(masks[L], ring, 2)

# 階段・エスカレーター: 上の階では床に穴(2)、下の階では床(1)
for e in vert_edges:
    a, b, k = out_edges[e * 3], out_edges[e * 3 + 1], out_edges[e * 3 + 2]
    (ax, ay, az), (bx, by, bz) = P3(a), P3(b)
    pa, pb = to_grid(ax, az), to_grid(bx, bz)
    top, bot = (pa, pb) if ay > by else (pb, pa)
    lt, lb_ = (out_lv[a], out_lv[b]) if ay > by else (out_lv[b], out_lv[a])
    Lt, Lb = round(lt), round(lb_)
    half = 1.6 if k != KCODE["esc"] else 1.4
    if Lt in masks and Lt != Lb:
        paint_segment(masks[Lt], top, bot, half, 2, cap=False)
    if Lb in masks:
        paint_segment(masks[Lb], top, bot, half, 1, cap=False, over=[0])

# エレベーター: 各階で扉の前を床に
for e in range(len(out_ekeys)):
    if out_edges[e * 3 + 2] != KCODE["elev"]:
        continue
    for n in (out_edges[e * 3], out_edges[e * 3 + 1]):
        L = round(out_lv[n])
        if L in masks and abs(out_lv[n] - L) < 0.3 and L != 0:
            pt = to_grid(P3(n)[0], P3(n)[2])
            paint_segment(masks[L], pt, pt, 2.2, 1, over=[0])


def rle(arr):
    flat = arr.ravel()
    change = np.flatnonzero(np.diff(flat)) + 1
    starts = np.concatenate([[0], change])
    lens = np.diff(np.concatenate([starts, [flat.size]]))
    out = []
    for st, ln in zip(starts.tolist(), lens.tolist()):
        out += [int(flat[st]), ln]
    return out


grid_out = dict(theta=round(THETA, 6), res=RES, u0=U0, v0=V0, w=GW, h=GH, levels=[])
for L in levels:
    m = masks[L]
    if not m.any():
        continue
    ys, xs = np.nonzero(m)
    j0, j1, i0, i1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    grid_out["levels"].append(dict(lv=L, i0=i0, j0=j0, w=i1 - i0, h=j1 - j0, rle=rle(m[j0:j1, i0:i1])))

# ------------------------------------------------------------------ 案内サイン（ホームへの階段の上に「○番線」）
plat_of_node = {}
for pi, p in enumerate(out_plats):
    for n in p["nodes"]:
        plat_of_node[n] = pi
adj_out = defaultdict(list)
for e in range(len(out_ekeys)):
    a, b, k = out_edges[e * 3], out_edges[e * 3 + 1], out_edges[e * 3 + 2]
    adj_out[a].append((b, k))
    adj_out[b].append((a, k))
signs = []
seen_sign = set()
for pi, p in enumerate(out_plats):
    near = set()
    for s0 in p["nodes"]:
        for v, k in adj_out[s0]:
            if k == KCODE["plat"] and v not in plat_of_node:
                near.add(v)
    for s0 in near:
        for v, k in adj_out[s0]:
            if k not in (KCODE["stairs"], KCODE["esc"], KCODE["elev"]):
                continue
            # 縦方向の辺をたどって、別の階に着いたところ
            prev, cur, steps = s0, v, 0
            while steps < 60:
                nxt = [(w, kk) for w, kk in adj_out[cur] if w != prev and kk == k]
                if not nxt or abs(out_lv[cur] - round(out_lv[cur])) < 0.05 and round(out_lv[cur]) != round(out_lv[s0]):
                    break
                prev, cur = cur, nxt[0][0]
                steps += 1
            if round(out_lv[cur]) == round(out_lv[s0]):
                continue
            key = (pi, round(P3(cur)[0] / 4), round(P3(cur)[2] / 4), round(out_lv[cur]))
            if key in seen_sign:
                continue
            seen_sign.add(key)
            ax, ay, az = P3(cur)
            bx, by, bz = P3(prev)
            signs.append(dict(x=round(ax, 1), y=round(ay, 2), z=round(az, 1), dx=round(bx - ax, 2), dz=round(bz - az, 2),
                              plat=pi, kind="plat"))

# 目印になる建物の名前
LANDMARK = re.compile(C.LANDMARK_RE)
for wid, (nds, t) in ways.items():
    nm = t.get("name", "")
    if not nm or not t.get("building") or not LANDMARK.search(nm):
        continue
    r = way_ring(wid)
    if len(r) < 4:
        continue
    cx = sum(p[0] for p in r) / len(r); cz = sum(p[1] for p in r) / len(r)
    if not inside_clip(cx, cz):
        continue
    for b in buildings:
        if abs(b["r"][0] - round(r[0][0], 1)) < 0.2 and abs(b["r"][1] - round(r[0][1], 1)) < 0.2:
            b["name"] = nm.split(";")[0]
            break

out = dict(
    meta=dict(title="新宿駅", origin=list(C.ORIGIN),
              osm_timestamp=(ROOT / "data/raw/timestamp.txt").read_text().strip()
              if (ROOT / "data/raw/timestamp.txt").exists() else ""),
    levels=[dict(lv=l, y=C.level_height(l), name=C.level_name(l)) for l in levels],
    ops=[dict(key=k, name=n, bit=b) for k, n, b in C.OPS],
    nodes=out_nodes, nodeLv=out_lv, zone=out_zone, edges=out_edges, cost=out_cost,
    gates=out_gates, plats=out_plats, lines=out_lines,
    exits=[dict(key=e["key"], name=e["name"], sub=e["sub"], n=remap[e["n"]]) for e in exits if e["n"] in remap],
    presets=[list(p) for p in C.PRESETS],
    buildings=buildings, roads=roads, rails=rails, shops=shops,
    ename=out_ename, ein=out_ein, names=names_list, grid=grid_out, signs=signs,
)
dst = ROOT / "data/station.json"
dst.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
print(f"wrote {dst} ({dst.stat().st_size // 1024} KB): nodes={len(used)} edges={len(out_edges) // 3} "
      f"plats={len(out_plats)} lines={len(out_lines)} gates={len(out_gates)} buildings={len(buildings)}")

if "--dump" in sys.argv:
    import pickle
    pickle.dump(dict(vnodes=vnodes, edges=edges, gate_v=gate_v, plats=plats, keep=keep, osm_of=osm_of, gates=gates),
                open(sys.argv[sys.argv.index("--dump") + 1], "wb"))

if "--debug" in sys.argv:
    (ROOT / "data/debug_osm.json").write_text(json.dumps([osm_of[o] for o in used]))
