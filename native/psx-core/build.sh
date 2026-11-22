#!/bin/sh
# Builds bin/psx-core: PCSX-ReARMed (the libretro core, pinned below) with src/psx_core.c, one static x86-64 binary
# for the iDrive 7 head unit (an Intel x86-64 Linux; static, so nothing from its libraries is needed).
#
#   sh native/psx-core/build.sh            (needs git, make, gcc on x86-64 Linux)
#
# PCSX-ReARMed is GPL-2.0-or-later; so is the binary this makes (see README.md). Its source: the commit below.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=https://github.com/libretro/pcsx_rearmed.git
REV=0f544ce1d18ac7dd114cb8f5507f01a29d3cd58c
W=${PSX_BUILD:-/tmp/psx-core-build}
mkdir -p "$W"
if [ ! -d "$W/pcsx_rearmed/.git" ]; then git clone "$REPO" "$W/pcsx_rearmed"; fi
git -C "$W/pcsx_rearmed" fetch -q origin "$REV" 2>/dev/null || true
git -C "$W/pcsx_rearmed" checkout -q "$REV"
make -C "$W/pcsx_rearmed" -f Makefile.libretro -j"$(nproc)"
# the core's objects, as its own link line lists them (frontend/libretro.o is the libretro API)
OBJS=$(make -C "$W/pcsx_rearmed" -f Makefile.libretro -n -B pcsx_rearmed_libretro.so 2>/dev/null | grep -- '-shared' | tail -n 1 | tr ' ' '\n' | grep '\.o$' | sed "s#^#$W/pcsx_rearmed/#")
mkdir -p "$HERE/bin"
gcc -O2 -Wall -static -o "$HERE/bin/psx-core" "$HERE/src/psx_core.c" -I"$W/pcsx_rearmed/deps/libretro-common/include" \
    $OBJS -Wl,--gc-sections -lpthread -lm -lrt -ldl
strip "$HERE/bin/psx-core"
"$HERE/bin/psx-core" --version
ls -l "$HERE/bin/psx-core"
