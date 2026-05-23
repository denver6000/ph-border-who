import {
  estimateBarangayPolygons,
  type EstimatedBoundaryFeature,
  type EstimationPoint,
  type GeoJsonMultiPolygon,
  type GeoJsonPolygon,
} from "@/lib/estimated-boundaries";
import { getOfficialBarangaySeeds, type OfficialBarangaySeedResult } from "@/lib/psgc";

export type BoundaryEstimationSeedMode = "osm-place-points" | "psgc-matched-osm-place-points";

export type BoundaryEstimationResult = {
  features: EstimatedBoundaryFeature[];
  officialSeeds: OfficialBarangaySeedResult | null;
  osmPointCount: number;
  seedMode: BoundaryEstimationSeedMode;
};

export async function estimateBarangayBoundariesWithOfficialSeeds({
  cityGeometry,
  cityName,
  locationLabel,
  osmPoints,
}: {
  cityGeometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  cityName?: string;
  locationLabel?: string;
  osmPoints: EstimationPoint[];
}): Promise<BoundaryEstimationResult> {
  const officialSeeds = await getOfficialBarangaySeeds({
    city: cityName,
    locationLabel,
    points: osmPoints,
  }).catch(() => null);
  const hasOfficialSeedMatches = Boolean(officialSeeds?.matchedPoints.length);
  const seedPoints = hasOfficialSeedMatches ? officialSeeds!.matchedPoints : osmPoints;

  return {
    features: estimateBarangayPolygons({
      cityGeometry,
      points: seedPoints,
    }),
    officialSeeds,
    osmPointCount: osmPoints.length,
    seedMode: hasOfficialSeedMatches ? "psgc-matched-osm-place-points" : "osm-place-points",
  };
}
