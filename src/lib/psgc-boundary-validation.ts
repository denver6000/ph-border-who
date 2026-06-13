import type { BoundaryFeature, BoundaryFeatureCollection } from "@/lib/boundary-types";
import { findOfficialBarangaysForCity, normalizePsgcName, type PsgcBarangay } from "@/lib/psgc";

function normalizeCode(value: string | undefined) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/^PH/, "")
    .replace(/[^0-9]/g, "");
}

function officialCodeKeys(barangay: PsgcBarangay) {
  return new Set([normalizeCode(barangay.code), normalizeCode(barangay.psgc10DigitCode)].filter(Boolean));
}

function featureCodeKeys(feature: BoundaryFeature) {
  return new Set([normalizeCode(feature.properties.psgcCode), normalizeCode(String(feature.properties.id))].filter(Boolean));
}

function officialNameKey(barangay: PsgcBarangay) {
  return normalizePsgcName(barangay.name);
}

function featureNameKey(feature: BoundaryFeature) {
  return normalizePsgcName(feature.properties.name);
}

function matchFeatureToOfficialBarangay(feature: BoundaryFeature, officialBarangays: PsgcBarangay[]) {
  const featureCodes = featureCodeKeys(feature);
  const featureName = featureNameKey(feature);

  return (
    officialBarangays.find((barangay) => {
      const codeMatch = Array.from(featureCodes).some((code) => officialCodeKeys(barangay).has(code));

      if (codeMatch) {
        return true;
      }

      return featureName && featureName === officialNameKey(barangay);
    }) ?? null
  );
}

export async function sanitizeIndicativeBarangaysWithPsgc({
  city,
  collection,
  locationLabel,
}: {
  city?: string;
  collection: BoundaryFeatureCollection;
  locationLabel?: string;
}): Promise<BoundaryFeatureCollection> {
  if (collection.metadata.boundaryMode !== "indicative" || !collection.features.length) {
    return collection;
  }

  const official = await findOfficialBarangaysForCity({
    city: city ?? collection.metadata.city,
    locationLabel,
  });

  if (!official) {
    return {
      ...collection,
      metadata: {
        ...collection.metadata,
        psgcValidation: {
          droppedCount: 0,
          keptCount: collection.features.length,
          officialCount: 0,
          status: "unavailable",
        },
      },
    };
  }

  const keptFeatures: BoundaryFeature[] = [];
  const droppedNames: string[] = [];
  const seenOfficialKeys = new Set<string>();

  for (const feature of collection.features) {
    const matched = matchFeatureToOfficialBarangay(feature, official.barangays);

    if (!matched) {
      droppedNames.push(feature.properties.name);
      continue;
    }

    const duplicateKey =
      normalizeCode(matched.psgc10DigitCode) || normalizeCode(matched.code) || officialNameKey(matched) || featureNameKey(feature);

    if (duplicateKey && seenOfficialKeys.has(duplicateKey)) {
      droppedNames.push(feature.properties.name);
      continue;
    }

    if (duplicateKey) {
      seenOfficialKeys.add(duplicateKey);
    }

    keptFeatures.push({
      ...feature,
      properties: {
        ...feature.properties,
        name: matched.name,
        psgcCode: feature.properties.psgcCode ?? matched.psgc10DigitCode ?? matched.code,
      },
    });
  }

  return {
    ...collection,
    features: keptFeatures,
    metadata: {
      ...collection.metadata,
      count: keptFeatures.length,
      psgcValidation: {
        droppedCount: droppedNames.length,
        droppedNames: droppedNames.slice(0, 25),
        keptCount: keptFeatures.length,
        officialCount: official.barangays.length,
        status: droppedNames.length ? "filtered" : "matched",
      },
    },
  };
}
