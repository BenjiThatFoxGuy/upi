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
      // Bind only to loopback – no reason to expose the backend on the LAN.
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

app.whenReady().then(createWindow).catch((err: unknown) => {
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
