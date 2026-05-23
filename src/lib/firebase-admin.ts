import { readFileSync } from "node:fs";

import { cert, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function loadServiceAccount() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson) {
    return JSON.parse(serviceAccountJson);
  }

  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountPath) {
    return JSON.parse(readFileSync(serviceAccountPath, "utf8"));
  }

  return null;
}

export function getAdminApp(): App {
  if (!getApps().length) {
    const serviceAccount = loadServiceAccount();
    const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

    if (serviceAccount) {
      initializeApp({
        credential: cert(serviceAccount),
        projectId,
      });
    } else {
      initializeApp({
        projectId,
      });
    }
  }

  return getApp();
}

export function getAdminFirestore() {
  getAdminApp();

  return getFirestore();
}
