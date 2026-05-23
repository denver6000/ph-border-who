"use client";

import { getFirebaseAppCheckToken, hasFirebaseAppCheckConfig } from "@/lib/firebase-app-check";

const APP_CHECK_HEADER = "X-Firebase-AppCheck";

type AppCheckFetchOptions = RequestInit & {
  skipAppCheck?: boolean;
};

export async function fetchWithAppCheck(input: RequestInfo | URL, init: AppCheckFetchOptions = {}) {
  const { skipAppCheck = false, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);

  if (!skipAppCheck && hasFirebaseAppCheckConfig()) {
    const token = await getFirebaseAppCheckToken();
    headers.set(APP_CHECK_HEADER, token);
  }

  return fetch(input, {
    ...requestInit,
    headers,
  });
}
