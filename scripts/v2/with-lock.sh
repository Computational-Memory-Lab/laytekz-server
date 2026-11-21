#!/usr/bin/env bash
# Usage: scripts/v2/with-lock.sh <lockfile> <command> [arguments...]
# Runs the command while holding an exclusive flock(2) on <lockfile>, waiting
# for it first. flock(1) where it is installed (the build machine); Perl's
# flock where it is not (macOS), on the same kind of lock, so both spellings
# exclude each other.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: with-lock.sh <lockfile> <command> [arguments...]" >&2; exit 2; }
lock="$1"; shift
if command -v flock > /dev/null 2>&1; then exec flock "$lock" "$@"; fi
exec perl -e '
  use Fcntl qw(:flock);
  $^F = 255;  # keep the locked descriptor open across exec
  my $lock = shift;
  open(my $fh, ">>", $lock) or die "with-lock: cannot open $lock: $!\n";
  flock($fh, LOCK_EX) or die "with-lock: cannot lock $lock: $!\n";
  exec { $ARGV[0] } @ARGV or die "with-lock: cannot run $ARGV[0]: $!\n";
' "$lock" "$@"
