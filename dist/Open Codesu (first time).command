#!/bin/bash
# Double-click this file the FIRST time you run Codesu.
# It clears the macOS "downloaded from the internet" quarantine flag that
# otherwise makes Gatekeeper say Codesu is "damaged" or from an
# "unidentified developer", then opens the app.
#
# It does NOT need admin rights and only touches Codesu.

set -e

APP="/Applications/Codesu.app"

if [ ! -d "$APP" ]; then
  echo "Codesu is not in your Applications folder yet."
  echo "Open the .dmg and drag Codesu into Applications first, then run this again."
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo "Removing the download quarantine flag from Codesu..."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Opening Codesu..."
open "$APP"

echo "Done. From now on you can just double-click Codesu normally."
sleep 1
