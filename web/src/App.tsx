import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react'
import './App.css'
import type { BackendHealth, IndexedPackage, WorkerResponse } from './types/unitypackage'

const backendBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'
const localModeWarningBytes = 512 * 1024 * 1024

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

function triggerBrowserDownload(filename: string, bytes: ArrayBuffer) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function App() {
  const workerRef = useRef<Worker | null>(null)
  const [backend, setBackend] = useState<BackendHealth>({
    status: 'checking',
    message: 'Checking Flask backend availability.',
  })
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [search, setSearch] = useState('')
  const [pkg, setPkg] = useState<IndexedPackage | null>(null)
  const [statusMessage, setStatusMessage] = useState('Pick a unitypackage to start indexing.')
  const [progress, setProgress] = useState(0)
  const [busyAction, setBusyAction] = useState<'idle' | 'local' | 'backend' | 'download'>('idle')
  const [error, setError] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(search)

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
        setStatusMessage(`Indexed ${message.pkg.assetCount} assets locally.`)
        startTransition(() => {
          setPkg(message.pkg)
        })
        return
      }

      if (message.type === 'downloaded') {
        setBusyAction('idle')
        triggerBrowserDownload(message.filename, message.bytes)
        setStatusMessage(`Downloaded ${message.filename} from local worker memory.`)
        return
      }

      setBusyAction('idle')
      setError(message.message)
      setStatusMessage('Indexing failed.')
    }

    return () => {
      worker.postMessage({ type: 'reset' })
      worker.terminate()
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
          setBackend({ status: 'online', message: 'Flask backend is reachable for large-package indexing.' })
        }
      } catch {
        if (!cancelled) {
          setBackend({ status: 'offline', message: 'Backend is offline. Local-only mode is still available.' })
        }
      }
    }

    void checkBackend()
    return () => {
      cancelled = true
    }
  }, [])

  const visibleAssets = !pkg
    ? []
    : (() => {
        const query = deferredSearch.trim().toLowerCase()
        if (!query) {
          return pkg.assets
        }

        return pkg.assets.filter(
          (asset) => asset.pathname.toLowerCase().includes(query) || asset.guid.toLowerCase().includes(query),
        )
      })()

  const packageSizeLabel = selectedFile ? formatFileSize(selectedFile.size) : 'No package selected'
  const shouldRecommendBackend = selectedFile !== null && selectedFile.size > localModeWarningBytes

  async function indexLocally() {
    if (!selectedFile || !workerRef.current) {
      return
    }

    setBusyAction('local')
    setProgress(0)
    setError(null)
    setPkg(null)
    setStatusMessage('Starting local package parse in a worker.')
    workerRef.current.postMessage({ type: 'index-package', file: selectedFile })
  }

  async function indexOnBackend() {
    if (!selectedFile) {
      return
    }

    setBusyAction('backend')
    setProgress(15)
    setError(null)
    setPkg(null)
    setStatusMessage('Uploading package to Flask backend for indexing.')

    try {
      const body = new FormData()
      body.set('package', selectedFile)

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
      setStatusMessage(`Indexed ${data.assetCount} assets through Flask.`)
      setPkg({ ...data, source: 'backend' })
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Backend indexing failed.'
      setError(message)
      setStatusMessage('Backend indexing failed.')
    } finally {
      setBusyAction('idle')
    }
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
      setStatusMessage(`Downloaded ${filename} from Flask backend.`)
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Asset download failed.'
      setError(message)
    } finally {
      setBusyAction('idle')
    }
  }

  return (
    <main className="shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Firefox-first Unity package browser</p>
          <h1>Inspect a .unitypackage before you import it.</h1>
          <p className="lede">
            This first pass supports worker-based local indexing for smaller packages and an optional Flask path for heavier extraction.
          </p>
        </div>

        <div className="status-rack">
          <article className={`status-card status-${backend.status}`}>
            <span className="status-label">Backend</span>
            <strong>{backend.status === 'online' ? 'Online' : backend.status === 'offline' ? 'Offline' : 'Checking'}</strong>
            <p>{backend.message}</p>
          </article>
          <article className="status-card">
            <span className="status-label">Selected package</span>
            <strong>{selectedFile?.name ?? 'Nothing loaded yet'}</strong>
            <p>{packageSizeLabel}</p>
          </article>
        </div>
      </section>

      <section className="control-grid">
        <article className="panel ingest-panel">
          <h2>Load package</h2>
          <p className="panel-copy">Pick a package from disk, then choose the local worker or the Flask backend.</p>
          <label className="file-picker">
            <span>Choose .unitypackage</span>
            <input
              type="file"
              accept=".unitypackage"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null
                setSelectedFile(file)
                setPkg(null)
                setError(null)
                setProgress(0)
                setStatusMessage(file ? `Ready to index ${file.name}.` : 'Pick a unitypackage to start indexing.')
              }}
            />
          </label>

          {shouldRecommendBackend ? (
            <p className="warning-banner">
              Local mode is currently intended for smaller files. For anything above 512 MB, the Flask path is the safer starting point.
            </p>
          ) : null}

          <div className="button-row">
            <button disabled={!selectedFile || busyAction !== 'idle'} onClick={() => void indexLocally()}>
              Index locally
            </button>
            <button
              className="secondary"
              disabled={!selectedFile || backend.status !== 'online' || busyAction !== 'idle'}
              onClick={() => void indexOnBackend()}
            >
              Index with Flask
            </button>
          </div>
        </article>

        <article className="panel progress-panel">
          <h2>Job state</h2>
          <p className="panel-copy">The worker and Flask API both report through the same status rail.</p>
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
            <p className="panel-copy">
              {pkg ? `${pkg.assetCount} assets indexed through ${pkg.source}.` : 'No package indexed yet.'}
            </p>
          </div>
          <input
            className="search-input"
            type="search"
            placeholder="Filter by path or GUID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="asset-list" role="table" aria-label="Indexed assets">
          <div className="asset-row asset-row-head" role="row">
            <span>Unity path</span>
            <span>Size</span>
            <span>Meta</span>
            <span>Safety</span>
            <span>Action</span>
          </div>

          {visibleAssets.map((asset) => (
            <div className="asset-row" role="row" key={asset.assetId}>
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

          {pkg && visibleAssets.length === 0 ? <p className="empty-state">No assets matched the current filter.</p> : null}
        </div>
      </section>
    </main>
  )
}

export default App
