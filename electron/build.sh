#!/usr/bin/env bash
# Build the UPI desktop app (all platforms build for the current OS by default).
# Pass --mac, --win, or --linux to target a specific platform, plus any other
# electron-builder flags you need.
#
# Prerequisites:
#   - Node.js + npm  (for the web build and electron-builder)
#   - Python 3.10+   (for PyInstaller)
#   - pip install pyinstaller
set -euo pipefail

ELECTRON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ELECTRON_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# 1. Build the React / Vite frontend
# ---------------------------------------------------------------------------
echo "==> [1/3] Building web frontend..."
cd "$REPO_ROOT/web"
npm ci
npm run build
# Output: web/dist/

# ---------------------------------------------------------------------------
# 2. Bundle the Flask backend with PyInstaller
# ---------------------------------------------------------------------------
echo "==> [2/3] Packaging Python backend with PyInstaller..."
cd "$REPO_ROOT/server"
pyinstaller \
  --onedir \
  --name app \
  --distpath "$ELECTRON_DIR/pyinstaller-dist" \
  --workpath "/tmp/upi-pyinstaller-work" \
  --noconfirm \
  app.py
# Output: electron/pyinstaller-dist/app/

# ---------------------------------------------------------------------------
# 3. Build the Electron distributable
# ---------------------------------------------------------------------------
echo "==> [3/3] Building Electron distributable..."
cd "$ELECTRON_DIR"
npm ci
npm run compile
npx electron-builder "${@}"
# Output: dist/electron/

echo ""
echo "Done. Distributable is in dist/electron/"
