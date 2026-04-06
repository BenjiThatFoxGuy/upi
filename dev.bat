@echo off
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "SERVER_DIR=%ROOT%\server"
set "WEB_DIR=%ROOT%\web"

set "PYTHON_EXE="
if exist "%ROOT%\.venv-1\Scripts\python.exe" set "PYTHON_EXE=%ROOT%\.venv-1\Scripts\python.exe"
if not defined PYTHON_EXE if exist "%ROOT%\.venv\Scripts\python.exe" set "PYTHON_EXE=%ROOT%\.venv\Scripts\python.exe"
if not defined PYTHON_EXE set "PYTHON_EXE=py -3"

echo [upi] Root: %ROOT%
echo [upi] Backend: %SERVER_DIR%
echo [upi] Frontend: %WEB_DIR%

if not exist "%WEB_DIR%\node_modules" (
  echo [upi] Installing frontend dependencies...
  pushd "%WEB_DIR%"
  call npm install
  if errorlevel 1 (
    popd
    echo [upi] npm install failed.
    exit /b 1
  )
  popd
)

echo [upi] Starting backend on http://0.0.0.0:8000 ...
start "Unity Package Inspector Backend" cmd /k "cd /d "%SERVER_DIR%" ^&^& %PYTHON_EXE% app.py"

echo [upi] Starting frontend on http://0.0.0.0:5173 ...
start "Unity Package Inspector Frontend" cmd /k "cd /d "%WEB_DIR%" ^&^& npm run dev"

echo.
echo [upi] Dev servers launched.
echo [upi] Open http://localhost:5173 on this PC or http://YOUR-LAN-IP:5173 on another device.
exit /b 0