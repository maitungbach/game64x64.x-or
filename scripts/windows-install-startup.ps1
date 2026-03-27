$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  return (Split-Path -Parent $PSScriptRoot)
}

$repoRoot = Get-RepoRoot
$startupDir = [Environment]::GetFolderPath('Startup')

if (-not (Test-Path $startupDir)) {
  throw "Startup folder not found: $startupDir"
}

$startupScriptPath = Join-Path $startupDir 'game64x64-runtime-watchdog.cmd'
$watchdogPath = Join-Path $repoRoot 'scripts\windows-runtime-watchdog.ps1'
$powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

$content = @(
  '@echo off',
  ('start "" /min "' + $powershellPath + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watchdogPath + '"')
)

Set-Content -Path $startupScriptPath -Value $content -Encoding ASCII
Write-Output "Installed startup launcher: $startupScriptPath"
