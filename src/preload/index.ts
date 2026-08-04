import { contextBridge, ipcRenderer } from 'electron'
import type {
  Diagnostics,
  Dongle,
  MagicethApi,
  Profile,
  ReconfigResult,
  SurveyResult
} from '../shared/types'

// Exposes a small, typed API on window.api. contextIsolation is on and the renderer
// never gets direct access to Node/Electron — only these methods.
const api: MagicethApi = {
  listDongles: () => ipcRenderer.invoke('dongles:list'),
  onDonglesChanged: (cb: (dongles: Dongle[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Dongle[]): void => cb(data)
    ipcRenderer.on('dongles:changed', listener)
    return () => ipcRenderer.removeListener('dongles:changed', listener)
  },
  runDiagnostics: (device: string): Promise<Diagnostics> =>
    ipcRenderer.invoke('diagnostics:run', device),
  startSurvey: (device: string): Promise<SurveyResult> =>
    ipcRenderer.invoke('survey:start', device),
  stopSurvey: (): Promise<SurveyResult | null> => ipcRenderer.invoke('survey:stop'),
  onSurveyUpdate: (cb: (result: SurveyResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SurveyResult): void => cb(data)
    ipcRenderer.on('survey:update', listener)
    return () => ipcRenderer.removeListener('survey:update', listener)
  },
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
