import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import type { BoundaryFeature, BoundaryFeatureCollection } from "@/lib/boundary-types";
import { queryNativeZones } from "@/lib/native-zones";
import { queryCityBoundaryBySearch } from "@/lib/overpass";

type PolygonalFeature = Feature<Polygon | MultiPolygon, BoundaryFeature["properties"]>;

export type MunicipalityBoundaryComparison = {
  locality: string;
  native: BoundaryFeatureCollection;
  osm: BoundaryFeatureCollection;
  province?: string;
  stats: {
    algorithmicCompensation: {
      applied: boolean;
      generatedPointPercent: number;
      note: string;
    };
    areaDeltaM2: number | null;
    areaDeltaPercentOfNative: number | null;
    intersectionAreaM2: number;
    iou: number | null;
    nativeAreaM2: number | null;
    nativeOnlyAreaM2: number | null;
    nativeOverlapPercent: number | null;
    nativeVertexCount: number;
    osmAreaM2: number | null;
    osmOnlyAreaM2: number | null;
    osmOverlapPercent: number | null;
    osmVertexCount: number;
  };
};

function primaryFeature(collection: BoundaryFeatureCollection) {
  return collection.features[0] ?? null;
}

function toTurfFeature(feature: BoundaryFeature | null): PolygonalFeature | null {
  if (!feature) {
    return null;
  }

  return turf.feature(feature.geometry as Polygon | MultiPolygon, feature.properties);
}

function countRingVertices(feature: BoundaryFeature | null) {
  if (!feature) {
    return 0;
  }

  if (feature.geometry.type === "Polygon") {
    return feature.geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0);
  }

  return feature.geometry.coordinates.reduce(
    (sum, polygon) => sum + polygon.reduce((polygonSum, ring) => polygonSum + ring.length, 0),
    0,
  );
}

function safeArea(feature: PolygonalFeature | null) {
  return feature ? turf.area(feature) : null;
}

function overlapStats(nativeFeature: PolygonalFeature | null, osmFeature: PolygonalFeature | null) {
  const nativeAreaM2 = safeArea(nativeFeature);
  const osmAreaM2 = safeArea(osmFeature);

  if (!nativeFeature || !osmFeature || !nativeAreaM2 || !osmAreaM2) {
    return {
      areaDeltaM2: nativeAreaM2 !== null && osmAreaM2 !== null ? osmAreaM2 - nativeAreaM2 : null,
      areaDeltaPercentOfNative: nativeAreaM2 && osmAreaM2 !== null ? ((osmAreaM2 - nativeAreaM2) / nativeAreaM2) * 100 : null,
      intersectionAreaM2: 0,
      iou: null,
      nativeAreaM2,
      nativeOnlyAreaM2: nativeAreaM2,
      nativeOverlapPercent: null,
      osmAreaM2,
      osmOnlyAreaM2: osmAreaM2,
      osmOverlapPercent: null,
    };
  }

  const intersection = turf.intersect(turf.featureCollection([nativeFeature, osmFeature]));
  const intersectionAreaM2 = intersection ? turf.area(intersection) : 0;
  const unionAreaM2 = nativeAreaM2 + osmAreaM2 - intersectionAreaM2;

  return {
    areaDeltaM2: osmAreaM2 - nativeAreaM2,
    areaDeltaPercentOfNative: ((osmAreaM2 - nativeAreaM2) / nativeAreaM2) * 100,
    intersectionAreaM2,
    iou: unionAreaM2 > 0 ? intersectionAreaM2 / unionAreaM2 : null,
    nativeAreaM2,
    nativeOnlyAreaM2: Math.max(nativeAreaM2 - intersectionAreaM2, 0),
    nativeOverlapPercent: (intersectionAreaM2 / nativeAreaM2) * 100,
    osmAreaM2,
    osmOnlyAreaM2: Math.max(osmAreaM2 - intersectionAreaM2, 0),
    osmOverlapPercent: (intersectionAreaM2 / osmAreaM2) * 100,
  };
}

export async function compareMunicipalityNativeAndOsm({
  locality,
  province,
}: {
  locality: string;
  province?: string;
}): Promise<MunicipalityBoundaryComparison> {
  const [native, osm] = await Promise.all([
    queryNativeZones({
      country: "PH",
      locality,
      province,
    }),
    queryCityBoundaryBySearch({
      city: locality,
      country: "Philippines",
      province,
    }) as Promise<BoundaryFeatureCollection>,
  ]);
  const nativeFeature = primaryFeature(native);
  const osmFeature = primaryFeature(osm);
  const stats = overlapStats(toTurfFeature(nativeFeature), toTurfFeature(osmFeature));

  return {
    locality,
    native,
    osm,
    province,
    stats: {
      ...stats,
      algorithmicCompensation: {
        applied: false,
        generatedPointPercent: 0,
        note: "No correction or AI compensation is applied in this view. Native and OSM outlines are rendered raw for inspection.",
      },
      nativeVertexCount: countRingVertices(nativeFeature),
      osmVertexCount: countRingVertices(osmFeature),
    },
  };
}
