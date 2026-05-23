import { NextRequest, NextResponse } from "next/server";

import { resolveCityBoundary } from "@/lib/city-boundaries";
import { buildCityZoneExportPayload } from "@/lib/zone-export";

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
    const boundary = await resolveCityBoundary({
      city,
      country,
      locationLabel,
      province,
      relationId,
    });

    if (!boundary.features.length) {
      return NextResponse.json(
        {
          error: "No city boundary polygon found for the provided city.",
          metadata: boundary.metadata,
        },
        { status: 404 },
      );
    }

    const payload = buildCityZoneExportPayload(boundary, request.url);

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${(city ?? boundary.metadata.city).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-city-zone.json"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: "Failed to export city zone.",
        details: message,
      },
      { status: 502 },
    );
  }
}
