import { contextBridge, ipcRenderer } from 'electron'
import type {
  Diagnostics,
  Adapter,
  MagicethApi,
  Profile,
  ReconfigResult,
  SpeedTestResult,
  SurveyResult,
  WifiAccessResult,
  WifiScanResult,
  RecordingSummary,
  SavedRecording
} from '../shared/types'
import type { KeyPress, PluginActivation, PluginManifest, PluginScreen } from '../shared/plugin'

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
  enableWifiAccess: (): Promise<WifiAccessResult> => ipcRenderer.invoke('wifi:enableAccess'),
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
    ipcRenderer.invoke('profiles:save', profile),
  listPlugins: (): Promise<PluginManifest[]> => ipcRenderer.invoke('plugins:list'),
  activatePlugin: (id: string, device: string): Promise<PluginActivation> =>
    ipcRenderer.invoke('plugins:activate', id, device),
  deactivatePlugin: (): Promise<void> => ipcRenderer.invoke('plugins:deactivate'),
  sendPluginKey: (key: KeyPress): Promise<void> => ipcRenderer.invoke('plugins:key', key),
  submitPluginForm: (formId: string, values: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke('plugins:submit', formId, values),
  onPluginView: (cb: (screen: PluginScreen) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: PluginScreen): void => cb(data)
    ipcRenderer.on('plugins:view', listener)
    return () => ipcRenderer.removeListener('plugins:view', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
