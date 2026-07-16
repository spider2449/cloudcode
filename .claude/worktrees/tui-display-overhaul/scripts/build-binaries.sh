#!/usr/bin/env bash
set -euo pipefail

if command -v bun >/dev/null 2>&1; then
    bun_cmd="bun"
elif [ -x "$HOME/.bun/bin/bun" ]; then
    bun_cmd="$HOME/.bun/bin/bun"
else
    echo "bun not found on PATH or at $HOME/.bun/bin/bun" >&2
    exit 1
fi

targets=(
    "bun-windows-x64:release/cloudcode-win-x64.exe"
    "bun-darwin-arm64:release/cloudcode-macos-arm64"
    "bun-darwin-x64:release/cloudcode-macos-x64"
    "bun-linux-x64:release/cloudcode-linux-x64"
)

mkdir -p release

for entry in "${targets[@]}"; do
    IFS=: read -r target out <<<"$entry"
    echo "Building $out ..."
    "$bun_cmd" build --compile --target="$target" scripts/bin-entry.ts --outfile "$out"
done
