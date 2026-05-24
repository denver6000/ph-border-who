import { NextRequest, NextResponse } from "next/server";

import { AppCheckVerificationError, verifyAppCheckRequest } from "@/lib/app-check-server";
import { queryFirestoreCities } from "@/lib/firestore-boundaries";
import { searchCityBoundaries } from "@/lib/overpass";

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

    const firestoreCities = await queryFirestoreCities({
      city,
    });

    if (firestoreCities.length) {
      return NextResponse.json({
        cities: firestoreCities,
        metadata: {
          city,
          country,
          count: firestoreCities.length,
          generatedAt: new Date().toISOString(),
          source: "firestore",
        },
      });
    }

    const cities = await searchCityBoundaries({
      city,
      country,
    });
    const overpassCities = cities.map((candidate) => ({
      ...candidate,
      sourceType: "overpass" as const,
    }));

    return NextResponse.json({
      cities: overpassCities,
      metadata: {
        city,
        country,
        count: overpassCities.length,
        generatedAt: new Date().toISOString(),
        source: "overpass",
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
        error: "Failed to search city boundaries from Overpass.",
        details: message,
      },
      { status: 502 },
    );
  }
}
