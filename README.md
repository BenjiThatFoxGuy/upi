# Unitypackage Inspector (UPI)

A web-based inspector for `.unitypackage` files. Upload a package (or provide a URL) to browse its assets, extract individual files, download a reconstructed ZIP, and optionally identify the package against a known catalog.

**Tech stack:** React + TypeScript (Vite) frontend · Flask (Python 3.10) backend

---

## Features

- Browse the full asset tree inside any `.unitypackage`
- Extract and download individual assets or the whole package as a ZIP
- SHA-256 and GUID fingerprinting for package identity lookup
- Identify packages against a remotely hosted CSV catalog; matches exact hashes, falls back to GUID lineage for modified variants
- Local (in-browser web worker) indexing for small files; backend indexing for larger ones
- Single-container production build

---

## Deployment

The easiest way to run UPI is with the prebuilt image from GHCR:

```bash
docker run -p 8000:8000 ghcr.io/benjithatfoxguy/upi:latest
```

The app will be available at `http://localhost:8000`.

Pass environment variables via `-e` to configure behaviour (see [Configuration](#configuration) below). For example:

```bash
docker run -p 8000:8000 \
  -e UPI_ENFORCE_THEME=false \
  ghcr.io/benjithatfoxguy/upi:latest
```

Available tags:

| Tag | Updated |
|---|---|
| `latest` | On every versioned release |
| `nightly` | On every push to `main` |
| `1.2.3` / `1.2` / `1` | Pinned release versions |

Or use Docker Compose — create a `compose.yaml`:

```yaml
services:
  upi:
    image: ghcr.io/benjithatfoxguy/upi:latest
    ports:
      - "8000:8000"
```

Then run:

```bash
docker compose up
```

### Building from source

If you need a custom build:

```bash
docker build -t upi .
docker run -p 8000:8000 upi
```

---

## Development

Quick-start scripts from the repo root start both servers together:

```bash
# Linux / macOS
./dev.sh

# Windows
dev.bat
```

`dev.sh` creates/reuses a `.venv`, installs backend requirements, installs frontend dependencies if needed, and runs both dev servers. `dev.bat` prefers `.venv-1`, then `.venv`, before falling back to `py -3`.

### Frontend only

```bash
cd web
npm install
npm run dev
```

The Vite dev server listens on `0.0.0.0:5173` (LAN-accessible).

### Backend only

```bash
cd server
python -m pip install -r requirements.txt
python app.py
```

The Flask dev server listens on `0.0.0.0:8000`.

### Connecting the two

The frontend automatically derives the API base URL from the browser hostname on port `8000`. Opening `http://<your-lan-ip>:5173` from another device will therefore target `http://<your-lan-ip>:8000`. Override this with the `VITE_API_BASE_URL` environment variable if needed.

---

## Configuration

### Frontend

`web/src/config/appConfig.ts` is the single place to tune frontend behaviour.

| Option | Description |
|---|---|
| `indexingMode` | `"local"` - always use the in-browser worker; `"backend"` - always use the server; `"auto"` - choose based on file size |

### Backend (environment variables)

| Variable | Default | Description |
|---|---|---|
| `UPI_THEME` | `dark` | Default UI theme (`dark` or `light`) |
| `UPI_ENFORCE_THEME` | `true` | When `true`, the user cannot switch themes |
| `UPI_IDENTITY_CSV_URL` | `https://benjithatfoxguy.github.io/pawprint/index.csv` | URL of the package catalog CSV used for identity lookup |
| `UPI_IDENTITY_TIMEOUT_SECONDS` | `5` | Timeout, in seconds, for fetching the identity catalog CSV |
| `UPI_IDENTITY_CACHE_SECONDS` | `300` | How long, in seconds, the backend caches the fetched identity catalog before refreshing it (defaults to `0` in dev mode) |
| `UPI_DEV` | *(unset)* | Set to `1` or `true` to enable backend development mode (disables catalog caching) |
| `FRONTEND_ORIGIN` | `*` | Allowed frontend origin used by the backend for CORS (set to e.g. `http://localhost:5173` in split frontend/backend setups) |

### Identity catalog CSV format

The CSV is fetched at runtime from `UPI_IDENTITY_CSV_URL`. Expected columns:

| Column | Description |
|---|---|
| `Known hashes` | Colon-separated SHA-256 hashes. Optionally annotate with a version: `hashA=1.0:hashB=2.0` |
| `Known GUIDs` | Colon-separated GUIDs, same optional `value=version` annotation |
| `Source links` *(optional)* | One or more product URLs separated by `\|`. Known hosts (Gumroad, Jinxxy, Itch.io) are labelled automatically. Also accepted as `Source`, `Sources`, `Source URL`, or `Source URLs` |

Identity matching logic:
- **Exact hash match** → known-good
- **Full GUID lineage match, hash mismatch** → modified/custom variant
- **Partial GUID lineage match** → possibly tampered or incomplete
- **No match** → unknown

---

## API reference

The backend exposes a package-oriented REST API that can be used independently of this UI.

### Packages

| Method | Endpoint | Body / notes |
|---|---|---|
| `POST` | `/api/packages/index` | Multipart form, field `package` - upload a `.unitypackage` file |
| `POST` | `/api/packages/index-url` | JSON `{ "url": "https://.../file.unitypackage" }` - index from a URL |
| `GET` | `/api/packages/<session_id>` | Retrieve the indexed package manifest |
| `GET` | `/api/packages/<session_id>/assets/<asset_id>/download` | Download a single extracted asset |
| `GET` | `/api/packages/<session_id>/download.zip` | Download the reconstructed ZIP |
| `DELETE` | `/api/packages/<session_id>` | Discard the temporary indexed package |

### Identity

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/identity/lookup` | Resolve a fingerprint payload against the catalog without uploading a package |
