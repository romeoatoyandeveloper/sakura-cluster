#!/usr/bin/env python3
"""psx-core's controller reading, without controllers: FIFOs fed the reports a PS4 (DualShock 4) and a PS5 (DualSense)
send over USB and Bluetooth, and evdev events (a driver's gamepad, and a Sony pad on the generic HID driver).
Checks the buttons psx-core reports ({"ev":"pad","b":...}, the same bits the game gets).

    python3 native/psx-core/test/test_pads.py native/psx-core/bin/psx-core
"""
import json, os, socket, struct, subprocess, sys, tempfile, time

B, Y, SELECT, START, UP, DOWN, LEFT, RIGHT, A, X, L, R_, L2, R2, L3, R3, PS = [1 << i for i in range(17)]
CROSS, SQUARE, CIRCLE, TRIANGLE = B, Y, A, X

core = sys.argv[1]
tmp = tempfile.mkdtemp()
fifos = {k: os.path.join(tmp, k) for k in ('ds4', 'ds5', 'evdev', 'generic')}
for p in fifos.values():
    os.mkfifo(p)
env = dict(os.environ, PSX_RUN=os.path.join(tmp, 'run'), PSX_HOME=os.path.join(tmp, 'home'),
           PSX_TEST_PADS=','.join('%s:%s' % kv for kv in fifos.items()))
proc = subprocess.Popen([core], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
writers = {}
for k, p in fifos.items():                 # opened for writing once psx-core holds the read end
    for _ in range(50):
        try:
            writers[k] = os.open(p, os.O_WRONLY | os.O_NONBLOCK)
            break
        except OSError:
            time.sleep(0.1)
s = socket.socket(socket.AF_UNIX)
for _ in range(50):
    try:
        s.connect(os.path.join(tmp, 'run', 'ctl.sock'))
        break
    except OSError:
        time.sleep(0.1)
s.settimeout(0.3)
buf = b''


def last_pad(wait=0.4):
    """The last {"ev":"pad"} buttons within wait s."""
    global buf
    b = None
    end = time.time() + wait
    while time.time() < end:
        try:
            buf += s.recv(65536)
        except socket.timeout:
            pass
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            d = json.loads(line)
            if d.get('ev') == 'pad':
                b = d['b']
    return b


def face(dpad, sq=0, cr=0, ci=0, tr=0): return dpad | sq << 4 | cr << 5 | ci << 6 | tr << 7
def ds4_usb(fb, sh=0, ps=0, lx=128, ly=128): return bytes([0x01, lx, ly, 128, 128, fb, sh, ps]) + bytes(56)
def ds4_bt(fb, sh=0, ps=0): return bytes([0x11, 0xC0, 0x00, 128, 128, 128, 128, fb, sh, ps]) + bytes(68)
def ds5_usb(fb, sh=0, ps=0): return bytes([0x01, 128, 128, 128, 128, 0, 0, 0, fb, sh, ps]) + bytes(53)
def ds5_bt(fb, sh=0, ps=0): return bytes([0x31, 0x00, 128, 128, 128, 128, 0, 0, 0, fb, sh, ps]) + bytes(66)
def ds5_bt_basic(fb, sh=0, ps=0): return bytes([0x01, 128, 128, 128, 128, fb, sh, ps, 0, 0])
def ev(t, c, v): return struct.pack('llHHi', 0, 0, t, c, v)
def syn(): return ev(0, 0, 0)


NONE = 8
cases = [
    ('PS4 USB: cross + up', 'ds4', ds4_usb(face(0, cr=1)), CROSS | UP),
    ('PS4 USB: square + down-left, L1 R2', 'ds4', ds4_usb(face(5, sq=1), sh=0x01 | 0x08), SQUARE | DOWN | LEFT | L | R2),
    ('PS4 USB: left stick pushed right = right', 'ds4', ds4_usb(face(NONE), lx=255), RIGHT),
    ('PS4 Bluetooth: circle, options', 'ds4', ds4_bt(face(NONE, ci=1), sh=0x20), CIRCLE | START),
    ('PS4 released', 'ds4', ds4_usb(face(NONE)), 0),
    ('PS5 USB: triangle + L1, PS', 'ds5', ds5_usb(face(NONE, tr=1), sh=0x01, ps=1), TRIANGLE | L | PS),
    ('PS5 Bluetooth: square, create', 'ds5', ds5_bt(face(NONE, sq=1), sh=0x10), SQUARE | SELECT),
    ('PS5 Bluetooth basic: cross + right', 'ds5', ds5_bt_basic(face(2, cr=1)), CROSS | RIGHT),
    ('PS5 released', 'ds5', ds5_usb(face(NONE)), 0),
    ('evdev gamepad: south + hat up', 'evdev', ev(1, 0x130, 1) + ev(3, 0x11, -1) + syn(), CROSS | UP),
    ('evdev gamepad: released', 'evdev', ev(1, 0x130, 0) + ev(3, 0x11, 0) + syn(), 0),
    ('generic HID Sony: 2nd button = cross, 3rd = circle', 'generic', ev(1, 0x121, 1) + ev(1, 0x122, 1) + syn(), CROSS | CIRCLE),
    ('generic HID Sony: released', 'generic', ev(1, 0x121, 0) + ev(1, 0x122, 0) + syn(), 0),
]
time.sleep(0.5)
last_pad()
fails = 0
for name, k, data, want in cases:
    os.write(writers[k], data)
    got = last_pad()
    got = 0 if got is None and want == 0 else got
    ok = got == want
    fails += not ok
    print('%-52s %s%s' % (name, 'ok' if ok else 'FAIL', '' if ok else ' (got %s, want %s)' % (got, want)))
proc.terminate()
proc.wait(5)
print('all ok' if not fails else '%d failed' % fails)
sys.exit(1 if fails else 0)
