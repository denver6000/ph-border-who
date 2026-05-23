import json
import re
from pathlib import Path

import geopandas as gpd
import osmnx as ox
import requests
from shapely import MultiPoint
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union, voronoi_diagram

ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = ROOT / "barangay_map_search (5).html"
PSGC_API_BASE_URL = "https://psgc.gitlab.io/api"

ox.settings.use_cache = True
ox.settings.requests_timeout = 120
ox.settings.http_user_agent = "CityBaranggay OSMnx barangay comparison"
ox.settings.overpass_url = "https://overpass.kumi.systems/api"


def normalize_name(value: str) -> str:
    value = value.lower()
    value = re.sub(r"\b(\d+)st\b", r"\1", value)
    value = re.sub(r"\b(\d+)nd\b", r"\1", value)
    value = re.sub(r"\b(\d+)rd\b", r"\1", value)
    value = re.sub(r"\b(\d+)th\b", r"\1", value)
    value = re.sub(r"\bist\b", "1", value)
    value = re.sub(r"\bii\b", "2", value)
    value = re.sub(r"\biii\b", "3", value)
    value = re.sub(r"\biv\b", "4", value)
    value = re.sub(r"\bpob\b", "poblacion", value)
    value = re.sub(r"\bsr\b", "senior", value)
    value = re.sub(r"[^a-z0-9]+", "", value)
    return value.replace("poblacion", "")


def compact_psgc_name(value: str) -> str:
    return normalize_name(value)


def match_score(official_name: str, osm_name: str) -> int:
    official = compact_psgc_name(official_name)
    osm = compact_psgc_name(osm_name)

    if not official or not osm:
        return 0

    if official == osm:
        return 4

    if official in osm or osm in official:
        return 3

    return 0


def load_html_barangays(city: str):
    html = HTML_PATH.read_text(encoding="utf-8")
    match = re.search(r"<script>var BDATA=(.*?);var COLORS=", html, re.S)

    if not match:
        raise RuntimeError("Could not find BDATA in HTML file.")

    data = json.loads(match.group(1))
    return [entry for entry in data.values() if entry["city"] == city]


def html_entry_to_polygon(entry):
    ring = [(point["lng"], point["lat"]) for point in entry["coords"]]

    if ring[0] != ring[-1]:
        ring.append(ring[0])

    return Polygon(ring)


def fetch_psgc_barangays(city_code: str):
    response = requests.get(f"{PSGC_API_BASE_URL}/cities-municipalities/{city_code}/barangays/", timeout=60)
    response.raise_for_status()
    return response.json()


def extract_place_points(city_geometry):
    features = ox.features_from_polygon(city_geometry, tags={"place": True})
    points = []
    excluded = {"city", "country", "island", "municipality", "province", "region", "state", "town"}

    for _, row in features.iterrows():
        name = row.get("name")
        place = row.get("place")

        if not isinstance(name, str) or place in excluded:
            continue

        geom = row.geometry
        point = geom if geom.geom_type == "Point" else geom.representative_point()

        if not city_geometry.contains(point):
            continue

        points.append(
            {
                "name": name,
                "place": place,
                "point": point,
            }
        )

    return points


def match_official_to_osm_points(barangays, points):
    used = set()
    matched = []
    unmatched = []

    for barangay in barangays:
        candidates = []

        for index, point in enumerate(points):
            if index in used:
                continue

            score = match_score(barangay["name"], point["name"])

            if score:
                candidates.append((score, point["name"], index, point))

        if not candidates:
            unmatched.append(barangay["name"])
            continue

        _, _, index, point = sorted(candidates, key=lambda item: (-item[0], item[1]))[0]
        used.add(index)
        matched.append(
            {
                "name": barangay["name"],
                "psgc": barangay["code"],
                "point": point["point"],
                "osm_name": point["name"],
            }
        )

    return matched, unmatched


def estimate_voronoi(city_geometry, seeds):
    points = MultiPoint([seed["point"] for seed in seeds])
    diagram = voronoi_diagram(points, envelope=city_geometry.envelope, edges=False)
    polygons = []

    for seed in seeds:
        nearest_cell = min(diagram.geoms, key=lambda cell: seed["point"].distance(cell.representative_point()))
        clipped = nearest_cell.intersection(city_geometry)

        if not clipped.is_empty:
            polygons.append({**seed, "geometry": clipped})

    return polygons


def compare_to_html(estimated, html_entries):
    html_by_name = {normalize_name(entry["name"]): entry for entry in html_entries}
    rows = []

    for item in estimated:
        html_entry = html_by_name.get(normalize_name(item["name"]))

        if not html_entry:
            rows.append({"name": item["name"], "matched": False})
            continue

        ours = item["geometry"]
        theirs = html_entry_to_polygon(html_entry)
        intersection_area = ours.intersection(theirs).area
        union_area = ours.union(theirs).area

        rows.append(
            {
                "name": item["name"],
                "matched": True,
                "iou": intersection_area / union_area if union_area else 0,
                "html_covered_by_ours": intersection_area / theirs.area if theirs.area else 0,
                "ours_covered_by_html": intersection_area / ours.area if ours.area else 0,
                "ours_vertices": len(getattr(ours.exterior, "coords", [])) if ours.geom_type == "Polygon" else None,
                "html_vertices": len(html_entry["coords"]),
            }
        )

    return rows


def summarize(rows):
    matched = [row for row in rows if row.get("matched")]
    ious = sorted(row["iou"] for row in matched)

    def avg(key):
        return sum(row[key] for row in matched) / max(len(matched), 1)

    return {
        "matched_names": len(matched),
        "average_iou": avg("iou"),
        "median_iou": ious[len(ious) // 2] if ious else 0,
        "average_html_covered_by_ours": avg("html_covered_by_ours"),
        "average_ours_covered_by_html": avg("ours_covered_by_html"),
        "worst_rows": sorted(matched, key=lambda row: row["iou"])[:10],
    }


def main():
    city_name = "San Jose City"
    city_code = "034926000"
    html_entries = load_html_barangays(city_name)
    city_gdf = ox.geocode_to_gdf({"city": "San Jose", "state": "Nueva Ecija", "country": "Philippines"})
    city_geometry = unary_union(city_gdf.geometry)
    place_points = extract_place_points(city_geometry)
    barangays = fetch_psgc_barangays(city_code)
    matched, unmatched = match_official_to_osm_points(barangays, place_points)
    estimated = estimate_voronoi(city_geometry, matched)
    rows = compare_to_html(estimated, html_entries)

    print(
        json.dumps(
            {
                "city_osm_id": str(city_gdf.iloc[0].get("osm_id")),
                "city_geometry_type": city_geometry.geom_type,
                "html_count": len(html_entries),
                "psgc_count": len(barangays),
                "osm_place_points": len(place_points),
                "matched_seed_count": len(matched),
                "unmatched_psgc": unmatched,
                "summary": summarize(rows),
            },
            indent=2,
            default=str,
        )
    )


if __name__ == "__main__":
    main()
