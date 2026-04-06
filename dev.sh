#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
WEB_DIR="$ROOT_DIR/web"

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Linux*) PLATFORM="linux" ;;
  Darwin*) PLATFORM="macos" ;;
  *)
    echo "[upi] Unsupported platform: $OS_NAME" >&2
    exit 1
    ;;
esac

if [[ "$PLATFORM" == "linux" ]]; then
  echo "[upi] Linux detected. Using Codespaces-friendly defaults."
else
  echo "[upi] macOS detected. Using local dev defaults."
fi

PYTHON_BIN="python3"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[upi] python3 is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[upi] npm is required." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/.venv" ]]; then
  echo "[upi] Creating Python virtual environment in .venv ..."
  "$PYTHON_BIN" -m venv "$ROOT_DIR/.venv"
fi

source "$ROOT_DIR/.venv/bin/activate"

echo "[upi] Installing backend requirements ..."
python -m pip install -r "$SERVER_DIR/requirements.txt"

if [[ ! -d "$WEB_DIR/node_modules" ]]; then
  echo "[upi] Installing frontend dependencies ..."
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

echo "[upi] Starting backend on http://0.0.0.0:8000 ..."
(
  cd "$SERVER_DIR"
  export UPI_DEV=1
  python app.py
) &
BACKEND_PID=$!

echo "[upi] Starting frontend on http://0.0.0.0:5173 ..."
(
  cd "$WEB_DIR"
  npm run dev
) &
FRONTEND_PID=$!

echo "[upi] Dev servers are running. Press Ctrl+C to stop both."
wait "$BACKEND_PID" "$FRONTEND_PID"