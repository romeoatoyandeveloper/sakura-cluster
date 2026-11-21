#!/bin/sh
# install.sh - on the head unit, as root, from this folder:  sh install.sh
# Puts the daemon in /var/opt/sport-ambient-pulse (kept over firmware updates), its unit in /etc/systemd/system and its
# name in recmgr's restart list (the root file system is read-only: made writable for that, then read-only again).
# The service starts at the next boot of the head unit: recmgr reads its list only then.
set -eu
ID=sport-ambient-pulse
VER=1.0.0
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=/var/opt/$ID
PY=/var/opt/mgu-python/current/bin/python3

[ "$(id -u)" -eq 0 ] || { echo "run it as root"; exit 1; }
[ -x "$PY" ] || { echo "no mgu-python at $PY (the MGU Store installs it with its updater)"; exit 1; }
[ -S /run/iteriodev-comfort/ctl.sock ] || echo "note: IterioDev's Comfort tool is not running now; the service waits for it (install his Ambient Light app from the MGU Store)"

mkdir -p "$DEST/versions/$VER"
cp "$HERE/sport_ambient_pulse.py" "$DEST/versions/$VER/"
chmod 0755 "$DEST/versions/$VER/sport_ambient_pulse.py"
cp "$HERE/uninstall.sh" "$DEST/uninstall.sh"
ln -sfn "versions/$VER" "$DEST/current"
[ -f "$DEST/config.json" ] || cp "$HERE/config.example.json" "$DEST/config.json"
"$PY" "$DEST/current/sport_ambient_pulse.py" --self-test

RO=0
if ( : > /etc/.sap-rw-check ) 2>/dev/null; then rm -f /etc/.sap-rw-check; else mount -o remount,rw /; RO=1; fi
trap 'if [ "$RO" = 1 ]; then sync; mount -o remount,ro / || echo "note: / stays writable until the next boot"; fi' EXIT
cp "$HERE/$ID.service" "/etc/systemd/system/$ID.service"
chmod 0644 "/etc/systemd/system/$ID.service"
"$PY" "$DEST/current/sport_ambient_pulse.py" --recmgr add
systemctl daemon-reload
systemctl enable "$ID.service"
sync
echo
echo "Installed $ID $VER: it starts at the next boot of the head unit."
echo "The pulse now, without driving:  $PY $DEST/current/sport_ambient_pulse.py --test-pulse"
