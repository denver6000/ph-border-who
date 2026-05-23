import { NextRequest, NextResponse } from "next/server";

import { resolveCityBoundary } from "@/lib/city-boundaries";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city")?.trim();
  const province = searchParams.get("province")?.trim() || undefined;
  const country = searchParams.get("country")?.trim() || "Philippines";
  const locationLabel = searchParams.get("locationLabel")?.trim() || undefined;
  const rawRelationId = searchParams.get("relationId");
  const relationId = rawRelationId ? Number(rawRelationId) : undefined;

  if (!city && !Number.isFinite(relationId)) {
    return NextResponse.json(
      {
        error: 'Missing required "city" or "relationId" query parameter.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await resolveCityBoundary({
      city,
      country,
      locationLabel,
      province,
      relationId,
    });

    if (!result.features.length) {
      return NextResponse.json(
        {
          error: "No city boundary polygon found for the provided city.",
          metadata: result.metadata,
        },
        { status: 404 },
      );
    }

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=43200",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: "Failed to fetch city boundary.",
        details: message,
      },
      { status: 502 },
    );
  }
}
