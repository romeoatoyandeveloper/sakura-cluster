# PSX

<img src="icon.png" width="72" align="left" alt="PSX icon">

PlayStation games on the centre screen, with a PS4 or PS5 controller, **parked only**. The game sits in the middle
of the screen at 4:3; the PS button opens the pause menu (resume, restart, quit). If the car starts moving the game
pauses and the menu says why.

It needs **psx-core**, the emulator, from the Store as well (a background tool: [native/psx-core](../../native/psx-core/README.md)).

## Getting it going

1. In the Store install **PSX** and **psx-core**, then restart the head unit once.
2. Open **PSX** from the apps menu. **Controller & sound** shows what it finds:
   - **Controller:** plug a PS4 or PS5 controller in with its USB cable, or pair it over Bluetooth: hold **PS + Share**
     (PS4) or **PS + Create** (PS5) until the light flashes, then tap **Pair a controller**.
   - **Sound:** tap **Test sound**.
3. **Games:** your own copies, on a USB stick in any folder (`.cue` with its `.bin`, `.chd`, `.pbp`, `.iso`), or in
   `/var/opt/psx/games`. **PS1 test picture** is always there, to try the screen and the controller.
4. **The PlayStation startup screen:** put your console's BIOS (`SCPH1001.BIN` or similar) on the stick too. PSX picks
   it up by itself; games then start with the Sony intro, and **PlayStation menu** (memory cards, CD player) is listed.

Not yet tested on a car: whether the car's Bluetooth pairs a game controller, and whether the head unit lets an app's
sound out, are the two open questions; the check page answers both.

## Licence

The app is MIT like the rest of this repository. psx-core (the emulator) is GPL-2.0-or-later.
