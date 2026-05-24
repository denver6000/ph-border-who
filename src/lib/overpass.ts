import {
  estimateBarangayBoundariesWithOfficialSeeds,
  type BoundaryEstimationResult,
  type BoundaryEstimationSeedMode,
} from "@/lib/boundary-estimation";
import type { EstimationPoint, GeoJsonMultiPolygon, GeoJsonPolygon } from "@/lib/estimated-boundaries";

const OVERPASS_API_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_FEATURES = 500;
const EXCLUDED_PLACE_TYPES = new Set(["city", "country", "island", "municipality", "province", "region", "state", "town"]);
const NOMINATIM_LOOKUP_TIMEOUT_MS = 2500;

type OverpassCenter = {
  lat: number;
  lon: number;
};

type OverpassMember = {
  geometry?: OverpassCenter[];
  role: string;
  type: string;
};

type OverpassElement = {
  center?: OverpassCenter;
  geometry?: OverpassCenter[];
  id: number;
  lat?: number;
  lon?: number;
  members?: OverpassMember[];
  tags?: Record<string, string>;
  type: "area" | "node" | "relation" | "way";
};

type OverpassResponse = {
  elements: OverpassElement[];
  generator?: string;
  osm3s?: {
    copyright?: string;
    timestamp_osm_base?: string;
  };
  version?: number;
};

type NominatimAddress = {
  country?: string;
  municipality?: string;
  province?: string;
  region?: string;
  state?: string;
};

type NominatimReverseResponse = {
  address?: NominatimAddress;
  display_name?: string;
};

type CityBoundary = {
  center?: OverpassCenter;
  id: number;
  tags: Record<string, string>;
};

type CityBoundaryFeature = {
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  id: number;
  tags: Record<string, string>;
};

export type CityBoundaryCandidate = {
  adminLevel?: string;
  borderType?: string;
  center?: OverpassCenter;
  id: number;
  locationLabel?: string;
  name: string;
  ref?: string;
  sourceType?: "firestore" | "overpass";
  wikidata?: string;
  wikipedia?: string;
};

export type BoundaryFeature = {
  type: "Feature";
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  properties: {
    adminLevel?: string;
    boundaryKind?: "actual" | "estimated" | "indicative";
    estimatedFromPoint?: [number, number];
    estimationMethod?: "voronoi";
    id: number;
    name: string;
    place?: string;
    psgcCode?: string;
    sourceType: "estimated" | "firestore-hdx-cod-ab" | "hdx-cod-ab" | "relation" | "way";
  };
};

export type BoundaryFeatureCollection = {
  type: "FeatureCollection";
  features: BoundaryFeature[];
  metadata: {
    adminLevels: string[];
    city: string;
    country: string;
    count: number;
    generatedAt: string;
    province?: string;
    source: string;
    boundaryMode: "actual" | "estimated" | "indicative";
    dataset?: {
      attribution: string;
      caveat: string;
      name: string;
    };
    approximation?: {
      method: "voronoi";
      note: string;
      pointCount: number;
      psgcBarangayCount?: number;
      seedMode: BoundaryEstimationSeedMode;
      unmatchedOfficialBarangays?: string[];
    };
    psgcValidation?: {
      droppedCount: number;
      droppedNames?: string[];
      keptCount: number;
      officialCount: number;
      status: "filtered" | "matched" | "unavailable";
    };
    cityBoundary?: {
      adminLevel?: string;
      borderType?: string;
      id: number;
      name?: string;
    };
  };
};

type QueryBarangayBoundariesArgs = {
  adminLevels?: string[];
  city: string;
  country?: string;
  limit?: number;
  province?: string;
};

type QueryBarangayBoundariesByRelationArgs = {
  adminLevels?: string[];
  city?: string;
  country?: string;
  limit?: number;
  locationLabel?: string;
  relationId: number;
};

type QueryCityBoundaryArgs = {
  city: string;
  country?: string;
  province?: string;
};

type QueryCityBoundaryByRelationArgs = {
  city?: string;
  country?: string;
  locationLabel?: string;
  relationId: number;
};

function escapeOverpassString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildAreaSelector(city: string, province?: string, country = "Philippines") {
  const cityName = escapeOverpassString(city);
  const provinceName = province ? escapeOverpassString(province) : undefined;
  const countryName = escapeOverpassString(country);

  return `
    (
      relation["boundary"="administrative"]["name"="${cityName}"]["admin_level"~"6|7|8"]${
        provinceName ? `["is_in:province"="${provinceName}"]` : ""
      };
      relation["boundary"="administrative"]["name"="${cityName}"]["admin_level"~"6|7|8"]${
        provinceName ? `["addr:province"="${provinceName}"]` : ""
      };
      relation["boundary"="administrative"]["name"="${cityName}"]["admin_level"~"6|7|8"]${
        countryName ? `["is_in:country"="${countryName}"]` : ""
      };
      relation["boundary"="administrative"]["name"="${cityName}"]["admin_level"~"6|7|8"];
    );
    map_to_area->.cityArea;
  `;
}

function cityNameVariants(city: string) {
  const withoutCity = city.replace(/\s+City$/i, "").trim();
  return Array.from(new Set([city.trim(), withoutCity, `${withoutCity} City`].filter(Boolean)));
}

function buildCityBoundaryQuery(city: string, province?: string, country = "Philippines") {
  const cityFilters = cityNameVariants(city)
    .flatMap((name) => {
      const escaped = escapeOverpassString(name);
      return [
        `relation(area.searchArea)["boundary"="administrative"]["name"="${escaped}"]["admin_level"~"6|7|8"];`,
        `relation(area.searchArea)["boundary"="administrative"]["alt_name"="${escaped}"]["admin_level"~"6|7|8"];`,
      ];
    })
    .join("\n      ");

  return `
    [out:json][timeout:${DEFAULT_TIMEOUT_SECONDS}];
    area["boundary"="administrative"]["name"="${escapeOverpassString(country)}"]->.countryArea;
    ${
      province
        ? `area(area.countryArea)["boundary"="administrative"]["name"="${escapeOverpassString(province)}"]->.searchArea;`
        : `.countryArea->.searchArea;`
    }
    (
      ${cityFilters}
    );
    out tags center;
  `;
}

function buildBarangayQueryForCityBoundary({
  adminLevels = ["10"],
  limit = DEFAULT_MAX_FEATURES,
  relationId,
}: {
  adminLevels?: string[];
  limit?: number;
  relationId: number;
}) {
  const sanitizedLevels = adminLevels
    .map((level) => level.trim())
    .filter(Boolean)
    .join("|");

  return `
    [out:json][timeout:${DEFAULT_TIMEOUT_SECONDS}];
    relation(${relationId});
    map_to_area->.cityArea;
    (
      relation(area.cityArea)["boundary"="administrative"]["admin_level"~"${sanitizedLevels}"]["border_type"="barangay"]["name"];
      relation(area.cityArea)["boundary"="administrative"]["admin_level"~"${sanitizedLevels}"]["name"];
    );
    out body geom ${limit};
  `;
}

function buildCityBoundaryGeometryQuery(relationId: number) {
  return `
    [out:json][timeout:${DEFAULT_TIMEOUT_SECONDS}];
    relation(${relationId});
    out body geom;
  `;
}

function buildBarangayPlacePointQuery({
  limit = DEFAULT_MAX_FEATURES,
  relationId,
}: {
  limit?: number;
  relationId: number;
}) {
  return `
    [out:json][timeout:${DEFAULT_TIMEOUT_SECONDS}];
    relation(${relationId});
    map_to_area->.cityArea;
    (
      node(area.cityArea)["place"]["name"];
      way(area.cityArea)["place"]["name"];
      relation(area.cityArea)["place"]["name"];
    );
    out tags center ${limit};
  `;
}

function buildBarangayQuery({
  adminLevels = ["10"],
  city,
  country = "Philippines",
  limit = DEFAULT_MAX_FEATURES,
  province,
}: QueryBarangayBoundariesArgs) {
  const sanitizedLevels = adminLevels
    .map((level) => level.trim())
    .filter(Boolean)
    .join("|");

  return `
    [out:json][timeout:${DEFAULT_TIMEOUT_SECONDS}];
    ${buildAreaSelector(city, province, country)}
    (
      relation(area.cityArea)["boundary"="administrative"]["admin_level"~"${sanitizedLevels}"]["border_type"="barangay"]["name"];
    );
    out body geom ${limit};
  `;
}

async function runOverpassQuery(query: string) {
  let lastError: Error | null = null;

  for (const url of OVERPASS_API_URLS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "User-Agent": "CityBaranggay/0.1 (Firebase App Hosting barangay boundary explorer)",
        },
        body: query,
        cache: "no-store",
      });

      if (!response.ok) {
        lastError = new Error(`Overpass request failed at ${url} with status ${response.status}`);
        continue;
      }

      return (await response.json()) as OverpassResponse;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown Overpass request failure");
    }
  }

  throw lastError ?? new Error("Overpass request failed.");
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+city$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

async function findCityBoundary(city: string, province?: string, country?: string): Promise<CityBoundary | null> {
  const candidates = await findCityBoundaryCandidates(city, province, country);

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (province && candidates.length > 1) {
    return candidates.find((candidate) => candidate.tags.border_type === "city") ?? candidates[0];
  }

  return null;
}

async function findCityBoundaryCandidates(city: string, province?: string, country?: string): Promise<CityBoundary[]> {
  const response = await runOverpassQuery(buildCityBoundaryQuery(city, province, country));
  const expected = normalizeName(city);

  return response.elements
    .filter((element) => element.type === "relation" && element.tags)
    .filter((element) => {
      const tags = element.tags!;
      return normalizeName(tags.name ?? "") === expected || normalizeName(tags.alt_name ?? "") === expected;
    })
    .map((element) => ({
      center: element.center,
      id: element.id,
      tags: element.tags!,
    }));
}

function toCityCandidate(boundary: CityBoundary): CityBoundaryCandidate {
  return {
    adminLevel: boundary.tags.admin_level,
    borderType: boundary.tags.border_type,
    center: boundary.center,
    id: boundary.id,
    locationLabel: buildLocationLabel(boundary.tags),
    name: boundary.tags.name ?? `Relation ${boundary.id}`,
    ref: boundary.tags.ref,
    wikidata: boundary.tags.wikidata,
    wikipedia: boundary.tags.wikipedia,
  };
}

function buildLocationLabel(tags: Record<string, string>, address?: NominatimAddress) {
  const parts = [
    tags["is_in:province"],
    tags["addr:province"],
    tags.province,
    tags["is_in:state"],
    tags["addr:state"],
    address?.province,
    address?.state,
    address?.region,
    address?.country,
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(parts)).join(", ") || undefined;
}

async function reverseLookupCandidate(boundary: CityBoundary) {
  const candidate = toCityCandidate(boundary);

  if (!boundary.center || candidate.locationLabel) {
    return candidate;
  }

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(boundary.center.lat));
  url.searchParams.set("lon", String(boundary.center.lon));
  url.searchParams.set("zoom", "10");
  url.searchParams.set("addressdetails", "1");

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(NOMINATIM_LOOKUP_TIMEOUT_MS),
      headers: {
        "User-Agent": "CityBaranggay/0.1 (+city candidate labels)",
      },
    });

    if (!response.ok) {
      return candidate;
    }

    const payload = (await response.json()) as NominatimReverseResponse;

    return {
      ...candidate,
      locationLabel: buildLocationLabel(boundary.tags, payload.address) ?? candidate.locationLabel,
    };
  } catch {
    return candidate;
  }
}

export async function searchCityBoundaries({
  city,
  country,
}: {
  city: string;
  country?: string;
}) {
  const candidates = await findCityBoundaryCandidates(city, undefined, country);
  const enrichedCandidates = await Promise.all(candidates.map(reverseLookupCandidate));

  return enrichedCandidates.sort((left, right) => {
    if (left.name !== right.name) {
      return left.name.localeCompare(right.name);
    }

    return left.id - right.id;
  });
}

function toCoordinateRing(points: OverpassCenter[]) {
  const ring = points.map((point) => [point.lon, point.lat]);
  const first = ring[0];
  const last = ring[ring.length - 1];

  if (!first || !last) {
    return [];
  }

  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  return ring;
}

function toCoordinatePath(points: OverpassCenter[]) {
  return points.map((point) => [point.lon, point.lat]);
}

function coordinatesMatch(left: number[], right: number[]) {
  return left[0] === right[0] && left[1] === right[1];
}

function stitchSegments(segments: number[][][]) {
  const remaining = [...segments];
  const rings: number[][][] = [];

  while (remaining.length) {
    let current = [...remaining.shift()!];
    let extended = true;

    while (extended) {
      extended = false;
      const start = current[0];
      const end = current[current.length - 1];

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const candidateStart = candidate[0];
        const candidateEnd = candidate[candidate.length - 1];

        if (coordinatesMatch(end, candidateStart)) {
          current = [...current, ...candidate.slice(1)];
        } else if (coordinatesMatch(end, candidateEnd)) {
          current = [...current, ...[...candidate].reverse().slice(1)];
        } else if (coordinatesMatch(start, candidateEnd)) {
          current = [...candidate.slice(0, -1), ...current];
        } else if (coordinatesMatch(start, candidateStart)) {
          current = [...[...candidate].reverse().slice(0, -1), ...current];
        } else {
          continue;
        }

        remaining.splice(index, 1);
        extended = true;
        break;
      }
    }

    if (!coordinatesMatch(current[0], current[current.length - 1])) {
      current = [...current, current[0]];
    }

    if (current.length >= 4) {
      rings.push(current);
    }
  }

  return rings;
}

function relationToGeometry(element: OverpassElement): GeoJsonPolygon | GeoJsonMultiPolygon | null {
  if (!element.members?.length) {
    return null;
  }

  const outerSegments = element.members
    .filter((member) => member.role === "outer" && member.geometry?.length)
    .map((member) => toCoordinatePath(member.geometry!))
    .filter((ring) => ring.length >= 2);

  const innerSegments = element.members
    .filter((member) => member.role === "inner" && member.geometry?.length)
    .map((member) => toCoordinatePath(member.geometry!))
    .filter((ring) => ring.length >= 2);

  const outers = stitchSegments(outerSegments);
  const inners = stitchSegments(innerSegments);

  if (!outers.length) {
    return null;
  }

  if (outers.length === 1) {
    return {
      type: "Polygon",
      coordinates: [outers[0], ...inners],
    };
  }

  return {
    type: "MultiPolygon",
    coordinates: outers.map((outer) => [outer]),
  };
}

function wayToGeometry(element: OverpassElement): GeoJsonPolygon | null {
  if (!element.geometry?.length) {
    return null;
  }

  const ring = toCoordinateRing(element.geometry);

  if (ring.length < 4) {
    return null;
  }

  return {
    type: "Polygon",
    coordinates: [ring],
  };
}

function elementToFeature(element: OverpassElement): BoundaryFeature | null {
  const name = element.tags?.name;

  if (!name) {
    return null;
  }

  const geometry =
    element.type === "relation" ? relationToGeometry(element) : element.type === "way" ? wayToGeometry(element) : null;

  if (!geometry) {
    return null;
  }

  const sourceType = element.type === "relation" ? "relation" : "way";

  return {
    type: "Feature",
    geometry,
    properties: {
      adminLevel: element.tags?.admin_level,
      boundaryKind: "actual",
      id: element.id,
      name,
      place: element.tags?.place,
      sourceType,
    },
  };
}

function elementToCityBoundaryFeature(element: OverpassElement): CityBoundaryFeature | null {
  if (element.type !== "relation" || !element.tags) {
    return null;
  }

  const geometry = relationToGeometry(element);

  if (!geometry) {
    return null;
  }

  return {
    geometry,
    id: element.id,
    tags: element.tags,
  };
}

function elementToEstimationPoint(element: OverpassElement): EstimationPoint | null {
  const name = element.tags?.name?.trim();
  const place = element.tags?.place;
  const center = element.center ?? (element.lat !== undefined && element.lon !== undefined ? { lat: element.lat, lon: element.lon } : undefined);

  if (!name || !center || (place && EXCLUDED_PLACE_TYPES.has(place))) {
    return null;
  }

  return {
    coordinates: [center.lon, center.lat],
    id: element.id,
    name,
    place,
  };
}

async function queryCityBoundaryFeature(relationId: number) {
  const response = await runOverpassQuery(buildCityBoundaryGeometryQuery(relationId));

  return (
    response.elements
      .map(elementToCityBoundaryFeature)
      .find((feature): feature is CityBoundaryFeature => feature !== null && feature.id === relationId) ?? null
  );
}

function toCityBoundaryCollection({
  city,
  country = "Philippines",
  feature,
  province,
  source,
}: {
  city: string;
  country?: string;
  feature: CityBoundaryFeature;
  province?: string;
  source: string;
}): BoundaryFeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          adminLevel: feature.tags.admin_level,
          boundaryKind: "actual",
          id: feature.id,
          name: city,
          sourceType: "relation",
        },
      },
    ],
    metadata: {
      adminLevels: [feature.tags.admin_level ?? "6"],
      boundaryMode: "actual",
      city,
      count: 1,
      country,
      generatedAt: new Date().toISOString(),
      province,
      source,
      cityBoundary: {
        adminLevel: feature.tags.admin_level,
        borderType: feature.tags.border_type,
        id: feature.id,
        name: feature.tags.name,
      },
    },
  };
}

async function queryBarangayPlacePoints(relationId: number, limit?: number) {
  const response = await runOverpassQuery(
    buildBarangayPlacePointQuery({
      limit,
      relationId,
    }),
  );

  return response.elements
    .map(elementToEstimationPoint)
    .filter((point): point is EstimationPoint => point !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function queryEstimatedBarangayFeatures({
  city,
  limit,
  locationLabel,
  relationId,
}: {
  city?: string;
  limit?: number;
  locationLabel?: string;
  relationId: number;
}) {
  const [cityBoundary, points] = await Promise.all([queryCityBoundaryFeature(relationId), queryBarangayPlacePoints(relationId, limit)]);

  if (!cityBoundary) {
    return {
      cityBoundary,
      estimation: {
        features: [],
        officialSeeds: null,
        osmPointCount: points.length,
        seedMode: "osm-place-points",
      } satisfies BoundaryEstimationResult,
    };
  }

  return {
    cityBoundary,
    estimation: await estimateBarangayBoundariesWithOfficialSeeds({
      cityGeometry: cityBoundary.geometry,
      cityName: city ?? cityBoundary.tags.name,
      locationLabel,
      osmPoints: points,
    }),
  };
}

export async function queryBarangayBoundaries({
  adminLevels,
  city,
  country,
  limit,
  province,
}: QueryBarangayBoundariesArgs): Promise<BoundaryFeatureCollection> {
  const cityBoundary = await findCityBoundary(city, province, country);
  let actualLookupError: Error | null = null;
  let response: OverpassResponse | null = null;

  try {
    response = cityBoundary
      ? await runOverpassQuery(
          buildBarangayQueryForCityBoundary({
            adminLevels,
            limit,
            relationId: cityBoundary.id,
          }),
        )
      : await runOverpassQuery(
          buildBarangayQuery({
            adminLevels,
            city,
            country,
            limit,
            province,
          }),
        );
  } catch (error) {
    actualLookupError = error instanceof Error ? error : new Error("Unknown Overpass request failure");
  }

  const features =
    response?.elements
      .map(elementToFeature)
      .filter((feature): feature is BoundaryFeature => feature !== null)
      .sort((left, right) => left.properties.name.localeCompare(right.properties.name)) ?? [];
  const estimatedResult = !features.length && cityBoundary ? await queryEstimatedBarangayFeatures({ city, limit, locationLabel: province, relationId: cityBoundary.id }) : null;
  const resultFeatures: BoundaryFeature[] = features.length ? features : (estimatedResult?.estimation.features ?? []);
  const isEstimated = !features.length && resultFeatures.length > 0;

  if (!resultFeatures.length && actualLookupError) {
    throw actualLookupError;
  }

  return {
    type: "FeatureCollection",
    features: resultFeatures,
    metadata: {
      adminLevels: adminLevels ?? ["10"],
      city,
      country: country ?? "Philippines",
      count: resultFeatures.length,
      generatedAt: new Date().toISOString(),
      province,
      source: OVERPASS_API_URLS.join(", "),
      boundaryMode: isEstimated ? "estimated" : "actual",
      approximation: isEstimated
        ? {
            method: "voronoi",
            note: "Estimated polygons were generated from OSM place points clipped to the selected city boundary. They are not official barangay boundaries.",
            pointCount: estimatedResult?.estimation.osmPointCount ?? 0,
            psgcBarangayCount: estimatedResult?.estimation.officialSeeds?.barangays.length,
            seedMode: estimatedResult?.estimation.seedMode ?? "osm-place-points",
            unmatchedOfficialBarangays: estimatedResult?.estimation.officialSeeds?.unmatchedBarangays.map((barangay) => barangay.name),
          }
        : undefined,
      cityBoundary: cityBoundary
        ? {
            adminLevel: cityBoundary.tags.admin_level,
            borderType: cityBoundary.tags.border_type,
            id: cityBoundary.id,
            name: cityBoundary.tags.name,
          }
        : undefined,
    },
  };
}

export async function queryCityBoundaryBySearch({
  city,
  country,
  province,
}: QueryCityBoundaryArgs): Promise<BoundaryFeatureCollection> {
  const boundary = await findCityBoundary(city, province, country);

  if (!boundary) {
    return {
      type: "FeatureCollection",
      features: [],
      metadata: {
        adminLevels: ["6", "7", "8"],
        boundaryMode: "actual",
        city,
        count: 0,
        country: country ?? "Philippines",
        generatedAt: new Date().toISOString(),
        province,
        source: OVERPASS_API_URLS.join(", "),
      },
    };
  }

  const cityFeature = await queryCityBoundaryFeature(boundary.id);

  if (!cityFeature) {
    return {
      type: "FeatureCollection",
      features: [],
      metadata: {
        adminLevels: [boundary.tags.admin_level ?? "6"],
        boundaryMode: "actual",
        city: boundary.tags.name ?? city,
        count: 0,
        country: country ?? "Philippines",
        generatedAt: new Date().toISOString(),
        province,
        source: OVERPASS_API_URLS.join(", "),
      },
    };
  }

  return toCityBoundaryCollection({
    city: boundary.tags.name ?? city,
    country,
    feature: cityFeature,
    province,
    source: OVERPASS_API_URLS.join(", "),
  });
}

export async function queryBarangayBoundariesByRelationId({
  adminLevels,
  city,
  country,
  limit,
  locationLabel,
  relationId,
}: QueryBarangayBoundariesByRelationArgs): Promise<BoundaryFeatureCollection> {
  let actualLookupError: Error | null = null;
  let response: OverpassResponse | null = null;

  try {
    response = await runOverpassQuery(
      buildBarangayQueryForCityBoundary({
        adminLevels,
        limit,
        relationId,
      }),
    );
  } catch (error) {
    actualLookupError = error instanceof Error ? error : new Error("Unknown Overpass request failure");
  }

  const features =
    response?.elements
      .map(elementToFeature)
      .filter((feature): feature is BoundaryFeature => feature !== null)
      .sort((left, right) => left.properties.name.localeCompare(right.properties.name)) ?? [];
  const estimatedResult = !features.length ? await queryEstimatedBarangayFeatures({ city, limit, locationLabel, relationId }) : null;
  const resultFeatures: BoundaryFeature[] = features.length ? features : (estimatedResult?.estimation.features ?? []);
  const isEstimated = !features.length && resultFeatures.length > 0;

  if (!resultFeatures.length && actualLookupError) {
    throw actualLookupError;
  }

  return {
    type: "FeatureCollection",
    features: resultFeatures,
    metadata: {
      adminLevels: adminLevels ?? ["10"],
      city: city ?? `Relation ${relationId}`,
      country: country ?? "Philippines",
      count: resultFeatures.length,
      generatedAt: new Date().toISOString(),
      source: OVERPASS_API_URLS.join(", "),
      boundaryMode: isEstimated ? "estimated" : "actual",
      approximation: isEstimated
        ? {
            method: "voronoi",
            note: "Estimated polygons were generated from OSM place points clipped to the selected city boundary. They are not official barangay boundaries.",
            pointCount: estimatedResult?.estimation.osmPointCount ?? 0,
            psgcBarangayCount: estimatedResult?.estimation.officialSeeds?.barangays.length,
            seedMode: estimatedResult?.estimation.seedMode ?? "osm-place-points",
            unmatchedOfficialBarangays: estimatedResult?.estimation.officialSeeds?.unmatchedBarangays.map((barangay) => barangay.name),
          }
        : undefined,
      cityBoundary: {
        adminLevel: estimatedResult?.cityBoundary?.tags.admin_level,
        borderType: estimatedResult?.cityBoundary?.tags.border_type,
        id: relationId,
        name: estimatedResult?.cityBoundary?.tags.name,
      },
    },
  };
}

export async function queryCityBoundaryByRelationId({
  city,
  country,
  locationLabel,
  relationId,
}: QueryCityBoundaryByRelationArgs): Promise<BoundaryFeatureCollection> {
  const feature = await queryCityBoundaryFeature(relationId);

  if (!feature) {
    return {
      type: "FeatureCollection",
      features: [],
      metadata: {
        adminLevels: ["6", "7", "8"],
        boundaryMode: "actual",
        city: city ?? `Relation ${relationId}`,
        count: 0,
        country: country ?? "Philippines",
        generatedAt: new Date().toISOString(),
        province: locationLabel,
        source: OVERPASS_API_URLS.join(", "),
      },
    };
  }

  return toCityBoundaryCollection({
    city: city ?? feature.tags.name ?? `Relation ${relationId}`,
    country,
    feature,
    province: locationLabel,
    source: OVERPASS_API_URLS.join(", "),
  });
}
