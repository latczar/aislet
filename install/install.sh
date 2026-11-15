#!/bin/sh
# Aislet installer for Linux and Mac: your private AI that works offline.
#
# Run in a terminal:
#   curl -fsSL https://raw.githubusercontent.com/latczar/aislet/main/install/install.sh | sh
#
# It checks for Ollama and Python, sets up the PDF reader, installs the Aislet app, downloads an
# AI model sized for your computer, and adds Aislet to your app menu with its hub starting at login.
# Nothing is sent anywhere except the downloads themselves. It never asks for your password.
#
# Linux is tested (Ubuntu 24.04). The Mac version is written to the same plan but has not been tested yet.
#
# Options (after "sh -s --" when piping):  --zip FILE   install from a local aislet-pc.zip
#                                          --no-models  skip the model downloads
set -eu

REPO="${AISLET_REPO:-latczar/aislet}"
ZIP=""
MODELS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ZIP="$2"; shift 2 ;;
    --no-models) MODELS=0; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
stop() { printf '\nInstall stopped: %s\nNothing was half-replaced: an earlier install, if any, is still in place.\n' "$1"; exit 1; }

case "$(uname -s)" in
  Linux) ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/Aislet"; OS=linux ;;
  Darwin) ROOT="$HOME/Library/Application Support/Aislet"; OS=mac ;;
  *) stop "This installer is for Linux and Mac. On Windows, use install.ps1." ;;
esac
APP_DIR="$ROOT/app"
echo "Aislet installer"

step "Ollama (runs the AI on this computer)"
if have ollama; then
  echo "Already installed."
elif [ "$OS" = mac ] && [ -x /Applications/Ollama.app/Contents/Resources/ollama ]; then
  PATH="/Applications/Ollama.app/Contents/Resources:$PATH"
  echo "Already installed."
elif [ "$OS" = mac ]; then
  stop "Ollama isn't installed. Download it from https://ollama.com/download (or: brew install ollama), open it once, then run this again."
else
  stop "Ollama isn't installed. Install it with its own installer (it asks for your password):
    curl -fsSL https://ollama.com/install.sh | sh
then run this again."
fi

step "Python (runs the small hub that links your phone)"
PY=""
for candidate in python3 python; do
  if have "$candidate" && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PY="$(command -v "$candidate")"; break
  fi
done
if [ -z "$PY" ]; then
  if [ "$OS" = mac ]; then stop "Python 3.10 or newer is needed. Install it from https://www.python.org/downloads/ (or: brew install python), then run this again."; fi
  stop "Python 3.10 or newer is needed. Install it with your package manager (for example: sudo apt install python3), then run this again."
fi
echo "Using $PY"

step "PDF reader"
# The hub runs from its own Python environment, so nothing is added to the system's Python.
VENV="$ROOT/python"
mkdir -p "$ROOT"
if "$PY" -m venv "$VENV" >/dev/null 2>&1 && "$VENV/bin/python" -m pip install --quiet --disable-pip-version-check --upgrade 'pypdf>=6.1'; then
  HUB_PY="$VENV/bin/python"
  echo "Ready."
else
  rm -rf "$VENV"
  HUB_PY="$PY"
  echo "Couldn't set up the PDF reader, so the laptop won't read PDFs yet. Everything else works."
  echo "To add it later: install your system's venv package (for example: sudo apt install python3-venv), then run this again."
fi

step "Aislet app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -n "$ZIP" ]; then
  cp "$ZIP" "$TMP/aislet-pc.zip"
else
  BASE="https://github.com/$REPO/releases/latest/download"
  curl -fsSL "$BASE/aislet-pc.zip" -o "$TMP/aislet-pc.zip" || stop "Couldn't download the app. Check your internet connection."
  EXPECTED="$(curl -fsSL "$BASE/aislet-pc.zip.sha256" | awk '{print tolower($1)}')"
  if have sha256sum; then ACTUAL="$(sha256sum "$TMP/aislet-pc.zip" | awk '{print $1}')"
  else ACTUAL="$(shasum -a 256 "$TMP/aislet-pc.zip" | awk '{print $1}')"; fi
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || stop "The download did not match its checksum, so it was not installed. Please try again later."
  echo "Download verified."
fi
# Unpack with Python: it's always here (unzip may not be), and this refuses paths that leave the folder.
"$PY" - "$TMP/aislet-pc.zip" "$TMP/app" <<'EOF'
import sys, zipfile
from pathlib import Path
src, root = sys.argv[1], Path(sys.argv[2]).resolve()
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        name = info.filename.replace("\\", "/")  # zips made on Windows may use backslashes
        target = (root / name).resolve()
        if root != target and root not in target.parents:
            sys.exit(f"Unsafe path in the zip: {info.filename}")
        if name.endswith("/"):
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(info))
EOF
[ -f "$TMP/app/pc/hub.py" ] || stop "The download didn't contain the app."
# Stop a running hub from an earlier install before swapping folders.
pkill -f "$APP_DIR/pc/hub.py" 2>/dev/null || true
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$TMP/app" "$APP_DIR"
rm -rf "$APP_DIR.old"
echo "Installed in $APP_DIR"

if [ "$MODELS" = 1 ]; then
  step "AI model (sized for this computer)"
  if ! ollama list >/dev/null 2>&1; then
    if [ "$OS" = mac ] && [ -d /Applications/Ollama.app ]; then open -a Ollama; else (ollama serve >/dev/null 2>&1 &); fi
    sleep 5
  fi
  GB=0
  if [ "$OS" = mac ]; then
    GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 / 2 ))  # about half of a Mac's memory can go to the AI
  elif have nvidia-smi; then
    GB=$(( $(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n1 || echo 0) / 1024 ))
  fi
  if [ "$GB" -ge 10 ]; then MODEL=qwen3.5:9b; else MODEL=qwen3.5:4b; fi
  echo "Graphics memory: about $GB GB, so using $MODEL."
  ollama pull "$MODEL" || stop "Downloading $MODEL failed."
  ollama pull nomic-embed-text || stop "Downloading the notes search model failed."
fi

step "App menu and login"
"$HUB_PY" "$APP_DIR/pc/install_shortcuts.py" || stop "Adding the shortcuts failed."

step "Phone access"
if [ "$OS" = linux ]; then
  echo "Your phone reaches this computer on port 8766 over your home Wi-Fi. If a firewall is on (for example ufw),"
  echo "allow your home network only:  sudo ufw allow from 192.168.0.0/16 to any port 8766 proto tcp"
else
  echo "The first time your phone connects, macOS may ask whether Python can accept connections: choose Allow."
fi

step "Opening Aislet"
"$HUB_PY" "$APP_DIR/pc/launch.py" >/dev/null 2>&1 || echo "Open http://localhost:8766 in your browser."
echo
echo "All done. Open Aislet from your app menu any time."
echo "For your phone: install Aislet.apk from the releases page, then open Settings > Home on this computer and scan the code with the phone's camera."
