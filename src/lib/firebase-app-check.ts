"use client";

import {
  ReCaptchaEnterpriseProvider,
  getLimitedUseToken,
  initializeAppCheck,
  type AppCheck,
} from "firebase/app-check";

import { getFirebaseApp } from "@/lib/firebase-client";

declare global {
  interface Window {
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

let appCheckInstance: AppCheck | null | undefined;

function appCheckSiteKey() {
  return process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY?.trim() || "";
}

function appEnvironment() {
  return process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase() || "prod";
}

function isDevelopmentAppEnv() {
  const env = appEnvironment();
  return env === "dev" || env === "development";
}

export function hasFirebaseAppCheckConfig() {
  return Boolean(appCheckSiteKey());
}

export function initializeFirebaseAppCheck() {
  if (typeof window === "undefined") {
    return null;
  }

  if (appCheckInstance !== undefined) {
    return appCheckInstance;
  }

  const app = getFirebaseApp();
  const siteKey = appCheckSiteKey();

  if (!app || !siteKey) {
    appCheckInstance = null;
    return appCheckInstance;
  }

  const debugToken = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN?.trim();

  if (isDevelopmentAppEnv()) {
    window.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken ? (debugToken === "true" ? true : debugToken) : true;
  } else if (debugToken) {
    window.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken === "true" ? true : debugToken;
  }

  appCheckInstance = initializeAppCheck(app, {
    isTokenAutoRefreshEnabled: true,
    provider: new ReCaptchaEnterpriseProvider(siteKey),
  });

  return appCheckInstance;
}

export async function getFirebaseAppCheckToken() {
  const appCheck = initializeFirebaseAppCheck();

  if (!appCheck) {
    throw new Error("Firebase App Check is not configured.");
  }

  const result = await getLimitedUseToken(appCheck);

  return result.token;
}
