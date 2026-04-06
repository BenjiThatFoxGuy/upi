/// <reference lib="webworker" />

import { gunzipSync, strFromU8 } from 'fflate'

import type { IndexedPackage, PackageAsset, WorkerRequest, WorkerResponse } from '../types/unitypackage'

type WorkerAssetRecord = PackageAsset & { filename: string; bytes: Uint8Array }

const workerScope = self as DedicatedWorkerGlobalScope
const packageCache = new Map<string, WorkerAssetRecord>()

const textDecoder = new TextDecoder('utf-8')

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

function buildIndexedPackage(fileName: string, entries: Map<string, Uint8Array>): IndexedPackage {
  packageCache.clear()
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
    })
  }

  assets.sort((left, right) => left.pathname.localeCompare(right.pathname))
  return {
    packageName: fileName,
    assetCount: assets.length,
    assets,
    source: 'local',
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const payload = event.data

  if (payload.type === 'reset') {
    packageCache.clear()
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

  try {
    postMessageToClient({ type: 'status', message: 'Reading package bytes from disk.', progress: 10 })
    const compressedBytes = new Uint8Array(await payload.file.arrayBuffer())
    postMessageToClient({ type: 'status', message: 'Decompressing gzip payload locally.', progress: 45 })
    const archiveBytes = gunzipSync(compressedBytes)
    postMessageToClient({ type: 'status', message: 'Parsing tar entries and building the asset index.', progress: 80 })
    const pkg = buildIndexedPackage(payload.file.name, parseTarArchive(archiveBytes))
    postMessageToClient({ type: 'indexed', pkg })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to index the selected unitypackage.'
    postMessageToClient({ type: 'error', message })
  }
}
