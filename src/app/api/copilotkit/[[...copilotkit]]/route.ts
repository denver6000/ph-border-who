import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { MastraAgent } from "@ag-ui/mastra";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { AppCheckVerificationError, verifyAppCheckRequest } from "@/lib/app-check-server";
import { mastra } from "@/mastra";

export const runtime = "nodejs";

async function handleCopilotKitRequest(request: NextRequest) {
  try {
    await verifyAppCheckRequest(request);

    const runtime = new CopilotRuntime({
      agents: MastraAgent.getLocalAgents({
        mastra,
        resourceId: "citybaranggay",
      }),
    });

    const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
      runtime,
      serviceAdapter: new ExperimentalEmptyAdapter(),
      endpoint: "/api/copilotkit",
    });

    return handleRequest(request);
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

    throw error;
  }
}

export const GET = handleCopilotKitRequest;
export const POST = handleCopilotKitRequest;
