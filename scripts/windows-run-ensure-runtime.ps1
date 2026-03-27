$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'windows-ensure-runtime.ps1')

Ensure-GameRuntime
