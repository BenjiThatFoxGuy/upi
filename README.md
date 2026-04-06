# unitypackage-browser-web

Unity package inspector with a React frontend and a Flask backend.

## Local development

Quick start scripts from the repo root:

```bash
./dev.sh
```

```bat
dev.bat
```

`dev.sh` supports Linux and macOS. On Linux it assumes a Codespaces-style Ubuntu environment and will create/use `.venv`, install backend requirements, install frontend dependencies if needed, and run both dev servers together. `dev.bat` is for local Windows development and prefers `.venv-1`, then `.venv`, before falling back to `py -3`.

Frontend:

```bash
cd web
npm install
npm run dev
```

The Vite dev server is configured to listen on your LAN at port `5173`.

Backend:

```bash
cd server
python -m pip install -r requirements.txt
python app.py
```

The Flask dev server already listens on `0.0.0.0:8000`, so other devices on your network can reach it.

By default, the frontend derives the API base URL from the browser hostname and port `8000`, so opening `http://<your-lan-ip>:5173` from another device will target `http://<your-lan-ip>:8000`. Override with `VITE_API_BASE_URL` if needed.

Frontend behavior is configured in `web/src/config/appConfig.ts`. The first exposed option, `indexingMode`, controls whether the UI lets the user choose local versus backend indexing or routes that choice automatically by file size.

Backend UI behavior is configured through environment variables. Theme enforcement defaults to dark-only with `UNITYPACKAGE_BROWSER_THEME=dark` and `UNITYPACKAGE_BROWSER_ENFORCE_THEME=true`.

Package identity lookup now reads from a remotely hosted CSV catalog with `UNITYPACKAGE_BROWSER_IDENTITY_CSV_URL`. By default it points at the published Google Sheets CSV currently in use. The backend matches exact known hashes first, then falls back to known GUID lineage so modified packages can still be recognized when the archive hash no longer matches a cataloged release.

The old schema is still supported: `Known hashes` and `Known GUIDs` can remain plain colon-separated values. You can now also annotate individual entries with versions inside the same cells using `value=version`, for example `hashA=1.0:hashB=2.0` or `guidA=1.0:guidB=1.0:guidC=2.0`. Semicolons are accepted too, but colons remain the recommended separator for Google Sheets CSV export.

The optional `Source links` column can contain one or more product URLs separated by `|`, for example `https://gumroad...|https://jinxxy...`. Legacy names such as `Source`, `Sources`, `Source URL`, and `Source URLs` are still accepted. The UI parses these into source links in the metadata card and labels known hosts such as Gumroad, Jinxxy, and Itch.io automatically.

Hash mismatch interpretation is now derived by the app rather than stored in the sheet. Exact hash matches are treated as known-good. Full GUID lineage with a hash mismatch is treated as a modified/custom variant. Strong partial GUID lineage is treated as possibly tampered or incomplete. If neither a hash nor GUID lineage matches, the package remains unknown.

## Reusable API

The backend now exposes a cleaner package-oriented API alongside the original compatibility routes, so you can reuse it from other projects without coupling to this UI. Preferred endpoints:

- `POST /api/packages/index` with multipart field `package`
- `POST /api/packages/index-url` with JSON body `{ "url": "https://.../file.unitypackage" }`
- `GET /api/packages/<session_id>` to retrieve the indexed package manifest again
- `GET /api/packages/<session_id>/assets/<asset_id>/download` to fetch one extracted asset
- `GET /api/packages/<session_id>/download.zip` to fetch the reconstructed ZIP
- `DELETE /api/packages/<session_id>` to discard the temporary indexed package
- `POST /api/identity/lookup` to resolve a fingerprint payload without uploading a package

This keeps the current web app working while giving future projects, such as a stash browser backed by a database of direct package links, a stable API surface focused on indexing and package contents rather than UI concerns.

## Current scope

- Local indexing in a web worker with SHA-256 and GUID fingerprinting
- Backend indexing, identity lookup, and per-asset downloads through Flask
- Single-container production build through the root Dockerfile
