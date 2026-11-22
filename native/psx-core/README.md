# psx-core

The PlayStation emulator behind the [PSX app](../../apps/psx/README.md): [PCSX-ReARMed](https://github.com/libretro/pcsx_rearmed)
(the libretro core) in a small host program, run as a background service on the head unit. It runs as root because
only root can read a game controller and reach the sound devices; the PSX app (the centre screen) talks to it and
draws its frames.

**Install it from the Store together with the PSX app, then restart the head unit once** (a new service starts with
the head unit).

## What it does

- **Games** from `/var/opt/psx/games` and from USB sticks (any removable FAT / exFAT / NTFS file system, up to three
  folders deep): `.cue` (with its `.bin`), `.chd`, `.pbp`, `.iso`, `.img`, `.bin`, `.exe`, `.m3u`. Your own copies:
  it downloads nothing. A built-in test picture (`test.exe`, colour bars) is listed too.
- **BIOS:** your PlayStation's (`SCPH1001.BIN` and the like, 512 KiB) anywhere on the USB stick is copied to
  `/var/opt/psx/bios` when the games are listed; psx-core then starts again with it, games start with the PlayStation's
  startup screen, and **PlayStation menu** (the console's own memory card and CD player screens, booted from a blank
  audio disc it makes) is listed first. Without one the core's own (HLE) BIOS is used: games start straight away.
  Sony's BIOS is not included: it comes from your own console. **Memory cards** in `/var/opt/psx/saves`, saved every few seconds and when a game stops.
- **Controllers:** a PS4 (DualShock 4) or PS5 (DualSense), over USB or Bluetooth, players 1 and 2 in the order they
  connect. Through the kernel's gamepad driver when the head unit has one, else straight from the controller's own
  reports (`/dev/hidraw`), so no driver is needed. The left stick works as the d-pad too; the PS button opens the
  app's pause menu.
- **Bluetooth pairing** (the app's Pair button): looks for a controller in pairing mode for 20 s with `bluetoothctl`
  and pairs, trusts and connects it, when the head unit has BlueZ. Whether the car's Bluetooth takes a game
  controller at all is not known yet: the app's check page says what it finds. A USB cable works without pairing.
- **Sound:** piped to `pacat` or `aplay` when the head unit has one; otherwise the game plays silently and the check
  page says so. Not known yet either.

## How the app talks to it

`/dev/shm/psx-core/ctl.sock` takes one command a line (`status`, `list`, `load <path>`, `unload`, `pause`, `resume`,
`reset`, `pair`, `tone`) and answers in JSON lines; frames go to `/dev/shm/psx-core/frame` (a 64-byte header and two
1024 x 512 RGBA slots). `src/psx_core.c` documents both.

## Building

`bin/psx-core` is one static x86-64 binary (the head unit is Intel x86-64 Linux), built by `build.sh` from
PCSX-ReARMed at the commit it pins plus `src/psx_core.c`. Tests: `python3 test/test_pads.py bin/psx-core` (the PS4
and PS5 reports over USB and Bluetooth, and evdev gamepads, fed through FIFOs); `test/make_test_exe.py` makes the
test picture.

## Licence

PCSX-ReARMed is GPL-2.0-or-later, so `bin/psx-core` and `src/psx_core.c` are under the GPL-2.0-or-later too
([COPYING](COPYING)). The source: `src/` here and PCSX-ReARMed at the commit in `build.sh`.
