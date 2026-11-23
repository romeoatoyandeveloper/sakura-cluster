# PSX

<img src="icon.png" width="72" align="left" alt="PSX icon">

PlayStation games on the centre screen, with a PS4 or PS5 controller. While a game runs it covers the whole screen:
at 4:3 (the game's own shape, as high as the screen), wide (16:9) or stretched to fill it, set in the pause menu
(**Picture**) or in Settings (**Game picture**). The PS button or a tap on the screen opens the pause menu (resume,
picture, restart, quit).

**Parked only** (Settings, on at first): the game pauses when the car moves, and the menu says why. Turn it off when
passengers play on the move.

It needs **psx-core**, the emulator, from the Store as well (a background tool: [native/psx-core](../../native/psx-core/README.md)).

## Getting it going

1. In the Store install **PSX** and **psx-core**, then restart the head unit once.
2. Open **PSX** from the apps menu. **Controller & sound** shows what it finds:
   - **Controller:** plug a PS4 or PS5 controller in with its USB cable, or pair it over Bluetooth: hold **PS + Share**
     (PS4) or **PS + Create** (PS5) until the light flashes, then tap **Pair a controller**.
   - **Sound:** tap **Test sound** until you hear the tone: each tap tries the next output, and the one you last
     heard is the one games use.
3. **Games:** your own copies, on a USB stick (FAT32 or exFAT) in any folder up to three deep (`.cue` with its `.bin`,
   `.chd`, `.pbp`, `.iso`). Plug it in and the list fills by itself. **PS1 test picture** is always there, to try the
   screen and the controller.
4. **The PlayStation startup screen:** put your console's BIOS (`SCPH1001.BIN` or similar) on the stick too. PSX picks
   it up by itself; games then start with the Sony intro, and **PlayStation menu** (memory cards, CD player) is listed.

**Car** shows what psx-core sees on the head unit: USB sticks, USB devices (is the controller there, with which
driver), input and sound devices. A photo of it says why a stick, a controller or the sound isn't found.

On the car so far: psx-core runs; the head unit has no Bluetooth that Linux apps can use, so the controller goes on a
USB cable; the sound and the USB controller are still to be seen working.

## Licence

The app is MIT like the rest of this repository. psx-core (the emulator) is GPL-2.0-or-later.
