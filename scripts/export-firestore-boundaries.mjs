import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  DATASET_COLLECTION,
  DEFAULT_DATASET_ID,
  DEFAULT_OUTPUT_FILE,
  getAdminDb,
  parseArgs,
} from "./firestore-boundary-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const datasetId = args.get("dataset") ?? DEFAULT_DATASET_ID;
const outputFile = path.resolve(process.cwd(), args.get("output") ?? DEFAULT_OUTPUT_FILE);
const cityFilter = args.get("city");

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bcity of\b/g, "")
    .replace(/\bcity\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function decodeChunkFeatures(chunk) {
  if (chunk.featuresEncoding === "gzip-base64" && typeof chunk.featuresPayload === "string") {
    return JSON.parse(gunzipSync(Buffer.from(chunk.featuresPayload, "base64")).toString("utf8"));
  }

  if (typeof chunk.featuresJson === "string") {
    return JSON.parse(chunk.featuresJson);
  }

  return chunk.features;
}

const db = getAdminDb();
const datasetRef = db.collection(DATASET_COLLECTION).doc(datasetId);
const datasetSnapshot = await datasetRef.get();

if (!datasetSnapshot.exists) {
  throw new Error(`Firestore dataset not found: ${datasetId}`);
}

let citiesSnapshot = await datasetRef.collection("cities").orderBy("cityName").get();
let cityDocs = citiesSnapshot.docs;

if (cityFilter) {
  const expected = normalizeName(cityFilter);
  cityDocs = cityDocs.filter((doc) => normalizeName(doc.data().cityName) === expected);
}

const features = [];

for (const cityDoc of cityDocs) {
  const cityData = cityDoc.data();
  const chunksSnapshot = await cityDoc.ref.collection("chunks").orderBy("index").get();

  chunksSnapshot.docs.forEach((chunkDoc) => {
    const chunk = chunkDoc.data();

    if (cityData.chunkCount !== undefined && (chunk.index ?? 0) >= cityData.chunkCount) {
      return;
    }

    const chunkFeatures = decodeChunkFeatures(chunk);

    if (Array.isArray(chunkFeatures)) {
      features.push(...chunkFeatures);
    }
  });
}

const dataset = datasetSnapshot.data();
const collection = {
  features,
  metadata: {
    boundaryMode: dataset?.boundaryMode ?? "indicative",
    caveat: dataset?.caveat,
    city: cityFilter,
    cityCount: cityDocs.length,
    count: features.length,
    datasetId,
    generatedAt: new Date().toISOString(),
    province: dataset?.province,
    source: dataset?.source,
    sourceUrl: dataset?.sourceUrl,
  },
  type: "FeatureCollection",
};

await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, `${JSON.stringify(collection)}\n`, "utf8");

console.log(`Exported ${features.length.toLocaleString()} features from Firestore dataset ${datasetId}.`);
console.log(outputFile);
