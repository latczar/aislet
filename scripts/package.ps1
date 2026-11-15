# Make the files to share: release/untethered-pc.zip (PC app + hub) and release/Untethered.apk.
# Run from the project folder after building: npm run build:pc, then scripts/build-android.sh in WSL.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'release'
$stage = Join-Path $env:TEMP 'untethered-stage'
if (-not (Test-Path (Join-Path $root 'dist\index.html'))) { throw 'Build the PC app first: npm run build:pc' }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage, "$stage\pc", "$stage\assets", $out | Out-Null
Copy-Item (Join-Path $root 'dist') $stage -Recurse
Copy-Item (Join-Path $root 'pc\hub.py'), (Join-Path $root 'pc\launch.py'), (Join-Path $root 'pc\install_shortcuts.py') "$stage\pc"
Copy-Item (Join-Path $root 'assets\icon.ico'), (Join-Path $root 'assets\icon.png') "$stage\assets"  # the .png is for Linux and Mac menus
Copy-Item (Join-Path $root 'app.json'), (Join-Path $root 'LICENSE'), (Join-Path $root 'THIRD_PARTY_LICENSES.md') $stage
$zip = Join-Path $out 'untethered-pc.zip'
Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
# The installer checks downloads against this.
"$((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower())  untethered-pc.zip" | Set-Content (Join-Path $out 'untethered-pc.zip.sha256') -Encoding ascii
Remove-Item $stage -Recurse -Force

$apk = Join-Path $root 'build\Assistant.apk'
if (Test-Path $apk) { Copy-Item $apk (Join-Path $out 'Untethered.apk') -Force }
Get-ChildItem $out | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
