import type { EstimationPoint } from "@/lib/estimated-boundaries";

const PSGC_API_BASE_URL = "https://psgc.gitlab.io/api";
const BARANGAY_NAME_STOPWORDS = new Set(["barangay", "brgy", "bgy"]);
const POBLACION_WORDS = new Set(["pob", "poblacion"]);

type PsgcCityMunicipality = {
  code: string;
  isCity: boolean;
  isMunicipality: boolean;
  name: string;
  oldName?: string;
  provinceCode?: string | false;
  regionCode?: string;
};

type PsgcProvince = {
  code: string;
  name: string;
  regionCode?: string;
};

type PsgcCityMunicipalityDataset = {
  localities: PsgcCityMunicipality[];
  localitiesByCode: Map<string, PsgcCityMunicipality>;
  provincesByCode: Map<string, PsgcProvince>;
};

export type PsgcBarangay = {
  cityCode?: string | false;
  code: string;
  municipalityCode?: string | false;
  name: string;
  oldName?: string;
  psgc10DigitCode?: string;
  provinceCode?: string | false;
  regionCode?: string;
};

export type OfficialBarangaySeedResult = {
  barangays: PsgcBarangay[];
  city?: PsgcCityMunicipality;
  matchedPoints: EstimationPoint[];
  unmatchedBarangays: PsgcBarangay[];
};

export type PsgcLocalityKind = "city" | "municipality";

let psgcCityMunicipalityDatasetPromise: Promise<PsgcCityMunicipalityDataset> | null = null;

async function fetchPsgc<T>(path: string) {
  const response = await fetch(`${PSGC_API_BASE_URL}${path}`, {
    cache: "force-cache",
  });

  if (!response.ok) {
    throw new Error(`PSGC request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizePsgcName(value: string) {
  return stripDiacritics(value)
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/\b(\d+)st\b/g, "$1")
    .replace(/\b(\d+)nd\b/g, "$1")
    .replace(/\b(\d+)rd\b/g, "$1")
    .replace(/\b(\d+)th\b/g, "$1")
    .replace(/\bist\b/g, "1")
    .replace(/\bii\b/g, "2")
    .replace(/\biii\b/g, "3")
    .replace(/\biv\b/g, "4")
    .replace(/\bsr\b/g, "senior")
    .replace(/\bjr\b/g, "junior")
    .replace(/\bcapital\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part && !BARANGAY_NAME_STOPWORDS.has(part))
    .join(" ");
}

function compactName(value: string) {
  return normalizePsgcName(value)
    .split(/\s+/)
    .filter((part) => !POBLACION_WORDS.has(part))
    .join("");
}

function localityNameKeys(value: string) {
  const normalized = normalizePsgcName(value);
  const withoutCity = normalized.replace(/\bcity\b/g, "").trim();
  const withoutCityOf = normalized.replace(/^city of\s+/, "").trim();
  const withoutMunicipality = normalized.replace(/\bmunicipality\b/g, "").trim();
  const withoutMunicipalityOf = normalized.replace(/^municipality of\s+/, "").trim();
  const withoutCapital = normalized.replace(/\bcapital\b/g, "").trim();

  return new Set(
    [normalized, withoutCity, withoutCityOf, withoutMunicipality, withoutMunicipalityOf, withoutCapital].filter(Boolean),
  );
}

function containsAnyLocationPart(locationLabel: string | undefined, value: string | undefined) {
  if (!locationLabel || !value) {
    return false;
  }

  return normalizePsgcName(locationLabel).includes(normalizePsgcName(value));
}

function barangayMatchScore(officialName: string, pointName: string) {
  const official = compactName(officialName);
  const point = compactName(pointName);

  if (!official || !point) {
    return 0;
  }

  if (official === point) {
    return 4;
  }

  if (official.includes(point) || point.includes(official)) {
    return 3;
  }

  const officialNoPob = official.replace(/pob|poblacion/g, "");
  const pointNoPob = point.replace(/pob|poblacion/g, "");

  if (officialNoPob && officialNoPob === pointNoPob) {
    return 2;
  }

  return 0;
}

async function getPsgcCityMunicipalityDataset() {
  if (!psgcCityMunicipalityDatasetPromise) {
    psgcCityMunicipalityDatasetPromise = Promise.all([
      fetchPsgc<PsgcCityMunicipality[]>("/cities-municipalities/"),
      fetchPsgc<PsgcProvince[]>("/provinces/"),
    ]).then(([localities, provinces]) => ({
      localities,
      localitiesByCode: new Map(localities.map((locality) => [locality.code, locality])),
      provincesByCode: new Map(provinces.map((province) => [province.code, province])),
    }));
  }

  return psgcCityMunicipalityDatasetPromise;
}

function findPsgcCityMunicipalityMatch(
  dataset: PsgcCityMunicipalityDataset,
  {
    code,
    locationLabel,
    name,
  }: {
    code?: string;
    locationLabel?: string;
    name: string;
  },
) {
  if (code) {
    const codeMatch = dataset.localitiesByCode.get(code);

    if (codeMatch) {
      return codeMatch;
    }
  }

  const expectedNames = localityNameKeys(name);
  const matches = dataset.localities.filter((candidate) => {
    const candidateKeys = localityNameKeys(candidate.name);
    return Array.from(expectedNames).some((expectedName) => candidateKeys.has(expectedName));
  });

  if (!matches.length) {
    return undefined;
  }

  return (
    matches.find((candidate) =>
      containsAnyLocationPart(locationLabel, dataset.provincesByCode.get(String(candidate.provinceCode))?.name),
    ) ??
    matches.find((candidate) => containsAnyLocationPart(locationLabel, candidate.regionCode)) ??
    matches[0]
  );
}

export async function getPsgcLocalityKind({
  code,
  name,
  province,
}: {
  code?: string;
  name: string;
  province?: string;
}): Promise<PsgcLocalityKind | null> {
  const dataset = await getPsgcCityMunicipalityDataset();
  const locality = findPsgcCityMunicipalityMatch(dataset, {
    code,
    locationLabel: province,
    name,
  });

  if (!locality) {
    return null;
  }

  if (locality.isMunicipality) {
    return "municipality";
  }

  if (locality.isCity) {
    return "city";
  }

  return null;
}

async function findPsgcCity(city: string, locationLabel?: string) {
  const dataset = await getPsgcCityMunicipalityDataset();
  return findPsgcCityMunicipalityMatch(dataset, {
    locationLabel,
    name: city,
  });
}

export async function findOfficialBarangaysForCity({
  city,
  locationLabel,
}: {
  city?: string;
  locationLabel?: string;
}) {
  if (!city) {
    return null;
  }

  const psgcCity = await findPsgcCity(city, locationLabel);

  if (!psgcCity) {
    return null;
  }

  const barangays = await fetchPsgc<PsgcBarangay[]>(`/cities-municipalities/${psgcCity.code}/barangays/`);

  return {
    barangays,
    city: psgcCity,
  };
}

function matchOfficialBarangaysToPoints(barangays: PsgcBarangay[], points: EstimationPoint[]) {
  const usedPointIds = new Set<number>();
  const matchedPoints: EstimationPoint[] = [];
  const unmatchedBarangays: PsgcBarangay[] = [];

  for (const barangay of barangays) {
    const best = points
      .filter((point) => !usedPointIds.has(point.id))
      .map((point) => ({
        point,
        score: barangayMatchScore(barangay.name, point.name),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.point.name.localeCompare(right.point.name))[0];

    if (!best) {
      unmatchedBarangays.push(barangay);
      continue;
    }

    usedPointIds.add(best.point.id);
    matchedPoints.push({
      ...best.point,
      id: Number(barangay.code),
      name: barangay.name,
      psgcCode: barangay.code,
    });
  }

  return {
    matchedPoints,
    unmatchedBarangays,
  };
}

export async function getOfficialBarangaySeeds({
  city,
  locationLabel,
  points,
}: {
  city?: string;
  locationLabel?: string;
  points: EstimationPoint[];
}): Promise<OfficialBarangaySeedResult | null> {
  if (!city) {
    return null;
  }

  const official = await findOfficialBarangaysForCity({
    city,
    locationLabel,
  });

  if (!official) {
    return null;
  }

  const matched = matchOfficialBarangaysToPoints(official.barangays, points);

  return {
    barangays: official.barangays,
    city: official.city,
    ...matched,
  };
}
