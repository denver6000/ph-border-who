import { NextRequest, NextResponse } from "next/server";

import { AppCheckVerificationError, verifyAppCheckRequest } from "@/lib/app-check-server";
import { resolveCityBoundary } from "@/lib/city-boundaries";
import {
  buildCityZoneExportPayload,
  buildCityZoneExportSql,
  buildMultiCityZoneExportPayload,
  buildMultiCityZoneExportSql,
  type ExportFormat,
} from "@/lib/zone-export";

export const runtime = "nodejs";

type ExportCityRequest = {
  city?: string;
  country?: string;
  locationLabel?: string;
  province?: string;
  relationId?: number;
};

function toSlug(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function resolveExportFormat(request: NextRequest): ExportFormat {
  const { searchParams } = new URL(request.url);
  return searchParams.get("format")?.toLowerCase() === "sql" ? "sql" : "json";
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const format = resolveExportFormat(request);
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
    await verifyAppCheckRequest(request);

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
    const filenameBase = toSlug(city ?? boundary.metadata.city);

    if (format === "sql") {
      return new NextResponse(buildCityZoneExportSql(boundary), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filenameBase}-city-zone.sql"`,
          "Content-Type": "text/sql; charset=utf-8",
        },
      });
    }

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filenameBase}-city-zone.json"`,
      },
    });
  } catch (error) {
    if (error instanceof AppCheckVerificationError) {
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
        error: "Failed to export city zone.",
        details: message,
      },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const format = resolveExportFormat(request);
  let payload: { cities?: ExportCityRequest[] };

  try {
    payload = (await request.json()) as { cities?: ExportCityRequest[] };
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON body.",
      },
      { status: 400 },
    );
  }

  const cities = payload.cities?.filter((entry) => entry.city?.trim() || Number.isFinite(entry.relationId)) ?? [];

  if (!cities.length) {
    return NextResponse.json(
      {
        error: 'Missing required "cities" array in request body.',
      },
      { status: 400 },
    );
  }

  try {
    await verifyAppCheckRequest(request);

    const boundaries = await Promise.all(
      cities.map((entry) =>
        resolveCityBoundary({
          city: entry.city?.trim(),
          country: entry.country?.trim() || "Philippines",
          locationLabel: entry.locationLabel?.trim() || undefined,
          province: entry.province?.trim() || undefined,
          relationId: entry.relationId,
        }),
      ),
    );

    const matchedBoundaries = boundaries.filter((entry) => entry.features.length);

    if (!matchedBoundaries.length) {
      return NextResponse.json(
        {
          error: "No city boundary polygons found for the provided cities.",
        },
        { status: 404 },
      );
    }

    const exportPayload = buildMultiCityZoneExportPayload(matchedBoundaries, request.url);
    const resolvedZoneCount = exportPayload.data.zones.total;

    if (!resolvedZoneCount) {
      return NextResponse.json(
        {
          error: "No non-overlapping city zones could be produced from the selected cities.",
        },
        { status: 409 },
      );
    }

    const filename =
      resolvedZoneCount === 1
        ? `${toSlug(exportPayload.data.zones.data[0].name)}-city-zone`
        : `selected-${resolvedZoneCount}-cities-zone`;

    if (format === "sql") {
      return new NextResponse(buildMultiCityZoneExportSql(matchedBoundaries), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filename}.sql"`,
          "Content-Type": "text/sql; charset=utf-8",
        },
      });
    }

    return NextResponse.json(exportPayload, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}.json"`,
      },
    });
  } catch (error) {
    if (error instanceof AppCheckVerificationError) {
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
        error: "Failed to export selected city zones.",
        details: message,
      },
      { status: 502 },
    );
  }
}
