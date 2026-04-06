export interface PackageAsset {
  assetId: string
  guid: string
  pathname: string
  size: number
  hasMeta: boolean
  safePath: boolean
}

export interface IndexedPackage {
  packageName: string
  assetCount: number
  assets: PackageAsset[]
  sessionId?: string
  source: 'local' | 'backend'
}

export interface BackendHealth {
  status: 'checking' | 'online' | 'offline'
  message: string
}

export type WorkerRequest =
  | { type: 'index-package'; file: File }
  | { type: 'download-asset'; assetId: string }
  | { type: 'reset' }

export type WorkerResponse =
  | { type: 'status'; message: string; progress: number }
  | { type: 'indexed'; pkg: IndexedPackage }
  | { type: 'downloaded'; assetId: string; filename: string; bytes: ArrayBuffer }
  | { type: 'error'; message: string }
