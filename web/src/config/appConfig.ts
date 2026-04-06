export type IndexingMode = 'user-choice' | 'size-based'

export interface AppConfig {
  indexingMode: IndexingMode
  automaticBackendThresholdBytes: number
}

export const appConfig: AppConfig = {
  indexingMode: 'size-based',
  automaticBackendThresholdBytes: 512 * 1024 * 1024,
}