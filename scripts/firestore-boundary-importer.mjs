import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";

import {
  DATASET_COLLECTION,
  commitBatch,
  getAdminDb,
  getCityName,
  getCityPcode,
  getProvinceName,
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

export async function importBoundaryGeoJsonToFirestore({
  chunkTargetBytes = 650_000,
  datasetId,
  dryRun = false,
  inputFile,
  sourceName,
  sourceUrl,
}) {
  const raw = await fs.readFile(inputFile, "utf8");
  const collection = JSON.parse(raw);
  const features = Array.isArray(collection.features) ? collection.features : [];
  const cities = groupByCity(features);
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
