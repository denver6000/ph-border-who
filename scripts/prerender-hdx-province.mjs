import { promises as fs } from "node:fs";
import path from "node:path";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);

const province = args.get("province") ?? "Nueva Ecija";
const cacheDir = path.resolve(process.cwd(), args.get("cache-dir") ?? path.join("data", "hdx", "cod-ab-phl"));
const outputDir = path.resolve(process.cwd(), args.get("output-dir") ?? path.join("public", "boundaries"));

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeName(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function repairMojibake(value) {
  if (!/[ÃÂ]/.test(value)) {
    return value;
  }

  try {
    return Buffer.from(value, "latin1").toString("utf8");
  } catch {
    return value;
  }
}

function repairStrings(value) {
  if (typeof value === "string") {
    return repairMojibake(value);
  }

  if (Array.isArray(value)) {
    return value.map(repairStrings);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, repairStrings(entry)]));
  }

  return value;
}

async function readNdjson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => repairStrings(JSON.parse(line)));
}

function toPublicFeature(feature) {
  const properties = feature.properties ?? {};

  return {
    geometry: feature.geometry,
    properties: {
      adm1Name: properties.ADM1_EN ?? properties.adm1_en,
      adm1Pcode: properties.ADM1_PCODE ?? properties.adm1_pcode,
      adm2Name: properties.ADM2_EN ?? properties.adm2_en,
      adm2Pcode: properties.ADM2_PCODE ?? properties.adm2_pcode,
      adm3Name: properties.ADM3_EN ?? properties.adm3_en,
      adm3Pcode: properties.ADM3_PCODE ?? properties.adm3_pcode,
      adm4Name: properties.ADM4_EN ?? properties.adm4_en,
      adm4Pcode: properties.ADM4_PCODE ?? properties.adm4_pcode,
      boundaryKind: "indicative",
      sourceType: "hdx-cod-ab",
    },
    type: "Feature",
  };
}

const manifestPath = path.join(cacheDir, "manifest.json");
const manifest = repairStrings(JSON.parse(await fs.readFile(manifestPath, "utf8")));
const provinceKey = normalizeName(province);
const cities = manifest.cities.filter((city) => normalizeName(city.adm2Name ?? "") === provinceKey);

if (!cities.length) {
  throw new Error(`No HDX cached city files found for province "${province}".`);
}

const features = [];

for (const city of cities) {
  const cityFeatures = await readNdjson(path.join(cacheDir, city.file));
  features.push(...cityFeatures.map(toPublicFeature));
}

features.sort((left, right) => {
  const cityCompare = String(left.properties.adm3Name).localeCompare(String(right.properties.adm3Name));

  if (cityCompare !== 0) {
    return cityCompare;
  }

  return String(left.properties.adm4Name).localeCompare(String(right.properties.adm4Name));
});

const provinceSlug = slugify(province);
const collection = {
  features,
  metadata: {
    boundaryMode: "indicative",
    caveat: manifest.dataset.caveat,
    cityCount: cities.length,
    count: features.length,
    generatedAt: new Date().toISOString(),
    province: repairMojibake(province),
    source: manifest.dataset.name,
    sourceUrl: manifest.dataset.sourceUrl,
  },
  type: "FeatureCollection",
};
const summary = {
  ...collection.metadata,
  cities: cities
    .map((city) => ({
      adm3Name: repairMojibake(city.adm3Name),
      adm3Pcode: city.adm3Pcode,
      barangayCount: city.featureCount,
    }))
    .sort((left, right) => left.adm3Name.localeCompare(right.adm3Name)),
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, `${provinceSlug}-barangays.geojson`), `${JSON.stringify(collection)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, `${provinceSlug}-barangays-summary.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(`Prerendered ${features.length.toLocaleString()} barangays across ${cities.length} cities/municipalities.`);
console.log(`GeoJSON: ${path.join(outputDir, `${provinceSlug}-barangays.geojson`)}`);
console.log(`Summary: ${path.join(outputDir, `${provinceSlug}-barangays-summary.json`)}`);
