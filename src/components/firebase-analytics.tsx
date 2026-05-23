"use client";

import { useEffect } from "react";

import { getFirebaseAnalyticsClient } from "@/lib/firebase-client";

export function FirebaseAnalyticsBootstrap() {
  useEffect(() => {
    void getFirebaseAnalyticsClient();
  }, []);

  return null;
}
