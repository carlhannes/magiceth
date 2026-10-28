# Releasing

How a version of magiceth goes from `main` to the four files on the
[Releases](https://github.com/carlhannes/magiceth/releases) page. There is no release automation:
CI runs the checks, a person (or an agent on their Mac) builds, and a person publishes. The whole
thing takes about half an hour, most of it electron-builder.

The artifacts, the commands that build them and why all four build on a Mac are in the README's
"Building & packaging" section; this page is the order of operations around that.

## Before you start

- A Mac with the Xcode command line tools (`swiftc` builds the Wi-Fi helper), Rosetta
  (`softwareupdate --install-rosetta`, for the Windows build), and a clean checkout of `main`
  with CI green.
- Everything that should be in the release is merged, and every change is listed under
  `Unreleased` in `CHANGELOG.md`.
- Anything the release depends on having been verified on hardware is recorded as such in the
  CHANGELOG and README. Nothing is described as tested that was not.

## 1. Pick the version

Pre-1.0 semantic versioning, as the CHANGELOG says: a new mode, a new capability or a change to
the plugin API bumps the minor version; fixes alone bump the patch. The plugin API has its own
version (`PLUGIN_API` in `src/shared/plugin.ts`), which only changes when `docs/PLUGINS.md` says
it must.

## 2. The release commit, on a branch

`main` takes no direct commits, so:

```sh
git switch -c chore/release-X.Y.Z main
npm version X.Y.Z --no-git-tag-version      # package.json and package-lock.json
```

In `CHANGELOG.md`: rename `## [Unreleased]` to `## [X.Y.Z] – YYYY-MM-DD`, add a fresh empty
`## [Unreleased]` above it, and in the link list at the bottom point `[Unreleased]` at
`compare/vX.Y.Z...HEAD` and add `[X.Y.Z]: …/compare/vPREVIOUS...vX.Y.Z`. Check the README for
anything the release changes about what is published or verified.

Then the gate, the commit, and a pull request:

```sh
npm run typecheck && npm run lint && npm test && npx prettier --check .
git commit -am "chore(release): X.Y.Z"
git push -u origin chore/release-X.Y.Z
```

Merge it. The tag goes on the merge commit:

```sh
git switch main && git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

## 3. Build the four files

On the release commit (the merged `main`, or the release branch — same tree):

```sh
npm ci
npm run package -- --mac     # magiceth-X.Y.Z-arm64.dmg and magiceth-X.Y.Z.dmg
npm run package -- --win     # magiceth Setup X.Y.Z.exe and magiceth-X.Y.Z-portable.exe
```

`npm run package` builds the Wi-Fi helper first, then the app, then electron-builder. Both
Windows targets come out of the one command; a release is always both. Everything lands in
`dist/`, which is git-ignored; the `.yml` files electron-builder writes next to them are not part of
the release.

Then prove the macOS seal is complete. electron-builder ad-hoc signs the bundle as a whole; a bundle
without a complete seal is "damaged and can't be opened" for everyone who downloads it, and nothing
on the build machine notices, because a local copy carries no quarantine flag (0.5.0 and 0.6.0
shipped that way). Every line must pass for both apps, or nothing is published:

```sh
for app in dist/mac-arm64/magiceth.app dist/mac/magiceth.app; do
  codesign --verify --deep --strict "$app"     # silent = good; any message = stop
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|Signature)'   # io.github.carlhannes.magiceth, adhoc
  codesign -dv "$app/Contents/Resources/wifi-helper/magiceth-wifi.app" 2>&1 | grep '^Identifier'   # …magiceth.wifi
done
gktool scan dist/mac-arm64/magiceth.app                    # must not say "altered"
syspolicy_check distribution dist/mac-arm64/magiceth.app   # see below
```

`syspolicy_check` is written for notarization, so two of its findings are expected here: the
"Adhoc Signed App" warning and the fatal "Notary Ticket Missing". A "Codesign Error" is the one that
matters — it is what the broken 0.6.0 bundle reported. `spctl --assess` rejects every ad-hoc app and
tells you nothing here.

## 4. Try one before publishing, the way a download arrives

A locally built app skips Gatekeeper, so give a copy of the dmg the quarantine flag a browser
would write, and open the app from the mounted image:

```sh
cp dist/magiceth-X.Y.Z-arm64.dmg /tmp/gk-test.dmg
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Chrome;$(uuidgen)" /tmp/gk-test.dmg
open /tmp/gk-test.dmg
```

Drag the app into Applications (the approval is stored in the file's quarantine attribute, which a
read-only image cannot hold, so from the image macOS asks every time) and open it from there.
Expected: "Apple could not verify…" → Done → System Settings → Privacy & Security → Open Anyway →
the app starts. "Damaged" means the seal is broken: stop. Then the topbar shows the new version;
each mode opens; Configure mode lists the built-in plugin; a WLAN-mode scan raises the Location
prompt (once per build — an ad-hoc signature changes every time) and shows BSSIDs afterwards. A
build that fails this is not published, whatever the checks said. Verified this way on 2026-10-28
with the first ad-hoc signed build: "Apple could not verify", Open Anyway, and the app ran.

## 5. Checksums and notes

```sh
cd dist
shasum -a 256 magiceth-X.Y.Z-arm64.dmg magiceth-X.Y.Z.dmg "magiceth Setup X.Y.Z.exe" magiceth-X.Y.Z-portable.exe > SHA256SUMS.txt
```

Release notes are one sentence on what the release is about, then the version's CHANGELOG section
verbatim. Keep them in `dist/RELEASE-NOTES-X.Y.Z.md` while publishing; the CHANGELOG is the copy
that lasts.

## 6. Publish

A GitHub release on tag `vX.Y.Z`, titled `vX.Y.Z — <what it is about>`, body from the notes file,
with five assets: the four files and `SHA256SUMS.txt`. Through the web UI ("Draft a new release",
choose the tag, drop the files in), or with the GitHub CLI:

```sh
gh release create vX.Y.Z --title "vX.Y.Z — …" --notes-file dist/RELEASE-NOTES-X.Y.Z.md \
  dist/magiceth-X.Y.Z-arm64.dmg dist/magiceth-X.Y.Z.dmg "dist/magiceth Setup X.Y.Z.exe" \
  dist/magiceth-X.Y.Z-portable.exe dist/SHA256SUMS.txt
```

Afterwards, the README's Releases link lands on it, and `main` already carries the next
`Unreleased` heading. Nothing else to bump.

## Who does what

Steps 2, 3 and 5 need nothing but a Mac and the repository, so an agent can do them and hand over
`dist/`. Merging the pull request, pushing the tag and publishing the release need the GitHub
account, and step 4 needs a person at the screen.
