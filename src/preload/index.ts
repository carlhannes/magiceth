import { contextBridge, ipcRenderer } from 'electron'
import type {
  Diagnostics,
  DiscoveryResult,
  Dongle,
  MagicethApi,
  Profile,
  ReconfigResult,
  SystemSnapshot
} from '../shared/types'

// Exposes a small, typed API on window.api. contextIsolation is on and the renderer
// never gets direct access to Node/Electron — only these methods.
const api: MagicethApi = {
  snapshot: () => ipcRenderer.invoke('system:snapshot'),
  onAdaptersChanged: (cb: (snapshot: SystemSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SystemSnapshot): void => cb(data)
    ipcRenderer.on('adapters:changed', listener)
    return () => ipcRenderer.removeListener('adapters:changed', listener)
  },
  listDongles: () => ipcRenderer.invoke('dongles:list'),
  onDonglesChanged: (cb: (dongles: Dongle[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Dongle[]): void => cb(data)
    ipcRenderer.on('dongles:changed', listener)
    return () => ipcRenderer.removeListener('dongles:changed', listener)
  },
  runDiagnostics: (device: string): Promise<Diagnostics> =>
    ipcRenderer.invoke('diagnostics:run', device),
  discover: (device: string): Promise<DiscoveryResult> =>
    ipcRenderer.invoke('discover:run', device),
  rollMac: (device: string): Promise<ReconfigResult> =>
    ipcRenderer.invoke('reconfig:rollMac', device),
  applyProfile: (device: string, profileId: string): Promise<ReconfigResult> =>
    ipcRenderer.invoke('reconfig:applyProfile', device, profileId),
  undo: (device: string): Promise<ReconfigResult> => ipcRenderer.invoke('reconfig:undo', device),
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),
  saveCurrentAsProfile: (device: string, name: string): Promise<Profile[]> =>
    ipcRenderer.invoke('profiles:saveCurrent', device, name),
  deleteProfile: (id: string): Promise<Profile[]> => ipcRenderer.invoke('profiles:delete', id),
  saveProfile: (profile: Profile): Promise<Profile[]> =>
    ipcRenderer.invoke('profiles:save', profile)
}

contextBridge.exposeInMainWorld('api', api)
