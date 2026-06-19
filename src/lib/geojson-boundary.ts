import { promises as fs } from "node:fs";
import path from "node:path";

import type { BoundaryFeature, BoundaryFeatureCollection, GeoJsonMultiPolygon, GeoJsonPolygon } from "@/lib/boundary-types";

type JsonObject = Record<string, unknown>;

export type GeoJsonBoundaryRequest = {
  city?: string;
  country?: string;
  fallbackPsgc?: string;
  geojson?: unknown;
  name?: string;
  province?: string;
  sourceUrl?: string;
  url?: string;
};

export class GeoJsonBoundaryError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GeoJsonBoundaryError";
    this.status = status;
  }
}

const MAX_REMOTE_GEOJSON_BYTES = 10 * 1024 * 1024;

type ResolvedGeoJsonPayload = {
  dataset?: BoundaryFeatureCollection["metadata"]["dataset"];
  geojson: unknown;
  source: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(properties: JsonObject, ...keys: string[]) {
  const entries = Object.entries(properties);

  for (const key of keys) {
    const match = entries.find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    const value = match?.[1];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function pickNumber(properties: JsonObject, ...keys: string[]) {
  const rawValue = pickString(properties, ...keys);

  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeCountry(value: string | undefined) {
  if (!value) {
    return "Philippines";
  }

  return /^philippines(?:\s+\(the\))?$/i.test(value.trim()) ? "Philippines" : value.trim();
}

function withoutBarangayPrefix(value: string) {
  return value.replace(/^\s*(barangay|brgy\.?|bgy\.?)\s*/i, "").trim();
}

function withBarangayPrefix(value: string) {
  const cleaned = withoutBarangayPrefix(value);
  return cleaned ? `Brgy. ${cleaned}` : value.trim();
}

function uniqueParts(parts: Array<string | undefined>) {
  const seen = new Set<string>();
  const output: string[] = [];

  parts.forEach((part) => {
    const cleaned = part?.trim();

    if (!cleaned) {
      return;
    }

    const key = cleaned.toLowerCase();

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(cleaned);
  });

  return output;
}

function buildFeatureName(properties: JsonObject, index: number, totalFeatures: number, inputName?: string) {
  if (inputName?.trim() && totalFeatures === 1) {
    return inputName.trim();
  }

  const barangayName = pickString(properties, "brgy_name", "barangay_name", "barangay", "ADM4_EN", "adm4_en");
  const cityName = pickString(properties, "city_name", "municipal_name", "mun_name", "ADM3_EN", "adm3_en");
  const provinceName = pickString(properties, "prov_name", "province_name", "ADM2_EN", "adm2_en");

  if (barangayName) {
    return uniqueParts([withBarangayPrefix(barangayName), cityName, provinceName]).join(", ");
  }

  return (
    pickString(properties, "name", "NAME", "Name", "label", "title") ??
    (inputName?.trim() ? `${inputName.trim()} ${index + 1}` : `GeoJSON feature ${index + 1}`)
  );
}

function parseRemoteUrl(rawUrl: string) {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GeoJsonBoundaryError("GeoJSON URL is not a valid URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new GeoJsonBoundaryError("GeoJSON URL must use http or https.");
  }

  if (/^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?)$/i.test(parsed.hostname)) {
    throw new GeoJsonBoundaryError("GeoJSON URL cannot target a local host.");
  }

  return parsed;
}

async function readRemoteGeoJson(rawUrl: string) {
  const url = parseRemoteUrl(rawUrl);
  const response = await fetch(url, {
    headers: {
      Accept: "application/geo+json, application/json, text/plain;q=0.8, */*;q=0.5",
      "User-Agent": "CityBaranggay GeoJSON boundary loader",
    },
  });

  const contentLength = Number(response.headers.get("content-length") ?? "0");

  if (contentLength > MAX_REMOTE_GEOJSON_BYTES) {
    throw new GeoJsonBoundaryError("GeoJSON response is too large.", 413);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new GeoJsonBoundaryError(`GeoJSON URL returned HTTP ${response.status}.`, 502);
  }

  if (text.length > MAX_REMOTE_GEOJSON_BYTES) {
    throw new GeoJsonBoundaryError("GeoJSON response is too large.", 413);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GeoJsonBoundaryError("GeoJSON URL did not return valid JSON.", 502);
  }
}

function normalizePsgcCode(value: string | undefined) {
  const digits = value?.replace(/^PH/i, "").replace(/\D/g, "") ?? "";

  return digits.length === 10 ? digits : null;
}

async function readLocalHdxFallback(psgcCode: string): Promise<ResolvedGeoJsonPayload | null> {
  const normalizedPsgc = normalizePsgcCode(psgcCode);

  if (!normalizedPsgc) {
    return null;
  }

  const adm3Code = `PH${normalizedPsgc.slice(0, 7)}`;
  const adm4Code = `PH${normalizedPsgc}`;
  const filePath = path.join(process.cwd(), "data", "hdx", "cod-ab-phl", "adm4", `${adm3Code}.ndjson`);

  let rawFile: string;

  try {
    rawFile = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const line = rawFile.split(/\r?\n/).find((entry) => entry.includes(`"ADM4_PCODE":"${adm4Code}"`));

  if (!line) {
    return null;
  }

  try {
    return {
      dataset: {
        attribution: "National Mapping and Resource Information Authority (NAMRIA), Philippine Statistics Authority (PSA), OCHA COD-AB",
        caveat: "Fallback boundary from the local HDX/COD-AB cache because the remote GeoJSON URL could not be fetched.",
        name: "HDX/OCHA Philippines COD-AB ADM4 fallback",
      },
      geojson: {
        features: [JSON.parse(line) as unknown],
        type: "FeatureCollection",
      },
      source: `Local HDX/COD-AB fallback for ${adm4Code}`,
    };
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GeoJsonBoundaryError(`${label} must be a finite number.`);
  }

  return value;
}

function normalizePosition(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new GeoJsonBoundaryError(`${label} must be a coordinate pair.`);
  }

  return [finiteNumber(value[0], `${label} longitude`), finiteNumber(value[1], `${label} latitude`)];
}

function samePosition(left: [number, number], right: [number, number]) {
  return left[0] === right[0] && left[1] === right[1];
}

function normalizeRing(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new GeoJsonBoundaryError(`${label} must be a linear ring.`);
  }

  const ring = value.map((point, index) => normalizePosition(point, `${label}[${index}]`));

  if (ring.length < 3) {
    throw new GeoJsonBoundaryError(`${label} must have at least three points.`);
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (!samePosition(first, last)) {
    ring.push([first[0], first[1]]);
  }

  if (ring.length < 4) {
    throw new GeoJsonBoundaryError(`${label} must have at least four closed-ring points.`);
  }

  return ring;
}

function normalizePolygonCoordinates(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new GeoJsonBoundaryError(`${label} must be a Polygon coordinate array.`);
  }

  const rings = value.map((ring, index) => normalizeRing(ring, `${label}[${index}]`));

  if (!rings.length) {
    throw new GeoJsonBoundaryError(`${label} must include an outer ring.`);
  }

  return rings;
}

function normalizeGeometry(value: unknown, label: string): GeoJsonPolygon | GeoJsonMultiPolygon {
  if (!isObject(value)) {
    throw new GeoJsonBoundaryError(`${label} must be a GeoJSON geometry.`);
  }

  if (value.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: normalizePolygonCoordinates(value.coordinates, `${label}.coordinates`),
    };
  }

  if (value.type === "MultiPolygon") {
    if (!Array.isArray(value.coordinates)) {
      throw new GeoJsonBoundaryError(`${label}.coordinates must be a MultiPolygon coordinate array.`);
    }

    const polygons = value.coordinates.map((polygon, index) => normalizePolygonCoordinates(polygon, `${label}.coordinates[${index}]`));

    if (!polygons.length) {
      throw new GeoJsonBoundaryError(`${label} must include at least one polygon.`);
    }

    return {
      type: "MultiPolygon",
      coordinates: polygons,
    };
  }

  throw new GeoJsonBoundaryError(`${label} must be a Polygon or MultiPolygon.`);
}

function extractGeoJsonFeatures(geojson: unknown): JsonObject[] {
  if (!isObject(geojson)) {
    throw new GeoJsonBoundaryError("GeoJSON payload must be an object.");
  }

  if (geojson.type === "FeatureCollection") {
    if (!Array.isArray(geojson.features)) {
      throw new GeoJsonBoundaryError("FeatureCollection.features must be an array.");
    }

    return geojson.features.filter(isObject);
  }

  if (geojson.type === "Feature") {
    return [geojson];
  }

  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
    return [
      {
        geometry: geojson,
        properties: {},
        type: "Feature",
      },
    ];
  }

  throw new GeoJsonBoundaryError("GeoJSON payload must be a FeatureCollection, Feature, Polygon, or MultiPolygon.");
}

function metadataFromFirstFeature(properties: JsonObject, input: GeoJsonBoundaryRequest, fallbackName: string, source: string) {
  const city = input.city?.trim() || pickString(properties, "city_name", "municipal_name", "mun_name", "ADM3_EN", "adm3_en") || fallbackName;
  const province = input.province?.trim() || pickString(properties, "prov_name", "province_name", "ADM2_EN", "adm2_en");
  const country = normalizeCountry(input.country?.trim() || pickString(properties, "country", "country_name", "ADM0_EN", "adm0_en"));

  return {
    city,
    country,
    province,
    source,
  };
}

function featureToBoundaryFeature(feature: JsonObject, index: number, totalFeatures: number, input: GeoJsonBoundaryRequest): BoundaryFeature {
  if (feature.type !== "Feature") {
    throw new GeoJsonBoundaryError(`Feature ${index + 1} is not a GeoJSON Feature.`);
  }

  const properties = isObject(feature.properties) ? feature.properties : {};
  const geometry = normalizeGeometry(feature.geometry, `features[${index}].geometry`);
  const id = pickNumber(properties, "objectid", "OBJECTID", "id", "ID") ?? index + 1;
  const psgcCode = pickString(properties, "psgc_10d", "psgc", "psgcCode", "ADM4_PCODE", "adm4_pcode", "ADM3_PCODE", "adm3_pcode");

  return {
    type: "Feature",
    geometry,
    properties: {
      boundaryKind: "indicative",
      id,
      name: buildFeatureName(properties, index, totalFeatures, input.name),
      psgcCode,
      sourceType: "geojson",
    },
  };
}

export async function resolveGeoJsonBoundary(input: GeoJsonBoundaryRequest): Promise<BoundaryFeatureCollection> {
  const sourceUrl = input.url?.trim() || input.sourceUrl?.trim() || undefined;
  let resolvedPayload: ResolvedGeoJsonPayload | null = null;

  if (sourceUrl) {
    try {
      resolvedPayload = {
        geojson: await readRemoteGeoJson(sourceUrl),
        source: `GeoJSON URL: ${sourceUrl}`,
      };
    } catch (error) {
      const fallback = input.fallbackPsgc ? await readLocalHdxFallback(input.fallbackPsgc) : null;

      if (!fallback) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "remote URL failed";
      resolvedPayload = {
        ...fallback,
        source: `${fallback.source}; remote URL failed: ${message}`,
      };
    }
  } else if (input.geojson) {
    resolvedPayload = {
      geojson: input.geojson,
      source: "Uploaded GeoJSON",
    };
  }

  if (!resolvedPayload?.geojson) {
    throw new GeoJsonBoundaryError('Missing required "url" or "geojson" payload.');
  }

  const rawFeatures = extractGeoJsonFeatures(resolvedPayload.geojson);

  if (!rawFeatures.length) {
    throw new GeoJsonBoundaryError("GeoJSON payload does not contain any features.");
  }

  const features = rawFeatures.map((feature, index) => featureToBoundaryFeature(feature, index, rawFeatures.length, input));
  const firstProperties = isObject(rawFeatures[0].properties) ? rawFeatures[0].properties : {};
  const metadata = metadataFromFirstFeature(firstProperties, input, features[0]?.properties.name ?? "GeoJSON boundary", resolvedPayload.source);

  return {
    type: "FeatureCollection",
    features,
    metadata: {
      adminLevels: [],
      boundaryMode: "indicative",
      city: metadata.city,
      count: features.length,
      country: metadata.country,
      dataset: {
        attribution: sourceUrl ?? "User supplied GeoJSON",
        caveat: "Imported GeoJSON boundary; verify source authority before production use.",
        name: "GeoJSON boundary import",
        ...(resolvedPayload.dataset ?? {}),
      },
      generatedAt: new Date().toISOString(),
      province: metadata.province,
      source: metadata.source,
    },
  };
}
