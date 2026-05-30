"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchWithAppCheck } from "@/lib/app-check-fetch";

type BoundaryFeature = {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
  properties: {
    adminLevel?: string;
    boundaryKind?: "actual" | "indicative";
    id: number;
    name: string;
    sourceType: "firestore-hdx-cod-ab" | "relation";
  };
};

type BoundaryResponse = {
  type: "FeatureCollection";
  features: BoundaryFeature[];
  metadata: {
    adminLevels: string[];
    boundaryMode: "actual" | "indicative";
    city: string;
    country: string;
    count: number;
    generatedAt: string;
    province?: string;
    source: string;
  };
};

type CityCandidate = {
  adminLevel?: string;
  borderType?: string;
  center?: {
    lat: number;
    lon: number;
  };
  id: number;
  locationLabel?: string;
  name: string;
  ref?: string;
  sourceType?: "firestore";
};

type CitySearchResponse = {
  cities: CityCandidate[];
  metadata: {
    city: string;
    country: string;
    count: number;
    generatedAt: string;
    source?: "firestore" | "overpass";
  };
};

type OverlayEntry = {
  bounds: google.maps.LatLngBounds;
  cityKey: string;
  featureId: number;
  polygon: google.maps.Polygon;
};

type CityColor = {
  fillColor: string;
  pillBackground: string;
  pillBorder: string;
  strokeColor: string;
};

const DEFAULT_CITY = "San Jose City";
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const CITY_COLOR_PALETTE: CityColor[] = [
  { fillColor: "#ef4444", pillBackground: "#fef2f2", pillBorder: "#fecaca", strokeColor: "#dc2626" },
  { fillColor: "#f97316", pillBackground: "#fff7ed", pillBorder: "#fed7aa", strokeColor: "#ea580c" },
  { fillColor: "#eab308", pillBackground: "#fefce8", pillBorder: "#fde68a", strokeColor: "#ca8a04" },
  { fillColor: "#22c55e", pillBackground: "#f0fdf4", pillBorder: "#bbf7d0", strokeColor: "#16a34a" },
  { fillColor: "#14b8a6", pillBackground: "#f0fdfa", pillBorder: "#99f6e4", strokeColor: "#0f766e" },
  { fillColor: "#0ea5e9", pillBackground: "#f0f9ff", pillBorder: "#bae6fd", strokeColor: "#0284c7" },
  { fillColor: "#6366f1", pillBackground: "#eef2ff", pillBorder: "#c7d2fe", strokeColor: "#4f46e5" },
  { fillColor: "#a855f7", pillBackground: "#faf5ff", pillBorder: "#e9d5ff", strokeColor: "#9333ea" },
  { fillColor: "#ec4899", pillBackground: "#fdf2f8", pillBorder: "#fbcfe8", strokeColor: "#db2777" },
];

let googleMapsPromise: Promise<void> | null = null;

function loadGoogleMapsApi(apiKey: string) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps can only be loaded in the browser."));
  }

  if (window.google?.maps) {
    return Promise.resolve();
  }

  if (!googleMapsPromise) {
    googleMapsPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>('script[data-google-maps-loader="true"]');

      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), { once: true });
        existingScript.addEventListener("error", () => reject(new Error("Failed to load Google Maps.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMapsLoader = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Google Maps."));
      document.head.appendChild(script);
    });
  }

  return googleMapsPromise;
}

function extendBoundsFromPath(bounds: google.maps.LatLngBounds, path: google.maps.LatLngLiteral[]) {
  path.forEach((point) => bounds.extend(point));
}

function toLatLngPath(path: number[][]) {
  return path.map(([lng, lat]) => ({ lat, lng }));
}

function getFeatureGeometrySets(feature: BoundaryFeature) {
  if (feature.geometry.type === "Polygon") {
    return [feature.geometry.coordinates as number[][][]];
  }

  return feature.geometry.coordinates as number[][][][];
}

function getCityCandidateKey(candidate: CityCandidate) {
  return `${candidate.id}:${candidate.locationLabel ?? ""}:${candidate.name}`;
}

function buildPolygonStyle(color: CityColor, isActiveCity: boolean, isActiveFeature: boolean): google.maps.PolygonOptions {
  return {
    clickable: true,
    fillColor: color.fillColor,
    fillOpacity: isActiveFeature ? 0.34 : isActiveCity ? 0.24 : 0.12,
    strokeColor: color.strokeColor,
    strokeOpacity: 0.95,
    strokeWeight: isActiveFeature ? 3 : isActiveCity ? 2.5 : 2,
  };
}

export function CityMapExplorer() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const overlayEntriesRef = useRef<OverlayEntry[]>([]);
  const boundaryCacheRef = useRef<Record<string, BoundaryResponse>>({});
  const cityColorsRef = useRef<Record<string, CityColor>>({});

  const [city, setCity] = useState(DEFAULT_CITY);
  const [queryLabel, setQueryLabel] = useState(DEFAULT_CITY);
  const [cityCandidates, setCityCandidates] = useState<CityCandidate[]>([]);
  const [trackedCities, setTrackedCities] = useState<CityCandidate[]>([]);
  const [selectedCity, setSelectedCity] = useState<CityCandidate | null>(null);
  const [boundaryCache, setBoundaryCache] = useState<Record<string, BoundaryResponse>>({});
  const [cityColors, setCityColors] = useState<Record<string, CityColor>>({});
  const [cityLoading, setCityLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const [mapStatus, setMapStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [mapError, setMapError] = useState<string | null>(null);
  const missingKey = !GOOGLE_MAPS_API_KEY;
  const selectedCityKey = selectedCity ? getCityCandidateKey(selectedCity) : null;
  const data = selectedCityKey ? boundaryCache[selectedCityKey] ?? null : null;

  const displayedBoundaries = useMemo(() => {
    const seen = new Set<string>();
    const entries: Array<{ candidate: CityCandidate; cityKey: string; data: BoundaryResponse }> = [];

    trackedCities.forEach((candidate) => {
      const cityKey = getCityCandidateKey(candidate);
      const cityData = boundaryCache[cityKey];

      if (!cityData || seen.has(cityKey)) {
        return;
      }

      seen.add(cityKey);
      entries.push({ candidate, cityKey, data: cityData });
    });

    if (selectedCity && selectedCityKey && data && !seen.has(selectedCityKey)) {
      entries.push({ candidate: selectedCity, cityKey: selectedCityKey, data });
    }

    return entries;
  }, [boundaryCache, data, selectedCity, selectedCityKey, trackedCities]);

  useEffect(() => {
    boundaryCacheRef.current = boundaryCache;
  }, [boundaryCache]);

  useEffect(() => {
    cityColorsRef.current = cityColors;
  }, [cityColors]);

  const ensureCityColor = useCallback((cityKey: string) => {
    const existingColor = cityColorsRef.current[cityKey];

    if (existingColor) {
      return existingColor;
    }

    const usedFillColors = new Set(Object.values(cityColorsRef.current).map((entry) => entry.fillColor));
    const availableColors = CITY_COLOR_PALETTE.filter((entry) => !usedFillColors.has(entry.fillColor));
    const colorPool = availableColors.length ? availableColors : CITY_COLOR_PALETTE;
    const nextColor = colorPool[Math.floor(Math.random() * colorPool.length)];

    setCityColors((current) => {
      if (current[cityKey]) {
        return current;
      }

      const nextAssignments = {
        ...current,
        [cityKey]: nextColor,
      };
      cityColorsRef.current = nextAssignments;
      return nextAssignments;
    });

    return nextColor;
  }, []);

  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) {
      return;
    }

    let active = true;

    async function initMap() {
      if (!mapContainerRef.current || mapRef.current) {
        return;
      }

      setMapStatus("loading");

      try {
        const apiKey = GOOGLE_MAPS_API_KEY;

        if (!apiKey) {
          return;
        }

        await loadGoogleMapsApi(apiKey);

        if (!active || !mapContainerRef.current) {
          return;
        }

        const map = new google.maps.Map(mapContainerRef.current, {
          center: { lat: 14.5547, lng: 121.0244 },
          clickableIcons: false,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 9,
        });

        mapRef.current = map;
        infoWindowRef.current = new google.maps.InfoWindow();
        setMapStatus("ready");
      } catch (caughtError) {
        const message = caughtError instanceof Error ? caughtError.message : "Unable to load Google Maps.";

        if (active) {
          setMapStatus("error");
          setMapError(message);
        }
      }
    }

    void initMap();

    return () => {
      active = false;
      overlayEntriesRef.current.forEach((entry) => {
        google.maps.event.clearInstanceListeners(entry.polygon);
        entry.polygon.setMap(null);
      });
      overlayEntriesRef.current = [];
      infoWindowRef.current?.close();
      infoWindowRef.current = null;
      mapRef.current = null;
    };
  }, []);

  const fetchBoundary = useCallback(async (candidate: CityCandidate) => {
    const candidateKey = getCityCandidateKey(candidate);
    const params = new URLSearchParams({ city: candidate.name });

    if (candidate.locationLabel) {
      params.set("locationLabel", candidate.locationLabel);
    }

    setError(null);
    setWarning(null);
    setSelectedCity(candidate);
    setSelectedFeatureId(null);

    const cachedBoundary = boundaryCacheRef.current[candidateKey];
    ensureCityColor(candidateKey);

    if (cachedBoundary) {
      setQueryLabel(candidate.name);
      setSelectedFeatureId(cachedBoundary.features[0]?.properties.id ?? null);
      return cachedBoundary;
    }

    setLoading(true);

    try {
      const response = await fetchWithAppCheck(`/api/cities/boundary?${params.toString()}`);
      const payload = (await response.json()) as BoundaryResponse & { details?: string; error?: string };

      if (!response.ok) {
        if (response.status === 404) {
          setWarning("Polygons do not exist for this city.");
          return null;
        }
        throw new Error(payload.error ?? payload.details ?? "Request failed.");
      }

      setBoundaryCache((current) => {
        const nextCache = {
          ...current,
          [candidateKey]: payload,
        };
        boundaryCacheRef.current = nextCache;
        return nextCache;
      });
      setSelectedFeatureId(payload.features[0]?.properties.id ?? null);
      setQueryLabel(candidate.name);
      return payload;
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to load city boundary.";
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [ensureCityColor]);

  useEffect(() => {
    async function loadInitialCity() {
      setCityLoading(true);

      try {
        const params = new URLSearchParams({ city: DEFAULT_CITY });
        const response = await fetchWithAppCheck(`/api/cities?${params.toString()}`);
        const payload = (await response.json()) as CitySearchResponse & { details?: string; error?: string };

        if (!response.ok) {
          throw new Error(payload.error ?? payload.details ?? "Request failed.");
        }

        setCityCandidates(payload.cities);
        setQueryLabel(DEFAULT_CITY);
        setWarning(payload.cities.length ? null : "Polygons do not exist for this city.");

        if (payload.cities.length === 1) {
          await fetchBoundary(payload.cities[0]);
        }
      } catch (caughtError) {
        const message = caughtError instanceof Error ? caughtError.message : "Unable to search cities.";
        setError(message);
        setCityCandidates([]);
      } finally {
        setCityLoading(false);
      }
    }

    void loadInitialCity();
  }, [fetchBoundary]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !displayedBoundaries.length) {
      overlayEntriesRef.current.forEach((entry) => {
        google.maps.event.clearInstanceListeners(entry.polygon);
        entry.polygon.setMap(null);
      });
      overlayEntriesRef.current = [];
      return;
    }

    overlayEntriesRef.current.forEach((entry) => {
      google.maps.event.clearInstanceListeners(entry.polygon);
      entry.polygon.setMap(null);
    });
    overlayEntriesRef.current = [];

    const overallBounds = new google.maps.LatLngBounds();

    displayedBoundaries.forEach(({ candidate, cityKey, data: cityData }) => {
      const isActiveCity = cityKey === selectedCityKey;
      const cityColor = cityColors[cityKey] ?? ensureCityColor(cityKey);

      cityData.features.forEach((feature) => {
        const geometrySets = getFeatureGeometrySets(feature);

        geometrySets.forEach((polygonCoordinateSet) => {
          const polygonBounds = new google.maps.LatLngBounds();
          const paths = polygonCoordinateSet.map((ring) => {
            const latLngPath = toLatLngPath(ring);
            extendBoundsFromPath(polygonBounds, latLngPath);
            extendBoundsFromPath(overallBounds, latLngPath);
            return latLngPath;
          });

          const polygon = new google.maps.Polygon({
            ...buildPolygonStyle(cityColor, isActiveCity, false),
            map,
            paths,
          });

          polygon.addListener("click", (event: google.maps.MapMouseEvent) => {
            setSelectedCity(candidate);
            setSelectedFeatureId(feature.properties.id);
            setQueryLabel(candidate.name);

            if (event.latLng && infoWindowRef.current) {
              infoWindowRef.current.setContent(
                `<div style="font-family: Arial, sans-serif; padding: 2px 4px;"><strong>${feature.properties.name}</strong><br />${candidate.name}</div>`,
              );
              infoWindowRef.current.setPosition(event.latLng);
              infoWindowRef.current.open({ map });
            }
          });

          overlayEntriesRef.current.push({
            bounds: polygonBounds,
            cityKey,
            featureId: feature.properties.id,
            polygon,
          });
        });
      });
    });

    if (!overallBounds.isEmpty()) {
      map.fitBounds(overallBounds, 48);
    }
  }, [cityColors, displayedBoundaries, ensureCityColor, selectedCityKey]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !overlayEntriesRef.current.length) {
      return;
    }

    const selectedBounds = new google.maps.LatLngBounds();

    overlayEntriesRef.current.forEach((entry) => {
      const isActiveCity = entry.cityKey === selectedCityKey;
      const isSelected = isActiveCity && entry.featureId === selectedFeatureId;
      const cityColor = cityColors[entry.cityKey] ?? ensureCityColor(entry.cityKey);
      entry.polygon.setOptions(buildPolygonStyle(cityColor, isActiveCity, isSelected));

      if (isSelected) {
        selectedBounds.extend(entry.bounds.getNorthEast());
        selectedBounds.extend(entry.bounds.getSouthWest());
      }
    });

    if (selectedFeatureId && !selectedBounds.isEmpty()) {
      map.fitBounds(selectedBounds, 64);
    }
  }, [cityColors, ensureCityColor, selectedCityKey, selectedFeatureId]);

  async function searchCities(nextCity: string) {
    const params = new URLSearchParams({ city: nextCity });

    setCityLoading(true);
    setError(null);
    setWarning(null);

    try {
      const response = await fetchWithAppCheck(`/api/cities?${params.toString()}`);
      const payload = (await response.json()) as CitySearchResponse & { details?: string; error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? payload.details ?? "Request failed.");
      }

      setCityCandidates(payload.cities);
      setQueryLabel(nextCity);
      setWarning(payload.cities.length ? null : "Polygons do not exist for this city.");

      if (payload.cities.length === 1) {
        await fetchBoundary(payload.cities[0]);
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to search cities.";
      setError(message);
      setCityCandidates([]);
    } finally {
      setCityLoading(false);
    }
  }

  async function toggleTrackedCity(candidate: CityCandidate) {
    const candidateKey = getCityCandidateKey(candidate);
    const isTracked = trackedCities.some((entry) => getCityCandidateKey(entry) === candidateKey);

    if (isTracked) {
      setTrackedCities((current) => current.filter((entry) => getCityCandidateKey(entry) !== candidateKey));
      return;
    }

    const boundary = await fetchBoundary(candidate);

    if (!boundary) {
      return;
    }

    setTrackedCities((current) => {
      if (current.some((entry) => getCityCandidateKey(entry) === candidateKey)) {
        return current;
      }

      return [...current, candidate];
    });
  }

  function removeTrackedCity(candidate: CityCandidate) {
    const candidateKey = getCityCandidateKey(candidate);
    setTrackedCities((current) => current.filter((entry) => getCityCandidateKey(entry) !== candidateKey));
  }

  async function exportZone() {
    if (!selectedCity) {
      setError("Load a city first before exporting.");
      return;
    }

    const params = new URLSearchParams({ city: selectedCity.name });

    if (selectedCity.locationLabel) {
      params.set("locationLabel", selectedCity.locationLabel);
    }

    setExporting(true);

    try {
      const response = await fetchWithAppCheck(`/api/cities/export?${params.toString()}`);

      if (!response.ok) {
        const payload = (await response.json()) as { details?: string; error?: string };
        throw new Error(payload.error ?? payload.details ?? "Unable to export city zone.");
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const citySlug = selectedCity.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      anchor.href = downloadUrl;
      anchor.download = `${citySlug}-city-zone.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to export city zone.";
      setError(message);
    } finally {
      setExporting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextCity = city.trim();

    if (!nextCity) {
      setError("City is required.");
      return;
    }

    void searchCities(nextCity);
  }

  const selectedFeature =
    data?.features.find((feature) => feature.properties.id === selectedFeatureId) ??
    data?.features[0] ??
    null;

  return (
    <div className="workspace">
      <aside className="workspace-sidebar">
        <div className="workspace-scroll">
          <section className="sidebar-section">
            <p className="sidebar-kicker">City Boundary</p>
            <h1 className="sidebar-title">Cities</h1>
          </section>

          <section className="sidebar-section">
            <p className="sidebar-subtitle">Search</p>
            <form className="mt-4" onSubmit={handleSubmit}>
              <div className="search-shell city-search-shell">
                <div className="flex-1">
                  <input className="google-input" value={city} onChange={(event) => setCity(event.target.value)} placeholder="Search city, e.g. San Jose City" />
                </div>
                <button className="google-button" type="submit" disabled={cityLoading}>
                  {cityLoading ? "Searching..." : "Search"}
                </button>
              </div>
            </form>
            <div className="mt-4 meta-strip">
              <span>{cityCandidates.length ? `${cityCandidates.length} result${cityCandidates.length === 1 ? "" : "s"}` : "Ready"}</span>
              <span className="meta-dot">•</span>
              <span>{trackedCities.length} selected</span>
              <span className="meta-dot">•</span>
              <span>{selectedCity?.locationLabel ?? queryLabel}</span>
            </div>
            <button className="google-button mt-4 w-full rounded-full border border-neutral-200 bg-white px-5 py-3" disabled={!data || exporting} onClick={exportZone} type="button">
              {exporting ? "Exporting..." : "Export City Zone"}
            </button>
            {warning ? <p className="mt-4 text-sm leading-6 text-amber-700">{warning}</p> : null}
            {error ? <p className="mt-4 text-sm leading-6 text-red-700">{error}</p> : null}
          </section>

          <section className="sidebar-section">
            <div className="flex items-center justify-between gap-3">
              <p className="sidebar-subtitle">Selected Cities</p>
              <span className="text-xs text-neutral-500">{trackedCities.length} tracked</span>
            </div>
            <div className="mt-4">
              {!trackedCities.length ? (
                <p className="text-sm leading-7 text-neutral-500">Choose cities from the search results to keep them here.</p>
              ) : null}
              {trackedCities.map((candidate) => {
                const candidateKey = getCityCandidateKey(candidate);
                const cityColor = cityColors[candidateKey];
                const isCurrent = candidateKey === (selectedCity ? getCityCandidateKey(selectedCity) : null);

                return (
                  <div key={candidateKey} className={`simple-row ${isCurrent ? "simple-row-active" : ""}`}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => void fetchBoundary(candidate)} type="button">
                      <span className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: cityColor?.fillColor ?? "#9ca3af" }}
                        />
                        <span className="truncate">{candidate.name}</span>
                      </span>
                      {candidate.locationLabel ? <span className="mt-1 block text-xs text-neutral-600">{candidate.locationLabel}</span> : null}
                      <span className="mt-1 block text-xs text-neutral-500">
                        {candidate.ref ? `Code ${candidate.ref}` : `ID ${candidate.id}`}
                      </span>
                    </button>
                    <button
                      className="shrink-0 rounded-full border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-900"
                      onClick={() => removeTrackedCity(candidate)}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="sidebar-section">
            <div className="flex items-center justify-between gap-3">
              <p className="sidebar-subtitle">City Results</p>
              <span className="text-xs text-neutral-500">{cityLoading ? "Searching..." : `${cityCandidates.length} loaded`}</span>
            </div>
            <div className="mt-4">
              {!cityCandidates.length && !cityLoading ? (
                <p className="text-sm leading-7 text-neutral-500">No results.</p>
              ) : null}
              {cityCandidates.map((candidate) => {
                const candidateKey = getCityCandidateKey(candidate);
                const cityColor = cityColors[candidateKey];
                const isCurrent = candidateKey === (selectedCity ? getCityCandidateKey(selectedCity) : null);
                const isTracked = trackedCities.some((entry) => getCityCandidateKey(entry) === candidateKey);

                return (
                  <div key={candidateKey} className={`simple-row ${isCurrent ? "simple-row-active" : ""}`}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => void fetchBoundary(candidate)} type="button">
                      <span className="block truncate text-sm font-medium text-neutral-900">{candidate.name}</span>
                      {candidate.locationLabel ? <span className="mt-1 block text-xs text-neutral-600">{candidate.locationLabel}</span> : null}
                      <span className="mt-1 block text-xs text-neutral-500">
                        {candidate.ref ? `Code ${candidate.ref}` : `ID ${candidate.id}`}
                      </span>
                    </button>
                    <button
                      aria-pressed={isTracked}
                      className={`shrink-0 rounded-full border px-3 py-2 text-xs font-medium transition ${
                        isTracked
                          ? ""
                          : "border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
                      }`}
                      style={
                        isTracked && cityColor
                          ? {
                              backgroundColor: cityColor.pillBackground,
                              borderColor: cityColor.pillBorder,
                              color: cityColor.strokeColor,
                            }
                          : undefined
                      }
                      onClick={() => void toggleTrackedCity(candidate)}
                      type="button"
                    >
                      {isTracked ? "Selected" : "Select"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </aside>

      <section className="workspace-map">
        <div className="map-topline">
          <div>
            <h2 className="text-base font-medium text-neutral-900">{selectedFeature ? selectedFeature.properties.name : "City map"}</h2>
            <p className="mt-1 text-sm text-neutral-600">
              {selectedFeature
                ? "Boundary selected"
                : loading
                  ? "Loading..."
                  : "Select a city."}
            </p>
          </div>
          <div className="meta-strip">
            <span>{data?.metadata.province ?? selectedCity?.locationLabel ?? ""}</span>
          </div>
        </div>

        <div className="map-panel">
          {mapStatus === "error" ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-7 text-neutral-600">{mapError}</div>
          ) : missingKey ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-7 text-neutral-600">
              Add <code className="mx-1 rounded bg-neutral-200 px-1.5 py-0.5 text-xs">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code>
              to your <code className="mx-1 rounded bg-neutral-200 px-1.5 py-0.5 text-xs">.env</code> file to render Google Maps.
            </div>
          ) : (
            <div ref={mapContainerRef} className="simple-map h-full w-full" />
          )}
        </div>
      </section>
    </div>
  );
}
