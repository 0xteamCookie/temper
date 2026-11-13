# Prepare the Flask demo project: clone pallets/flask at 3.1.3 and create a virtualenv.
# Usage: scripts\setup-flask-demo.ps1 [target-dir]   (default: ..\flask)
param([string]$Target)
$ErrorActionPreference = 'Stop'

$Tag = '3.1.3'
$ExpectedSha = '22d92470'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path (Split-Path -Parent $Root) 'flask' }

if (-not (Test-Path (Join-Path $Target '.git'))) {
  git clone --branch $Tag --depth 1 https://github.com/pallets/flask.git $Target
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}

$head = (git -C $Target rev-parse HEAD).Trim()
if (-not $head.StartsWith($ExpectedSha)) {
  throw "Unexpected Flask HEAD $head (expected $ExpectedSha...)"
}
Write-Host "Flask HEAD is $head"

Push-Location $Target
try {
  python -m venv .venv
  if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
  # pytest 9 breaks tests/test_cli.py, so pin it below 9.
  & .\.venv\Scripts\python.exe -m pip install -e . 'pytest<9'
  if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
} finally {
  Pop-Location
}
Write-Host "Flask demo ready at $Target"
