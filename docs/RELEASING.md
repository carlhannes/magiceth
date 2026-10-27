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

## 4. Try one before publishing

Open `dist/magiceth-X.Y.Z-arm64.dmg`, drag nothing, right-click the app → Open (it is unsigned).
The topbar shows the new version; each mode opens; Configure mode lists the built-in plugin. A
build that fails this is not published, whatever the checks said.

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
