import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import extract from "extract-zip";
import shapefile from "shapefile";
import * as turf from "@turf/turf";

const HDX_SHP_URL =
  "https://data.humdata.org/dataset/caf116df-f984-4deb-85ca-41b349d3f313/resource/12457689-6a86-4474-8032-5ca9464d38a8/download/phl_adm_psa_namria_20231106_shp.zip";
const OUTPUT_DIR = path.resolve(process.cwd(), "data", "hdx", "cod-ab-phl");
const CACHE_DIR = path.resolve(process.cwd(), ".cache", "hdx");
const ZIP_PATH = path.join(CACHE_DIR, "phl_adm_psa_namria_20231106_shp.zip");
const EXTRACT_DIR = path.join(CACHE_DIR, "phl_adm_psa_namria_20231106_shp");
const ADM4_DIR = path.join(OUTPUT_DIR, "adm4");

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const simplifyTolerance = Number(args.get("simplify") ?? 0);
const forceDownload = args.has("force-download");

function pick(properties, ...keys) {
  const entries = Object.entries(properties);

  for (const key of keys) {
    const match = entries.find(([candidateKey]) => candidateKey.toLowerCase() === key.toLowerCase());

    if (typeof match?.[1] === "string" && match[1].trim()) {
      return match[1].trim();
    }
  }

  return undefined;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadZip() {
  if (!forceDownload && (await exists(ZIP_PATH))) {
    console.log(`Using cached HDX ZIP: ${ZIP_PATH}`);
    return;
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  console.log(`Downloading HDX shapefile ZIP. This is large: ${HDX_SHP_URL}`);
  const response = await fetch(HDX_SHP_URL, {
    headers: {
      "User-Agent": "CityBaranggay HDX boundary importer",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`HDX download failed with status ${response.status}`);
  }

  await pipeline(response.body, createWriteStream(ZIP_PATH));
}

async function extractZip() {
  if ((await exists(EXTRACT_DIR)) && !args.has("force-extract")) {
    console.log(`Using extracted HDX ZIP: ${EXTRACT_DIR}`);
    return;
  }

  await fs.rm(EXTRACT_DIR, { force: true, recursive: true });
  await fs.mkdir(EXTRACT_DIR, { recursive: true });
  console.log(`Extracting HDX ZIP to ${EXTRACT_DIR}`);
  await extract(ZIP_PATH, { dir: EXTRACT_DIR });
}

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? walkFiles(fullPath) : fullPath;
    }),
  );

  return files.flat();
}

async function findAdm4Shapefile() {
  const files = await walkFiles(EXTRACT_DIR);
  const shp = files.find((file) => /adm4/i.test(path.basename(file)) && path.extname(file).toLowerCase() === ".shp");

  if (!shp) {
    throw new Error("Could not find ADM4 .shp file in the HDX archive.");
  }

  const dbf = shp.replace(/\.shp$/i, ".dbf");

  if (!(await exists(dbf))) {
    throw new Error(`Could not find matching DBF for ${shp}`);
  }

  return { dbf, shp };
}

async function appendFeature(filePath, feature) {
  await fs.appendFile(filePath, `${JSON.stringify(feature)}\n`, "utf8");
}

function toOutputFeature(feature) {
  const properties = feature.properties ?? {};
  const output = {
    geometry: feature.geometry,
    properties,
    type: "Feature",
  };

  if (simplifyTolerance > 0 && output.geometry) {
    return turf.simplify(output, {
      highQuality: false,
      mutate: false,
      tolerance: simplifyTolerance,
    });
  }

  return output;
}

async function buildCache() {
  const { dbf, shp } = await findAdm4Shapefile();
  const source = await shapefile.open(shp, dbf);
  const cities = new Map();
  let count = 0;

  await fs.rm(ADM4_DIR, { force: true, recursive: true });
  await fs.mkdir(ADM4_DIR, { recursive: true });

  while (true) {
    const next = await source.read();

    if (next.done) {
      break;
    }

    const feature = next.value;
    const properties = feature.properties ?? {};
    const adm3Pcode = pick(properties, "ADM3_PCODE", "adm3_pcode");
    const adm3Name = pick(properties, "ADM3_EN", "adm3_en");

    if (!adm3Pcode || !adm3Name || !feature.geometry) {
      continue;
    }

    const file = path.join("adm4", `${adm3Pcode}.ndjson`).replace(/\\/g, "/");
    const existing = cities.get(adm3Pcode);

    cities.set(adm3Pcode, {
      adm1Name: pick(properties, "ADM1_EN", "adm1_en"),
      adm1Pcode: pick(properties, "ADM1_PCODE", "adm1_pcode"),
      adm2Name: pick(properties, "ADM2_EN", "adm2_en"),
      adm2Pcode: pick(properties, "ADM2_PCODE", "adm2_pcode"),
      adm3Name,
      adm3Pcode,
      featureCount: (existing?.featureCount ?? 0) + 1,
      file,
    });

    await appendFeature(path.join(OUTPUT_DIR, file), toOutputFeature(feature));
    count += 1;

    if (count % 1000 === 0) {
      console.log(`Processed ${count.toLocaleString()} ADM4 features...`);
    }
  }

  const manifest = {
    cities: Array.from(cities.values()).sort((left, right) => left.adm3Name.localeCompare(right.adm3Name)),
    dataset: {
      attribution: "National Mapping and Resource Information Authority (NAMRIA), Philippine Statistics Authority (PSA), OCHA COD-AB",
      caveat: "Indicative boundaries only; not official legal boundary data.",
      name: "HDX/OCHA Philippines COD-AB ADM4",
      sourceUrl: "https://data.humdata.org/dataset/cod-ab-phl",
    },
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(OUTPUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Imported ${count.toLocaleString()} barangay features into ${OUTPUT_DIR}`);
}

await downloadZip();
await extractZip();
await buildCache();
