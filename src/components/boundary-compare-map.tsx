"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type GeoJsonPolygon = {
  coordinates: number[][][];
  type: "Polygon";
};

type GeoJsonMultiPolygon = {
  coordinates: number[][][][];
  type: "MultiPolygon";
};

type CompareFeature = {
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  properties: Record<string, string | number | undefined>;
  type: "Feature";
};

type CompareCollection = {
  features: CompareFeature[];
  metadata?: {
    count?: number;
    source?: string;
  };
  type: "FeatureCollection";
};

type SourceId = "barangayMapSearch" | "ours";

type BoundarySource = {
  color: string;
  id: SourceId;
  label: string;
  url: string;
};

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const DEFAULT_CITY = "San Jose City";
const SOURCES: BoundarySource[] = [
  {
    color: "#e53935",
    id: "ours",
    label: "Our HDX/NAMRIA/PSA data",
    url: "/boundaries/nueva-ecija-barangays.geojson",
  },
  {
    color: "#1e88e5",
    id: "barangayMapSearch",
    label: "barangay_map_search data",
    url: "/boundaries/barangay-map-search-nueva-ecija.geojson",
  },
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

function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bcity of\b/g, "")
    .replace(/\bcity\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getCityName(feature: CompareFeature) {
  return String(feature.properties.adm3Name ?? feature.properties.city ?? "Unknown city");
}

function filterCollection(collection: CompareCollection, selectedCity: string): CompareCollection {
  if (selectedCity === "All") {
    return collection;
  }

  const expected = normalizeName(selectedCity);

  return {
    ...collection,
    features: collection.features.filter((feature) => normalizeName(getCityName(feature)) === expected),
  };
}

function extendBoundsFromGeometry(bounds: google.maps.LatLngBounds, geometry: GeoJsonPolygon | GeoJsonMultiPolygon) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  polygons.forEach((polygon) => {
    polygon.forEach((ring) => {
      ring.forEach(([lng, lat]) => bounds.extend({ lat, lng }));
    });
  });
}

function buildLayerStyle(color: string): google.maps.Data.StyleOptions {
  return {
    clickable: true,
    fillColor: color,
    fillOpacity: 0.16,
    strokeColor: color,
    strokeOpacity: 0.9,
    strokeWeight: 2,
    visible: true,
  };
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function BoundaryCompareMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const layersRef = useRef<google.maps.Data[]>([]);

  const [collections, setCollections] = useState<Partial<Record<SourceId, CompareCollection>>>({});
  const [selectedCity, setSelectedCity] = useState(DEFAULT_CITY);
  const [visibleSources, setVisibleSources] = useState<Record<SourceId, boolean>>({
    barangayMapSearch: true,
    ours: true,
  });
  const [status, setStatus] = useState<"error" | "loading" | "ready">("loading");
  const [error, setError] = useState<string | null>(null);
  const missingKey = !GOOGLE_MAPS_API_KEY;

  const cityOptions = useMemo(() => {
    const names = new Map<string, string>();

    Object.values(collections).forEach((collection) => {
      collection?.features.forEach((feature) => {
        const city = getCityName(feature);
        names.set(normalizeName(city), city);
      });
    });

    return ["All", ...Array.from(names.values()).sort((left, right) => left.localeCompare(right))];
  }, [collections]);

  const visibleCounts = useMemo(() => {
    return Object.fromEntries(
      SOURCES.map((source) => {
        const collection = collections[source.id];
        return [source.id, collection ? filterCollection(collection, selectedCity).features.length : 0];
      }),
    ) as Record<SourceId, number>;
  }, [collections, selectedCity]);

  useEffect(() => {
    let active = true;

    async function loadDataAndMap() {
      if (!GOOGLE_MAPS_API_KEY) {
        setStatus("error");
        setError("Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to .env to render Google Maps.");
        return;
      }

      try {
        const [, responses] = await Promise.all([
          loadGoogleMapsApi(GOOGLE_MAPS_API_KEY),
          Promise.all(
            SOURCES.map(async (source) => {
              const response = await fetch(source.url);

              if (!response.ok) {
                throw new Error(`Failed to load ${source.label}: ${response.status}`);
              }

              return [source.id, (await response.json()) as CompareCollection] as const;
            }),
          ),
        ]);

        if (!active || !mapContainerRef.current) {
          return;
        }

        const map = new google.maps.Map(mapContainerRef.current, {
          center: { lat: 15.75, lng: 121.05 },
          clickableIcons: false,
          fullscreenControl: true,
          mapTypeControl: true,
          streetViewControl: false,
          zoom: 10,
        });

        mapRef.current = map;
        infoWindowRef.current = new google.maps.InfoWindow();
        setCollections(Object.fromEntries(responses));
        setStatus("ready");
      } catch (caughtError) {
        if (!active) {
          return;
        }

        setStatus("error");
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load comparison map.");
      }
    }

    void loadDataAndMap();

    return () => {
      active = false;
      layersRef.current.forEach((layer) => layer.setMap(null));
      layersRef.current = [];
      infoWindowRef.current?.close();
      infoWindowRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || status !== "ready") {
      return;
    }

    layersRef.current.forEach((layer) => layer.setMap(null));
    layersRef.current = [];

    const bounds = new google.maps.LatLngBounds();

    SOURCES.forEach((source) => {
      if (!visibleSources[source.id]) {
        return;
      }

      const collection = collections[source.id];

      if (!collection) {
        return;
      }

      const filtered = filterCollection(collection, selectedCity);
      const layer = new google.maps.Data({ map });
      layer.addGeoJson(filtered);
      layer.setStyle(buildLayerStyle(source.color));
      layer.addListener("click", (event: google.maps.Data.MouseEvent) => {
        const feature = event.feature;
        const barangay = escapeHtml(String(feature.getProperty("adm4Name") ?? feature.getProperty("name") ?? "Unnamed barangay"));
        const city = escapeHtml(String(feature.getProperty("adm3Name") ?? feature.getProperty("city") ?? "Unknown city"));

        infoWindowRef.current?.setContent(
          `<div style="font-family:Arial,sans-serif;padding:4px 6px;line-height:1.5"><strong>${barangay}</strong><br />${city}</div>`,
        );

        if (event.latLng) {
          infoWindowRef.current?.setPosition(event.latLng);
          infoWindowRef.current?.open({ map });
        }
      });

      filtered.features.forEach((feature) => extendBoundsFromGeometry(bounds, feature.geometry));
      layersRef.current.push(layer);
    });

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, 48);
    }
  }, [collections, selectedCity, status, visibleSources]);

  return (
    <div className="workspace">
      <aside className="workspace-sidebar">
        <div className="workspace-scroll">
          <section className="sidebar-section">
            <p className="sidebar-kicker">Boundary Compare</p>
            <h1 className="sidebar-title">Compare</h1>
          </section>

          <section className="sidebar-section">
            <p className="sidebar-subtitle">Filter</p>
            <label className="mt-4 block text-sm font-medium text-neutral-700">
              City / municipality
              <select
                className="mt-2 w-full rounded-2xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900 outline-none focus:border-neutral-500"
                value={selectedCity}
                onChange={(event) => setSelectedCity(event.target.value)}
              >
                {cityOptions.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 space-y-2">
              {SOURCES.map((source) => (
                <label key={source.id} className="flex cursor-pointer items-center gap-3 py-2 text-sm text-neutral-700">
                  <input
                    checked={visibleSources[source.id]}
                    onChange={(event) =>
                      setVisibleSources((current) => ({
                        ...current,
                        [source.id]: event.target.checked,
                      }))
                    }
                    type="checkbox"
                  />
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: source.color }} />
                  <span>{source.id === "ours" ? "Red" : "Blue"}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="sidebar-section">
            <p className="sidebar-subtitle">Counts</p>
            <div className="mt-4 space-y-2 text-sm text-neutral-700">
              <p>Red: <strong className="text-neutral-900">{visibleCounts.ours}</strong></p>
              <p>Blue: <strong className="text-neutral-900">{visibleCounts.barangayMapSearch}</strong></p>
              <p>Difference: <strong className="text-neutral-900">{visibleCounts.ours - visibleCounts.barangayMapSearch}</strong></p>
            </div>
          </section>

        </div>
      </aside>

      <section className="workspace-map">
        <div className="map-topline">
          <div>
            <h2 className="text-base font-medium text-neutral-900">{selectedCity === "All" ? "Province-wide comparison" : selectedCity}</h2>
            <p className="mt-1 text-sm text-neutral-600">Compare</p>
          </div>
          <div className="meta-strip">
            <span>{visibleCounts.ours} red</span>
            <span className="meta-dot">•</span>
            <span>{visibleCounts.barangayMapSearch} blue</span>
          </div>
        </div>

        <div className="map-panel-tall">
          {missingKey || status === "error" ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-7 text-neutral-600">
              {error ?? "Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to .env to render Google Maps."}
            </div>
          ) : (
            <div className="relative h-full">
              {status === "loading" ? (
                <div className="absolute left-4 top-4 z-10 bg-white px-4 py-2 text-sm text-neutral-700">Loading comparison layers...</div>
              ) : null}
              <div ref={mapContainerRef} className="h-full w-full" />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
