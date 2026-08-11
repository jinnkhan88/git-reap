#!/usr/bin/env bash
# git-reap release build: compile the proven matrix, write
# checksums. Targets that fail packaging drop to "bunx only" — the workflow
# uploads whatever succeeded.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-dist}"
mkdir -p "$OUT"

# Native target of the current machine (always works if the spike passed)
# `bun build --compile` defaults to the host target.
build_target() {
  local target="$1" out="$2"
  echo "== compiling $target"
  if bun build --compile --target "$target" src/bin.js --outfile "$out" 2>"$OUT/$target.log"; then
    echo "   ok: $out"
    return 0
  fi
  echo "   FAILED (see $OUT/$target.log) — this target is bunx-only for now"
  return 1
}

# Prove the compile matrix: any failing target is documented as
# npm/bunx only rather than blocking the release.
build_target "bun-linux-x64" "$OUT/git-reap-linux-x64" || true
build_target "bun-linux-arm64" "$OUT/git-reap-linux-arm64" || true
build_target "bun-darwin-x64" "$OUT/git-reap-darwin-x64" || true
build_target "bun-darwin-arm64" "$OUT/git-reap-darwin-arm64" || true
build_target "bun-windows-x64" "$OUT/git-reap-windows-x64.exe" || true

# Checksums for every artifact that actually built
(cd "$OUT" && sha256sum git-reap-* 2>/dev/null > SHA256SUMS) || true

echo
echo "artifacts:"
ls -lh "$OUT" 2>/dev/null || echo "  (none built)"
