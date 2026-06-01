import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

import {
  DATASET_COLLECTION,
  DEFAULT_CHUNK_TARGET_BYTES,
  ImportScriptError,
  commitBatch,
  getAdminDb,
  getCityName,
  getCityPcode,
  getPsgcLocalityKind,
  getProvinceName,
  makeBatchOperation,
  normalizeName,
  slugify,
  toMappingFeature,
} from "./firestore-boundary-utils.mjs";

export function encodeFeatures(features) {
  return gzipSync(JSON.stringify(features)).toString("base64");
}

export function encodedByteLength(features) {
  return Buffer.byteLength(encodeFeatures(features), "utf8");
}

function estimateJsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function groupByCity(features) {
  const grouped = new Map();

  features.forEach((feature, index) => {
    const mappingFeature = toMappingFeature(feature, index + 1);
    const cityName = getCityName(feature);
    const cityPcode = getCityPcode(feature);
    const cityKey = cityPcode || slugify(cityName);
    const existing = grouped.get(cityKey);

    if (existing) {
      existing.features.push(mappingFeature);
      return;
    }

    grouped.set(cityKey, {
      cityKey,
      cityName,
      cityPcode,
      features: [mappingFeature],
      normalizedCityName: normalizeName(cityName),
      province: getProvinceName(feature),
    });
  });

  return Array.from(grouped.values()).sort((left, right) => left.cityName.localeCompare(right.cityName));
}

export function chunkFeatures(features, chunkTargetBytes) {
  const chunks = [];
  let current = [];

  for (const feature of features) {
    const candidate = [...current, feature];

    if (current.length && encodedByteLength(candidate) > chunkTargetBytes) {
      chunks.push(current);
      current = [feature];
      continue;
    }

    current = candidate;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

async function annotateLocalityTypes(cities) {
  return Promise.all(
    cities.map(async (city) => ({
      ...city,
      localityType: await getPsgcLocalityKind({
        name: city.cityName,
        province: city.province,
      }),
    })),
  );
}

async function readJsonFile(filePath) {
  let raw;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new ImportScriptError("The HDX cache file was not found.", {
        details: [`Expected file: ${filePath}`],
        solutions: [
          "Run npm run import:hdx first to build the nationwide HDX cache.",
          "Make sure the cache directory points at data/hdx/cod-ab-phl.",
        ],
        cause: error,
      });
    }

    throw new ImportScriptError("A required HDX cache file could not be read.", {
      details: [`Path: ${filePath}`],
      solutions: [
        "Check that the cache directory exists and is readable.",
        "Rebuild the cache with npm run import:hdx if files are missing or partial.",
      ],
      cause: error,
    });
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ImportScriptError("A required HDX cache file is not valid JSON.", {
      details: [`Path: ${filePath}`],
      solutions: [
        "Rebuild the cache with npm run import:hdx.",
        "Make sure the manifest file was not manually edited or truncated.",
      ],
      cause: error,
    });
  }
}

async function readNdjsonFeatures(filePath) {
  let raw;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new ImportScriptError("A city NDJSON cache file was not found.", {
        details: [`Expected file: ${filePath}`],
        solutions: [
          "Rebuild the nationwide HDX cache with npm run import:hdx.",
          "Check that the adm4 directory is complete.",
        ],
        cause: error,
      });
    }

    throw new ImportScriptError("A city NDJSON cache file could not be read.", {
      details: [`Path: ${filePath}`],
      solutions: [
        "Check the cache directory permissions.",
        "Rebuild the cache if the file is corrupted.",
      ],
      cause: error,
    });
  }

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new ImportScriptError("A city NDJSON cache file contains invalid JSON.", {
          details: [`Path: ${filePath}`, `Line: ${index + 1}`],
          solutions: [
            "Rebuild the nationwide HDX cache with npm run import:hdx.",
            "Do not edit the generated adm4/*.ndjson files by hand.",
          ],
          cause: error,
        });
      }
    });
}

export async function importBoundaryGeoJsonToFirestore({
  chunkTargetBytes = DEFAULT_CHUNK_TARGET_BYTES,
  datasetId,
  dryRun = false,
  inputFile,
  sourceName,
  sourceUrl,
}) {
  if (!datasetId) {
    throw new ImportScriptError("Missing Firestore dataset id.", {
      solutions: [
        "Pass --dataset=hdx-philippines-adm4 when running the importer.",
        "Or set FIRESTORE_BOUNDARY_DATASET_ID in your environment for the app runtime.",
      ],
    });
  }

  if (!Number.isFinite(chunkTargetBytes) || chunkTargetBytes <= 0) {
    throw new ImportScriptError("Invalid chunk size.", {
      details: [`Received chunkTargetBytes=${String(chunkTargetBytes)}`],
      solutions: ["Pass a positive number with --chunk-bytes=650000 or similar."],
    });
  }

  let raw;

  try {
    raw = await fs.readFile(inputFile, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new ImportScriptError("The HDX GeoJSON file was not found.", {
        details: [`Expected input file: ${inputFile}`],
        solutions: [
          "Download or generate the processed HDX GeoJSON first.",
          "Pass the correct file with --input=C:\\path\\to\\philippines-adm4.geojson.",
          "This repository does not bundle the full HDX dataset, so the importer needs a local file to read from.",
        ],
        cause: error,
      });
    }

    throw new ImportScriptError("The input file could not be read.", {
      details: [`Path: ${inputFile}`],
      solutions: [
        "Check that the file exists and is readable.",
        "If the file is on another drive or folder, pass it with --input=...",
      ],
      cause: error,
    });
  }

  let collection;

  try {
    collection = JSON.parse(raw);
  } catch (error) {
    throw new ImportScriptError("The input file is not valid JSON.", {
      details: [`Path: ${inputFile}`],
      solutions: [
        "Make sure the file is a valid GeoJSON file and not a ZIP, SHP, or partial download.",
        "Rebuild the processed GeoJSON and run the importer again.",
      ],
      cause: error,
    });
  }

  if (collection?.type !== "FeatureCollection") {
    throw new ImportScriptError("The input JSON is not a GeoJSON FeatureCollection.", {
      details: [`Path: ${inputFile}`, `Found type: ${String(collection?.type ?? "undefined")}`],
      solutions: [
        "Point the importer at a processed ADM4 GeoJSON file.",
        "If you still have the HDX ZIP or shapefiles, convert them to GeoJSON first.",
      ],
    });
  }

  const features = Array.isArray(collection.features) ? collection.features : [];

  if (!features.length) {
    throw new ImportScriptError("The GeoJSON file contains no features.", {
      details: [`Path: ${inputFile}`],
      solutions: [
        "Check whether the file was generated correctly.",
        "Open the GeoJSON and confirm that it has a non-empty features array.",
      ],
    });
  }

  const cities = await annotateLocalityTypes(groupByCity(features));
  const totalChunks = cities.reduce((sum, city) => sum + chunkFeatures(city.features, chunkTargetBytes).length, 0);

  console.log(`Preparing ${features.length.toLocaleString()} features from ${inputFile}`);
  console.log(`Dataset: ${datasetId}`);
  console.log(
    `Cities: ${cities.length.toLocaleString()}, chunks: ${totalChunks.toLocaleString()}, target chunk size: ${chunkTargetBytes}`,
  );

  if (dryRun) {
    for (const city of cities) {
      const chunks = chunkFeatures(city.features, chunkTargetBytes);
      console.log(`${city.cityName}: ${city.features.length} features, ${chunks.length} chunks`);
    }

    return {
      chunkTargetBytes,
      cities,
      collection,
      features,
      totalChunks,
    };
  }

  const db = getAdminDb();
  const datasetRef = db.collection(DATASET_COLLECTION).doc(datasetId);
  const operations = [
    (batch) =>
      batch.set(datasetRef, {
        boundaryMode: "indicative",
        caveat: collection.metadata?.caveat ?? "Indicative boundaries only; not official legal boundary data.",
        cityCount: cities.length,
        count: features.length,
        datasetId,
        importedAt: new Date().toISOString(),
        province: collection.metadata?.province ?? cities[0]?.province ?? "",
        source: sourceName,
        sourceUrl,
        storage: {
          chunkTargetBytes,
          totalChunks,
        },
      }),
  ];

  for (const city of cities) {
    const chunks = chunkFeatures(city.features, chunkTargetBytes);
    const cityRef = datasetRef.collection("cities").doc(city.cityKey);

    operations.push((batch) =>
      batch.set(cityRef, {
        cityKey: city.cityKey,
        cityName: city.cityName,
        cityPcode: city.cityPcode,
        chunkCount: chunks.length,
        featureCount: city.features.length,
        localityType: city.localityType ?? null,
        normalizedCityName: city.normalizedCityName,
        province: city.province,
      }),
    );

    chunks.forEach((chunk, index) => {
      const featuresPayload = encodeFeatures(chunk);
      const chunkRef = cityRef.collection("chunks").doc(String(index).padStart(4, "0"));
      operations.push((batch) =>
        batch.set(chunkRef, {
          byteLength: Buffer.byteLength(featuresPayload, "utf8"),
          featuresEncoding: "gzip-base64",
          featuresPayload,
          index,
        }),
      );
    });
  }

  await commitBatch(db, operations);
  console.log(`Imported ${features.length.toLocaleString()} features into Firestore dataset ${datasetId}.`);

  return {
    chunkTargetBytes,
    cities,
    collection,
    features,
    totalChunks,
  };
}

export async function importBoundaryCacheToFirestore({
  cacheDir,
  chunkTargetBytes = DEFAULT_CHUNK_TARGET_BYTES,
  datasetId,
  dryRun = false,
  sourceName,
  sourceUrl,
}) {
  if (!datasetId) {
    throw new ImportScriptError("Missing Firestore dataset id.", {
      solutions: [
        "Pass --dataset=hdx-philippines-adm4 when running the importer.",
        "Or set FIRESTORE_BOUNDARY_DATASET_ID in your environment for the app runtime.",
      ],
    });
  }

  const manifestPath = path.join(cacheDir, "manifest.json");
  const manifest = await readJsonFile(manifestPath);

  if (!manifest || !Array.isArray(manifest.cities) || !manifest.cities.length) {
    throw new ImportScriptError("The HDX cache manifest is missing city entries.", {
      details: [`Manifest path: ${manifestPath}`],
      solutions: [
        "Run npm run import:hdx first to build the nationwide cache.",
        "Make sure the cache directory points to data/hdx/cod-ab-phl.",
      ],
    });
  }

  const cities = [];
  let featureCount = 0;
  let totalChunks = 0;

  console.log(`Preparing nationwide HDX cache import from ${cacheDir}`);
  console.log(`Dataset: ${datasetId}`);

  for (const [cityIndex, manifestCity] of manifest.cities.entries()) {
    const filePath = path.join(cacheDir, manifestCity.file);
    const rawFeatures = await readNdjsonFeatures(filePath);
    const features = rawFeatures.map((feature, index) => toMappingFeature(feature, index + 1));
    const cityName = manifestCity.adm3Name ?? getCityName(rawFeatures[0] ?? {});
    const cityPcode = manifestCity.adm3Pcode ?? getCityPcode(rawFeatures[0] ?? {});
    const cityKey = cityPcode || slugify(cityName);
    const province = manifestCity.adm2Name ?? getProvinceName(rawFeatures[0] ?? {});
    const chunks = chunkFeatures(features, chunkTargetBytes);

    cities.push({
      cityKey,
      cityName,
      cityPcode,
      chunkCount: chunks.length,
      chunks,
      featureCount: features.length,
      normalizedCityName: normalizeName(cityName),
      province,
    });

    featureCount += features.length;
    totalChunks += chunks.length;

    if ((cityIndex + 1) % 100 === 0 || cityIndex === manifest.cities.length - 1) {
      console.log(
        `[HDX Import] Prepared ${String(cityIndex + 1).padStart(4, " ")} / ${manifest.cities.length.toLocaleString()} cities (${featureCount.toLocaleString()} features, ${totalChunks.toLocaleString()} chunks)`,
      );
    }
  }

  const resolvedCities = await annotateLocalityTypes(cities);

  console.log(
    `Cities: ${resolvedCities.length.toLocaleString()}, features: ${featureCount.toLocaleString()}, chunks: ${totalChunks.toLocaleString()}`,
  );

  if (dryRun) {
    const topCities = [...resolvedCities]
      .sort((left, right) => right.featureCount - left.featureCount)
      .slice(0, 10);

    console.log("Top cities by feature count:");
    topCities.forEach((city) => {
      console.log(`- ${city.cityName}: ${city.featureCount} features, ${city.chunkCount} chunks`);
    });

    return {
      cacheDir,
      cities: resolvedCities,
      featureCount,
      manifest,
      totalChunks,
    };
  }

  const db = getAdminDb();
  const datasetRef = db.collection(DATASET_COLLECTION).doc(datasetId);
  const datasetDocument = {
    boundaryMode: "indicative",
    caveat: manifest.dataset?.caveat ?? "Indicative boundaries only; not official legal boundary data.",
    cityCount: resolvedCities.length,
    count: featureCount,
    datasetId,
    importedAt: new Date().toISOString(),
    province: "",
    source: sourceName,
    sourceUrl,
    storage: {
      chunkTargetBytes,
      totalChunks,
    },
  };
  const operations = [
    makeBatchOperation(
      `dataset metadata -> ${datasetRef.path}`,
      (batch) => batch.set(datasetRef, datasetDocument),
      estimateJsonByteLength(datasetDocument),
    ),
  ];

  for (const [cityIndex, city] of resolvedCities.entries()) {
    const cityRef = datasetRef.collection("cities").doc(city.cityKey);
    const cityDocument = {
      cityKey: city.cityKey,
      cityName: city.cityName,
      cityPcode: city.cityPcode,
      chunkCount: city.chunkCount,
      featureCount: city.featureCount,
      localityType: city.localityType ?? null,
      normalizedCityName: city.normalizedCityName,
      province: city.province,
    };

    operations.push(
      makeBatchOperation(
        `city metadata -> ${city.cityName} (${cityRef.path})`,
        (batch) => batch.set(cityRef, cityDocument),
        estimateJsonByteLength(cityDocument),
      ),
    );

    city.chunks.forEach((chunk, index) => {
      const featuresPayload = encodeFeatures(chunk);
      const chunkRef = cityRef.collection("chunks").doc(String(index).padStart(4, "0"));
      const chunkDocument = {
        byteLength: Buffer.byteLength(featuresPayload, "utf8"),
        featuresEncoding: "gzip-base64",
        featuresPayload,
        index,
      };
      operations.push(
        makeBatchOperation(
          `chunk ${index + 1}/${city.chunkCount} -> ${city.cityName} (${chunkRef.path})`,
          (batch) => batch.set(chunkRef, chunkDocument),
          estimateJsonByteLength(chunkDocument),
        ),
      );
    });

    if ((cityIndex + 1) % 100 === 0 || cityIndex === resolvedCities.length - 1) {
      console.log(
        `[HDX Import] Queued Firestore writes for ${String(cityIndex + 1).padStart(4, " ")} / ${resolvedCities.length.toLocaleString()} cities`,
      );
    }
  }

  console.log(`[HDX Import] Total Firestore write operations queued: ${operations.length.toLocaleString()}`);
  await commitBatch(db, operations);
  console.log(`Imported ${featureCount.toLocaleString()} features into Firestore dataset ${datasetId}.`);

  return {
      cacheDir,
      cities: resolvedCities,
      featureCount,
      manifest,
      totalChunks,
  };
}
