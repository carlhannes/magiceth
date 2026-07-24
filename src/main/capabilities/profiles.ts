import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NetInfo, Profile } from '../../shared/types'
import {
  ensureDefaults,
  parseProfiles,
  profileFromNetInfo,
  removeProfile,
  serializeProfiles,
  upsertProfile
} from './profiles-core'

// Electron/fs glue around the pure profile operations. Stored in a single JSON file in userData
// (single source of truth). No cloud sync or encryption (internal tool, KISS).

function profilesPath(): string {
  return join(app.getPath('userData'), 'profiles.json')
}

export function loadProfiles(): Profile[] {
  try {
    return parseProfiles(readFileSync(profilesPath(), 'utf8'))
  } catch {
    return ensureDefaults([])
  }
}

function persist(list: Profile[]): Profile[] {
  const withDefaults = ensureDefaults(list)
  writeFileSync(profilesPath(), serializeProfiles(withDefaults), 'utf8')
  return withDefaults
}

export function saveCurrentAsProfile(name: string, net: NetInfo): Profile[] {
  const id = `p-${Date.now().toString(36)}`
  return persist(upsertProfile(loadProfiles(), profileFromNetInfo(id, name, net)))
}

/** Create (if id is missing) or update a profile with custom values. */
export function saveProfile(profile: Profile): Profile[] {
  const withId = profile.id ? profile : { ...profile, id: `p-${Date.now().toString(36)}` }
  return persist(upsertProfile(loadProfiles(), withId))
}

export function deleteProfile(id: string): Profile[] {
  return persist(removeProfile(loadProfiles(), id))
}
