$ErrorActionPreference = "Stop"

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCmd) {
    $bun = "bun"
} elseif (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") {
    $bun = "$env:USERPROFILE\.bun\bin\bun.exe"
} else {
    throw "bun not found on PATH or at $env:USERPROFILE\.bun\bin\bun.exe"
}

# Cross-target downloads can fail on Windows with "Failed to extract executable"
# (oven-sh/bun#25346). Workaround: download the target's official release zip from
# https://github.com/oven-sh/bun/releases/download/bun-v<ver>/<target>.zip and copy
# the extracted `bun` binary to $env:USERPROFILE\.bun\install\cache\<target>-v<ver>
# (darwin-arm64 zip is named bun-darwin-aarch64.zip).
$targets = @(
    @{ target = "bun-windows-x64"; out = "release/cloudcode-win-x64.exe" },
    @{ target = "bun-darwin-arm64"; out = "release/cloudcode-macos-arm64" },
    @{ target = "bun-darwin-x64";  out = "release/cloudcode-macos-x64" },
    @{ target = "bun-linux-x64";   out = "release/cloudcode-linux-x64" }
)
New-Item -ItemType Directory -Force release | Out-Null
foreach ($t in $targets) {
    Write-Host "Building $($t.out) ..."
    & $bun build --compile --target=$($t.target) scripts/bin-entry.ts --outfile $t.out
    if ($LASTEXITCODE -ne 0) { throw "bun build failed for $($t.target)" }
}
