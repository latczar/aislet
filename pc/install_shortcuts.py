"""Add the app to the computer's app list, and start the hub at login. Run again any time.

python pc/install_shortcuts.py            add (or refresh) the shortcuts
python pc/install_shortcuts.py --remove   remove them (your data stays)

Windows: the Start menu, the desktop and Startup. Linux: the app menu and the desktop's autostart folder.
Mac (untested): ~/Applications/Aislet.app and a login item (a LaunchAgent).
Shortcuts from the app's earlier names (Untethered, Unplugged, Ember, Assistant) are removed.
The shortcuts run this Python, so run this script with the Python the hub should use.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
NAME = json.loads((APP / "app.json").read_text(encoding="utf-8"))["expo"]["name"]
DESCRIPTION = "Your private AI that works offline"
PYTHON = Path(sys.executable)


# ---- Windows ---------------------------------------------------------------------------------

def windows_links() -> dict[Path, str]:
    programs = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs"
    desktop = Path(os.environ["USERPROFILE"]) / "Desktop"
    return {  # shortcut -> script it runs
        programs / f"{NAME}.lnk": "pc/launch.py",
        desktop / f"{NAME}.lnk": "pc/launch.py",
        programs / f"Startup/{NAME} hub.lnk": "pc/hub.py",
    }


def windows_old() -> list[Path]:  # shortcuts from earlier names
    programs = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs"
    desktop = Path(os.environ["USERPROFILE"]) / "Desktop"
    return ([programs / f"{old}.lnk" for old in ("Assistant", "Ember", "Unplugged", "Untethered")]
            + [desktop / f"{old}.lnk" for old in ("Assistant", "Ember", "Unplugged", "Untethered")]
            + [programs / f"Startup/{old} hub.lnk" for old in ("Ember", "Unplugged", "Untethered")])


def windows_link(link: Path, script: str) -> None:
    pythonw = PYTHON.with_name("pythonw.exe")
    q = lambda s: str(s).replace("'", "''")
    command = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}');"
        "$s.TargetPath = '{exe}'; $s.Arguments = '\"{arg}\"'; $s.WorkingDirectory = '{cwd}';"
        "$s.IconLocation = '{icon}'; $s.Description = '{desc}'; $s.Save()"
    ).format(lnk=q(link), exe=q(pythonw if pythonw.exists() else PYTHON), arg=q(APP / script),
             cwd=q(APP), icon=q(APP / "assets/icon.ico"), desc=DESCRIPTION)
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], check=True)


def windows(remove: bool) -> str:
    for old in windows_old():
        old.unlink(missing_ok=True)
    for link, script in windows_links().items():
        if remove:
            link.unlink(missing_ok=True)
        else:
            windows_link(link, script)
    return f"Added {NAME} to the Start menu and desktop, and its hub to startup."


# ---- Linux: freedesktop.org menu entries --------------------------------------------------------

def exec_arg(path: Path) -> str:
    """One argument for a .desktop file's Exec line, quoted as the spec asks."""
    text = str(path)
    for ch in ("\\", '"', "`", "$"):
        text = text.replace(ch, "\\" + ch)
    return f'"{text}"'.replace("%", "%%")


def linux(remove: bool) -> str:
    data = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    entries = {
        data / "applications/aislet.desktop": (
            "pc/launch.py", f"Name={NAME}\nComment={DESCRIPTION}\nCategories=Utility;\n"),
        config / "autostart/aislet-hub.desktop": (
            "pc/hub.py", f"Name={NAME} hub\nComment=Links {NAME} on your phone to this computer\nNoDisplay=true\n"
                         "X-GNOME-Autostart-enabled=true\n"),
    }
    for path, (script, extra) in entries.items():
        if remove:
            path.unlink(missing_ok=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "[Desktop Entry]\nType=Application\n" + extra
            + f"Exec={exec_arg(PYTHON)} {exec_arg(APP / script)}\nPath={APP}\nIcon={APP / 'assets/icon.png'}\nTerminal=false\n",
            encoding="utf-8",
        )
    return f"Added {NAME} to the app menu, and its hub to the programs that start when you log in."


# ---- Mac (untested): an app in ~/Applications and a LaunchAgent ---------------------------------

def plist(values: dict) -> str:
    def value(v) -> str:
        if isinstance(v, bool):
            return "<true/>" if v else "<false/>"
        if isinstance(v, list):
            return "<array>" + "".join(value(x) for x in v) + "</array>"
        return "<string>" + str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") + "</string>"
    body = "".join(f"<key>{k}</key>{value(v)}" for k, v in values.items())
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
            f'"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>{body}</dict></plist>\n')


def mac(remove: bool) -> str:
    bundle = Path.home() / f"Applications/{NAME}.app"
    agent = Path.home() / "Library/LaunchAgents/app.aislet.hub.plist"
    if remove:
        agent.unlink(missing_ok=True)
        for f in (bundle / "Contents/MacOS" / NAME, bundle / "Contents/Info.plist"):
            f.unlink(missing_ok=True)
        for d in (bundle / "Contents/MacOS", bundle / "Contents", bundle):
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
        return "Removed."
    q = lambda p: "'" + str(p).replace("'", "'\\''") + "'"
    (bundle / "Contents/MacOS").mkdir(parents=True, exist_ok=True)
    script = bundle / "Contents/MacOS" / NAME
    script.write_text(f"#!/bin/sh\nexec {q(PYTHON)} {q(APP / 'pc/launch.py')}\n", encoding="utf-8")
    script.chmod(0o755)
    (bundle / "Contents/Info.plist").write_text(plist({
        "CFBundleName": NAME, "CFBundleDisplayName": NAME, "CFBundleIdentifier": "app.aislet.launcher",
        "CFBundleExecutable": NAME, "CFBundlePackageType": "APPL", "LSUIElement": True,
    }), encoding="utf-8")
    agent.parent.mkdir(parents=True, exist_ok=True)
    agent.write_text(plist({
        "Label": "app.aislet.hub", "ProgramArguments": [str(PYTHON), str(APP / "pc/hub.py")],
        "WorkingDirectory": str(APP), "RunAtLoad": True,
    }), encoding="utf-8")
    return f"Added {NAME} to ~/Applications, and its hub to your login items."


if __name__ == "__main__":
    remove = "--remove" in sys.argv
    done = windows(remove) if os.name == "nt" else mac(remove) if sys.platform == "darwin" else linux(remove)
    print("Removed." if remove else done)
