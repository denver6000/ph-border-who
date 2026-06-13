import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { BoundaryFeature, BoundaryFeatureCollection, CityBoundaryCandidate } from "@/lib/boundary-types";

type NativeZone = {
  country: string;
  feature: BoundaryFeature;
  locality: string;
  province?: string;
  sourceFile: string;
  status: number;
};

type ZoneCoordinate = {
  lang?: number;
  lat: number;
  lng?: number;
};

type NativeZoneCache = {
  files: string[];
  key: string;
  zones: NativeZone[];
};

const DEFAULT_NATIVE_ZONE_FILES = [
  "C:/Users/giyut/Downloads/selected-29-cities-zone.sql",
  "data/backfills/bulacan-malolos-balagtas-zones.sql",
];

let nativeZoneCache: NativeZoneCache | null = null;
let nativeZoneCachePromise: Promise<NativeZoneCache> | null = null;

function configuredNativeZoneFiles() {
  const raw = process.env.NATIVE_ZONES_SQL_PATHS ?? process.env.NATIVE_ZONES_SQL_PATH;

  if (!raw) {
    return DEFAULT_NATIVE_ZONE_FILES;
  }

  return raw
    .split(";")
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveInputPath(inputPath: string) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(/* turbopackIgnore: true */ process.cwd(), inputPath);
}

async function existingNativeZoneFiles() {
  const candidates = configuredNativeZoneFiles().map(resolveInputPath);
  const checks = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate);
        return candidate;
      } catch {
        return null;
      }
    }),
  );

  return checks.filter((candidate): candidate is string => Boolean(candidate));
}

function unquoteSqlString(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) {
    return trimmed;
  }

  return trimmed.slice(1, -1).replace(/''/g, "'");
}

function extractValueTuples(sql: string) {
  const tuples: string[] = [];
  const valuesPattern = /\bvalues\b/gi;
  let valuesMatch: RegExpExecArray | null;

  while ((valuesMatch = valuesPattern.exec(sql))) {
    let inQuote = false;
    let depth = 0;
    let tupleStart = -1;

    for (let index = valuesMatch.index + valuesMatch[0].length; index < sql.length; index += 1) {
      const char = sql[index];
      const next = sql[index + 1];

      if (char === "'" && inQuote && next === "'") {
        index += 1;
        continue;
      }

      if (char === "'") {
        inQuote = !inQuote;
        continue;
      }

      if (inQuote) {
        continue;
      }

      if (char === "(") {
        if (depth === 0) {
          tupleStart = index;
        }

        depth += 1;
        continue;
      }

      if (char === ")") {
        depth -= 1;

        if (depth === 0 && tupleStart >= 0) {
          tuples.push(sql.slice(tupleStart + 1, index));
          tupleStart = -1;
        }

        continue;
      }

      if (char === ";" && depth === 0) {
        break;
      }
    }
  }

  return tuples;
}

function splitSqlValues(tuple: string) {
  const values: string[] = [];
  let inQuote = false;
  let current = "";

  for (let index = 0; index < tuple.length; index += 1) {
    const char = tuple[index];
    const next = tuple[index + 1];

    if (char === "'" && inQuote && next === "'") {
      current += "''";
      index += 1;
      continue;
    }

    if (char === "'") {
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (char === "," && !inQuote) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function closeRing(coordinates: ZoneCoordinate[]) {
  const ring = coordinates
    .map((point) => [point.lng ?? point.lang, point.lat])
    .filter((point): point is number[] => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([...first]);
  }

  return ring;
}

function hashZoneId(value: string) {
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }

  return hash || 1;
}

function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bcity of\b/g, "")
    .replace(/\bcity\b/g, "")
    .replace(/\bmunicipality of\b/g, "")
    .replace(/\bmunicipality\b/g, "")
    .replace(/\bcapital\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCountry(value: string) {
  const normalized = normalizeName(value);

  if (normalized === "ph" || normalized === "philippines" || normalized === "republic of the philippines") {
    return "ph";
  }

  return normalized;
}

function splitZoneName(name: string) {
  const parts = name.split(",").map((part) => part.trim()).filter(Boolean);

  return {
    locality: parts[0] ?? name,
    province: parts[1],
  };
}

function parseZoneTuple(tuple: string, rowIndex: number, sourceFile: string): NativeZone | null {
  const values = splitSqlValues(tuple);

  if (values.length < 4) {
    return null;
  }

  const name = unquoteSqlString(values[0]);
  const country = unquoteSqlString(values[1]);
  const coordinates = JSON.parse(unquoteSqlString(values[2])) as ZoneCoordinate[];
  const status = Number(values[3]);
  const ring = closeRing(coordinates);

  if (ring.length < 4) {
    return null;
  }

  const { locality, province } = splitZoneName(name);

  return {
    country,
    feature: {
      geometry: {
        coordinates: [ring],
        type: "Polygon",
      },
      properties: {
        boundaryKind: "indicative",
        id: hashZoneId(`${sourceFile}|${rowIndex}|${name}`),
        name,
        sourceType: "native-zone-sql",
      },
      type: "Feature",
    },
    locality,
    province,
    sourceFile,
    status,
  };
}

async function readNativeZonesFromFile(sourceFile: string) {
  const sql = await readFile(sourceFile, "utf8");

  return extractValueTuples(sql)
    .map((tuple, index) => {
      try {
        return parseZoneTuple(tuple, index + 1, sourceFile);
      } catch {
        return null;
      }
    })
    .filter((zone): zone is NativeZone => Boolean(zone));
}

async function readAllNativeZones() {
  const files = await existingNativeZoneFiles();
  const key = files.join("|");

  if (nativeZoneCache?.key === key) {
    return nativeZoneCache;
  }

  if (nativeZoneCachePromise) {
    const cached = await nativeZoneCachePromise;

    if (cached.key === key) {
      return cached;
    }
  }

  nativeZoneCachePromise = Promise.all(files.map(readNativeZonesFromFile)).then((zoneGroups) => {
    const nextCache = {
      files,
      key,
      zones: zoneGroups.flat(),
    };

    nativeZoneCache = nextCache;
    nativeZoneCachePromise = null;
    return nextCache;
  });

  return nativeZoneCachePromise;
}

function filterNativeZones({
  country = "PH",
  locality,
  province,
}: {
  country?: string;
  locality?: string;
  province?: string;
} = {}, zones: NativeZone[]) {
  const normalizedLocality = locality ? normalizeName(locality) : "";
  const normalizedProvince = province ? normalizeName(province) : "";

  return zones.filter((zone) => {
    if (country && normalizeCountry(zone.country) !== normalizeCountry(country)) {
      return false;
    }

    if (normalizedProvince) {
      const zoneProvince = normalizeName(zone.province ?? "");

      if (!zoneProvince.includes(normalizedProvince) && !normalizedProvince.includes(zoneProvince)) {
        return false;
      }
    }

    if (normalizedLocality) {
      const zoneLocality = normalizeName(zone.locality);

      if (!zoneLocality.includes(normalizedLocality) && !normalizedLocality.includes(zoneLocality)) {
        return false;
      }
    }

    return true;
  });
}

export async function queryNativeZoneCandidates({
  country = "PH",
  province,
}: {
  country?: string;
  province?: string;
} = {}): Promise<CityBoundaryCandidate[]> {
  const { zones } = await readAllNativeZones();
  const filteredZones = filterNativeZones({ country, province }, zones);
  const candidatesByKey = new Map<string, CityBoundaryCandidate>();

  filteredZones.forEach((zone) => {
    const key = `${normalizeName(zone.province ?? province ?? "")}|${normalizeName(zone.locality)}`;

    if (candidatesByKey.has(key)) {
      return;
    }

    candidatesByKey.set(key, {
      adminLevel: "native-zone",
      borderType: "native-zone-sql",
      id: hashZoneId(`native-candidate|${zone.country}|${zone.province ?? ""}|${zone.locality}`),
      localityType: "municipality",
      locationLabel: zone.province ?? province,
      name: zone.locality,
      ref: `native-zone:${key}`,
      sourceType: "native-zone-sql",
    });
  });

  return Array.from(candidatesByKey.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export async function queryNativeZones({
  country = "PH",
  locality,
  province,
}: {
  country?: string;
  locality?: string;
  province?: string;
} = {}): Promise<BoundaryFeatureCollection> {
  const { files, zones } = await readAllNativeZones();
  const filteredZones = filterNativeZones({ country, locality, province }, zones);
  const displayProvince = province ?? filteredZones[0]?.province;

  return {
    features: filteredZones.map((zone) => zone.feature),
    metadata: {
      adminLevels: ["native-zone"],
      boundaryMode: "indicative",
      city: displayProvince ? `${displayProvince} native zones` : "Native zones",
      count: filteredZones.length,
      country,
      dataset: {
        attribution: "Local zones SQL dataset",
        caveat: "Indicative boundaries loaded from the native zones table export.",
        name: "Native zones SQL",
      },
      generatedAt: new Date().toISOString(),
      province: displayProvince,
      source: files.length ? files.join(", ") : "No native zone SQL files found",
    },
    type: "FeatureCollection",
  };
}
