$ErrorActionPreference = "Stop"

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCmd) {
    $bun = "bun"
} elseif (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") {
    $bun = "$env:USERPROFILE\.bun\bin\bun.exe"
} else {
    throw "bun not found on PATH or at $env:USERPROFILE\.bun\bin\bun.exe"
}

$allTargets = @(
    @{ target = "bun-windows-x64"; out = "release/cloudcode-win-x64.exe" },
    @{ target = "bun-linux-x64";   out = "release/cloudcode-linux-x64" }
)

$isWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
$targets = if ($isWindows) {
    $allTargets | Where-Object { $_.target -match "windows" }
} else {
    $allTargets | Where-Object { $_.target -match "linux" }
}

New-Item -ItemType Directory -Force release | Out-Null
foreach ($t in $targets) {
    Write-Host "Building $($t.out) ..."
    & $bun build --compile --target=$($t.target) scripts/bin-entry.ts --outfile $t.out
    if ($LASTEXITCODE -ne 0) { throw "bun build failed for $($t.target)" }
}
