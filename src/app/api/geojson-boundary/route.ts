import { NextRequest, NextResponse } from "next/server";

import { ApiKeyVerificationError, verifyAppApiKeyRequest } from "@/lib/app-api-key-server";
import { GeoJsonBoundaryError, resolveGeoJsonBoundary, type GeoJsonBoundaryRequest } from "@/lib/geojson-boundary";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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

    return NextResponse.json(boundary, {
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

    if (error instanceof GeoJsonBoundaryError) {
      return NextResponse.json(
        {
          error: "Failed to load GeoJSON boundary.",
          details: error.message,
        },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: "Failed to load GeoJSON boundary.",
        details: message,
      },
      { status: 502 },
    );
  }
}
