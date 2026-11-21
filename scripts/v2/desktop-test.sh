#!/usr/bin/env bash
# Usage (on the Mac): scripts/v2/desktop-test.sh [playwright test arguments]
#   scripts/v2/desktop-test.sh                       the whole desktop suite
#   scripts/v2/desktop-test.sh tests/shell.spec.mjs  one spec
#
# Runs desktop-v2's Electron tests the only way agents may: one Electron
# instance at a time across every agent (/tmp/laytekz-electron.lock), one
# Playwright worker, ELECTRON_RUN_AS_NODE removed (an editor's terminal sets
# it, which turns Electron into plain Node). The specs launch the app in its
# hidden test mode themselves (tests/helpers.mjs). V2_DESKTOP overrides where
# desktop-v2 is.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
desk="${V2_DESKTOP:-$here/../../../desktop-v2}"
export PATH="/opt/homebrew/bin:$PATH"
cd "$desk"
exec "$here/with-lock.sh" /tmp/laytekz-electron.lock env -u ELECTRON_RUN_AS_NODE npx playwright test --workers=1 "$@"
