import { NextRequest } from "next/server";
import { getAppCheck } from "firebase-admin/app-check";

import { getAdminApp } from "@/lib/firebase-admin";

const APP_CHECK_HEADER = "x-firebase-appcheck";

export class AppCheckVerificationError extends Error {
  readonly details?: string;
  readonly status: number;

  constructor(message: string, status = 401, details?: string) {
    super(message);
    this.name = "AppCheckVerificationError";
    this.details = details;
    this.status = status;
  }
}

function isAppCheckEnabled() {
  return process.env.FIREBASE_APP_CHECK_ENABLED === "true";
}

export async function verifyAppCheckRequest(request: NextRequest) {
  if (!isAppCheckEnabled()) {
    return null;
  }

  const token = request.headers.get(APP_CHECK_HEADER);

  if (!token) {
    throw new AppCheckVerificationError("Missing App Check token.", 401, 'Expected "X-Firebase-AppCheck" header.');
  }

  try {
    return await getAppCheck(getAdminApp()).verifyToken(token);
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown App Check verification error.";
    throw new AppCheckVerificationError("Invalid App Check token.", 401, details);
  }
}
