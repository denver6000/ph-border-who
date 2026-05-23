import path from "node:path";

import {
  DEFAULT_DATASET_ID,
  DEFAULT_INPUT_FILE,
  loadLocalEnvFiles,
  printImportError,
  parseArgs,
} from "./firestore-boundary-utils.mjs";
import { importBoundaryGeoJsonToFirestore } from "./firestore-boundary-importer.mjs";

loadLocalEnvFiles();

const args = parseArgs(process.argv.slice(2));
const inputFile = path.resolve(process.cwd(), args.get("input") ?? DEFAULT_INPUT_FILE);
const datasetId = args.get("dataset") ?? DEFAULT_DATASET_ID;
const chunkTargetBytes = Number(args.get("chunk-bytes") ?? 650_000);
const dryRun = args.has("dry-run");

try {
  await importBoundaryGeoJsonToFirestore({
    chunkTargetBytes,
    datasetId,
    dryRun,
    inputFile,
    sourceName: "BTAA / HDX COD-AB Philippines ADM4",
    sourceUrl: "https://geo.btaa.org/catalog/caf116df-f984-4deb-85ca-41b349d3f313",
  });
} catch (error) {
  printImportError(error);
  process.exitCode = 1;
}
