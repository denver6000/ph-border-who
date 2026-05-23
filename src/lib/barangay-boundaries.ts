import { queryFirestoreBarangayBoundaries } from "@/lib/firestore-boundaries";
import { queryHdxBarangayBoundaries } from "@/lib/hdx-boundaries";
import { queryBarangayBoundaries, queryBarangayBoundariesByRelationId, type BoundaryFeatureCollection } from "@/lib/overpass";
import { sanitizeIndicativeBarangaysWithPsgc } from "@/lib/psgc-boundary-validation";

type ResolveBarangayBoundariesArgs = {
  adminLevels?: string[];
  city?: string;
  country?: string;
  locationLabel?: string;
  province?: string;
  relationId?: number;
};

export async function resolveBarangayBoundaries({
  adminLevels,
  city,
  country = "Philippines",
  locationLabel,
  province,
  relationId,
}: ResolveBarangayBoundariesArgs): Promise<BoundaryFeatureCollection> {
  const firestoreResult = await queryFirestoreBarangayBoundaries({
    city,
    country,
    province: province ?? locationLabel,
  });
  const hdxResult = await queryHdxBarangayBoundaries({
    city,
    country,
    locationLabel,
    province,
  });

  if (firestoreResult) {
    return sanitizeIndicativeBarangaysWithPsgc({
      city,
      collection: firestoreResult,
      locationLabel: province ?? locationLabel,
    });
  }

  if (hdxResult) {
    return sanitizeIndicativeBarangaysWithPsgc({
      city,
      collection: hdxResult,
      locationLabel: province ?? locationLabel,
    });
  }

  if (Number.isFinite(relationId)) {
    return queryBarangayBoundariesByRelationId({
      adminLevels,
      city,
      country,
      locationLabel,
      relationId: relationId!,
    });
  }

  if (!city) {
    throw new Error('Missing required "city" query parameter.');
  }

  return queryBarangayBoundaries({
    adminLevels,
    city,
    country,
    province,
  });
}
