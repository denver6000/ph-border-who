import * as turf from "@turf/turf";
import type { Feature, Polygon, MultiPolygon } from "geojson";

import type { BoundaryFeatureCollection } from "@/lib/overpass";

type ZoneCoordinate = {
  lang: number;
  lat: number;
};

type ExportZone = {
  coordinates: ZoneCoordinate[];
  country: string;
  id: number;
  name: string;
  status: 1;
};

const MAX_COORDINATE_POINTS = 24;
const SIMPLIFY_TOLERANCE = 0.0006;

function normalizePrefix(name: string) {
  return name.replace(/^\s*(barangay|brgy\.?|bgy\.?)\s*/i, "").trim();
}

function formatZoneName(barangay: string, city: string, province?: string) {
  const base = `Brgy. ${normalizePrefix(barangay)}`;
  const parts = [base, city.trim(), province?.trim()].filter((value): value is string => Boolean(value));

  return parts.join(", ");
}

function formatCityZoneName(city: string, province?: string) {
  return [city.trim(), province?.trim()].filter((value): value is string => Boolean(value)).join(", ");
}

function signedRingArea(ring: number[][]) {
  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    area += x1 * y2 - x2 * y1;
  }

  return area / 2;
}

function largestOuterRing(geometry: BoundaryFeatureCollection["features"][number]["geometry"]) {
  const polygonRings = geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map((polygon) => polygon[0]);

  return polygonRings.sort((left, right) => Math.abs(signedRingArea(right)) - Math.abs(signedRingArea(left)))[0] ?? [];
}

function decimateRing(ring: number[][]) {
  if (ring.length <= MAX_COORDINATE_POINTS) {
    return ring;
  }

  const step = Math.max(1, Math.ceil((ring.length - 1) / (MAX_COORDINATE_POINTS - 1)));
  const reduced = ring.filter((_, index) => index === 0 || index === ring.length - 1 || index % step === 0);
  const last = reduced[reduced.length - 1];
  const first = reduced[0];

  if (!last || !first) {
    return ring;
  }

  if (last[0] !== first[0] || last[1] !== first[1]) {
    reduced.push([first[0], first[1]]);
  }

  const trimmed = reduced.slice(0, MAX_COORDINATE_POINTS - 1);
  const trimmedFirst = trimmed[0];
  const trimmedLast = trimmed[trimmed.length - 1];

  if (!trimmedFirst || !trimmedLast) {
    return ring;
  }

  if (trimmedLast[0] !== trimmedFirst[0] || trimmedLast[1] !== trimmedFirst[1]) {
    trimmed.push([trimmedFirst[0], trimmedFirst[1]]);
  }

  return trimmed;
}

function simplifyFeatureRing(geometry: BoundaryFeatureCollection["features"][number]["geometry"]) {
  const feature = turf.feature(geometry as Polygon | MultiPolygon) as Feature<Polygon | MultiPolygon>;
  const simplified = turf.simplify(feature, {
    highQuality: false,
    mutate: false,
    tolerance: SIMPLIFY_TOLERANCE,
  });

  return decimateRing(largestOuterRing(simplified.geometry as BoundaryFeatureCollection["features"][number]["geometry"]));
}

function toZoneCoordinates(geometry: BoundaryFeatureCollection["features"][number]["geometry"]) {
  return simplifyFeatureRing(geometry)
    .map(([lang, lat]) => ({
      lang,
      lat,
    }))
    .filter((point, index, array) => {
      if (index === 0) {
        return true;
      }

      const previous = array[index - 1];
      return previous.lat !== point.lat || previous.lang !== point.lang;
    });
}

function buildZoneRecord({
  country,
  feature,
  name,
}: {
  country: string;
  feature: BoundaryFeatureCollection["features"][number];
  name: string;
}): ExportZone {
  return {
    coordinates: toZoneCoordinates(feature.geometry),
    country,
    id: feature.properties.id,
    name,
    status: 1,
  };
}

export function buildZoneExportPayload(boundaries: BoundaryFeatureCollection, path: string) {
  const city = boundaries.metadata.city;
  const province = boundaries.metadata.province;
  const country = boundaries.metadata.country === "Philippines" ? "PH" : boundaries.metadata.country;
  const zones: ExportZone[] = boundaries.features.map((feature) =>
    buildZoneRecord({
      country,
      feature,
      name: formatZoneName(feature.properties.name, city, province),
    }),
  );

  return {
    data: {
      zones: {
        current_page: 1,
        data: zones,
        next_page_url: null,
        path,
        per_page: zones.length,
        prev_page_url: null,
        to: zones.length,
        total: zones.length,
      },
    },
    message: ["Zones"],
    remark: "zone",
    status: "success",
  };
}

export function buildCityZoneExportPayload(boundaries: BoundaryFeatureCollection, path: string) {
  const country = boundaries.metadata.country === "Philippines" ? "PH" : boundaries.metadata.country;
  const primaryFeature = boundaries.features[0];

  if (!primaryFeature) {
    return buildZoneExportPayload(
      {
        ...boundaries,
        features: [],
      },
      path,
    );
  }

  const zones: ExportZone[] = [
    buildZoneRecord({
      country,
      feature: primaryFeature,
      name: formatCityZoneName(boundaries.metadata.city, boundaries.metadata.province),
    }),
  ];

  return {
    data: {
      zones: {
        current_page: 1,
        data: zones,
        next_page_url: null,
        path,
        per_page: zones.length,
        prev_page_url: null,
        to: zones.length,
        total: zones.length,
      },
    },
    message: ["Zones"],
    remark: "zone",
    status: "success",
  };
}
