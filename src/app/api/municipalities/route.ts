import { NextRequest, NextResponse } from "next/server";

import { AppCheckVerificationError, verifyAppCheckRequest } from "@/lib/app-check-server";
import { queryFirestoreCitiesByProvince } from "@/lib/firestore-boundaries";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const province = searchParams.get("province")?.trim();
  const country = searchParams.get("country")?.trim() || "Philippines";

  if (!province) {
    return NextResponse.json(
      {
        error: 'Missing required "province" query parameter.',
      },
      { status: 400 },
    );
  }

  try {
    await verifyAppCheckRequest(request);

    const municipalities = await queryFirestoreCitiesByProvince({
      province,
    });

    return NextResponse.json({
      metadata: {
        count: municipalities.length,
        country,
        generatedAt: new Date().toISOString(),
        province,
        source: "firestore",
      },
      municipalities,
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
        error: "Failed to load province localities from Firestore.",
        details: message,
      },
      { status: 502 },
    );
  }
}
