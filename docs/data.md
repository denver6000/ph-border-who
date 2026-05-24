# Data Guide

This document explains the boundary data used by this project, what the HDX/COD-AB fields mean, and how the import pipeline stores the result in Firestore.

## Purpose

This repository is a renderer and importer, not a bundled data repository.

You are expected to:

1. obtain the boundary data separately
2. build the local HDX cache
3. import that cache into Firebase / Firestore
4. let the app read the imported dataset

## Source Trail

The main external reference used by this project is:

- BTAA metadata page: https://geo.btaa.org/catalog/caf116df-f984-4deb-85ca-41b349d3f313

That record points to the Philippines subnational administrative boundary dataset lineage. This repo does not mirror the full data.

## What HDX / COD-AB Means

- `HDX` = Humanitarian Data Exchange
- `COD-AB` = Common Operational Dataset - Administrative Boundaries

For this project, think of HDX/COD-AB as the external admin-boundary dataset source family.

## What The Admin Levels Mean

The dataset uses administrative levels.

- `ADM0` = country
- `ADM1` = region
- `ADM2` = province
- `ADM3` = city or municipality
- `ADM4` = barangay

This project mainly cares about:

- `ADM3` when listing cities or municipalities
- `ADM4` when rendering barangay boundaries

## What The Codes Mean

The dataset contains `Pcode` values. These are identifier fields used by the boundary dataset.

Important examples:

- `ADM3_PCODE` or `adm3Pcode`
  - city or municipality code
- `ADM4_PCODE` or `adm4Pcode`
  - barangay code

Important name fields:

- `ADM2_EN` or `adm2Name`
  - province name
- `ADM3_EN` or `adm3Name`
  - city or municipality name
- `ADM4_EN` or `adm4Name`
  - barangay name

In the import scripts, these are mapped into normalized app fields so the UI and Firestore layout do not depend on only one exact naming variant.

## How This Project Reads The Cache

The nationwide import path now reads from:

```txt
data/hdx/cod-ab-phl/manifest.json
data/hdx/cod-ab-phl/adm4/*.ndjson
```

The NDJSON feature files currently use these fields when available:

- province
  - `adm2Name`
  - `province`
  - `ADM2_EN`
- city or municipality
  - `adm3Name`
  - `city`
  - `ADM3_EN`
- barangay
  - `adm4Name`
  - `name`
  - `ADM4_EN`
- city code
  - `adm3Pcode`
  - `ADM3_PCODE`
- barangay code
  - `adm4Pcode`
  - `psgc`
  - `ADM4_PCODE`

If a code is missing, the importer can still proceed, but some ids will fall back to generated values.

## Dataset Id In Firestore

The active dataset id is controlled by:

```env
FIRESTORE_BOUNDARY_DATASET_ID=hdx-philippines-adm4
```

That value tells the app which Firestore dataset document to read.

Example:

```txt
boundaryDatasets/hdx-philippines-adm4
```

If you import to a different dataset id, the app must be pointed at the same id or it will not find the data you imported.

## Firestore Storage Layout

The importer does not store the entire nationwide HDX cache in one Firestore document.

Instead it stores:

```txt
boundaryDatasets/{datasetId}
boundaryDatasets/{datasetId}/cities/{cityKey}
boundaryDatasets/{datasetId}/cities/{cityKey}/chunks/{chunkId}
```

### Dataset Document

Contains metadata such as:

- `datasetId`
- `count`
- `cityCount`
- `source`
- `sourceUrl`
- `boundaryMode`
- `storage.chunkTargetBytes`
- `storage.totalChunks`

### City Document

Contains metadata such as:

- `cityKey`
- `cityName`
- `cityPcode`
- `normalizedCityName`
- `province`
- `featureCount`
- `chunkCount`

### Chunk Document

Contains the actual boundary payload for part of a city:

- `featuresEncoding`
- `featuresPayload`
- `byteLength`
- `index`

The payload is stored as:

- gzipped JSON
- base64 encoded

This is done to keep document sizes manageable.

## How App Features Are Shaped

During import, each cached HDX feature is turned into a mapping feature with:

- `geometry`
- `properties.name`
- `properties.city`
- `properties.psgcCode`
- `properties.id`
- `properties.boundaryKind`
- `properties.sourceType`

Example shape:

```json
{
  "type": "Feature",
  "geometry": {},
  "properties": {
    "boundaryKind": "indicative",
    "city": "San Jose City",
    "id": 34926001,
    "name": "A. Pascual",
    "psgcCode": "034926001",
    "sourceType": "firestore-hdx-cod-ab"
  }
}
```

## Running The Import

Standard import:

```powershell
npm run import:hdx
npm run import:firebase:hdx -- --dataset=hdx-philippines-adm4
```

Dry run:

```powershell
npm run import:firebase:hdx:dry-run
```

## Common Failure Cases

### Missing Cache Files

Meaning:

- the importer could not find the local nationwide HDX cache files

Typical fix:

- run `npm run import:hdx` first
- if needed, pass the correct cache path with `--cache-dir=...`

### Missing Firebase Project Id

Meaning:

- `FIREBASE_PROJECT_ID` was not available to the Node import process

Typical fix:

- set `FIREBASE_PROJECT_ID` in `.env`
- or export it in your shell before running the importer

### Missing Service Account

Meaning:

- local import does not have the Firebase admin credentials it needs

Typical fix:

- set `FIREBASE_SERVICE_ACCOUNT_PATH` to a valid service account JSON file

## Important Limits

- This repo does not ship the nationwide dataset.
- Firestore is used as an application-serving cache, not as the original source archive.
- The imported boundaries should be treated as dataset-derived map geometry, not guaranteed legal boundary truth.
