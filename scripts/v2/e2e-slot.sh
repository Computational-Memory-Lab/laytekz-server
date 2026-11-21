#!/usr/bin/env bash
# Usage (on the build machine, inside a scratch tree; normally through remote.sh):
#   scripts/v2/e2e-slot.sh [playwright test arguments]     default: -c e2e
#
# The build machine also serves the live site, so Playwright runs only inside
# one of two slots: it takes ~/v2-scratch/e2e.1.lock or e2e.2.lock (flock),
# waiting for slot 1 when both are busy. Slot k gets its own ports: the app
# on 31k0, the mocks on 31k1-31k8 (main and auth suites), the base-path and
# provisioning servers on 32k0-32k6, and a compiler on 40k0, loopback only,
# with a one-off COMPILER_TOKEN and DATA_DIR=${E2E_DATA_DIR:-.data-e2e} (the
# main suite's; set E2E_DATA_DIR for another suite that typesets). The app
# server listens on 127.0.0.1 (HOST). Everything runs under nice -n 10.
# Playwright's Chromium lives in ~/.cache/ms-playwright on the build machine.
set -euo pipefail

cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/opt/node/bin:$HOME/texlive/tl/bin/x86_64-linux:$PATH"
# Chromium's X and ATK libraries, unpacked without root from Ubuntu's packages
# (apt-get download + dpkg -x): the build machine has no sudo.
chromium_libs="$HOME/.local/opt/chromium-libs/root/usr/lib/x86_64-linux-gnu"
if [ -d "$chromium_libs" ]; then export LD_LIBRARY_PATH="$chromium_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi
locks="${V2_LOCK_DIR:-$HOME/v2-scratch}"
mkdir -p "$locks"

slot=""
for k in 1 2; do
  exec 9>"$locks/e2e.$k.lock"
  if flock -n 9; then slot=$k; break; fi
  exec 9>&-
done
if [ -z "$slot" ]; then
  echo "e2e-slot: both slots are busy; waiting for slot 1"
  exec 9>"$locks/e2e.1.lock"
  flock 9
  slot=1
fi
k=$slot

export E2E_PORT=31${k}0 E2E_MOCK_PORT=31${k}1 E2E_GITLAB_PORT=31${k}2 E2E_GITEA_PORT=31${k}3
export E2E_AUTH_PORT=31${k}4 E2E_AUTH_MOCK_PORT=31${k}5 E2E_AUTH_OIDC_PORT=31${k}6 E2E_AUTH_APPROVAL_PORT=31${k}7 E2E_AUTH_LOGOUT_PORT=31${k}8
export E2E_BASE_PATH_PORT=32${k}0 E2E_BASE_PATH_AUTH_PORT=32${k}2 E2E_BASE_PATH_OIDC_PORT=32${k}3 E2E_PROV_PORT=32${k}5 E2E_PROV_GITLAB_PORT=32${k}6
export HOST=127.0.0.1
cport=40${k}0
export COMPILER_URL="http://127.0.0.1:$cport"
COMPILER_TOKEN="$(head -c 64 /dev/urandom | base64 | tr -d '\n/+=' | head -c 64)"
export COMPILER_TOKEN
data="${E2E_DATA_DIR:-$PWD/.data-e2e}"
mkdir -p "$data"

PORT=$cport DATA_DIR="$data" nice -n 10 node apps/compiler/server.js > "$locks/compiler.$k.log" 2>&1 &
cpid=$!
trap 'kill "$cpid" 2>/dev/null || true' EXIT
for _ in $(seq 1 150); do
  if curl -fsS "$COMPILER_URL/health" > /dev/null 2>&1; then break; fi
  if ! kill -0 "$cpid" 2>/dev/null; then echo "e2e-slot: the compiler exited; see $locks/compiler.$k.log" >&2; exit 1; fi
  sleep 0.2
done
echo "e2e-slot: slot $k, app :$E2E_PORT, mocks :$E2E_MOCK_PORT, compiler :$cport, data $data"

[ $# -gt 0 ] || set -- -c e2e
nice -n 10 npx playwright test "$@"
