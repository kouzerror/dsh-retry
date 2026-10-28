param(
  [Parameter(Mandatory = $true)][int]$MainPid,
  [Parameter(Mandatory = $true)][string]$AsarPath,
  [string]$PatchedAsar = '',
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [string]$MarkerPath = '',
  [long]$ExpectedAsarSize = -1,
  [long]$ExpectedAsarMtimeMs = -1,
  [switch]$Detached,
  [switch]$InstallOnly
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('o'), $Message
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # logging must never abort the restart
  }
}

function Quote([string]$Value) {
  return '"' + $Value + '"'
}

# Stage 1: the host starts this script as a regular child process. A child is
# torn down together with its process tree when the app dies, so hand the real
# work to a process created by WMI, which lives outside that tree.
if (-not $Detached) {
  $commandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Quote $PSCommandPath) +
  ' -MainPid ' + $MainPid +
  ' -AsarPath ' + (Quote $AsarPath) +
  ' -PatchedAsar ' + (Quote $PatchedAsar) +
  ' -BackupPath ' + (Quote $BackupPath) +
  ' -ExePath ' + (Quote $ExePath) +
  ' -LogPath ' + (Quote $LogPath)
  if ($MarkerPath) { $commandLine += ' -MarkerPath ' + (Quote $MarkerPath) }
  if ($ExpectedAsarSize -ge 0) { $commandLine += ' -ExpectedAsarSize ' + $ExpectedAsarSize }
  if ($ExpectedAsarMtimeMs -ge 0) { $commandLine += ' -ExpectedAsarMtimeMs ' + $ExpectedAsarMtimeMs }
  $commandLine += ' -Detached'
  if ($InstallOnly) { $commandLine += ' -InstallOnly' }
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
  Write-Log "detached helper pid=$($result.ProcessId) return=$($result.ReturnValue)"
  exit 0
}

$markerWritten = $false
try {
  Write-Log "helper start mainPid=$MainPid patchedAsar=$PatchedAsar asar=$AsarPath installOnly=$InstallOnly"

  if ($MarkerPath) {
    try {
      $marker = @{ mainPid = $MainPid; helperPid = $PID; mode = $(if ($InstallOnly) { 'install-only' } else { 'restart' }); armedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
      Set-Content -LiteralPath $MarkerPath -Value $marker -Encoding UTF8
      $markerWritten = $true
    } catch {
      Write-Log "could not write marker: $($_.Exception.Message)"
    }
  }

  function Get-MainProcess {
    return Get-Process -Id $MainPid -ErrorAction SilentlyContinue
  }

  function Test-SourceFresh {
    if ($ExpectedAsarSize -lt 0) { return $true }
    $item = Get-Item -LiteralPath $AsarPath -ErrorAction Stop
    if ($item.Length -ne $ExpectedAsarSize) {
      Write-Log "asar size changed (found $($item.Length), expected $ExpectedAsarSize); refusing to install stale patch"
      return $false
    }
    if ($ExpectedAsarMtimeMs -ge 0) {
      $epoch = [DateTimeOffset]::new(1970, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $mtimeMs = [long]([DateTimeOffset]::new($item.LastWriteTimeUtc.ToUniversalTime()) - $epoch).TotalMilliseconds
      if ([Math]::Abs($mtimeMs - $ExpectedAsarMtimeMs) -gt 1000) {
        Write-Log "asar mtime changed (found $mtimeMs, expected $ExpectedAsarMtimeMs); refusing to install stale patch"
        return $false
      }
    }
    return $true
  }

  if ($InstallOnly) {
    # No button exists yet before the patch is installed, so the host arms this
    # helper once and it silently installs the patch whenever the app exits.
    Write-Log 'waiting for the main process to exit'
    $deadline = (Get-Date).AddDays(7)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-MainProcess)) { break }
      Start-Sleep -Milliseconds 500
    }
    if (Get-MainProcess) {
      Write-Log 'main process still alive after 7 days, giving up'
      exit 5
    }
    Write-Log 'main process exited, installing patch on exit'
  } else {
    # Give the renderer a moment to flush its reply before the app disappears.
    Start-Sleep -Milliseconds 1200

    $process = Get-MainProcess
    if ($process) {
      Write-Log "stopping main process $MainPid ($($process.ProcessName)) and its children"
      try {
        & taskkill.exe /PID $MainPid /T /F | Out-Null
      } catch {
        Write-Log "taskkill failed: $($_.Exception.Message)"
      }
      if (Get-MainProcess) { Stop-Process -Id $MainPid -Force -ErrorAction SilentlyContinue }
    } else {
      Write-Log "main process $MainPid already gone"
    }

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-MainProcess)) { break }
      Start-Sleep -Milliseconds 250
    }
    if (Get-MainProcess) {
      Write-Log 'main process still alive after 30s, aborting asar swap'
      exit 1
    }
    Write-Log 'main process exited'
  }

  $start = @{}
  if (-not $InstallOnly) { $start['workingDirectory'] = Split-Path -Parent $ExePath }

  function Start-App {
    if (Test-Path -LiteralPath $ExePath) {
      Write-Log "starting $ExePath"
      if ($start.ContainsKey('workingDirectory')) {
        Start-Process -FilePath $ExePath -WorkingDirectory $start['workingDirectory']
      } else {
        Start-Process -FilePath $ExePath
      }
    } else {
      Write-Log "executable not found: $ExePath"
    }
  }

  if ($PatchedAsar) {
    if (-not (Test-Path -LiteralPath $PatchedAsar)) {
      Write-Log "patched asar missing: $PatchedAsar"
      Start-App
      exit 2
    }
    if (-not (Test-SourceFresh)) {
      Start-App
      exit 2
    }

    $patchedSize = (Get-Item -LiteralPath $PatchedAsar).Length
    # Unique per helper: two helpers can run at once (armed install + restart).
    $tmp = $AsarPath + '.dsh-retry.' + $PID + '.tmp'
    $installed = $false
    for ($attempt = 1; $attempt -le 100; $attempt++) {
      try {
        if (-not (Test-Path -LiteralPath $BackupPath)) {
          Copy-Item -LiteralPath $AsarPath -Destination $BackupPath -Force
          Write-Log "backed up asar to $BackupPath"
        }
        # Copy next to the target (same volume) and only then rename over it, so
        # a crash can never leave a truncated app.asar behind.
        Copy-Item -LiteralPath $PatchedAsar -Destination $tmp -Force
        $tmpSize = (Get-Item -LiteralPath $tmp).Length
        if ($tmpSize -ne $patchedSize) {
          throw "temporary copy size mismatch ($tmpSize != $patchedSize)"
        }
        Move-Item -LiteralPath $tmp -Destination $AsarPath -Force
        $installed = $true
        Write-Log "replaced asar attempt=$attempt bytes=$tmpSize"
        break
      } catch {
        Write-Log "replace attempt=$attempt failed: $($_.Exception.Message)"
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
      }
    }

    if (-not $installed) {
      Write-Log 'failed to replace asar after 100 attempts; restoring backup'
      if (Test-Path -LiteralPath $BackupPath) {
        try {
          Copy-Item -LiteralPath $BackupPath -Destination $AsarPath -Force
          Write-Log 'backup restored'
        } catch {
          Write-Log "backup restore failed: $($_.Exception.Message)"
        }
      }
      Start-App
      exit 3
    }
  }

  if ($InstallOnly) {
    Write-Log 'helper done (patch installed on exit)'
    exit 0
  }

  Start-App
  Write-Log 'helper done'
  exit 0
} finally {
  if ($markerWritten -and $MarkerPath) {
    Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
  }
}
