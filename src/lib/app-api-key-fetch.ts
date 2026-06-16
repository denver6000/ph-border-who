"use client";

import { APP_API_KEY_HEADER } from "@/lib/app-api-key";

type AppApiKeyFetchOptions = RequestInit & {
  skipAppApiKey?: boolean;
};

export function fetchWithAppApiKey(input: RequestInfo | URL, init: AppApiKeyFetchOptions = {}) {
  const { skipAppApiKey = false, ...requestInit } = init;
  const apiKey = process.env.NEXT_PUBLIC_APP_API_KEY?.trim() || "";

  if (skipAppApiKey || !apiKey) {
    return fetch(input, requestInit);
  }

  const headers = new Headers(requestInit.headers);
  headers.set(APP_API_KEY_HEADER, apiKey);

  return fetch(input, {
    ...requestInit,
    headers,
  });
}
