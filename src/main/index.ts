import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { listAdapters } from './capabilities/adapters'
import { installSetup, setupStatus } from './capabilities/setup'
import { runDiagnostics } from './capabilities/diagnostics'
import { startSurvey, stopSurvey } from './capabilities/survey'
import { startSpeedTest, stopSpeedTest } from './capabilities/speedtest'
import {
  enableWifiAccess,
  endWifiSession,
  pinMonitor,
  startMonitor,
  startWifiScan,
  stopMonitor,
  stopWifiScan
} from './capabilities/wifiscan'
import { listRecordings, readRecording, revealRecording } from './capabilities/recordings'
import { applyProfile, rollMac, undo } from './capabilities/reconfig'
import {
  deleteProfile,
  loadProfiles,
  saveCurrentAsProfile,
  saveProfile
} from './capabilities/profiles'
import {
  activatePlugin,
  deactivatePlugin,
  listPlugins,
  onPluginScreen,
  pluginKey,
  pluginSubmit
} from './plugins/loader'
import { getPlatform } from './platform'
import type { Adapter, Profile, ReconfigResult } from '../shared/types'
import type { KeyPress } from '../shared/plugin'

// The hotplug probe: a signature over os.networkInterfaces() (platform-independent, no
// privileges, cheap enough to poll) that changes when a dongle is plugged/unplugged or link
// comes up/down. Main-process only — it never crosses IPC; the renderer gets Adapter[] instead.
function interfaceSignature(): string {
  return Object.entries(os.networkInterfaces())
    .map(([name, addrs]) => {
      const addresses = (addrs ?? []).map((a) => `${a.family}:${a.address}`).join(',')
      return `${name}|${addresses}`
    })
    .sort()
    .join(';')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    // Tall enough for a port's whole readout, but never taller than the screen: on an 11.6" laptop
    // the work area is under 800 px and a window that overruns it hides the key legend.
    height: Math.min(820, screen.getPrimaryDisplay().workAreaSize.height),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

const POLL_MS = 1500
// os.networkInterfaces() only reports interfaces that have an address, so a dongle plugged in
// without a network cable is invisible to interfaceSignature() — and so is its removal. Re-run
// the real enumeration every few ticks to catch those. It is cheap enough to afford: measured on
// macOS, ioreg is ~10 ms and networksetup ~20 ms, and they run in parallel.
const FULL_SCAN_EVERY = 3 // ≈ every 4.5 s

/** Identity of the connected adapters, for spotting appear/disappear between full scans. */
function adapterSignature(adapters: Adapter[]): string {
  return adapters
    .map((d) => `${d.device}:${d.mac}`)
    .sort()
    .join(';')
}

// Simple poll (KISS) — no native udev/event hook in V1. The cheap interface signature is polled
// often, so link-up and address changes are picked up quickly; the heavier adapter enumeration
// runs when that signature moves, and otherwise on the slower full-scan cadence above.
function startHotplugPolling(): void {
  let lastInterfaces = ''
  let lastDongles = ''
  let tick = 0
  let scanning = false

  const pollOnce = async (): Promise<void> => {
    const dueForFullScan = tick++ % FULL_SCAN_EVERY === 0
    const sig = interfaceSignature()
    const interfacesChanged = sig !== lastInterfaces
    if (!interfacesChanged && !dueForFullScan) return
    // A slow scan must not overlap the next tick and write lastDongles out of order.
    if (scanning) return

    scanning = true
    try {
      lastInterfaces = sig
      const adapters = await listAdapters()
      const key = adapterSignature(adapters)
      // On a full scan with nothing new there is nothing to tell the renderer. When the interface
      // signature moved we always push, because that is what re-runs diagnostics.
      if (!interfacesChanged && key === lastDongles) return
      lastDongles = key
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('adapters:changed', adapters)
      }
    } finally {
      scanning = false
    }
  }

  setInterval(() => {
    pollOnce().catch((e) => console.error('hotplug poll failed:', e))
  }, POLL_MS)
}

// On Linux, run as a native Wayland client where there is a Wayland session (X11 otherwise), and
// speak the text-input protocol: that is what makes GNOME's on-screen keyboard appear when a form
// field takes focus on a touch screen. Must be set before the app is ready.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  app.commandLine.appendSwitch('enable-wayland-ime')
  app.commandLine.appendSwitch('wayland-text-input-version', '3')
}

app.whenReady().then(() => {
  // The start screen's setup card. Status is a few PATH lookups (and one `sudo -n` on Linux);
  // install runs the package manager or writes the admin rule, through the elevated path.
  ipcMain.handle('setup:status', () => setupStatus())
  ipcMain.handle('setup:install', (_event, ids: string[]) => installSetup(ids))
  ipcMain.handle('adapters:list', () => listAdapters())
  ipcMain.handle('diagnostics:run', (_event, device: string) => runDiagnostics(device))
  // The survey runs until stopped, pushing partial results as they accumulate.
  ipcMain.handle('survey:start', (_event, device: string) =>
    startSurvey(device, (result) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('survey:update', result)
      }
    })
  )
  ipcMain.handle('survey:stop', () => stopSurvey())

  // The speed test moves real traffic, so it only ever runs on a keypress. Same push shape as the
  // survey: partial results arrive while it runs, both directions in turn.
  ipcMain.handle('speedtest:start', (_event, device: string) =>
    startSpeedTest(device, (result) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('speedtest:update', result)
      }
    })
  )
  ipcMain.handle('speedtest:stop', () => stopSpeedTest())

  // Scanning moves the radio off-channel, so a recording only ever runs on a keypress. Same push
  // shape as the survey: partial results arrive while it runs.
  ipcMain.handle('wifi:start', (_event, device: string, mode: 'once' | 'record') =>
    startWifiScan(device, mode, (result) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('wifi:update', result)
      }
    })
  )
  ipcMain.handle('wifi:stop', () => stopWifiScan())
  // Listening disconnects Wi-Fi and asks for admin; the renderer confirms before it asks. Updates
  // arrive on the same channel as the scan's.
  ipcMain.handle('wifi:monitor:start', (_event, device: string) =>
    startMonitor(device, (result) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('wifi:update', result)
      }
    })
  )
  ipcMain.handle('wifi:monitor:stop', () => stopMonitor())
  ipcMain.handle('wifi:monitor:pin', (_event, bssid: string | null) => pinMonitor(bssid))
  // Privileged and opt-in (UAC on Windows): the renderer asks for a confirming second press first.
  ipcMain.handle('wifi:enableAccess', () => enableWifiAccess())

  // Recordings the scanner has written to ~/Documents/magiceth. Reads are cheap and the ids are
  // validated against the filename pattern in the capability, so a bad id cannot escape the folder.
  ipcMain.handle('recordings:list', () => listRecordings())
  ipcMain.handle('recordings:read', (_event, id: string) => readRecording(id))
  ipcMain.handle('recordings:reveal', (_event, id: string) => revealRecording(id))

  // Profiles
  ipcMain.handle('profiles:list', () => loadProfiles())
  ipcMain.handle('profiles:saveCurrent', async (_event, device: string, name: string) => {
    const net = await getPlatform().readNetInfo(device)
    return saveCurrentAsProfile(name, net)
  })
  ipcMain.handle('profiles:delete', (_event, id: string) => deleteProfile(id))
  ipcMain.handle('profiles:save', (_event, profile: Profile) => saveProfile(profile))

  // Configure mode. Listing reads manifests only; code runs from `plugins:activate` on, and every
  // re-render the active plugin asks for is pushed as a whole screen.
  onPluginScreen((screen) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('plugins:view', screen)
    }
  })
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:activate', (_event, id: string, device: string) =>
    activatePlugin(id, device)
  )
  ipcMain.handle('plugins:deactivate', () => deactivatePlugin())
  ipcMain.handle('plugins:key', (_event, key: KeyPress) => pluginKey(key))
  ipcMain.handle('plugins:submit', (_event, formId: string, values: Record<string, string>) =>
    pluginSubmit(formId, values)
  )

  // Active control (privileged)
  ipcMain.handle('reconfig:rollMac', (_event, device: string) => rollMac(device))
  ipcMain.handle('reconfig:undo', (_event, device: string) => undo(device))
  ipcMain.handle(
    'reconfig:applyProfile',
    (_event, device: string, profileId: string): Promise<ReconfigResult> => {
      const profile = loadProfiles().find((p) => p.id === profileId)
      if (!profile) return Promise.resolve({ ok: false, message: 'Profile not found.' })
      return applyProfile(device, profile)
    }
  )

  createWindow()
  startHotplugPolling()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quitting mid-run must not orphan a root tcpdump or a curl saturating someone's uplink. Both
// have their own hard caps as a backstop, but stopping them here means the processes are gone the
// moment the window is.
app.on('before-quit', () => {
  stopSurvey()
  stopSpeedTest()
  // Listening first: its stop file is what makes the root script put the Wi-Fi back.
  stopMonitor()
  stopWifiScan()
  endWifiSession()
  // The parts that matter — the address-hold stop file and the DHCP socket — go before its first
  // await, so not awaiting here loses nothing.
  void deactivatePlugin()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
