# City Barangay Boundary Explorer

This repository contains the application code for rendering city and barangay polygons on top of Google Maps.

It does **not** contain the full boundary dataset.

The repo is meant to stay open-source without bundling the large HDX-derived boundary files. The actual boundary data should be sourced separately, processed locally, and then imported into Firebase / Firestore for the app to read.

## What This Repo Includes

- Next.js application for browsing cities and barangays
- Google Maps rendering for city and barangay polygons
- Comparison and export tooling
- Local scripts for processing and importing boundary data into Firestore

## What This Repo Does Not Include

- The raw HDX archive
- A bundled nationwide boundary dataset
- Official legal boundary files

If you clone this repository on its own, you are getting the renderer and import pipeline, not the data payload.

## Boundary Data Source

The boundary data used with this project should be obtained separately.

The strongest lead we used is the BTAA record for the Philippines subnational administrative boundaries:

- BTAA metadata page: https://geo.btaa.org/catalog/caf116df-f984-4deb-85ca-41b349d3f313

That is the important external reference for the dataset trail. The “gold” is there, not in this repository.

## What The HDX Codes Mean

Short version:

- `ADM2` = province
- `ADM3` = city or municipality
- `ADM4` = barangay
- `Pcode` = the code/id for that administrative unit inside the dataset

Examples you will see in the import scripts and data:

- `ADM2_EN` or `adm2Name` = province name
- `ADM3_EN` or `adm3Name` = city or municipality name
- `ADM4_EN` or `adm4Name` = barangay name
- `ADM3_PCODE` or `adm3Pcode` = city/municipality code
- `ADM4_PCODE` or `adm4Pcode` = barangay code

In this project, `ADM4` is the important one because that is the barangay boundary level.

## Current Data Pipeline

The import flow is now a two-step process:

1. build a local HDX cache
2. import that cache into Firestore

### 1. Build The Local HDX Cache

```powershell
npm run import:hdx
```

This script:

- downloads the Philippines ADM4 shapefile ZIP from HDX
- extracts it into `.cache/hdx/`
- converts the ADM4 features into a local cache under `data/hdx/cod-ab-phl/`

The generated cache currently looks like:

```txt
data/hdx/cod-ab-phl/manifest.json
data/hdx/cod-ab-phl/adm4/*.ndjson
```

Useful options:

```powershell
npm run import:hdx -- --simplify=0.0001
npm run import:hdx -- --force-download
npm run import:hdx -- --force-extract
```

### 2. Import The Cache Into Firestore

Use the dedicated HDX-to-Firebase importer after the local cache exists:

```powershell
npm run import:firebase:hdx
```

This command reads the generated cache from `data/hdx/cod-ab-phl/` by default and writes it into Firestore as chunked city documents.

Useful options:

```powershell
npm run import:firebase:hdx:dry-run
npm run import:firebase:hdx -- --dataset=hdx-philippines-adm4
npm run import:firebase:hdx -- --cache-dir=path\to\cod-ab-phl
```

There is also a more generic importer that reads the same cache format but lets you override source metadata:

```powershell
npm run import:firestore-boundaries
npm run import:firestore-boundaries:dry-run
npm run import:firestore-boundaries -- --source="Custom source"
npm run import:firestore-boundaries -- --source-url=https://example.com/dataset
```

Both Firestore importers fragment the nationwide cache into compressed chunk documents so the app can serve the dataset without storing one huge geometry blob in a single document.

For a nationwide deployment, keep the dataset id aligned with:

```env
FIRESTORE_BOUNDARY_DATASET_ID=hdx-philippines-adm4
```

## Exporting Data From Firestore

You can export the currently imported Firestore dataset back to a GeoJSON file with:

```powershell
npm run export:firestore-boundaries
```

By default this writes to:

```txt
public/boundaries/firestore-hdx-philippines-adm4.geojson
```

Useful options:

```powershell
npm run export:firestore-boundaries -- --dataset=hdx-philippines-adm4
npm run export:firestore-boundaries -- --output=public/boundaries/my-export.geojson
npm run export:firestore-boundaries -- --city="San Jose City"
```

## Data Docs

More complete data documentation lives here:

- [docs/data.md](C:/Users/giyut/Documents/ProjectsForOtherPeeps/CityBaranggay/docs/data.md)

That document explains:

- where the data comes from
- what `ADM2`, `ADM3`, `ADM4`, and `Pcode` mean
- how the GeoJSON fields map into this app
- how the Firestore dataset is structured
- how to run imports safely

## Required Environment

For local imports and exports, provide Firebase credentials through environment variables such as:

```env
FIREBASE_PROJECT_ID=bounds-finder
FIREBASE_SERVICE_ACCOUNT_PATH=C:\path\to\service-account.json
```

The scripts load `.env.local` and `.env` automatically if present. They can also use `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_KEY` when available.

The web app itself reads its public Firebase and Google Maps configuration from `.env`.

## Development

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`.
