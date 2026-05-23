import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  DATASET_COLLECTION,
  DEFAULT_DATASET_ID,
  DEFAULT_INPUT_FILE,
  commitBatch,
  getAdminDb,
  getCityName,
  getCityPcode,
  getProvinceName,
  normalizeName,
  parseArgs,
  slugify,
  toMappingFeature,
} from "./firestore-boundary-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputFile = path.resolve(process.cwd(), args.get("input") ?? DEFAULT_INPUT_FILE);
const datasetId = args.get("dataset") ?? DEFAULT_DATASET_ID;
const sourceName = args.get("source") ?? "HDX/OCHA Philippines COD-AB ADM4";
const sourceUrl = args.get("source-url") ?? "https://data.humdata.org/dataset/cod-ab-phl";
const chunkTargetBytes = Number(args.get("chunk-bytes") ?? 650_000);
const dryRun = args.has("dry-run");

function encodeFeatures(features) {
  return gzipSync(JSON.stringify(features)).toString("base64");
}

function encodedByteLength(features) {
  return Buffer.byteLength(encodeFeatures(features), "utf8");
}

function groupByCity(features) {
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

function chunkFeatures(features) {
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

const raw = await fs.readFile(inputFile, "utf8");
const collection = JSON.parse(raw);
const features = Array.isArray(collection.features) ? collection.features : [];
const cities = groupByCity(features);
const totalChunks = cities.reduce((sum, city) => sum + chunkFeatures(city.features).length, 0);

console.log(`Preparing ${features.length.toLocaleString()} features from ${inputFile}`);
console.log(`Dataset: ${datasetId}`);
console.log(`Cities: ${cities.length.toLocaleString()}, chunks: ${totalChunks.toLocaleString()}, target chunk size: ${chunkTargetBytes}`);

if (dryRun) {
  for (const city of cities) {
    const chunks = chunkFeatures(city.features);
    console.log(`${city.cityName}: ${city.features.length} features, ${chunks.length} chunks`);
  }

  process.exit(0);
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
  const chunks = chunkFeatures(city.features);
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
