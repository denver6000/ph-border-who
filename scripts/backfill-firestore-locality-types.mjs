import {
  DEFAULT_DATASET_ID,
  DATASET_COLLECTION,
  commitBatch,
  getAdminDb,
  getPsgcLocalityKind,
  loadLocalEnvFiles,
  makeBatchOperation,
  parseArgs,
  printImportError,
} from "./firestore-boundary-utils.mjs";

loadLocalEnvFiles();

const args = parseArgs(process.argv.slice(2));
const datasetId = args.get("dataset") ?? DEFAULT_DATASET_ID;
const dryRun = args.has("dry-run");
const onlyMissing = args.has("only-missing");
const limit = args.get("limit") ? Number(args.get("limit")) : undefined;

function estimateJsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function backfillLocalityTypes() {
  const db = getAdminDb();
  const citiesRef = db.collection(DATASET_COLLECTION).doc(datasetId).collection("cities");
  const snapshot = await citiesRef.get();

  if (snapshot.empty) {
    console.log(`No city documents found for dataset ${datasetId}.`);
    return;
  }

  const updates = [];
  const skipped = {
    alreadySet: 0,
    unmatched: 0,
  };

  for (const doc of snapshot.docs) {
    if (limit && updates.length >= limit) {
      break;
    }

    const data = doc.data();
    const currentLocalityType = data.localityType ?? null;

    if (onlyMissing && currentLocalityType) {
      skipped.alreadySet += 1;
      continue;
    }

    const localityType = await getPsgcLocalityKind({
      name: data.cityName,
      province: data.province,
    });

    if (!localityType) {
      skipped.unmatched += 1;
      continue;
    }

    if (currentLocalityType === localityType) {
      skipped.alreadySet += 1;
      continue;
    }

    updates.push({
      cityName: data.cityName,
      localityType,
      path: doc.ref.path,
    });
  }

  console.log(`Dataset: ${datasetId}`);
  console.log(`City docs scanned: ${snapshot.size}`);
  console.log(`Docs queued for localityType update: ${updates.length}`);
  console.log(`Skipped unchanged/already set: ${skipped.alreadySet}`);
  console.log(`Skipped unmatched: ${skipped.unmatched}`);

  if (dryRun || !updates.length) {
    updates.slice(0, 20).forEach((entry) => {
      console.log(`- ${entry.cityName}: ${entry.localityType} -> ${entry.path}`);
    });
    return;
  }

  const operations = updates.map((entry) =>
    makeBatchOperation(
      `localityType -> ${entry.cityName} (${entry.path})`,
      (batch) =>
        batch.set(
          db.doc(entry.path),
          {
            localityType: entry.localityType,
          },
          { merge: true },
        ),
      estimateJsonByteLength({
        localityType: entry.localityType,
      }),
    ),
  );

  await commitBatch(db, operations);
  console.log(`Updated localityType for ${updates.length} city documents.`);
}

try {
  await backfillLocalityTypes();
} catch (error) {
  printImportError(error);
  process.exitCode = 1;
}
