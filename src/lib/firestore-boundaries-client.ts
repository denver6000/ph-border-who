"use client";

import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
  type DocumentReference,
} from "firebase/firestore";

import { getFirebaseAppCheckToken } from "@/lib/firebase-app-check";
import { ensureAnonymousFirebaseUser, getFirebaseFirestoreClient } from "@/lib/firebase-client";
import type { BoundaryFeature, BoundaryFeatureCollection, CityBoundaryCandidate } from "@/lib/boundary-types";
import { sanitizeIndicativeBarangaysWithPsgc } from "@/lib/psgc-boundary-validation";

const DATASET_COLLECTION = "boundaryDatasets";
const DEFAULT_DATASET_ID = "hdx-philippines-adm4";
const CITY_INDEX_CACHE_TTL_MS = 10 * 60 * 1000;

type FirestoreDataset = {
  boundaryMode?: "indicative";
  caveat?: string;
  count?: number;
  datasetId?: string;
  province?: string;
  source?: string;
  sourceUrl?: string;
};

type FirestoreCity = {
  chunkCount?: number;
  cityKey?: string;
  cityPcode?: string;
  cityName?: string;
  normalizedCityName?: string;
  province?: string;
};

type FirestoreChunk = {
  features?: BoundaryFeature[];
  featuresEncoding?: string;
  featuresJson?: string;
  featuresPayload?: string;
  index?: number;
};

type FirestoreCityIndexEntry = {
  cityKey?: string;
  cityName: string;
  cityPcode?: string;
  normalizedCityName: string;
  province?: string;
};

let cityIndexCache:
  | {
      datasetId: string;
      entries: FirestoreCityIndexEntry[];
      expiresAt: number;
    }
  | null = null;

async function ensureAppCheckReady() {
  await getFirebaseAppCheckToken();
}

async function ensureClientGuardsReady() {
  await ensureAppCheckReady();
  await ensureAnonymousFirebaseUser();
}

function getClientFirestore() {
  const db = getFirebaseFirestoreClient();

  if (!db) {
    throw new Error("Firebase Firestore is not configured.");
  }

  return db;
}

function firestoreDatasetId() {
  return process.env.NEXT_PUBLIC_FIRESTORE_BOUNDARY_DATASET_ID || DEFAULT_DATASET_ID;
}

function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bcity of\b/g, "")
    .replace(/\bcity\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numericIdFromCode(value: string | undefined, fallback: string) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const numeric = Number(digits);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  let hash = 0;

  for (const character of fallback) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }

  return hash || 1;
}

function hashCityId(city: string, province?: string) {
  return numericIdFromCode(undefined, `${city}|${province ?? ""}`);
}

async function gunzipBase64Json<T>(payload: string) {
  const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as T;
}

async function decodeChunkFeatures(chunk: FirestoreChunk) {
  if (chunk.featuresEncoding === "gzip-base64" && typeof chunk.featuresPayload === "string") {
    return gunzipBase64Json<BoundaryFeature[]>(chunk.featuresPayload);
  }

  if (typeof chunk.featuresJson === "string") {
    return JSON.parse(chunk.featuresJson) as BoundaryFeature[];
  }

  return Array.isArray(chunk.features) ? chunk.features : [];
}

async function getFirestoreCityIndex() {
  const datasetId = firestoreDatasetId();
  const now = Date.now();

  if (cityIndexCache && cityIndexCache.datasetId === datasetId && cityIndexCache.expiresAt > now) {
    return cityIndexCache.entries;
  }

  await ensureClientGuardsReady();

  const db = getClientFirestore();
  const datasetRef = doc(db, DATASET_COLLECTION, datasetId);
  const [datasetSnapshot, citiesSnapshot] = await Promise.all([
    getDoc(datasetRef),
    getDocs(collection(datasetRef, "cities")),
  ]);

  if (!datasetSnapshot.exists() || citiesSnapshot.empty) {
    cityIndexCache = {
      datasetId,
      entries: [],
      expiresAt: now + CITY_INDEX_CACHE_TTL_MS,
    };
    return [];
  }

  const entries = citiesSnapshot.docs
    .map((snapshot) => snapshot.data() as FirestoreCity)
    .filter((candidate) => Boolean(candidate.cityName))
    .map((candidate) => ({
      cityKey: candidate.cityKey,
      cityName: candidate.cityName!,
      cityPcode: candidate.cityPcode,
      normalizedCityName: candidate.normalizedCityName ?? normalizeName(candidate.cityName ?? ""),
      province: candidate.province,
    }));

  cityIndexCache = {
    datasetId,
    entries,
    expiresAt: now + CITY_INDEX_CACHE_TTL_MS,
  };

  return entries;
}

export async function queryClientFirestoreCities({
  city,
}: {
  city?: string;
}): Promise<CityBoundaryCandidate[]> {
  if (!city || process.env.NEXT_PUBLIC_FIRESTORE_BOUNDARIES_ENABLED === "false") {
    return [];
  }

  const expected = normalizeName(city);
  const cities = await getFirestoreCityIndex();

  return cities
    .filter((candidate) => {
      const normalized = candidate.normalizedCityName;
      return normalized.includes(expected) || expected.includes(normalized);
    })
    .sort((left, right) => left.cityName.localeCompare(right.cityName))
    .map((candidate) => ({
      adminLevel: "dataset",
      borderType: "firestore",
      id: numericIdFromCode(candidate.cityPcode ?? candidate.cityKey, candidate.cityName),
      locationLabel: candidate.province,
      name: candidate.cityName,
      ref: candidate.cityPcode ?? candidate.cityKey,
      sourceType: "firestore",
    }));
}

async function getFirestoreCityDocument({
  city,
  province,
}: {
  city: string;
  province?: string;
}) {
  await ensureClientGuardsReady();

  const db = getClientFirestore();
  const datasetRef = doc(db, DATASET_COLLECTION, firestoreDatasetId());
  const [datasetSnapshot, citiesSnapshot] = await Promise.all([
    getDoc(datasetRef),
    getDocs(query(collection(datasetRef, "cities"), where("normalizedCityName", "==", normalizeName(city)))),
  ]);

  if (!datasetSnapshot.exists() || citiesSnapshot.empty) {
    return null;
  }

  const normalizedProvince = province ? normalizeName(province) : "";
  const cityDoc =
    citiesSnapshot.docs.find((snapshot) => {
      if (!normalizedProvince) {
        return false;
      }

      const cityData = snapshot.data() as FirestoreCity;
      return normalizeName(cityData.province ?? "") === normalizedProvince;
    }) ?? citiesSnapshot.docs[0];

  return {
    cityData: cityDoc.data() as FirestoreCity,
    cityRef: cityDoc.ref,
    dataset: datasetSnapshot.data() as FirestoreDataset,
  };
}

async function readCityChunks(cityRef: DocumentReference, cityData: FirestoreCity) {
  const chunksSnapshot = await getDocs(query(collection(cityRef, "chunks"), orderBy("index")));
  const chunks = await Promise.all(
    chunksSnapshot.docs.map(async (snapshot) => {
      const chunk = snapshot.data() as FirestoreChunk;

      if (cityData.chunkCount !== undefined && (chunk.index ?? 0) >= cityData.chunkCount) {
        return [];
      }

      return decodeChunkFeatures(chunk);
    }),
  );

  return chunks.flat();
}

export async function queryClientFirestoreBarangayBoundaries({
  city,
  country = "Philippines",
  province,
}: {
  city?: string;
  country?: string;
  province?: string;
}): Promise<BoundaryFeatureCollection | null> {
  if (!city || process.env.NEXT_PUBLIC_FIRESTORE_BOUNDARIES_ENABLED === "false") {
    return null;
  }

  const result = await getFirestoreCityDocument({
    city,
    province,
  });

  if (!result) {
    return null;
  }

  const { cityData, cityRef, dataset } = result;
  const features = await readCityChunks(cityRef, cityData);

  if (!features.length) {
    return null;
  }

  return {
    features,
    metadata: {
      adminLevels: ["4"],
      boundaryMode: "indicative",
      city: cityData.cityName ?? city,
      count: features.length,
      country,
      dataset: {
        attribution: dataset.source ?? "Firestore boundary dataset",
        caveat: dataset.caveat ?? "Indicative boundaries only; not official legal boundary data.",
        name: dataset.source ?? dataset.datasetId ?? firestoreDatasetId(),
      },
      generatedAt: new Date().toISOString(),
      province: cityData.province ?? province ?? dataset.province,
      source: dataset.sourceUrl
        ? `Firestore cache of ${dataset.source ?? "HDX boundary dataset"} (${dataset.sourceUrl})`
        : `Firestore cache of ${dataset.source ?? "boundary dataset"}`,
    },
    type: "FeatureCollection",
  };
}

function dissolveCityGeometry(features: BoundaryFeature[]) {
  const polygonFeatures = features.map((feature) =>
    turf.feature(feature.geometry as Polygon | MultiPolygon, {
      id: feature.properties.id,
      name: feature.properties.name,
    }),
  );

  if (!polygonFeatures.length) {
    return null;
  }

  if (polygonFeatures.length === 1) {
    return polygonFeatures[0].geometry as Polygon | MultiPolygon;
  }

  try {
    const unioned = turf.union(turf.featureCollection(polygonFeatures)) as Feature<Polygon | MultiPolygon> | null;

    return unioned?.geometry ?? null;
  } catch {
    const combined = turf.combine(turf.featureCollection(polygonFeatures));
    const geometry = combined.features[0]?.geometry;

    if (geometry?.type === "MultiPolygon") {
      return geometry;
    }

    return null;
  }
}

export async function resolveClientFirestoreBarangayBoundaries({
  city,
  country = "Philippines",
  province,
}: {
  city?: string;
  country?: string;
  province?: string;
}): Promise<BoundaryFeatureCollection> {
  const firestoreResult = await queryClientFirestoreBarangayBoundaries({
    city,
    country,
    province,
  });

  if (firestoreResult) {
    return sanitizeIndicativeBarangaysWithPsgc({
      city,
      collection: firestoreResult,
      locationLabel: province,
    });
  }

  if (!city) {
    throw new Error('Missing required "city" query parameter.');
  }

  return {
    type: "FeatureCollection",
    features: [],
    metadata: {
      adminLevels: ["4"],
      boundaryMode: "indicative",
      city,
      count: 0,
      country,
      generatedAt: new Date().toISOString(),
      province,
      source: "Firestore boundary dataset",
    },
  };
}

export async function resolveClientFirestoreCityBoundary({
  city,
  country = "Philippines",
  province,
}: {
  city?: string;
  country?: string;
  province?: string;
}): Promise<BoundaryFeatureCollection> {
  const firestoreBarangays = await queryClientFirestoreBarangayBoundaries({
    city,
    country,
    province,
  });

  if (!firestoreBarangays?.features.length) {
    if (!city) {
      throw new Error('Missing required "city" query parameter.');
    }

    return {
      type: "FeatureCollection",
      features: [],
      metadata: {
        adminLevels: ["6", "7", "8"],
        boundaryMode: "indicative",
        city,
        count: 0,
        country,
        generatedAt: new Date().toISOString(),
        province,
        source: "Firestore boundary dataset",
      },
    };
  }

  const geometry = dissolveCityGeometry(firestoreBarangays.features);

  if (!geometry) {
    return {
      ...firestoreBarangays,
      features: [],
      metadata: {
        ...firestoreBarangays.metadata,
        adminLevels: ["6", "7", "8"],
        count: 0,
      },
    };
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry,
        properties: {
          boundaryKind: "indicative",
          id: hashCityId(firestoreBarangays.metadata.city, firestoreBarangays.metadata.province),
          name: firestoreBarangays.metadata.city,
          sourceType: "firestore-hdx-cod-ab",
        },
      },
    ],
    metadata: {
      adminLevels: ["6", "7", "8"],
      boundaryMode: "indicative",
      city: firestoreBarangays.metadata.city,
      count: 1,
      country,
      generatedAt: new Date().toISOString(),
      province: firestoreBarangays.metadata.province,
      source: firestoreBarangays.metadata.source,
    },
  };
}
