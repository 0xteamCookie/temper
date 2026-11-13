# Start a local TrueForge (pinned) bound to 127.0.0.1:8790 and wait until it is ready.
$ErrorActionPreference = 'Stop'

$Version = '0.185.0'
$Port = 8790
$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root '.trueforge'
$Log = Join-Path $StateDir 'tf.log'
$ErrLog = Join-Path $StateDir 'tf.err.log'
$Url = "http://127.0.0.1:$Port/"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Test-Ready {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-Ready) {
  Write-Host "TrueForge is already running at $Url"
  exit 0
}

# Only 127.0.0.1 may be registered as an outbound MCP/provider host (exact-host match).
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
$env:SQLITE_PATH = Join-Path $StateDir 'trueforge.db'

Write-Host "Starting TrueForge $Version (log: $Log)"
$proc = Start-Process -FilePath 'npx.cmd' `
  -ArgumentList '-y', "@truefoundry/trueforge@$Version" `
  -RedirectStandardOutput $Log -RedirectStandardError $ErrLog `
  -WindowStyle Hidden -PassThru
$proc.Id | Out-File -Encoding ascii (Join-Path $StateDir 'tf.pid')

# The first start downloads the package and can take 60-90 seconds.
for ($i = 0; $i -lt 180; $i++) {
  if (Test-Ready) {
    Write-Host "TrueForge is ready at $Url"
    exit 0
  }
  Start-Sleep -Seconds 1
}

Write-Error "TrueForge did not become ready within 180s. See $Log and $ErrLog"
exit 1
