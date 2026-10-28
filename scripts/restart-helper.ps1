param(
  [Parameter(Mandatory = $true)][int]$MainPid,
  [Parameter(Mandatory = $true)][string]$AsarPath,
  [string]$PatchedAsar = '',
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('o'), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

Write-Log "helper start mainPid=$MainPid patchedAsar=$PatchedAsar asar=$AsarPath"

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
    Start-Process -FilePath $ExePath
    exit 3
  }
}

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Log "executable not found: $ExePath"
  exit 4
}

Write-Log "starting $ExePath"
Start-Process -FilePath $ExePath
Write-Log 'helper done'
