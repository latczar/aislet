# Aislet installer for Windows: your private AI that works offline.
#
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/latczar/aislet/main/install/install.ps1 | iex
#
# It installs (only what's missing): Ollama, Python and the PDF reader, the Aislet app,
# and an AI model sized for your computer. It then adds Aislet to the Start menu and
# desktop. Nothing is sent anywhere except the downloads themselves.
param(
  [string]$Zip = '',  # optional: install from a local aislet-pc.zip instead of downloading
  [string]$Repo = 'latczar/aislet',
  [ValidateSet('ask', 'yes', 'no')][string]$Phone = 'ask'  # allow the phone through the firewall?
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Join-Path $env:LOCALAPPDATA 'Aislet'
$OldAppDir = Join-Path $env:LOCALAPPDATA 'Untethered\app'  # the app's earlier name; its data is moved by the hub
$AppDir = Join-Path $Root 'app'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE). Fix the problem above and run the installer again." } }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Winget-Install($id) {
  if (-not (Have 'winget')) { throw "winget isn't available. Install 'App Installer' from the Microsoft Store, then run this again." }
  winget install -e --id $id --silent --accept-source-agreements --accept-package-agreements
  Check "Installing $id"
  Refresh-Path
}

try {
  Write-Host 'Aislet installer' -ForegroundColor Green

  Step 'Ollama (runs the AI on this computer)'
  if (Have 'ollama') { Write-Host 'Already installed.' } else { Winget-Install 'Ollama.Ollama' }

  Step 'Python (runs the small hub that links your phone)'
  $pyExe = $null
  foreach ($candidate in @(@('py', '-3'), @('python'))) {
    try {
      $exe = & $candidate[0] $candidate[1..9] -c "import sys; print(sys.executable if sys.version_info >= (3, 10) else '')" 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe) { $pyExe = $exe.Trim(); break }
    } catch {}
  }
  if (-not $pyExe) {
    Winget-Install 'Python.Python.3.12'
    $pyExe = (& py -3 -c "import sys; print(sys.executable)").Trim()
    Check 'Finding Python'
  }
  $pyw = Join-Path (Split-Path $pyExe) 'pythonw.exe'
  Write-Host "Using $pyExe"

  Step 'PDF reader'
  & $pyExe -m pip install --user --quiet --disable-pip-version-check --upgrade 'pypdf>=6.1'
  Check 'Installing the PDF reader'

  Step 'Aislet app'
  $tmp = Join-Path $env:TEMP "aislet-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $zipFile = Join-Path $tmp 'aislet-pc.zip'
  if ($Zip) {
    Copy-Item $Zip $zipFile
  } else {
    $base = "https://github.com/$Repo/releases/latest/download"
    Invoke-WebRequest "$base/aislet-pc.zip" -OutFile $zipFile
    $expected = ((Invoke-WebRequest "$base/aislet-pc.zip.sha256" -UseBasicParsing).Content -split '\s+')[0].Trim().ToLower()
    $actual = (Get-FileHash $zipFile -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw 'The download did not match its checksum, so it was not installed. Please try again later.' }
    Write-Host 'Download verified.'
  }
  $staged = Join-Path $tmp 'app'
  Expand-Archive $zipFile -DestinationPath $staged -Force
  # Stop a running hub from an earlier install before swapping folders.
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -like "*$AppDir*hub.py*" -or $_.CommandLine -like "*$OldAppDir*hub.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force $Root | Out-Null
  $old = "$AppDir.old"
  if (Test-Path $old) { Remove-Item $old -Recurse -Force }
  if (Test-Path $AppDir) { Rename-Item $AppDir $old }
  Move-Item $staged $AppDir
  if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

  Step 'AI model (sized for this computer)'
  $vramGb = 0
  try { $vramGb = [int]((nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1) / 1024) } catch {}
  $model = if ($vramGb -ge 10) { 'qwen3.5:9b' } else { 'qwen3.5:4b' }
  Write-Host "Graphics memory: $vramGb GB, so using $model."
  if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) {
    $ollamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
    if (Test-Path $ollamaApp) { Start-Process $ollamaApp; Start-Sleep -Seconds 5 }
  }
  ollama pull $model; Check "Downloading $model"
  ollama pull nomic-embed-text; Check 'Downloading the notes search model'

  Step 'Start menu and desktop'
  & $pyExe (Join-Path $AppDir 'pc\install_shortcuts.py'); Check 'Adding shortcuts'

  Step 'Phone access (optional)'
  Write-Host 'To use Aislet on your Android phone at home, Windows must let it reach this computer on your home Wi-Fi.'
  $answer = if ($Phone -eq 'ask') { Read-Host 'Allow your phone to connect on private (home) networks? [Y/n]' } else { $Phone }
  if ($answer -notmatch '^(n|no)$') {
    $p = $pyw -replace "'", "''"
    $rule = "Get-NetFirewallApplicationFilter | Where-Object { `$_.Program -eq '$p' } | Get-NetFirewallRule | Where-Object { `$_.Action -eq 'Block' } | Remove-NetFirewallRule; " +
            "Remove-NetFirewallRule -DisplayName 'Untethered hub' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'Aislet hub' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8766 -Program '$p' -Profile Private -RemoteAddress LocalSubnet | Out-Null"
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $proc = Start-Process $ps -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile', '-Command', $rule
    if ($proc.ExitCode -eq 0) {
      Write-Host 'Done: only devices on your home network can reach it, and they still need your pairing code.'
    } else {
      Write-Host "The firewall rule wasn't added. You can allow pythonw.exe on private networks later in Windows Security." -ForegroundColor Yellow
    }
  }

  Step 'Opening Aislet'
  Start-Process $pyw -ArgumentList "`"$(Join-Path $AppDir 'pc\launch.py')`""
  Write-Host "`nAll done. Open Aislet from the Start menu any time." -ForegroundColor Green
  Write-Host 'For your phone: install Aislet.apk from the releases page, then open Settings > Home on this computer and scan the code with the phone's camera.'
} catch {
  Write-Host "`nInstall stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Nothing was half-replaced: an earlier install, if any, is still in place.'
}
