import { feature, featureCollection } from "@turf/helpers";
import { difference } from "@turf/difference";
import { union } from "@turf/union";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import type { BoundaryFeature, BoundaryFeatureCollection } from "@/lib/boundary-types";

type TurfPolygonFeature = Feature<Polygon | MultiPolygon, BoundaryFeature["properties"]>;

function toTurfFeature(boundaryFeature: BoundaryFeature): TurfPolygonFeature {
  return feature(boundaryFeature.geometry, boundaryFeature.properties);
}

function mergeFeatures(features: TurfPolygonFeature[]): Feature<Polygon | MultiPolygon> | null {
  if (!features.length) {
    return null;
  }

  if (features.length === 1) {
    return feature(features[0].geometry, {});
  }

  return union(featureCollection(features)) ?? null;
}

export function resolveNonOverlappingBoundaryCollections<T extends BoundaryFeatureCollection>(collections: T[]): T[] {
  let claimedGeometry: Feature<Polygon | MultiPolygon> | null = null;

  return collections.map((collection) => {
    const resolvedFeatures = collection.features
      .map((boundaryFeature) => {
        if (!claimedGeometry) {
          return boundaryFeature;
        }

        const clipped = difference(featureCollection([toTurfFeature(boundaryFeature), claimedGeometry]));

        if (!clipped) {
          return null;
        }

        return {
          ...boundaryFeature,
          geometry: clipped.geometry,
        };
      })
      .filter((boundaryFeature): boundaryFeature is BoundaryFeature => Boolean(boundaryFeature));

    const resolvedTurfFeatures = resolvedFeatures.map(toTurfFeature);
    const resolvedGeometry = mergeFeatures(resolvedTurfFeatures);

    if (resolvedGeometry) {
      claimedGeometry = claimedGeometry
        ? union(featureCollection([feature(claimedGeometry.geometry, {}), feature(resolvedGeometry.geometry, {})])) ?? claimedGeometry
        : feature(resolvedGeometry.geometry, {});
    }

    return {
      ...collection,
      features: resolvedFeatures,
      metadata: {
        ...collection.metadata,
        count: resolvedFeatures.length,
      },
    };
  });
}
