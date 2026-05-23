import { NextRequest, NextResponse } from "next/server";

import { resolveBarangayBoundaries } from "@/lib/barangay-boundaries";
import { buildZoneExportPayload } from "@/lib/zone-export";

export const runtime = "nodejs";

function parseAdminLevels(rawValue: string | null) {
  if (!rawValue) {
    return ["10"];
  }

  return rawValue
    .split(",")
    .map((level) => level.trim())
    .filter(Boolean);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city")?.trim();
  const province = searchParams.get("province")?.trim() || undefined;
  const country = searchParams.get("country")?.trim() || "Philippines";
  const adminLevels = parseAdminLevels(searchParams.get("adminLevels"));
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
    const boundaries = await resolveBarangayBoundaries({
      adminLevels,
      city,
      country,
      locationLabel,
      province,
      relationId,
    });

    if (!boundaries.features.length) {
      return NextResponse.json(
        {
          error: "No boundary polygons found for the provided city.",
          metadata: boundaries.metadata,
        },
        { status: 404 },
      );
    }

    const payload = buildZoneExportPayload(boundaries, request.url);

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${(city ?? boundaries.metadata.city).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-zones.json"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: "Failed to export barangay zones.",
        details: message,
      },
      { status: 502 },
    );
  }
}
