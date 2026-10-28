param(
  [Parameter(Mandatory = $true)][int]$MainPid,
  [Parameter(Mandatory = $true)][string]$AsarPath,
  [string]$PatchedAsar = '',
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [switch]$Detached,
  [switch]$InstallOnly
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('o'), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

# Stage 1: the host starts this script as a regular child process. A child is
# torn down together with its process tree when the app dies, so hand the real
# work to a process created by WMI, which lives outside that tree.
if (-not $Detached) {
  $commandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath +
  '" -MainPid ' + $MainPid +
  ' -AsarPath "' + $AsarPath +
  '" -PatchedAsar "' + $PatchedAsar +
  '" -BackupPath "' + $BackupPath +
  '" -ExePath "' + $ExePath +
  '" -LogPath "' + $LogPath +
  '" -Detached'
  if ($InstallOnly) { $commandLine += ' -InstallOnly' }
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
  Write-Log "detached helper pid=$($result.ProcessId) return=$($result.ReturnValue)"
  exit 0
}

Write-Log "helper start mainPid=$MainPid patchedAsar=$PatchedAsar asar=$AsarPath installOnly=$InstallOnly"

if ($InstallOnly) {
  # No button exists yet before the patch is installed, so the host arms this
  # helper once and it silently installs the patch whenever the app exits.
  Write-Log 'waiting for the main process to exit'
  $deadline = (Get-Date).AddDays(7)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $MainPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $MainPid -ErrorAction SilentlyContinue) {
    Write-Log 'main process still alive after 7 days, giving up'
    exit 5
  }
  Write-Log 'main process exited, installing patch on exit'
} else {
  # Give the renderer a moment to flush its reply before the app disappears.
  Start-Sleep -Milliseconds 1200

  try {
    $process = Get-Process -Id $MainPid -ErrorAction Stop
    Write-Log "stopping main process $MainPid ($($process.ProcessName))"
    Stop-Process -Id $MainPid -Force -ErrorAction Stop
  } catch {
    Write-Log "main process $MainPid already gone: $($_.Exception.Message)"
  }

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $MainPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $MainPid -ErrorAction SilentlyContinue) {
    Write-Log 'main process still alive after 30s, aborting asar swap'
    exit 1
  }
  Write-Log 'main process exited'
}

if ($PatchedAsar) {
  if (-not (Test-Path -LiteralPath $PatchedAsar)) {
    Write-Log "patched asar missing: $PatchedAsar"
    exit 2
  }

  $installed = $false
  for ($attempt = 1; $attempt -le 100; $attempt++) {
    try {
      if (-not (Test-Path -LiteralPath $BackupPath)) {
        Copy-Item -LiteralPath $AsarPath -Destination $BackupPath -Force
        Write-Log "backed up asar to $BackupPath"
      }
      Copy-Item -LiteralPath $PatchedAsar -Destination $AsarPath -Force
      $installed = $true
      Write-Log "replaced asar attempt=$attempt"
      break
    } catch {
      Write-Log "replace attempt=$attempt failed: $($_.Exception.Message)"
      Start-Sleep -Milliseconds 300
    }
  }

  if (-not $installed) {
    Write-Log 'failed to replace asar after 100 attempts'
    if (-not $InstallOnly) { Start-Process -FilePath $ExePath }
    exit 3
  }
}

if ($InstallOnly) {
  Write-Log 'helper done (patch installed on exit)'
  exit 0
}

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Log "executable not found: $ExePath"
  exit 4
}

Write-Log "starting $ExePath"
Start-Process -FilePath $ExePath
Write-Log 'helper done'
