import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { listDongles } from './capabilities/adapters'
import { runDiagnostics } from './capabilities/diagnostics'
import { discover } from './capabilities/discover'
import { applyProfile, rollMac, undo } from './capabilities/reconfig'
import {
  deleteProfile,
  loadProfiles,
  saveCurrentAsProfile,
  saveProfile
} from './capabilities/profiles'
import { getPlatform } from './platform'
import type { Profile, ReconfigResult } from '../shared/types'

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

// Simple poll (KISS) — no native udev/event hook in V1. The cheap interface signature
// is polled often; the heavier dongle enumeration (spawns commands) runs only when something
// has actually changed.
function startHotplugPolling(): void {
  let last = ''
  const pollOnce = async (): Promise<void> => {
    const sig = interfaceSignature()
    if (sig === last) return
    last = sig
    const dongles = await listDongles()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('dongles:changed', dongles)
    }
  }
  setInterval(() => {
    pollOnce().catch((e) => console.error('hotplug poll failed:', e))
  }, 1500)
}

app.whenReady().then(() => {
  ipcMain.handle('dongles:list', () => listDongles())
  ipcMain.handle('diagnostics:run', (_event, device: string) => runDiagnostics(device))
  ipcMain.handle('discover:run', (_event, device: string) => discover(device))

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
