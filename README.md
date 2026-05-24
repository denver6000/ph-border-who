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

## Importing Data Into Firebase

Once you have built the HDX cache locally, you can import the entire Philippines dataset into Firestore with the dedicated HDX importer:

```powershell
npm run import:firebase:hdx
```

That command now reads from:

```txt
data/hdx/cod-ab-phl/manifest.json
data/hdx/cod-ab-phl/adm4/*.ndjson
```

and imports all available Philippine cities / municipalities in the cache.

Useful flags:

```powershell
npm run import:hdx
npm run import:firebase:hdx -- --dataset=hdx-philippines-adm4
npm run import:firebase:hdx -- --cache-dir=path\to\cod-ab-phl
npm run import:firebase:hdx -- --dry-run
```

The importer fragments the nationwide cache into compressed Firestore chunk documents so the mapping system can read the dataset without storing a huge geometry blob in a single document.

For a nationwide deployment, keep the dataset id aligned with:

```env
FIRESTORE_BOUNDARY_DATASET_ID=hdx-philippines-adm4
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

For local imports, provide Firebase credentials through environment variables such as:

```env
FIREBASE_PROJECT_ID=bounds-finder
FIREBASE_SERVICE_ACCOUNT_PATH=C:\path\to\service-account.json
```

The web app itself reads its public Firebase and Google Maps configuration from `.env`.

## Development

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`.
