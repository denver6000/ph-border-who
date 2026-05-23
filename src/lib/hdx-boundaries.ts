import { promises as fs } from "node:fs";
import path from "node:path";

import type { BoundaryFeature, BoundaryFeatureCollection } from "@/lib/overpass";

const HDX_DATASET_URL = "https://data.humdata.org/dataset/cod-ab-phl";
const DEFAULT_HDX_CACHE_DIR = path.join(process.cwd(), "data", "hdx", "cod-ab-phl");

type HdxManifestCity = {
  adm1Name?: string;
  adm1Pcode?: string;
  adm2Name?: string;
  adm2Pcode?: string;
  adm3Name: string;
  adm3Pcode: string;
  featureCount: number;
  file: string;
};

type HdxManifest = {
  cities: HdxManifestCity[];
  dataset: {
    attribution: string;
    caveat: string;
    name: string;
    sourceUrl: string;
  };
  generatedAt: string;
};

type HdxFeatureProperties = {
  ADM1_EN?: string;
  ADM1_PCODE?: string;
  ADM2_EN?: string;
  ADM2_PCODE?: string;
  ADM3_EN?: string;
  ADM3_PCODE?: string;
  ADM4_EN?: string;
  ADM4_PCODE?: string;
  adm1_en?: string;
  adm1_pcode?: string;
  adm2_en?: string;
  adm2_pcode?: string;
  adm3_en?: string;
  adm3_pcode?: string;
  adm4_en?: string;
  adm4_pcode?: string;
  [key: string]: unknown;
};

type HdxRawFeature = {
  geometry: BoundaryFeature["geometry"];
  properties: HdxFeatureProperties;
  type: "Feature";
};

function hdxCacheDir() {
  return process.env.HDX_BOUNDARIES_DIR || DEFAULT_HDX_CACHE_DIR;
}

function repairMojibake(value: string) {
  if (!/[ÃÂ]/.test(value)) {
    return value;
  }

  try {
    return Buffer.from(value, "latin1").toString("utf8");
  } catch {
    return value;
  }
}

function repairStrings<T>(value: T): T {
  if (typeof value === "string") {
    return repairMojibake(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => repairStrings(entry)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, repairStrings(entry)])) as T;
  }

  return value;
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

function cityNameKeys(value: string) {
  const normalized = normalizeName(value);

  return new Set([normalized, normalized.replace(/\s+/g, "")].filter(Boolean));
}

function locationMatches(city: HdxManifestCity, locationLabel?: string, province?: string) {
  const location = normalizeName([locationLabel, province].filter(Boolean).join(" "));

  if (!location) {
    return true;
  }

  return [city.adm2Name, city.adm1Name, city.adm2Pcode, city.adm1Pcode]
    .filter((value): value is string => Boolean(value))
    .some((value) => location.includes(normalizeName(value)));
}

function findCity(manifest: HdxManifest, city: string, locationLabel?: string, province?: string) {
  const expectedKeys = cityNameKeys(city);
  const cityMatches = manifest.cities.filter((candidate) => {
    const candidateKeys = cityNameKeys(candidate.adm3Name);
    return Array.from(expectedKeys).some((key) => candidateKeys.has(key));
  });

  if (!cityMatches.length) {
    return null;
  }

  return cityMatches.find((candidate) => locationMatches(candidate, locationLabel, province)) ?? cityMatches[0];
}

async function readManifest(cacheDir: string) {
  try {
    const raw = await fs.readFile(path.join(cacheDir, "manifest.json"), "utf8");
    return repairStrings(JSON.parse(raw) as HdxManifest);
  } catch {
    return null;
  }
}

function propertyValue(properties: HdxFeatureProperties, ...keys: string[]) {
  for (const key of keys) {
    const value = properties[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function hdxFeatureToBoundaryFeature(feature: HdxRawFeature, index: number): BoundaryFeature | null {
  const name = propertyValue(feature.properties, "ADM4_EN", "adm4_en");
  const psgcCode = propertyValue(feature.properties, "ADM4_PCODE", "adm4_pcode");

  if (!name || !feature.geometry) {
    return null;
  }

  return {
    geometry: feature.geometry,
    properties: {
      boundaryKind: "indicative",
      id: Number(psgcCode) || index,
      name,
      psgcCode,
      sourceType: "hdx-cod-ab",
    },
    type: "Feature",
  };
}

async function readCityFeatures(cacheDir: string, city: HdxManifestCity) {
  const raw = await fs.readFile(path.join(cacheDir, city.file), "utf8");

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => repairStrings(JSON.parse(line) as HdxRawFeature))
    .map((feature, index) => hdxFeatureToBoundaryFeature(feature, index))
    .filter((feature): feature is BoundaryFeature => feature !== null)
    .sort((left, right) => left.properties.name.localeCompare(right.properties.name));
}

export async function queryHdxBarangayBoundaries({
  city,
  country = "Philippines",
  locationLabel,
  province,
}: {
  city?: string;
  country?: string;
  locationLabel?: string;
  province?: string;
}): Promise<BoundaryFeatureCollection | null> {
  if (!city) {
    return null;
  }

  const cacheDir = hdxCacheDir();
  const manifest = await readManifest(cacheDir);

  if (!manifest) {
    return null;
  }

  const matchedCity = findCity(manifest, city, locationLabel, province);

  if (!matchedCity) {
    return null;
  }

  const features = await readCityFeatures(cacheDir, matchedCity);

  if (!features.length) {
    return null;
  }

  return {
    features,
    metadata: {
      adminLevels: ["4"],
      boundaryMode: "indicative",
      city: matchedCity.adm3Name,
      count: features.length,
      country,
      generatedAt: new Date().toISOString(),
      province: matchedCity.adm2Name,
      source: `${manifest.dataset.name} (${manifest.dataset.sourceUrl})`,
      dataset: {
        attribution: manifest.dataset.attribution,
        caveat: manifest.dataset.caveat,
        name: manifest.dataset.name,
      },
    },
    type: "FeatureCollection",
  };
}

export { HDX_DATASET_URL };
