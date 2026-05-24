import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const DEFAULT_DATASET_ID = "hdx-philippines-adm4";
export const DEFAULT_HDX_CACHE_DIR = "data/hdx/cod-ab-phl";
export const DEFAULT_OUTPUT_FILE = "public/boundaries/firestore-hdx-philippines-adm4.geojson";
export const DATASET_COLLECTION = "boundaryDatasets";
export const DEFAULT_CHUNK_TARGET_BYTES = 650_000;
export const MAX_BATCH_WRITES = 400;
export const MAX_BATCH_ESTIMATED_BYTES = 8 * 1024 * 1024;

export class ImportScriptError extends Error {
  constructor(message, { details = [], solutions = [], cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ImportScriptError";
    this.details = details;
    this.solutions = solutions;
  }
}

export function makeBatchOperation(description, apply, estimatedBytes = 0) {
  return {
    apply,
    description,
    estimatedBytes,
  };
}

export function parseArgs(argv) {
  const parsed = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];

    if (!raw.startsWith("--")) {
      continue;
    }

    const normalized = raw.replace(/^--/, "");

    if (normalized.includes("=")) {
      const [key, ...rest] = normalized.split("=");
      parsed.set(key, rest.join("="));
      continue;
    }

    const next = argv[index + 1];

    if (next && !next.startsWith("--")) {
      parsed.set(normalized, next);
      index += 1;
      continue;
    }

    parsed.set(normalized, "true");
  }

  return parsed;
}

export function loadLocalEnvFiles(cwd = process.cwd()) {
  const candidates = [".env.local", ".env"];

  for (const candidate of candidates) {
    const envPath = path.resolve(cwd, candidate);

    if (!existsSync(envPath)) {
      continue;
    }

    const raw = readFileSync(envPath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

export function printImportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const details = Array.isArray(error?.details) ? error.details : [];
  const solutions = Array.isArray(error?.solutions) ? error.solutions : [];

  console.error("");
  console.error("[HDX Import] Import failed");
  console.error(`Reason: ${message}`);

  if (details.length) {
    console.error("");
    console.error("Details:");

    for (const detail of details) {
      console.error(`- ${detail}`);
    }
  }

  if (solutions.length) {
    console.error("");
    console.error("Possible fixes:");

    for (const solution of solutions) {
      console.error(`- ${solution}`);
    }
  }

  if (error instanceof Error && error.stack && !(error instanceof ImportScriptError)) {
    console.error("");
    console.error(error.stack);
  }
}

export function getAdminDb() {
  if (!getApps().length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const serviceAccountPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    let serviceAccount = null;

    if (!projectId) {
      throw new ImportScriptError("Missing Firebase project id.", {
        details: ["Neither FIREBASE_PROJECT_ID nor NEXT_PUBLIC_FIREBASE_PROJECT_ID is set."],
        solutions: [
          "Set FIREBASE_PROJECT_ID in your shell or .env before running the import.",
          "If you are importing locally, also set FIREBASE_SERVICE_ACCOUNT_PATH to a valid service account JSON file.",
        ],
      });
    }

    if (serviceAccountJson) {
      try {
        serviceAccount = JSON.parse(serviceAccountJson);
      } catch (error) {
        throw new ImportScriptError("FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON.", {
          details: ["The environment variable was present but could not be parsed."],
          solutions: [
            "Replace FIREBASE_SERVICE_ACCOUNT_KEY with a valid JSON string.",
            "Or remove it and use FIREBASE_SERVICE_ACCOUNT_PATH instead.",
          ],
          cause: error,
        });
      }
    } else if (serviceAccountPath) {
      if (!existsSync(serviceAccountPath)) {
        throw new ImportScriptError("Firebase service account file was not found.", {
          details: [`Path: ${serviceAccountPath}`],
          solutions: [
            "Check FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS.",
            "Point it to an existing service account JSON file for the target Firebase project.",
          ],
        });
      }

      try {
        serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
      } catch (error) {
        throw new ImportScriptError("Firebase service account file could not be parsed.", {
          details: [`Path: ${serviceAccountPath}`],
          solutions: [
            "Make sure the file is valid JSON.",
            "Download a fresh service account key if the file was truncated or edited.",
          ],
          cause: error,
        });
      }
    }

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
  let batchNumber = 1;
  let totalCommitted = 0;
  let batchDescriptions = [];
  let batchEstimatedBytes = 0;

  for (const operation of operations) {
    const apply = typeof operation === "function" ? operation : operation.apply;
    const description =
      typeof operation === "function" ? operation.description ?? "unnamed operation" : operation.description;
    const estimatedBytes =
      typeof operation === "function" ? operation.estimatedBytes ?? 0 : operation.estimatedBytes ?? 0;

    const wouldExceedWriteLimit = operationCount > 0 && operationCount + 1 > MAX_BATCH_WRITES;
    const wouldExceedByteLimit =
      operationCount > 0 && batchEstimatedBytes + estimatedBytes > MAX_BATCH_ESTIMATED_BYTES;

    if (wouldExceedWriteLimit || wouldExceedByteLimit) {
      console.log(
        `[HDX Import] Committing Firestore batch ${batchNumber} (${operationCount} writes, ~${batchEstimatedBytes.toLocaleString()} bytes, total queued: ${(totalCommitted + operationCount).toLocaleString()})`,
      );

      try {
        await batch.commit();
      } catch (error) {
        throw new ImportScriptError(`Firestore batch ${batchNumber} failed during commit.`, {
          details: [
            `Writes in failed batch: ${operationCount}`,
            `Estimated bytes in failed batch: ${batchEstimatedBytes.toLocaleString()}`,
            `Total writes committed before failure: ${totalCommitted}`,
            `First operation: ${batchDescriptions[0] ?? "n/a"}`,
            `Last operation: ${batchDescriptions[batchDescriptions.length - 1] ?? "n/a"}`,
          ],
          solutions: [
            "Re-run the import and note which batch fails consistently.",
            "Check Firestore quotas, document size limits, and write throughput for the target project.",
            "If this keeps failing at the same city, inspect that city's chunk payload size and feature count.",
          ],
          cause: error,
        });
      }

      totalCommitted += operationCount;
      console.log(`[HDX Import] Batch ${batchNumber} committed successfully.`);
      batch = db.batch();
      operationCount = 0;
      batchDescriptions = [];
      batchEstimatedBytes = 0;
      batchNumber += 1;
    }

    apply(batch);
    operationCount += 1;
    batchDescriptions.push(description);
    batchEstimatedBytes += estimatedBytes;
  }

  if (operationCount > 0) {
    console.log(
      `[HDX Import] Committing Firestore batch ${batchNumber} (${operationCount} writes, ~${batchEstimatedBytes.toLocaleString()} bytes, total queued: ${(totalCommitted + operationCount).toLocaleString()})`,
    );

    try {
      await batch.commit();
    } catch (error) {
      throw new ImportScriptError(`Firestore batch ${batchNumber} failed during commit.`, {
        details: [
          `Writes in failed batch: ${operationCount}`,
          `Estimated bytes in failed batch: ${batchEstimatedBytes.toLocaleString()}`,
          `Total writes committed before failure: ${totalCommitted}`,
          `First operation: ${batchDescriptions[0] ?? "n/a"}`,
          `Last operation: ${batchDescriptions[batchDescriptions.length - 1] ?? "n/a"}`,
        ],
        solutions: [
          "Re-run the import and note which batch fails consistently.",
          "Check Firestore quotas, document size limits, and write throughput for the target project.",
          "If this keeps failing at the same city, inspect that city's chunk payload size and feature count.",
        ],
        cause: error,
      });
    }

    totalCommitted += operationCount;
    console.log(`[HDX Import] Batch ${batchNumber} committed successfully.`);
  }

  console.log(`[HDX Import] Finished committing ${totalCommitted.toLocaleString()} Firestore writes.`);
}
