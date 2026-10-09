#!/bin/sh
# Builds the macOS Wi-Fi helper: a minimal .app bundle wrapping a Swift binary.
#
# The bundle is not packaging neatness. macOS only offers a Location Services grant to a process
# with a CFBundleIdentifier and an NSLocationWhenInUseUsageDescription, and without that grant
# CoreWLAN hides every BSSID and every beacon information element. A bare executable cannot even
# raise the prompt.
#
# macOS only. Not part of `npm run build` or CI (which runs on Linux and never packages) — run it
# before `npm run dev` or `npm run package` on a Mac.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src="$here/../resources/wifi-helper"
out="$src/build"
app="$out/magiceth-wifi.app"

[ "$(uname -s)" = "Darwin" ] || { echo "build-wifi-helper: macOS only, skipping." >&2; exit 0; }
command -v swiftc >/dev/null 2>&1 || { echo "build-wifi-helper: swiftc not found (install Xcode command line tools)." >&2; exit 1; }

rm -rf "$out"
mkdir -p "$app/Contents/MacOS"
cp "$src/Info.plist" "$app/Contents/Info.plist"

# Both slices: electron-builder targets arm64 and x64 for macOS, and a helper that is missing the
# running machine's architecture fails at exec time rather than at build time.
swiftc -O -target arm64-apple-macos13 -o "$out/magiceth-wifi-arm64" "$src/main.swift"
swiftc -O -target x86_64-apple-macos13 -o "$out/magiceth-wifi-x64" "$src/main.swift"
lipo -create "$out/magiceth-wifi-arm64" "$out/magiceth-wifi-x64" -output "$app/Contents/MacOS/magiceth-wifi"
rm -f "$out/magiceth-wifi-arm64" "$out/magiceth-wifi-x64"

# Ad-hoc signature. TCC keys a Location grant to the code signature, so an unsigned bundle would be
# re-prompted far more aggressively. The outer app is deliberately unsigned (identity: null), which
# does not prevent signing this one.
codesign --force --sign - "$app"

echo "built $app"
lipo -archs "$app/Contents/MacOS/magiceth-wifi"
