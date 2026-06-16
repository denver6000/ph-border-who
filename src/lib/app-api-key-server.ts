import { timingSafeEqual } from "node:crypto";

import { NextRequest } from "next/server";

import { APP_API_KEY_HEADER } from "@/lib/app-api-key";

export class ApiKeyVerificationError extends Error {
  readonly details?: string;
  readonly status: number;

  constructor(message: string, status = 401, details?: string) {
    super(message);
    this.name = "ApiKeyVerificationError";
    this.details = details;
    this.status = status;
  }
}

function configuredApiKey() {
  return process.env.APP_API_KEY?.trim() || "";
}

function matchesApiKey(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function verifyAppApiKeyRequest(request: NextRequest) {
  const expected = configuredApiKey();

  if (!expected) {
    return null;
  }

  const received = request.headers.get(APP_API_KEY_HEADER)?.trim() || "";

  if (!received) {
    throw new ApiKeyVerificationError("Missing API key.", 401, `Expected "${APP_API_KEY_HEADER}" header.`);
  }

  if (!matchesApiKey(received, expected)) {
    throw new ApiKeyVerificationError("Invalid API key.");
  }

  return true;
}
