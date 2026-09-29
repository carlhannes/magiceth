import { contextBridge, ipcRenderer } from 'electron'
import type {
  Diagnostics,
  Adapter,
  MagicethApi,
  Profile,
  ReconfigResult,
  SpeedTestResult,
  SurveyResult,
  WifiScanResult,
  RecordingSummary,
  SavedRecording
} from '../shared/types'

// Exposes a small, typed API on window.api. contextIsolation is on and the renderer
// never gets direct access to Node/Electron — only these methods.
const api: MagicethApi = {
  listAdapters: () => ipcRenderer.invoke('adapters:list'),
  onAdaptersChanged: (cb: (adapters: Adapter[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Adapter[]): void => cb(data)
    ipcRenderer.on('adapters:changed', listener)
    return () => ipcRenderer.removeListener('adapters:changed', listener)
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
  startSpeedTest: (device: string): Promise<SpeedTestResult> =>
    ipcRenderer.invoke('speedtest:start', device),
  stopSpeedTest: (): Promise<SpeedTestResult | null> => ipcRenderer.invoke('speedtest:stop'),
  onSpeedTestUpdate: (cb: (result: SpeedTestResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SpeedTestResult): void => cb(data)
    ipcRenderer.on('speedtest:update', listener)
    return () => ipcRenderer.removeListener('speedtest:update', listener)
  },
  rollMac: (device: string): Promise<ReconfigResult> =>
    ipcRenderer.invoke('reconfig:rollMac', device),
  applyProfile: (device: string, profileId: string): Promise<ReconfigResult> =>
    ipcRenderer.invoke('reconfig:applyProfile', device, profileId),
  undo: (device: string): Promise<ReconfigResult> => ipcRenderer.invoke('reconfig:undo', device),
  startWifiScan: (device: string, mode: 'once' | 'record'): Promise<WifiScanResult> =>
    ipcRenderer.invoke('wifi:start', device, mode),
  stopWifiScan: (): Promise<WifiScanResult | null> => ipcRenderer.invoke('wifi:stop'),
  onWifiUpdate: (cb: (result: WifiScanResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: WifiScanResult): void => cb(data)
    ipcRenderer.on('wifi:update', listener)
    return () => ipcRenderer.removeListener('wifi:update', listener)
  },
  listRecordings: (): Promise<RecordingSummary[]> => ipcRenderer.invoke('recordings:list'),
  readRecording: (id: string): Promise<SavedRecording | null> =>
    ipcRenderer.invoke('recordings:read', id),
  revealRecording: (id: string): Promise<void> => ipcRenderer.invoke('recordings:reveal', id),
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),
  saveCurrentAsProfile: (device: string, name: string): Promise<Profile[]> =>
    ipcRenderer.invoke('profiles:saveCurrent', device, name),
  deleteProfile: (id: string): Promise<Profile[]> => ipcRenderer.invoke('profiles:delete', id),
  saveProfile: (profile: Profile): Promise<Profile[]> =>
    ipcRenderer.invoke('profiles:save', profile)
}

contextBridge.exposeInMainWorld('api', api)
