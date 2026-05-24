# Firestore Rules Analysis

## Client Firestore Paths

- `boundaryDatasets/{datasetId}` is read with `getDoc()` to load dataset metadata.
- `boundaryDatasets/{datasetId}/cities` is read with `getDocs(collection(...))` for city search indexing.
- `boundaryDatasets/{datasetId}/cities` is queried with `where("normalizedCityName", "==", value)` to select a city.
- `boundaryDatasets/{datasetId}/cities/{cityId}/chunks` is queried with `orderBy("index")` to load boundary feature chunks.

## Access Model

- Clients may read only boundary dataset documents and their `cities` / `chunks` subcollections.
- Clients must be signed in with Firebase Auth. The app signs in anonymously before Firestore reads.
- Client writes are denied. Boundary imports and updates remain server/admin-only.
- All other Firestore paths are denied by default.

## Rule Audit Notes

- Public list exploit: unauthenticated reads and lists are denied because reads require `request.auth != null`.
- Unauthorized write: all client creates, updates, and deletes are denied on boundary paths and default-denied elsewhere.
- Query mismatch: the required city list/query and chunk ordered query are allowed for authenticated anonymous users.
- App Check: Firestore App Check enforcement is configured outside rules; these rules pair that enforcement with anonymous Auth.
