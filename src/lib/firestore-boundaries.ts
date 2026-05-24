import { gunzipSync } from "node:zlib";

import { getAdminFirestore } from "@/lib/firebase-admin";
import type { BoundaryFeature, BoundaryFeatureCollection, CityBoundaryCandidate } from "@/lib/boundary-types";

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

function decodeChunkFeatures(chunk: FirestoreChunk) {
  if (chunk.featuresEncoding === "gzip-base64" && typeof chunk.featuresPayload === "string") {
    return JSON.parse(gunzipSync(Buffer.from(chunk.featuresPayload, "base64")).toString("utf8")) as BoundaryFeature[];
  }

  if (typeof chunk.featuresJson === "string") {
    return JSON.parse(chunk.featuresJson) as BoundaryFeature[];
  }

  return Array.isArray(chunk.features) ? chunk.features : [];
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

function firestoreDatasetId() {
  return process.env.FIRESTORE_BOUNDARY_DATASET_ID || DEFAULT_DATASET_ID;
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

export async function queryFirestoreCities({
  city,
}: {
  city?: string;
}): Promise<CityBoundaryCandidate[]> {
  if (!city || process.env.FIRESTORE_BOUNDARIES_ENABLED === "false") {
    return [];
  }

  try {
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
  } catch {
    return [];
  }
}

async function getFirestoreCityIndex() {
  const datasetId = firestoreDatasetId();
  const now = Date.now();

  if (cityIndexCache && cityIndexCache.datasetId === datasetId && cityIndexCache.expiresAt > now) {
    return cityIndexCache.entries;
  }

  const db = getAdminFirestore();
  const datasetRef = db.collection(DATASET_COLLECTION).doc(datasetId);
  const [datasetSnapshot, citiesSnapshot] = await Promise.all([datasetRef.get(), datasetRef.collection("cities").get()]);

  if (!datasetSnapshot.exists || citiesSnapshot.empty) {
    cityIndexCache = {
      datasetId,
      entries: [],
      expiresAt: now + CITY_INDEX_CACHE_TTL_MS,
    };
    return [];
  }

  const entries = citiesSnapshot.docs
    .map((doc) => doc.data() as FirestoreCity)
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

export async function queryFirestoreBarangayBoundaries({
  city,
  country = "Philippines",
  province,
}: {
  city?: string;
  country?: string;
  province?: string;
}): Promise<BoundaryFeatureCollection | null> {
  if (!city || process.env.FIRESTORE_BOUNDARIES_ENABLED === "false") {
    return null;
  }

  try {
    const db = getAdminFirestore();
    const datasetRef = db.collection(DATASET_COLLECTION).doc(firestoreDatasetId());
    const [datasetSnapshot, citySnapshot] = await Promise.all([
      datasetRef.get(),
      datasetRef.collection("cities").where("normalizedCityName", "==", normalizeName(city)).get(),
    ]);

    if (!datasetSnapshot.exists || citySnapshot.empty) {
      return null;
    }

    const dataset = datasetSnapshot.data() as FirestoreDataset;
    const normalizedProvince = province ? normalizeName(province) : "";
    const cityDoc =
      citySnapshot.docs.find((doc) => {
        if (!normalizedProvince) {
          return false;
        }

        const cityData = doc.data() as FirestoreCity;
        return normalizeName(cityData.province ?? "") === normalizedProvince;
      }) ?? citySnapshot.docs[0];
    const cityData = cityDoc.data() as FirestoreCity;
    const chunksSnapshot = await cityDoc.ref.collection("chunks").orderBy("index").get();
    const features = chunksSnapshot.docs.flatMap((doc) => {
      const chunk = doc.data() as FirestoreChunk;

      if (cityData.chunkCount !== undefined && (chunk.index ?? 0) >= cityData.chunkCount) {
        return [];
      }

      return decodeChunkFeatures(chunk);
    });

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
  } catch {
    return null;
  }
}
