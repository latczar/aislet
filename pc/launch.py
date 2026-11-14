"""Open the app on this PC in its own window, starting the hub first if it isn't running.

The app is opened with the hub's secret PC token in the address (after #, so it is never sent
over the network); the app keeps it and uses it to talk to the hub.
The Start menu and desktop shortcuts run this with pythonw, so no console appears.
"""
import json
import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("UNTETHERED_PORT", "8766"))
STORE = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Untethered" / "hub.json"
BROWSERS = [
    Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
]


def running() -> bool:
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=0.5).close()
        return True
    except OSError:
        return False


def start_hub() -> None:
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0
    subprocess.Popen([str(pythonw if pythonw.exists() else sys.executable), str(APP / "pc/hub.py")],
                     cwd=APP, creationflags=flags, close_fds=True)
    for _ in range(40):
        if running():
            return
        time.sleep(0.25)


def app_url() -> str:
    token = ""
    for _ in range(20):  # the hub writes its token when it starts
        try:
            token = json.loads(STORE.read_text(encoding="utf-8")).get("local_token", "")
            break
        except (OSError, ValueError):
            time.sleep(0.25)
    return f"http://localhost:{PORT}/#t={token}" if token else f"http://localhost:{PORT}/"


def main() -> None:
    if not running():
        start_hub()
    url = app_url()
    for browser in BROWSERS:
        if browser.is_file():
            subprocess.Popen([str(browser), f"--app={url}"])
            return
    webbrowser.open(url)


if __name__ == "__main__":
    main()
