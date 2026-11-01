param(
  [Parameter(Mandatory = $true)][int]$MainPid,
  [Parameter(Mandatory = $true)][string]$AsarPath,
  [string]$PatchedAsar = '',
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [long]$ExpectedAsarSize = -1,
  [long]$ExpectedAsarMtimeMs = -1,
  # Written after a successful swap so the next boot can tell "this is the archive
  # we installed" from "another plugin edited it afterwards".
  [string]$InstallRecordPath = '',
  # Only set by a caller that verified the live archive is pristine; without it a
  # patched archive must never become the backup that rollback rebuilds from.
  [switch]$CreateBackup,
  [switch]$Detached
)

$ErrorActionPreference = 'Stop'

# Set as soon as the app is stopped: from that moment every failure path has to
# start it again, or the user is left with DSH closed and no window to retry from.
$script:appStopped = $false
$ExpectedProcessName = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)

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
  if ($ExpectedAsarSize -ge 0) { $commandLine += ' -ExpectedAsarSize ' + $ExpectedAsarSize }
  if ($ExpectedAsarMtimeMs -ge 0) { $commandLine += ' -ExpectedAsarMtimeMs ' + $ExpectedAsarMtimeMs }
  if ($CreateBackup) { $commandLine += ' -CreateBackup' }
  $commandLine += ' -Detached'
  try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
    Write-Log "detached helper pid=$($result.ProcessId) return=$($result.ReturnValue)"
    if ($result.ReturnValue -ne 0) {
      Write-Log "WMI refused to create the helper (return=$($result.ReturnValue)); the restart cannot continue"
      exit 5
    }
    exit 0
  } catch {
    Write-Log "failed to detach helper: $($_.Exception.Message)"
    exit 5
  }
}

function Get-MainProcess {
  return Get-Process -Id $MainPid -ErrorAction SilentlyContinue
}

function Test-MainProcess($Process) {
  return [bool]($Process -and ($Process.ProcessName -ieq $ExpectedProcessName))
}

function Test-AppRunning {
  $process = Get-MainProcess
  return (Test-MainProcess $process)
}

function Test-SourceFresh {
  if ($ExpectedAsarSize -lt 0) { return $true }
  try {
    $item = Get-Item -LiteralPath $AsarPath -ErrorAction Stop
  } catch {
    Write-Log "cannot stat live asar: $($_.Exception.Message)"
    return $false
  }
  # Size equality is the strong check: installing the patch changes the archive
  # size, so a different DSH build (or a patch already installed by a racing
  # helper) never matches. The mtime tolerance only absorbs the sub-millisecond
  # rounding between Node's mtimeMs and PowerShell's DateTime conversion.
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

function Start-App {
  if (Test-Path -LiteralPath $ExePath) {
    Write-Log "starting $ExePath"
    try {
      Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath) | Out-Null
    } catch {
      Write-Log "failed to start $($ExePath): $($_.Exception.Message)"
    }
  } else {
    Write-Log "executable not found: $ExePath"
  }
}

# Helpers killed mid-copy leave multi-hundred-megabyte temp files next to the
# archive. Remove only ours and only when no live helper can still own them.
function Remove-StaleTemp {
  try {
    $dir = Split-Path -Parent $AsarPath
    $leaf = Split-Path -Leaf $AsarPath
    $own = $leaf + '.dsh-retry.' + $PID
    $cutoff = (Get-Date).AddMinutes(-10)
    Get-ChildItem -LiteralPath $dir -Filter ($leaf + '.dsh-retry.*.tmp') -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt $cutoff -and -not $_.Name.StartsWith($own, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object {
        try {
          Remove-Item -LiteralPath $_.FullName -Force
          Write-Log "removed stale temp $($_.Name)"
        } catch {
          Write-Log "could not remove stale temp $($_.Name): $($_.Exception.Message)"
        }
      }
  } catch {
    Write-Log "stale temp cleanup failed: $($_.Exception.Message)"
  }
}

function Restore-Backup {
  if (-not (Test-Path -LiteralPath $BackupPath)) {
    Write-Log 'no backup to restore'
    return $false
  }
  $restoreTmp = $AsarPath + '.dsh-retry.' + $PID + '.restore.tmp'
  try {
    $backupSize = (Get-Item -LiteralPath $BackupPath).Length
    Copy-Item -LiteralPath $BackupPath -Destination $restoreTmp -Force
    $restoreSize = (Get-Item -LiteralPath $restoreTmp).Length
    if ($restoreSize -ne $backupSize) {
      throw "restore copy size mismatch ($restoreSize != $backupSize)"
    }
    Move-Item -LiteralPath $restoreTmp -Destination $AsarPath -Force
    Write-Log "backup restored ($restoreSize bytes)"
    return $true
  } catch {
    Write-Log "backup restore failed: $($_.Exception.Message)"
    Remove-Item -LiteralPath $restoreTmp -Force -ErrorAction SilentlyContinue
    return $false
  }
}

try {
  Write-Log "helper start mainPid=$MainPid patchedAsar=$PatchedAsar asar=$AsarPath backup=$BackupPath createBackup=$CreateBackup"

  Remove-StaleTemp

  if ($PatchedAsar) {
    if (-not (Test-Path -LiteralPath $PatchedAsar)) {
      Write-Log "patched asar missing: $PatchedAsar"
      if (-not (Test-AppRunning)) { Start-App }
      exit 2
    }
    # Check before stopping anything: a request whose archive already moved on must
    # not cost the user a restart.
    if (-not (Test-SourceFresh)) {
      Write-Log 'live asar is no longer the one this patch was built for; leaving the app alone'
      if (-not (Test-AppRunning)) { Start-App }
      exit 2
    }
  }

  # The app cannot swap its own archive (it holds app.asar open without
  # FILE_SHARE_DELETE), so the swap always happens from here: stop the app,
  # replace the archive, start it again. Short-lived by design - a helper that
  # waits for a later exit gets torn down on this machine before it can act.
  Start-Sleep -Milliseconds 1200

  if (Test-AppRunning) {
    $process = Get-MainProcess
    Write-Log "stopping main process $MainPid ($($process.ProcessName)) and its children"
    try {
      & taskkill.exe /PID $MainPid /T /F | Out-Null
    } catch {
      Write-Log "taskkill failed: $($_.Exception.Message)"
    }
    if (Test-AppRunning) { Stop-Process -Id $MainPid -Force -ErrorAction SilentlyContinue }
  } else {
    Write-Log "main process $MainPid is not running"
  }

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-AppRunning)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Test-AppRunning) {
    Write-Log 'main process still alive after 30s, aborting asar swap'
    exit 1
  }
  Write-Log 'main process exited'
  $script:appStopped = $true

  if ($PatchedAsar) {
    # Re-check after the kill: a concurrent helper may have replaced the archive
    # while this one was waiting for the app to die.
    if (-not (Test-SourceFresh)) {
      Write-Log 'live asar changed while waiting for the app; restoring startup'
      Start-App
      exit 2
    }

    if ($CreateBackup -and -not (Test-Path -LiteralPath $BackupPath)) {
      $backupTmp = $BackupPath + '.' + $PID + '.tmp'
      try {
        $sourceSize = (Get-Item -LiteralPath $AsarPath).Length
        Copy-Item -LiteralPath $AsarPath -Destination $backupTmp -Force
        $backupSize = (Get-Item -LiteralPath $backupTmp).Length
        if ($backupSize -ne $sourceSize) {
          throw "backup copy size mismatch ($backupSize != $sourceSize)"
        }
        Move-Item -LiteralPath $backupTmp -Destination $BackupPath -Force
        Write-Log "backed up asar to $BackupPath ($backupSize bytes)"
      } catch {
        Write-Log "backup creation skipped: $($_.Exception.Message)"
        Remove-Item -LiteralPath $backupTmp -Force -ErrorAction SilentlyContinue
      }
    }

    $patchedSize = (Get-Item -LiteralPath $PatchedAsar).Length
    # Unique per helper run, so a leftover copy is never mistaken for a good one.
    $tmp = $AsarPath + '.dsh-retry.' + $PID + '.tmp'
    $installed = $false
    try {
      for ($attempt = 1; $attempt -le 100; $attempt++) {
        try {
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
          if ($InstallRecordPath) {
            try {
              $record = @{ bytes = $tmpSize; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
              [IO.File]::WriteAllText($InstallRecordPath, $record)
            } catch {
              Write-Log "could not write the install record: $($_.Exception.Message)"
            }
          }
          break
        } catch {
          Write-Log "replace attempt=$attempt failed: $($_.Exception.Message)"
          Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
          Start-Sleep -Milliseconds 300
        }
      }
    } finally {
      # A helper can be killed at any point; without this a run that dies between
      # copy and rename leaks a ~180 MB temp file that only Remove-StaleTemp sees.
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }

    if (-not $installed) {
      Write-Log 'failed to replace asar after 100 attempts; restoring the pristine backup'
      if ($InstallRecordPath) { Remove-Item -LiteralPath $InstallRecordPath -Force -ErrorAction SilentlyContinue }
      Restore-Backup | Out-Null
      Start-App
      exit 3
    }
  }

  Start-App
  Write-Log 'helper done'
  exit 0
} catch {
  Write-Log "helper failed: $($_.Exception.Message)"
  if ($script:appStopped) {
    Write-Log 'app was stopped before the failure; starting it again'
    Start-App
  }
  exit 4
}