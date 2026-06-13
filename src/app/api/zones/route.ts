import { NextRequest, NextResponse } from "next/server";

import { AppCheckVerificationError, verifyAppCheckRequest } from "@/lib/app-check-server";
import { queryNativeZones } from "@/lib/native-zones";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const province = searchParams.get("province")?.trim() || undefined;
  const country = searchParams.get("country")?.trim() || "PH";

  try {
    await verifyAppCheckRequest(request);

    const result = await queryNativeZones({
      country,
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
        error: "Failed to load native zones.",
        details: message,
      },
      { status: 502 },
    );
  }
}
