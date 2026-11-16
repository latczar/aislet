# Make the files to share: release/aislet-pc.zip (PC app + hub) and release/Aislet.apk.
# untethered-pc.zip is the same zip under the app's earlier name, for installers saved before the rename (1.0.7 only).
# Run from the project folder after building: npm run build:pc, then scripts/build-android.sh in WSL.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'release'
$stage = Join-Path $env:TEMP 'aislet-stage'
if (-not (Test-Path (Join-Path $root 'dist\index.html'))) { throw 'Build the PC app first: npm run build:pc' }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage, "$stage\pc", "$stage\assets", $out | Out-Null
Copy-Item (Join-Path $root 'dist') $stage -Recurse
Get-ChildItem (Join-Path $root 'pc') -Filter *.py -File | Copy-Item -Destination "$stage\pc"  # every module the hub imports (hub, library, link, ...); not the tests
Copy-Item (Join-Path $root 'assets\icon.ico'), (Join-Path $root 'assets\icon.png') "$stage\assets"  # the .png is for Linux and Mac menus
Copy-Item (Join-Path $root 'app.json'), (Join-Path $root 'LICENSE'), (Join-Path $root 'THIRD_PARTY_LICENSES.md') $stage
$zip = Join-Path $out 'aislet-pc.zip'
Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
# The installer checks downloads against this.
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  aislet-pc.zip" | Set-Content (Join-Path $out 'aislet-pc.zip.sha256') -Encoding ascii
Copy-Item $zip (Join-Path $out 'untethered-pc.zip') -Force
"$hash  untethered-pc.zip" | Set-Content (Join-Path $out 'untethered-pc.zip.sha256') -Encoding ascii
Remove-Item $stage -Recurse -Force

$apk = Join-Path $root 'build\Assistant.apk'
if (Test-Path $apk) { Copy-Item $apk (Join-Path $out 'Aislet.apk') -Force }
Get-ChildItem $out | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
