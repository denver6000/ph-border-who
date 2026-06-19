import { NextRequest, NextResponse } from "next/server";

import { ApiKeyVerificationError, verifyAppApiKeyRequest } from "@/lib/app-api-key-server";
import { GeoJsonBoundaryError, resolveGeoJsonBoundary, type GeoJsonBoundaryRequest } from "@/lib/geojson-boundary";
import { buildBoundaryZoneExportPayload, buildBoundaryZoneExportSql, type ExportFormat } from "@/lib/zone-export";

export const runtime = "nodejs";

function toSlug(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function resolveExportFormat(request: NextRequest): ExportFormat {
  const { searchParams } = new URL(request.url);
  return searchParams.get("format")?.toLowerCase() === "json" ? "json" : "sql";
}

export async function POST(request: NextRequest) {
  const format = resolveExportFormat(request);
  let payload: GeoJsonBoundaryRequest;

  try {
    payload = (await request.json()) as GeoJsonBoundaryRequest;
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON body.",
      },
      { status: 400 },
    );
  }

  try {
    verifyAppApiKeyRequest(request);

    const boundary = await resolveGeoJsonBoundary(payload);
    const filenameBase = boundary.features.length === 1 ? toSlug(boundary.features[0].properties.name) : `geojson-${boundary.features.length}-zones`;

    if (format === "json") {
      return NextResponse.json(buildBoundaryZoneExportPayload(boundary, request.url), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filenameBase}.json"`,
        },
      });
    }

    return new NextResponse(buildBoundaryZoneExportSql(boundary), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filenameBase}.sql"`,
        "Content-Type": "text/sql; charset=utf-8",
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

    if (error instanceof GeoJsonBoundaryError) {
      return NextResponse.json(
        {
          error: "Failed to export GeoJSON boundary.",
          details: error.message,
        },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: "Failed to export GeoJSON boundary.",
        details: message,
      },
      { status: 502 },
    );
  }
}
