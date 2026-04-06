export interface PackageAsset {
  assetId: string
  guid: string
  pathname: string
  size: number
  hasMeta: boolean
  safePath: boolean
}

export interface PackageFingerprint {
  md5: string
  sha256: string
  guidFingerprint: string
  guidCount: number
  guidValues: string[]
  guidSample: string[]
  assetCount: number
  safeAssetCount: number
  unsafeAssetCount: number
}

export interface PackageIdentity {
  lookupStatus: 'pending' | 'resolved' | 'unavailable'
  recognitionStatus: 'known-good' | 'known-custom' | 'likely-custom' | 'unrecognized' | 'corrupt' | 'unknown'
  matchType: 'hash' | 'guids' | 'none'
  displayName?: string
  baseName?: string
  version?: string
  author?: string
  thumbnailUrl?: string
  sourceLinks?: Array<{ label: string; url: string }>
  message: string
}

export interface IndexedPackage {
  packageName: string
  assetCount: number
  assets: PackageAsset[]
  fingerprint: PackageFingerprint
  identity: PackageIdentity
  sessionId?: string
  source: 'local' | 'backend'
}

export interface BackendHealth {
  status: 'checking' | 'online' | 'offline'
  message: string
}

export interface ServerConfig {
  theme: 'dark' | 'light'
  themeEnforced: boolean
  identityLookupEnabled?: boolean
  identityCatalogUrl?: string
}

export type WorkerRequest =
  | { type: 'index-package'; file: File }
  | { type: 'download-asset'; assetId: string }
  | { type: 'download-package-zip' }
  | { type: 'preview-asset'; assetId: string }
  | { type: 'reset' }

export type WorkerResponse =
  | { type: 'status'; message: string; progress: number }
  | { type: 'indexed'; pkg: IndexedPackage }
  | { type: 'downloaded'; assetId: string; filename: string; bytes: ArrayBuffer }
  | { type: 'zipped'; filename: string; bytes: ArrayBuffer }
  | { type: 'previewed'; assetId: string; filename: string; bytes: ArrayBuffer }
  | { type: 'error'; message: string }
