"""Add the app to the Start menu and desktop, and start the hub at login. Run again any time.

python pc/install_shortcuts.py            add (or refresh) the shortcuts
python pc/install_shortcuts.py --remove   remove them (your data stays)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
NAME = json.loads((APP / "app.json").read_text(encoding="utf-8"))["expo"]["name"]
PROGRAMS = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs"
DESKTOP = Path(os.environ["USERPROFILE"]) / "Desktop"
LINKS = {  # shortcut -> script it runs
    PROGRAMS / f"{NAME}.lnk": "pc/launch.py",
    DESKTOP / f"{NAME}.lnk": "pc/launch.py",
    PROGRAMS / f"Startup/{NAME} hub.lnk": "pc/hub.py",
}
OLD = (  # shortcuts from earlier names
    [PROGRAMS / f"{old}.lnk" for old in ("Assistant", "Ember", "Unplugged")]
    + [DESKTOP / f"{old}.lnk" for old in ("Assistant", "Ember", "Unplugged")]
    + [PROGRAMS / f"Startup/{old} hub.lnk" for old in ("Ember", "Unplugged")]
)


def make(link: Path, script: str) -> None:
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    q = lambda s: str(s).replace("'", "''")
    command = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}');"
        "$s.TargetPath = '{exe}'; $s.Arguments = '\"{arg}\"'; $s.WorkingDirectory = '{cwd}';"
        "$s.IconLocation = '{icon}'; $s.Description = 'Your private AI that works offline'; $s.Save()"
    ).format(lnk=q(link), exe=q(pythonw if pythonw.exists() else sys.executable), arg=q(APP / script),
             cwd=q(APP), icon=q(APP / "assets/icon.ico"))
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], check=True)


if __name__ == "__main__":
    for old in OLD:
        old.unlink(missing_ok=True)
    for link, script in LINKS.items():
        if "--remove" in sys.argv:
            link.unlink(missing_ok=True)
        else:
            make(link, script)
    print("Removed." if "--remove" in sys.argv else f"Added {NAME} to the Start menu and desktop, and its hub to startup.")
