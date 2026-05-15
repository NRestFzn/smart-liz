param(
  [string]$Python = $(if ($env:CHROMA_PYTHON) { $env:CHROMA_PYTHON } else { "python" })
)

$ErrorActionPreference = "Stop"

$BackendDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvDir = Join-Path $BackendDir "chroma-env"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

Write-Host "Creating/updating Chroma Python environment..." -ForegroundColor Cyan
& $Python -m venv $VenvDir

Write-Host "Installing chromadb into chroma-env..." -ForegroundColor Cyan
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install --upgrade chromadb

Write-Host "Chroma setup complete." -ForegroundColor Green
Write-Host "You can now run: npm run dev:all" -ForegroundColor Green
