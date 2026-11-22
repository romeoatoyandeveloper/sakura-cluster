#!/usr/bin/env python3
"""Write test.exe: a tiny PlayStation program (a PS-X EXE, hand-assembled MIPS) for the bench and the car's check
screen, so psx-core can be seen running with no game: the screen's colour cycles and a white bar slides along.
Draws with the GPU's fill command only (no BIOS calls).

    python3 native/psx-core/test/make_test_exe.py [out.exe]
"""
import struct
import sys

ORG = 0x80010000
R = {'zero': 0, 't0': 8, 't1': 9, 't2': 10, 't3': 11, 't4': 12, 't5': 13, 't6': 14, 't7': 15, 's0': 16, 't8': 24, 't9': 25}


def i_type(op, rs, rt, imm): return (op << 26) | (R[rs] << 21) | (R[rt] << 16) | (imm & 0xFFFF)
def lui(rt, imm): return i_type(0x0F, 'zero', rt, imm)
def ori(rt, rs, imm): return i_type(0x0D, rs, rt, imm)
def andi(rt, rs, imm): return i_type(0x0C, rs, rt, imm)
def addiu(rt, rs, imm): return i_type(0x09, rs, rt, imm)
def sw(rt, off, rs): return i_type(0x2B, rs, rt, off)
def sll(rd, rt, sa): return (R[rt] << 16) | (R[rd] << 11) | (sa << 6)
def or_(rd, rs, rt): return (R[rs] << 21) | (R[rt] << 16) | (R[rd] << 11) | 0x25
NOP = 0


class Asm:
    def __init__(self):
        self.w, self.labels, self.fix = [], {}, []

    def __call__(self, *words): self.w.extend(words)
    def label(self, n): self.labels[n] = len(self.w)
    def li(self, rt, v): self(lui(rt, v >> 16), ori(rt, rt, v & 0xFFFF))
    def gp0(self, v): self.li('t1', v); self(sw('t1', 0x1810, 't0'))
    def gp1(self, v): self.li('t1', v); self(sw('t1', 0x1814, 't0'))

    def bne(self, rs, rt, target): self.fix.append((len(self.w), 'b', target)); self(i_type(0x05, rs, rt, 0), NOP)
    def j(self, target): self.fix.append((len(self.w), 'j', target)); self(0x02 << 26, NOP)

    def code(self):
        for at, kind, t in self.fix:
            tgt = self.labels[t]
            if kind == 'b':
                self.w[at] |= (tgt - (at + 1)) & 0xFFFF
            else:
                self.w[at] |= ((ORG + tgt * 4) >> 2) & 0x3FFFFFF
        return b''.join(struct.pack('<I', x) for x in self.w)


a = Asm()
a(lui('t0', 0x1F80))                 # I/O at 0x1F80_0000: GP0 +0x1810, GP1 +0x1814
a.gp1(0x00000000)                    # reset the GPU
a.gp1(0x08000001)                    # 320 x 240, NTSC, 15-bit
a.gp1(0x06C60260)                    # horizontal display range
a.gp1(0x07042018)                    # vertical display range (240 lines)
a.gp1(0x05000000)                    # display from VRAM 0, 0
a.gp1(0x03000000)                    # display on
a.gp0(0xE1000400)                    # drawing to the displayed area allowed
a(ori('s0', 'zero', 0))              # s0: frame counter
a.label('loop')
a(andi('t2', 's0', 0xFF), sll('t3', 't2', 8), ori('t3', 't3', 0x40))   # green cycles, red 0x40
a(lui('t4', 0x0280), or_('t4', 't4', 't3'), sw('t4', 0x1810, 't0'))   # fill, blue 0x80
a(sw('zero', 0x1810, 't0'))          # at 0, 0
a.li('t5', 0x00F00140)               # 320 x 240
a(sw('t5', 0x1810, 't0'))
a(andi('t6', 's0', 0x0F), sll('t6', 't6', 4))                           # bar x: 0..240, steps of 16
a.li('t7', 0x02FFFFFF)               # fill, white
a(sw('t7', 0x1810, 't0'))
a(lui('t8', 0x0060), or_('t9', 't8', 't6'), sw('t9', 0x1810, 't0'))    # at x, 96
a.li('t5', 0x00300040)               # 64 x 48
a(sw('t5', 0x1810, 't0'))
a(lui('t1', 0x0002))                 # a short wait
a.label('wait')
a(addiu('t1', 't1', -1))
a.bne('t1', 'zero', 'wait')
a(addiu('s0', 's0', 1))
a.j('loop')

code = a.code()
size = (len(code) + 0x7FF) & ~0x7FF
head = bytearray(0x800)
head[0:8] = b'PS-X EXE'
struct.pack_into('<IIII', head, 0x10, ORG, 0, ORG, size)
struct.pack_into('<II', head, 0x30, 0x801FFFF0, 0)
mark = b'Sony Computer Entertainment Inc. for North America area'
head[0x4C:0x4C + len(mark)] = mark
out = sys.argv[1] if len(sys.argv) > 1 else 'test.exe'
open(out, 'wb').write(bytes(head) + code + bytes(size - len(code)))
print('wrote', out, len(code), 'bytes of code')
