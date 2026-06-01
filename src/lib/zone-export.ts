import { resolveNonOverlappingBoundaryCollections } from "@/lib/non-overlapping-city-boundaries";
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

type ZoneExportPayload = {
  data: {
    zones: {
      current_page: number;
      data: ExportZone[];
      next_page_url: null;
      path: string;
      per_page: number;
      prev_page_url: null;
      to: number;
      total: number;
    };
  };
  message: string[];
  remark: "zone";
  status: "success";
};

type ExportFormat = "json" | "sql";

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

function toZoneCoordinates(geometry: BoundaryFeatureCollection["features"][number]["geometry"]) {
  return largestOuterRing(geometry)
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

  return buildZonesPayload(zones, path);
}

function buildZonesPayload(zones: ExportZone[], path: string): ZoneExportPayload {
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

function escapeSqlString(value: string) {
  return value.replace(/'/g, "''");
}

function buildZonesInsertSql(zones: ExportZone[]) {
  if (!zones.length) {
    return [
      "-- No zones to export.",
      "INSERT INTO zones (name, country, coordinates, status, created_at, updated_at) VALUES",
      "-- Add at least one zone before running this script.",
      ";",
    ].join("\n");
  }

  const rows = zones.map((zone) => {
    const coordinates = JSON.stringify(zone.coordinates);

    return `('${escapeSqlString(zone.name)}', '${escapeSqlString(zone.country)}', '${escapeSqlString(coordinates)}', ${zone.status}, NOW(), NOW())`;
  });

  return [
    "INSERT INTO zones (name, country, coordinates, status, created_at, updated_at) VALUES",
    `${rows.join(",\n")};`,
  ].join("\n");
}

function buildCityZoneRecord(boundaries: BoundaryFeatureCollection) {
  const country = boundaries.metadata.country === "Philippines" ? "PH" : boundaries.metadata.country;
  const primaryFeature = boundaries.features[0];

  if (!primaryFeature) {
    return null;
  }

  return buildZoneRecord({
    country,
    feature: primaryFeature,
    name: formatCityZoneName(boundaries.metadata.city, boundaries.metadata.province),
  });
}

export function buildCityZoneExportPayload(boundaries: BoundaryFeatureCollection, path: string) {
  const cityZone = buildCityZoneRecord(boundaries);

  if (!cityZone) {
    return buildZonesPayload([], path);
  }

  return buildZonesPayload([cityZone], path);
}

export function buildMultiCityZoneExportPayload(boundariesList: BoundaryFeatureCollection[], path: string) {
  const zones = resolveNonOverlappingBoundaryCollections(boundariesList)
    .map((boundaries) => buildCityZoneRecord(boundaries))
    .filter((zone): zone is ExportZone => Boolean(zone));

  return buildZonesPayload(zones, path);
}

export function buildCityZoneExportSql(boundaries: BoundaryFeatureCollection) {
  const cityZone = buildCityZoneRecord(boundaries);

  return buildZonesInsertSql(cityZone ? [cityZone] : []);
}

export function buildMultiCityZoneExportSql(boundariesList: BoundaryFeatureCollection[]) {
  const zones = resolveNonOverlappingBoundaryCollections(boundariesList)
    .map((boundaries) => buildCityZoneRecord(boundaries))
    .filter((zone): zone is ExportZone => Boolean(zone));

  return buildZonesInsertSql(zones);
}

export type { ExportFormat };
