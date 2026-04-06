#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
WEB_DIR="$ROOT_DIR/web"

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Linux*) PLATFORM="linux" ;;
  Darwin*) PLATFORM="macos" ;;
  *)
    echo "[unitypackage-browser-web] Unsupported platform: $OS_NAME" >&2
    exit 1
    ;;
esac

if [[ "$PLATFORM" == "linux" ]]; then
  echo "[unitypackage-browser-web] Linux detected. Using Codespaces-friendly defaults."
else
  echo "[unitypackage-browser-web] macOS detected. Using local dev defaults."
fi

PYTHON_BIN="python3"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[unitypackage-browser-web] python3 is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[unitypackage-browser-web] npm is required." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/.venv" ]]; then
  echo "[unitypackage-browser-web] Creating Python virtual environment in .venv ..."
  "$PYTHON_BIN" -m venv "$ROOT_DIR/.venv"
fi

source "$ROOT_DIR/.venv/bin/activate"

echo "[unitypackage-browser-web] Installing backend requirements ..."
python -m pip install -r "$SERVER_DIR/requirements.txt"

if [[ ! -d "$WEB_DIR/node_modules" ]]; then
  echo "[unitypackage-browser-web] Installing frontend dependencies ..."
  (
    cd "$WEB_DIR"
    npm install
  )
fi

cleanup() {
  local exit_code=$?
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

trap cleanup INT TERM EXIT

echo "[unitypackage-browser-web] Starting backend on http://0.0.0.0:8000 ..."
(
  cd "$SERVER_DIR"
  python app.py
) &
BACKEND_PID=$!

echo "[unitypackage-browser-web] Starting frontend on http://0.0.0.0:5173 ..."
(
  cd "$WEB_DIR"
  npm run dev
) &
FRONTEND_PID=$!

echo "[unitypackage-browser-web] Dev servers are running. Press Ctrl+C to stop both."
wait "$BACKEND_PID" "$FRONTEND_PID"