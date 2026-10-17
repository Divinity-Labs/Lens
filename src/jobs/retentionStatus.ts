import { snapshot_retention_path } from '../metrics'

export type RetentionPath = 'starting' | 'redis_queue' | 'in_process'

let activePath: RetentionPath = 'starting'

export function setRetentionPath(path: RetentionPath): void {
  if (path === activePath) return
  activePath = path
  for (const label of ['starting', 'redis_queue', 'in_process'] as const) {
    snapshot_retention_path.set({ path: label }, label === path ? 1 : 0)
  }
  console.info(JSON.stringify({ level: 'info', event: 'snapshot_retention_path_changed', path }))
}

export function getRetentionPath(): RetentionPath {
  return activePath
}
