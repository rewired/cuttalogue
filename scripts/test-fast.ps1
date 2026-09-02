# Runs the deterministic local release gate. The real MMS alignment smoke test
# is intentionally separate because it downloads and loads a roughly 1 GB model.
param([string]$PythonPath = "")

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPython = if ($PythonPath) { $PythonPath } else { Join-Path $repoRoot "backend\.venv\Scripts\python.exe" }
if (-not (Test-Path $venvPython)) {
    throw "Backend virtual environment not found. Run .\start.ps1 once to create it."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required for the canonical compiler and frontend tests."
}

$failed = [System.Collections.Generic.List[string]]::new()
$backendTests = Get-ChildItem (Join-Path $repoRoot "backend\tests\test_*.py") |
    Where-Object { $_.Name -ne "test_alignment_smoke.py" }
$frontendTests = Get-ChildItem (Join-Path $repoRoot "frontend\tests\*.test.js")

foreach ($test in $backendTests) {
    Write-Host "RUN backend/$($test.Name)"
    & $venvPython $test.FullName
    if ($LASTEXITCODE -ne 0) { $failed.Add($test.FullName) }
}
foreach ($test in $frontendTests) {
    Write-Host "RUN frontend/$($test.Name)"
    & node $test.FullName
    if ($LASTEXITCODE -ne 0) { $failed.Add($test.FullName) }
}

if ($failed.Count -gt 0) {
    Write-Host "FAILED TESTS:"
    $failed | ForEach-Object { Write-Host $_ }
    exit 1
}
Write-Host "ALL FAST REGRESSIONS PASSED ($($backendTests.Count) backend, $($frontendTests.Count) frontend)"
