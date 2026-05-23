"use client";

import { useEffect } from "react";

import { initializeFirebaseAppCheck } from "@/lib/firebase-app-check";

export function FirebaseAppCheckBootstrap() {
  useEffect(() => {
    initializeFirebaseAppCheck();
  }, []);

  return null;
}
