import { readFileSync } from "node:fs";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const DEFAULT_DATASET_ID = "hdx-nueva-ecija";
export const DEFAULT_INPUT_FILE = "public/boundaries/nueva-ecija-barangays.geojson";
export const DEFAULT_OUTPUT_FILE = "public/boundaries/firestore-nueva-ecija-barangays.geojson";
export const DATASET_COLLECTION = "boundaryDatasets";

export function parseArgs(argv) {
  return new Map(
    argv.map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.length ? rest.join("=") : "true"];
    }),
  );
}

export function getAdminDb() {
  if (!getApps().length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const serviceAccountPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const serviceAccount = serviceAccountJson
      ? JSON.parse(serviceAccountJson)
      : serviceAccountPath
        ? JSON.parse(readFileSync(serviceAccountPath, "utf8"))
        : null;

    if (serviceAccount) {
      initializeApp({
        credential: cert(serviceAccount),
        projectId,
      });
    } else {
      initializeApp({
        projectId,
      });
    }
  }

  return getFirestore();
}

export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bcity of\b/g, "")
    .replace(/\bcity\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slugify(value) {
  return normalizeName(value).replace(/\s+/g, "-") || "unknown";
}

export function getCityName(feature) {
  return String(feature.properties?.adm3Name ?? feature.properties?.city ?? feature.properties?.ADM3_EN ?? "Unknown city");
}

export function getProvinceName(feature) {
  return String(feature.properties?.adm2Name ?? feature.properties?.province ?? feature.properties?.ADM2_EN ?? "");
}

export function getBarangayName(feature) {
  return String(feature.properties?.adm4Name ?? feature.properties?.name ?? feature.properties?.ADM4_EN ?? "Unnamed barangay");
}

export function getBarangayPcode(feature) {
  return String(feature.properties?.adm4Pcode ?? feature.properties?.psgc ?? feature.properties?.ADM4_PCODE ?? "");
}

export function getCityPcode(feature) {
  return String(feature.properties?.adm3Pcode ?? feature.properties?.ADM3_PCODE ?? "");
}

export function toMappingFeature(feature, fallbackId = 0) {
  const psgcCode = getBarangayPcode(feature);

  return {
    geometry: feature.geometry,
    properties: {
      boundaryKind: "indicative",
      city: getCityName(feature),
      id: Number(psgcCode) || fallbackId,
      name: getBarangayName(feature),
      psgcCode,
      sourceType: "firestore-hdx-cod-ab",
    },
    type: "Feature",
  };
}

export async function commitBatch(db, operations) {
  let batch = db.batch();
  let operationCount = 0;

  for (const operation of operations) {
    operation(batch);
    operationCount += 1;

    if (operationCount === 450) {
      await batch.commit();
      batch = db.batch();
      operationCount = 0;
    }
  }

  if (operationCount > 0) {
    await batch.commit();
  }
}
