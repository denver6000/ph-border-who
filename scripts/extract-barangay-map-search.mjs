import { promises as fs } from "node:fs";
import path from "node:path";

const inputFile = path.resolve(process.cwd(), "barangay_map_search (5).html");
const outputFile = path.resolve(process.cwd(), "public", "boundaries", "barangay-map-search-nueva-ecija.geojson");

function closeRing(coordinates) {
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];

  if (!first || !last) {
    return coordinates;
  }

  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...coordinates, first];
  }

  return coordinates;
}

const html = await fs.readFile(inputFile, "utf8");
const match = html.match(/var BDATA=(.*?);var COLORS=/s);

if (!match?.[1]) {
  throw new Error("Could not find BDATA in barangay_map_search HTML.");
}

const bdata = JSON.parse(match[1]);
const features = Object.entries(bdata)
  .map(([key, value]) => {
    const coords = value.coords?.map((point) => [point.lng, point.lat]);

    if (!coords || coords.length < 3) {
      return null;
    }

    return {
      geometry: {
        coordinates: [closeRing(coords)],
        type: "Polygon",
      },
      properties: {
        city: value.city,
        key,
        name: value.name,
        psgc: String(value.psgc),
        sourceType: "barangay-map-search",
      },
      type: "Feature",
    };
  })
  .filter(Boolean)
  .sort((left, right) => {
    const cityCompare = left.properties.city.localeCompare(right.properties.city);

    if (cityCompare !== 0) {
      return cityCompare;
    }

    return left.properties.name.localeCompare(right.properties.name);
  });

const collection = {
  features,
  metadata: {
    count: features.length,
    generatedAt: new Date().toISOString(),
    source: "barangay_map_search (5).html",
  },
  type: "FeatureCollection",
};

await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, `${JSON.stringify(collection)}\n`, "utf8");

console.log(`Extracted ${features.length.toLocaleString()} barangay_map_search polygons.`);
console.log(outputFile);
