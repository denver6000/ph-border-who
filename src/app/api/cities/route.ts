import { NextRequest, NextResponse } from "next/server";

import { AppCheckVerificationError, verifyAppCheckRequest } from "@/lib/app-check-server";
import { queryFirestoreCities } from "@/lib/firestore-boundaries";

export const runtime = "nodejs";

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
    await verifyAppCheckRequest(request);

    const cities = await queryFirestoreCities({
      city,
    });

    if (!cities.length) {
      return NextResponse.json({
        cities: [],
        metadata: {
          city,
          country,
          count: 0,
          generatedAt: new Date().toISOString(),
          source: "firestore",
        },
      });
    }

    return NextResponse.json({
      cities,
      metadata: {
        city,
        country,
        count: cities.length,
        generatedAt: new Date().toISOString(),
        source: "firestore",
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
        error: "Failed to search city boundaries from Firestore.",
        details: message,
      },
      { status: 502 },
    );
  }
}
