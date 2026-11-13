# Stop the local TrueForge by killing whatever listens on port 8790.
$ErrorActionPreference = 'Stop'

$Port = 8790
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
  Write-Host "Nothing is listening on port $Port"
  exit 0
}
$conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
  Stop-Process -Id $_ -Force
  Write-Host "Stopped PID $_"
}
