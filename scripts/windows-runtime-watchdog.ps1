$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'windows-ensure-runtime.ps1')

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\game64x64-runtime-watchdog', [ref]$createdNew)

if (-not $createdNew) {
  Write-RuntimeLog '[watchdog] another watchdog instance is already running'
  exit 0
}

try {
  Write-RuntimeLog '[watchdog] started'

  while ($true) {
    try {
      Ensure-GameRuntime
    } catch {
      Write-RuntimeLog "[watchdog] ensure failed: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds 30
  }
} finally {
  Write-RuntimeLog '[watchdog] stopped'
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}
