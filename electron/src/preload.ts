import { contextBridge } from 'electron'

// The renderer talks to the bundled Flask backend over HTTP on loopback, so no
// IPC bridges are needed. This flag only lets the UI know it's running in the
// desktop app (e.g. downloads open a native save dialog here).
contextBridge.exposeInMainWorld('upiDesktop', { isDesktop: true })
