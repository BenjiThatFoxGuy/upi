import { app, BrowserWindow, shell } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Dev mode: set ELECTRON_DEV=1 to skip spawning the bundled backend and
// instead load from ELECTRON_DEV_URL (default: http://localhost:5173).
// ---------------------------------------------------------------------------
const isDev = !!process.env.ELECTRON_DEV

let backend: ChildProcess | null = null

// ---------------------------------------------------------------------------
// Port helpers
// ---------------------------------------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function waitForBackend(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    function attempt() {
      http
        .get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume()
          if (res.statusCode === 200) {
            resolve()
          } else if (Date.now() < deadline) {
            setTimeout(attempt, 300)
          } else {
            reject(new Error('Backend health check timed out'))
          }
        })
        .on('error', () => {
          if (Date.now() < deadline) setTimeout(attempt, 300)
          else reject(new Error('Backend did not start within the timeout'))
        })
    }
    attempt()
  })
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

async function startBackend(): Promise<number> {
  const port = await findFreePort()

  const exe = process.platform === 'win32' ? 'app.exe' : 'app'
  const backendExe = path.join(process.resourcesPath, 'backend', exe)

  if (!fs.existsSync(backendExe)) {
    throw new Error(`Bundled backend not found at: ${backendExe}`)
  }

  backend = spawn(backendExe, [], {
    // Don't pop a console window for the backend on Windows.
    windowsHide: true,
    env: {
      ...process.env,
      // Bind only to loopback - no reason to expose the backend on the LAN.
      UPI_HOST: '127.0.0.1',
      UPI_PORT: String(port),
      // Tell Flask where the pre-built Vite assets live.
      FRONTEND_DIST: path.join(process.resourcesPath, 'frontend-dist'),
    },
  })

  backend.stdout?.on('data', (d: Buffer) => process.stdout.write(`[backend] ${d}`))
  backend.stderr?.on('data', (d: Buffer) => process.stderr.write(`[backend] ${d}`))
  backend.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[backend] exited with code ${code}`)
    }
  })

  await waitForBackend(port)
  return port
}

function stopBackend() {
  if (backend && !backend.killed) {
    backend.kill()
    backend = null
  }
}

// ---------------------------------------------------------------------------
// Auto-updater
// ---------------------------------------------------------------------------

async function initAutoUpdater() {
  if (isDev || !app.isPackaged) return

  if (process.platform === 'darwin') {
    // macOS: use Sparkle via electron-sparkle-updater.
    try {
      const { loadSparkleBridgeForApp } = await import('electron-sparkle-updater')
      const bridge = await loadSparkleBridgeForApp((msg) =>
        console.log('[sparkle]', msg),
      )

      if (bridge) {
        const archSuffix = process.arch === 'x64' ? 'x64' : 'arm64'
        const appcastUrl =
          process.env.UPI_APPCAST_URL ??
          `https://github.com/BenjiThatFoxGuy/upi/releases/latest/download/appcast-${archSuffix}.xml`

        // The public EdDSA key is baked into Info.plist (SUPublicEDKey) at
        // build time. Read it from there so there's a single source of truth.
        const { SUPublicEDKey } = (
          app as unknown as { getInfoPlistData?: () => Record<string, string> }
        ).getInfoPlistData?.() ?? {}

        const publicEdKey =
          process.env.UPI_SPARKLE_PUBLIC_KEY ?? SUPublicEDKey ?? ''

        if (
          !publicEdKey ||
          publicEdKey === 'SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'
        ) {
          console.log(
            '[sparkle] no EdDSA public key configured, skipping auto-update',
          )
          return
        }

        const ok = bridge.init({ appcastUrl, publicEdKey })
        if (!ok) {
          console.error('[sparkle] init failed')
          return
        }

        bridge.setEventHandler((event) => {
          console.log('[sparkle]', event.type, event)
        })

        // Enable periodic background checks.
        bridge.setAutomaticChecks(true)

        // Also check right now on launch.
        bridge.checkForUpdates()

        // Clean up the native callback on quit to avoid calling into a
        // deallocated handler.
        app.on('will-quit', () => bridge.setEventHandler(null))

        console.log('[sparkle] auto-updater initialized')
      } else {
        console.log('[sparkle] bridge not available, skipping auto-update')
      }
    } catch (err) {
      console.error('[sparkle] failed to initialize:', err)
    }
  } else {
    // Windows / Linux: use electron-updater.
    try {
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.logger = {
        info: (msg: string) => console.log('[updater]', msg),
        warn: (msg: string) => console.warn('[updater]', msg),
        error: (msg: string) => console.error('[updater]', msg),
        debug: (msg: string) => console.log('[updater:debug]', msg),
      }
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      await autoUpdater.checkForUpdatesAndNotify()
      console.log('[updater] auto-updater initialized')
    } catch (err) {
      console.error('[updater] failed to initialize:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  })

  // Show the window only once it's ready to avoid a blank flash.
  win.once('ready-to-show', () => win.show())

  // Route any window.open / target=_blank links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    const devUrl = process.env.ELECTRON_DEV_URL ?? 'http://localhost:5173'
    await win.loadURL(devUrl)
    win.webContents.openDevTools()
  } else {
    const port = await startBackend()
    await win.loadURL(`http://127.0.0.1:${port}`)
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  await createWindow()
  // Fire-and-forget: don't block the window on update checks.
  initAutoUpdater()
}).catch((err: unknown) => {
  console.error('Failed to launch:', err)
  app.quit()
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})

// macOS: re-open the window when the dock icon is clicked.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('will-quit', () => stopBackend())
