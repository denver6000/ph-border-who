import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import type { Analytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
};

export function hasFirebaseWebConfig() {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.appId &&
      firebaseConfig.authDomain &&
      firebaseConfig.messagingSenderId &&
      firebaseConfig.projectId &&
      firebaseConfig.storageBucket,
  );
}

export function getFirebaseApp(): FirebaseApp | null {
  if (!hasFirebaseWebConfig()) {
    return null;
  }

  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export async function getFirebaseAnalyticsClient(): Promise<Analytics | null> {
  if (typeof window === "undefined" || !firebaseConfig.measurementId) {
    return null;
  }

  const app = getFirebaseApp();

  if (!app) {
    return null;
  }

  const { getAnalytics, isSupported } = await import("firebase/analytics");

  if (!(await isSupported())) {
    return null;
  }

  return getAnalytics(app);
}

export { firebaseConfig };
