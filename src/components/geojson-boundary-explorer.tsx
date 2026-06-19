"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { fetchWithAppApiKey } from "@/lib/app-api-key-fetch";
import type { BoundaryFeatureCollection } from "@/lib/boundary-types";

type BoundaryFeature = BoundaryFeatureCollection["features"][number];

type GeoJsonLoadRequest = {
  fallbackPsgc?: string;
  geojson?: unknown;
  url?: string;
};

type OverlayEntry = {
  bounds: google.maps.LatLngBounds;
  color: string;
  featureId: number;
  polygon: google.maps.Polygon;
};

type SourceMode = "url" | "paste";

const DEFAULT_GEORISK_SANTA_RITA_URL =
  "https://portal.georisk.gov.ph/arcgis/rest/services/PSA/Barangay/MapServer/4/query?where=psgc_10d%3D%270301408010%27&outFields=*&returnGeometry=true&f=geojson&outSR=4326";
const DEFAULT_GEORISK_SANTA_RITA_PSGC = "0301408010";
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const mapPalette = ["#dc2626", "#0ea5e9", "#16a34a", "#ca8a04", "#7c3aed", "#0891b2"];

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

function buildPolygonStyle(color: string, selected: boolean): google.maps.PolygonOptions {
  return {
    clickable: true,
    fillColor: color,
    fillOpacity: selected ? 0.34 : 0.18,
    strokeColor: color,
    strokeOpacity: 0.95,
    strokeWeight: selected ? 3 : 2,
    zIndex: selected ? 20 : 10,
  };
}

function readDownloadFilename(response: Response) {
  const disposition = response.headers.get("Content-Disposition");

  if (!disposition) {
    return null;
  }

  const match = disposition.match(/filename="([^"]+)"/i);
  return match?.[1] ?? null;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildUrlRequest(url: string): GeoJsonLoadRequest {
  return {
    fallbackPsgc: url === DEFAULT_GEORISK_SANTA_RITA_URL ? DEFAULT_GEORISK_SANTA_RITA_PSGC : undefined,
    url,
  };
}

function sourceSummary(data: BoundaryFeatureCollection | null) {
  if (!data) {
    return null;
  }

  if (data.metadata.source.startsWith("Local HDX/COD-AB fallback")) {
    return data.metadata.dataset?.name ?? "Local fallback";
  }

  return data.metadata.dataset?.name ?? data.metadata.source;
}

export function GeoJsonBoundaryExplorer() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const overlayEntriesRef = useRef<OverlayEntry[]>([]);
  const loadedDefaultRef = useRef(false);

  const [sourceMode, setSourceMode] = useState<SourceMode>("url");
  const [geoJsonUrl, setGeoJsonUrl] = useState(DEFAULT_GEORISK_SANTA_RITA_URL);
  const [rawGeoJsonText, setRawGeoJsonText] = useState("");
  const [data, setData] = useState<BoundaryFeatureCollection | null>(null);
  const [lastRequest, setLastRequest] = useState<GeoJsonLoadRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          center: { lat: 14.858, lng: 120.864 },
          clickableIcons: false,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 13,
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
    if (loadedDefaultRef.current) {
      return;
    }

    loadedDefaultRef.current = true;
    void loadBoundary(buildUrlRequest(DEFAULT_GEORISK_SANTA_RITA_URL));
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

    data.features.forEach((feature, featureIndex) => {
      const color = mapPalette[featureIndex % mapPalette.length];
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
          ...buildPolygonStyle(color, false),
          map,
          paths,
        });

        polygon.addListener("click", (event: google.maps.MapMouseEvent) => {
          setSelectedFeatureId(feature.properties.id);

          if (event.latLng && infoWindowRef.current) {
            infoWindowRef.current.setContent(
              `<div style="font-family: Arial, sans-serif; padding: 2px 4px;"><strong>${escapeHtml(feature.properties.name)}</strong></div>`,
            );
            infoWindowRef.current.setPosition(event.latLng);
            infoWindowRef.current.open({ map });
          }
        });

        overlayEntriesRef.current.push({
          bounds: polygonBounds,
          color,
          featureId: feature.properties.id,
          polygon,
        });
      });
    });

    if (!overallBounds.isEmpty()) {
      map.fitBounds(overallBounds, 48);
    }
  }, [data, mapStatus]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !overlayEntriesRef.current.length) {
      return;
    }

    const selectedBounds = new google.maps.LatLngBounds();

    overlayEntriesRef.current.forEach((entry) => {
      const isSelected = entry.featureId === selectedFeatureId;
      entry.polygon.setOptions(buildPolygonStyle(entry.color, isSelected));

      if (isSelected) {
        selectedBounds.extend(entry.bounds.getNorthEast());
        selectedBounds.extend(entry.bounds.getSouthWest());
      }
    });

    if (selectedFeatureId && !selectedBounds.isEmpty()) {
      map.fitBounds(selectedBounds, 64);
    }
  }, [selectedFeatureId]);

  async function loadBoundary(requestBody: GeoJsonLoadRequest) {
    setLoading(true);
    setError(null);
    setSelectedFeatureId(null);

    try {
      const response = await fetchWithAppApiKey("/api/geojson-boundary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json()) as BoundaryFeatureCollection & { details?: string; error?: string };

      if (!response.ok) {
        throw new Error(payload.details ?? payload.error ?? "Unable to load GeoJSON boundary.");
      }

      setData(payload);
      setLastRequest(requestBody);
      setSelectedFeatureId(payload.features[0]?.properties.id ?? null);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to load GeoJSON boundary.";
      setError(message);
      setData(null);
      setLastRequest(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadFromUrl() {
    const url = geoJsonUrl.trim();

    if (!url) {
      setError("GeoJSON URL is required.");
      return;
    }

    await loadBoundary(buildUrlRequest(url));
  }

  async function loadFromPaste() {
    if (!rawGeoJsonText.trim()) {
      setError("Paste GeoJSON before rendering.");
      return;
    }

    let geojson: unknown;

    try {
      geojson = JSON.parse(rawGeoJsonText);
    } catch {
      setError("Pasted GeoJSON is not valid JSON.");
      return;
    }

    await loadBoundary({ geojson });
  }

  async function exportSql() {
    if (!lastRequest) {
      setError("Render GeoJSON before exporting SQL.");
      return;
    }

    setExporting(true);
    setError(null);

    try {
      const response = await fetchWithAppApiKey("/api/geojson-boundary/export?format=sql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(lastRequest),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { details?: string; error?: string };
        throw new Error(payload.details ?? payload.error ?? "Unable to export SQL.");
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = readDownloadFilename(response) ?? "geojson-zone.sql";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to export SQL.";
      setError(message);
    } finally {
      setExporting(false);
    }
  }

  function handleUrlSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadFromUrl();
  }

  function handlePasteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadFromPaste();
  }

  const features = data?.features ?? [];
  const selectedFeature = features.find((feature) => feature.properties.id === selectedFeatureId) ?? features[0] ?? null;
  const sourceLabel = sourceSummary(data);

  return (
    <div className="workspace">
      <aside className="workspace-sidebar">
        <div className="workspace-scroll">
          <section className="sidebar-section">
            <p className="sidebar-kicker">GeoJSON Boundary</p>
            <h1 className="sidebar-title">GeoJSON</h1>
          </section>

          <section className="sidebar-section">
            <div className="segmented-control">
              <button
                className={`segmented-button ${sourceMode === "url" ? "segmented-button-active" : ""}`}
                onClick={() => setSourceMode("url")}
                type="button"
              >
                URL
              </button>
              <button
                className={`segmented-button ${sourceMode === "paste" ? "segmented-button-active" : ""}`}
                onClick={() => setSourceMode("paste")}
                type="button"
              >
                Paste
              </button>
            </div>

            {sourceMode === "url" ? (
              <form className="mt-4" onSubmit={handleUrlSubmit}>
                <div className="geojson-url-shell">
                  <input
                    className="google-input"
                    value={geoJsonUrl}
                    onChange={(event) => setGeoJsonUrl(event.target.value)}
                    placeholder="GeoJSON URL"
                  />
                  <button className="google-button" disabled={loading} type="submit">
                    {loading ? "Rendering..." : "Render URL"}
                  </button>
                </div>
              </form>
            ) : (
              <form className="mt-4" onSubmit={handlePasteSubmit}>
                <textarea
                  className="geojson-textarea"
                  value={rawGeoJsonText}
                  onChange={(event) => setRawGeoJsonText(event.target.value)}
                  placeholder='{"type":"FeatureCollection","features":[]}'
                  spellCheck={false}
                />
                <button className="google-button mt-3 w-full rounded-full border border-neutral-200 bg-white px-5 py-3" disabled={loading} type="submit">
                  {loading ? "Rendering..." : "Render Paste"}
                </button>
              </form>
            )}

            <div className="mt-4 meta-strip">
              <span>{features.length ? `${features.length} loaded` : "Ready"}</span>
              <span>{data?.metadata.province ?? data?.metadata.city ?? "Santa Rita default"}</span>
            </div>
            <button className="google-button mt-4 w-full rounded-full border border-neutral-200 bg-white px-5 py-3" disabled={!lastRequest || exporting} onClick={() => void exportSql()} type="button">
              {exporting ? "Exporting..." : "Export SQL"}
            </button>
            {error ? <p className="mt-4 text-sm leading-6 text-red-700">{error}</p> : null}
          </section>

          <section className="sidebar-section">
            <div className="flex items-center justify-between gap-3">
              <p className="sidebar-subtitle">Features</p>
              <span className="text-xs text-neutral-500">{loading ? "Refreshing..." : `${features.length} loaded`}</span>
            </div>
            <div className="mt-4">
              {!features.length && !loading ? <p className="text-sm leading-7 text-neutral-500">No GeoJSON rendered.</p> : null}
              {features.map((feature, index) => {
                const isSelected = feature.properties.id === selectedFeatureId;

                return (
                  <button
                    key={`${feature.properties.id}:${feature.properties.name}`}
                    className={`simple-row ${isSelected ? "simple-row-active" : ""}`}
                    onClick={() => setSelectedFeatureId(feature.properties.id)}
                    type="button"
                  >
                    <span className="mt-1 h-2.5 w-2.5 flex-none rounded-full" style={{ backgroundColor: mapPalette[index % mapPalette.length] }} />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm font-medium text-neutral-900">{feature.properties.name}</span>
                      {feature.properties.psgcCode ? <span className="mt-1 block text-xs text-neutral-500">PSGC {feature.properties.psgcCode}</span> : null}
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
            <h2 className="text-base font-medium text-neutral-900">{selectedFeature ? selectedFeature.properties.name : "GeoJSON boundary map"}</h2>
            <p className="mt-1 text-sm text-neutral-600">{selectedFeature ? "Boundary selected" : loading ? "Loading..." : "Render a GeoJSON boundary."}</p>
          </div>
          <div className="meta-strip">
            <span>{data?.metadata.count ?? 0} feature{data?.metadata.count === 1 ? "" : "s"}</span>
            {sourceLabel ? <span>{sourceLabel}</span> : null}
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
