"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

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
  featureId: number;
  polygon: google.maps.Polygon;
};

const DEFAULT_CITY = "San Jose City";
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

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

function buildPolygonStyle(selected: boolean): google.maps.PolygonOptions {
  return {
    clickable: true,
    fillColor: "#4285f4",
    fillOpacity: selected ? 0.26 : 0.16,
    strokeColor: selected ? "#1a73e8" : "#4285f4",
    strokeOpacity: 0.95,
    strokeWeight: selected ? 3 : 2,
  };
}

export function CityMapExplorer() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const overlayEntriesRef = useRef<OverlayEntry[]>([]);

  const [city, setCity] = useState(DEFAULT_CITY);
  const [queryLabel, setQueryLabel] = useState(DEFAULT_CITY);
  const [cityCandidates, setCityCandidates] = useState<CityCandidate[]>([]);
  const [selectedCity, setSelectedCity] = useState<CityCandidate | null>(null);
  const [data, setData] = useState<BoundaryResponse | null>(null);
  const [cityLoading, setCityLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const [mapStatus, setMapStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [mapError, setMapError] = useState<string | null>(null);
  const missingKey = !GOOGLE_MAPS_API_KEY;

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
        setData(null);
      } finally {
        setCityLoading(false);
      }
    }

    void loadInitialCity();
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !data?.features.length) {
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

    data.features.forEach((feature) => {
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
          ...buildPolygonStyle(false),
          map,
          paths,
        });

        polygon.addListener("click", (event: google.maps.MapMouseEvent) => {
          setSelectedFeatureId(feature.properties.id);

          if (event.latLng && infoWindowRef.current) {
            infoWindowRef.current.setContent(
              `<div style="font-family: Arial, sans-serif; padding: 2px 4px;"><strong>${feature.properties.name}</strong></div>`,
            );
            infoWindowRef.current.setPosition(event.latLng);
            infoWindowRef.current.open({ map });
          }
        });

        overlayEntriesRef.current.push({
          bounds: polygonBounds,
          featureId: feature.properties.id,
          polygon,
        });
      });
    });

    if (!overallBounds.isEmpty()) {
      map.fitBounds(overallBounds, 48);
    }
  }, [data]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !overlayEntriesRef.current.length) {
      return;
    }

    const selectedBounds = new google.maps.LatLngBounds();

    overlayEntriesRef.current.forEach((entry) => {
      const isSelected = entry.featureId === selectedFeatureId;
      entry.polygon.setOptions(buildPolygonStyle(isSelected));

      if (isSelected) {
        selectedBounds.extend(entry.bounds.getNorthEast());
        selectedBounds.extend(entry.bounds.getSouthWest());
      }
    });

    if (selectedFeatureId && !selectedBounds.isEmpty()) {
      map.fitBounds(selectedBounds, 64);
    }
  }, [selectedFeatureId]);

  async function searchCities(nextCity: string) {
    const params = new URLSearchParams({ city: nextCity });

    setCityLoading(true);
    setError(null);
    setWarning(null);
    setData(null);
    setSelectedCity(null);
    setSelectedFeatureId(null);

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
      setData(null);
    } finally {
      setCityLoading(false);
    }
  }

  async function fetchBoundary(candidate: CityCandidate) {
    const params = new URLSearchParams({ city: candidate.name });

    if (candidate.locationLabel) {
      params.set("locationLabel", candidate.locationLabel);
    }

    setLoading(true);
    setError(null);
    setWarning(null);
    setSelectedCity(candidate);
    setSelectedFeatureId(null);

    try {
      const response = await fetchWithAppCheck(`/api/cities/boundary?${params.toString()}`);
      const payload = (await response.json()) as BoundaryResponse & { details?: string; error?: string };

      if (!response.ok) {
        if (response.status === 404) {
          setWarning("Polygons do not exist for this city.");
          setData(null);
          return;
        }
        throw new Error(payload.error ?? payload.details ?? "Request failed.");
      }

      setData(payload);
      setSelectedFeatureId(payload.features[0]?.properties.id ?? null);
      setQueryLabel(candidate.name);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to load city boundary.";
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
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

  const selectedFeature = data?.features[0] ?? null;

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
              <p className="sidebar-subtitle">City Results</p>
              <span className="text-xs text-neutral-500">{cityLoading ? "Searching..." : `${cityCandidates.length} loaded`}</span>
            </div>
            <div className="mt-4">
              {!cityCandidates.length && !cityLoading ? (
                <p className="text-sm leading-7 text-neutral-500">No results.</p>
              ) : null}
              {cityCandidates.map((candidate) => {
                const isSelected = candidate.id === selectedCity?.id;

                return (
                  <button
                    key={candidate.id}
                    className={`simple-row ${isSelected ? "simple-row-active" : ""}`}
                    onClick={() => fetchBoundary(candidate)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm font-medium text-neutral-900">{candidate.name}</span>
                      {candidate.locationLabel ? <span className="mt-1 block text-xs text-neutral-600">{candidate.locationLabel}</span> : null}
                      <span className="mt-1 block text-xs text-neutral-500">
                        {candidate.ref ? `Code ${candidate.ref}` : `ID ${candidate.id}`}
                      </span>
                    </span>
                  </button>
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
