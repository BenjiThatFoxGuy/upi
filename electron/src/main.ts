import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
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

const APP_DISPLAY_NAME = 'Unity Package Inspector'

// Stored reference for triggering update checks from the menu.
// On macOS this is the Sparkle bridge; on Win/Linux it wraps electron-updater.
let checkForUpdatesFromMenu: (() => void) | null = null

// Sparkle bridge reference for macOS-specific operations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sparkleBridge: any = null

// Whether the current update check was triggered by the user (menu item).
let userInitiatedCheck = false

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
        // build time. Read it from the plist file directly since Electron
        // doesn't expose a plist API.
        let plistKey = ''
        try {
          const plistPath = path.join(
            app.getAppPath(), '..', '..', 'Info.plist',
          )
          const plistContent = fs.readFileSync(plistPath, 'utf-8')
          const match = plistContent.match(
            /<key>SUPublicEDKey<\/key>\s*<string>([^<]+)<\/string>/,
          )
          if (match) plistKey = match[1]
        } catch {
          // Not packaged or plist unreadable - fall through to env var
        }

        const publicEdKey =
          process.env.UPI_SPARKLE_PUBLIC_KEY ?? plistKey

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

          if (event.type === 'update-available') {
            const version = (event.version as string) ?? 'unknown'
            dialog
              .showMessageBox({
                type: 'info',
                title: 'Update Available',
                message: `A new version of ${APP_DISPLAY_NAME} is available.`,
                detail: `Version ${version} is ready to download. The update will be downloaded in the background.`,
                buttons: ['OK'],
              })
              .catch(() => {})
          }

          if (event.type === 'update-downloaded') {
            dialog
              .showMessageBox({
                type: 'info',
                title: 'Update Ready',
                message: 'An update has been downloaded.',
                detail: `The new version will be installed when you quit ${APP_DISPLAY_NAME}. Would you like to restart now?`,
                buttons: ['Restart Now', 'Later'],
                defaultId: 0,
              })
              .then(({ response }) => {
                if (response === 0) {
                  sparkleBridge?.installUpdateNow()
                }
              })
              .catch(() => {})
          }

          if (event.type === 'update-not-available' && userInitiatedCheck) {
            userInitiatedCheck = false
            dialog
              .showMessageBox({
                type: 'info',
                title: 'No Updates Available',
                message: `You're up to date!`,
                detail: `${APP_DISPLAY_NAME} ${app.getVersion()} is the latest version.`,
                buttons: ['OK'],
              })
              .catch(() => {})
          }

          if (event.type === 'error' && userInitiatedCheck) {
            userInitiatedCheck = false
            dialog
              .showMessageBox({
                type: 'warning',
                title: 'Update Check Failed',
                message: 'Could not check for updates.',
                detail: 'Please check your internet connection and try again later.',
                buttons: ['OK'],
              })
              .catch(() => {})
          }
        })

        // Enable periodic background checks.
        bridge.setAutomaticChecks(true)

        // Check on launch (silently - no dialog if up to date).
        bridge.checkForUpdates()

        // Clean up the native callback on quit to avoid calling into a
        // deallocated handler.
        app.on('will-quit', () => bridge.setEventHandler(null))

        sparkleBridge = bridge
        checkForUpdatesFromMenu = () => {
          userInitiatedCheck = true
          bridge.checkForUpdates()
        }
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

      autoUpdater.on('update-available', (info) => {
        dialog
          .showMessageBox({
            type: 'info',
            title: 'Update Available',
            message: `A new version of ${APP_DISPLAY_NAME} is available.`,
            detail: `Version ${info.version} is being downloaded in the background.`,
            buttons: ['OK'],
          })
          .catch(() => {})
      })

      autoUpdater.on('update-downloaded', (info) => {
        dialog
          .showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: 'An update has been downloaded.',
            detail: `Version ${info.version} will be installed when you quit ${APP_DISPLAY_NAME}. Would you like to restart now?`,
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
          })
          .then(({ response }) => {
            if (response === 0) {
              autoUpdater.quitAndInstall()
            }
          })
          .catch(() => {})
      })

      autoUpdater.on('update-not-available', () => {
        if (userInitiatedCheck) {
          userInitiatedCheck = false
          dialog
            .showMessageBox({
              type: 'info',
              title: 'No Updates Available',
              message: `You're up to date!`,
              detail: `${APP_DISPLAY_NAME} ${app.getVersion()} is the latest version.`,
              buttons: ['OK'],
            })
            .catch(() => {})
        }
      })

      autoUpdater.on('error', (err) => {
        if (userInitiatedCheck) {
          userInitiatedCheck = false
          dialog
            .showMessageBox({
              type: 'warning',
              title: 'Update Check Failed',
              message: 'Could not check for updates.',
              detail: err?.message ?? 'Please check your internet connection and try again later.',
              buttons: ['OK'],
            })
            .catch(() => {})
        }
      })

      checkForUpdatesFromMenu = () => {
        userInitiatedCheck = true
        autoUpdater.checkForUpdates()
      }

      await autoUpdater.checkForUpdates()
      console.log('[updater] auto-updater initialized')
    } catch (err) {
      console.error('[updater] failed to initialize:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

function buildAppMenu() {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_DISPLAY_NAME,
            submenu: [
              { role: 'about' as const, label: `About ${APP_DISPLAY_NAME}` },
              { type: 'separator' as const },
              ...(checkForUpdatesFromMenu
                ? [
                    {
                      label: 'Check for Updates…',
                      click: () => checkForUpdatesFromMenu?.(),
                    },
                    { type: 'separator' as const },
                  ]
                : []),
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, label: `Hide ${APP_DISPLAY_NAME}` },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, label: `Quit ${APP_DISPLAY_NAME}` },
            ] as Electron.MenuItemConstructorOptions[],
          },
        ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GitHub Repository',
          click: () =>
            shell.openExternal('https://github.com/BenjiThatFoxGuy/upi'),
        },
        ...(!isMac && checkForUpdatesFromMenu
          ? [
              { type: 'separator' as const },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdatesFromMenu?.(),
              },
            ]
          : []),
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
  // Initialize the updater first, then build the menu (the menu includes
  // "Check for Updates" only when the updater bridge is available).
  await initAutoUpdater()
  buildAppMenu()
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
