$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  return (Split-Path -Parent $PSScriptRoot)
}

function Get-EnvMap {
  if ($script:EnvMap) {
    return $script:EnvMap
  }

  $repoRoot = Get-RepoRoot
  $envPath = Join-Path $repoRoot '.env'
  $map = @{}

  if (Test-Path $envPath) {
    foreach ($rawLine in Get-Content $envPath) {
      $line = $rawLine.Trim()
      if (-not $line -or $line.StartsWith('#')) {
        continue
      }

      $separatorIndex = $line.IndexOf('=')
      if ($separatorIndex -lt 0) {
        continue
      }

      $key = $line.Substring(0, $separatorIndex).Trim()
      $value = $line.Substring($separatorIndex + 1).Trim()

      if (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }

      $map[$key] = $value
    }
  }

  $script:EnvMap = $map
  return $map
}

function Get-Setting {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [string]$Default = ''
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue
  }

  $userValue = [Environment]::GetEnvironmentVariable($Name, 'User')
  if (-not [string]::IsNullOrWhiteSpace($userValue)) {
    return $userValue
  }

  $machineValue = [Environment]::GetEnvironmentVariable($Name, 'Machine')
  if (-not [string]::IsNullOrWhiteSpace($machineValue)) {
    return $machineValue
  }

  $envMap = Get-EnvMap
  if ($envMap.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($envMap[$Name])) {
    return $envMap[$Name]
  }

  return $Default
}

function Write-RuntimeLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $repoRoot = Get-RepoRoot
  $logDir = Join-Path $repoRoot 'logs'
  if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
  }

  $logPath = Join-Path $logDir 'windows-runtime.log'
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $logPath -Value "$timestamp $Message"
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Address,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [int]$TimeoutMs = 1000
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $asyncResult = $client.BeginConnect($Address, $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      return $false
    }

    $client.EndConnect($asyncResult)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-TcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Address,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [int]$TimeoutSec = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -Address $Address -Port $Port -TimeoutMs 1000) {
      return $true
    }
    Start-Sleep -Seconds 1
  }

  return $false
}

function Resolve-CommandPath {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  throw "Command not found: $($Names -join ', ')"
}

function Get-AppPort {
  $portValue = Get-Setting -Name 'PORT' -Default '3000'
  return [int]$portValue
}

function Get-AppHealth {
  $port = Get-AppPort
  $uri = "http://127.0.0.1:$port/api/health"

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 5
    if (-not $response.Content) {
      return $null
    }

    return $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-AppHealthy {
  $requireMongo = (Get-Setting -Name 'AUTH_REQUIRE_MONGO' -Default 'false').ToLowerInvariant() -eq 'true'
  $health = Get-AppHealth

  if (-not $health -or $health.ok -ne $true) {
    return $false
  }

  if ($requireMongo -and $health.mongoConnected -ne $true) {
    return $false
  }

  return $true
}

function Get-Pm2Command {
  return Resolve-CommandPath -Names @('pm2.cmd', 'pm2')
}

function Invoke-Pm2 {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$IgnoreExitCode
  )

  $pm2 = Get-Pm2Command
  $output = & $pm2 @Arguments 2>&1
  $exitCode = $LASTEXITCODE

  if (-not $IgnoreExitCode -and $exitCode -ne 0) {
    throw "pm2 $($Arguments -join ' ') failed with exit code $exitCode.`n$output"
  }

  return $output
}

function Get-Pm2Process {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  try {
    $json = Invoke-Pm2 -Arguments @('jlist') -IgnoreExitCode
    if (-not $json) {
      return $null
    }

    $items = $json | ConvertFrom-Json
    foreach ($item in $items) {
      if ($item.name -eq $Name) {
        return $item
      }
    }

    return $null
  } catch {
    return $null
  }
}

function Get-MongoTunnelConfig {
  $mongoUrl = Get-Setting -Name 'MONGO_URL' -Default 'mongodb://127.0.0.1:37018'
  $localHost = Get-Setting -Name 'MONGO_TUNNEL_LOCAL_HOST' -Default '127.0.0.1'
  $localPort = [int](Get-Setting -Name 'MONGO_TUNNEL_LOCAL_PORT' -Default '37018')

  $mongoMatch = [regex]::Match(
    $mongoUrl,
    '^mongodb(?:\+srv)?:\/\/([^\/?]+)',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if ($mongoMatch.Success) {
    $hosts = $mongoMatch.Groups[1].Value.Split(',')
    if ($hosts.Count -eq 1) {
      $parts = $hosts[0].Split(':')
      if ($parts.Count -ge 2) {
        $localHost = $parts[0]
        $localPort = [int]$parts[1]
      }
    }
  }

  return @{
    LocalHost = $localHost
    LocalPort = $localPort
    RemoteHost = Get-Setting -Name 'MONGO_TUNNEL_REMOTE_HOST' -Default '172.16.10.202'
    RemotePort = [int](Get-Setting -Name 'MONGO_TUNNEL_REMOTE_PORT' -Default '27017')
    SshHost = Get-Setting -Name 'MONGO_TUNNEL_SSH_HOST' -Default '103.252.74.109'
    SshPort = [int](Get-Setting -Name 'MONGO_TUNNEL_SSH_PORT' -Default '2357')
    SshUser = Get-Setting -Name 'MONGO_TUNNEL_SSH_USER' -Default 'root'
    SshKey = Get-Setting -Name 'MONGO_TUNNEL_SSH_KEY' -Default ''
  }
}

function Ensure-MongoTunnel {
  $tunnel = Get-MongoTunnelConfig

  if (Test-TcpPort -Address $tunnel.LocalHost -Port $tunnel.LocalPort -TimeoutMs 1000) {
    return
  }

  $ssh = Resolve-CommandPath -Names @('ssh.exe', 'ssh')
  $repoRoot = Get-RepoRoot
  $logDir = Join-Path $repoRoot 'logs'
  if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
  }

  $stdoutPath = Join-Path $logDir 'mongo-tunnel.out.log'
  $stderrPath = Join-Path $logDir 'mongo-tunnel.err.log'

  $arguments = @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-p', "$($tunnel.SshPort)"
  )

  if (-not [string]::IsNullOrWhiteSpace($tunnel.SshKey)) {
    $arguments += @('-i', $tunnel.SshKey)
  }

  $arguments += @(
    '-L', "$($tunnel.LocalHost):$($tunnel.LocalPort):$($tunnel.RemoteHost):$($tunnel.RemotePort)",
    "$($tunnel.SshUser)@$($tunnel.SshHost)"
  )

  $process = Start-Process -FilePath $ssh `
    -ArgumentList $arguments `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

  Write-RuntimeLog "[tunnel] started ssh pid=$($process.Id) for $($tunnel.LocalHost):$($tunnel.LocalPort)"

  if (-not (Wait-TcpPort -Address $tunnel.LocalHost -Port $tunnel.LocalPort -TimeoutSec 20)) {
    throw "Mongo tunnel did not become ready on $($tunnel.LocalHost):$($tunnel.LocalPort)."
  }

  Write-RuntimeLog "[tunnel] ready at $($tunnel.LocalHost):$($tunnel.LocalPort)"
}

function Ensure-AppRuntime {
  $repoRoot = Get-RepoRoot
  $appName = 'game64x64'
  $pm2Process = Get-Pm2Process -Name $appName

  Push-Location $repoRoot
  try {
    if (-not $pm2Process) {
      Write-RuntimeLog "[app] starting $appName via PM2"
      Invoke-Pm2 -Arguments @('start', 'config/ecosystem.config.js', '--only', $appName, '--update-env') | Out-Null
    } elseif ($pm2Process.pm2_env.status -ne 'online') {
      Write-RuntimeLog "[app] restarting $appName because status=$($pm2Process.pm2_env.status)"
      Invoke-Pm2 -Arguments @('restart', $appName, '--update-env') | Out-Null
    }

    Invoke-Pm2 -Arguments @('save') | Out-Null
  } finally {
    Pop-Location
  }
}

function Ensure-AppHealthy {
  $requireMongo = (Get-Setting -Name 'AUTH_REQUIRE_MONGO' -Default 'false').ToLowerInvariant() -eq 'true'
  $deadline = (Get-Date).AddSeconds(30)

  while ((Get-Date) -lt $deadline) {
    $health = Get-AppHealth
    if ($health -and $health.ok -eq $true) {
      if (-not $requireMongo -or $health.mongoConnected -eq $true) {
        Write-RuntimeLog "[health] ok=$($health.ok) mongoConnected=$($health.mongoConnected)"
        return
      }
    }

    Start-Sleep -Seconds 2
  }

  throw 'Application health check did not report mongoConnected=true in time.'
}

function Ensure-GameRuntime {
  Ensure-MongoTunnel
  if (Test-AppHealthy) {
    return
  }

  Ensure-AppRuntime
  Ensure-AppHealthy
}
