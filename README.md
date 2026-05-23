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

## Importing Data Into Firebase

Once you have a processed GeoJSON file locally, you can import it into Firestore with the dedicated HDX importer:

```powershell
npm run import:firebase:hdx
```

Useful flags:

```powershell
npm run import:firebase:hdx -- --input=public/boundaries/nueva-ecija-barangays.geojson
npm run import:firebase:hdx -- --dataset=hdx-nueva-ecija
npm run import:firebase:hdx -- --chunk-bytes=650000
npm run import:firebase:hdx -- --dry-run
```

The importer fragments the GeoJSON into compressed Firestore chunk documents so the mapping system can read the dataset without storing a huge geometry blob in a single document.

## Required Environment

For local imports, provide Firebase credentials through environment variables such as:

```env
FIREBASE_PROJECT_ID=projct-id-23121
FIREBASE_SERVICE_ACCOUNT_PATH=C:\path\to\service-account.json
```

The web app itself reads its public Firebase and Google Maps configuration from `.env`.

## Development

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`.
