"""Speed baseline on a phone over adb: cold start, reply times, model speed and memory, in the release app.

    python scripts/eval/phone_speed.py state           which AI, performance mode and accelerator are set
    python scripts/eval/phone_speed.py cold [runs]     cold starts: first frame, message box and a ready AI
    python scripts/eval/phone_speed.py chat [runs]     a made-up prompt and two follow-ups in a new chat, timed
    python scripts/eval/phone_speed.py memory          the app's memory use (PSS and RSS)
    python scripts/eval/phone_speed.py laptop-off      switch "Use the laptop's AI at home" off (laptop-on: back on)

It reuses the phone e2e suite's helpers (e2e/phone/run.py) and its etiquette: it only acts when Aislet or the
launcher is in front, prints timings and settings only (never screen text from your own chats), and deletes its
test chats ("E2E check: ...") afterwards (after a failed run, check the chat list). Set ANDROID_SERIAL when adb sees more than one device. It doesn't change
settings by itself; to time the phone's own model, run laptop-off first and laptop-on afterwards.
"""
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'e2e' / 'phone'))
import run as e2e  # noqa: E402

PKG = e2e.PKG
PROMPT = 'E2E check: explain briefly how a heat pump heats a home.'
FOLLOW_UP = 'And compare its running cost with a gas boiler.'
WITH_NUMBER = 'Give a rough cost to fit one in 2026.'  # a number turns on the alarm/timer instructions


def ms() -> int:
    return int(time.time() * 1000)


def in_front_ok() -> None:
    front = e2e.foreground()
    if front != PKG and not any(l in front for l in e2e.LAUNCHERS):
        sys.exit(f'Another app is in front ({front}): stopping.')
    if e2e.panel_open():
        sys.exit('The notification panel is open: stopping.')
    if front != PKG:
        e2e.shell(f'am start -W -n {PKG}/.MainActivity')
        e2e.wait_for('the Menu button', timeout=20, desc='Menu')


def switch_state(label: str) -> bool | None:
    """The switch on the row whose title is `label`, scrolling Settings to it."""
    row = e2e.scroll_to(label, text=label)
    nodes = e2e.screen()
    switches = [n for n in nodes if n.cls.endswith('Switch') and abs(n.cy - row.cy) < 120]
    return switches[0].checked if switches else None


def state() -> None:
    in_front_ok()
    e2e.go_tab('Settings')
    e2e.scroll_to_top()
    e2e.scroll_to('Speed and heat', contains='Speed and heat')
    e2e.scroll_to('the performance buttons', text='Performance')
    print('Performance:', e2e.current_mode())
    for accel in ('CPU', 'GPU', 'NPU'):
        hit = [n for n in e2e.find(e2e.screen(), text=accel) if n.checked]
        if hit:
            print('Accelerator:', accel)
    e2e.scroll_to_top()
    print("Use the laptop's AI at home:", switch_state("Use the laptop's AI at home"))
    e2e.scroll_to_top()
    e2e.go_tab('Chat')


def set_laptop(on: bool) -> None:
    """Switch "Use the laptop's AI at home" on or off. Put it back as it was when you're done."""
    in_front_ok()
    e2e.go_tab('Settings')
    e2e.scroll_to_top()
    label = "Use the laptop's AI at home"
    if switch_state(label) != on:
        row = e2e.scroll_to(label, text=label)
        switch = [n for n in e2e.screen() if n.cls.endswith('Switch') and abs(n.cy - row.cy) < 120][0]
        e2e.tap(switch)
        time.sleep(1.5)
    print(f'{label}:', switch_state(label))
    e2e.scroll_to_top()
    e2e.go_tab('Chat')


def cold(runs: int) -> None:
    in_front_ok()
    e2e.go_tab('Chat')  # Aislet reopens where it was left, so leave it on the chat
    rows = []
    for i in range(runs):
        e2e.key(3)
        time.sleep(1)
        e2e.shell(f'am force-stop {PKG}')
        time.sleep(3)
        e2e.adb('logcat', '-c', check=False)
        t0 = ms()
        out = e2e.shell(f'am start -W -n {PKG}/.MainActivity -f 0x10008000')
        frame = int(re.search(r'TotalTime: (\d+)', out).group(1))
        box = ready = None
        while ms() - t0 < 60_000:
            nodes = e2e.screen()
            now = ms() - t0
            if box is None and e2e.editable(nodes):
                box = now
            if e2e.find(nodes, contains='· private'):
                ready = now
                break
        # The phone's own clock: from the app process's first log line to React Native running the app's JS.
        pid = e2e.shell(f'pidof {PKG}').strip()
        stamps = [(float(l.split()[0]), l) for l in e2e.adb('logcat', '-d', '-v', 'epoch', f'--pid={pid}', timeout=30, check=False).splitlines()
                  if re.match(r'\s*\d+\.\d+\s', l)]
        js = next((round((t - stamps[0][0]) * 1000) for t, l in stamps if 'Running "main"' in l), None) if stamps else None
        rows.append((frame, js, box, ready))
        print(f'run {i + 1}: first frame {frame} ms, JS running {js} ms after the process started, '
              f'message box seen by {box} ms, AI ready seen by {ready} ms')
    print('(the screen is read every ~2 s, so "seen by" times are upper bounds)')


def answer_nodes(nodes, prompt_node):
    composer = e2e.editable(nodes)[-1]
    return [n for n in nodes if n.text and n.y1 > prompt_node.y2 and n.y2 < composer.y1
            and n.text not in (PROMPT, FOLLOW_UP, WITH_NUMBER) and not n.cls.endswith('EditText')]


def phone_log() -> list[tuple[float, str]]:
    """The app's log since it was last cleared, as (phone time, message). Only llama.rn and the app's own lines."""
    pid = e2e.shell(f'pidof {PKG}').strip()
    out = e2e.adb('logcat', '-d', '-v', 'epoch', f'--pid={pid}', 'RNLlama:*', 'ReactNativeJS:*', '*:S', timeout=30, check=False)
    rows = []
    for line in out.splitlines():
        m = re.match(r'\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+[^:]+:\s?(.*)', line)
        if m:
            rows.append((float(m.group(1)), m.group(2)))
    return rows


def send_and_time(text: str) -> dict:
    box = e2e.message_box()
    e2e.tap(box)
    e2e.wait_keyboard(True)
    e2e.type_text(text)
    time.sleep(0.5)
    send = e2e.find(e2e.screen(), desc='Send')
    if not send:
        raise e2e.CheckFailed('no Send button')
    e2e.adb('logcat', '-c', check=False)
    t0 = ms()
    e2e.tap(send[0])
    words = 0
    # uiautomator waits for the screen to be still, so it can't see words arrive: only the finished reply.
    while ms() - t0 < 300_000:
        nodes = e2e.screen()
        if e2e.find(nodes, desc='Copy') and not e2e.find(nodes, desc='Stop'):
            sent = e2e.find(nodes, text=text)
            if sent:
                words = sum(len(re.findall(r"\w+", n.text)) for n in answer_nodes(nodes, sent[-1]))
            break
        if e2e.find(nodes, text='Dismiss'):
            raise e2e.CheckFailed('the reply failed with an error card')
    done = ms() - t0
    log = phone_log()
    # On the phone's own model, llama.rn logs the chat prompt (a Qwen prompt starts with token 248045) when it
    # starts reading it, and the app logs its speed when the reply ends: the time between is the model's work.
    start = next((t for t, m in log if 'prompt_tokens = 248045' in m), None)
    end = next((t for t, m in log if 'tok/s on' in m), None)
    tok = next((re.search(r'\] ([\d.]+) tok/s on (\w+)', m) for t, m in log if 'tok/s on' in m), None)
    split = next((re.search(r'read (\d+) new tokens in ([\d.]+) s, wrote (\d+)', m) for t, m in log if 'new tokens' in m), None)
    return {'done': done, 'words': words, 'model_s': round(end - start, 1) if start and end else None,
            'full_reprocess': any('full cache clear' in m for _, m in log),
            'tok_s': float(tok.group(1)) if tok else None, 'accel': tok.group(2) if tok else None,
            'read': f'read {split.group(1)} new tokens in {split.group(2)} s, wrote {split.group(3)}' if split else None}


def delete_test_chats() -> int:
    """Delete every "E2E check" chat. Uses the list's own Close button, not Back (Back on a chat opens the list)."""
    in_front_ok()
    nodes = e2e.screen()
    if not e2e.find(nodes, desc='Close menu'):
        e2e.tap(e2e.wait_for('the Menu button', desc='Menu'))
        time.sleep(2)
    deleted = 0
    for _ in range(10):
        nodes = e2e.screen()
        rows = [n for n in nodes if n.text.startswith('E2E check')]
        buttons = [b for b in e2e.find(nodes, desc='Delete chat') if rows and b.y1 - 20 <= rows[0].cy <= b.y2 + 20]
        if not buttons:
            break
        e2e.tap_xy(buttons[0].cx, buttons[0].cy)
        for _ in range(20):  # the prompt can take a few seconds while the phone model is busy
            ok = [n for n in e2e.screen() if n.cls.endswith('Button') and n.text.upper() == 'DELETE']
            if ok:
                e2e.tap_xy(ok[0].cx, ok[0].cy)
                deleted += 1
                time.sleep(1.5)
                break
            time.sleep(0.5)
        else:
            raise e2e.CheckFailed('no Delete prompt for a test chat: check the chat list by hand')
    close = e2e.find(e2e.screen(), desc='Close menu')
    if close:
        e2e.tap_xy(close[0].cx, close[0].cy)
        time.sleep(1)
    return deleted


def chat(runs: int) -> None:
    in_front_ok()
    try:
        for i in range(runs):
            e2e.open_new_chat()
            for label, text in (('new chat', PROMPT), ('follow-up', FOLLOW_UP), ('with a number', WITH_NUMBER)):
                r = send_and_time(text)
                e2e.hide_keyboard()
                line = f"run {i + 1} {label:13} reply finished by {r['done']} ms, {r['words']} words"
                if r['tok_s']:
                    line += (f"; phone model busy {r['model_s']} s, writing at {r['tok_s']} tok/s on {r['accel']}"
                             f"{', whole prompt read again' if r['full_reprocess'] else ''}")
                if r['read']:
                    line += f"; {r['read']}"
                print(line)
            delete_test_chats()
    finally:
        print('test chats deleted:', delete_test_chats())
    print('(the screen is read every ~2 s and only once the reply is still, so "finished by" is an upper bound; with the '
          "laptop's AI, Ollama's log on the laptop has its prompt sizes and times)")


def memory() -> None:
    out = e2e.shell(f'dumpsys meminfo {PKG}')
    for line in out.splitlines():
        if re.match(r'\s*(TOTAL PSS|TOTAL RSS|TOTAL SWAP|Native Heap|Graphics|Unknown|TOTAL:)', line):
            print(line.rstrip())


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    what = sys.argv[1] if len(sys.argv) > 1 else ''
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    e2e.preflight(force=False)
    {'state': state, 'cold': lambda: cold(n), 'chat': lambda: chat(n), 'memory': memory,
     'laptop-on': lambda: set_laptop(True), 'laptop-off': lambda: set_laptop(False)}.get(what, lambda: print(__doc__))()
