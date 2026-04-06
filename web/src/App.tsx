import { startTransition, type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { appConfig } from './config/appConfig'
import type { BackendHealth, IndexedPackage, PackageAsset, PackageIdentity, ServerConfig, WorkerResponse } from './types/unitypackage'

function IdentityMessageValue({ children }: { children: string }) {
  return <span className="identity-message-value">{children}</span>
}

function resolveBackendBaseUrl() {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL
  if (configuredBaseUrl) {
    return configuredBaseUrl
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:8000'
  }

  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:8000`
}

const backendBaseUrl = resolveBackendBaseUrl()
const previewBatchSize = 36
const maxImagePreviewBytes = 12 * 1024 * 1024
const maxTextPreviewBytes = 256 * 1024

type ThemeMode = 'dark' | 'light'
type ViewMode = 'grid' | 'list'

type AssetPreview =
  | { status: 'loading' }
  | { status: 'ready'; kind: 'image'; url: string }
  | { status: 'ready'; kind: 'text'; text: string }
  | { status: 'error'; message: string }

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])
const textExtensions = new Set(['txt', 'json', 'md', 'yaml', 'yml', 'xml', 'shader', 'cginc', 'hlsl', 'glsl', 'css', 'js', 'ts', 'csv'])

function formatFileSize(size: number) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let index = 0

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function getFilename(pathname: string) {
  return pathname.split(/[\\/]/).filter(Boolean).at(-1) ?? pathname
}

function getExtension(pathname: string) {
  const filename = getFilename(pathname)
  const divider = filename.lastIndexOf('.')
  return divider === -1 ? '' : filename.slice(divider + 1).toLowerCase()
}

function getPreviewKind(pathname: string) {
  const extension = getExtension(pathname)
  if (imageExtensions.has(extension)) {
    return 'image'
  }

  if (textExtensions.has(extension)) {
    return 'text'
  }

  return null
}

function getMimeType(pathname: string) {
  const extension = getExtension(pathname)
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'bmp':
      return 'image/bmp'
    case 'avif':
      return 'image/avif'
    case 'json':
      return 'application/json'
    case 'xml':
      return 'application/xml'
    default:
      return 'text/plain;charset=utf-8'
  }
}

function getPreviewBudget(pathname: string) {
  return getPreviewKind(pathname) === 'image' ? maxImagePreviewBytes : maxTextPreviewBytes
}

function canPreviewAsset(asset: PackageAsset) {
  const kind = getPreviewKind(asset.pathname)
  if (!kind) {
    return false
  }

  return asset.size <= getPreviewBudget(asset.pathname)
}

function createTextPreview(bytes: ArrayBuffer) {
  const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  return text.split(/\r?\n/).slice(0, 6).join('\n').trim() || 'Empty file'
}

function triggerBrowserDownload(filename: string, bytes: ArrayBuffer) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function readInitialTheme(): ThemeMode {
  return 'dark'
}

function isUnityPackageFile(file: File) {
  return file.name.toLowerCase().endsWith('.unitypackage')
}

function getDroppedUnityPackage(files: FileList | null) {
  if (!files) {
    return null
  }

  return Array.from(files).find((file) => isUnityPackageFile(file)) ?? null
}

function getFilenameFromUrl(value: string) {
  try {
    const parsed = new URL(value)
    const candidate = parsed.pathname.split('/').filter(Boolean).at(-1)
    return candidate && candidate.length > 0 ? candidate : 'remote-package.unitypackage'
  } catch {
    return 'remote-package.unitypackage'
  }
}

function isLikelyCorsFailure(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return error instanceof TypeError || message.includes('failed to fetch') || message.includes('networkerror') || message.includes('load failed')
}

function createUnavailableIdentity(message: string): PackageIdentity {
  return {
    lookupStatus: 'unavailable',
    recognitionStatus: 'unknown',
    matchType: 'none',
    sourceLinks: [],
    message,
  }
}

function getIdentityTitle(identity: PackageIdentity) {
  if (identity.displayName) {
    return identity.displayName
  }

  switch (identity.recognitionStatus) {
    case 'known-good':
      return 'Known untampered package'
    case 'known-custom':
      return 'Known base, modified package'
    case 'likely-custom':
      return 'Probably custom package'
    case 'corrupt':
      return 'Corrupt or incomplete package'
    case 'unknown':
      return 'Unknown package'
    case 'unrecognized':
      return 'Unknown package'
    default:
      return identity.lookupStatus === 'pending' ? 'Checking package identity' : 'Identity unavailable'
  }
}

function getIdentityMeta(identity: PackageIdentity) {
  const matchLabel = identity.matchType === 'guids' ? 'GUID match' : identity.matchType === 'hash' ? 'Hash match' : 'No catalog match'
  if (identity.baseName && identity.version) {
    return `${identity.baseName} • ${identity.version} • ${matchLabel}`
  }

  if (identity.baseName) {
    return `${identity.baseName} • ${matchLabel}`
  }

  return matchLabel
}

function getSourceLinkKey(sourceLink: { label: string; url: string }) {
  return `${sourceLink.label}:${sourceLink.url}`
}

function FingerprintHover({ sha256 }: { sha256: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(sha256)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }

    window.setTimeout(() => {
      setCopyState('idle')
    }, 1600)
  }

  return (
    <span className="hover-card hover-card-above">
      <button type="button" className="hover-card-trigger identity-fingerprint-trigger" aria-haspopup="dialog" aria-label="Show full SHA-256 fingerprint">
        SHA-256 {sha256.slice(0, 12)}...
      </button>
      <span className="hover-card-panel hover-card-panel-wide">
        <span className="hover-card-overline">Full SHA-256</span>
        <code className="hover-card-code">{sha256}</code>
        <span className="hover-card-actions">
          <button type="button" className="secondary hover-card-button" onClick={handleCopy}>
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy hash'}
          </button>
        </span>
      </span>
    </span>
  )
}

function renderIdentityMessage(identity: PackageIdentity) {
  if (identity.recognitionStatus === 'known-good') {
    if (identity.displayName && identity.version) {
      return (
        <>
          GUID lineage matches a known file from <IdentityMessageValue>{identity.displayName}</IdentityMessageValue>, and the package hash matches a known hash of the cataloged <IdentityMessageValue>{identity.version}</IdentityMessageValue> release.
        </>
      )
    }

    if (identity.displayName) {
      return (
        <>
          GUID lineage matches a known file from <IdentityMessageValue>{identity.displayName}</IdentityMessageValue>, and the package hash matches a known cataloged release.
        </>
      )
    }
  }

  return identity.message
}

function renderIdentityExplanation(identity: PackageIdentity): ReactNode {
  if (identity.recognitionStatus === 'known-good' && identity.displayName && identity.version) {
    return (
      <>
        This looks like the same package we already know as <IdentityMessageValue>{identity.displayName}</IdentityMessageValue>, specifically the cataloged <IdentityMessageValue>{identity.version}</IdentityMessageValue> release.
        <span className="hover-card-support">
          If this did not match, it would usually mean the package is custom, edited, or possibly incomplete/tampered. If you already know it was customized, for example for a commission, that is typically expected and not a problem.
        </span>
      </>
    )
  }

  if (identity.recognitionStatus === 'known-good' && identity.displayName) {
    return (
      <>
        This looks like the same package we already know as <IdentityMessageValue>{identity.displayName}</IdentityMessageValue>.
        <span className="hover-card-support">
          If this did not match, it would usually mean the package is custom, edited, or possibly incomplete/tampered. If you already know it was customized, for example for a commission, that is typically expected and not a problem.
        </span>
      </>
    )
  }

  if (identity.recognitionStatus === 'known-custom') {
    return (
      <>
        We found at least one familiar internal file that lines up with <IdentityMessageValue>{identity.displayName ?? 'a known base package'}</IdentityMessageValue>, but the full package fingerprint differs from cataloged releases.
        <span className="hover-card-support">
          That usually means a customized build. If you expected edits, like a commission or private variant, this is typically fine.
        </span>
        {identity.matchedFilePathnames && identity.matchedFilePathnames.length > 0 ? (
          <span className="hover-card-support">
            {identity.matchedFilePathnames.map((pathname, index) => (
              <div key={`${pathname}-${index}`}>
                {index === 0 ? 'Matched files: ' : ''}
                <IdentityMessageValue>{pathname}</IdentityMessageValue>
                {identity.matchedGuidExamples && identity.matchedGuidExamples[index] ? (
                  <>
                    {' '}
                    <span style={{ opacity: 0.7 }}>({identity.matchedGuidExamples[index]})</span>
                  </>
                ) : null}
              </div>
            ))}
          </span>
        ) : null}
      </>
    )
  }

  if (identity.recognitionStatus === 'likely-custom') {
    return (
      <>
        We found familiar internal files from <IdentityMessageValue>{identity.displayName ?? 'a known base package'}</IdentityMessageValue>, but the overall package still differs from any exact cataloged release.
        <span className="hover-card-support">
          This often indicates a custom variant. If this was not expected, verify where the package came from.
        </span>
        {identity.matchedFilePathnames && identity.matchedFilePathnames.length > 0 ? (
          <span className="hover-card-support">
            {identity.matchedFilePathnames.map((pathname, index) => (
              <div key={`${pathname}-${index}`}>
                {index === 0 ? 'Example matched files: ' : ''}
                <IdentityMessageValue>{pathname}</IdentityMessageValue>
                {identity.matchedGuidExamples && identity.matchedGuidExamples[index] ? (
                  <>
                    {' '}
                    <span style={{ opacity: 0.7 }}>({identity.matchedGuidExamples[index]})</span>
                  </>
                ) : null}
              </div>
            ))}
          </span>
        ) : null}
      </>
    )
  }

  if (identity.recognitionStatus === 'corrupt') {
    return (
      <>
        The package appears incomplete or only partially lines up with a known package.
        <span className="hover-card-support">
          This can happen with heavy edits, but it can also mean a broken or tampered archive. If unexpected, treat it cautiously.
        </span>
      </>
    )
  }

  if (identity.recognitionStatus === 'unknown' || identity.recognitionStatus === 'unrecognized') {
    return (
      <>
        We could not connect this package to any known cataloged lineage.
        <span className="hover-card-support">
          That can still be normal for private or original work. Another common reason is that this specific package has not been cataloged yet.
        </span>
        <span className="hover-card-support">
          The catalog is maintained with broad coverage and a lot of manual effort, but it is not a guarantee that every release is already indexed.
        </span>
      </>
    )
  }

  return renderIdentityMessage(identity)
}

function IdentityMessageHelp({ identity }: { identity: PackageIdentity }) {
  return (
    <span className="hover-card hover-card-above hover-card-block">
      <button type="button" className="hover-card-trigger identity-message-trigger" aria-haspopup="dialog" aria-label="Explain identity match details">
        {renderIdentityMessage(identity)}
      </button>
      <span className="hover-card-panel hover-card-panel-wide">
        <span className="hover-card-overline">What this means</span>
        <span className="hover-card-body">{renderIdentityExplanation(identity)}</span>
      </span>
    </span>
  )
}

function IdentityThumbnail({ identity, alt }: { identity: PackageIdentity; alt: string }) {
  const directUrl = identity.thumbnailUrl?.trim()
  const [sourceUrl, setSourceUrl] = useState<string | null>(directUrl ?? null)
  const [usingProxy, setUsingProxy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setSourceUrl(directUrl ?? null)
    setUsingProxy(false)
    setFailed(false)
  }, [directUrl])

  if (!directUrl || failed || !sourceUrl) {
    return <div className="identity-thumbnail identity-thumbnail-fallback">No thumbnail</div>
  }

  return (
    <img
      className="identity-thumbnail"
      src={sourceUrl}
      alt={alt}
      loading="lazy"
      onError={() => {
        if (!usingProxy) {
          setUsingProxy(true)
          setSourceUrl(`${backendBaseUrl}/api/identity/thumbnail?url=${encodeURIComponent(directUrl)}`)
          return
        }

        setFailed(true)
      }}
    />
  )
}

function App() {
  const workerRef = useRef<Worker | null>(null)
  const previewUrlsRef = useRef(new Map<string, string>())
  const packageSourceRef = useRef<IndexedPackage | null>(null)
  const handleSelectedFileRef = useRef<(file: File | null) => void>(() => {})
  const dragDepthRef = useRef(0)
  const [backend, setBackend] = useState<BackendHealth>({
    status: 'checking',
    message: 'Checking backend availability.',
  })
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [packageUrl, setPackageUrl] = useState('')
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [search, setSearch] = useState('')
  const [pkg, setPkg] = useState<IndexedPackage | null>(null)
  const [statusMessage, setStatusMessage] = useState('Select a .unitypackage to begin.')
  const [progress, setProgress] = useState(0)
  const [busyAction, setBusyAction] = useState<'idle' | 'local' | 'backend' | 'remote-url' | 'download' | 'zip'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme)
  const [serverConfig, setServerConfig] = useState<ServerConfig>({ theme: 'dark', themeEnforced: true })
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [previews, setPreviews] = useState<Record<string, AssetPreview>>({})
  const deferredSearch = useDeferredValue(search)
  const thresholdLabel = formatFileSize(appConfig.automaticBackendThresholdBytes)
  const usesAutomaticRouting = appConfig.indexingMode === 'size-based'
  const backendAvailable = backend.status === 'online'
  const localOnlyMode = backend.status === 'offline'

  function clearPreviewUrls() {
    for (const url of previewUrlsRef.current.values()) {
      URL.revokeObjectURL(url)
    }

    previewUrlsRef.current.clear()
  }

  function applyPreview(assetId: string, pathname: string, bytes: ArrayBuffer) {
    const kind = getPreviewKind(pathname)
    if (kind === 'image') {
      const priorUrl = previewUrlsRef.current.get(assetId)
      if (priorUrl) {
        URL.revokeObjectURL(priorUrl)
      }

      const blob = new Blob([bytes], { type: getMimeType(pathname) })
      const url = URL.createObjectURL(blob)
      previewUrlsRef.current.set(assetId, url)
      setPreviews((current) => ({ ...current, [assetId]: { status: 'ready', kind: 'image', url } }))
      return
    }

    if (kind === 'text') {
      setPreviews((current) => ({ ...current, [assetId]: { status: 'ready', kind: 'text', text: createTextPreview(bytes) } }))
    }
  }

  useEffect(() => {
    packageSourceRef.current = pkg
  }, [pkg])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    function onDragEnter(event: DragEvent) {
      if (!event.dataTransfer?.types.includes('Files')) {
        return
      }

      event.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }

    function onDragOver(event: DragEvent) {
      if (!event.dataTransfer?.types.includes('Files')) {
        return
      }

      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    }

    function onDragLeave(event: DragEvent) {
      if (!event.dataTransfer?.types.includes('Files')) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) {
        setDragActive(false)
      }
    }

    function onDrop(event: DragEvent) {
      if (!event.dataTransfer?.files.length) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)

      const file = getDroppedUnityPackage(event.dataTransfer.files)
      if (!file) {
        setError('Drop a .unitypackage file to index it.')
        setStatusMessage('Only .unitypackage files can be dropped here.')
        return
      }

      setShowUrlInput(false)
      handleSelectedFileRef.current(file)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)

    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('./workers/packageWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data

      if (message.type === 'status') {
        setProgress(message.progress)
        setStatusMessage(message.message)
        return
      }

      if (message.type === 'indexed') {
        setBusyAction('idle')
        setProgress(100)
        setError(null)
        setStatusMessage(`Indexed ${message.pkg.assetCount} assets with local processing.`)
        startTransition(() => {
          setPkg(message.pkg)
        })
        return
      }

      if (message.type === 'downloaded') {
        setBusyAction('idle')
        triggerBrowserDownload(message.filename, message.bytes)
        setStatusMessage(`Downloaded ${message.filename}.`)
        return
      }

      if (message.type === 'zipped') {
        setBusyAction('idle')
        triggerBrowserDownload(message.filename, message.bytes)
        setStatusMessage(`Downloaded ${message.filename}.`)
        return
      }

      if (message.type === 'previewed') {
        applyPreview(message.assetId, message.filename, message.bytes)
        return
      }

      setBusyAction('idle')
      setError(message.message)
      setStatusMessage('Indexing failed.')
    }

    return () => {
      worker.postMessage({ type: 'reset' })
      worker.terminate()
      clearPreviewUrls()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function checkBackend() {
      try {
        const response = await fetch(`${backendBaseUrl}/api/health`)
        if (!response.ok) {
          throw new Error('Backend healthcheck returned a non-success status.')
        }

        if (!cancelled) {
          setBackend({ status: 'online', message: 'Backend is available.' })
        }
      } catch {
        if (!cancelled) {
          setBackend({ status: 'offline', message: 'Backend is unavailable. Local indexing is still available.' })
        }
      }
    }

    void checkBackend()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadServerConfig() {
      try {
        const response = await fetch(`${backendBaseUrl}/api/config`)
        if (!response.ok) {
          throw new Error('Config request failed.')
        }

        const config = (await response.json()) as ServerConfig
        if (!cancelled) {
          setServerConfig(config)
          setTheme(config.theme)
        }
      } catch {
        if (!cancelled) {
          setServerConfig({ theme: 'dark', themeEnforced: true, identityLookupEnabled: false })
          setTheme('dark')
        }
      }
    }

    void loadServerConfig()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    clearPreviewUrls()
    setPreviews({})
  }, [pkg?.packageName, pkg?.sessionId, pkg?.source])

  useEffect(() => {
    if (!pkg || pkg.source !== 'local' || pkg.identity.lookupStatus !== 'pending') {
      return
    }

    const localPackage = pkg

    if (!backendAvailable) {
      return
    }

    if (serverConfig.identityLookupEnabled === false) {
      setPkg((current) => (current && current.source === 'local'
        ? { ...current, identity: createUnavailableIdentity('Identity lookup is not configured on this server.') }
        : current))
      return
    }

    let cancelled = false

    async function resolveLocalIdentity() {
      try {
        const response = await fetch(`${backendBaseUrl}/api/package/identify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            packageName: localPackage.packageName,
            ...localPackage.fingerprint,
            assets: localPackage.assets,
          }),
        })

        if (!response.ok) {
          throw new Error('Identity lookup failed.')
        }

        const identity = (await response.json()) as PackageIdentity
        if (!cancelled) {
          setPkg((current) => {
            if (!current || current.source !== 'local' || current.fingerprint.sha256 !== localPackage.fingerprint.sha256) {
              return current
            }

            return {
              ...current,
              identity: {
                ...identity,
                matchedGuidExamples: identity.matchedGuidExamples || current.identity.matchedGuidExamples,
                matchedFilePathnames: identity.matchedFilePathnames || current.identity.matchedFilePathnames,
              },
            }
          })
        }
      } catch {
        if (!cancelled) {
          setPkg((current) => (current && current.source === 'local' && current.fingerprint.sha256 === localPackage.fingerprint.sha256
            ? { ...current, identity: createUnavailableIdentity('Identity service could not be reached.') }
            : current))
        }
      }
    }

    void resolveLocalIdentity()
    return () => {
      cancelled = true
    }
  }, [backendAvailable, pkg, serverConfig.identityLookupEnabled])

  const visibleAssets = useMemo(() => {
    if (!pkg) {
      return []
    }

    const query = deferredSearch.trim().toLowerCase()
    if (!query) {
      return pkg.assets
    }

    return pkg.assets.filter(
      (asset) => asset.pathname.toLowerCase().includes(query) || asset.guid.toLowerCase().includes(query),
    )
  }, [deferredSearch, pkg])

  useEffect(() => {
    if (!pkg) {
      return
    }

    if (pkg.source === 'backend' && !backendAvailable) {
      return
    }

    const candidates = visibleAssets
      .slice(0, previewBatchSize)
      .filter((asset) => canPreviewAsset(asset) && previews[asset.assetId] === undefined)

    if (candidates.length === 0) {
      return
    }

    setPreviews((current) => {
      const next = { ...current }
      for (const asset of candidates) {
        next[asset.assetId] = { status: 'loading' }
      }
      return next
    })

    for (const asset of candidates) {
      if (pkg.source === 'local') {
        workerRef.current?.postMessage({ type: 'preview-asset', assetId: asset.assetId })
        continue
      }

      void (async () => {
        try {
          const response = await fetch(`${backendBaseUrl}/api/package/${pkg.sessionId}/assets/${encodeURIComponent(asset.assetId)}/download`)
          if (!response.ok) {
            throw new Error('Preview fetch failed.')
          }

          const bytes = await response.arrayBuffer()
          applyPreview(asset.assetId, asset.pathname, bytes)
        } catch {
          setPreviews((current) => ({ ...current, [asset.assetId]: { status: 'error', message: 'Preview unavailable' } }))
        }
      })()
    }
  }, [backend.status, pkg, previews, visibleAssets])

  const packageSizeLabel = selectedFile ? formatFileSize(selectedFile.size) : packageUrl.trim() ? 'Remote URL selected' : 'No package selected'
  const selectedPackageLabel = selectedFile?.name ?? (packageUrl.trim() ? getFilenameFromUrl(packageUrl.trim()) : 'Nothing loaded yet')
  const exceedsAutomaticThreshold = selectedFile !== null && selectedFile.size >= appConfig.automaticBackendThresholdBytes
  const routingSummary = localOnlyMode
    ? 'Backend is offline. The app is running in local-only mode.'
    : usesAutomaticRouting
      ? `Indexing target is selected automatically. Files at or above ${thresholdLabel} go through the backend when it is available.`
      : 'Indexing target is selected by the user.'
  const canRetryCurrentSource = busyAction === 'idle' && (Boolean(selectedFile) || packageUrl.trim().length > 0)

  function handleSelectedFile(file: File | null) {
    setSelectedFile(file)
    setPackageUrl('')
    setPkg(null)
    setError(null)
    setProgress(0)

    if (!file) {
      setStatusMessage('Select a .unitypackage to begin.')
      return
    }

    if (usesAutomaticRouting || localOnlyMode) {
      setStatusMessage(`Selected ${file.name}. Starting indexing.`)
      void indexUsingConfiguredMode(file)
      return
    }

    setStatusMessage(`Ready to index ${file.name}.`)
  }

  useEffect(() => {
    handleSelectedFileRef.current = handleSelectedFile
  }, [handleSelectedFile])

  async function indexLocally(fileOverride?: File) {
    const file = fileOverride ?? selectedFile
    if (!file || !workerRef.current) {
      return
    }

    setBusyAction('local')
    setProgress(0)
    setError(null)
    setPkg(null)
    setStatusMessage('Starting local indexing.')
    workerRef.current.postMessage({ type: 'index-package', file })
  }

  async function fetchUrlAsLocalFile() {
    if (!packageUrl.trim()) {
      return null
    }

    const response = await fetch(packageUrl.trim())
    if (!response.ok) {
      throw new Error('Remote package fetch failed.')
    }

    const bytes = await response.blob()
    const fileName = getFilenameFromUrl(packageUrl.trim())
    return new File([bytes], fileName.toLowerCase().endsWith('.unitypackage') ? fileName : `${fileName}.unitypackage`, {
      type: 'application/octet-stream',
    })
  }

  async function indexRemoteUrlOnBackend() {
    const response = await fetch(`${backendBaseUrl}/api/package/index-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: packageUrl.trim() }),
    })

    if (!response.ok) {
      const data = (await response.json()) as { error?: string }
      throw new Error(data.error ?? 'Remote URL indexing failed.')
    }

    const data = (await response.json()) as IndexedPackage
    setSelectedFile(null)
    setProgress(100)
    setStatusMessage(`Indexed ${data.assetCount} assets from the remote URL with backend processing.`)
    setPkg({ ...data, source: 'backend' })
  }

  async function indexOnBackend(fileOverride?: File) {
    const file = fileOverride ?? selectedFile
    if (!file) {
      return
    }

    setBusyAction('backend')
    setProgress(15)
    setError(null)
    setPkg(null)
    setStatusMessage('Uploading package for backend indexing.')

    try {
      const body = new FormData()
      body.set('package', file)

      const response = await fetch(`${backendBaseUrl}/api/package/index`, {
        method: 'POST',
        body,
      })

      if (!response.ok) {
        const data = (await response.json()) as { error?: string }
        throw new Error(data.error ?? 'Backend indexing failed.')
      }

      const data = (await response.json()) as IndexedPackage
      setProgress(100)
      setStatusMessage(`Indexed ${data.assetCount} assets with backend processing.`)
      setPkg({ ...data, source: 'backend' })
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Backend indexing failed.'
      setError(message)
      setStatusMessage('Backend indexing failed.')
    } finally {
      setBusyAction('idle')
    }
  }

  async function indexFromUrl() {
    if (!packageUrl.trim()) {
      return
    }

    setBusyAction('remote-url')
    setProgress(8)
    setError(null)
    setPkg(null)

    setStatusMessage('Fetching remote package directly in the browser.')

    try {
      const remoteFile = await fetchUrlAsLocalFile()
      if (!remoteFile || !workerRef.current) {
        throw new Error('No remote package URL was provided.')
      }

      setSelectedFile(remoteFile)
      workerRef.current.postMessage({ type: 'index-package', file: remoteFile })
    } catch (caughtError) {
      if (backendAvailable && isLikelyCorsFailure(caughtError)) {
        setStatusMessage('Browser fetch was blocked. Retrying through the backend.')

        try {
          await indexRemoteUrlOnBackend()
        } catch (backendError) {
          const message = backendError instanceof Error ? backendError.message : 'Remote URL indexing failed.'
          setError(message)
          setStatusMessage('Remote URL indexing failed.')
        } finally {
          setBusyAction('idle')
        }

        return
      }

      const message = caughtError instanceof Error ? caughtError.message : 'Remote URL indexing failed.'
      setBusyAction('idle')
      setError(message)
      setStatusMessage('Remote URL indexing failed.')
    }
  }

  async function indexUsingConfiguredMode(fileOverride?: File) {
    const file = fileOverride ?? selectedFile
    if (!file) {
      return
    }

    if (file.size >= appConfig.automaticBackendThresholdBytes && backendAvailable) {
      await indexOnBackend(file)
      return
    }

    await indexLocally(file)
  }

  async function retryCurrentSource() {
    if (packageUrl.trim()) {
      await indexFromUrl()
      return
    }

    if (!selectedFile) {
      return
    }

    if (usesAutomaticRouting || localOnlyMode) {
      await indexUsingConfiguredMode(selectedFile)
      return
    }

    await indexLocally(selectedFile)
  }

  async function downloadAsset(assetId: string) {
    if (!pkg) {
      return
    }

    setBusyAction('download')
    setError(null)

    if (pkg.source === 'local') {
      workerRef.current?.postMessage({ type: 'download-asset', assetId })
      return
    }

    if (!backendAvailable) {
      setBusyAction('idle')
      setError('Backend download is unavailable while the backend is offline.')
      setStatusMessage('Backend is offline. Local-only mode is active.')
      return
    }

    try {
      const response = await fetch(`${backendBaseUrl}/api/package/${pkg.sessionId}/assets/${encodeURIComponent(assetId)}/download`)
      if (!response.ok) {
        throw new Error('Asset download failed.')
      }

      const disposition = response.headers.get('content-disposition')
      const filenameMatch = disposition?.match(/filename="?([^"]+)"?$/)
      const filename = filenameMatch?.[1] ?? 'asset.bin'
      const bytes = await response.arrayBuffer()
      triggerBrowserDownload(filename, bytes)
      setStatusMessage(`Downloaded ${filename}.`)
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Asset download failed.'
      setError(message)
    } finally {
      setBusyAction('idle')
    }
  }

  async function downloadPackageZip() {
    if (!pkg) {
      return
    }

    setBusyAction('zip')
    setError(null)
    setStatusMessage('Preparing ZIP download.')

    if (pkg.source === 'local') {
      workerRef.current?.postMessage({ type: 'download-package-zip' })
      return
    }

    if (!backendAvailable) {
      setBusyAction('idle')
      setError('Backend ZIP export is unavailable while the backend is offline.')
      setStatusMessage('Backend is offline. Local-only mode is active.')
      return
    }

    try {
      const response = await fetch(`${backendBaseUrl}/api/package/${pkg.sessionId}/download.zip`)
      if (!response.ok) {
        throw new Error('ZIP download failed.')
      }

      const disposition = response.headers.get('content-disposition')
      const filenameMatch = disposition?.match(/filename="?([^\"]+)"?$/)
      const filename = filenameMatch?.[1] ?? `${pkg.packageName.replace(/\.unitypackage$/i, '')}.zip`
      const bytes = await response.arrayBuffer()
      triggerBrowserDownload(filename, bytes)
      setStatusMessage(`Downloaded ${filename}.`)
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'ZIP download failed.'
      setError(message)
      setStatusMessage('ZIP download failed.')
    } finally {
      setBusyAction('idle')
    }
  }

  function renderPreview(asset: PackageAsset) {
    const preview = previews[asset.assetId]
    const extension = getExtension(asset.pathname).toUpperCase() || 'FILE'

    if (!canPreviewAsset(asset)) {
      return <div className="asset-preview asset-preview-fallback">{extension}</div>
    }

    if (!preview || preview.status === 'loading') {
      return <div className="asset-preview asset-preview-loading">Loading preview</div>
    }

    if (preview.status === 'error') {
      return <div className="asset-preview asset-preview-fallback">{extension}</div>
    }

    if (preview.kind === 'image') {
      return <img className="asset-preview asset-preview-image" src={preview.url} alt={getFilename(asset.pathname)} loading="lazy" />
    }

    return <pre className="asset-preview asset-preview-text">{preview.text}</pre>
  }

  return (
    <main className="shell">
      {dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <strong>Drop a .unitypackage anywhere</strong>
            <span>The package will be selected for indexing immediately.</span>
          </div>
        </div>
      ) : null}

      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Unity package inspector</p>
          <h1>Inspect, verify, and unpack Unity packages.</h1>
          <p className="lede">Open a package, fingerprint it by hash and GUIDs, compare it against a central catalog, browse its contents, and download individual files.</p>
        </div>

        <div className="status-rack">
          <article className={`status-card status-${backend.status}`}>
            <span className="status-label">Backend</span>
            <strong>{backend.status === 'online' ? 'Online' : backend.status === 'offline' ? 'Offline' : 'Checking'}</strong>
            <p>{backend.message}</p>
          </article>
          <article className="status-card">
            <span className="status-label">Selected package</span>
            <strong>{selectedPackageLabel}</strong>
            <p>{packageSizeLabel}</p>
          </article>
          <article className={`status-card identity-${pkg?.identity.recognitionStatus ?? 'unknown'}`}>
            <span className="status-label">Package identity</span>
            {pkg?.identity.thumbnailUrl ? <IdentityThumbnail identity={pkg.identity} alt={getIdentityTitle(pkg.identity)} /> : null}
            <strong>{pkg ? getIdentityTitle(pkg.identity) : 'No package indexed yet'}</strong>
            <p>{pkg ? getIdentityMeta(pkg.identity) : 'Hash and GUID recognition will appear here.'}</p>
            {pkg?.identity.author ? <p className="identity-author">Catalog author: {pkg.identity.author}</p> : null}
            {pkg?.identity.sourceLinks.length ? (
              <p className="identity-sources">
                <span>{pkg.identity.sourceLinks.length === 1 ? 'Source:' : 'Sources:'}</span>{' '}
                {pkg.identity.sourceLinks.map((sourceLink, index) => (
                  <span key={getSourceLinkKey(sourceLink)}>
                    {index > 0 ? ' | ' : null}
                    <a href={sourceLink.url} target="_blank" rel="noreferrer">
                      {sourceLink.label}
                    </a>
                  </span>
                ))}
              </p>
            ) : null}
            {pkg ? <p className="identity-fingerprint"><FingerprintHover sha256={pkg.fingerprint.sha256} /> · {pkg.fingerprint.guidCount} GUIDs</p> : null}
            {pkg ? <p className="identity-message"><IdentityMessageHelp identity={pkg.identity} /></p> : null}
          </article>
        </div>
      </section>

      <section className="control-grid">
        <article className="panel ingest-panel">
          <h2>Load package</h2>
          <p className="panel-copy">Choose a package from disk, drop one anywhere on the page, or load one from a direct URL.</p>
          <p className="panel-copy">File selection starts indexing immediately when automatic routing is active.</p>
          <p className="panel-copy">{routingSummary}</p>
          <label className="file-picker">
            <span>Choose .unitypackage</span>
            <input
              type="file"
              accept=".unitypackage"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null
                handleSelectedFile(file)
              }}
            />
          </label>

          <div className="source-row">
            <button className="secondary" type="button" onClick={() => setShowUrlInput((current) => !current)}>
              {showUrlInput ? 'Hide URL input' : 'Use package URL'}
            </button>
          </div>

          {showUrlInput ? (
            <div className="url-ingest-panel">
              <input
                className="search-input url-input"
                type="url"
                placeholder="https://example.com/package.unitypackage"
                value={packageUrl}
                onChange={(event) => {
                  setPackageUrl(event.target.value)
                  setSelectedFile(null)
                  setPkg(null)
                  setError(null)
                  setProgress(0)
                }}
              />
              <button disabled={!packageUrl.trim() || busyAction !== 'idle'} onClick={() => void indexFromUrl()}>
                Load URL
              </button>
            </div>
          ) : null}

          {usesAutomaticRouting && !localOnlyMode && exceedsAutomaticThreshold ? (
            <p className="warning-banner">This file is above the automatic backend threshold of {thresholdLabel}.</p>
          ) : null}

          {!(usesAutomaticRouting || localOnlyMode) ? (
            <div className="button-row">
                <button disabled={!selectedFile || busyAction !== 'idle'} onClick={() => void indexLocally()}>
                  Index locally
                </button>
                <button
                  className="secondary"
                  disabled={!selectedFile || !backendAvailable || busyAction !== 'idle'}
                  onClick={() => void indexOnBackend()}
                >
                  Index with backend
                </button>
            </div>
          ) : error && canRetryCurrentSource ? (
            <div className="button-row">
              <button className="secondary" disabled={!canRetryCurrentSource} onClick={() => void retryCurrentSource()}>
                Retry indexing
              </button>
            </div>
          ) : null}
        </article>

        <article className="panel progress-panel">
          <div className="panel-toolbar">
            <div>
              <h2>Session</h2>
              <p className="panel-copy">Indexing progress, theme, and asset layout.</p>
            </div>
            <div className="toolbar-actions">
              {!serverConfig.themeEnforced ? (
              <button className="secondary" onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}>
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
              ) : null}
            </div>
          </div>
          <div className="meter" aria-hidden="true">
            <div className="meter-fill" style={{ width: `${progress}%` }}></div>
          </div>
          <p className="status-message">{statusMessage}</p>
          {error ? <p className="error-banner">{error}</p> : null}
        </article>
      </section>

      <section className="browser-panel panel">
        <div className="browser-header">
          <div>
            <h2>Asset browser</h2>
            <p className="panel-copy">{pkg ? `${pkg.assetCount} assets indexed with ${pkg.source} processing.` : 'No package indexed yet.'}</p>
          </div>
          <div className="browser-controls">
            <button className="secondary" disabled={!pkg || busyAction !== 'idle'} onClick={() => void downloadPackageZip()}>
              Convert to zip
            </button>
            <div className="view-toggle" role="group" aria-label="Asset layout">
              <button className={viewMode === 'grid' ? 'view-toggle-active' : 'secondary'} onClick={() => setViewMode('grid')}>
                Grid
              </button>
              <button className={viewMode === 'list' ? 'view-toggle-active' : 'secondary'} onClick={() => setViewMode('list')}>
                List
              </button>
            </div>
            <input
              className="search-input"
              type="search"
              placeholder="Filter by path or GUID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>

        {viewMode === 'grid' ? (
          <div className="asset-grid" role="list" aria-label="Indexed assets">
            {visibleAssets.map((asset) => (
              <article className="asset-card" role="listitem" key={asset.assetId}>
                {renderPreview(asset)}
                <div className="asset-card-body">
                  <div className="asset-path">
                    <strong>{getFilename(asset.pathname)}</strong>
                    <span>{asset.pathname}</span>
                  </div>
                  <div className="asset-tags">
                    <span>{formatFileSize(asset.size)}</span>
                    <span>{asset.hasMeta ? 'Meta' : 'No meta'}</span>
                    <span>{asset.safePath ? 'Safe' : 'Flagged'}</span>
                  </div>
                  <div className="asset-card-actions">
                    <span className="asset-guid">{asset.guid}</span>
                    <button disabled={busyAction === 'download'} onClick={() => void downloadAsset(asset.assetId)}>
                      Download
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="asset-list" role="table" aria-label="Indexed assets">
            <div className="asset-row asset-row-head" role="row">
              <span>Preview</span>
              <span>Unity path</span>
              <span>Size</span>
              <span>Meta</span>
              <span>Safety</span>
              <span>Action</span>
            </div>

            {visibleAssets.map((asset) => (
              <div className="asset-row" role="row" key={asset.assetId}>
                <div className="asset-row-preview">{renderPreview(asset)}</div>
                <div className="asset-path">
                  <strong>{asset.pathname}</strong>
                  <span>{asset.guid}</span>
                </div>
                <span>{formatFileSize(asset.size)}</span>
                <span>{asset.hasMeta ? 'Yes' : 'No'}</span>
                <span>{asset.safePath ? 'Safe' : 'Flagged'}</span>
                <button disabled={busyAction === 'download'} onClick={() => void downloadAsset(asset.assetId)}>
                  Download
                </button>
              </div>
            ))}
          </div>
        )}

        {pkg && visibleAssets.length === 0 ? <p className="empty-state">No assets matched the current filter.</p> : null}
      </section>
    </main>
  )
}

export default App
