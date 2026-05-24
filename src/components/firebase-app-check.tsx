"use client";

import { useEffect } from "react";

import { initializeFirebaseAppCheck } from "@/lib/firebase-app-check";

type FirebaseAppCheckBootstrapProps = {
  debugToken?: string | null;
};

export function FirebaseAppCheckBootstrap({ debugToken }: FirebaseAppCheckBootstrapProps) {
  useEffect(() => {
    initializeFirebaseAppCheck({ debugToken });
  }, [debugToken]);

  return null;
}
