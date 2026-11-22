#!/var/opt/mgu-python/current/bin/python3
"""sport-ambient-pulse: when the Driving Experience Control goes into Sport (Sport, Sport Plus or Sport Individual)
from any other mode, the cabin's ambient light pulses red three times, then is exactly as it was.

For a BMW iDrive 7 (MGU) head unit with the MGU Store, mgu-python and IterioDev's Comfort tool (iteriodev-comfort,
which the Store installs with his Ambient Light app). Comfort is used as installed, through its control socket
/run/iteriodev-comfort/ctl.sock (JSON lines; it sends its state as the first line of every connection and again after
every change):

  drive mode  Comfort reads FES (SOME/IP service 0xB50D, event 0x8025, and its getter once a second) and keeps it in
              its state as ambient.mode: 1 Sport, 2 Sport Plus, 3 Sport Individual, 4 to 6 Comfort (Plus,
              Individual), 7 to 9 Eco Pro (Plus, Individual), 10 Adaptive; a name is read too (a plug-in hybrid's
              start with PHEV_: PHEV_SPORT_STANDARD). Since 1.1.0 the drive mode Cluster Themes (or HUD Widgets)
              reads comes first when it is there: those apps write it to /dev/shm/sakura-cluster/drive_mode.json
              every 2 s, and they read a plug-in hybrid's drive mode, which Comfort may not (a 745e's did nothing).
  light       {"op": "ambient", "settings": {on, rgb, bright 5-100, follow, zones, modes}}. Comfort writes each light
              module through the body controller (UDS 2E DA5E / E3D1 to the BDC, via the head unit's diagnostic
              gateway) with a hold time of at most 254 s, after which the module shows the car's own colour again.
              Nothing is coded: a reboot, or Comfort stopping, gives the car its own light back.

A pulse: the light's settings are read and kept (also on disk, pending.json, until they are back), then the colour
goes to red at full brightness, dim, full, dim, full, dim (one phase every phase_ms; Comfort puts at most one round of
writes on the bus every 500 ms, so a phase can't be shorter), then the kept settings are sent back and read back to
check, in a finally. A pulse left half done (a crash, a power cut) is put right at the next start.

Only while the car's own ambient light is on (Comfort lights nothing otherwise) and Comfort has found light modules.
The daemon holds no connection to Comfort between pulses: Comfort halts a seat move started by an app when its last
client leaves, and a connection kept open would stop that from working.

  sport_ambient_pulse.py --daemon        the service (systemd: sport-ambient-pulse.service)
  sport_ambient_pulse.py --test-pulse    one pulse now, whatever the drive mode
  sport_ambient_pulse.py --status        what Comfort reports, and anything that would stop a pulse
  sport_ambient_pulse.py --restore       put back the settings of a pulse left half done
  sport_ambient_pulse.py --self-test     offline checks

What it is doing goes to /dev/shm/sport-ambient-pulse/status.json (every 2 s and at each change), which Cluster Themes
shows on its Settings tab, so it can be checked from the car's screen.
"""
import argparse
import copy
import fcntl
import json
import logging
import logging.handlers
import os
import re
import signal
import socket
import subprocess
import sys
import time

ID = 'sport-ambient-pulse'
VERSION = '1.1.0'
HOME = os.environ.get('SAP_HOME', '/var/opt/' + ID)
SOCK = os.environ.get('SAP_COMFORT_SOCK', '/run/iteriodev-comfort/ctl.sock')
LOCK = os.environ.get('SAP_LOCK', '/run/' + ID + '.lock')
RECMGR = os.environ.get('SAP_RECMGR', '/etc/recmgr-restartlist.conf')
MARKER = os.path.join(HOME, 'pending.json')
# the drive mode Cluster Themes / HUD Widgets read (rewritten every 2 s while one runs; older than DRIVE_FRESH_S: gone)
DRIVE = os.environ.get('SAP_DRIVE', '/dev/shm/sakura-cluster/drive_mode.json')
DRIVE_FRESH_S = 8.0
# what this is doing, for Cluster Themes' Settings tab
STATUS = os.environ.get('SAP_STATUS', '/dev/shm/' + ID + '/status.json')

MODES = {1: 'Sport', 2: 'Sport Plus', 3: 'Sport Individual', 4: 'Comfort', 5: 'Comfort Plus', 6: 'Comfort Individual',
         7: 'Eco Pro', 8: 'Eco Pro Plus', 9: 'Eco Pro Individual', 10: 'Adaptive'}
DEFAULTS = {
    'rgb': [254, 0, 0],          # a light module reads FF as "no change", so a colour tops out at FE
    'pulses': 3,
    'phase_ms': 600,             # each bright and each dim phase; at least MIN_PHASE_MS
    'bright_high': 100,
    'bright_low': 5,             # Comfort's lowest
    'poll_ms': 500,              # how often Comfort's state is read
    'cooldown_s': 3.0,           # after a pulse, no new one for this long
    'sport_modes': [1, 2, 3],
    'when_ambient_config': 'skip',   # the kit's Ambient config writing the lights itself: 'skip' the pulse or 'pulse'
}
MIN_PHASE_MS = 500               # Comfort's gap between two rounds of writes
RESTORE_TRIES = 5

log = logging.getLogger(ID)


class ComfortError(Exception):
    pass


class Stop(Exception):
    """SIGTERM / SIGINT during a pulse's phases: the finally puts the light back, then the program ends."""


RUN = {'stop': False, 'pulsing': False}


def _on_signal(signum, frame):
    RUN['stop'] = True
    if RUN['pulsing']:
        raise Stop()


# ---- config -------------------------------------------------------------------------------------------------------

def load_config(path):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        with open(path) as f:
            user = json.load(f)
        unknown = sorted(set(user) - set(DEFAULTS))
        if unknown:
            log.warning('config %s: unknown keys %s left out', path, ', '.join(unknown))
        cfg.update({k: v for k, v in user.items() if k in DEFAULTS})
    rgb = cfg['rgb']
    if not (isinstance(rgb, list) and len(rgb) == 3 and all(isinstance(x, int) and 0 <= x <= 254 for x in rgb)):
        raise ValueError('rgb must be three whole numbers 0-254')
    for k, lo, hi in (('pulses', 1, 10), ('bright_high', 5, 100), ('bright_low', 5, 100)):
        if not (isinstance(cfg[k], int) and lo <= cfg[k] <= hi):
            raise ValueError('%s must be a whole number %d-%d' % (k, lo, hi))
    cfg['phase_ms'] = max(MIN_PHASE_MS, int(cfg['phase_ms']))
    cfg['poll_ms'] = max(100, int(cfg['poll_ms']))
    cfg['cooldown_s'] = max(0.0, float(cfg['cooldown_s']))
    cfg['sport_modes'] = [int(m) for m in cfg['sport_modes']]
    if cfg['when_ambient_config'] not in ('skip', 'pulse'):
        raise ValueError("when_ambient_config must be 'skip' or 'pulse'")
    return cfg


# ---- Comfort's control socket -------------------------------------------------------------------------------------

class Session:
    """One connection to Comfort: its state arrives as the first line, and again after every change."""

    def __init__(self, path=None, timeout=3.0):
        self.path = path or SOCK
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        try:
            self.sock.connect(self.path)
        except OSError as e:
            self.sock.close()
            raise ComfortError('Comfort is not reachable at %s (%s)' % (self.path, e.strerror or e))
        self.buf = b''
        self.state = self._next_state(timeout)

    def _line(self, deadline):
        while b'\n' not in self.buf:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ComfortError('Comfort did not answer in time')
            self.sock.settimeout(left)
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                raise ComfortError('Comfort did not answer in time')
            if not chunk:
                raise ComfortError('Comfort closed the connection')
            self.buf += chunk
            if len(self.buf) > 1 << 20:
                raise ComfortError('Comfort sent an over-long line')
        line, self.buf = self.buf.split(b'\n', 1)
        return line

    def _next_state(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            try:
                msg = json.loads(self._line(deadline).decode('utf-8'))
            except ValueError:
                continue
            if isinstance(msg, dict) and isinstance(msg.get('state'), dict):
                return msg['state']

    def send(self, settings):
        self.sock.sendall((json.dumps({'op': 'ambient', 'settings': settings}, separators=(',', ':')) + '\n').encode())

    def wait_for(self, pred, timeout):
        """The first state (the newest one held included) that pred() accepts."""
        if pred(self.state):
            return self.state
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ComfortError('Comfort did not report the change in time')
            self.state = self._next_state(left)
            if pred(self.state):
                return self.state

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def read_state():
    with Session() as s:
        return s.state


def ambient_of(state):
    a = state.get('ambient') if isinstance(state, dict) else None
    if not isinstance(a, dict) or not isinstance(a.get('settings'), dict):
        raise ComfortError('Comfort reports no ambient light settings')
    return a


# ---- the pulse ----------------------------------------------------------------------------------------------------

KEYS = ('on', 'rgb', 'bright', 'follow', 'zones', 'modes')


def canon(settings):
    """Settings as Comfort keeps them, comparable: its keys only, zones and modes in full."""
    s = {k: settings.get(k) for k in KEYS}
    s['zones'] = s['zones'] or {}
    s['modes'] = s['modes'] or {}
    return json.dumps(s, sort_keys=True)


def frames(snapshot, cfg):
    """The settings sent for each phase: red, bright and dim in turn. The zones with their own colour go red too
    (the ones switched off stay off), Comfort's drive-mode colours are held off (they would take the place of the
    red), and the car's brightness is not followed."""
    rgb = list(cfg['rgb'])
    zones = {z: {'rgb': rgb} for z, v in (snapshot.get('zones') or {}).items()
             if not (isinstance(v, dict) and v.get('off') is True)}
    base = {'on': True, 'rgb': rgb, 'follow': False, 'zones': zones, 'modes': {'on': False}}
    out = []
    for _ in range(cfg['pulses']):
        out.append(dict(base, bright=cfg['bright_high']))
        out.append(dict(base, bright=cfg['bright_low']))
    return out


def restore_settings(snapshot, current):
    """What to send to have the snapshot back: every key, every zone it had, and null for a zone it didn't have."""
    out = {k: copy.deepcopy(snapshot[k]) for k in ('on', 'rgb', 'bright', 'follow') if k in snapshot}
    out['modes'] = copy.deepcopy(snapshot.get('modes') or {'on': False})
    had = snapshot.get('zones') or {}
    now = (current or {}).get('zones') or {}
    out['zones'] = {z: (copy.deepcopy(had[z]) if z in had else None) for z in sorted(set(had) | set(now))}
    return out


def write_marker(snapshot, reason):
    os.makedirs(HOME, exist_ok=True)
    tmp = MARKER + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'settings': snapshot, 'reason': reason, 'at': time.strftime('%Y-%m-%d %H:%M:%S')}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, MARKER)
    try:
        d = os.open(HOME, os.O_RDONLY)
        os.fsync(d)
        os.close(d)
    except OSError:
        pass


def read_marker():
    try:
        with open(MARKER) as f:
            m = json.load(f)
        return m if isinstance(m, dict) and isinstance(m.get('settings'), dict) else None
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log.error('pending.json unreadable (%s): left in place', e)
        return None


def clear_marker():
    try:
        os.remove(MARKER)
    except FileNotFoundError:
        pass


def restore(snapshot, tries=RESTORE_TRIES):
    """Send the snapshot back until Comfort reports it; the marker goes once it does. True when restored."""
    want = canon(snapshot)
    for n in range(1, tries + 1):
        try:
            with Session() as s:
                cur = ambient_of(s.state)['settings']
                if canon(cur) != want:
                    s.send(restore_settings(snapshot, cur))
                    s.wait_for(lambda st: canon(ambient_of(st)['settings']) == want, 4.0)
            clear_marker()
            log.info('light restored (%s)', summary(snapshot))
            return True
        except (ComfortError, OSError) as e:
            log.warning('restore, try %d of %d: %s', n, tries, e)
            if n < tries:
                time.sleep(min(5, n))
    log.error('the light could not be restored now; pending.json keeps it for the next try')
    return False


def summary(s):
    m = s.get('modes') or {}
    return 'own colour %s, rgb %s, brightness %s%s, drive-mode colours %s, %d zone(s) of their own' % (
        'on' if s.get('on') else "off (the car's)", s.get('rgb'), s.get('bright'),
        ' following the car' if s.get('follow') else '', 'on' if m.get('on') else 'off', len(s.get('zones') or {}))


def ambient_config_pids():
    """The MGU App Kit's Ambient config app (it writes the same lights itself, in its own process)."""
    out = []
    me = os.getpid()
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == me:
            continue
        try:
            with open('/proc/%s/cmdline' % pid, 'rb') as f:
                if b'ambient_config' in f.read():
                    out.append(int(pid))
        except OSError:
            continue
    return out


class PulseLock:
    """One pulse at a time, the service's and --test-pulse's alike."""

    def __enter__(self):
        self.f = open(LOCK, 'w')
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.held = True
        except OSError:
            self.held = False
        return self

    def __exit__(self, *exc):
        if self.held:
            fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def pulse(cfg, reason):
    """One pulse, if the light can show it. True when it ran (the light is back afterwards)."""
    with PulseLock() as lock:
        if not lock.held:
            log.info('pulse (%s) skipped: another one is running', reason)
            last('skipped: another pulse was running')
            return False
        amb = ambient_of(read_state())
        snap = copy.deepcopy(amb['settings'])
        if amb.get('carOn') is not True:
            log.warning("pulse (%s) skipped: the car's own ambient light is off, and Comfort lights nothing then", reason)
            last("skipped: the car's own ambient light is off (car settings)")
            return False
        if not amb.get('modules'):
            log.warning('pulse (%s) skipped: Comfort has found no ambient light modules on this car', reason)
            last('skipped: Comfort found no ambient light modules')
            return False
        comfort_lights = snap.get('on') is True or (snap.get('modes') or {}).get('on') is True
        if not comfort_lights and ambient_config_pids():
            if cfg['when_ambient_config'] == 'skip':
                log.warning('pulse (%s) skipped: the Ambient config app is running and writes the lights itself '
                            '(when_ambient_config: "pulse" pulses anyway)', reason)
                last("skipped: the Ambient config app has the lights (turn on Ambient Light's own colour)")
                return False
            log.warning('the Ambient config app is running too: its colour may cut into the pulse')
        write_marker(snap, reason)
        log.info('pulse (%s): %d x red, %d ms a phase; kept: %s', reason, cfg['pulses'], cfg['phase_ms'], summary(snap))
        session = None
        try:
            RUN['pulsing'] = True
            if RUN['stop']:
                raise Stop()
            session = Session()
            t0 = time.monotonic()
            for i, f in enumerate(frames(snap, cfg)):
                wait = t0 + i * cfg['phase_ms'] / 1000.0 - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                session.send(f)
            time.sleep(cfg['phase_ms'] / 1000.0)
        finally:
            RUN['pulsing'] = False
            if session:
                session.close()
            back = restore(snap)
            last('pulsed (%s)%s' % (reason, '' if back else ', the light NOT put back yet'))
        return True


# ---- the service --------------------------------------------------------------------------------------------------

def mode_number(v):
    """A drive mode as Comfort's numbers (1 Sport .. 10 Adaptive) from a number or a name: SPORT, SPORT_PLUS,
    COMFORT_INDIVIDUAL, ECO_PRO..., a plug-in hybrid's with PHEV_ in front (PHEV_SPORT_STANDARD); None if unknown."""
    if isinstance(v, bool):
        return None
    if isinstance(v, str) and v.strip().isdigit():
        v = int(v.strip())
    if isinstance(v, int):
        return v if 1 <= v <= 10 else None
    if not isinstance(v, str):
        return None
    u = re.sub(r'^(PHEV|HEV|HYBRID)_', '', v.strip().upper())
    extra = 1 if re.search(r'PLUS|EXPERT', u) else 2 if 'INDIVID' in u else 0
    if u.startswith('SPORT'):
        return 1 + extra
    if u.startswith('COMFORT'):
        return 4 + extra
    if u.startswith('ECO') or u.startswith('EFFICIEN'):
        return 7 + extra
    if u.startswith('ADAPTIVE'):
        return 10
    return None


def shared_mode():
    """(Comfort's number, the car's value) from Cluster Themes' drive_mode.json while it is fresh, else None."""
    try:
        if time.time() - os.stat(DRIVE).st_mtime > DRIVE_FRESH_S:
            return None
        with open(DRIVE) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    base = {'sport': 1, 'comfort': 4, 'eco': 7}.get(d.get('mode')) if isinstance(d, dict) else None
    if base is None:
        return None
    return base + {'plus': 1, 'individual': 2}.get(d.get('variant'), 0), d.get('raw')


ST = {'version': VERSION, 'comfort': None, 'mode': None, 'source': None, 'last': None, 'lastAt': None}
_st_written = [0.0, None]


def report(force=False, **kw):
    """Update what this is doing and write it for Cluster Themes (at most every 2 s unless something changed)."""
    ST.update(kw)
    ST['at'] = time.time()
    key = json.dumps({k: v for k, v in ST.items() if k != 'at'}, sort_keys=True)
    if not force and key == _st_written[1] and time.monotonic() - _st_written[0] < 2.0:
        return
    try:
        d = os.path.dirname(STATUS)
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o755)
        tmp = STATUS + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(ST, f)
        os.chmod(tmp, 0o644)
        os.replace(tmp, STATUS)
        _st_written[0], _st_written[1] = time.monotonic(), key
    except OSError as e:
        if _st_written[1] != 'error':
            log.warning('status for Cluster Themes not written: %s', e)
            _st_written[1] = 'error'


def last(text):
    report(force=True, last=text, lastAt=time.time())


def name(mode):
    return MODES.get(mode, 'mode %s' % mode) if mode is not None else 'unknown'


def daemon(cfg):
    sport = set(cfg['sport_modes'])
    poll = cfg['poll_ms'] / 1000.0
    log.info('%s %s: Sport is %s; %d pulses of %s, %d ms a phase', ID, VERSION,
             ', '.join(name(m) for m in sorted(sport)), cfg['pulses'], cfg['rgb'], cfg['phase_ms'])
    prev = None                  # the last drive mode known (a gap in Comfort's news keeps it)
    source = None                # where the drive mode comes from: 'Cluster Themes' or 'Comfort'
    report(force=True, comfort=None, mode=None, source=None)
    quiet_until = 0.0            # no new pulse before this (monotonic)
    reachable = None
    retry_marker_at = 0.0
    while not RUN['stop']:
        m = read_marker()
        if m:
            if time.monotonic() >= retry_marker_at:
                log.info('a pulse was left half done (%s, %s): putting the light back', m.get('reason'), m.get('at'))
                if not restore(m['settings'], tries=1):
                    retry_marker_at = time.monotonic() + 10
            time.sleep(poll)
            continue
        try:
            cmode = ambient_of(read_state()).get('mode')
            if reachable is not True:
                log.info('Comfort reachable')
            reachable = True
        except ComfortError as e:
            if reachable is not False:
                log.warning('%s; waiting for it', e)
            reachable = False
            report(comfort=str(e))
            time.sleep(max(poll, 2.0))
            continue
        # the drive mode: Cluster Themes' while it writes one (it reads a plug-in hybrid's), else Comfort's; a change of
        # where it comes from starts over (no pulse for the first reading from the other one)
        sh = shared_mode()
        mode, src = (sh[0], 'Cluster Themes') if sh else (mode_number(cmode), 'Comfort')
        if src != source:
            log.info('drive mode from %s%s', src, '' if sh or mode is not None else ' (it reports none: %r)' % (cmode,))
            source, prev = src, None
        report(comfort='reachable', mode=name(mode), source=src)
        if isinstance(mode, int):
            if mode != prev:
                log.info('drive mode %s -> %s', name(prev), name(mode))
            if prev is not None and prev not in sport and mode in sport:
                if time.monotonic() < quiet_until:
                    log.info('Sport again within %.0f s of the last pulse: no pulse', cfg['cooldown_s'])
                else:
                    try:
                        pulse(cfg, '%s -> %s' % (name(prev), name(mode)))
                    except ComfortError as e:
                        log.warning('pulse not run: %s', e)
                        last('not run: %s' % e)
                    quiet_until = time.monotonic() + cfg['cooldown_s']
                    try:         # the mode after the pulse is the one the next change is measured from
                        sh = shared_mode()
                        after = sh[0] if sh and source == 'Cluster Themes' else mode_number(ambient_of(read_state()).get('mode'))
                        mode = after if isinstance(after, int) else mode
                    except ComfortError:
                        pass
            prev = mode
        time.sleep(poll)
    report(force=True, comfort=None, mode=None, source=None, last='stopped', lastAt=time.time())
    log.info('stopped')


# ---- status, install helpers ---------------------------------------------------------------------------------------

def status(cfg):
    ok = True
    print('%s %s' % (ID, VERSION))
    try:
        r = subprocess.run(['systemctl', 'is-active', ID + '.service'], capture_output=True, text=True, timeout=5)
        print('service: %s' % ((r.stdout.strip() or r.stderr.strip() or '?').splitlines()[0]))
    except (OSError, subprocess.SubprocessError):
        print('service: (systemctl not available)')
    print('recmgr entry: %s' % ('yes' if recmgr_has(ID) else 'NO (the service starts at boot only once it is listed)'))
    try:
        amb = ambient_of(read_state())
        mods = amb.get('modules') or []
        print('Comfort: reachable at %s' % SOCK)
        cm = mode_number(amb.get('mode'))
        print("drive mode, Comfort's: %s%s (it sends %r)" % (name(cm), ' (Sport)' if cm in cfg['sport_modes'] else '', amb.get('mode')))
        print("car's own ambient light: %s" % {True: 'on', False: 'OFF (no pulse while it is off)'}.get(amb.get('carOn'), 'unknown'))
        print('light modules found: %d%s' % (len(mods), '' if mods else ' (NO PULSE POSSIBLE: Comfort found none)'))
        for x in mods:
            print('  %-28s zone %-10s%s' % (x.get('name'), x.get('zone'), '  FAULT' if x.get('fault') else ''))
        print('Comfort light now: %s' % summary(amb['settings']))
        ok = bool(mods) and amb.get('carOn') is True
    except ComfortError as e:
        ok = False
        print('Comfort: %s' % e)
        print('  (install IterioDev\'s Ambient Light app from the MGU Store: it brings the Comfort tool)')
    sh = shared_mode()
    print("drive mode, Cluster Themes': %s" % ('%s%s (the car sends %r; this one is used)' % (name(sh[0]), ' (Sport)' if sh[0] in cfg['sport_modes'] else '', sh[1])
                                               if sh else 'none (Cluster Themes 0.22.6 or later writes it while it runs)'))
    pids = ambient_config_pids()
    print('Ambient config app (MGU App Kit): %s' % ('RUNNING, pid %s (when_ambient_config: %s)' % (
        ', '.join(map(str, pids)), cfg['when_ambient_config']) if pids else 'not running'))
    m = read_marker()
    print('pulse left half done: %s' % ('YES, from %s (run --restore)' % m.get('at') if m else 'no'))
    return 0 if ok else 1


def recmgr_edit(add, name_):
    """Add the name to, or take it out of, recmgr's [Whitelist] and [WhitelistExitSuccess] (read at boot); every
    other line stays as it is. A copy of the list as it was goes to HOME the first time."""
    with open(RECMGR) as f:
        text = f.read()
    keep = os.path.join(HOME, 'recmgr-restartlist.conf.orig')
    if not os.path.exists(keep):
        os.makedirs(HOME, exist_ok=True)
        with open(keep, 'w') as f:
            f.write(text)
    sections = ('Whitelist', 'WhitelistExitSuccess')
    lines, out, cur, seen = text.split('\n'), [], None, set()

    def flush(sec):
        if add and sec in sections and sec not in seen:
            while out and out[-1].strip() == '':
                out.pop()
            out.append(name_)
            out.append('')
            seen.add(sec)

    for line in lines:
        s = line.split('#')[0].strip()
        if s.startswith('[') and s.endswith(']'):
            flush(cur)
            cur = s[1:-1]
            out.append(line)
            continue
        if cur in sections and s == name_:
            if add:
                seen.add(cur)
                out.append(line)
            continue                 # removing: the line goes
        out.append(line)
    flush(cur)
    if add:
        for sec in sections:
            if sec not in seen:
                out += ['[%s]' % sec, name_, '']
    new = '\n'.join(out)
    if new != text:
        tmp = RECMGR + '.sap-tmp'
        with open(tmp, 'w') as f:
            f.write(new)
        os.chmod(tmp, 0o644)
        os.replace(tmp, RECMGR)
    return new != text


def recmgr_has(name_):
    try:
        with open(RECMGR) as f:
            text = f.read()
    except OSError:
        return False
    found, cur = set(), None
    for line in text.split('\n'):
        s = line.split('#')[0].strip()
        if s.startswith('[') and s.endswith(']'):
            cur = s[1:-1]
        elif s == name_:
            found.add(cur)
    return {'Whitelist', 'WhitelistExitSuccess'} <= found


def self_test():
    cfg = load_config(None)
    snap = {'on': False, 'rgb': [40, 120, 254], 'bright': 70, 'follow': True,
            'zones': {'dash': {'rgb': [0, 200, 0]}, 'doors': {'off': True}}, 'modes': {'on': True, 'rgb': {'1': [254, 30, 0]}}}
    fr = frames(snap, cfg)
    assert len(fr) == 6 and [f['bright'] for f in fr] == [100, 5, 100, 5, 100, 5]
    assert all(f['rgb'] == [254, 0, 0] and f['on'] and f['follow'] is False and f['modes'] == {'on': False} for f in fr)
    assert fr[0]['zones'] == {'dash': {'rgb': [254, 0, 0]}}, 'a zone switched off stays off'
    r = restore_settings(snap, {'zones': {'dash': {'rgb': [254, 0, 0]}, 'roof': {'rgb': [1, 2, 3]}}})
    assert r['zones'] == {'dash': {'rgb': [0, 200, 0]}, 'doors': {'off': True}, 'roof': None}
    assert r['on'] is False and r['bright'] == 70 and r['follow'] is True and r['modes']['on'] is True
    assert canon(snap) == canon(json.loads(json.dumps(snap)))
    assert load_config(None)['phase_ms'] >= MIN_PHASE_MS
    assert [mode_number(v) for v in (1, '3', 'SPORT', 'PHEV_SPORT_STANDARD', 'PHEV_SPORT_PLUS', 'SPORT_INDIVIDUAL', 'PHEV_COMFORT',
                                      'ECO_PRO', 'PHEV_ECO_PRO_PLUS', 'ADAPTIVE', None, 0, True, 'NOPE')] == [1, 3, 1, 1, 2, 3, 4, 7, 8, 10, None, None, None, None]
    print('self-test ok')
    return 0


# ---- main ---------------------------------------------------------------------------------------------------------

def setup_logging(to_file):
    log.setLevel(logging.INFO)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(message)s', '%Y-%m-%d %H:%M:%S')
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(fmt)
    log.addHandler(h)
    if to_file:
        # the head unit's journal keeps only minutes: events (never the polls) also go to a small file
        try:
            os.makedirs(HOME, exist_ok=True)
            fh = logging.handlers.RotatingFileHandler(os.path.join(HOME, 'pulse.log'), maxBytes=256 * 1024, backupCount=1)
            fh.setFormatter(fmt)
            log.addHandler(fh)
        except OSError as e:
            log.warning('no log file (%s)', e)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--daemon', action='store_true', help='run the service')
    g.add_argument('--test-pulse', action='store_true', help='one pulse now, whatever the drive mode')
    g.add_argument('--status', action='store_true', help="Comfort's state and what would stop a pulse")
    g.add_argument('--restore', action='store_true', help='put back the settings of a pulse left half done')
    g.add_argument('--self-test', action='store_true', help='offline checks')
    g.add_argument('--recmgr', choices=['add', 'remove'], help="(install / uninstall) recmgr's restart list")
    p.add_argument('--config', default=os.path.join(HOME, 'config.json'))
    a = p.parse_args(argv)
    setup_logging(a.daemon or a.test_pulse or a.restore)
    if a.self_test:
        return self_test()
    if a.recmgr:
        if not os.path.exists(RECMGR):
            print('recmgr list: none on this unit (%s), nothing to do' % RECMGR)
            return 0
        changed = recmgr_edit(a.recmgr == 'add', ID)
        print('recmgr list: %s %s' % ('changed,' if changed else 'already', 'with ' + ID if a.recmgr == 'add' else 'without ' + ID))
        return 0
    cfg = load_config(a.config)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    try:
        if a.status:
            return status(cfg)
        if a.restore:
            m = read_marker()
            if not m:
                log.info('nothing to restore')
                return 0
            return 0 if restore(m['settings']) else 1
        if a.test_pulse:
            if read_marker():
                log.info('a pulse was left half done: putting the light back first')
                if not restore(read_marker()['settings']):
                    return 1
            return 0 if pulse(cfg, 'test') else 1
        daemon(cfg)
        return 0
    except Stop:
        log.info('stopped during a pulse; the light was put back')
        return 0
    except ComfortError as e:
        log.error('%s', e)
        return 1


if __name__ == '__main__':
    sys.exit(main())
