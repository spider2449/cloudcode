$ErrorActionPreference = "Stop"

# Locate ISCC.exe (Inno Setup command-line compiler).
$isccCmd = Get-Command iscc -ErrorAction SilentlyContinue
if ($isccCmd) {
    $iscc = $isccCmd.Source
} elseif (Test-Path "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") {
    $iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
} elseif (Test-Path "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") {
    $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
} else {
    throw "ISCC.exe not found. Install Inno Setup 6 (https://jrsoftware.org/isdl.php). Searched: 'iscc' on PATH, $env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe, ${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
}

& "$iscc" installer\cloudcode.iss
if ($LASTEXITCODE -ne 0) { throw "ISCC compile failed (exit $LASTEXITCODE)" }
