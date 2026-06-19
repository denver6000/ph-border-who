import { NextRequest, NextResponse } from "next/server";

import { ApiKeyVerificationError, verifyAppApiKeyRequest } from "@/lib/app-api-key-server";
import type { CityBoundaryCandidate } from "@/lib/boundary-types";
import { queryFirestoreCities } from "@/lib/firestore-boundaries";
import { queryNativeZones } from "@/lib/native-zones";
import { normalizePsgcName, searchOfficialLocalities, toPsgc10DigitCode, type PsgcLocalitySearchResult } from "@/lib/psgc";

export const runtime = "nodejs";

function hashCandidateId(value: string) {
  const digits = value.replace(/\D/g, "");
  const numeric = Number(digits);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }

  return hash || 1;
}

function localityKey(value: string) {
  return normalizePsgcName(value)
    .replace(/^city of\s+/, "")
    .replace(/^municipality of\s+/, "")
    .replace(/\bcity\b/g, "")
    .replace(/\bmunicipality\b/g, "")
    .replace(/^of\s+/, "")
    .trim();
}

function codeMatches(left: string | undefined, right: string | undefined) {
  const leftDigits = left?.replace(/\D/g, "") ?? "";
  const rightDigits = right?.replace(/\D/g, "") ?? "";
  const normalizedLeft = toPsgc10DigitCode(left);
  const normalizedRight = toPsgc10DigitCode(right);
  const leftCandidates = new Set([leftDigits, normalizedLeft].filter(Boolean));
  const rightCandidates = new Set([rightDigits, normalizedRight].filter(Boolean));

  if (!leftCandidates.size || !rightCandidates.size) {
    return false;
  }

  return Array.from(leftCandidates).some((leftCandidate) =>
    Array.from(rightCandidates).some(
      (rightCandidate) =>
        leftCandidate === rightCandidate ||
        leftCandidate.startsWith(rightCandidate) ||
        rightCandidate.startsWith(leftCandidate),
    ),
  );
}

function findMatchingFirestoreCandidate(
  official: PsgcLocalitySearchResult,
  firestoreCandidates: CityBoundaryCandidate[],
) {
  const officialKey = localityKey(official.name);
  const officialProvinceKey = official.provinceName ? normalizePsgcName(official.provinceName) : "";

  return (
    firestoreCandidates.find((candidate) => codeMatches(candidate.ref, official.code)) ??
    firestoreCandidates.find((candidate) => {
      const candidateKey = localityKey(candidate.name);
      const candidateProvinceKey = candidate.locationLabel ? normalizePsgcName(candidate.locationLabel) : "";
      const provinceMatches = !officialProvinceKey || !candidateProvinceKey || candidateProvinceKey === officialProvinceKey;

      return provinceMatches && candidateKey === officialKey;
    })
  );
}

async function hasNativePolygon(official: PsgcLocalitySearchResult) {
  const boundary = await queryNativeZones({
    country: "PH",
    locality: official.name,
    province: official.provinceName,
  }).catch(() => null);

  return Boolean(boundary?.features.length);
}

async function toPsgcCityCandidate(official: PsgcLocalitySearchResult): Promise<CityBoundaryCandidate> {
  const firestoreCandidates = await queryFirestoreCities({
    city: official.name,
    kind: official.localityType,
  });
  const firestoreCandidate = findMatchingFirestoreCandidate(official, firestoreCandidates);
  const nativePolygonFound = firestoreCandidate ? false : await hasNativePolygon(official);
  const boundaryStatus = firestoreCandidate ? "firestore" : nativePolygonFound ? "native-zone" : "psgc-unchecked";

  return {
    adminLevel: "psgc",
    boundaryStatus,
    borderType: "official-psgc-locality",
    id: hashCandidateId(official.psgc10DigitCode),
    localityType: official.localityType,
    locationLabel: official.provinceName,
    name: official.name,
    ref: official.psgc10DigitCode,
    sourceType: firestoreCandidate ? "firestore" : nativePolygonFound ? "native-zone-sql" : "psgc",
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city")?.trim();
  const country = searchParams.get("country")?.trim() || "Philippines";

  if (!city) {
    return NextResponse.json(
      {
        error: 'Missing required "city" query parameter.',
      },
      { status: 400 },
    );
  }

  try {
    verifyAppApiKeyRequest(request);

    const officialCities = await searchOfficialLocalities({
      kind: "all",
      query: city,
    });
    const cities = await Promise.all(officialCities.map(toPsgcCityCandidate));

    return NextResponse.json({
      cities,
      metadata: {
        city,
        country,
        count: cities.length,
        generatedAt: new Date().toISOString(),
        source: "psgc-firestore-native-osm-on-select",
      },
    });
  } catch (error) {
    if (error instanceof ApiKeyVerificationError) {
      return NextResponse.json(
        {
          error: error.message,
          details: error.details,
        },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: "Failed to search PSGC localities from Firestore.",
        details: message,
      },
      { status: 502 },
    );
  }
}
