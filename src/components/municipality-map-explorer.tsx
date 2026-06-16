"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchWithAppApiKey } from "@/lib/app-api-key-fetch";
import type { BoundaryFeatureCollection, CityBoundaryCandidate } from "@/lib/boundary-types";
import { resolveNonOverlappingBoundaryCollections } from "@/lib/non-overlapping-city-boundaries";

type BoundaryFeature = BoundaryFeatureCollection["features"][number];
type BoundaryResponse = BoundaryFeatureCollection;
type LocalityCandidate = CityBoundaryCandidate;

type ProvinceLocalitiesResponse = {
  boundaries?: MergedMunicipalityBoundary[];
  metadata: {
    count: number;
    country: string;
    firebaseCount?: number;
    generatedAt: string;
    missingCount?: number;
    nativeZoneCount?: number;
    osmCompatibleCount?: number;
    osmIncompatibleCount?: number;
    province: string;
    source?: "firebase-native-osm-merged" | "firebase-native-psgc-list" | "firebase-osm-merged" | "firestore";
  };
  municipalities: LocalityCandidate[];
};

type MergedMunicipalityBoundary = {
  boundary: BoundaryResponse | null;
  candidate: LocalityCandidate;
  status: "firebase" | "native-zone" | "osm-compatible" | "osm-incompatible" | "missing";
};

type BoundaryComparisonResponse = {
  locality: string;
  native: BoundaryResponse;
  osm: BoundaryResponse;
  province?: string;
  stats: {
    algorithmicCompensation: {
      applied: boolean;
      generatedPointPercent: number;
      note: string;
    };
    areaDeltaM2: number | null;
    areaDeltaPercentOfNative: number | null;
    intersectionAreaM2: number;
    iou: number | null;
    nativeAreaM2: number | null;
    nativeOnlyAreaM2: number | null;
    nativeOverlapPercent: number | null;
    nativeVertexCount: number;
    osmAreaM2: number | null;
    osmOnlyAreaM2: number | null;
    osmOverlapPercent: number | null;
    osmVertexCount: number;
  };
};

type OverlayEntry = {
  bounds: google.maps.LatLngBounds;
  cityKey: string;
  featureId: number;
  polygon: google.maps.Polygon;
};

type ExportFormat = "json" | "sql";
type MapTab = "localities" | "comparison";

type LocalityColor = {
  fillColor: string;
  pillBackground: string;
  pillBorder: string;
  strokeColor: string;
};

const DEFAULT_PROVINCE = "Nueva Ecija";
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const BULK_SELECTION_CONCURRENCY = 6;
const NATIVE_ZONE_LAYER_KEY = "__native-zone-sql";
const LOCALITY_COLOR_PALETTE: LocalityColor[] = [
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

function getLocalityCandidateKey(candidate: LocalityCandidate) {
  return `${candidate.id}:${candidate.locationLabel ?? ""}:${candidate.name}`;
}

function buildPolygonStyle(color: LocalityColor, isActiveLocality: boolean, isActiveFeature: boolean): google.maps.PolygonOptions {
  return {
    clickable: true,
    fillColor: color.fillColor,
    fillOpacity: isActiveFeature ? 0.34 : isActiveLocality ? 0.24 : 0.12,
    strokeColor: color.strokeColor,
    strokeOpacity: 0.95,
    strokeWeight: isActiveFeature ? 3 : isActiveLocality ? 2.5 : 2,
    zIndex: isActiveFeature ? 30 : isActiveLocality ? 20 : 10,
  };
}

function buildNativeZoneStyle(isActiveFeature: boolean): google.maps.PolygonOptions {
  return {
    clickable: true,
    fillColor: "#2563eb",
    fillOpacity: isActiveFeature ? 0.16 : 0.08,
    strokeColor: "#1d4ed8",
    strokeOpacity: isActiveFeature ? 0.85 : 0.48,
    strokeWeight: isActiveFeature ? 2.5 : 1.5,
    zIndex: isActiveFeature ? 18 : 6,
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

function clearPolygons(polygons: google.maps.Polygon[]) {
  polygons.forEach((polygon) => {
    google.maps.event.clearInstanceListeners(polygon);
    polygon.setMap(null);
  });
}

function drawBoundaryCollection({
  collection,
  fillColor,
  map,
  strokeColor,
}: {
  collection: BoundaryResponse;
  fillColor: string;
  map: google.maps.Map;
  strokeColor: string;
}) {
  const bounds = new google.maps.LatLngBounds();
  const polygons: google.maps.Polygon[] = [];

  collection.features.forEach((feature) => {
    getFeatureGeometrySets(feature).forEach((polygonCoordinateSet) => {
      const paths = polygonCoordinateSet.map((ring) => {
        const latLngPath = toLatLngPath(ring);
        extendBoundsFromPath(bounds, latLngPath);
        return latLngPath;
      });
      const polygon = new google.maps.Polygon({
        clickable: false,
        fillColor,
        fillOpacity: 0.12,
        map,
        paths,
        strokeColor,
        strokeOpacity: 0.95,
        strokeWeight: 2.5,
        zIndex: 10,
      });

      polygons.push(polygon);
    });
  });

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, 40);
  }

  return polygons;
}

function formatSquareMeters(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} km2`;
  }

  return `${value.toFixed(0)} m2`;
}

function formatPercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(2)}%`;
}

function normalizeClientText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function localityTypeLabel(candidate: LocalityCandidate) {
  if (candidate.localityType === "city") {
    return "City";
  }

  if (candidate.localityType === "municipality") {
    return "Municipality";
  }

  return "Locality";
}

function localitySortScore(candidate: LocalityCandidate, filterQuery: string) {
  const normalizedQuery = normalizeClientText(filterQuery);

  if (!normalizedQuery) {
    return 0;
  }

  const normalizedName = normalizeClientText(candidate.name);

  if (normalizedName === normalizedQuery) {
    return 0;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 1;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 2;
  }

  return 3;
}

function renderableMergedBoundaries(boundaries: MergedMunicipalityBoundary[] | undefined) {
  return (boundaries ?? []).filter(
    (entry) => entry.boundary?.features.length && entry.status !== "osm-incompatible",
  );
}

function exportRelationId(candidate: LocalityCandidate, boundary: BoundaryResponse) {
  if (candidate.sourceType === "overpass" || candidate.sourceType === "osm") {
    return candidate.id;
  }

  const primaryFeature = boundary.features[0];

  if (primaryFeature?.properties.sourceType === "relation") {
    return boundary.metadata.cityBoundary?.id ?? primaryFeature.properties.id;
  }

  return undefined;
}

type FetchBoundaryOptions = {
  reportErrors?: boolean;
  selectCandidate?: boolean;
  setLoadingState?: boolean;
};

export function MunicipalityMapExplorer() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const nativeCompareMapContainerRef = useRef<HTMLDivElement | null>(null);
  const osmCompareMapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const nativeCompareMapRef = useRef<google.maps.Map | null>(null);
  const osmCompareMapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const overlayEntriesRef = useRef<OverlayEntry[]>([]);
  const comparisonOverlayEntriesRef = useRef<google.maps.Polygon[]>([]);
  const boundaryCacheRef = useRef<Record<string, BoundaryResponse>>({});
  const localityColorsRef = useRef<Record<string, LocalityColor>>({});
  const boundaryRequestIdRef = useRef(0);
  const comparisonRequestIdRef = useRef(0);
  const provinceRequestIdRef = useRef(0);

  const [provinceInput, setProvinceInput] = useState(DEFAULT_PROVINCE);
  const [loadedProvinceLabel, setLoadedProvinceLabel] = useState("No province loaded");
  const [filterQuery, setFilterQuery] = useState("");
  const [localityCandidates, setLocalityCandidates] = useState<LocalityCandidate[]>([]);
  const [trackedLocalities, setTrackedLocalities] = useState<LocalityCandidate[]>([]);
  const [selectedLocality, setSelectedLocality] = useState<LocalityCandidate | null>(null);
  const [boundaryCache, setBoundaryCache] = useState<Record<string, BoundaryResponse>>({});
  const [localityColors, setLocalityColors] = useState<Record<string, LocalityColor>>({});
  const [provinceLoading, setProvinceLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [activeMapTab, setActiveMapTab] = useState<MapTab>("localities");
  const [bulkSelecting, setBulkSelecting] = useState(false);
  const [comparisonData, setComparisonData] = useState<BoundaryComparisonResponse | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nativeZonesLoading = false;
  const [warning, setWarning] = useState<string | null>(null);
  const [selectedNativeZoneId, setSelectedNativeZoneId] = useState<number | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const [mapStatus, setMapStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [mapError, setMapError] = useState<string | null>(null);
  const missingKey = !GOOGLE_MAPS_API_KEY;
  const selectedLocalityKey = selectedLocality ? getLocalityCandidateKey(selectedLocality) : null;
  const data = selectedLocalityKey ? boundaryCache[selectedLocalityKey] ?? null : null;

  const filteredLocalityCandidates = useMemo(() => {
    const normalizedFilter = normalizeClientText(filterQuery);

    return localityCandidates
      .filter((candidate) => {
        if (!normalizedFilter) {
          return true;
        }

        return normalizeClientText(candidate.name).includes(normalizedFilter);
      })
      .sort((left, right) => {
        const scoreDelta = localitySortScore(left, filterQuery) - localitySortScore(right, filterQuery);

        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        if (left.localityType === "municipality" && right.localityType === "city") {
          return -1;
        }

        if (left.localityType === "city" && right.localityType === "municipality") {
          return 1;
        }

        return left.name.localeCompare(right.name);
      });
  }, [filterQuery, localityCandidates]);

  const displayedBoundaries = useMemo(() => {
    const seen = new Set<string>();
    const entries: Array<{ candidate: LocalityCandidate; cityKey: string; data: BoundaryResponse }> = [];

    trackedLocalities.forEach((candidate) => {
      const cityKey = getLocalityCandidateKey(candidate);
      const localityData = boundaryCache[cityKey];

      if (!localityData || seen.has(cityKey)) {
        return;
      }

      seen.add(cityKey);
      entries.push({ candidate, cityKey, data: localityData });
    });

    if (selectedLocality && selectedLocalityKey && data && !seen.has(selectedLocalityKey)) {
      entries.push({ candidate: selectedLocality, cityKey: selectedLocalityKey, data });
    }

    return entries;
  }, [boundaryCache, data, selectedLocality, selectedLocalityKey, trackedLocalities]);

  const resolvedDisplayedBoundaries = useMemo(() => {
    const resolvedCollections = resolveNonOverlappingBoundaryCollections(displayedBoundaries.map((entry) => entry.data));

    return displayedBoundaries
      .map((entry, index) => ({
        ...entry,
        data: resolvedCollections[index],
      }))
      .filter((entry) => entry.data.features.length)
      .sort((left, right) => {
        if (left.cityKey === selectedLocalityKey && right.cityKey !== selectedLocalityKey) {
          return 1;
        }

        if (right.cityKey === selectedLocalityKey && left.cityKey !== selectedLocalityKey) {
          return -1;
        }

        return 0;
      });
  }, [displayedBoundaries, selectedLocalityKey]);

  const exportCandidates = useMemo(() => resolvedDisplayedBoundaries.map((entry) => entry.candidate), [resolvedDisplayedBoundaries]);
  const visibleLocalityKeys = useMemo(
    () => new Set(filteredLocalityCandidates.map((candidate) => getLocalityCandidateKey(candidate))),
    [filteredLocalityCandidates],
  );
  const allVisibleSelected =
    filteredLocalityCandidates.length > 0 &&
    filteredLocalityCandidates.every((candidate) =>
      trackedLocalities.some((entry) => getLocalityCandidateKey(entry) === getLocalityCandidateKey(candidate)),
    );

  useEffect(() => {
    boundaryCacheRef.current = boundaryCache;
  }, [boundaryCache]);

  useEffect(() => {
    localityColorsRef.current = localityColors;
  }, [localityColors]);

  const ensureLocalityColor = useCallback((cityKey: string) => {
    const existingColor = localityColorsRef.current[cityKey];

    if (existingColor) {
      return existingColor;
    }

    const usedFillColors = new Set(Object.values(localityColorsRef.current).map((entry) => entry.fillColor));
    const availableColors = LOCALITY_COLOR_PALETTE.filter((entry) => !usedFillColors.has(entry.fillColor));
    const colorPool = availableColors.length ? availableColors : LOCALITY_COLOR_PALETTE;
    const nextColor = colorPool[Math.floor(Math.random() * colorPool.length)];

    setLocalityColors((current) => {
      if (current[cityKey]) {
        return current;
      }

      const nextAssignments = {
        ...current,
        [cityKey]: nextColor,
      };
      localityColorsRef.current = nextAssignments;
      return nextAssignments;
    });

    return nextColor;
  }, []);

  const ensureLocalityColors = useCallback((cityKeys: string[]) => {
    const uniqueMissingKeys = Array.from(new Set(cityKeys)).filter((cityKey) => !localityColorsRef.current[cityKey]);

    if (!uniqueMissingKeys.length) {
      return;
    }

    setLocalityColors((current) => {
      const nextAssignments = { ...current };
      let usedFillColors = new Set(Object.values(nextAssignments).map((entry) => entry.fillColor));

      uniqueMissingKeys.forEach((cityKey) => {
        if (nextAssignments[cityKey]) {
          return;
        }

        const availableColors = LOCALITY_COLOR_PALETTE.filter((entry) => !usedFillColors.has(entry.fillColor));
        const colorPool = availableColors.length ? availableColors : LOCALITY_COLOR_PALETTE;
        const nextColor = colorPool[Math.floor(Math.random() * colorPool.length)];

        nextAssignments[cityKey] = nextColor;
        usedFillColors = new Set([...usedFillColors, nextColor.fillColor]);
      });

      localityColorsRef.current = nextAssignments;
      return nextAssignments;
    });
  }, []);

  const applyMergedBoundaryPayload = useCallback((payload: ProvinceLocalitiesResponse) => {
    const renderableBoundaries = renderableMergedBoundaries(payload.boundaries);
    const nextBoundaryEntries: Record<string, BoundaryResponse> = {};
    const nextTrackedLocalities: LocalityCandidate[] = [];
    const nextTrackedKeys: string[] = [];

    renderableBoundaries.forEach((entry) => {
      if (!entry.boundary) {
        return;
      }

      const candidateKey = getLocalityCandidateKey(entry.candidate);
      nextBoundaryEntries[candidateKey] = entry.boundary;
      nextTrackedLocalities.push(entry.candidate);
      nextTrackedKeys.push(candidateKey);
    });

    ensureLocalityColors(nextTrackedKeys);

    if (Object.keys(nextBoundaryEntries).length) {
      setBoundaryCache((current) => {
        const nextCache = {
          ...current,
          ...nextBoundaryEntries,
        };
        boundaryCacheRef.current = nextCache;
        return nextCache;
      });
    }

    setTrackedLocalities(nextTrackedLocalities);
    setSelectedLocality(nextTrackedLocalities[0] ?? null);
    setSelectedFeatureId(renderableBoundaries[0]?.boundary?.features[0]?.properties.id ?? null);

    const missingCount = payload.metadata.missingCount ?? 0;
    const nativeCount = payload.metadata.nativeZoneCount ?? 0;
    const incompatibleCount = payload.metadata.osmIncompatibleCount ?? 0;
    const osmCount = payload.metadata.osmCompatibleCount ?? 0;

    if (missingCount || incompatibleCount) {
      setWarning(
        `${missingCount} localit${missingCount === 1 ? "y is" : "ies are"} still missing boundaries. ${incompatibleCount} OSM fallback${incompatibleCount === 1 ? " was" : "s were"} held back by compatibility checks. ${nativeCount} native zone${nativeCount === 1 ? " was" : "s were"} rendered.`,
      );
      return;
    }

    if (osmCount || nativeCount) {
      setWarning(
        `${osmCount} OSM fallback boundar${osmCount === 1 ? "y was" : "ies were"} merged. ${nativeCount} native zone${nativeCount === 1 ? " was" : "s were"} rendered.`,
      );
      return;
    }

    setWarning(null);
  }, [ensureLocalityColors]);
  const applyMergedBoundaryPayloadRef = useRef(applyMergedBoundaryPayload);

  useEffect(() => {
    applyMergedBoundaryPayloadRef.current = applyMergedBoundaryPayload;
  }, [applyMergedBoundaryPayload]);

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

  const fetchBoundary = useCallback(async (candidate: LocalityCandidate, options: FetchBoundaryOptions = {}) => {
    const {
      reportErrors = true,
      selectCandidate = true,
      setLoadingState = true,
    } = options;
    const candidateKey = getLocalityCandidateKey(candidate);
    const requestId = selectCandidate ? boundaryRequestIdRef.current + 1 : boundaryRequestIdRef.current;
    const params = new URLSearchParams({ city: candidate.name });

    if (selectCandidate) {
      boundaryRequestIdRef.current = requestId;
    }

    if (candidate.locationLabel) {
      params.set("locationLabel", candidate.locationLabel);
    }

    if (reportErrors) {
      setError(null);
      setWarning(null);
    }

    if (selectCandidate) {
      setSelectedLocality(candidate);
      setSelectedFeatureId(null);
      setSelectedNativeZoneId(null);
    }

    const cachedBoundary = boundaryCacheRef.current[candidateKey];
    ensureLocalityColor(candidateKey);

    if (cachedBoundary) {
      if (selectCandidate) {
        setSelectedFeatureId(cachedBoundary.features[0]?.properties.id ?? null);
      }
      return cachedBoundary;
    }

    if (setLoadingState) {
      setLoading(true);
    }

    try {
      const response = await fetchWithAppApiKey(`/api/cities/boundary?${params.toString()}`);
      const payload = (await response.json()) as BoundaryResponse & { details?: string; error?: string };

      if (selectCandidate && boundaryRequestIdRef.current !== requestId) {
        return null;
      }

      if (!response.ok) {
        if (response.status === 404) {
          if (reportErrors) {
            setWarning("Polygons do not exist for this locality.");
          }
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
      if (selectCandidate) {
        setSelectedFeatureId(payload.features[0]?.properties.id ?? null);
      }
      return payload;
    } catch (caughtError) {
      if (selectCandidate && boundaryRequestIdRef.current !== requestId) {
        return null;
      }

      const message = caughtError instanceof Error ? caughtError.message : "Unable to load locality boundary.";
      if (reportErrors) {
        setError(message);
      }
      return null;
    } finally {
      if (setLoadingState && (!selectCandidate || boundaryRequestIdRef.current === requestId)) {
        setLoading(false);
      }
    }
  }, [ensureLocalityColor]);

  const fetchBoundaryComparison = useCallback(async (candidate: LocalityCandidate | null) => {
    const requestId = comparisonRequestIdRef.current + 1;
    comparisonRequestIdRef.current = requestId;

    if (!candidate) {
      setComparisonData(null);
      setComparisonError("Select a municipality or city to compare.");
      return;
    }

    const params = new URLSearchParams({
      locality: candidate.name,
    });

    if (candidate.locationLabel) {
      params.set("province", candidate.locationLabel);
    }

    setComparisonLoading(true);
    setComparisonError(null);

    try {
      const response = await fetchWithAppApiKey(`/api/municipalities/compare?${params.toString()}`);
      const payload = (await response.json()) as BoundaryComparisonResponse & { details?: string; error?: string };

      if (comparisonRequestIdRef.current !== requestId) {
        return;
      }

      if (!response.ok) {
        throw new Error(payload.error ?? payload.details ?? "Request failed.");
      }

      setComparisonData(payload);
    } catch (caughtError) {
      if (comparisonRequestIdRef.current !== requestId) {
        return;
      }

      const message = caughtError instanceof Error ? caughtError.message : "Unable to compare boundaries.";
      setComparisonData(null);
      setComparisonError(message);
    } finally {
      if (comparisonRequestIdRef.current === requestId) {
        setComparisonLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const nativeZoneFeatures: BoundaryFeature[] = [];

    if (!map || (!resolvedDisplayedBoundaries.length && !nativeZoneFeatures.length)) {
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

    nativeZoneFeatures.forEach((feature) => {
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
          ...buildNativeZoneStyle(false),
          map,
          paths,
        });

        polygon.addListener("click", (event: google.maps.MapMouseEvent) => {
          setSelectedNativeZoneId(feature.properties.id);
          setSelectedFeatureId(null);

          if (event.latLng && infoWindowRef.current) {
            infoWindowRef.current.setContent(
              `<div style="font-family: Arial, sans-serif; padding: 2px 4px;"><strong>${feature.properties.name}</strong><br />Native zone</div>`,
            );
            infoWindowRef.current.setPosition(event.latLng);
            infoWindowRef.current.open({ map });
          }
        });

        overlayEntriesRef.current.push({
          bounds: polygonBounds,
          cityKey: NATIVE_ZONE_LAYER_KEY,
          featureId: feature.properties.id,
          polygon,
        });
      });
    });

    resolvedDisplayedBoundaries.forEach(({ candidate, cityKey, data: localityData }) => {
      const localityColor = localityColors[cityKey] ?? ensureLocalityColor(cityKey);

      localityData.features.forEach((feature) => {
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
            ...buildPolygonStyle(localityColor, false, false),
            map,
            paths,
          });

          polygon.addListener("click", (event: google.maps.MapMouseEvent) => {
            setSelectedLocality(candidate);
            setSelectedFeatureId(feature.properties.id);
            setSelectedNativeZoneId(null);

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
  }, [ensureLocalityColor, localityColors, resolvedDisplayedBoundaries]);

  useEffect(() => {
    const currentComparison = comparisonData;

    if (activeMapTab !== "comparison" || !GOOGLE_MAPS_API_KEY || !currentComparison) {
      return;
    }

    let active = true;
    const comparison = currentComparison;

    async function drawComparisonMaps() {
      await loadGoogleMapsApi(GOOGLE_MAPS_API_KEY!);

      if (!active || !nativeCompareMapContainerRef.current || !osmCompareMapContainerRef.current) {
        return;
      }

      const nativeMap =
        nativeCompareMapRef.current ??
        new google.maps.Map(nativeCompareMapContainerRef.current, {
          center: { lat: 14.8, lng: 121 },
          clickableIcons: false,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 10,
        });
      const osmMap =
        osmCompareMapRef.current ??
        new google.maps.Map(osmCompareMapContainerRef.current, {
          center: { lat: 14.8, lng: 121 },
          clickableIcons: false,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 10,
        });

      nativeCompareMapRef.current = nativeMap;
      osmCompareMapRef.current = osmMap;
      clearPolygons(comparisonOverlayEntriesRef.current);
      comparisonOverlayEntriesRef.current = [
        ...drawBoundaryCollection({
          collection: comparison.native,
          fillColor: "#2563eb",
          map: nativeMap,
          strokeColor: "#1d4ed8",
        }),
        ...drawBoundaryCollection({
          collection: comparison.osm,
          fillColor: "#dc2626",
          map: osmMap,
          strokeColor: "#b91c1c",
        }),
      ];
    }

    void drawComparisonMaps();

    return () => {
      active = false;
    };
  }, [activeMapTab, comparisonData]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !overlayEntriesRef.current.length) {
      return;
    }

    const selectedBounds = new google.maps.LatLngBounds();

    overlayEntriesRef.current.forEach((entry) => {
      if (entry.cityKey === NATIVE_ZONE_LAYER_KEY) {
        const isSelectedNativeZone = entry.featureId === selectedNativeZoneId;
        entry.polygon.setOptions(buildNativeZoneStyle(isSelectedNativeZone));

        if (isSelectedNativeZone) {
          selectedBounds.extend(entry.bounds.getNorthEast());
          selectedBounds.extend(entry.bounds.getSouthWest());
        }

        return;
      }

      const isActiveLocality = entry.cityKey === selectedLocalityKey;
      const isSelected = isActiveLocality && entry.featureId === selectedFeatureId;
      const localityColor = localityColors[entry.cityKey] ?? ensureLocalityColor(entry.cityKey);
      entry.polygon.setOptions(buildPolygonStyle(localityColor, isActiveLocality, isSelected));

      if (isSelected) {
        selectedBounds.extend(entry.bounds.getNorthEast());
        selectedBounds.extend(entry.bounds.getSouthWest());
      }
    });

    if ((selectedFeatureId || selectedNativeZoneId) && !selectedBounds.isEmpty()) {
      map.fitBounds(selectedBounds, 64);
    }
  }, [ensureLocalityColor, localityColors, selectedFeatureId, selectedLocalityKey, selectedNativeZoneId]);

  async function loadProvince(nextProvince: string) {
    const requestId = provinceRequestIdRef.current + 1;
    provinceRequestIdRef.current = requestId;
    const params = new URLSearchParams({ province: nextProvince });

    setProvinceLoading(true);
    setError(null);
    setWarning(null);
    setTrackedLocalities([]);
    setSelectedLocality(null);
    setSelectedFeatureId(null);
    setSelectedNativeZoneId(null);

    try {
      const response = await fetchWithAppApiKey(`/api/municipalities?${params.toString()}`);
      const payload = (await response.json()) as ProvinceLocalitiesResponse & { details?: string; error?: string };

      if (provinceRequestIdRef.current !== requestId) {
        return;
      }

      if (!response.ok) {
        throw new Error(payload.error ?? payload.details ?? "Request failed.");
      }

      setLocalityCandidates(payload.municipalities);
      setLoadedProvinceLabel(payload.metadata.province);
      setWarning(payload.municipalities.length ? null : "No localities were found for this province.");
    } catch (caughtError) {
      if (provinceRequestIdRef.current !== requestId) {
        return;
      }

      const message = caughtError instanceof Error ? caughtError.message : "Unable to load province localities.";
      setError(message);
      setLocalityCandidates([]);
    } finally {
      if (provinceRequestIdRef.current === requestId) {
        setProvinceLoading(false);
      }
    }
  }

  async function toggleTrackedLocality(candidate: LocalityCandidate) {
    const candidateKey = getLocalityCandidateKey(candidate);
    const isTracked = trackedLocalities.some((entry) => getLocalityCandidateKey(entry) === candidateKey);

    if (isTracked) {
      setTrackedLocalities((current) => current.filter((entry) => getLocalityCandidateKey(entry) !== candidateKey));
      return;
    }

    const boundary = await fetchBoundary(candidate);

    if (!boundary) {
      return;
    }

    setTrackedLocalities((current) => {
      if (current.some((entry) => getLocalityCandidateKey(entry) === candidateKey)) {
        return current;
      }

      return [...current, candidate];
    });
  }

  function removeTrackedLocality(candidate: LocalityCandidate) {
    const candidateKey = getLocalityCandidateKey(candidate);
    setTrackedLocalities((current) => current.filter((entry) => getLocalityCandidateKey(entry) !== candidateKey));
  }

  async function selectVisibleLocalities() {
    const untrackedCandidates = filteredLocalityCandidates.filter(
      (candidate) => !trackedLocalities.some((entry) => getLocalityCandidateKey(entry) === getLocalityCandidateKey(candidate)),
    );

    if (!untrackedCandidates.length) {
      return;
    }

    setBulkSelecting(true);
    setError(null);
    setWarning(null);

    const successfulCandidates: LocalityCandidate[] = [];
    let failedCount = 0;

    try {
      for (let index = 0; index < untrackedCandidates.length; index += BULK_SELECTION_CONCURRENCY) {
        const batch = untrackedCandidates.slice(index, index + BULK_SELECTION_CONCURRENCY);
        const results = await Promise.all(
          batch.map((candidate) =>
            fetchBoundary(candidate, {
              reportErrors: false,
              selectCandidate: false,
              setLoadingState: false,
            }),
          ),
        );

        results.forEach((boundary, resultIndex) => {
          if (boundary) {
            successfulCandidates.push(batch[resultIndex]);
            return;
          }

          failedCount += 1;
        });
      }

      setTrackedLocalities((current) => {
        const currentKeys = new Set(current.map((entry) => getLocalityCandidateKey(entry)));
        const nextEntries = successfulCandidates.filter((candidate) => !currentKeys.has(getLocalityCandidateKey(candidate)));

        return nextEntries.length ? [...current, ...nextEntries] : current;
      });

      if (!successfulCandidates.length) {
        setWarning("No visible localities could be loaded.");
      } else if (failedCount) {
        setWarning(`${failedCount} visible localit${failedCount === 1 ? "y was" : "ies were"} skipped because no boundary could be loaded.`);
      }
    } finally {
      setBulkSelecting(false);
    }
  }

  function clearVisibleLocalities() {
    setTrackedLocalities((current) =>
      current.filter((entry) => !visibleLocalityKeys.has(getLocalityCandidateKey(entry))),
    );
  }

  async function exportZone(format: ExportFormat) {
    if (!exportCandidates.length) {
      setError("Load at least one locality before exporting.");
      return;
    }

    setExportingFormat(format);
    setError(null);

    try {
      const response = await fetchWithAppApiKey(`/api/cities/export?format=${format}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cities: resolvedDisplayedBoundaries.map((entry) => ({
            city: entry.candidate.name,
            locationLabel: entry.candidate.locationLabel,
            relationId: exportRelationId(entry.candidate, entry.data),
          })),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { details?: string; error?: string };
        throw new Error(payload.error ?? payload.details ?? "Unable to export selected locality zones.");
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download =
        readDownloadFilename(response) ??
        (exportCandidates.length === 1
          ? `${exportCandidates[0].name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-city-zone.${format}`
          : `selected-${exportCandidates.length}-cities-zone.${format}`);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to export selected locality zones.";
      setError(message);
    } finally {
      setExportingFormat(null);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextProvince = provinceInput.trim();

    if (!nextProvince) {
      setError("Province is required.");
      return;
    }

    void loadProvince(nextProvince);
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
            <p className="sidebar-kicker">Province Localities</p>
            <h1 className="sidebar-title">Municipalities</h1>
          </section>

          <section className="sidebar-section">
            <p className="sidebar-subtitle">Load Province</p>
            <form className="mt-4" onSubmit={handleSubmit}>
              <div className="search-shell city-search-shell">
                <div className="flex-1">
                  <input
                    className="google-input"
                    value={provinceInput}
                    onChange={(event) => setProvinceInput(event.target.value)}
                    placeholder="Load province, e.g. Nueva Ecija"
                  />
                </div>
                <button className="google-button" type="submit" disabled={provinceLoading}>
                  {provinceLoading ? "Loading..." : "Load"}
                </button>
              </div>
            </form>
            <div className="mt-4">
              <input
                className="google-input"
                value={filterQuery}
                onChange={(event) => setFilterQuery(event.target.value)}
                placeholder="Filter loaded localities"
              />
            </div>
            <div className="mt-4 meta-strip">
              <span>{localityCandidates.length ? `${localityCandidates.length} loaded` : "Ready"}</span>
              <span className="meta-dot">•</span>
              <span>{trackedLocalities.length} selected</span>
              <span className="meta-dot">•</span>
              <span>{nativeZonesLoading ? "Zones loading" : "0 zones preloaded"}</span>
              <span className="meta-dot">•</span>
              <span>{loadedProvinceLabel}</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                className="google-button rounded-full border border-neutral-200 bg-white px-5 py-3"
                disabled={!exportCandidates.length || Boolean(exportingFormat)}
                onClick={() => void exportZone("json")}
                type="button"
              >
                {exportingFormat === "json" ? "Exporting..." : exportCandidates.length > 1 ? "Export Localities JSON" : "Export Locality JSON"}
              </button>
              <button
                className="google-button rounded-full border border-neutral-200 bg-white px-5 py-3"
                disabled={!exportCandidates.length || Boolean(exportingFormat)}
                onClick={() => void exportZone("sql")}
                type="button"
              >
                {exportingFormat === "sql" ? "Exporting..." : exportCandidates.length > 1 ? "Export Localities SQL" : "Export Locality SQL"}
              </button>
            </div>
            {warning ? <p className="mt-4 text-sm leading-6 text-amber-700">{warning}</p> : null}
            {error ? <p className="mt-4 text-sm leading-6 text-red-700">{error}</p> : null}
          </section>

          <section className="sidebar-section">
            <div className="flex items-center justify-between gap-3">
              <p className="sidebar-subtitle">Selected Localities</p>
              <span className="text-xs text-neutral-500">{trackedLocalities.length} tracked</span>
            </div>
            <div className="mt-4">
              {!trackedLocalities.length ? (
                <p className="text-sm leading-7 text-neutral-500">Choose localities from the loaded province to keep them here.</p>
              ) : null}
              {trackedLocalities.map((candidate) => {
                const candidateKey = getLocalityCandidateKey(candidate);
                const localityColor = localityColors[candidateKey];
                const isCurrent = candidateKey === (selectedLocality ? getLocalityCandidateKey(selectedLocality) : null);

                return (
                  <div key={candidateKey} className={`simple-row ${isCurrent ? "simple-row-active" : ""}`}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => void fetchBoundary(candidate)} type="button">
                      <span className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: localityColor?.fillColor ?? "#9ca3af" }}
                        />
                        <span className="truncate">{candidate.name}</span>
                      </span>
                      <span className="mt-1 block text-xs text-neutral-600">{localityTypeLabel(candidate)}</span>
                      {candidate.locationLabel ? <span className="mt-1 block text-xs text-neutral-600">{candidate.locationLabel}</span> : null}
                    </button>
                    <button
                      className="shrink-0 rounded-full border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-900"
                      onClick={() => removeTrackedLocality(candidate)}
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
              <p className="sidebar-subtitle">Loaded Localities</p>
              <span className="text-xs text-neutral-500">{provinceLoading ? "Loading..." : `${filteredLocalityCandidates.length} visible`}</span>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                className="google-button flex-1 rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-sm"
                disabled={!filteredLocalityCandidates.length || bulkSelecting || allVisibleSelected}
                onClick={() => void selectVisibleLocalities()}
                type="button"
              >
                {bulkSelecting ? "Selecting..." : "Select Visible"}
              </button>
              <button
                className="google-button flex-1 rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-sm"
                disabled={!filteredLocalityCandidates.length || bulkSelecting || !trackedLocalities.some((entry) => visibleLocalityKeys.has(getLocalityCandidateKey(entry)))}
                onClick={clearVisibleLocalities}
                type="button"
              >
                Clear Visible
              </button>
            </div>
            <div className="mt-4">
              {!localityCandidates.length && !provinceLoading ? (
                <p className="text-sm leading-7 text-neutral-500">No loaded localities.</p>
              ) : null}
              {localityCandidates.length && !filteredLocalityCandidates.length ? (
                <p className="text-sm leading-7 text-neutral-500">No loaded localities match this filter.</p>
              ) : null}
              {filteredLocalityCandidates.map((candidate) => {
                const candidateKey = getLocalityCandidateKey(candidate);
                const localityColor = localityColors[candidateKey];
                const isCurrent = candidateKey === (selectedLocality ? getLocalityCandidateKey(selectedLocality) : null);
                const isTracked = trackedLocalities.some((entry) => getLocalityCandidateKey(entry) === candidateKey);

                return (
                  <div key={candidateKey} className={`simple-row ${isCurrent ? "simple-row-active" : ""}`}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => void fetchBoundary(candidate)} type="button">
                      <span className="block truncate text-sm font-medium text-neutral-900">{candidate.name}</span>
                      <span className="mt-1 block text-xs text-neutral-600">{localityTypeLabel(candidate)}</span>
                      {candidate.locationLabel ? <span className="mt-1 block text-xs text-neutral-500">{candidate.locationLabel}</span> : null}
                      <span className="mt-1 block text-xs text-neutral-500">
                        {candidate.ref ? `Code ${candidate.ref}` : `ID ${candidate.id}`}
                      </span>
                    </button>
                    <button
                      className="shrink-0 rounded-full border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-900"
                      onClick={() => {
                        setSelectedLocality(candidate);
                        setActiveMapTab("comparison");
                        void fetchBoundaryComparison(candidate);
                      }}
                      type="button"
                    >
                      Compare
                    </button>
                    <button
                      aria-pressed={isTracked}
                      className={`shrink-0 rounded-full border px-3 py-2 text-xs font-medium transition ${
                        isTracked
                          ? ""
                          : "border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
                      }`}
                      style={
                        isTracked && localityColor
                          ? {
                              backgroundColor: localityColor.pillBackground,
                              borderColor: localityColor.pillBorder,
                              color: localityColor.strokeColor,
                            }
                          : undefined
                      }
                      onClick={() => void toggleTrackedLocality(candidate)}
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
            <h2 className="text-base font-medium text-neutral-900">
              {activeMapTab === "comparison"
                ? comparisonData?.locality ?? selectedLocality?.name ?? "OSM vs Native"
                : selectedFeature
                  ? selectedFeature.properties.name
                  : "Province locality map"}
            </h2>
            <p className="mt-1 text-sm text-neutral-600">
              {activeMapTab === "comparison"
                ? "Raw whole-municipality outlines"
                : selectedFeature
                  ? "Boundary selected"
                  : loading
                    ? "Loading..."
                    : "Load a province, then select a locality."}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="segmented-control" role="tablist" aria-label="Map view">
              <button
                aria-selected={activeMapTab === "localities"}
                className={`segmented-button ${activeMapTab === "localities" ? "segmented-button-active" : ""}`}
                onClick={() => setActiveMapTab("localities")}
                role="tab"
                type="button"
              >
                Localities
              </button>
              <button
                aria-selected={activeMapTab === "comparison"}
                className={`segmented-button ${activeMapTab === "comparison" ? "segmented-button-active" : ""}`}
                onClick={() => {
                  setActiveMapTab("comparison");
                  void fetchBoundaryComparison(selectedLocality ?? trackedLocalities[0] ?? null);
                }}
                role="tab"
                type="button"
              >
                OSM vs Native
              </button>
            </div>
            <div className="meta-strip">
              <span>{data?.metadata.province ?? loadedProvinceLabel}</span>
            </div>
          </div>
        </div>

        {activeMapTab === "comparison" ? (
          <div className="comparison-panel">
            <div className="comparison-maps">
              <section className="comparison-map-block">
                <div className="comparison-map-header">
                  <span>Native</span>
                  <strong>{comparisonData?.native.features.length ?? 0} outline</strong>
                </div>
                <div ref={nativeCompareMapContainerRef} className="simple-map comparison-map-canvas" />
              </section>
              <section className="comparison-map-block">
                <div className="comparison-map-header">
                  <span>OSM</span>
                  <strong>{comparisonData?.osm.features.length ?? 0} outline</strong>
                </div>
                <div ref={osmCompareMapContainerRef} className="simple-map comparison-map-canvas" />
              </section>
            </div>
            <div className="comparison-stats">
              {comparisonLoading ? <p className="text-sm text-neutral-600">Comparing boundaries...</p> : null}
              {comparisonError ? <p className="text-sm text-red-700">{comparisonError}</p> : null}
              {comparisonData ? (
                <>
                  <div className="comparison-stat">
                    <span>Native area</span>
                    <strong>{formatSquareMeters(comparisonData.stats.nativeAreaM2)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>OSM area</span>
                    <strong>{formatSquareMeters(comparisonData.stats.osmAreaM2)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>Shared overlap</span>
                    <strong>{formatSquareMeters(comparisonData.stats.intersectionAreaM2)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>IoU</span>
                    <strong>{comparisonData.stats.iou === null ? "n/a" : comparisonData.stats.iou.toFixed(4)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>Native covered by OSM</span>
                    <strong>{formatPercent(comparisonData.stats.nativeOverlapPercent)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>OSM covered by native</span>
                    <strong>{formatPercent(comparisonData.stats.osmOverlapPercent)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>Native-only gap</span>
                    <strong>{formatSquareMeters(comparisonData.stats.nativeOnlyAreaM2)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>OSM-only gap</span>
                    <strong>{formatSquareMeters(comparisonData.stats.osmOnlyAreaM2)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>Area delta</span>
                    <strong>{formatPercent(comparisonData.stats.areaDeltaPercentOfNative)}</strong>
                  </div>
                  <div className="comparison-stat">
                    <span>Vertices</span>
                    <strong>{comparisonData.stats.nativeVertexCount} / {comparisonData.stats.osmVertexCount}</strong>
                  </div>
                  <div className="comparison-stat comparison-stat-wide">
                    <span>Algorithmic compensation</span>
                    <strong>{comparisonData.stats.algorithmicCompensation.generatedPointPercent.toFixed(0)}% generated points</strong>
                    <p>{comparisonData.stats.algorithmicCompensation.note}</p>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : (
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
        )}
      </section>
    </div>
  );
}
