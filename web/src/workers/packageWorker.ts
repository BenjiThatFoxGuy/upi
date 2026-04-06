/// <reference lib="webworker" />

import { gunzipSync, strFromU8, zipSync } from 'fflate'
import { sha256 } from 'js-sha256'
import SparkMD5 from 'spark-md5'

import type { IndexedPackage, PackageAsset, PackageFingerprint, PackageIdentity, WorkerRequest, WorkerResponse } from '../types/unitypackage'

type WorkerAssetRecord = PackageAsset & { filename: string; bytes: Uint8Array; metaBytes?: Uint8Array }

const workerScope = self as DedicatedWorkerGlobalScope
const packageCache = new Map<string, WorkerAssetRecord>()
let currentPackageName = 'package.unitypackage'

const textDecoder = new TextDecoder('utf-8')
const textEncoder = new TextEncoder()

function postMessageToClient(message: WorkerResponse, transfer?: Transferable[]) {
  workerScope.postMessage(message, transfer ? { transfer } : undefined)
}

function parseOctal(value: string) {
  const trimmed = value.replace(/\0/g, '').trim()
  return trimmed ? Number.parseInt(trimmed, 8) : 0
}

function isSafeUnityPath(pathname: string) {
  if (pathname.startsWith('/') || pathname.startsWith('\\')) {
    return false
  }

  const parts = pathname.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..')
}

function sanitizeZipSegment(segment: string) {
  return segment.replace(/[<>:"|?*]/g, '_').trim() || 'unnamed'
}

function buildZipEntryPath(asset: WorkerAssetRecord, includeMeta = false) {
  const normalizedPath = asset.pathname.replace(/\\/g, '/').split('/').filter(Boolean).map(sanitizeZipSegment).join('/')
  if (asset.safePath && normalizedPath) {
    return includeMeta ? `${normalizedPath}.meta` : normalizedPath
  }

  const fallbackName = sanitizeZipSegment(asset.filename)
  const flaggedPath = `_flagged/${sanitizeZipSegment(asset.guid)}/${fallbackName}`
  return includeMeta ? `${flaggedPath}.meta` : flaggedPath
}

function buildZipFilename(packageName: string) {
  return packageName.toLowerCase().endsWith('.unitypackage')
    ? `${packageName.slice(0, -'.unitypackage'.length)}.zip`
    : `${packageName}.zip`
}

async function sha256Hex(bytes: Uint8Array) {
  return sha256(bytes)
}

function md5Hex(bytes: Uint8Array) {
  return SparkMD5.ArrayBuffer.hash(Uint8Array.from(bytes).buffer)
}

async function sha256TextHex(value: string) {
  return sha256Hex(textEncoder.encode(value))
}

function createPendingIdentity(): PackageIdentity {
  return {
    lookupStatus: 'pending',
    recognitionStatus: 'unknown',
    matchType: 'none',
    sourceLinks: [],
    message: 'Package identity will be checked when the backend can reach the catalog.',
  }
}

function parseTarArchive(bytes: Uint8Array) {
  const entries = new Map<string, Uint8Array>()
  let offset = 0

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    const emptyHeader = header.every((byte) => byte === 0)
    if (emptyHeader) {
      break
    }

    const name = strFromU8(header.subarray(0, 100)).replace(/\0.*$/, '')
    const size = parseOctal(strFromU8(header.subarray(124, 136)))
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    entries.set(name, bytes.slice(dataStart, dataEnd))

    const paddedSize = Math.ceil(size / 512) * 512
    offset = dataStart + paddedSize
  }

  return entries
}

async function buildIndexedPackage(fileName: string, archiveMd5: string, archiveSha256: string, entries: Map<string, Uint8Array>): Promise<IndexedPackage> {
  packageCache.clear()
  currentPackageName = fileName
  const grouped = new Map<string, Partial<Record<'pathname' | 'asset' | 'asset.meta', Uint8Array>>>()

  for (const [name, data] of entries.entries()) {
    const divider = name.indexOf('/')
    if (divider === -1) {
      continue
    }

    const guid = name.slice(0, divider)
    const leaf = name.slice(divider + 1)
    const current = grouped.get(guid) ?? {}
    if (leaf === 'pathname' || leaf === 'asset' || leaf === 'asset.meta') {
      current[leaf] = data
      grouped.set(guid, current)
    }
  }

  const assets: PackageAsset[] = []
  for (const [guid, groupedAsset] of grouped.entries()) {
    const pathnameBytes = groupedAsset.pathname
    const assetBytes = groupedAsset.asset
    if (!pathnameBytes || !assetBytes) {
      continue
    }

    const pathname = textDecoder.decode(pathnameBytes).trim()
    const filename = pathname.split(/[\\/]/).filter(Boolean).at(-1) ?? `${guid}.bin`
    const assetId = `${guid}:${pathname}`
    const safePath = isSafeUnityPath(pathname)
    const asset: PackageAsset = {
      assetId,
      guid,
      pathname,
      size: assetBytes.byteLength,
      hasMeta: Boolean(groupedAsset['asset.meta']),
      safePath,
    }

    assets.push(asset)
    packageCache.set(assetId, {
      ...asset,
      filename,
      bytes: assetBytes,
      metaBytes: groupedAsset['asset.meta'],
    })
  }

  assets.sort((left, right) => left.pathname.localeCompare(right.pathname))
  const guidSample = Array.from(new Set(assets.map((asset) => asset.guid))).sort()
  const fingerprint: PackageFingerprint = {
    md5: archiveMd5,
    sha256: archiveSha256,
    guidFingerprint: await sha256TextHex(guidSample.join('\n')),
    guidCount: guidSample.length,
    guidValues: guidSample,
    guidSample: guidSample.slice(0, 32),
    assetCount: assets.length,
    safeAssetCount: assets.filter((asset) => asset.safePath).length,
    unsafeAssetCount: assets.filter((asset) => !asset.safePath).length,
  }

  return {
    packageName: fileName,
    assetCount: assets.length,
    assets,
    fingerprint,
    identity: createPendingIdentity(),
    source: 'local',
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const payload = event.data

  if (payload.type === 'reset') {
    packageCache.clear()
    currentPackageName = 'package.unitypackage'
    return
  }

  if (payload.type === 'download-asset') {
    const asset = packageCache.get(payload.assetId)
    if (!asset) {
      postMessageToClient({ type: 'error', message: 'Asset is no longer available in local worker memory.' })
      return
    }

    const buffer = asset.bytes.slice().buffer
    postMessageToClient(
      {
        type: 'downloaded',
        assetId: asset.assetId,
        filename: asset.filename,
        bytes: buffer,
      },
      [buffer],
    )
    return
  }

  if (payload.type === 'download-package-zip') {
    if (packageCache.size === 0) {
      postMessageToClient({ type: 'error', message: 'Package ZIP is no longer available in local worker memory.' })
      return
    }

    postMessageToClient({ type: 'status', message: 'Building ZIP archive in local worker memory.', progress: 92 })
    const zipEntries: Record<string, Uint8Array> = {}

    for (const asset of packageCache.values()) {
      zipEntries[buildZipEntryPath(asset)] = asset.bytes.slice()
      if (asset.metaBytes) {
        zipEntries[buildZipEntryPath(asset, true)] = asset.metaBytes.slice()
      }
    }

    const bytes = zipSync(zipEntries, { level: 0 })
    const buffer = Uint8Array.from(bytes).buffer
    postMessageToClient(
      {
        type: 'zipped',
        filename: buildZipFilename(currentPackageName),
        bytes: buffer,
      },
      [buffer],
    )
    return
  }

  if (payload.type === 'preview-asset') {
    const asset = packageCache.get(payload.assetId)
    if (!asset) {
      postMessageToClient({ type: 'error', message: 'Asset preview is no longer available in local worker memory.' })
      return
    }

    const buffer = asset.bytes.slice().buffer
    postMessageToClient(
      {
        type: 'previewed',
        assetId: asset.assetId,
        filename: asset.filename,
        bytes: buffer,
      },
      [buffer],
    )
    return
  }

  try {
    postMessageToClient({ type: 'status', message: 'Reading package bytes from disk.', progress: 10 })
    const compressedBytes = new Uint8Array(await payload.file.arrayBuffer())
    const archiveMd5 = md5Hex(compressedBytes)
    const archiveSha256 = await sha256Hex(compressedBytes)
    postMessageToClient({ type: 'status', message: 'Decompressing gzip payload locally.', progress: 45 })
    const archiveBytes = gunzipSync(compressedBytes)
    postMessageToClient({ type: 'status', message: 'Parsing tar entries and building the asset index.', progress: 80 })
    const pkg = await buildIndexedPackage(payload.file.name, archiveMd5, archiveSha256, parseTarArchive(archiveBytes))
    postMessageToClient({ type: 'indexed', pkg })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to index the selected unitypackage.'
    postMessageToClient({ type: 'error', message })
  }
}
