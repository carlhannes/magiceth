import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { listDongles } from './capabilities/adapters'
import { runDiagnostics } from './capabilities/diagnostics'
import { startSurvey, stopSurvey } from './capabilities/survey'
import { applyProfile, rollMac, undo } from './capabilities/reconfig'
import {
  deleteProfile,
  loadProfiles,
  saveCurrentAsProfile,
  saveProfile
} from './capabilities/profiles'
import { getPlatform } from './platform'
import type { Dongle, Profile, ReconfigResult } from '../shared/types'

// The hotplug probe: a signature over os.networkInterfaces() (platform-independent, no
// privileges, cheap enough to poll) that changes when a dongle is plugged/unplugged or link
// comes up/down. Main-process only — it never crosses IPC; the renderer gets Dongle[] instead.
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
    height: 820,
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

/** Identity of the connected dongles, for spotting appear/disappear between full scans. */
function dongleSignature(dongles: Dongle[]): string {
  return dongles
    .map((d) => `${d.device}:${d.mac}`)
    .sort()
    .join(';')
}

// Simple poll (KISS) — no native udev/event hook in V1. The cheap interface signature is polled
// often, so link-up and address changes are picked up quickly; the heavier dongle enumeration
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
      const dongles = await listDongles()
      const key = dongleSignature(dongles)
      // On a full scan with nothing new there is nothing to tell the renderer. When the interface
      // signature moved we always push, because that is what re-runs diagnostics.
      if (!interfacesChanged && key === lastDongles) return
      lastDongles = key
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('dongles:changed', dongles)
      }
    } finally {
      scanning = false
    }
  }

  setInterval(() => {
    pollOnce().catch((e) => console.error('hotplug poll failed:', e))
  }, POLL_MS)
}

app.whenReady().then(() => {
  ipcMain.handle('dongles:list', () => listDongles())
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

  // Profiles
  ipcMain.handle('profiles:list', () => loadProfiles())
  ipcMain.handle('profiles:saveCurrent', async (_event, device: string, name: string) => {
    const net = await getPlatform().readNetInfo(device)
    return saveCurrentAsProfile(name, net)
  })
  ipcMain.handle('profiles:delete', (_event, id: string) => deleteProfile(id))
  ipcMain.handle('profiles:save', (_event, profile: Profile) => saveProfile(profile))

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

// Quitting mid-capture must not orphan a root tcpdump. The script has a hard cap as a backstop,
// but stopping it here means the process is gone the moment the window is.
app.on('before-quit', () => {
  stopSurvey()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
