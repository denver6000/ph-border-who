import path from "node:path";

import {
  DEFAULT_CHUNK_TARGET_BYTES,
  DEFAULT_HDX_CACHE_DIR,
  DEFAULT_DATASET_ID,
  loadLocalEnvFiles,
  printImportError,
  parseArgs,
} from "./firestore-boundary-utils.mjs";
import { importBoundaryCacheToFirestore } from "./firestore-boundary-importer.mjs";

loadLocalEnvFiles();

const args = parseArgs(process.argv.slice(2));
const cacheDir = path.resolve(process.cwd(), args.get("cache-dir") ?? DEFAULT_HDX_CACHE_DIR);
const datasetId = args.get("dataset") ?? DEFAULT_DATASET_ID;
const sourceName = args.get("source") ?? "HDX/OCHA Philippines COD-AB ADM4";
const sourceUrl = args.get("source-url") ?? "https://data.humdata.org/dataset/cod-ab-phl";
const dryRun = args.has("dry-run");
try {
  await importBoundaryCacheToFirestore({
    cacheDir,
    chunkTargetBytes: DEFAULT_CHUNK_TARGET_BYTES,
    datasetId,
    dryRun,
    sourceName,
    sourceUrl,
  });
} catch (error) {
  printImportError(error);
  process.exitCode = 1;
}
