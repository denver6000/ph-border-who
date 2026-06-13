import { NextRequest, NextResponse } from "next/server";

import { AppCheckVerificationError, verifyAppCheckRequest } from "@/lib/app-check-server";
import { compareMunicipalityNativeAndOsm } from "@/lib/municipality-boundary-comparison";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const locality = searchParams.get("locality")?.trim() ?? searchParams.get("city")?.trim();
  const province = searchParams.get("province")?.trim() || undefined;

  if (!locality) {
    return NextResponse.json(
      {
        error: 'Missing required "locality" query parameter.',
      },
      { status: 400 },
    );
  }

  try {
    await verifyAppCheckRequest(request);

    const result = await compareMunicipalityNativeAndOsm({
      locality,
      province,
    });

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store",
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
        error: "Failed to compare municipality boundaries.",
        details: message,
      },
      { status: 502 },
    );
  }
}
