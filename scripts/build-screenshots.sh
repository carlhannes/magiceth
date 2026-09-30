#!/bin/sh
# Builds the side-by-side figures the README embeds, from the individual screenshots in
# docs/shots. Run after re-taking any of them:
#
#   sh scripts/build-screenshots.sh
#
# The individual shots stay the source of truth so one half can be replaced without redoing its
# partner — which matters, because the Ethernet ones need a dongle and a live port to reproduce
# while the Wi-Fi ones can be captured any time.
#
# Pairs are like with like on purpose: the Ethernet shots still carry a window title bar and the
# Wi-Fi ones do not, and mixing the two in one figure looks like a mistake.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
shots="$here/../docs/shots"
out="$here/../docs"

command -v magick >/dev/null 2>&1 || {
  echo "build-screenshots: needs ImageMagick (brew install imagemagick)." >&2
  exit 1
}

# The app's own background, so the padding under the shorter of a pair is invisible.
bg='#0f1216'

pair() {
  name=$1 left=$2 right=$3
  if [ ! -f "$shots/$left" ] || [ ! -f "$shots/$right" ]; then
    echo "  skipping $name — missing $left or $right" >&2
    return 0
  fi
  magick "$shots/$left" \( "$shots/$right" -background "$bg" -splice 36x0 \) \
    -background "$bg" -gravity north +append \
    -bordercolor "$bg" -border 24 "$out/$name"
  echo "  $name"
}

pair figure-ethernet.png screenshot.png screenshot-vlan.png
pair figure-ethernet-panels.png screenshot-chipset.png screenshot-profiles.png
pair figure-wlan-scan.png screenshot-wlan.png screenshot-wlan-aps.png
pair figure-wlan-spectrum.png screenshot-wlan-channels.png screenshot-wlan-buckets.png
pair figure-wlan-detail.png screenshot-wlan-ap.png screenshot-wlan-saved.png
