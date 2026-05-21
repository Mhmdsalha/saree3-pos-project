import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { invoke } from '@tauri-apps/api/core'
import type { AppPaths, LauncherConfig, LauncherMode, ServerState } from '@/types'

declare global {
  interface Window {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  }
}

export function isTauriRuntime() {
  if (typeof window === 'undefined') return false
  if (typeof window.__TAURI__ !== 'undefined') return true
  if (typeof window.__TAURI_INTERNALS__ !== 'undefined') return true
  if (typeof navigator !== 'undefined' && /tauri/i.test(navigator.userAgent)) return true
  return false
}

export async function openExternal(url: string) {
  if (isTauriRuntime()) {
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function pickLogoFile() {
  if (!isTauriRuntime()) return null
  const selected = await open({
    multiple: false,
    directory: false,
    title: 'اختيار شعار المتجر',
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico'],
      },
    ],
  })

  if (typeof selected === 'string') return selected
  if (Array.isArray(selected)) {
    return typeof selected[0] === 'string' ? selected[0] : null
  }
  return null
}

export async function getAppPaths() {
  if (!isTauriRuntime()) {
    return {
      app_data_dir: '',
      config_dir: '',
      data_dir: '',
      uploads_dir: '',
      backups_dir: '',
      database_path: '',
      logo_dir: '',
    } satisfies AppPaths
  }
  return invoke<AppPaths>('app_paths')
}

export async function getLauncherConfig() {
  if (!isTauriRuntime()) {
    return {
      mode: 'host',
      client_base_url: null,
      installation_id: 'web-dev-installation',
    } satisfies LauncherConfig
  }
  return invoke<LauncherConfig>('launcher_config')
}

export async function saveLauncherMode(mode?: LauncherMode | null) {
  if (!isTauriRuntime()) return getLauncherConfig()
  return invoke<LauncherConfig>('save_launcher_mode', { mode })
}

export async function saveClientConnection(baseUrl: string) {
  if (!isTauriRuntime()) return getLauncherConfig()
  return invoke<LauncherConfig>('save_client_connection', { baseUrl })
}

export async function resetHostStoreData() {
  if (!isTauriRuntime()) return false
  return invoke<boolean>('reset_host_store_data')
}

export async function getServerState() {
  if (!isTauriRuntime()) {
    return {
      status: 'stopped',
      port: 8000,
      url: 'https://127.0.0.1:8000/frontend-react/',
      mobile_url: 'https://127.0.0.1:8000/mobile-react/',
      pid: null,
      error: null,
    } satisfies ServerState
  }
  return invoke<ServerState>('server_status')
}

export async function startServer(port?: number) {
  if (!isTauriRuntime()) return getServerState()
  return invoke<ServerState>('start_server', { port })
}

export async function stopServer() {
  if (!isTauriRuntime()) return getServerState()
  return invoke<ServerState>('stop_server')
}

export async function restartServer(port?: number) {
  if (!isTauriRuntime()) return getServerState()
  return invoke<ServerState>('restart_server', { port })
}

export async function createBackup() {
  if (!isTauriRuntime()) return null
  return invoke<string>('create_backup')
}

export async function restoreBackup(backupPath: string) {
  if (!isTauriRuntime()) return false
  return invoke<boolean>('restore_backup', { backupPath })
}

export async function copyLogoToStoreAssets(sourcePath: string) {
  if (!isTauriRuntime()) return sourcePath
  return invoke<string>('copy_logo_to_store_assets', { sourcePath })
}

export async function saveLogoFile(file: File) {
  if (!isTauriRuntime()) return file.name
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
  return invoke<string>('save_logo_file', {
    fileName: file.name,
    bytes,
  })
}
