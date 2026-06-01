export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

export type GeoJsonMultiPolygon = {
  type: "MultiPolygon";
  coordinates: number[][][][];
};

export type CityBoundaryCandidate = {
  adminLevel?: string;
  borderType?: string;
  center?: {
    lat: number;
    lon: number;
  };
  id: number;
  locationLabel?: string;
  localityType?: "city" | "municipality";
  name: string;
  ref?: string;
  sourceType?: "firestore";
  wikidata?: string;
  wikipedia?: string;
};

export type BoundaryFeature = {
  type: "Feature";
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  properties: {
    adminLevel?: string;
    boundaryKind?: "actual" | "estimated" | "indicative";
    estimatedFromPoint?: [number, number];
    estimationMethod?: "voronoi";
    id: number;
    name: string;
    place?: string;
    psgcCode?: string;
    sourceType: "estimated" | "firestore-hdx-cod-ab" | "hdx-cod-ab" | "relation" | "way";
  };
};

export type BoundaryFeatureCollection = {
  type: "FeatureCollection";
  features: BoundaryFeature[];
  metadata: {
    adminLevels: string[];
    city: string;
    country: string;
    count: number;
    generatedAt: string;
    province?: string;
    source: string;
    boundaryMode: "actual" | "estimated" | "indicative";
    dataset?: {
      attribution: string;
      caveat: string;
      name: string;
    };
    approximation?: {
      method: "voronoi";
      note: string;
      pointCount: number;
      psgcBarangayCount?: number;
      seedMode: "osm-place-points" | "psgc-matched-osm-place-points";
      unmatchedOfficialBarangays?: string[];
    };
    psgcValidation?: {
      droppedCount: number;
      droppedNames?: string[];
      keptCount: number;
      officialCount: number;
      status: "filtered" | "matched" | "unavailable";
    };
    cityBoundary?: {
      adminLevel?: string;
      borderType?: string;
      id: number;
      name?: string;
    };
  };
};
