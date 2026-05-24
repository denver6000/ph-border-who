import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import type { BoundaryFeatureCollection, BoundaryFeature } from "@/lib/boundary-types";
import { queryFirestoreBarangayBoundaries } from "@/lib/firestore-boundaries";

type ResolveCityBoundaryArgs = {
  city?: string;
  country?: string;
  locationLabel?: string;
  province?: string;
  relationId?: number;
};

function dissolveCityGeometry(features: BoundaryFeature[]) {
  const polygonFeatures = features.map((feature) =>
    turf.feature(feature.geometry as Polygon | MultiPolygon, {
      id: feature.properties.id,
      name: feature.properties.name,
    }),
  );

  if (!polygonFeatures.length) {
    return null;
  }

  if (polygonFeatures.length === 1) {
    return polygonFeatures[0].geometry as Polygon | MultiPolygon;
  }

  try {
    const unioned = turf.union(turf.featureCollection(polygonFeatures)) as Feature<Polygon | MultiPolygon> | null;

    return unioned?.geometry ?? null;
  } catch {
    const combined = turf.combine(turf.featureCollection(polygonFeatures));
    const geometry = combined.features[0]?.geometry;

    if (geometry?.type === "MultiPolygon") {
      return geometry;
    }

    return null;
  }
}

function buildCityBoundaryCollection({
  boundaryKind,
  city,
  country,
  geometry,
  id,
  province,
  source,
  sourceType,
}: {
  boundaryKind: "indicative";
  city: string;
  country: string;
  geometry: Polygon | MultiPolygon;
  id: number;
  province?: string;
  source: string;
  sourceType: "firestore-hdx-cod-ab";
}): BoundaryFeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry,
        properties: {
          boundaryKind,
          id,
          name: city,
          sourceType,
        },
      },
    ],
    metadata: {
      adminLevels: ["6", "7", "8"],
      boundaryMode: boundaryKind,
      city,
      count: 1,
      country,
      generatedAt: new Date().toISOString(),
      province,
      source,
    },
  };
}

function hashCityId(city: string, province?: string) {
  const value = `${city}|${province ?? ""}`;
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }

  return hash || 1;
}

async function queryFirestoreCityBoundary({
  city,
  country = "Philippines",
  province,
}: {
  city?: string;
  country?: string;
  province?: string;
}) {
  const firestoreBarangays = await queryFirestoreBarangayBoundaries({
    city,
    country,
    province,
  });

  if (!firestoreBarangays?.features.length) {
    return null;
  }

  const geometry = dissolveCityGeometry(firestoreBarangays.features);

  if (!geometry) {
    return null;
  }

  return buildCityBoundaryCollection({
    boundaryKind: "indicative",
    city: firestoreBarangays.metadata.city,
    country,
    geometry,
    id: hashCityId(firestoreBarangays.metadata.city, firestoreBarangays.metadata.province),
    province: firestoreBarangays.metadata.province,
    source: firestoreBarangays.metadata.source,
    sourceType: "firestore-hdx-cod-ab",
  });
}

export async function resolveCityBoundary({
  city,
  country = "Philippines",
  locationLabel,
  province,
}: ResolveCityBoundaryArgs): Promise<BoundaryFeatureCollection> {
  const firestoreBoundary = await queryFirestoreCityBoundary({
    city,
    country,
    province: province ?? locationLabel,
  });

  if (firestoreBoundary) {
    return firestoreBoundary;
  }

  if (!city) {
    throw new Error('Missing required "city" query parameter.');
  }

  return {
    type: "FeatureCollection",
    features: [],
    metadata: {
      adminLevels: ["6", "7", "8"],
      boundaryMode: "indicative",
      city,
      count: 0,
      country,
      generatedAt: new Date().toISOString(),
      province: province ?? locationLabel,
      source: "Firestore boundary dataset",
    },
  };
}
