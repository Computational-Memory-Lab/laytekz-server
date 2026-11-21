#!/usr/bin/env bash
# Usage (on the Mac; the integrator, after committing): scripts/v2/refresh-base.sh [--install]
#
# Makes the build machine's base copy (~/laytekz-v2/server) the committed
# tree: git archive HEAD replaces every tracked file and removes the ones HEAD
# no longer has, keeping node_modules, test data and build output. Records the
# commit in ~/laytekz-v2/server/.v2-base-rev. --install then runs npm ci there
# (required when a lockfile changed, as WP17 and WP43 do), under nice.
# Environment: V2_REMOTE (default: GALLEY_SSH_HOST from deploy/site.env beside this repository), V2_BASE (default laytekz-v2/server).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
export PATH="/opt/homebrew/bin:$PATH"
site_env="$(cd "$(dirname "$0")/../../.." && pwd)/deploy/site.env"
if [[ -z "${V2_REMOTE:-}" && -f "$site_env" ]]; then V2_REMOTE="$(. "$site_env" >/dev/null 2>&1; printf %s "${GALLEY_SSH_HOST:-}")"; fi
remote="${V2_REMOTE:?set V2_REMOTE to the ssh host of the build machine}"
base="${V2_BASE:-laytekz-v2/server}"
install=0
[ "${1:-}" = "--install" ] && install=1

if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "refresh-base: note: the working tree has uncommitted changes; only HEAD is copied" >&2
fi
head="$(git -C "$root" rev-parse HEAD)"
incoming="$base.incoming"
ssh "$remote" "rm -rf ~/$incoming && mkdir -p ~/$incoming"
git -C "$root" archive --format=tar HEAD | ssh "$remote" "tar -x -C ~/$incoming"
ssh "$remote" "mkdir -p ~/$base && rsync -a --delete --exclude=node_modules --exclude='/.data*' --exclude='/.secrets*' --exclude=dist --exclude=/.cache --exclude=test-results --exclude=playwright-report --exclude=/.v2-base-rev --exclude=/apps/server/assets/pdf-viewer.html ~/$incoming/ ~/$base/ && rm -rf ~/$incoming && echo $head > ~/$base/.v2-base-rev"
if [ "$install" = 1 ]; then
  ssh "$remote" "cd ~/$base && export PATH=\$HOME/.local/opt/node/bin:\$PATH && nice -n 10 npm ci"
fi
echo "refresh-base: ~/$base is now ${head:0:12}"
