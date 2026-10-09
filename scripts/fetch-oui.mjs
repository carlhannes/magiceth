// Regenerates resources/oui.json from the IEEE Registration Authority's public registries.
//
// Run this by hand when the database is getting stale; the result is committed so a build needs
// no network and is reproducible. Same idea as resources/chipsets.json, which is hand-maintained
// for USB dongles — this one is too large to maintain by hand.
//
//   node scripts/fetch-oui.mjs
//
// All three tiers are fetched, not just MA-L. IEEE hands out shorter blocks to large companies
// and subdivides others, so an MA-M or MA-S address looked up against MA-L alone resolves to
// "IEEE Registration Authority" — technically true and completely useless. Lookup is
// longest-prefix, so the finer registries win where they apply.

import { writeFileSync } from 'node:fs'

const SOURCES = [
  { url: 'https://standards-oui.ieee.org/oui/oui.csv', nybbles: 6 }, // MA-L, /24
  { url: 'https://standards-oui.ieee.org/oui28/mam.csv', nybbles: 7 }, // MA-M, /28
  { url: 'https://standards-oui.ieee.org/oui36/oui36.csv', nybbles: 9 } // MA-S, /36
]

/** Minimal CSV record splitter — the registry quotes the address field, which contains commas. */
function splitCsvLine(line) {
  const out = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(field)
      field = ''
    } else field += c
  }
  out.push(field)
  return out
}

const db = {}
for (const { url, nybbles } of SOURCES) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const text = await res.text()
  let added = 0
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (line.trim() === '') continue
    const [, assignment, organization] = splitCsvLine(line)
    if (!assignment || !organization) continue
    const key = assignment.trim().toLowerCase()
    if (key.length !== nybbles) continue
    // Registered names carry trailing spaces and the odd double space. Otherwise left as
    // registered: "TP-LINK TECHNOLOGIES CO.,LTD." is what IEEE was told, so it is what we show.
    const name = organization.replace(/\s+/g, ' ').trim()
    if (name === '' || name.toLowerCase() === 'private') continue
    db[key] = name
    added++
  }
  console.log(`${url} -> ${added} assignments`)
}

// Sorted keys so regenerating produces a reviewable diff rather than a reshuffle.
const sorted = Object.fromEntries(
  Object.keys(db)
    .sort()
    .map((k) => [k, db[k]])
)
writeFileSync('resources/oui.json', JSON.stringify(sorted) + '\n', 'utf8')
console.log(`resources/oui.json -> ${Object.keys(sorted).length} entries`)
