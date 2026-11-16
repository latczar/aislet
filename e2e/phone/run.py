#!/usr/bin/env python3
"""End-to-end checks for the Aislet phone app, run on a real Android phone over adb.

Drives the installed app with adb taps and typing, reads the screen with uiautomator, and prints one
PASS or FAIL line per check. Exits non-zero if any check fails. Python standard library only.

    python e2e/phone/run.py                  # every check
    python e2e/phone/run.py --list           # list the checks
    python e2e/phone/run.py chat_typing memory

Before running: unlock the phone and leave it on its home screen or in Aislet. The runner refuses to
start while another app is in front, and checks again before every tap, key, swipe and launch, so it never
types into something else. If another app comes to the front during a run, the current check stops.

Test data is made up ("E2E ..." text) and removed afterwards: the test chat is deleted, test facts are
forgotten, a saved test note is deleted, and changed fields and settings are put back as they were. On a failure
a screenshot and screen dump go to e2e/phone/out/.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import struct
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from pathlib import Path

PKG = 'app.untethered.assistant'
OUT = Path(__file__).resolve().parent / 'out'
LAUNCHERS = ('launcher', 'nexuslauncher', 'trebuchet', 'lawnchair')
# The keyboard covers the message box if it reaches this close (px).
MARGIN = 2


class CheckFailed(Exception):
    pass


# ---------- adb ----------

def adb(*args: str, timeout: float = 30, check: bool = True) -> str:
    cmd = [os.environ.get('ADB', 'adb'), *args]
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise CheckFailed(f"adb timed out: {' '.join(args)}") from e
    out = done.stdout.decode('utf-8', 'replace')
    if check and done.returncode != 0:
        raise CheckFailed(f"adb {' '.join(args)} failed: {done.stderr.decode('utf-8', 'replace').strip() or out.strip()}")
    return out


def shell(command: str, timeout: float = 30) -> str:
    # Every tap, key, swipe and launch first checks that Aislet or the home screen is in front, so nothing
    # lands in another app if someone picks up the phone during a run.
    if command.startswith(('input ', 'am start')):
        front = foreground()
        if front != PKG and not any(l in front for l in LAUNCHERS) and not (picker_open and PICKER in front):
            raise CheckFailed(f'stopped: another app is in front ({front or "unknown"})')
        if panel_open():
            raise CheckFailed('stopped: the notification panel is open (someone is using the phone)')
    return adb('shell', command, timeout=timeout)


def key(code: int | str) -> None:
    shell(f'input keyevent {code}')


def tap_xy(x: int, y: int) -> None:
    shell(f'input tap {x} {y}')


SAFE_TEXT = re.compile(r"^[A-Za-z0-9 .,:\-]*$")


def type_text(text: str) -> None:
    """Type into the focused field. Test text sticks to letters, digits and simple punctuation."""
    if not SAFE_TEXT.match(text):
        raise ValueError(f'unsupported characters in test text: {text!r}')
    for start in range(0, len(text), 40):  # long strings in one go can drop characters
        chunk = text[start:start + 40].replace(' ', '%s')
        shell(f"input text '{chunk}'")


def clear_focused_field() -> None:
    shell('input keycombination 113 29')  # Ctrl+A
    key(67)  # delete


def panel_open() -> bool:
    """The notification or quick-settings panel is pulled down. The app underneath still counts as in front."""
    return 'NotificationShade' in adb('shell', 'dumpsys window | grep -m1 mCurrentFocus', check=False)


def foreground() -> str:
    out = shell('dumpsys activity activities')
    m = re.search(r'(?:topResumedActivity|mResumedActivity|ResumedActivity)[^\n]*?\s(\S+)/(\S+)', out)
    return m.group(1) if m else ''


def keyboard_top() -> int | None:
    """Screen y (px) of the top of the on-screen keyboard, or None when it's hidden."""
    if 'mInputShown=true' not in shell('dumpsys input_method'):
        return None
    win = shell('dumpsys window InputMethod')
    frame = re.search(r'\sframe=\[(\d+),(\d+)\]\[(\d+),(\d+)\]', win)
    insets = re.search(r'mGivenContentInsets=\[\d+,(\d+)\]', win)
    if not frame or 'isVisible=true' not in win:
        return None
    return int(frame.group(2)) + (int(insets.group(1)) if insets else 0)


def wait_keyboard(shown: bool, timeout: float = 5) -> int | None:
    end = time.time() + timeout
    while time.time() < end:
        top = keyboard_top()
        if (top is not None) == shown:
            return top
        time.sleep(0.3)
    raise CheckFailed('keyboard did not ' + ('open' if shown else 'close'))


def hide_keyboard() -> None:
    if keyboard_top() is not None:
        key(4)  # back closes the keyboard (only pressed when it's open)
        wait_keyboard(False)


# ---------- screen ----------

@dataclass
class Node:
    text: str
    desc: str
    cls: str
    checked: bool
    enabled: bool
    focused: bool
    clickable: bool
    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def cx(self) -> int:
        return (self.x1 + self.x2) // 2

    @property
    def cy(self) -> int:
        return (self.y1 + self.y2) // 2

    @property
    def height(self) -> int:
        return self.y2 - self.y1

    @property
    def label(self) -> str:
        return self.text or self.desc


def screen() -> list[Node]:
    """Everything uiautomator can see in the app's window."""
    for attempt in range(6):
        raw = adb('exec-out', 'uiautomator', 'dump', '/dev/tty', timeout=40, check=False)
        start, end = raw.find('<?xml'), raw.rfind('</hierarchy>')
        if start >= 0 and end > start:
            root = ET.fromstring(raw[start:end + len('</hierarchy>')])
            nodes = []
            for n in root.iter('node'):
                b = re.match(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', n.get('bounds', ''))
                if not b:
                    continue
                nodes.append(Node(
                    n.get('text', ''), n.get('content-desc', ''), n.get('class', ''), n.get('checked') == 'true',
                    n.get('enabled') == 'true', n.get('focused') == 'true', n.get('clickable') == 'true', *map(int, b.groups()),
                ))
            return nodes
        time.sleep(0.5 + attempt * 0.3)  # uiautomator waits for an idle screen; animations can delay it
    raise CheckFailed('could not read the screen (uiautomator dump failed)')


def find(nodes: list[Node], text: str | None = None, desc: str | None = None, contains: str | None = None,
         cls: str | None = None) -> list[Node]:
    out = []
    for n in nodes:
        if text is not None and n.text != text:
            continue
        if desc is not None and n.desc != desc:
            continue
        if contains is not None and contains.lower() not in (n.text + ' ' + n.desc).lower():
            continue
        if cls is not None and not n.cls.endswith(cls):
            continue
        if n.x2 <= n.x1 or n.y2 <= n.y1:
            continue
        out.append(n)
    return out


def wait_for(what: str, timeout: float = 10, **match) -> Node:
    end = time.time() + timeout
    while True:
        hits = find(screen(), **match)
        if hits:
            return hits[0]
        if time.time() > end:
            raise CheckFailed(f'{what} did not appear within {timeout:.0f} s')
        time.sleep(0.4)


def wait_gone(what: str, timeout: float = 10, **match) -> None:
    end = time.time() + timeout
    while find(screen(), **match):
        if time.time() > end:
            raise CheckFailed(f'{what} still showing after {timeout:.0f} s')
        time.sleep(0.4)


def tap(node: Node) -> None:
    top = keyboard_top()
    if top is not None and node.cy >= top - MARGIN:
        raise CheckFailed(f"'{node.label}' is behind the keyboard (y={node.cy}, keyboard top={top})")
    tap_xy(node.cx, node.cy)


def screen_height() -> int:
    m = re.search(r'(\d+)x(\d+)', shell('wm size'))
    return int(m.group(2)) if m else 2340


def px_per_dp() -> float:
    out = shell('wm density')
    m = re.search(r'Override density: (\d+)', out) or re.search(r'Physical density: (\d+)', out)
    return int(m.group(1)) / 160 if m else 2.625


def scroll_to(what: str, timeout_swipes: int = 10, up: bool = False, **match) -> Node:
    hide_keyboard()  # a swipe that starts on the keyboard types instead of scrolling
    h = screen_height()
    for _ in range(timeout_swipes):
        hits = [n for n in find(screen(), **match) if 150 < n.cy < h - 300]
        if hits:
            return hits[0]
        if up:
            shell(f'input swipe 540 {int(h * 0.35)} 540 {int(h * 0.7)} 300')
        else:
            shell(f'input swipe 540 {int(h * 0.7)} 540 {int(h * 0.35)} 300')
        time.sleep(0.6)
    raise CheckFailed(f'could not scroll to {what}')


def scroll_to_top() -> None:
    hide_keyboard()
    h = screen_height()
    for _ in range(4):
        shell(f'input swipe 540 {int(h * 0.3)} 540 {int(h * 0.8)} 200')
    time.sleep(0.5)


def go_tab(name: str) -> None:
    hide_keyboard()
    tab = wait_for(f'the {name} tab', text=name)
    tap(tab)
    time.sleep(1)


def editable(nodes: list[Node]) -> list[Node]:
    return [n for n in nodes if n.cls.endswith('EditText')]


def labelled_field(label: str, swipes: int = 10) -> Node:
    """The text box with this label, scrolled into view."""
    tag = scroll_to(f'the {label} box', timeout_swipes=swipes, text=label)
    boxes = editable(screen())
    if not boxes:
        raise CheckFailed(f'no text box near "{label}"')
    return min(boxes, key=lambda b: 0 if b.y1 <= tag.cy <= b.y2 else min(abs(b.y1 - tag.cy), abs(b.y2 - tag.cy)))


def field_above_keyboard(field: Node, top: int, what: str) -> None:
    if field.y2 > top + MARGIN:
        raise CheckFailed(f'{what} is behind the keyboard (bottom y={field.y2}, keyboard top={top})')
    if field.y1 < 0:
        raise CheckFailed(f'{what} is off the top of the screen')


def confirm_alert(button: str) -> None:
    """Press a button in a native Android alert (button labels may be shown in capitals)."""
    end = time.time() + 6
    while time.time() < end:
        for n in screen():
            if n.text.lower() == button.lower() and n.cls.endswith('Button'):
                tap_xy(n.cx, n.cy)
                time.sleep(0.8)
                return
        time.sleep(0.3)
    raise CheckFailed(f"no '{button}' button in the alert")


def row_button(row_text_contains: str, desc: str) -> Node | None:
    """The button with this label on the same row as some text (e.g. a fact's Forget button)."""
    nodes = screen()
    rows = find(nodes, contains=row_text_contains)
    buttons = find(nodes, desc=desc)
    for r in rows:
        for b in buttons:
            if b.y1 <= r.cy <= b.y2 or r.y1 <= b.cy <= r.y2:
                return b
    return None


def save_evidence(name: str) -> None:
    OUT.mkdir(exist_ok=True)
    stamp = time.strftime('%H%M%S')
    try:
        png = subprocess.run([os.environ.get('ADB', 'adb'), 'exec-out', 'screencap', '-p'], capture_output=True, timeout=20).stdout
        (OUT / f'{stamp}-{name}.png').write_bytes(png)
        xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty', timeout=40, check=False)
        (OUT / f'{stamp}-{name}.xml').write_text(xml, encoding='utf-8')
    except Exception:  # evidence is best effort
        pass


# ---------- the checks ----------

PROMPT = 'E2E check: reply with one word, pong'
FACTS = ['E2E test fact: favourite colour is teal', 'E2E test fact: likes the colour teal best']


def check_launch() -> str:
    """Start the app from cold and wait until its AI is ready."""
    key(3)  # home first, so closing the app can't bring another app to the front
    time.sleep(1)
    shell(f'am force-stop {PKG}')
    # A fresh task (NEW_TASK | CLEAR_TASK), so a browser tab the app opened earlier can't stay on top.
    shell(f'am start -W -n {PKG}/.MainActivity -f 0x10008000')
    wait_for('the Chat tab', timeout=20, text='Chat')
    go_tab('Chat')  # the app reopens on the screen that was open last time
    status = wait_for('a ready AI (status ending "private")', timeout=90, contains='· private')
    if foreground() != PKG:
        raise CheckFailed('the app is not in front after launching')
    return status.text


def open_new_chat() -> Node:
    go_tab('Chat')
    tap(wait_for('the New chat button', desc='New chat'))
    time.sleep(0.8)
    boxes = editable(screen())
    if not boxes:
        raise CheckFailed('no message box on the chat screen')
    return boxes[-1]


def message_box() -> Node:
    boxes = editable(screen())
    if not boxes:
        raise CheckFailed('message box disappeared')
    return boxes[-1]


def check_chat_typing() -> str:
    """Typing in the message box shows the text, the box and Send stay above the keyboard, and Back closes the attach menu."""
    tap(open_new_chat())
    top = wait_keyboard(True)
    text = 'E2E typing check 123'
    type_text(text)
    time.sleep(0.6)
    box = message_box()
    if box.text != text:
        raise CheckFailed(f'message box shows {box.text!r}, expected {text!r}')
    field_above_keyboard(box, top, 'the message box')
    send = find(screen(), desc='Send')
    if not send:
        raise CheckFailed('no Send button while typing')
    field_above_keyboard(send[0], top, 'the Send button')
    if find(screen(), text='Memory'):
        raise CheckFailed('the tabs should hide while typing')
    one_line = box.height

    # Long text grows the box up to its limit, still above the keyboard.
    clear_focused_field()
    type_text('E2E long text check, line after line. ' * 12)
    time.sleep(0.8)
    box = message_box()
    limit = 160 * px_per_dp() + 4
    if not box.text.startswith('E2E long text check'):
        raise CheckFailed(f'long text not shown: {box.text[:40]!r}')
    if box.height <= one_line * 1.5:
        raise CheckFailed(f'box did not grow for long text ({one_line}px to {box.height}px)')
    if box.height > limit:
        raise CheckFailed(f'box grew past its limit ({box.height}px > {limit:.0f}px)')
    field_above_keyboard(box, wait_keyboard(True), 'the message box with long text')
    grown = box.height

    clear_focused_field()
    time.sleep(0.6)
    if message_box().height >= grown:
        raise CheckFailed('box did not shrink after clearing')
    hide_keyboard()

    # The attach menu opens, and Back closes it without leaving the app.
    tap(wait_for('the attach button', desc='Attach a photo or file'))
    wait_for('the attach menu', timeout=5, text='PDF or text file')
    key(4)
    time.sleep(1)
    if foreground() != PKG:
        raise CheckFailed('Back with the attach menu open left the app')
    if find(screen(), text='PDF or text file'):
        raise CheckFailed('Back did not close the attach menu')
    return f'box {one_line}px, grows to {grown}px (limit {limit:.0f}px), keyboard top {top}; Back closes the attach menu'


def delete_test_chat() -> bool:
    hide_keyboard()
    go_tab('Chat')
    tap(wait_for('the Chats button', desc='Chats'))
    time.sleep(1)
    deleted = False
    for _ in range(3):
        b = row_button('E2E check', 'Delete chat')
        if not b:
            break
        tap_xy(b.cx, b.cy)
        confirm_alert('Delete')
        deleted = True
    key(4)  # close the chat list
    time.sleep(0.8)
    return deleted


def check_chat_send() -> str:
    """Send a message by tapping Send with the keyboard open, and get a reply."""
    tap(open_new_chat())
    wait_keyboard(True)
    type_text(PROMPT)
    time.sleep(0.5)
    if message_box().text != PROMPT:
        raise CheckFailed(f'message box shows {message_box().text!r}')
    send = find(screen(), desc='Send')
    if not send:
        raise CheckFailed('no Send button')
    tap(send[0])  # fails if Send is under the keyboard, where a tap would type instead
    started = time.time()
    try:
        wait_for('the sent message in the thread', timeout=10, text=PROMPT)
        if message_box().text not in ('', 'Message'):
            raise CheckFailed(f'message box not cleared after sending: {message_box().text!r}')
        hide_keyboard()
        end = time.time() + 180
        while True:
            nodes = screen()
            if find(nodes, desc='Copy') and not find(nodes, desc='Stop'):
                break
            problem = find(nodes, text='Dismiss')
            if problem:
                raise CheckFailed('the reply failed with an error card')
            if time.time() > end:
                raise CheckFailed('no reply within 180 s')
            time.sleep(1.5)
        return f'reply in {time.time() - started:.0f} s'
    finally:
        if not delete_test_chat():
            print('  note: could not find the test chat to delete', file=sys.stderr)


def type_check(what: str, field: Node, text: str) -> None:
    tap(field)
    wait_keyboard(True)
    clear_focused_field()
    type_text(text)
    time.sleep(0.6)
    now = [n for n in editable(screen()) if n.focused] or editable(screen())
    shown = now[0]
    if shown.text != text:
        raise CheckFailed(f'{what} shows {shown.text!r}, expected {text!r}')
    field_above_keyboard(shown, wait_keyboard(True), what)
    clear_focused_field()


def append_and_restore(what: str, field: Node, extra: str = ' e2e') -> None:
    """Type at the end of a field that saves itself, check it, then delete exactly what was typed."""
    original = field.text
    tap(field)
    wait_keyboard(True)
    key(123)  # cursor to the end
    type_text(extra)
    time.sleep(0.6)
    focused = [n for n in editable(screen()) if n.focused]
    if not focused:
        raise CheckFailed(f'{what} lost focus while typing')
    try:
        if not focused[0].text.endswith(extra):
            raise CheckFailed(f'{what} shows {focused[0].text!r} after typing {extra!r}')
        field_above_keyboard(focused[0], wait_keyboard(True), what)
    finally:
        key(123)
        for _ in extra:
            key(67)
        time.sleep(0.5)
        after = [n for n in editable(screen()) if n.focused]
        if after and original and after[0].text != original:
            raise CheckFailed(f'could not put {what} back: now {after[0].text!r}, was {original!r}')
        hide_keyboard()


def check_text_fields() -> str:
    """Typing shows in Memory's add-a-fact box, a new note, and Settings (put back afterwards)."""
    go_tab('Memory')
    scroll_to_top()
    fact_box = wait_for('the Add a fact box', contains='Add a fact', cls='EditText')
    type_check('the Add a fact box', fact_box, 'E2E field check')
    hide_keyboard()

    go_tab('Notes')
    tap(wait_for('the New note button', text='New note'))
    time.sleep(0.8)
    fields = editable(screen())
    if len(fields) < 2:
        raise CheckFailed('new note has no title and text boxes')
    type_check('the note title', fields[0], 'E2E note title')
    type_check('the note text', editable(screen())[1], 'E2E note body text')
    hide_keyboard()
    tap(wait_for('Cancel', text='Cancel'))
    time.sleep(0.8)
    if find(screen(), contains='E2E note'):
        raise CheckFailed('a test note was saved')

    go_tab('Settings')
    scroll_to_top()
    append_and_restore('Your name', labelled_field('Your name'))
    append_and_restore('Custom instructions', labelled_field('Custom instructions'))
    scroll_to_top()
    return 'memory, note title and text, your name, custom instructions'


def check_find_laptop() -> str:
    """Pairing status in Settings → Home, and Find my laptop (never unpairs)."""
    go_tab('Settings')
    scroll_to_top()
    try:
        scroll_to('the Home section', timeout_swipes=8, contains="Use the laptop's AI")
        paired = True
    except CheckFailed:
        paired = False
    if paired:
        nodes = screen()
        if find(nodes, contains='Laptop not reachable'):
            raise CheckFailed('paired, but the laptop is not reachable')
        if not find(nodes, contains='Connected to'):
            raise CheckFailed('paired, but no "Connected to" status')
        laptop_ai = [n for n in nodes if n.cls.endswith('Switch')]
        ai = f"; laptop's AI {'on' if laptop_ai[-1].checked else 'off'}" if laptop_ai else ''
        # While connected, Find again lives under Advanced.
        tap(scroll_to('Show advanced settings', text='Show advanced settings'))
        tap(scroll_to('Find again', text='Find again'))
        found = wait_for('"Found it at …"', timeout=60, contains='Found it at')
        where = re.search(r'Found it at (\S+)', found.label)
        scroll_to_top()
        wait_for('the connected status after finding', timeout=20, contains='Connected to')
        return f"paired and connected; Find again found it at {where.group(1) if where else '?'}{ai}"

    # Not paired: Find my laptop should list the laptop. It doesn't pair (that needs the code).
    tap(scroll_to('Find my laptop', text='Find my laptop'))
    end = time.time() + 60
    while time.time() < end:
        nodes = screen()
        ips = [n for n in nodes if re.fullmatch(r'\d+\.\d+\.\d+\.\d+', n.text)]
        if ips:
            scroll_to_top()
            return f'not paired; found a laptop at {ips[0].text} (did not pair)'
        if find(nodes, contains='No laptop found'):
            raise CheckFailed('Find my laptop found nothing')
        time.sleep(1)
    raise CheckFailed('Find my laptop found nothing within 60 s')


# Made up: no laptop answers at this address, and the code is never a real one (it only uses the hub's letters).
PAIR_ADDRESS = '192.168.255.254'
PAIR_CODE = 'E2ETESTS'


def open_link(url: str) -> None:
    """Open a link in Aislet, as the camera app does after scanning a QR code."""
    out = shell(f"am start -W -a android.intent.action.VIEW -d '{url}' -p {PKG}")
    if 'Error' in out:
        raise CheckFailed(f'Android did not open the link in Aislet: {out.strip()}')


def home_pairing() -> str:
    """'paired' or 'not paired', from Settings → Home. Changes nothing."""
    go_tab('Settings')
    scroll_to_top()
    try:
        scroll_to('the Home section', timeout_swipes=8, contains="Use the laptop's AI")
        return 'paired'
    except CheckFailed:
        scroll_to('Find my laptop', timeout_swipes=4, text='Find my laptop')
        return 'not paired'


def check_pair_link() -> str:
    """A pairing link (the laptop's QR code) shows the address and asks first; Cancel changes nothing."""
    before = home_pairing()
    connected = before == 'paired' and bool(find(screen(), contains='Connected to'))
    # A link to an address outside the home network is turned away without asking.
    open_link(f'aislet://pair?u=203.0.113.9&c={PAIR_CODE}')
    wait_for('the "not on a home network" message', timeout=10, contains="isn't on a home network")
    if find(screen(), contains='Pair with the laptop at'):
        raise CheckFailed('asked to pair with an address outside the home network')
    # From cold, as when the camera app opens the link: the app starts and asks.
    safe_front('closing the app')
    key(3)
    time.sleep(1)
    shell(f'am force-stop {PKG}')
    open_link(f'aislet://pair?u={PAIR_ADDRESS}&c={PAIR_CODE}')
    title = f'Pair with the laptop at {PAIR_ADDRESS}?'
    card = wait_for('the pairing card', timeout=20, text=title)
    nodes = screen()
    pair = [n for n in find(nodes, text='Pair') if n.cy > card.cy]
    cancel = [n for n in find(nodes, text='Cancel') if n.cy > card.cy]
    if not pair or not cancel:
        raise CheckFailed('the pairing card has no Pair and Cancel buttons')
    if not find(nodes, contains='Only pair if'):
        raise CheckFailed('the pairing card does not warn to pair only with your own laptop')
    tap(cancel[0])
    wait_gone('the pairing card', timeout=5, text=title)
    # Back also cancels, and stays in the app.
    open_link(f'aislet://pair?u={PAIR_ADDRESS}&c={PAIR_CODE}')
    wait_for('the pairing card again', timeout=10, text=title)
    key(4)
    wait_gone('the pairing card after Back', timeout=5, text=title)
    if foreground() != PKG:
        raise CheckFailed('Back on the pairing card left the app')
    after = home_pairing()
    if after != before:
        raise CheckFailed(f'pairing changed after Cancel: {before} → {after}')
    if connected:
        wait_for('the connected status after Cancel', timeout=20, contains='Connected to')
    return f'outside address ignored; asked about {PAIR_ADDRESS} from cold; Cancel and Back left it {after}'


def scroll_list() -> bool:
    """Swipe up about a third of the screen. False when nothing moved: the end of the list."""
    before = [(n.label, n.y1) for n in screen()]
    h = screen_height()
    shell(f'input swipe 540 {int(h * 0.7)} 540 {int(h * 0.35)} 300')
    time.sleep(0.6)
    return [(n.label, n.y1) for n in screen()] != before


def forget(text_contains: str) -> int:
    """Forget every fact containing this text, looking through the whole list (real facts push test ones down)."""
    count = 0
    scroll_to_top()
    for _ in range(30):
        b = row_button(text_contains, 'Forget this')
        if b:
            tap_xy(b.cx, b.cy)
            confirm_alert('Forget')
            count += 1
            continue
        if not scroll_list():
            break
    scroll_to_top()
    return count


def has_fact(text_contains: str) -> bool:
    """Whether any fact in the whole list contains this text."""
    scroll_to_top()
    found = False
    for _ in range(30):
        if row_button(text_contains, 'Forget this'):
            found = True
            break
        if not scroll_list():
            break
    scroll_to_top()
    return found


def check_memory() -> str:
    """Add facts, tidy up, and forget them again."""
    go_tab('Memory')
    scroll_to_top()
    started_empty = bool(find(screen(), contains='Nothing yet'))
    detail = 'added 2'
    try:
        for fact in FACTS:
            scroll_to_top()
            tap(editable(screen())[0])  # the add-a-fact box is the only text box on the Memory screen
            wait_keyboard(True)
            clear_focused_field()
            type_text(fact)
            time.sleep(0.4)
            hide_keyboard()
            tap(wait_for('the Add button', text='Add'))
            time.sleep(0.8)
            scroll_to(f'the fact "{fact}"', timeout_swipes=12, text=fact)  # new facts go below the real ones
        scroll_to_top()
        tidy = wait_for('the Tidy up button', text='Tidy up')
        if not tidy.enabled:
            raise CheckFailed('Tidy up is disabled (is the AI ready?)')
        tap(tidy)
        end = time.time() + 180
        while True:
            nodes = screen()
            if find(nodes, text='Suggested changes'):
                if started_empty:
                    apply = [n for n in nodes if n.text.startswith('Apply')]
                    if not apply or not apply[0].enabled:
                        raise CheckFailed('no Apply button in the suggestions')
                    tap(apply[0])
                    wait_for('the "Tidied" message', timeout=10, contains='Tidied')
                    detail += ', tidy suggested changes (applied, test facts only)'
                else:
                    tap(wait_for('Cancel', text='Cancel'))
                    detail += ', tidy suggested changes (cancelled: real facts present)'
                break
            if find(nodes, contains='All tidy'):
                detail += ', tidy found nothing to change'
                break
            if find(nodes, contains="Couldn't check"):
                raise CheckFailed('tidy up failed')
            if time.time() > end:
                raise CheckFailed('tidy up took longer than 180 s')
            time.sleep(2)
    finally:
        time.sleep(1.5)
        removed = forget('E2E test fact')
        if started_empty:  # anything left came from the test facts (e.g. a merged fact)
            for _ in range(4):
                b = find(screen(), desc='Forget this')
                if not b:
                    break
                tap_xy(b[0].cx, b[0].cy)
                confirm_alert('Forget')
                removed += 1
    if has_fact('E2E test fact'):
        raise CheckFailed('test facts still in memory after forgetting them')
    if started_empty and not find(screen(), contains='Nothing yet'):
        raise CheckFailed('memory not empty again after the test')
    return f'{detail}, forgot {removed}'


MODES = {'Cool': 'Cool: slower replies', 'Balanced': 'Balanced: quick replies', 'Max': 'Max: quickest'}


def mode_buttons() -> dict[str, Node]:
    """The Cool / Balanced / Max buttons under "Performance" (Answer length has a "Balanced" too)."""
    nodes = screen()
    label = find(nodes, text='Performance')
    if not label:
        raise CheckFailed('no Performance setting on screen')
    below = [n for n in nodes if n.label in MODES and label[0].y2 < n.cy < label[0].y2 + 250]
    return {n.label: n for n in below}


def current_mode() -> str | None:
    for name, n in mode_buttons().items():
        if n.checked:
            return name
    nodes = screen()
    for mode, footer in MODES.items():
        if find(nodes, contains=footer):
            return mode
    return None


def check_performance() -> str:
    """Switch Cool, Max and back, and check each takes effect."""
    go_tab('Settings')
    scroll_to_top()
    scroll_to('Speed and heat', contains='Speed and heat')
    label = scroll_to('the performance buttons', text='Performance')
    h = screen_height()
    if label.cy > h * 0.55:  # its buttons may still be behind the tab bar: bring them up a little, keeping the label on screen
        shell(f'input swipe 540 {int(h * 0.6)} 540 {int(h * 0.4)} 300')
        time.sleep(0.6)
    original = current_mode()
    if not original:
        raise CheckFailed('could not tell which performance mode is on')
    seen = []
    try:
        for mode in [m for m in ('Cool', 'Max', 'Balanced') if m != original] + [original]:
            tap(mode_buttons()[mode])
            wait_for(f'the {mode} description', timeout=5, contains=MODES[mode])
            seen.append(mode)
    finally:
        if current_mode() != original:
            tap(mode_buttons()[original])
            time.sleep(0.8)
    if current_mode() != original:
        raise CheckFailed(f'could not put the mode back to {original}')
    scroll_to_top()
    return f"{' → '.join(seen)} (was {original})"


def button_box(nodes: list[Node], label: str) -> Node | None:
    """The tappable box around a button's label."""
    texts = [n for n in nodes if n.text == label or n.desc == label]
    if not texts:
        return None
    t = texts[0]
    boxes = [n for n in nodes if n.clickable and n.x1 <= t.cx <= n.x2 and n.y1 <= t.cy <= n.y2]
    return min(boxes, key=lambda n: (n.x2 - n.x1) * (n.y2 - n.y1)) if boxes else None


def surface(nodes: list[Node], box: Node) -> Node:
    """A button's visible shape: the tallest box in its column around it. A row that drops Paper's
    style stretches this to the row's height while the tappable part keeps its size."""
    column = [n for n in nodes if abs(n.x1 - box.x1) <= 2 and abs(n.x2 - box.x2) <= 2 and n.y1 <= box.y1 and n.y2 >= box.y2]
    return max(column, key=lambda n: n.height, default=box)


def row_around(nodes: list[Node], a: Node, b: Node) -> Node | None:
    """The smallest box holding both a row's title and its control: the row itself."""
    holders = [n for n in nodes if n.x1 <= min(a.x1, b.x1) and n.x2 >= max(a.x2, b.x2)
               and n.y1 <= min(a.y1, b.y1) and n.y2 >= max(a.y2, b.y2)]
    return min(holders, key=lambda n: (n.x2 - n.x1) * (n.y2 - n.y1)) if holders else None


def lined_up(values: dict[str, int], what: str, tolerance: int = 4) -> None:
    if max(values.values()) - min(values.values()) > tolerance:
        raise CheckFailed(f"{what} don't line up: " + ', '.join(f'{k} {v}' for k, v in values.items()))


def check_rows(nodes: list[Node], rows: dict[str, str], screen_name: str, dp: float) -> tuple[dict, dict]:
    """Rows given as title → control label. Returns the titles' left edges and the controls' right edges."""
    lefts, rights = {}, {}
    for title, control in rows.items():
        t = next((n for n in nodes if n.text == title or (title.endswith('…') and n.text.startswith(title[:-1]))), None)
        if t is None:
            raise CheckFailed(f'no "{title}" row on {screen_name}')
        lefts[title] = t.x1
        if not control:
            continue
        box = (next((n for n in nodes if n.cls.endswith('Switch') and abs(n.cy - t.cy) < 60 * dp), None)
               if control == 'switch' else button_box(nodes, control))
        if box is None:
            raise CheckFailed(f'no {control} control on the "{title}" row')
        shape = surface(nodes, box)
        if shape.height > box.height + 4 or box.height > 48 * dp:
            raise CheckFailed(f'"{control}" is stretched to {shape.height / dp:.0f} dp tall on {screen_name}')
        # Material 3: controls sit centred on the row, or level with the title when the description wraps.
        row = row_around(nodes, t, box)
        centred = row is not None and abs(row.cy - box.cy) <= 3 * dp
        level = abs(box.y1 - t.y1) <= 3 * dp
        if not (centred or level):
            raise CheckFailed(f'"{control}" is neither centred on its row nor level with its title on {screen_name}')
        if control != 'switch':
            rights[control] = box.x2
    return lefts, rights


PRIVACY_ROWS = ['What you say stays on your devices', 'Online only for downloads', 'Your laptop, directly',
                'No account, no tracking', "How it's checked"]


def check_privacy() -> str:
    """Settings → Privacy says what goes online (downloads only). Nothing is tapped, so nothing opens."""
    go_tab('Settings')
    scroll_to_top()
    scroll_to('the Privacy section', timeout_swipes=14, text='Privacy')
    for title in PRIVACY_ROWS:
        scroll_to(f'the "{title}" row', timeout_swipes=4, text=title)
    if not find(screen(), contains='Hugging Face'):
        scroll_to('where models come from', timeout_swipes=2, up=True, contains='Hugging Face')
    scroll_to_top()
    return f'{len(PRIVACY_ROWS)} rows, downloads named as the only use of the internet'


SAME_AS_PHONE = 'Same as the phone'  # the menu's first item: the phone's own language


def voice_row() -> tuple[Node, str]:
    """The Voice language row's Change button, and the language it shows."""
    scroll_to('the Voice language row', timeout_swipes=8, text='Voice language')
    nodes = screen()
    shown = [n for n in find(nodes, contains='Used when you talk') if n.text]
    if not shown:
        raise CheckFailed('the Voice language row shows no language')
    title = find(nodes, text='Voice language')[0]
    change = min(find(nodes, text='Change'), key=lambda n: abs(n.cy - title.cy), default=None)
    if not change or abs(change.cy - title.cy) > 150:
        raise CheckFailed('no Change button on the Voice language row')
    return change, shown[0].text.split('. Used')[0]


def menu_items(first: Node) -> list[Node]:
    """The language menu's items: the labels lined up under its first item, one after another with no gap
    (so the tab labels further down, or other text that happens to line up, aren't counted)."""
    lined_up = sorted((n for n in find(screen()) if n.text and abs(n.x1 - first.x1) < 12 and n.y1 >= first.y1),
                      key=lambda n: n.y1)
    items = [first]
    for n in lined_up:
        if n.y1 <= items[-1].y1:
            continue
        if n.y1 - items[-1].y2 > first.height * 2:
            break
        items.append(n)
    return items


def check_voice_language() -> str:
    """Settings → Voice lists the phone's offline speech packs; Back closes the menu; choosing one shows it, then it's put back."""
    go_tab('Settings')
    scroll_to_top()
    if find(screen(), contains='no offline speech packs'):
        return 'this phone has no offline speech packs, so there is nothing to choose'
    change, before = voice_row()
    tap(change)
    auto = wait_for('the language menu', timeout=5, text=SAME_AS_PHONE)
    languages = [n for n in menu_items(auto) if n.text != SAME_AS_PHONE]
    if not languages:
        raise CheckFailed('the menu lists no installed languages')
    names = [n.text for n in languages]
    # Back closes the menu and stays in the app.
    key(4)
    time.sleep(1)
    if foreground() != PKG:
        raise CheckFailed('Back with the language menu open left the app')
    if find(screen(), text=SAME_AS_PHONE):
        raise CheckFailed('Back did not close the language menu')
    tap(voice_row()[0])
    auto = wait_for('the language menu again', timeout=5, text=SAME_AS_PHONE)
    languages = [n for n in menu_items(auto) if n.text != SAME_AS_PHONE]
    pick = next((n for n in languages if n.text != before), languages[0])
    tap(pick)
    time.sleep(1)
    try:
        change, now = voice_row()
        if now != pick.text:
            raise CheckFailed(f'chose {pick.text}, but the row shows {now}')
    finally:
        change, now = voice_row()
        if now != before:  # put it back
            tap(change)
            auto = wait_for('the language menu', timeout=5, text=SAME_AS_PHONE)
            item = SAME_AS_PHONE if before.startswith(SAME_AS_PHONE) else before  # the row says "Same as the phone: …"
            tap(next(n for n in menu_items(auto) if n.text == item))
            time.sleep(1)
    if voice_row()[1] != before:
        raise CheckFailed(f'could not put the voice language back to {before}')
    return f"offline packs: {', '.join(names)}; chose {pick.text}, then put back {before}"


def check_layout() -> str:
    """List rows line up: one left edge for titles, one right edge for buttons, none stretched or out of place."""
    dp = px_per_dp()
    go_tab('Memory')
    scroll_to_top()
    nodes = screen()
    lefts, rights = check_rows(nodes, {'Get to know me': 'Start', 'Learn from my chats': 'switch', 'Tidy up memory': 'Tidy up'}, 'Memory', dp)
    add = button_box(nodes, 'Add')
    if add is None:
        raise CheckFailed('no Add button on Memory')
    rights['Add'] = add.x2
    lined_up(lefts, 'Memory row titles')
    lined_up(rights, "Memory buttons' right edges")
    title_x, button_x = min(lefts.values()), min(rights.values())

    go_tab('Settings')
    scroll_to_top()
    checked = 'Memory'
    try:
        scroll_to('Settings → Home', timeout_swipes=8, contains="Use the laptop's AI")
    except CheckFailed:
        pass
    nodes = screen()
    if find(nodes, contains="Use the laptop's AI"):  # paired; the unpaired form has no rows to compare
        sync = 'Sync' if find(nodes, text='Sync') else 'Retry'
        l2, r2 = check_rows(nodes, {
            'Connected to…' if sync == 'Sync' else 'Laptop not reachable': sync,
            "Use the laptop's AI at home": 'switch',
        }, 'Settings → Home', dp)
        lined_up({**l2, 'Memory titles': title_x}, 'Settings → Home row titles')
        lined_up({**r2, 'Memory buttons': button_x}, "Settings → Home buttons' right edges")
        checked += ', Settings → Home'
    scroll_to('Photo understanding', text='Photo understanding')
    nodes = screen()
    l3, _ = check_rows(nodes, {'Notes search': '', 'Photo understanding': ''}, 'Settings → AI', dp)
    lined_up({**l3, 'Memory titles': title_x}, 'Settings → AI row titles')
    gets = [b for b in (button_box(nodes, 'Get'),) if b] + [n for n in nodes if n.desc.startswith('Delete ') and n.clickable]
    if gets:
        lined_up({**{f'control {i + 1}': g.x2 for i, g in enumerate(gets)}, 'Memory buttons': button_x}, "Settings → AI controls' right edges")
        for g in gets:
            if surface(nodes, g).height > g.height + 4:
                raise CheckFailed(f'a model button is stretched to {surface(nodes, g).height / dp:.0f} dp tall')
    scroll_to_top()
    return f'{checked}, Settings → AI: titles at x={title_x}, buttons end at x={button_x}'


def vibrate_switch() -> Node:
    row = scroll_to('Vibrate on taps', text='Vibrate on taps')
    switches = [n for n in screen() if n.cls.endswith('Switch') and abs(n.cy - row.cy) < 120]
    if not switches:
        raise CheckFailed('no switch on the "Vibrate on taps" row')
    return switches[0]


def check_haptics() -> str:
    """The "Vibrate on taps" switch turns off and on, and is put back as it was."""
    go_tab('Settings')
    scroll_to_top()
    original = vibrate_switch().checked
    try:
        tap(vibrate_switch())
        time.sleep(0.6)
        if vibrate_switch().checked == original:
            raise CheckFailed('the switch did not change')
    finally:
        if vibrate_switch().checked != original:
            tap(vibrate_switch())
            time.sleep(0.6)
    if vibrate_switch().checked != original:
        raise CheckFailed('could not put "Vibrate on taps" back')
    scroll_to_top()
    return f"switched {'off and on' if original else 'on and off'}"


# Files to share live in the app's own folder on the phone, so the app can read them without any storage
# permission and they never reach the gallery or a photo backup.
SHARE_DIR = f'/sdcard/Android/data/{PKG}/files/e2e'
SHARED_TEXT = 'E2E shared text check 42'


def safe_front(doing: str) -> None:
    """Stop unless Aislet or the home screen is in front, so nothing lands in another app."""
    front = foreground()
    if front != PKG and not any(l in front for l in LAUNCHERS):
        raise CheckFailed(f'stopped before {doing}: another app is in front ({front})')


def share_to_app(mime: str, extras: str) -> None:
    """Send an Android share (ACTION_SEND) the way the share sheet does, limited to Aislet."""
    out = shell(f'am start -W -a android.intent.action.SEND -t {mime} {extras} -p {PKG}')
    if 'Error' in out:
        raise CheckFailed(f'Android does not offer Aislet for {mime}: {out.strip()}')


def test_png(w: int = 360, h: int = 240) -> bytes:
    """A made-up picture (a colour gradient)."""
    rows = b''.join(b'\x00' + bytes(v for x in range(w) for v in (x * 255 // w, y * 255 // h, 140)) for y in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def test_pdf(text: str) -> bytes:
    """A one-page PDF with a line of made-up text."""
    stream = f'BT /F1 18 Tf 72 720 Td ({text}) Tj ET'.encode()
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream',
    ]
    out, offsets = b'%PDF-1.4\n', []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    out += b''.join(b'%010d 00000 n \n' % o for o in offsets)
    return out + b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref)


def push_test_file(name: str, data: bytes) -> str:
    OUT.mkdir(exist_ok=True)
    local = OUT / name
    local.write_bytes(data)
    try:
        shell(f'mkdir -p {SHARE_DIR}')
        adb('push', str(local), f'{SHARE_DIR}/{name}')
    finally:
        local.unlink(missing_ok=True)
    return f'file://{SHARE_DIR}/{name}'


def wait_message_text(text: str, timeout: float = 15) -> Node:
    end = time.time() + timeout
    while True:
        boxes = editable(screen())
        if boxes and boxes[-1].text == text:
            return boxes[-1]
        if time.time() > end:
            raise CheckFailed(f"message box shows {boxes[-1].text if boxes else None!r}, expected the shared text")
        time.sleep(0.5)


def check_share() -> str:
    """Text, a photo and a PDF shared from another app each open a new chat with them in the message box."""
    details = []
    try:
        # Text, while the app is open on another tab.
        go_tab('Memory')
        safe_front('sharing text')
        share_to_app('text/plain', f"--es android.intent.extra.TEXT '{SHARED_TEXT}'")
        box = wait_message_text(SHARED_TEXT)
        if foreground() != PKG:
            raise CheckFailed('Aislet is not in front after sharing text')
        if not find(screen(), text='New chat'):
            raise CheckFailed('sharing text did not open a new chat')
        if any(n.text == SHARED_TEXT and not n.cls.endswith('EditText') for n in screen()):
            raise CheckFailed('the shared text was sent; it should wait in the message box')
        tap(box)
        wait_keyboard(True)
        clear_focused_field()
        hide_keyboard()
        details.append('text (app open)')

        # A photo, with the app closed: it starts with the share.
        uri = push_test_file('E2E-share.png', test_png())
        safe_front('going to the home screen')
        key(3)  # home, so the app can be closed without another app coming to the front
        time.sleep(1)
        shell(f'am force-stop {PKG}')
        safe_front('sharing a photo')
        share_to_app('image/png', f'--eu android.intent.extra.STREAM {uri}')
        remove = wait_for('the shared photo in the message box', timeout=40, desc='Remove photo')
        if foreground() != PKG:
            raise CheckFailed('Aislet is not in front after sharing a photo')
        if len(find(screen(), desc='Remove photo')) != 1:
            raise CheckFailed('expected exactly one shared photo')
        tap(remove)
        wait_gone('the shared photo', desc='Remove photo')
        details.append('photo (app closed)')

        # A PDF: the laptop reads its text, so wait for the AI to be ready first.
        wait_for('a ready AI', timeout=90, contains='· private')
        uri = push_test_file('E2E-share.pdf', test_pdf('E2E shared PDF check'))
        safe_front('sharing a PDF')
        share_to_app('application/pdf', f'--eu android.intent.extra.STREAM {uri}')
        end = time.time() + 60
        while True:
            nodes = screen()
            if find(nodes, text='E2E-share.pdf') and find(nodes, desc='Remove file') and not find(nodes, text='Reading file…'):
                tap(find(nodes, desc='Remove file')[0])
                wait_gone('the shared PDF', desc='Remove file')
                details.append('PDF read by the laptop')
                break
            if find(nodes, contains='needs your laptop'):
                details.append('PDF: "needs your laptop" shown (laptop not connected)')
                break
            problem = (find(nodes, contains='E2E-share.pdf has no readable text') or find(nodes, contains="Couldn't open")
                       or find(nodes, contains="can't read PDFs") or find(nodes, contains="couldn't be read"))
            if problem:
                raise CheckFailed(f'shared PDF not read: {problem[0].text}')
            if time.time() > end:
                raise CheckFailed('the shared PDF did not appear in the message box within 60 s')
            time.sleep(1)
    finally:
        adb('shell', f'rm -rf {SHARE_DIR}', check=False)
    return ', '.join(details)


LIBRARY_DIR = f'/sdcard/Android/data/{PKG}/files/libraries'  # the app's own folder: no "All files access" needed
LIBRARY_FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'e2e-library.zim'  # made by make_test_library.py
LIBRARY_PROMPT = 'E2E check: how long does the Lumen-7 lantern run on batteries'


def check_library() -> str:
    """A made-up library in the app's folder shows in Settings, and an answer uses its made-up fact."""
    try:
        shell(f'mkdir -p {LIBRARY_DIR}')
        adb('push', str(LIBRARY_FIXTURE), f'{LIBRARY_DIR}/e2e-library.zim')
        check_launch()  # a fresh start lists it
        go_tab('Settings')
        scroll_to('the test library in Settings, Libraries', text='E2E Test Library')
        scroll_to_top()
        tap(open_new_chat())
        wait_keyboard(True)
        type_text(LIBRARY_PROMPT)
        time.sleep(0.5)
        send = find(screen(), desc='Send')
        if not send:
            raise CheckFailed('no Send button')
        tap(send[0])
        wait_for('the sent message in the thread', timeout=10, text=LIBRARY_PROMPT)
        hide_keyboard()
        started, end = time.time(), time.time() + 180
        while True:
            nodes = screen()
            if find(nodes, desc='Copy') and not find(nodes, desc='Stop'):
                break
            if find(nodes, text='Dismiss'):
                raise CheckFailed('the reply failed with an error card')
            if time.time() > end:
                raise CheckFailed('no reply within 180 s')
            time.sleep(1.5)
        reply = ' '.join(n.text for n in screen() if n.text and n.text != LIBRARY_PROMPT)
        if '42' not in reply:
            raise CheckFailed(f'the reply did not use the library (no "42 hours"): {reply[:160]!r}')
        cited = 'E2E Test Library' in reply
        return f'listed in Settings; reply in {time.time() - started:.0f} s used the made-up fact' + (', and named the library' if cited else '')
    finally:
        if not delete_test_chat():
            print('  note: could not find the test chat to delete', file=sys.stderr)
        adb('shell', f'rm -rf {LIBRARY_DIR}', check=False)


# Your own files: made up (pc/tests/made_up_files.py), in the app's own folder, so no "All files access" is
# needed and nothing of yours is touched. Each one's checksum and date are compared before and after.
FILES_PROMPT = 'E2E check: what pressure does the Zephyrion 9 boiler run at when cold'


def own_test_files() -> dict[str, bytes]:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'pc' / 'tests'))
    from made_up_files import epub, pdf  # noqa: E402
    return {
        'e2e-boiler-notes.md': b'# E2E boiler notes\n\n## Pressure\n\nThe made-up Zephyrion 9 boiler runs at 1.4 bar when cold.\n',
        'e2e-tale.epub': epub('E2E Tale of Orrin', [('The Harbour', 'Orrin sailed from Velmor at dawn.'), ('The Storm', 'A storm broke the mast.')]),
        'e2e-manual.pdf': pdf(['Welcome to the made-up Glimmerfold manual.', 'Hold the amber key for 7 seconds to reset it.']),
        'e2e-not-really.pdf': b'This is not a PDF.',
        'e2e-letter.docx': b'PK\x03\x04 not a real Word file',
    }


def remote_fingerprints(names: list[str]) -> dict[str, str]:
    """Each file's checksum and date (seconds) on the phone."""
    out = shell('cd ' + LIBRARY_DIR + ' && for f in ' + ' '.join(names) + '; do echo "$f $(sha256sum "$f" | cut -c1-64) $(stat -c %Y "$f")"; done')
    return {parts[0]: ' '.join(parts[1:]) for parts in (line.split() for line in out.splitlines()) if len(parts) == 3}


def check_library_files() -> str:
    """Your own files in the library folder are listed (or say why not), searched, cited, and never changed."""
    files = own_test_files()
    local = Path(tempfile.mkdtemp(prefix='aislet-e2e-files-'))
    try:
        shell(f'mkdir -p {LIBRARY_DIR}')
        for name, data in files.items():
            (local / name).write_bytes(data)
            adb('push', str(local / name), f'{LIBRARY_DIR}/{name}')
        before = remote_fingerprints(list(files))
        expected = {n: hashlib.sha256(d).hexdigest() for n, d in files.items()}
        if len(before) != len(files) or any(before[n].split()[0] != expected[n] for n in files):
            raise CheckFailed(f'the test files did not reach the phone intact: {before}')
        check_launch()  # a fresh start lists them and reads them
        go_tab('Settings')
        rows = {
            'e2e-boiler-notes': 'Markdown',
            'E2E Tale of Orrin': 'Ebook · 2 chapters',
            'e2e-manual': 'PDF · 2 pages',
            'e2e-not-really': "This isn't a PDF, or it's damaged.",
            'e2e-letter': "Aislet can't read .docx files yet.",
        }
        seen = []
        for title, described in rows.items():
            row = scroll_to(f'"{title}" in Settings, Libraries', text=title)
            end = time.time() + 90  # the first read happens in the background
            while True:
                near = [n.text for n in screen() if n.text and 0 < n.cy - row.cy < 160]
                if any(described in t for t in near):
                    break
                if time.time() > end:
                    raise CheckFailed(f'"{title}" never showed "{described}" (showed {near[:2]})')
                time.sleep(1.5)
                row = scroll_to(f'"{title}" in Settings, Libraries', text=title)
            seen.append(title)
        if find(screen(), desc='Delete e2e-boiler-notes') or find(screen(), desc='Delete e2e-manual'):
            raise CheckFailed('your own files have a delete button')
        scroll_to_top()
        tap(open_new_chat())
        wait_keyboard(True)
        type_text(FILES_PROMPT)
        time.sleep(0.5)
        send = find(screen(), desc='Send')
        if not send:
            raise CheckFailed('no Send button')
        tap(send[0])
        wait_for('the sent message in the thread', timeout=10, text=FILES_PROMPT)
        hide_keyboard()
        started, end = time.time(), time.time() + 180
        while True:
            nodes = screen()
            if find(nodes, desc='Copy') and not find(nodes, desc='Stop'):
                break
            if find(nodes, text='Dismiss'):
                raise CheckFailed('the reply failed with an error card')
            if time.time() > end:
                raise CheckFailed('no reply within 180 s')
            time.sleep(1.5)
        reply = ' '.join(n.text for n in screen() if n.text and n.text != FILES_PROMPT)
        if '1.4' not in reply:
            raise CheckFailed(f'the reply did not use the note (no "1.4 bar"): {reply[:160]!r}')
        cited = 'e2e-boiler-notes' in reply
        after = remote_fingerprints(list(files))
        if after != before:
            raise CheckFailed(f'a file was changed by reading it: before {before}, after {after}')
        return (f'{len(seen)} files listed (2 with reasons they can\'t be read); reply in {time.time() - started:.0f} s used the '
                f'note{" and named it" if cited else ""}; all {len(files)} files unchanged')
    finally:
        if not delete_test_chat():
            print('  note: could not find the test chat to delete', file=sys.stderr)
        adb('shell', f'rm -rf {LIBRARY_DIR}', check=False)
        shutil.rmtree(local, ignore_errors=True)


# The backup check drives Android's own folder and file picker, which Aislet opens. Only while it does
# may taps go to the picker as well as to Aislet.
PICKER = 'documentsui'
picker_open = False
BACKUP_DIR = '/sdcard/Documents/E2E-untethered-backups'
BACKUP_FACT = 'E2E backup fact: restored from a backup'
PASSPHRASE = 'E2E pass 4242 x'


def picker_tap(label: str, timeout: float = 15) -> None:
    """Tap something in the system picker (labels may be shown in capitals)."""
    end = time.time() + timeout
    while time.time() < end:
        if PICKER not in foreground():
            raise CheckFailed(f'the system picker is not in front ({foreground()})')
        for n in screen():
            if n.text.lower() == label.lower() or (label.endswith('*') and n.text.startswith(label[:-1])):
                tap_xy(n.cx, n.cy)
                time.sleep(1.2)
                return
        time.sleep(0.5)
    raise CheckFailed(f'no "{label}" in the system picker')


def backup_switch() -> Node:
    row = scroll_to('Automatic backups', text='Automatic backups')
    switches = [n for n in screen() if n.cls.endswith('Switch') and abs(n.cy - row.cy) < 120]
    if not switches:
        raise CheckFailed('no switch on the "Automatic backups" row')
    return switches[0]


def type_into(label: str, text: str) -> None:
    hide_keyboard()
    tap(labelled_field(label))
    wait_keyboard(True)
    clear_focused_field()
    type_text(text)
    time.sleep(0.4)


def add_fact(fact: str) -> None:
    go_tab('Memory')
    scroll_to_top()
    tap(editable(screen())[0])  # the add-a-fact box is the only text box on the Memory screen
    wait_keyboard(True)
    clear_focused_field()
    type_text(fact)
    time.sleep(0.4)
    hide_keyboard()
    tap(wait_for('the Add button', text='Add'))
    time.sleep(0.8)


def check_backup() -> str:
    """Encrypted backups: turn on with a passphrase and a folder, then restore a forgotten fact from the file."""
    global picker_open
    go_tab('Settings')
    scroll_to_top()
    if backup_switch().checked:
        # Backups are already set up: leave them as they are and only check "Back up now".
        before = [n.text for n in screen() if n.text.startswith('Last backup')]
        tap(wait_for('the Back up button', text='Back up'))
        time.sleep(4)
        after = [n.text for n in screen() if n.text.startswith('Last backup')]
        if not after:
            raise CheckFailed('no "Last backup" time after Back up now')
        return f'backups were already on, so only Back up now was checked ({before[:1]} → {after[:1]})'

    turned_on = False
    try:
        adb('shell', f'mkdir -p {BACKUP_DIR}')
        add_fact(BACKUP_FACT)

        # Turn on: passphrase, then the folder.
        go_tab('Settings')
        scroll_to_top()
        tap(backup_switch())
        time.sleep(1.5)  # the form opens with its first box focused and the keyboard up
        scroll_to('the passphrase box', timeout_swipes=4, text='Passphrase again')
        type_into('Passphrase', PASSPHRASE)
        type_into('Passphrase again', PASSPHRASE)
        hide_keyboard()
        tap(wait_for('the Choose folder button', text='Choose folder'))
        end = time.time() + 15
        while PICKER not in foreground():
            if time.time() > end:
                raise CheckFailed('the folder picker did not open')
            time.sleep(0.5)
        picker_open = True
        picker_tap('E2E-untethered-backups')
        picker_tap('Use this folder')
        picker_tap('Allow')
        picker_open = False
        turned_on = True
        wait_for('backups on, saving to the test folder', timeout=60, contains='Daily to Documents/E2E-untethered-backups')
        files = [f for f in shell(f'ls {BACKUP_DIR}').split() if f.startswith('aislet-backup-')]
        if len(files) != 1:
            raise CheckFailed(f'expected one backup file, found {files}')
        content = shell(f"cat '{BACKUP_DIR}/{files[0]}'")
        if '"app":"untethered-backup"' not in content or '"cipher":"AES-256-GCM"' not in content:
            raise CheckFailed('the backup file is not in the expected format')
        if 'E2E backup fact' in content:
            raise CheckFailed('the backup file holds the fact in plain text; it should be encrypted')

        # Forget the fact, then restore it from the file.
        go_tab('Memory')
        if not forget('E2E backup fact'):
            raise CheckFailed('could not forget the test fact before restoring')
        go_tab('Settings')
        tap(scroll_to('the Restore row', text='Restore an encrypted backup'))
        end = time.time() + 15
        while PICKER not in foreground():
            if time.time() > end:
                raise CheckFailed('the file picker did not open')
            time.sleep(0.5)
        picker_open = True
        picker_tap('aislet-backup-*')
        picker_open = False
        time.sleep(2)  # the form opens under the Restore row, which may be low on the screen
        scroll_to('the restore passphrase box', timeout_swipes=4, contains='Enter the passphrase for aislet-backup-')
        type_into('Passphrase', 'wrong passphrase 1')
        hide_keyboard()
        tap(wait_for('the Restore button', text='Restore'))
        wait_for('the wrong-passphrase message', timeout=60, contains="passphrase doesn't open this backup")
        type_into('Passphrase', PASSPHRASE)
        hide_keyboard()
        tap(wait_for('the Restore button', text='Restore'))
        wait_gone('the restore passphrase box', timeout=60, contains='Enter the passphrase for')
        go_tab('Memory')
        if not has_fact('E2E backup fact'):
            raise CheckFailed('the forgotten fact did not come back from the backup')
        return f'backed up to the test folder (encrypted, {len(content)} bytes), wrong passphrase refused, fact restored'
    finally:
        picker_open = False
        if foreground() not in (PKG,) and PICKER in foreground():
            key(4)  # leave the picker if a step failed inside it
            time.sleep(1)
        go_tab('Memory')
        forget('E2E backup fact')
        if turned_on:
            go_tab('Settings')
            if backup_switch().checked:
                tap(backup_switch())
                confirm_alert('Turn off')
        else:
            go_tab('Settings')
            if find(screen(), text='Choose folder'):
                tap(wait_for('Cancel', text='Cancel'))
        adb('shell', f'rm -rf {BACKUP_DIR}', check=False)
        scroll_to_top()


RESUME_PROMPT = 'E2E check resume: reply with one word, ok'


def relaunch() -> None:
    """Close the app the way Android does in the background, then open it again from the home screen."""
    safe_front('closing the app')
    key(3)
    time.sleep(1)
    shell(f'am force-stop {PKG}')
    safe_front('opening the app')
    shell(f'am start -W -n {PKG}/.MainActivity -f 0x10008000')
    wait_for('the tabs after reopening', timeout=20, text='Chat')


def check_resume() -> str:
    """After Android closes the app, opening it again shows the chat and the screen you left."""
    try:
        tap(open_new_chat())
        wait_keyboard(True)
        type_text(RESUME_PROMPT)
        time.sleep(0.5)
        tap(find(screen(), desc='Send')[0])
        wait_for('the sent message', timeout=10, text=RESUME_PROMPT)
        hide_keyboard()
        end = time.time() + 120
        while not (find(screen(), desc='Copy') and not find(screen(), desc='Stop')):
            if time.time() > end:
                raise CheckFailed('no reply within 120 s')
            time.sleep(1.5)
        relaunch()
        wait_for('the same chat after reopening', timeout=15, text=RESUME_PROMPT)
        go_tab('Notes')
        relaunch()
        wait_for('the Notes screen after reopening', timeout=15, text='New note')
        go_tab('Chat')
        wait_for('the same chat on the Chat tab', timeout=10, text=RESUME_PROMPT)
        return 'the chat and the Notes screen came back after the app was closed'
    finally:
        go_tab('Chat')
        if not delete_test_chat():
            print('  note: could not find the resume test chat to delete', file=sys.stderr)


NOTE_PROMPT = 'E2E check: save note, reply with one word, ok'


def ask_and_wait(prompt: str, timeout: float = 180) -> None:
    """Send a message in a new chat and wait until the reply has finished."""
    tap(open_new_chat())
    wait_keyboard(True)
    type_text(prompt)
    time.sleep(0.5)
    tap(wait_for('the Send button', desc='Send'))
    wait_for('the sent message', timeout=10, text=prompt)
    hide_keyboard()
    end = time.time() + timeout
    while True:
        nodes = screen()
        if find(nodes, desc='Copy') and not find(nodes, desc='Stop'):
            return
        if find(nodes, text='Dismiss'):
            raise CheckFailed('the reply failed with an error card')
        if time.time() > end:
            raise CheckFailed(f'no reply within {timeout:.0f} s')
        time.sleep(1.5)


def delete_note(title: str) -> bool:
    """Delete the note with this title from the Notes screen. False when there isn't one."""
    go_tab('Notes')
    scroll_to_top()
    rows = find(screen(), text=title)
    if not rows:
        return False
    tap(rows[0])
    tap(wait_for('the note Delete button', text='Delete'))
    confirm_alert('Delete')
    wait_for('the Notes list after deleting', timeout=5, text='New note')
    return True


def check_save_note() -> str:
    """Save to Notes on an answer adds it as a note titled with the question, once; deleting the note frees the button again."""
    try:
        ask_and_wait(NOTE_PROMPT)
        if find(screen(), desc='Saved to Notes'):
            raise CheckFailed('the answer shows as saved before Save to Notes was tapped')
        tap(wait_for('the Save to Notes button', desc='Save to Notes'))
        saved = wait_for('the saved state on the answer', timeout=5, desc='Saved to Notes')
        if saved.enabled:
            raise CheckFailed('Save to Notes can be tapped again after saving, which would save a copy')
        go_tab('Notes')
        scroll_to_top()
        row = wait_for('the saved note in Notes', timeout=5, text=NOTE_PROMPT)
        tap(row)
        boxes = editable(screen())
        if len(boxes) < 2 or not boxes[1].text.strip():
            raise CheckFailed("the saved note doesn't hold the answer")
        answer = boxes[1].text.strip()
        tap(wait_for('the note Cancel button', text='Cancel'))
        wait_for('the Notes list', timeout=5, text='New note')
        if not delete_note(NOTE_PROMPT):
            raise CheckFailed('could not find the test note to delete')
        go_tab('Chat')
        wait_for('Save to Notes free again after deleting the note', timeout=5, desc='Save to Notes')
        return f'saved once as "{NOTE_PROMPT}" ({len(answer)} characters); deleting the note freed the button'
    finally:
        hide_keyboard()
        while delete_note(NOTE_PROMPT):
            pass
        go_tab('Chat')
        if not delete_test_chat():
            print('  note: could not find the save-note test chat to delete', file=sys.stderr)


PIN_PROMPT = 'E2E check: pin chat, reply with one word, ok'
DATE_SECTIONS = ('Today', 'Yesterday', 'Previous 7 days', 'Older')


def in_pinned_section(title: str) -> bool:
    """Whether the chat list row with this title sits under the Pinned heading (the chat list is open)."""
    nodes = screen()
    rows = sorted(find(nodes, contains=title), key=lambda n: n.height)
    if not rows:
        raise CheckFailed(f'no chat titled {title!r} in the chat list')
    pinned = find(nodes, text='Pinned')
    if not pinned:
        return False
    below = [n.cy for n in nodes if n.text in DATE_SECTIONS and n.cy > pinned[0].cy]
    return pinned[0].cy < rows[0].cy < min(below, default=10 ** 6)


def check_pin_chat() -> str:
    """Pin chat moves a chat under Pinned at the top of the chat list; it stays pinned after the app restarts; Unpin puts it back."""
    try:
        ask_and_wait(PIN_PROMPT)
        tap(wait_for('the Chats button', desc='Chats'))
        wait_for('the test chat in the chat list', timeout=5, contains=PIN_PROMPT)
        if in_pinned_section(PIN_PROMPT):
            raise CheckFailed('a new chat is already pinned')
        pin = row_button(PIN_PROMPT, 'Pin chat')
        if not pin:
            raise CheckFailed('no Pin chat button on the test chat')
        tap(pin)
        time.sleep(1)
        if not in_pinned_section(PIN_PROMPT):
            raise CheckFailed('the chat did not move under Pinned')
        if not row_button(PIN_PROMPT, 'Unpin chat'):
            raise CheckFailed('a pinned chat has no Unpin chat button')
        key(4)  # close the chat list
        time.sleep(0.8)
        relaunch()
        go_tab('Chat')
        tap(wait_for('the Chats button', desc='Chats'))
        wait_for('the test chat after restarting', timeout=5, contains=PIN_PROMPT)
        if not in_pinned_section(PIN_PROMPT):
            raise CheckFailed('the pin was lost when the app restarted')
        tap(row_button(PIN_PROMPT, 'Unpin chat') or wait_for('the Unpin chat button', desc='Unpin chat'))
        time.sleep(1)
        if in_pinned_section(PIN_PROMPT):
            raise CheckFailed('the chat stayed under Pinned after Unpin')
        if not row_button(PIN_PROMPT, 'Pin chat'):
            raise CheckFailed('an unpinned chat has no Pin chat button')
        key(4)
        time.sleep(0.8)
        return 'pinned to the top, kept after a restart, and unpinned'
    finally:
        if find(screen(), desc='Delete chat'):  # the chat list is still open
            key(4)
            time.sleep(0.8)
        if not delete_test_chat():
            print('  note: could not find the pin test chat to delete', file=sys.stderr)


ACTIONS_PROMPT = 'E2E check: add E2E check event to my calendar on 2030-01-15 at 10:00 for 30 minutes'
ACTIONS_EVENT = 'E2E check event'
ALARM_PROMPT = 'E2E check: now set an alarm for 06:15 called E2E check alarm'


def handler(action: str, data: str = '') -> str:
    """The package that would open this intent, or '' if none would."""
    out = adb('shell', f"cmd package resolve-activity --brief -a {action}" + (f" -d '{data}'" if data else ''), check=False)
    last = out.strip().splitlines()[-1] if out.strip() else ''
    return last.split('/')[0] if '/' in last else ''


def wait_reply(timeout: float = 180) -> None:
    """Wait until the reply that's being written has finished."""
    end = time.time() + timeout
    while True:
        nodes = screen()
        if find(nodes, desc='Copy') and not find(nodes, desc='Stop'):
            return
        if find(nodes, text='Dismiss'):
            raise CheckFailed('the reply failed with an error card')
        if time.time() > end:
            raise CheckFailed(f'no reply within {timeout:.0f} s')
        time.sleep(1.5)


def back_to_aislet() -> None:
    """Bring Aislet back to the front without touching the app in front (no taps or keys go to it). Aislet's
    screen is "single task", so this also closes anything it opened on top of itself, unsaved."""
    adb('shell', f'am start -W -n {PKG}/.MainActivity')
    end = time.time() + 8
    while foreground() != PKG:
        if time.time() > end:
            raise CheckFailed(f'Aislet did not come back to the front ({foreground() or "unknown"} is in front)')
        time.sleep(0.5)


def check_actions() -> str:
    """Asking for a calendar event or an alarm gets a card, not a raw action line; Add to calendar opens the calendar filled in, which is closed unsaved."""
    calendar = handler('android.intent.action.INSERT', 'content://com.android.calendar/events')
    clock = handler('android.intent.action.SET_ALARM')
    if not calendar or not clock:
        raise CheckFailed(f'no app for calendar events ({calendar or "none"}) or alarms ({clock or "none"})')
    opened = ''
    try:
        ask_and_wait(ACTIONS_PROMPT)
        button = wait_for('the Add to calendar button on the card', timeout=10, text='Add to calendar')
        nodes = screen()
        if not find(nodes, text=ACTIONS_EVENT):
            raise CheckFailed('the card does not show the event name')
        if not find(nodes, contains='2030'):
            raise CheckFailed('the card does not show the date')
        if any('[[' in n.text for n in nodes if n.text):
            raise CheckFailed('the action line shows as text in the chat')
        # An alarm card too. It's never tapped: that would set a real alarm.
        tap(message_box())
        wait_keyboard(True)
        type_text(ALARM_PROMPT)
        time.sleep(0.5)
        tap(wait_for('the Send button', desc='Send'))
        hide_keyboard()
        wait_reply()
        wait_for('the Set alarm button on the alarm card', timeout=10, text='Set alarm')
        if not find(screen(), contains='06:15') and not find(screen(), contains='6:15'):
            raise CheckFailed('the alarm card does not show 06:15')
        # Add to calendar: the calendar opens with the event filled in. Nothing is tapped there.
        button = wait_for('the Add to calendar button', timeout=5, text='Add to calendar')
        tap(button)
        end = time.time() + 10
        while foreground() != calendar:
            if time.time() > end:
                raise CheckFailed(f'the calendar did not open ({foreground() or "unknown"} is in front)')
            time.sleep(0.5)
        opened = calendar
        time.sleep(1.5)
        shown = find(screen(), contains=ACTIONS_EVENT)
        back_to_aislet()
        opened = ''
        if not shown:
            raise CheckFailed('the calendar opened without the event name filled in')
        if calendar in shell('dumpsys activity recents | grep -i "realActivity"'):
            raise CheckFailed('the unsaved event is still open in the calendar')
        wait_for('the card showing it was opened', timeout=5, text='Opened')
        return f'event and alarm cards shown; {calendar} opened with the event and was closed unsaved'
    finally:
        if opened and foreground() == opened:
            back_to_aislet()
        if not delete_test_chat():
            print('  note: could not find the actions test chat to delete', file=sys.stderr)


def mic_allowed() -> bool:
    return 'android.permission.RECORD_AUDIO: granted=true' in shell(f'dumpsys package {PKG}')


def delete_open_chat() -> None:
    """Delete the chat that's open, found by the title in the chat header (for a chat the test started)."""
    menu = wait_for('the Chats button', desc='Chats')
    titles = [n for n in screen() if n.text and '·' not in n.text and n.y1 >= menu.y1 - 20 and n.y2 <= menu.y2 + 20
              and n.x1 > menu.x2 and n.text != 'New chat']
    if not titles:
        return
    title = titles[0].text
    tap(menu)
    time.sleep(1)
    b = row_button(title, 'Delete chat')
    if b:
        tap_xy(b.cx, b.cy)
        confirm_alert('Delete')
    key(4)
    time.sleep(0.8)


def check_hands_free() -> str:
    """Hands-free takes Send's place only while the box is empty; it listens, and stops on End, in the background and after silence."""
    box = open_new_chat()
    nodes = screen()
    if not find(nodes, desc='Hands-free'):
        raise CheckFailed('no Hands-free button while the message box is empty')
    if find(nodes, desc='Send'):
        raise CheckFailed('Send and Hands-free both show while the box is empty')
    tap(box)
    wait_keyboard(True)
    type_text('E2E hands-free check')
    time.sleep(0.6)
    nodes = screen()
    if find(nodes, desc='Hands-free') or not find(nodes, desc='Send'):
        raise CheckFailed('typing should put Send in place of Hands-free')
    clear_focused_field()
    time.sleep(0.5)
    hide_keyboard()
    wait_for('Hands-free again after clearing the box', timeout=5, desc='Hands-free')
    if not mic_allowed():
        return 'Hands-free swaps with Send; the microphone is not allowed, so listening was not tried'

    heard_nearby = False
    try:
        # End stops it, and the message box comes back.
        tap(wait_for('the Hands-free button', desc='Hands-free'))
        wait_for('hands-free listening', timeout=8, contains='Listening')
        tap(wait_for('the End button', desc='End hands-free'))
        wait_gone('the hands-free bar', timeout=5, desc='End hands-free')
        if not editable(screen()):
            raise CheckFailed('the message box did not come back after End')

        # Going to the background stops it.
        tap(wait_for('the Hands-free button', desc='Hands-free'))
        wait_for('hands-free listening', timeout=8, contains='Listening')
        key(3)
        time.sleep(1.5)
        safe_front('opening the app')
        shell(f'am start -W -n {PKG}/.MainActivity')  # back to the same task, not a fresh start
        wait_for('the chat after coming back', timeout=10, desc='Hands-free')
        if find(screen(), desc='End hands-free'):
            raise CheckFailed('hands-free was still on after the app went to the background')

        # A quiet moment stops it, with a message saying why.
        tap(wait_for('the Hands-free button', desc='Hands-free'))
        wait_for('hands-free listening', timeout=8, contains='Listening')
        end = time.time() + 25
        while True:
            nodes = screen()
            if find(nodes, contains='no speech heard'):
                quiet = 'stopped after silence with a message'
                break
            if find(nodes, contains='Thinking') or find(nodes, contains='Speaking'):
                heard_nearby = True  # someone talked near the phone: stop, and remove the chat it started
                quiet = 'heard speech nearby, so the silence stop was not checked'
                break
            if not find(nodes, desc='End hands-free'):
                raise CheckFailed('hands-free ended after silence without saying why')
            if time.time() > end:
                raise CheckFailed('still listening after 25 s of quiet')
            time.sleep(1)
        return f'swaps with Send; End and the background stop it; {quiet}'
    finally:
        end_button = find(screen(), desc='End hands-free')
        if end_button:
            tap(end_button[0])
        if heard_nearby:
            stop = find(screen(), desc='Stop')
            if stop:
                tap(stop[0])
            time.sleep(1)
            delete_open_chat()


CHECKS = {
    'launch': check_launch,
    'chat_typing': check_chat_typing,
    'chat_send': check_chat_send,
    'save_note': check_save_note,
    'pin_chat': check_pin_chat,
    'actions': check_actions,
    'share': check_share,
    'resume': check_resume,
    'text_fields': check_text_fields,
    'find_laptop': check_find_laptop,
    'pair_link': check_pair_link,
    'memory': check_memory,
    'performance': check_performance,
    'haptics': check_haptics,
    'backup': check_backup,
    'voice_language': check_voice_language,
    'hands_free': check_hands_free,
    'privacy': check_privacy,
    'layout': check_layout,
    'library': check_library,
    'library_files': check_library_files,
}


def preflight(force: bool) -> None:
    out = adb('devices')
    if not re.search(r'\tdevice\b', out):
        sys.exit('No phone connected over adb. Connect it (adb connect / wireless debugging) and try again.')
    power = shell('dumpsys power')
    if 'mWakefulness=Awake' not in power or 'isKeyguardShowing=true' in shell('dumpsys window'):
        sys.exit('The phone is asleep or locked. Unlock it, leave it on the home screen, and run again.')
    front = foreground()
    if not force and front != PKG and not any(l in front for l in LAUNCHERS):
        sys.exit(f'Another app is in front ({front}). Go to the home screen first, or pass --force.')
    if not force and panel_open():
        sys.exit('The notification panel is open. Close it and leave the phone on the home screen.')
    if PKG not in shell(f'pm list packages {PKG}'):
        sys.exit(f'{PKG} is not installed.')


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows consoles may not be UTF-8
        stream.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('checks', nargs='*', help='checks to run (default: all)')
    parser.add_argument('--list', action='store_true', help='list the checks and exit')
    parser.add_argument('--device', help='adb serial, if more than one device is connected')
    parser.add_argument('--force', action='store_true', help='run even if another app is in front')
    args = parser.parse_args()
    if args.list:
        for name, fn in CHECKS.items():
            print(f'{name:12} {fn.__doc__}')
        return 0
    if args.device:
        os.environ['ANDROID_SERIAL'] = args.device
    unknown = [c for c in args.checks if c not in CHECKS]
    if unknown:
        sys.exit(f"Unknown check(s): {', '.join(unknown)}. Use --list.")
    preflight(args.force)
    version = re.search(r'versionName=(\S+)', shell(f'dumpsys package {PKG}'))
    print(f"Aislet {version.group(1) if version else '?'} on {shell('getprop ro.product.model').strip()}")

    names = args.checks or list(CHECKS)
    if 'launch' not in names:
        names = ['launch', *names]  # every run starts from a fresh launch
    failed = skipped = 0
    for i, name in enumerate(names):
        started = time.time()
        try:
            detail = CHECKS[name]()
            print(f'PASS {name} ({time.time() - started:.0f} s): {detail}', flush=True)
        except Exception as e:  # report and carry on with the next check
            failed += 1
            print(f'FAIL {name} ({time.time() - started:.0f} s): {e}', flush=True)
            save_evidence(name)
            try:
                hide_keyboard()
            except Exception:
                pass
            if name == 'launch':
                skipped = len(names) - i - 1
                for rest in names[i + 1:]:
                    print(f'SKIP {rest}: the app did not start', flush=True)
                break
    passed = len(names) - failed - skipped
    print(f"{passed}/{len(names)} passed" + (f', {skipped} not run' if skipped else '') + (f'; evidence in {OUT}' if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
