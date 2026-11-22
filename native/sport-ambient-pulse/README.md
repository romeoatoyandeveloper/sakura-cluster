# sport-ambient-pulse

A small background service for a BMW iDrive 7 (MGU) head unit, written for a 2019 745e (G11 LCI). When the Driving
Experience Control goes into **Sport, Sport Plus or Sport Individual** from any other mode, the cabin's ambient
light turns **red and pulses three times**, then goes back to **exactly the colour and brightness it had**. No
screen, no app tile: one Python file (standard library only) on mgu-python, one systemd unit.

## Step 1: how it reads the mode and drives the light

Both go through **IterioDev's Comfort tool** (`iteriodev-comfort`, the root service the MGU Store installs with his
*Ambient Light* app), used exactly as installed, over its control socket `/run/iteriodev-comfort/ctl.sock`. Comfort
sends its state as the first JSON line of every connection and again after every change, and takes
`{"op":"ambient","settings":{...}}` requests. Nothing of Comfort is copied or changed: its licence (PolyForm Strict)
allows using it as installed, not building on its code.

| | What happens on the car | How this tool gets it |
|---|---|---|
| **Drive mode** | Comfort subscribes to FES, SOME/IP service `0xB50D` (`de.bmw.infotainment.drivingexcitement.FES`), event `0x8025`, and reads its getter once a second | **From 1.1.0, first:** the drive mode **Cluster Themes** (0.22.6 or later, or HUD Widgets 0.16.6) reads, which it writes to `/dev/shm/sakura-cluster/drive_mode.json` every 2 s. Those apps read a plug-in hybrid's drive mode (`PHEV_SPORT_STANDARD` and the like); on a 745e Comfort's alone gave no pulse. **Else** `state.ambient.mode` in Comfort's state: `1` Sport, `2` Sport Plus, `3` Sport Individual, `4`-`6` Comfort (Plus, Individual), `7`-`9` Eco Pro (Plus, Individual), `10` Adaptive, or a name (`PHEV_` read too). Read about twice a second |
| **Ambient light** | Comfort writes each light module through the body controller: UDS `2E DA5E` (LIN 1) / `2E E3D1` (LIN 2) to the BDC (`0x40`) via the head unit's diagnostic gateway: module, on, brightness 0-100, R, G, B, **hold time ≤ 254 s**. The module shows that colour for the hold time, then the car's own colour again; "off" gives the car's colour at once | `{"op":"ambient","settings":{"on","rgb","bright","follow","zones","modes"}}` on the socket; the light's settings now are `state.ambient.settings` |

**Runtime only:** those writes are not coding. Each one runs out by itself within 254 s, Comfort hands the lights back
to the car when it stops, and this tool never talks to the BDC. A reboot, a crash or uninstalling anything gives the
car its own light back.

Why not something else:

- **Its own SOME/IP or UDS connection:** the head unit has no Python binding for vsomeip. Comfort's notes record a
  second diagnostic session beside its own restarting a head unit. And a second writer to the light modules would
  fight Comfort every 2 minutes.
- **The read-only probe `sembsa/idrive7-ambient`:** it maps where the ambient state lives (`0xB512`
  ComfortFunctionIuK, `0xB09E` interiorillumination.AmbientLight), but sets nothing.
- **The MGU App Kit's *Ambient config* app (`cauliflowermossgrape/idrive7-apps`):** it writes the same registers, but
  it is an RHMI app inside BMW's app runtime, not a systemd service. It is what this tool watches out for (below).

## A pulse

1. The light's settings are read from Comfort and kept, in memory and in `/var/opt/sport-ambient-pulse/pending.json`
   (written and synced before anything changes).
2. Six phases, `phase_ms` apart: red at 100 %, 5 %, 100 %, 5 %, 100 %, 5 %. Zones with their own colour go red too;
   zones switched off stay off. Comfort's own drive-mode colours are held off, and the brightness doesn't follow the
   car's, for those seconds.
3. In a `finally`: the kept settings are sent back, read back from Comfort and compared. Only then does
   `pending.json` go.

**Pulse length:** Comfort puts at most one round of writes on the bus every **500 ms** (a round writes every light
module over LIN), and a change that comes sooner is merged into the next round. A 300-400 ms pulse (two changes in
it) would lose its dim phase, so a phase is at least 500 ms. The default is 600 ms: three pulses take about 3.6 s,
crisp on/dim.

**Edge and debounce:** a pulse only follows a change from a known non-Sport mode into Sport. Repeated Sport states,
Sport to Sport Plus and a start already in Sport do nothing. During a pulse nothing is read; afterwards the mode then
is the new starting point, and nothing new starts for `cooldown_s` (3 s). One pulse at a time (a lock in
`/run`), `--test-pulse` included.

**Restore guaranteed:** the `finally` covers errors and SIGTERM (systemd stop, `Ctrl-C`). A pulse cut short by a crash
or power loss is put right at the next start from `pending.json`. If Comfort was killed meanwhile, the hold time
still returns the modules to the car's colour within 254 s.

**Checking it from the car:** Cluster Themes (0.22.6 or later) has a **Sport ambient pulse** row on its Settings tab
(Help and reset): running or not, which drive mode it sees and from where, and what it did last (pulsed, or skipped and
why). It reads `/dev/shm/sport-ambient-pulse/status.json`, which this writes every 2 s and at each change.

**When it doesn't pulse:** with the car's own ambient light off (Comfort lights nothing then), and when Comfort has
found no light modules on the car. Both are logged.

## Other ambient tools

- **Comfort and its Ambient Light app** are what this tool uses: they don't fight, because Comfort is the only writer.
  If *Colour by drive mode* is on in the app, the Sport colour takes over right after the pulse.
- **The MGU App Kit's *Ambient config* app** writes the same light modules itself. It stands aside only while
  Comfort's own colour or drive-mode colours are on (it checks every 10 s). If it is running while Comfort's light is
  off, the two would cut into each other, so the pulse is skipped and logged (`"when_ambient_config": "pulse"` pulses
  anyway). Use one ambient app at a time.
- `--status` shows all of this.
- **Seats:** this tool holds no connection to Comfort between pulses. Comfort stops a seat move an app started when its
  last client leaves, and a connection held open all the time would stop that from working. It connects about twice
  a second for a moment instead (Comfort sends its state and nothing reaches the bus).

## Requirements

- iDrive 7 (MGU) with root SSH and the [MGU Store](https://github.com/robertnisipeanu/mgu-store). The Store installs
  **mgu-python** (Python 3.12, `/var/opt/mgu-python/current/bin/python3`) with its updater.
- **IterioDev's Ambient Light app** from the Store (it brings the Comfort tool), with Comfort running
  (`systemctl is-active iteriodev-comfort`).
- The car's own ambient light switched on in the car's settings.

**Not yet run on a car.** It is tested here against a stand-in for Comfort's socket (`tests/test_pulse.py`). Comfort's
light route is known to work on BDC_G05 cars (an M4). Its drive modes and iDrive 7 support are marked untested by its
author. Whether a G11's body controller takes these writes is unknown until `--status` lists light modules and
`--test-pulse` pulses on your car.

## On the car

**Through the Store** (this repository is the Store source that also has Cluster Themes):

1. Install IterioDev's **Ambient Light** app from the Store if it isn't there (it brings the Comfort tool; its source
   is `IterioDev/car-apps`, under Sources).
2. In the Store, check for updates: **Sport ambient pulse** is listed. Install it.
3. The Store says it starts at the next start of the head unit: restart when it asks, or it starts the next time the
   car wakes. A new service only starts once the head unit's recovery manager (recmgr) has read it at boot.
4. Switch the car on, ambient light on in the car's settings, and press **SPORT**.

Remove it in the Store like any other component; a pulse running puts the light back first. Updates come the same
way: a higher `version` in `component.json` (and `VERSION` in the script) is offered as an update.

**Over SSH** (testing without driving, logs):

```sh
HU=root@192.168.1.50          # your head unit
PY=/var/opt/mgu-python/current/bin/python3; SAP=/var/opt/sport-ambient-pulse/current/sport_ambient_pulse.py
ssh $HU "$PY $SAP --status"                                    # Comfort, mode, light modules, conflicts
ssh $HU "$PY $SAP --test-pulse"                                # one pulse now: car on, ambient light on
ssh $HU 'journalctl -u sport-ambient-pulse -f'                 # live (the head unit keeps its journal only minutes)
ssh $HU 'tail -n 50 /var/opt/sport-ambient-pulse/pulse.log'    # the events, kept (256 KB, one old file)
ssh $HU "$PY $SAP --restore"                                   # a pulse left half done (done by itself at a start too)
ssh $HU 'vi /var/opt/sport-ambient-pulse/config.json && systemctl restart sport-ambient-pulse'   # settings
```

Without the Store, `install.sh` and `uninstall.sh` (run on the head unit as root, from this folder) do what the
Store does: the program in `/var/opt/sport-ambient-pulse/versions/1.0.0` with `current` pointing at it, the unit in
`/etc/systemd/system` (the read-only `/` made writable for it, then read-only again) and the name in
`/etc/recmgr-restartlist.conf`; then restart the head unit as the Store does:
`/usr/bin/nsm_control --requestRestart 7 --normal`. After an iDrive firmware update (it resets `/`, keeps
`/var/opt`) run `install.sh` again; the Store puts its tools back by itself.

## Settings: `/var/opt/sport-ambient-pulse/config.json`

| Key | Default | |
|---|---|---|
| `rgb` | `[254, 0, 0]` | the pulse colour, 0-254 each (a module reads 255 as "no change") |
| `pulses` | `3` | 1-10 |
| `phase_ms` | `600` | each bright and each dim phase; 500 at least |
| `bright_high`, `bright_low` | `100`, `5` | 5-100 (Comfort's range) |
| `poll_ms` | `500` | how often Comfort's state is read |
| `cooldown_s` | `3.0` | no new pulse for this long after one |
| `sport_modes` | `[1, 2, 3]` | the modes that count as Sport |
| `when_ambient_config` | `"skip"` | `"skip"` or `"pulse"` while the Ambient config app runs and Comfort's light is off |

## Files

| | |
|---|---|
| `sport_ambient_pulse.py` | the service and its commands (`--daemon`, `--test-pulse`, `--status`, `--restore`, `--self-test`) |
| `sport-ambient-pulse.service` | the systemd unit: after Comfort, `Restart=on-failure`, output to the journal, `Nice=10` |
| `install.sh`, `uninstall.sh` | the same without the Store, run on the head unit as root |
| `config.example.json` | the defaults |
| `component.json` | the tool as the MGU Store installs it (files, unit, enable); `mgu-repo.json` at the repository root lists it |
| `tests/test_pulse.py` | `python3 tests/test_pulse.py`: a stand-in Comfort, the service as a real process |

## Credits

The ways in come from public work on these head units: IterioDev's Comfort tool and Ambient Light app
([IterioDev/car-apps](https://github.com/IterioDev/car-apps): used as installed, nothing taken from it),
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (the light modules' UDS
records, the Ambient config app), [sembsa/idrive7-ambient](https://github.com/sembsa/idrive7-ambient) (the ambient
SOME/IP services) and [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) (mgu-python, the tool
format, recmgr, the head unit's restart).
