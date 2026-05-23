import * as turf from "@turf/turf";
import type { BBox, Feature, FeatureCollection, MultiPolygon, Point, Polygon } from "geojson";

export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

export type GeoJsonMultiPolygon = {
  type: "MultiPolygon";
  coordinates: number[][][][];
};

export type EstimationPoint = {
  coordinates: [number, number];
  id: number;
  name: string;
  place?: string;
  psgcCode?: string;
};

export type EstimatedBoundaryFeature = {
  type: "Feature";
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  properties: {
    boundaryKind: "estimated";
    estimatedFromPoint: [number, number];
    estimationMethod: "voronoi";
    id: number;
    name: string;
    place?: string;
    psgcCode?: string;
    sourceType: "estimated";
  };
};

const MIN_POLYGON_AREA_SQUARE_METERS = 1;

function padBbox([minLng, minLat, maxLng, maxLat]: BBox): BBox {
  const width = Math.max(maxLng - minLng, 0.01);
  const height = Math.max(maxLat - minLat, 0.01);
  const lngPadding = width * 0.1;
  const latPadding = height * 0.1;

  return [minLng - lngPadding, minLat - latPadding, maxLng + lngPadding, maxLat + latPadding];
}

function isPolygonGeometry(geometry: Feature["geometry"]): geometry is Polygon | MultiPolygon {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function dedupePoints(points: EstimationPoint[]) {
  const seen = new Set<string>();

  return points.filter((point) => {
    const [lng, lat] = point.coordinates;

    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !point.name.trim()) {
      return false;
    }

    const key = `${normalizeKey(point.name)}:${lng.toFixed(6)},${lat.toFixed(6)}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function estimateBarangayPolygons({
  cityGeometry,
  points,
}: {
  cityGeometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  points: EstimationPoint[];
}) {
  const cleanPoints = dedupePoints(points);
  const cityFeature = turf.feature(cityGeometry) as Feature<Polygon | MultiPolygon>;

  if (!cleanPoints.length) {
    return [];
  }

  if (cleanPoints.length === 1) {
    const [point] = cleanPoints;

    return [
      {
        type: "Feature",
        geometry: cityGeometry,
        properties: {
          boundaryKind: "estimated",
          estimatedFromPoint: point.coordinates,
          estimationMethod: "voronoi",
          id: point.id,
          name: point.name,
          place: point.place,
          psgcCode: point.psgcCode,
          sourceType: "estimated",
        },
      },
    ] satisfies EstimatedBoundaryFeature[];
  }

  const pointFeatures: FeatureCollection<Point> = turf.featureCollection(
    cleanPoints.map((point, index) =>
      turf.point(point.coordinates, {
        index,
      }),
    ),
  );
  const cells = turf.voronoi(pointFeatures, { bbox: padBbox(turf.bbox(cityFeature)) });

  return cells.features
    .map((cell): EstimatedBoundaryFeature | null => {
      const point = cleanPoints[Number(cell.properties?.index)];

      if (!point || !cell.geometry) {
        return null;
      }

      const clipped = turf.intersect(turf.featureCollection([cell, cityFeature]));

      if (!clipped?.geometry || !isPolygonGeometry(clipped.geometry) || turf.area(clipped) < MIN_POLYGON_AREA_SQUARE_METERS) {
        return null;
      }

      const feature: EstimatedBoundaryFeature = {
        type: "Feature",
        geometry: clipped.geometry,
        properties: {
          boundaryKind: "estimated",
          estimatedFromPoint: point.coordinates,
          estimationMethod: "voronoi",
          id: point.id,
          name: point.name,
          place: point.place,
          psgcCode: point.psgcCode,
          sourceType: "estimated",
        },
      };

      return feature;
    })
    .filter((feature): feature is EstimatedBoundaryFeature => feature !== null)
    .sort((left, right) => left.properties.name.localeCompare(right.properties.name));
}
