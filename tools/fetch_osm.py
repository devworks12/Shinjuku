#!/usr/bin/env python3
"""新宿駅周辺の OpenStreetMap データを Overpass API から取得して data/raw/ に保存する。

GitHub Actions（.github/workflows/fetch-osm.yml）から実行する想定。
ローカルでも `python3 tools/fetch_osm.py` で動く。
"""
import gzip
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# 新宿駅（JR・小田急・京王・メトロ・都営）＋西武新宿・新宿三丁目・新宿西口をカバー
BBOX = (35.6845, 139.6935, 35.6975, 139.7085)  # south, west, north, east

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

S, W, N, E = BBOX
B = f"{S},{W},{N},{E}"

# 歩行ネットワーク・ホーム・改札・建物・店舗など、駅模型に必要なもの
FEATURES = f"""
[out:json][timeout:300][maxsize:536870912];
(
  nwr["railway"]({B});
  nwr["public_transport"]({B});
  nwr["highway"]({B});
  nwr["indoor"]({B});
  nwr["level"]({B});
  nwr["level:ref"]({B});
  nwr["barrier"]({B});
  nwr["entrance"]({B});
  nwr["door"]({B});
  nwr["building"]({B});
  nwr["building:part"]({B});
  nwr["shop"]({B});
  nwr["amenity"]({B});
  nwr["tunnel"]({B});
  nwr["man_made"]({B});
  nwr["conveying"]({B});
  nwr["area:highway"]({B});
);
out body geom qt;
"""

# 路線（route relation）と駅のまとまり（stop_area）。メンバーだけ（ジオメトリなし）
ROUTES = f"""
[out:json][timeout:300];
(
  nwr["railway"~"platform|stop|station|halt"]({B});
  nwr["public_transport"~"platform|stop_position|station"]({B});
)->.p;
(
  rel(bn.p)["type"="route"];
  rel(bw.p)["type"="route"];
  rel(br.p)["type"="route"];
  rel(bn.p)["public_transport"="stop_area"];
  rel(bw.p)["public_transport"="stop_area"];
)->.r;
(.r; rel(br.r)["public_transport"="stop_area_group"];);
out body;
"""


def run(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(3):
        for ep in ENDPOINTS:
            try:
                print(f"POST {ep} (attempt {attempt + 1})", flush=True)
                req = urllib.request.Request(
                    ep, data=body,
                    headers={"User-Agent": "shinjuku-norikae-3d/1.0 (github.com/devworks12/Shinjuku)"},
                )
                with urllib.request.urlopen(req, timeout=400) as r:
                    data = json.loads(r.read().decode("utf-8"))
                print(f"  -> {len(data.get('elements', []))} elements", flush=True)
                return data
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  failed: {e}", flush=True)
                time.sleep(10)
    raise SystemExit(f"Overpass query failed: {last}")


def save(name: str, data: dict) -> None:
    out = Path(__file__).resolve().parent.parent / "data" / "raw" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    with gzip.open(out, "wb", compresslevel=9, mtime=0) as f:
        f.write(raw)
    print(f"wrote {out} ({out.stat().st_size} bytes gz, {len(raw)} raw)")


def main() -> None:
    save("osm_features.json.gz", run(FEATURES))
    time.sleep(5)
    save("osm_routes.json.gz", run(ROUTES))
    meta = {"bbox": BBOX, "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (Path(__file__).resolve().parent.parent / "data" / "raw" / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    sys.exit(main())
