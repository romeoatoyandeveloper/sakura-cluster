"""Tests against a stand-in for Comfort's control socket (JSON lines: its state on connecting and after every change,
{"op": "ambient", "settings": ...} merged into its settings). The daemon runs as a real process.

    python3 tests/test_pulse.py
"""
import copy
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'sport_ambient_pulse.py')
sys.path.insert(0, os.path.join(HERE, '..'))
import sport_ambient_pulse as sap  # noqa: E402

START = {'on': False, 'rgb': [40, 120, 254], 'bright': 70, 'follow': True,
         'zones': {'dash': {'rgb': [0, 200, 0]}, 'doors': {'off': True}},
         'modes': {'on': True, 'rgb': {'1': [254, 30, 0], '4': [40, 120, 254]}}}
MODULES = [{'id': 'lin1:1', 'name': 'Dash line', 'zone': 'dash', 'fault': False},
           {'id': 'lin1:2', 'name': 'Footwell driver front', 'zone': 'footwell', 'fault': False}]


def read(path):
    with open(path) as f:
        return f.read()


class FakeComfort:
    def __init__(self, path, mode=4, car_on=True, modules=MODULES):
        self.path, self.mode, self.car_on, self.modules = path, mode, car_on, modules
        self.settings = copy.deepcopy(START)
        self.applied = []                      # (time, settings) after each ambient op
        self.clients, self.lock, self.connects = set(), threading.Lock(), 0
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        self.srv.listen(8)
        threading.Thread(target=self._accept, daemon=True).start()

    def state(self):
        return {'state': {'ambient': {'settings': copy.deepcopy(self.settings), 'carOn': self.car_on, 'lit': True,
                                      'mode': self.mode, 'modules': self.modules}}}

    def push(self):
        line = (json.dumps(self.state()) + '\n').encode()
        for c in list(self.clients):
            try:
                c.sendall(line)
            except OSError:
                self.clients.discard(c)

    def set_mode(self, m):
        with self.lock:
            self.mode = m
            self.push()

    def _accept(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            with self.lock:
                self.connects += 1
                self.clients.add(c)
                c.sendall((json.dumps(self.state()) + '\n').encode())
            threading.Thread(target=self._serve, args=(c,), daemon=True).start()

    def _serve(self, c):
        buf = b''
        while True:
            try:
                d = c.recv(65536)
            except OSError:
                d = b''
            if not d:
                with self.lock:
                    self.clients.discard(c)
                c.close()
                return
            buf += d
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                q = json.loads(line)
                if q.get('op') == 'ambient':
                    with self.lock:
                        self._merge(q['settings'])
                        self.applied.append((time.monotonic(), copy.deepcopy(self.settings)))
                        self.push()

    def _merge(self, p):
        s = self.settings
        for k in ('on', 'follow'):
            if isinstance(p.get(k), bool):
                s[k] = p[k]
        if isinstance(p.get('rgb'), list):
            s['rgb'] = list(p['rgb'])
        if isinstance(p.get('bright'), int) and 5 <= p['bright'] <= 100:
            s['bright'] = p['bright']
        for z, v in (p.get('zones') or {}).items():
            if v is None:
                s['zones'].pop(z, None)
            else:
                s['zones'][z] = {'off': True} if v.get('off') else {'rgb': list(v['rgb'])}
        m = p.get('modes') or {}
        if isinstance(m.get('on'), bool):
            s['modes']['on'] = m['on']
        s['modes']['rgb'].update(m.get('rgb') or {})

    def close(self):
        self.srv.close()
        for c in list(self.clients):
            c.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sock = os.path.join(self.tmp, 'ctl.sock')
        self.env = dict(os.environ, SAP_HOME=os.path.join(self.tmp, 'home'), SAP_COMFORT_SOCK=self.sock,
                        SAP_LOCK=os.path.join(self.tmp, 'pulse.lock'), SAP_RECMGR=os.path.join(self.tmp, 'recmgr.conf'),
                        SAP_DRIVE=os.path.join(self.tmp, 'drive_mode.json'), SAP_STATUS=os.path.join(self.tmp, 'st', 'status.json'))
        self.cfg = os.path.join(self.tmp, 'config.json')
        with open(self.cfg, 'w') as f:
            json.dump({'phase_ms': 500, 'poll_ms': 100, 'cooldown_s': 1.0}, f)
        self.procs = []
        self.fakes = []

    def tearDown(self):
        for f in self.fakes:
            f.close()
        for p in self.procs:
            if p.poll() is None:
                p.kill()
                p.wait()
            if p.stdout:
                p.stdout.close()

    def fake(self, **kw):
        f = FakeComfort(self.sock, **kw)
        self.fakes.append(f)
        return f

    def daemon(self):
        p = subprocess.Popen([sys.executable, SCRIPT, '--daemon', '--config', self.cfg], env=self.env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.procs.append(p)
        return p

    def marker(self):
        return os.path.exists(os.path.join(self.tmp, 'home', 'pending.json'))

    def pulses(self, fake):
        """How many pulses the applied settings hold: a red frame at full brightness after something that wasn't."""
        n, last = 0, None
        for _, s in fake.applied:
            red_hi = s['rgb'] == [254, 0, 0] and s['bright'] == 100 and s['on']
            if red_hi and last is not True:
                n += 1
            last = red_hi
        return n


class Pulse(Base):
    def share(self, mode, variant=None, raw=None):
        """Cluster Themes writing the drive mode it reads (shared/hud.js _shareDrive)."""
        p = os.path.join(self.tmp, 'drive_mode.json')
        with open(p + '.tmp', 'w') as f:
            json.dump({'mode': mode, 'variant': variant, 'raw': raw, 'app': 'cluster_themes'}, f)
        os.replace(p + '.tmp', p)

    def status_file(self):
        with open(os.path.join(self.tmp, 'st', 'status.json')) as f:
            return json.load(f)

    def test_plug_in_hybrid_names_from_comfort_pulse(self):
        # a 745e: Comfort may hand over the car's name rather than a number
        fake = self.fake(mode='PHEV_COMFORT')
        self.daemon()
        time.sleep(1.0)
        fake.set_mode('PHEV_SPORT_STANDARD')
        time.sleep(4.5)
        self.assertEqual(self.pulses(fake), 3)
        self.assertEqual(fake.settings, START)

    def test_drive_mode_from_cluster_themes_comes_first(self):
        # Comfort knows no drive mode (it can't read this car's), Cluster Themes does
        fake = self.fake(mode=None)
        stop = threading.Event()
        cur = {'m': 'comfort', 'raw': 'PHEV_COMFORT'}

        def writer():                  # every 0.5 s, as the app's 2 s heartbeat, faster for the test
            while not stop.is_set():
                self.share(cur['m'], None, cur['raw'])
                time.sleep(0.5)
        t = threading.Thread(target=writer, daemon=True)
        t.start()
        try:
            self.daemon()
            time.sleep(1.5)
            st = self.status_file()
            self.assertEqual((st['source'], st['mode'], st['comfort']), ('Cluster Themes', 'Comfort', 'reachable'))
            cur.update(m='sport', raw='PHEV_SPORT_STANDARD')
            time.sleep(4.5)
            self.assertEqual(self.pulses(fake), 3)
            self.assertEqual(fake.settings, START)
            st = self.status_file()
            self.assertTrue(st['last'].startswith('pulsed (Comfort -> Sport)'), st['last'])
            self.assertEqual(st['mode'], 'Sport')
        finally:
            stop.set()
            t.join()

    def test_a_stale_shared_mode_is_not_used(self):
        fake = self.fake(mode=4)
        self.share('sport', None, 'SPORT')
        old = time.time() - 60
        os.utime(os.path.join(self.tmp, 'drive_mode.json'), (old, old))
        self.daemon()
        time.sleep(1.0)
        self.assertEqual(self.status_file()['source'], 'Comfort')
        self.assertEqual(fake.applied, [])

    def test_a_skip_is_reported(self):
        fake = self.fake(mode=4, car_on=False)
        self.daemon()
        time.sleep(1.0)
        fake.set_mode(1)
        time.sleep(1.5)
        self.assertIn("car's own ambient light is off", self.status_file()['last'])
        self.assertEqual(fake.applied, [])

    def test_into_sport_pulses_three_times_and_restores_exactly(self):
        fake = self.fake(mode=4)
        self.daemon()
        time.sleep(1.0)
        fake.set_mode(1)
        time.sleep(5.0)
        frames = [s for _, s in fake.applied]
        self.assertEqual(len(frames), 7, 'six phases and the restore')
        self.assertEqual([f['bright'] for f in frames[:6]], [100, 5, 100, 5, 100, 5])
        for f in frames[:6]:
            self.assertEqual(f['rgb'], [254, 0, 0])
            self.assertEqual(f['zones'], {'dash': {'rgb': [254, 0, 0]}, 'doors': {'off': True}})
            self.assertFalse(f['modes']['on'])
            self.assertFalse(f['follow'])
        gaps = [b[0] - a[0] for a, b in zip(fake.applied, fake.applied[1:6])]
        self.assertTrue(all(g >= 0.45 for g in gaps), gaps)
        self.assertEqual(fake.settings, START)
        self.assertFalse(self.marker())
        self.assertEqual(self.pulses(fake), 3)

    def test_already_in_sport_and_sport_to_sport_plus_do_nothing(self):
        fake = self.fake(mode=1)
        self.daemon()
        time.sleep(1.0)
        fake.set_mode(2)
        time.sleep(1.0)
        fake.set_mode(3)
        time.sleep(1.0)
        self.assertEqual(fake.applied, [])
        fake.set_mode(4)
        time.sleep(0.5)
        fake.set_mode(3)
        time.sleep(4.5)
        self.assertEqual(self.pulses(fake), 3)
        self.assertEqual(fake.settings, START)

    def test_rapid_presses_during_a_pulse_give_one_pulse(self):
        fake = self.fake(mode=4)
        self.daemon()
        time.sleep(1.0)
        fake.set_mode(1)
        for m in (4, 1, 4, 1):
            time.sleep(0.4)
            fake.set_mode(m)
        time.sleep(5.0)
        self.assertEqual(self.pulses(fake), 3, 'one pulse of three')
        self.assertEqual(len(fake.applied), 7)
        self.assertEqual(fake.settings, START)
        fake.set_mode(4)                     # later, out and back in: another pulse
        time.sleep(0.5)
        fake.set_mode(1)
        time.sleep(4.5)
        self.assertEqual(len(fake.applied), 14)
        self.assertEqual(fake.settings, START)

    def test_sigterm_mid_pulse_puts_the_light_back(self):
        fake = self.fake(mode=4)
        p = self.daemon()
        time.sleep(1.0)
        fake.set_mode(1)
        time.sleep(1.3)
        self.assertEqual(fake.settings['rgb'], [254, 0, 0])
        p.send_signal(signal.SIGTERM)
        out, _ = p.communicate(timeout=10)
        self.assertEqual(p.returncode, 0, out)
        self.assertEqual(fake.settings, START)
        self.assertFalse(self.marker())
        self.assertIn('light restored', out)

    def test_crash_mid_pulse_is_put_right_at_the_next_start(self):
        fake = self.fake(mode=4)
        p = self.daemon()
        time.sleep(1.0)
        fake.set_mode(1)
        time.sleep(1.3)
        p.kill()
        p.wait()
        self.assertEqual(fake.settings['rgb'], [254, 0, 0], 'left red')
        self.assertTrue(self.marker())
        self.daemon()
        time.sleep(1.5)
        self.assertEqual(fake.settings, START)
        self.assertFalse(self.marker())

    def test_no_pulse_while_the_cars_ambient_light_is_off_or_no_modules(self):
        fake = self.fake(mode=4, car_on=False)
        p = self.daemon()
        time.sleep(1.0)
        fake.set_mode(1)
        time.sleep(1.0)
        self.assertEqual(fake.applied, [])
        fake.car_on, fake.modules = True, []
        fake.set_mode(4)
        time.sleep(1.2)
        fake.set_mode(1)
        time.sleep(1.0)
        self.assertEqual(fake.applied, [])
        p.send_signal(signal.SIGTERM)
        out, _ = p.communicate(timeout=10)
        self.assertIn("car's own ambient light is off", out)
        self.assertIn('no ambient light modules', out)

    def test_waits_for_comfort(self):
        p = self.daemon()
        time.sleep(1.0)
        fake = self.fake(mode=4)
        time.sleep(2.5)
        fake.set_mode(1)
        time.sleep(4.5)
        self.assertEqual(self.pulses(fake), 3)
        p.send_signal(signal.SIGTERM)
        out, _ = p.communicate(timeout=10)
        self.assertIn('waiting for it', out)
        self.assertIn('Comfort reachable', out)

    def test_no_connection_held_between_pulses(self):
        fake = self.fake(mode=4)
        self.daemon()
        time.sleep(1.5)
        self.assertLessEqual(len(fake.clients), 1)
        held = sum(1 for _ in range(10) if (time.sleep(0.05) or len(fake.clients)))
        self.assertLess(held, 10, 'connections are short')
        self.assertGreater(fake.connects, 5)

    def test_test_pulse_cli(self):
        fake = self.fake(mode=7)
        r = subprocess.run([sys.executable, SCRIPT, '--test-pulse', '--config', self.cfg], env=self.env,
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.pulses(fake), 3)
        self.assertEqual(fake.settings, START)


class Recmgr(Base):
    def test_add_and_remove_keep_everything_else(self):
        text = '[Whitelist]\nstockd # stock\n\n[WhitelistExitSuccess]\nstockd\n\n[ForceRestartList]\ndbus\n\n[Other]\nkeepme\n'
        with open(self.env['SAP_RECMGR'], 'w') as f:
            f.write(text)
        run = lambda *a: subprocess.run([sys.executable, SCRIPT] + list(a), env=self.env, capture_output=True, text=True)
        self.assertEqual(run('--recmgr', 'add').returncode, 0)
        new = read(self.env['SAP_RECMGR'])
        self.assertIn('[Whitelist]\nstockd # stock\nsport-ambient-pulse\n', new)
        self.assertIn('[WhitelistExitSuccess]\nstockd\nsport-ambient-pulse\n', new)
        self.assertIn('[ForceRestartList]\ndbus\n', new)
        self.assertNotIn('dbus\nsport-ambient-pulse', new)
        run('--recmgr', 'add')
        self.assertEqual(read(self.env['SAP_RECMGR']), new, 'twice: no change')
        run('--recmgr', 'remove')
        self.assertEqual(read(self.env['SAP_RECMGR']), text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
