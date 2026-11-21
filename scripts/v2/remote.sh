#!/usr/bin/env bash
# Usage (on the Mac): scripts/v2/remote.sh <WP> '<command>'
#   scripts/v2/remote.sh WP05 'npm run typecheck -w apps/web && npm run test -w apps/web -- src/editor/core'
#   scripts/v2/remote.sh WP03 'npm run typecheck -w apps/server && npm run test:unit -w apps/server'
#   scripts/v2/remote.sh WP06 'scripts/v2/e2e-slot.sh -c e2e tests/206-page-host.spec.ts'
#
# Runs the command on the build machine in ~/v2-scratch/<WP>/server (made by
# scratch-sync.sh), under nice -n 10, with the build machine's Node and TeX
# Live on PATH. Environment: V2_REMOTE (default: GALLEY_SSH_HOST from deploy/site.env beside this repository).
set -euo pipefail
wp="${1:-}"; cmd="${2:-}"
case "$wp" in WP[0-9][0-9]|WPX[0-9]) ;; *) echo "usage: remote.sh <WP> '<command>'" >&2; exit 2 ;; esac
[ -n "$cmd" ] || { echo "usage: remote.sh <WP> '<command>'" >&2; exit 2; }
site_env="$(cd "$(dirname "$0")/../../.." && pwd)/deploy/site.env"
if [[ -z "${V2_REMOTE:-}" && -f "$site_env" ]]; then V2_REMOTE="$(. "$site_env" >/dev/null 2>&1; printf %s "${GALLEY_SSH_HOST:-}")"; fi
remote="${V2_REMOTE:?set V2_REMOTE to the ssh host of the build machine}"
quoted="$(printf '%q' "$cmd")"
exec ssh "$remote" "cd ~/v2-scratch/$wp/server && export PATH=\$HOME/.local/opt/node/bin:\$HOME/texlive/tl/bin/x86_64-linux:\$PATH && nice -n 10 bash -c $quoted"
