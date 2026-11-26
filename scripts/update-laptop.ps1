# Bring the laptop's installed Aislet up to date with main. The hub and the PC app run from the main worktree
# (C:\spaceio\ai\assistant-app), which a push from another branch (git push origin learning:main) leaves behind.
# Run it after every push to main:
#   powershell -ExecutionPolicy Bypass -File scripts\update-laptop.ps1
# It only fast-forwards, refuses a worktree with changes in it, reinstalls packages only when the lock file changed,
# rebuilds the PC app (dist/) when anything changed, and restarts the hub only when pc/ changed. Your data
# (%LOCALAPPDATA%\Aislet) isn't touched.
param(
  [string]$App = 'C:\spaceio\ai\assistant-app',
  [switch]$Rebuild # rebuild dist/ even when nothing changed
)
$ErrorActionPreference = 'Stop'

function Invoke-Git {
  $out = git -C $App @args
  if ($LASTEXITCODE) { throw "git $($args -join ' ') failed in $App" }
  $out
}

if ((Invoke-Git rev-parse --abbrev-ref HEAD) -ne 'main') { throw "$App isn't on main, so it's been left alone." }
if (Invoke-Git status --porcelain) { throw "$App has changes that aren't committed, so it's been left alone." }

Invoke-Git fetch -q origin
$before = Invoke-Git rev-parse HEAD
Invoke-Git merge -q --ff-only origin/main
$after = Invoke-Git rev-parse HEAD
$changed = if ($before -ne $after) { @(Invoke-Git diff --name-only $before $after) } else { @() }
Write-Host ($(if ($changed) { "Updated $($before.Substring(0, 7)) -> $($after.Substring(0, 7)) ($($changed.Count) files)" } else { 'Already up to date with main.' }))

Push-Location $App
try {
  if ($changed -contains 'package-lock.json') {
    Write-Host 'Packages changed: installing...'
    npm.cmd ci
    if ($LASTEXITCODE) { throw 'npm ci failed' }
  }
  if ($changed -or $Rebuild -or -not (Test-Path 'dist\index.html')) {
    Write-Host 'Rebuilding the PC app...'
    npm.cmd run build:pc | Select-Object -Last 2
    if ($LASTEXITCODE) { throw 'The PC app build failed' }
  }
} finally {
  Pop-Location
}

# The hub picks up a rebuilt dist/ by itself; only its own code needs a restart.
$hub = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" | Where-Object { $_.CommandLine -like "*$App\pc\hub.py*" }
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Aislet hub.lnk'
if ($hub -and ($changed | Where-Object { $_ -like 'pc/*' })) {
  Write-Host 'The hub changed: restarting it...'
  $hub | ForEach-Object { Stop-Process -Id $_.ProcessId }
  Start-Sleep -Seconds 1
  $hub = $null
}
if (-not $hub) {
  if (Test-Path $startup) { Start-Process $startup; Write-Host 'Started the hub.' }
  else { Write-Warning "The hub isn't running and there's no '$startup' to start it with." }
}
Write-Host 'Done.'
