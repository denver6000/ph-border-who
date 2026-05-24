import type { BoundaryFeatureCollection } from "@/lib/boundary-types";
import { queryFirestoreBarangayBoundaries } from "@/lib/firestore-boundaries";
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
}: ResolveBarangayBoundariesArgs): Promise<BoundaryFeatureCollection> {
  const firestoreResult = await queryFirestoreBarangayBoundaries({
    city,
    country,
    province: province ?? locationLabel,
  });

  if (firestoreResult) {
    return sanitizeIndicativeBarangaysWithPsgc({
      city,
      collection: firestoreResult,
      locationLabel: province ?? locationLabel,
    });
  }

  if (!city) {
    throw new Error('Missing required "city" query parameter.');
  }

  return {
    type: "FeatureCollection",
    features: [],
    metadata: {
      adminLevels: adminLevels ?? ["4"],
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
