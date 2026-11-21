#!/bin/sh
# uninstall.sh - on the head unit, as root:  sh /var/opt/sport-ambient-pulse/uninstall.sh  (or from this folder)
# Stops the service (a pulse running puts the light back first), puts back a pulse left half done, takes the unit and
# the recmgr entry out and removes /var/opt/sport-ambient-pulse. Comfort and its own settings are left as they are.
set -u
ID=sport-ambient-pulse
DEST=/var/opt/$ID
PY=/var/opt/mgu-python/current/bin/python3
SCRIPT=$DEST/current/sport_ambient_pulse.py

[ "$(id -u)" -eq 0 ] || { echo "run it as root"; exit 1; }
if systemctl is-active --quiet "$ID.service"; then systemctl stop "$ID.service"; fi
[ -x "$PY" ] && [ -f "$SCRIPT" ] && "$PY" "$SCRIPT" --restore

RO=0
if ( : > /etc/.sap-rw-check ) 2>/dev/null; then rm -f /etc/.sap-rw-check; else mount -o remount,rw /; RO=1; fi
systemctl disable "$ID.service" 2>/dev/null
rm -f "/etc/systemd/system/$ID.service"
[ -x "$PY" ] && [ -f "$SCRIPT" ] && "$PY" "$SCRIPT" --recmgr remove
systemctl daemon-reload
sync
if [ "$RO" = 1 ]; then mount -o remount,ro / || echo "note: / stays writable until the next boot"; fi
rm -rf "$DEST" /run/$ID.lock
echo "Removed $ID. Nothing of it is left in the car."
