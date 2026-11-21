#!/usr/bin/env bash
# Usage (on the Mac, from anywhere):
#   scripts/v2/scratch-sync.sh <WP> [--with <WP>]...
#
# Builds ~/v2-scratch/<WP>/server on the build machine: the last commit
# (git archive HEAD, uploaded once per commit and cached under
# ~/v2-scratch/.heads/), plus this package's own changed files from the working
# tree (check-ownership.mjs <WP> --list), with node_modules linked from the
# wave's single install (~/laytekz-v2/server). Other packages' half-finished
# work never reaches it. Test data and builds in the scratch tree (.data*,
# .secrets*, dist, test-results) survive a re-sync.
#
# --with <WP> also overlays that package's current files: only for a smoke run
# against a neighbour you depend on (say so in your notes). Desktop files are
# skipped: desktop tests run on the Mac (scripts/v2/desktop-test.sh).
#
# Then: scripts/v2/remote.sh <WP> 'npm run typecheck -w apps/web'
# Environment: V2_REMOTE (default: GALLEY_SSH_HOST from deploy/site.env beside this repository), V2_BASE (default laytekz-v2/server, relative to the remote home).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
export PATH="/opt/homebrew/bin:$PATH"
export COPYFILE_DISABLE=1
site_env="$(cd "$(dirname "$0")/../../.." && pwd)/deploy/site.env"
if [[ -z "${V2_REMOTE:-}" && -f "$site_env" ]]; then V2_REMOTE="$(. "$site_env" >/dev/null 2>&1; printf %s "${GALLEY_SSH_HOST:-}")"; fi
remote="${V2_REMOTE:?set V2_REMOTE to the ssh host of the build machine}"
base="${V2_BASE:-laytekz-v2/server}"

wp="${1:-}"
case "$wp" in WP[0-9][0-9]|WPX[0-9]) shift ;; *) echo "usage: scratch-sync.sh <WP> [--with <WP>]..." >&2; exit 2 ;; esac
packages="$wp"
while [ $# -gt 0 ]; do
  case "$1" in
    --with) [ $# -ge 2 ] || { echo "--with needs a package" >&2; exit 2; }; packages="$packages $2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

head="$(git -C "$root" rev-parse HEAD)"
dest="v2-scratch/$wp/server"
cache="v2-scratch/.heads/$head"

if ! ssh "$remote" "test -f ~/$cache/.complete"; then
  # Several agents may sync the same new commit at once: one extracts it
  # under the lock, the others drain their copy of the archive and reuse it.
  echo "scratch-sync: uploading commit ${head:0:12} once"
  git -C "$root" archive --format=tar HEAD | ssh "$remote" "mkdir -p ~/v2-scratch/.heads && flock ~/v2-scratch/.heads/.lock sh -c 'if [ -f ~/$cache/.complete ]; then cat > /dev/null; else rm -rf ~/$cache.tmp && mkdir -p ~/$cache.tmp && tar -x -C ~/$cache.tmp && touch ~/$cache.tmp/.complete && rm -rf ~/$cache && mv ~/$cache.tmp ~/$cache; fi'"
fi

ssh "$remote" "mkdir -p ~/$dest && rsync -a --delete --exclude=/.complete --exclude=node_modules --exclude='/.data*' --exclude='/.secrets*' --exclude=dist --exclude=test-results --exclude=playwright-report --exclude=/.cache --exclude=/apps/server/assets/pdf-viewer.html ~/$cache/ ~/$dest/"

lists="$(mktemp)"; gone="$(mktemp)"
trap 'rm -f "$lists" "$gone"' EXIT
for p in $packages; do
  node "$here/check-ownership.mjs" "$p" --list | while IFS= read -r line; do
    case "$line" in
      ''|desktop-v2/*|-desktop-v2/*) ;;
      -*) printf '%s\n' "${line#-}" >> "$gone" ;;
      *) printf '%s\n' "$line" >> "$lists" ;;
    esac
  done
done

count=$(wc -l < "$lists" | tr -d ' ')
if [ "$count" -gt 0 ]; then
  (cd "$root" && tar --no-xattrs -cf - -T "$lists") | ssh "$remote" "tar -x -C ~/$dest"
fi
removed=$(wc -l < "$gone" | tr -d ' ')
if [ "$removed" -gt 0 ]; then
  tr '\n' '\0' < "$gone" | ssh "$remote" "cd ~/$dest && xargs -0 rm -f --"
fi

ssh "$remote" "ln -sfn ~/$base/node_modules ~/$dest/node_modules && if [ -d ~/$base/apps/web/node_modules ]; then ln -sfn ~/$base/apps/web/node_modules ~/$dest/apps/web/node_modules; fi"
note=""; [ "$removed" -gt 0 ] && note=", $removed deleted"
echo "scratch-sync: ~/$dest = ${head:0:12} + $count file(s) of [$packages]$note"
