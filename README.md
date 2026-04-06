# unitypackage-browser-web

Browser-first unitypackage inspector with a React frontend and an optional Flask backend.

## Local development

Frontend:

```bash
cd web
npm install
npm run dev
```

Backend:

```bash
cd server
python -m pip install -r requirements.txt
python app.py
```

The frontend defaults to `http://localhost:8000` for the Flask API. Override with `VITE_API_BASE_URL` if needed.

## Current scope

- Local worker-based indexing for smaller unitypackage files
- Optional Flask upload/index/download flow for larger packages
- Single-container production build through the root Dockerfile

