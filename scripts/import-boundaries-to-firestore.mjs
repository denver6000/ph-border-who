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
const sourceName = args.get("source") ?? "HDX/OCHA Philippines COD-AB ADM4";
const sourceUrl = args.get("source-url") ?? "https://data.humdata.org/dataset/cod-ab-phl";
const chunkTargetBytes = Number(args.get("chunk-bytes") ?? 650_000);
const dryRun = args.has("dry-run");
try {
  await importBoundaryGeoJsonToFirestore({
    chunkTargetBytes,
    datasetId,
    dryRun,
    inputFile,
    sourceName,
    sourceUrl,
  });
} catch (error) {
  printImportError(error);
  process.exitCode = 1;
}
