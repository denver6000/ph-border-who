import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import type { BoundaryFeatureCollection, CityBoundaryCandidate } from "@/lib/boundary-types";
import { queryFirestoreCityBoundary } from "@/lib/city-boundaries";
import { queryFirestoreCitiesByProvince } from "@/lib/firestore-boundaries";
import { queryNativeZoneCandidates, queryNativeZones } from "@/lib/native-zones";
import { queryCityBoundaryBySearch } from "@/lib/overpass";
import { findOfficialLocalitiesForProvince, normalizePsgcName, type PsgcLocality } from "@/lib/psgc";

type BoundarySource = "firebase" | "native-zone-sql" | "osm" | "missing";
type BoundaryStatus = "firebase" | "native-zone" | "osm-compatible" | "osm-incompatible" | "missing";

export type MergedMunicipalityBoundary = {
  boundary: BoundaryFeatureCollection | null;
  candidate: CityBoundaryCandidate;
  compatibility?: BoundaryCompatibilityReport;
  official: {
    code: string;
    localityType: "city" | "municipality";
    name: string;
  };
  source: BoundarySource;
  status: BoundaryStatus;
};

export type MergedMunicipalityBoundaryResponse = {
  boundaries: MergedMunicipalityBoundary[];
  metadata: {
    count: number;
    country: string;
    firebaseCount: number;
    generatedAt: string;
    missingCount: number;
    nativeZoneCount: number;
    osmCompatibleCount: number;
    osmIncompatibleCount: number;
    province: string;
    source: "firebase-native-osm-merged";
  };
  municipalities: CityBoundaryCandidate[];
};

export type MunicipalityCandidateListResponse = {
  metadata: {
    count: number;
    country: string;
    generatedAt: string;
    province: string;
    source: "firebase-native-psgc-list";
  };
  municipalities: CityBoundaryCandidate[];
};

export type BoundaryCompatibilityReport = {
  checkedAgainst: number;
  compatible: boolean;
  maxOverlapAreaM2: number;
  maxOverlapOfSmallerRatio: number;
  thresholdAreaM2: number;
  thresholdSmallerRatio: number;
};

type BoundaryRepository = {
  getBoundary(locality: OfficialLocalityCandidate): Promise<BoundaryFeatureCollection | null>;
  listCandidates?(province: string): Promise<CityBoundaryCandidate[]>;
  source: BoundarySource;
};

type OfficialLocalityCandidate = {
  code: string;
  localityType: "city" | "municipality";
  name: string;
  province: string;
};

const OSM_COMPATIBILITY_THRESHOLD_AREA_M2 = 1_000;
const OSM_COMPATIBILITY_THRESHOLD_SMALLER_RATIO = 0.02;
const BULK_BOUNDARY_CONCURRENCY = 6;

function hashCandidateId(value: string) {
  const digits = value.replace(/\D/g, "");
  const numeric = Number(digits);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }

  return hash || 1;
}

function toOfficialCandidate(locality: PsgcLocality, province: string): OfficialLocalityCandidate {
  return {
    code: locality.code,
    localityType: locality.isMunicipality ? "municipality" : "city",
    name: locality.name,
    province,
  };
}

function toCityCandidate(locality: OfficialLocalityCandidate, firestoreCandidate?: CityBoundaryCandidate): CityBoundaryCandidate {
  return {
    adminLevel: firestoreCandidate?.adminLevel ?? "psgc",
    borderType: firestoreCandidate?.borderType ?? "official-locality",
    id: firestoreCandidate?.id ?? hashCandidateId(locality.code),
    localityType: locality.localityType,
    locationLabel: firestoreCandidate?.locationLabel ?? locality.province,
    name: firestoreCandidate?.name ?? locality.name,
    ref: firestoreCandidate?.ref ?? locality.code,
    sourceType: firestoreCandidate?.sourceType ?? "psgc",
  };
}

function localityKey(value: string) {
  return normalizePsgcName(value)
    .replace(/^city of\s+/, "")
    .replace(/^municipality of\s+/, "")
    .replace(/\bcity\b/g, "")
    .replace(/\bmunicipality\b/g, "")
    .replace(/^of\s+/, "")
    .trim();
}

function findFirestoreCandidate(locality: OfficialLocalityCandidate, candidates: CityBoundaryCandidate[]) {
  const byCode = candidates.find((candidate) => candidate.ref === locality.code);

  if (byCode) {
    return byCode;
  }

  const expected = localityKey(locality.name);

  return candidates.find((candidate) => localityKey(candidate.name) === expected);
}

function asPolygonFeature(collection: BoundaryFeatureCollection) {
  const feature = collection.features[0];

  if (!feature) {
    return null;
  }

  return turf.feature(feature.geometry as Polygon | MultiPolygon, feature.properties);
}

function overlapReport(left: Feature<Polygon | MultiPolygon>, right: Feature<Polygon | MultiPolygon>) {
  const intersection = turf.intersect(turf.featureCollection([left, right]));

  if (!intersection) {
    return {
      overlapAreaM2: 0,
      overlapOfSmallerRatio: 0,
    };
  }

  const overlapAreaM2 = turf.area(intersection);
  const smallerAreaM2 = Math.min(turf.area(left), turf.area(right));

  return {
    overlapAreaM2,
    overlapOfSmallerRatio: smallerAreaM2 > 0 ? overlapAreaM2 / smallerAreaM2 : 0,
  };
}

function checkBoundaryCompatibility(
  candidateBoundary: BoundaryFeatureCollection,
  acceptedBoundaries: BoundaryFeatureCollection[],
): BoundaryCompatibilityReport {
  const candidateFeature = asPolygonFeature(candidateBoundary);
  let maxOverlapAreaM2 = 0;
  let maxOverlapOfSmallerRatio = 0;

  if (!candidateFeature) {
    return {
      checkedAgainst: acceptedBoundaries.length,
      compatible: false,
      maxOverlapAreaM2,
      maxOverlapOfSmallerRatio,
      thresholdAreaM2: OSM_COMPATIBILITY_THRESHOLD_AREA_M2,
      thresholdSmallerRatio: OSM_COMPATIBILITY_THRESHOLD_SMALLER_RATIO,
    };
  }

  for (const acceptedBoundary of acceptedBoundaries) {
    const acceptedFeature = asPolygonFeature(acceptedBoundary);

    if (!acceptedFeature) {
      continue;
    }

    const overlap = overlapReport(candidateFeature, acceptedFeature);
    maxOverlapAreaM2 = Math.max(maxOverlapAreaM2, overlap.overlapAreaM2);
    maxOverlapOfSmallerRatio = Math.max(maxOverlapOfSmallerRatio, overlap.overlapOfSmallerRatio);
  }

  const compatible =
    maxOverlapAreaM2 <= OSM_COMPATIBILITY_THRESHOLD_AREA_M2 ||
    maxOverlapOfSmallerRatio <= OSM_COMPATIBILITY_THRESHOLD_SMALLER_RATIO;

  return {
    checkedAgainst: acceptedBoundaries.length,
    compatible,
    maxOverlapAreaM2,
    maxOverlapOfSmallerRatio,
    thresholdAreaM2: OSM_COMPATIBILITY_THRESHOLD_AREA_M2,
    thresholdSmallerRatio: OSM_COMPATIBILITY_THRESHOLD_SMALLER_RATIO,
  };
}

function createFirebaseBoundaryRepository(): BoundaryRepository {
  return {
    async getBoundary(locality) {
      const boundary = await queryFirestoreCityBoundary({
        city: locality.name,
        country: "Philippines",
        province: locality.province,
      });

      return boundary?.features.length ? boundary : null;
    },
    listCandidates: (province) => queryFirestoreCitiesByProvince({ province }),
    source: "firebase",
  };
}

function createOsmBoundaryRepository(): BoundaryRepository {
  return {
    async getBoundary(locality) {
      const boundary = (await queryCityBoundaryBySearch({
        city: locality.name,
        country: "Philippines",
        province: locality.province,
      })) as unknown as BoundaryFeatureCollection;

      return boundary.features.length ? boundary : null;
    },
    source: "osm",
  };
}

function createNativeZoneBoundaryRepository(): BoundaryRepository {
  return {
    async getBoundary(locality) {
      const boundary = await queryNativeZones({
        country: "PH",
        locality: locality.name,
        province: locality.province,
      });

      return boundary.features.length ? boundary : null;
    },
    listCandidates: (province) => queryNativeZoneCandidates({ country: "PH", province }),
    source: "native-zone-sql",
  };
}

function mergeOfficialAndNativeLocalities({
  nativeCandidates,
  officialLocalities,
  province,
}: {
  nativeCandidates: CityBoundaryCandidate[];
  officialLocalities: PsgcLocality[];
  province: string;
}) {
  const mergedByName = new Map<string, OfficialLocalityCandidate>();

  officialLocalities.forEach((locality) => {
    const official = toOfficialCandidate(locality, province);
    mergedByName.set(localityKey(official.name), official);
  });

  nativeCandidates.forEach((candidate) => {
    const key = localityKey(candidate.name);

    if (mergedByName.has(key)) {
      return;
    }

    mergedByName.set(key, {
      code: candidate.ref ?? `native-zone:${key}`,
      localityType: candidate.localityType ?? "municipality",
      name: candidate.name,
      province: candidate.locationLabel ?? province,
    });
  });

  return Array.from(mergedByName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    results.push(...(await Promise.all(batch.map(mapper))));
  }

  return results;
}

async function resolveFirebaseBoundaries({
  candidates,
  firebaseRepository,
  localities,
}: {
  candidates: CityBoundaryCandidate[];
  firebaseRepository: BoundaryRepository;
  localities: OfficialLocalityCandidate[];
}) {
  return mapWithConcurrency(localities, BULK_BOUNDARY_CONCURRENCY, async (locality) => {
    const firestoreCandidate = findFirestoreCandidate(locality, candidates);
    const candidate = toCityCandidate(locality, firestoreCandidate);
    const boundary = firestoreCandidate ? await firebaseRepository.getBoundary(locality).catch(() => null) : null;

    return {
      boundary,
      candidate,
      official: {
        code: locality.code,
        localityType: locality.localityType,
        name: locality.name,
      },
      source: boundary ? "firebase" : "missing",
      status: boundary ? "firebase" : "missing",
    } satisfies MergedMunicipalityBoundary;
  });
}

async function fillMissingBoundariesWithNativeAndOsm({
  acceptedBoundaries,
  includeOsmFallback,
  missingResults,
  nativeRepository,
  osmRepository,
  province,
}: {
  acceptedBoundaries: BoundaryFeatureCollection[];
  includeOsmFallback: boolean;
  missingResults: MergedMunicipalityBoundary[];
  nativeRepository: BoundaryRepository;
  osmRepository: BoundaryRepository;
  province: string;
}) {
  const resolved: MergedMunicipalityBoundary[] = [];

  for (const result of missingResults) {
    const nativeBoundary = await nativeRepository
      .getBoundary({
        code: result.official.code,
        localityType: result.official.localityType,
        name: result.official.name,
        province,
      })
      .catch(() => null);

    if (nativeBoundary) {
      acceptedBoundaries.push(nativeBoundary);
      resolved.push({
        ...result,
        boundary: nativeBoundary,
        source: "native-zone-sql",
        status: "native-zone",
      });
      continue;
    }

    if (!includeOsmFallback) {
      resolved.push(result);
      continue;
    }

    const osmBoundary = await osmRepository
      .getBoundary({
        code: result.official.code,
        localityType: result.official.localityType,
        name: result.official.name,
        province,
      })
      .catch(() => null);

    if (!osmBoundary) {
      resolved.push(result);
      continue;
    }

    const compatibility = checkBoundaryCompatibility(osmBoundary, acceptedBoundaries);

    if (!compatibility.compatible) {
      resolved.push({
        ...result,
        boundary: osmBoundary,
        compatibility,
        source: "osm",
        status: "osm-incompatible",
      });
      continue;
    }

    acceptedBoundaries.push(osmBoundary);
    resolved.push({
      ...result,
      boundary: osmBoundary,
      compatibility,
      source: "osm",
      status: "osm-compatible",
    });
  }

  return resolved;
}

export async function resolveMergedMunicipalityBoundaries({
  country = "Philippines",
  includeOsmFallback = false,
  province,
}: {
  country?: string;
  includeOsmFallback?: boolean;
  province: string;
}): Promise<MergedMunicipalityBoundaryResponse> {
  const firebaseRepository = createFirebaseBoundaryRepository();
  const nativeRepository = createNativeZoneBoundaryRepository();
  const osmRepository = createOsmBoundaryRepository();
  const [officialLocalities, firebaseCandidates, nativeCandidates] = await Promise.all([
    findOfficialLocalitiesForProvince(province),
    firebaseRepository.listCandidates?.(province) ?? Promise.resolve([]),
    nativeRepository.listCandidates?.(province) ?? Promise.resolve([]),
  ]);
  const localities = mergeOfficialAndNativeLocalities({
    nativeCandidates,
    officialLocalities,
    province,
  });
  const firebaseResults = await resolveFirebaseBoundaries({
    candidates: firebaseCandidates,
    firebaseRepository,
    localities,
  });
  const acceptedBoundaries = firebaseResults
    .map((result) => result.boundary)
    .filter((boundary): boundary is BoundaryFeatureCollection => Boolean(boundary));
  const missingResults = firebaseResults.filter((result) => !result.boundary);
  const osmResults = await fillMissingBoundariesWithNativeAndOsm({
    acceptedBoundaries,
    includeOsmFallback,
    missingResults,
    nativeRepository,
    osmRepository,
    province,
  });
  const mergedByCode = new Map<string, MergedMunicipalityBoundary>();

  firebaseResults
    .filter((result) => result.boundary)
    .forEach((result) => mergedByCode.set(result.official.code, result));
  osmResults.forEach((result) => mergedByCode.set(result.official.code, result));

  const boundaries = localities
    .map((locality) => mergedByCode.get(locality.code))
    .filter((result): result is MergedMunicipalityBoundary => Boolean(result));
  const municipalities = boundaries.map((result) => result.candidate);

  return {
    boundaries,
    metadata: {
      count: municipalities.length,
      country,
      firebaseCount: boundaries.filter((result) => result.status === "firebase").length,
      generatedAt: new Date().toISOString(),
      missingCount: boundaries.filter((result) => result.status === "missing").length,
      nativeZoneCount: boundaries.filter((result) => result.status === "native-zone").length,
      osmCompatibleCount: boundaries.filter((result) => result.status === "osm-compatible").length,
      osmIncompatibleCount: boundaries.filter(
        (result) => result.status === "osm-incompatible" || result.compatibility?.compatible === false,
      ).length,
      province,
      source: "firebase-native-osm-merged",
    },
    municipalities,
  };
}

export async function listMunicipalityCandidates({
  country = "Philippines",
  province,
}: {
  country?: string;
  province: string;
}): Promise<MunicipalityCandidateListResponse> {
  const firebaseRepository = createFirebaseBoundaryRepository();
  const nativeRepository = createNativeZoneBoundaryRepository();
  const [officialLocalities, firebaseCandidates, nativeCandidates] = await Promise.all([
    findOfficialLocalitiesForProvince(province),
    firebaseRepository.listCandidates?.(province) ?? Promise.resolve([]),
    nativeRepository.listCandidates?.(province) ?? Promise.resolve([]),
  ]);
  const localities = mergeOfficialAndNativeLocalities({
    nativeCandidates,
    officialLocalities,
    province,
  });
  const candidatesByKey = new Map<string, CityBoundaryCandidate>();

  localities.forEach((locality) => {
    const candidate = toCityCandidate(locality, findFirestoreCandidate(locality, firebaseCandidates));
    candidatesByKey.set(localityKey(candidate.name), candidate);
  });

  firebaseCandidates.forEach((candidate) => {
    const key = localityKey(candidate.name);

    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, candidate);
    }
  });

  const municipalities = Array.from(candidatesByKey.values()).sort((left, right) => left.name.localeCompare(right.name));

  return {
    metadata: {
      count: municipalities.length,
      country,
      generatedAt: new Date().toISOString(),
      province,
      source: "firebase-native-psgc-list",
    },
    municipalities,
  };
}
