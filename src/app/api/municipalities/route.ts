import { NextRequest, NextResponse } from "next/server";

import { ApiKeyVerificationError, verifyAppApiKeyRequest } from "@/lib/app-api-key-server";
import { listMunicipalityCandidates, resolveMergedMunicipalityBoundaries } from "@/lib/municipality-boundary-service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const province = searchParams.get("province")?.trim();
  const country = searchParams.get("country")?.trim() || "Philippines";
  const includeBoundaries = searchParams.get("includeBoundaries") === "true";
  const includeOsmFallback = searchParams.get("osmFallback") === "true";

  if (!province) {
    return NextResponse.json(
      {
        error: 'Missing required "province" query parameter.',
      },
      { status: 400 },
    );
  }

  try {
    verifyAppApiKeyRequest(request);

    if (includeBoundaries) {
      const result = await resolveMergedMunicipalityBoundaries({
        country,
        includeOsmFallback,
        province,
      });

      return NextResponse.json(result, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    const result = await listMunicipalityCandidates({
      country,
      province,
    });

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store",
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
        error: "Failed to load province localities from Firestore.",
        details: message,
      },
      { status: 502 },
    );
  }
}
