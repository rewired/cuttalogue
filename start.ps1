# Starts the CUTTAlogue backend (which also serves the frontend).
# Usage: .\start.ps1

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$venvDir = Join-Path $backendDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "No venv found at $venvDir - creating one..."
    python -m venv $venvDir
    & $venvPython -m pip install -r (Join-Path $backendDir "requirements.txt")
}

Set-Location $backendDir
& $venvPython -m uvicorn app.main:app --reload
