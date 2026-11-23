/*
 * psx-core: the PlayStation emulator service behind the PSX app, for a BMW iDrive 7 (MGU) head unit.
 *
 * It runs PCSX-ReARMed (the libretro core, linked in: GPL-2.0, see ../README.md) as root, because only root can read
 * a game controller (/dev/input, /dev/hidraw) and reach the sound devices. The PSX app (apps/psx, the centre screen)
 * talks to it over a Unix socket and draws the frames it leaves in shared memory:
 *
 *   /dev/shm/psx-core/ctl.sock   commands, one per line, from the app:
 *                                  status | list | load <path> | unload | pause | resume | reset | pair | tone | sys
 *                                and JSON lines back: {"ev":"status",...}, {"ev":"games",...}, {"ev":"loaded",...},
 *                                {"ev":"sys",...} (what the head unit shows: USB sticks and devices, sound devices),
 *                                {"ev":"pad","b":<buttons>} (while no game runs or it is paused: menus), {"ev":"menu"}
 *                                (the PS button), {"ev":"pair",...}, {"ev":"tone",...}, {"ev":"error","text":...}
 *   /dev/shm/psx-core/frame      64-byte header (u32 LE: magic "PSXF", seq, slot, w, h, fps x 100, running, paused)
 *                                and two 1024 x 512 RGBA slots; the header's slot is the newest whole frame, seq
 *                                counts frames
 *
 * Controllers: PS4 (DualShock 4) and PS5 (DualSense), over USB or Bluetooth, first through the kernel's gamepad
 * driver (evdev: BTN_SOUTH ..., or a generic HID joystick's buttons in the Sony order), else straight from the
 * controller's own reports (hidraw), and over USB with no HID driver at all, from its USB endpoint (usbfs). The first
 * two found are players 1 and 2; the left stick works as the d-pad too; the PS button opens the app's menu.
 * Sound: through pacat, aplay or gst-launch-1.0 when the unit has one, else straight to an ALSA playback device. "tone"
 * plays a test tone on the next output each time and keeps the one last tested (/var/opt/psx/sound) for games.
 * Bluetooth: "pair" looks for a controller in pairing mode for 20 s with bluetoothctl (BlueZ), when the unit has it.
 * Games: /var/opt/psx/games and USB sticks (what is mounted under /media, /mnt or /run/media, and removable file systems;
 * listed again by itself when a stick comes or goes), .cue .chd .pbp .iso .img .bin
 * .exe; memory cards in /var/opt/psx/saves. BIOS: your PlayStation's (scph1001.bin and the like, 512 KiB) on a USB
 * stick is copied to /var/opt/psx/bios when the games are listed, and the core then starts with the PlayStation's
 * startup screen; without one, the core's own (HLE), which goes straight into the game.
 *
 * Plain C, built static (build.sh), so it needs nothing from the head unit's libraries.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/hidraw.h>
#include <linux/input.h>
#include <linux/usbdevice_fs.h>
#include <limits.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <sound/asound.h>
#include "libretro.h"

#define VERSION "0.2.2"
#define FW 1024
#define FH 512
#define SLOT (FW * FH * 4)
#define HDR 64
#define MAXPADS 8
#define BIT_PS 16

static char RUN[256] = "/dev/shm/psx-core", HOME[256] = "/var/opt/psx";
static volatile sig_atomic_t quit_now;
static int restart_now;            /* a BIOS was added: start again, so the core finds it */
static char **self_argv;

/* ------------------------------------------------------------------ log: the journal, and /var/opt/psx/psx-core.log,
   which the PSX app shows when it can't reach this (the head unit keeps its journal only minutes) */
static int logfd = -1;

static void log_open(void) {
    char p[300], old[310];
    snprintf(p, sizeof p, "%s/psx-core.log", HOME);
    struct stat st;
    if (!stat(p, &st) && st.st_size > 128 * 1024) { snprintf(old, sizeof old, "%s.1", p); rename(p, old); }
    logfd = open(p, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
    if (logfd >= 0) fchmod(logfd, 0644);
}

static void say(const char *fmt, ...) {
    va_list ap;
    time_t t = time(NULL);
    struct tm tm;
    char line[1200];
    localtime_r(&t, &tm);
    size_t n = strftime(line, sizeof line, "%Y-%m-%d %H:%M:%S psx-core: ", &tm);
    va_start(ap, fmt);
    int k = vsnprintf(line + n, sizeof line - n - 2, fmt, ap);
    va_end(ap);
    n = k < 0 ? n : n + k < sizeof line - 2 ? n + k : sizeof line - 2;
    line[n++] = '\n';
    if (write(2, line, n) < 0) { /* no journal */ }
    if (logfd >= 0 && write(logfd, line, n) < 0) { /* full */ }
}

/* a crash: one line in the log (async-signal-safe), then the default action (systemd starts it again) */
static void on_crash(int sig) {
    static const char msg[] = "psx-core: crashed (signal ";
    char num[8];
    int i = 0, v = sig;
    do { num[i++] = '0' + v % 10; v /= 10; } while (v && i < 6);
    if (logfd >= 0) {
        if (write(logfd, msg, sizeof msg - 1) < 0) { /* nothing to do */ }
        while (i--) if (write(logfd, &num[i], 1) < 0) { break; }
        if (write(logfd, ")\n", 2) < 0) { /* nothing to do */ }
    }
    signal(sig, SIG_DFL);
    raise(sig);
}

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

/* JSON string escaping into a static ring of buffers */
static const char *js(const char *s) {
    static char bufs[8][1024];
    static int n;
    char *o = bufs[n++ & 7], *e = o + 1020;
    *o = 0;
    char *p = o;
    for (; s && *s && p < e; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { *p++ = '\\'; *p++ = c; }
        else if (c < 0x20) { p += snprintf(p, e - p, "\\u%04x", c); }
        else *p++ = c;
    }
    *p = 0;
    return o;
}

/* ------------------------------------------------------------------ the app's socket */
static int lfd = -1, cfd = -1;
static char inbuf[4096];
static size_t inlen;

static void send_line(const char *fmt, ...) {
    if (cfd < 0) return;
    static char line[49152];          /* the games list and the sys report fit whole: a cut line isn't JSON */
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof line - 2, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if (n > (int)sizeof line - 2) n = sizeof line - 2;
    line[n++] = '\n';
    if (send(cfd, line, n, MSG_NOSIGNAL | MSG_DONTWAIT) < 0 && errno != EAGAIN) { close(cfd); cfd = -1; }
}

/* ------------------------------------------------------------------ frames in shared memory */
static uint8_t *shm;
static uint32_t *hdr;
static uint32_t seq;

static int shm_open_frames(void) {
    char p[300];
    snprintf(p, sizeof p, "%s/frame", RUN);
    int fd = open(p, O_RDWR | O_CREAT, 0644);
    if (fd < 0) return -1;
    fchmod(fd, 0644);
    if (ftruncate(fd, HDR + 2 * SLOT) < 0) { close(fd); return -1; }
    shm = mmap(NULL, HDR + 2 * SLOT, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (shm == MAP_FAILED) return -1;
    hdr = (uint32_t *)shm;
    memset(hdr, 0, HDR);
    hdr[0] = 0x46585350; /* "PSXF" */
    return 0;
}

static enum retro_pixel_format pixfmt = RETRO_PIXEL_FORMAT_0RGB1555;

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch) {
    if (!data || !shm) return;          /* a duped frame: the last one stays */
    if (w > FW) w = FW;
    if (h > FH) h = FH;
    int slot = hdr[2] ^ 1;
    uint8_t *o = shm + HDR + slot * SLOT;
    for (unsigned y = 0; y < h; y++) {
        const uint8_t *row = (const uint8_t *)data + y * pitch;
        uint8_t *d = o + y * w * 4;
        if (pixfmt == RETRO_PIXEL_FORMAT_XRGB8888) {
            const uint32_t *s = (const uint32_t *)row;
            for (unsigned x = 0; x < w; x++) {
                uint32_t v = s[x];
                d[0] = v >> 16; d[1] = v >> 8; d[2] = v; d[3] = 255; d += 4;
            }
        } else if (pixfmt == RETRO_PIXEL_FORMAT_RGB565) {
            const uint16_t *s = (const uint16_t *)row;
            for (unsigned x = 0; x < w; x++) {
                uint16_t v = s[x];
                uint8_t r = v >> 11, g = (v >> 5) & 63, b = v & 31;
                d[0] = (r << 3) | (r >> 2); d[1] = (g << 2) | (g >> 4); d[2] = (b << 3) | (b >> 2); d[3] = 255; d += 4;
            }
        } else {
            const uint16_t *s = (const uint16_t *)row;
            for (unsigned x = 0; x < w; x++) {
                uint16_t v = s[x];
                uint8_t r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
                d[0] = (r << 3) | (r >> 2); d[1] = (g << 3) | (g >> 2); d[2] = (b << 3) | (b >> 2); d[3] = 255; d += 4;
            }
        }
    }
    hdr[3] = w; hdr[4] = h; hdr[2] = slot;
    __sync_synchronize();
    hdr[1] = ++seq;
}

/* ------------------------------------------------------------------ controllers */
enum { K_NONE, K_EVDEV, K_HIDRAW, K_USBFS };
typedef struct {
    int fd, kind, sony, generic;
    char node[200], name[96];
    uint32_t b;                     /* buttons (retro joypad bits, BIT_PS for the PS button) */
    int lx, ly, hx, hy;            /* left stick (0..255), hat (-1..1) */
    uint32_t keys;                 /* evdev: face / shoulder keys held */
    struct usbdevfs_urb *urb;      /* usbfs: the interrupt transfer in flight, its buffer after it */
    int ep;                        /* usbfs: the HID interface's interrupt IN endpoint */
} pad_t;
static pad_t pads[MAXPADS];
static int npads_changed = 1;

static const unsigned short SONY_DS4[] = {0x05c4, 0x09cc, 0x0ba0, 0};
static const unsigned short SONY_DS5[] = {0x0ce6, 0x0df2, 0};
static int in_list(const unsigned short *l, unsigned short v) { for (; *l; l++) if (*l == v) return 1; return 0; }

static int pad_port(int i) {        /* players in the order the controllers were found */
    int port = 0;
    for (int j = 0; j < i; j++) if (pads[j].fd >= 0) port++;
    return port;
}

static uint32_t pad_bits(pad_t *p) {
    uint32_t b = p->b;
    if (p->kind == K_EVDEV) {
        b = p->keys;
        if (p->hy < 0) b |= 1 << RETRO_DEVICE_ID_JOYPAD_UP;
        if (p->hy > 0) b |= 1 << RETRO_DEVICE_ID_JOYPAD_DOWN;
        if (p->hx < 0) b |= 1 << RETRO_DEVICE_ID_JOYPAD_LEFT;
        if (p->hx > 0) b |= 1 << RETRO_DEVICE_ID_JOYPAD_RIGHT;
    }
    /* the left stick as the d-pad too */
    if (p->ly < 64) b |= 1 << RETRO_DEVICE_ID_JOYPAD_UP;
    if (p->ly > 192) b |= 1 << RETRO_DEVICE_ID_JOYPAD_DOWN;
    if (p->lx < 64) b |= 1 << RETRO_DEVICE_ID_JOYPAD_LEFT;
    if (p->lx > 192) b |= 1 << RETRO_DEVICE_ID_JOYPAD_RIGHT;
    return b;
}

static uint32_t port_bits(unsigned port) {
    uint32_t b = 0;
    for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0 && pad_port(i) == (int)port) b |= pad_bits(&pads[i]);
    return b;
}

static int test_bit(const unsigned long *a, int bit) { return (a[bit / (8 * sizeof(long))] >> (bit % (8 * sizeof(long)))) & 1; }

static int slot_free(void) { for (int i = 0; i < MAXPADS; i++) if (pads[i].fd < 0) return i; return -1; }
static int node_open(const char *node) { for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0 && !strcmp(pads[i].node, node)) return 1; return 0; }
static int sony_evdev_open(void) { for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0 && pads[i].kind == K_EVDEV && pads[i].sony) return 1; return 0; }

/* a small sysfs file's first line, or "" */
static char *sysread(const char *dir, const char *file, char *out, size_t n) {
    char p[512];
    snprintf(p, sizeof p, "%s/%s", dir, file);
    out[0] = 0;
    FILE *f = fopen(p, "r");
    if (!f) return out;
    if (!fgets(out, n, f)) out[0] = 0;
    fclose(f);
    size_t l = strlen(out);
    while (l && (out[l - 1] == '\n' || out[l - 1] == ' ')) out[--l] = 0;
    return out;
}

/* tests only: PSX_TEST_PADS="ds4:<fifo>,ds5:<fifo>,evdev:<fifo>,generic:<fifo>" reads those as controllers
   (test/test_pads.py feeds them the controllers' own reports and input events) */
static void scan_test_pads(void) {
    const char *spec = getenv("PSX_TEST_PADS");
    if (!spec) return;
    char buf[1024], *save = NULL;
    snprintf(buf, sizeof buf, "%s", spec);
    for (char *t = strtok_r(buf, ",", &save); t; t = strtok_r(NULL, ",", &save)) {
        char *c = strchr(t, ':');
        if (!c) continue;
        *c = 0;
        if (node_open(c + 1)) continue;
        int fd = open(c + 1, O_RDONLY | O_NONBLOCK | O_CLOEXEC), s = slot_free();
        if (fd < 0 || s < 0) { if (fd >= 0) close(fd); continue; }
        pad_t *p = &pads[s];
        memset(p, 0, sizeof *p);
        p->fd = fd; p->lx = p->ly = 128;
        if (!strcmp(t, "ds4") || !strcmp(t, "ds5")) { p->kind = K_HIDRAW; p->sony = t[2] - '0'; }
        else { p->kind = K_EVDEV; p->generic = !strcmp(t, "generic"); }
        snprintf(p->node, sizeof p->node, "%s", c + 1);
        snprintf(p->name, sizeof p->name, "test %s", t);
        npads_changed = 1;
    }
}

/* A PS4 / PS5 controller on USB that no kernel driver took (no evdev, no hidraw): its HID interface claimed through
   usbfs (/dev/bus/usb) and its interrupt endpoint read; the reports are the ones hidraw gives. One a driver holds is
   left to it, unless after 8 s it still shows no evdev or hidraw node. */
static int submit_urb(pad_t *p) {
    struct usbdevfs_urb *u = p->urb;
    memset(u, 0, sizeof *u);
    u->type = USBDEVFS_URB_TYPE_INTERRUPT;
    u->endpoint = p->ep;
    u->buffer = (uint8_t *)(u + 1);
    u->buffer_length = 64;
    return ioctl(p->fd, USBDEVFS_SUBMITURB, u);
}

static struct { char dev[32]; double t; } usb_seen[8];
static double usb_since(const char *dev) {      /* when this USB device was first seen with a driver on it */
    int fr = -1;
    for (int i = 0; i < 8; i++) {
        if (!strcmp(usb_seen[i].dev, dev)) return usb_seen[i].t;
        if (fr < 0 && !usb_seen[i].dev[0]) fr = i;
    }
    if (fr < 0) fr = 0;
    snprintf(usb_seen[fr].dev, sizeof usb_seen[fr].dev, "%s", dev);
    return usb_seen[fr].t = now_s();
}

static void scan_usbfs(void) {
    const char *root = "/sys/bus/usb/devices";
    DIR *d = opendir(root);
    struct dirent *e;
    while (d && (e = readdir(d))) {
        if (e->d_name[0] == '.' || strchr(e->d_name, ':')) continue;
        char dir[300], v[64], node[64];
        snprintf(dir, sizeof dir, "%s/%s", root, e->d_name);
        if (strtol(sysread(dir, "idVendor", v, sizeof v), NULL, 16) != 0x054c) continue;
        unsigned short prod = (unsigned short)strtol(sysread(dir, "idProduct", v, sizeof v), NULL, 16);
        if (!in_list(SONY_DS4, prod) && !in_list(SONY_DS5, prod)) continue;
        int bus = atoi(sysread(dir, "busnum", v, sizeof v)), dev = atoi(sysread(dir, "devnum", v, sizeof v));
        snprintf(node, sizeof node, "/dev/bus/usb/%03d/%03d", bus, dev);
        if (node_open(node) || access(node, F_OK)) continue;
        /* its HID interface (class 03) and that interface's interrupt IN endpoint */
        int ifno = -1, ep = -1, bound = 0;
        DIR *d2 = opendir(root);
        struct dirent *f;
        size_t nl = strlen(e->d_name);
        while (d2 && (f = readdir(d2)) && ep < 0) {
            if (strncmp(f->d_name, e->d_name, nl) || f->d_name[nl] != ':') continue;
            char idir[300], drv[400];
            snprintf(idir, sizeof idir, "%s/%s", root, f->d_name);
            if (strcmp(sysread(idir, "bInterfaceClass", v, sizeof v), "03")) continue;
            ifno = (int)strtol(sysread(idir, "bInterfaceNumber", v, sizeof v), NULL, 16);
            snprintf(drv, sizeof drv, "%s/driver", idir);
            bound = !access(drv, F_OK);
            DIR *d3 = opendir(idir);
            struct dirent *g;
            while (d3 && (g = readdir(d3))) {
                if (strncmp(g->d_name, "ep_", 3)) continue;
                char edir[600], t[32], dn[32];
                snprintf(edir, sizeof edir, "%s/%s", idir, g->d_name);
                if (!strcmp(sysread(edir, "type", t, sizeof t), "Interrupt") && !strcmp(sysread(edir, "direction", dn, sizeof dn), "in")) {
                    ep = (int)strtol(g->d_name + 3, NULL, 16);
                    break;
                }
            }
            if (d3) closedir(d3);
        }
        if (d2) closedir(d2);
        if (ifno < 0 || ep < 0) continue;
        if (bound && (now_s() - usb_since(node) < 8 || sony_evdev_open())) continue;
        int hid_open = 0;
        for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0 && pads[i].kind == K_HIDRAW) hid_open = 1;
        if (bound && hid_open) continue;
        int s = slot_free();
        if (s < 0) break;
        int fd = open(node, O_RDWR | O_CLOEXEC);
        if (fd < 0) { say("controller %s: can't open (%s)", node, strerror(errno)); continue; }
        if (ioctl(fd, USBDEVFS_CLAIMINTERFACE, &ifno) < 0) {
            struct usbdevfs_ioctl cmd = {.ifno = ifno, .ioctl_code = USBDEVFS_DISCONNECT, .data = NULL};
            ioctl(fd, USBDEVFS_IOCTL, &cmd);       /* a driver that made no gamepad of it */
            if (ioctl(fd, USBDEVFS_CLAIMINTERFACE, &ifno) < 0) { say("controller %s: can't claim interface %d (%s)", node, ifno, strerror(errno)); close(fd); continue; }
        }
        pad_t *p = &pads[s];
        memset(p, 0, sizeof *p);
        p->fd = fd; p->kind = K_USBFS; p->sony = in_list(SONY_DS5, prod) ? 5 : 4; p->ep = ep;
        p->lx = p->ly = 128;
        p->urb = calloc(1, sizeof(struct usbdevfs_urb) + 64);
        snprintf(p->node, sizeof p->node, "%s", node);
        char prodname[96];
        sysread(dir, "product", prodname, sizeof prodname);
        snprintf(p->name, sizeof p->name, "%s", prodname[0] ? prodname : (p->sony == 5 ? "DualSense" : "DualShock 4"));
        if (!p->urb || submit_urb(p) < 0) { say("controller %s: can't read endpoint %02x (%s)", node, ep, strerror(errno)); free(p->urb); p->urb = NULL; close(fd); p->fd = -1; continue; }
        say("controller %s: %s (USB endpoint %02x, interface %d%s)", node, p->name, ep, ifno, bound ? ", taken from its driver" : "");
        npads_changed = 1;
    }
    if (d) closedir(d);
}

static void scan_pads(void) {
    char node[64];
    scan_test_pads();
    for (int n = 0; n < 32; n++) {             /* evdev gamepads */
        snprintf(node, sizeof node, "/dev/input/event%d", n);
        if (node_open(node) || access(node, F_OK)) continue;
        int fd = open(node, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) continue;
        unsigned long keys[(KEY_MAX + 8 * sizeof(long)) / (8 * sizeof(long))] = {0};
        struct input_id id = {0};
        char name[96] = "";
        ioctl(fd, EVIOCGBIT(EV_KEY, sizeof keys), keys);
        ioctl(fd, EVIOCGID, &id);
        ioctl(fd, EVIOCGNAME(sizeof name - 1), name);
        int gamepad = test_bit(keys, BTN_SOUTH) || test_bit(keys, BTN_GAMEPAD);
        int generic = !gamepad && test_bit(keys, BTN_TRIGGER) && test_bit(keys, BTN_THUMB);
        int s = slot_free();
        if ((!gamepad && !generic) || s < 0) { close(fd); continue; }
        pad_t *p = &pads[s];
        memset(p, 0, sizeof *p);
        p->fd = fd; p->kind = K_EVDEV; p->sony = id.vendor == 0x054c; p->generic = generic;
        p->lx = p->ly = 128;
        snprintf(p->node, sizeof p->node, "%s", node);
        snprintf(p->name, sizeof p->name, "%s", name[0] ? name : "gamepad");
        say("controller %s: %s (evdev%s, %04x:%04x)", node, p->name, generic ? ", generic HID" : "", id.vendor, id.product);
        npads_changed = 1;
    }
    for (int n = 0; n < 16; n++) {             /* Sony controllers straight from their reports */
        snprintf(node, sizeof node, "/dev/hidraw%d", n);
        if (node_open(node) || access(node, F_OK)) continue;
        int fd = open(node, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) continue;
        struct hidraw_devinfo info = {0};
        char name[96] = "";
        if (ioctl(fd, HIDIOCGRAWINFO, &info) < 0 || (info.vendor & 0xffff) != 0x054c ||
            !(in_list(SONY_DS4, info.product) || in_list(SONY_DS5, info.product)) || sony_evdev_open()) { close(fd); continue; }
        int s = slot_free();
        if (s < 0) { close(fd); continue; }
        ioctl(fd, HIDIOCGRAWNAME(sizeof name - 1), name);
        pad_t *p = &pads[s];
        memset(p, 0, sizeof *p);
        p->fd = fd; p->kind = K_HIDRAW; p->sony = in_list(SONY_DS5, info.product) ? 5 : 4;
        p->lx = p->ly = 128;
        snprintf(p->node, sizeof p->node, "%s", node);
        snprintf(p->name, sizeof p->name, "%s", name[0] ? name : (p->sony == 5 ? "DualSense" : "DualShock 4"));
        say("controller %s: %s (raw reports, %s, %s)", node, p->name, p->sony == 5 ? "PS5" : "PS4", info.bustype == BUS_BLUETOOTH ? "Bluetooth" : "USB");
        npads_changed = 1;
    }
    scan_usbfs();
}

static void pad_close(pad_t *p, const char *why) {
    say("controller %s gone (%s)", p->node, why);
    close(p->fd);
    p->fd = -1;
    free(p->urb);
    p->urb = NULL;
    npads_changed = 1;
}

/* the Sony face / shoulder / PS bytes (the same in a DS4's and a DualSense's reports) into joypad bits */
static uint32_t sony_bits(uint8_t face, uint8_t sh, uint8_t ps) {
    static const uint8_t HAT[9] = {1, 1 | 8, 8, 8 | 2, 2, 2 | 4, 4, 4 | 1, 0};   /* N NE E SE S SW W NW none: up 1 down 2 left 4 right 8 */
    uint32_t b = 0;
    uint8_t h = HAT[(face & 15) < 9 ? (face & 15) : 8];
    if (h & 1) b |= 1 << RETRO_DEVICE_ID_JOYPAD_UP;
    if (h & 2) b |= 1 << RETRO_DEVICE_ID_JOYPAD_DOWN;
    if (h & 4) b |= 1 << RETRO_DEVICE_ID_JOYPAD_LEFT;
    if (h & 8) b |= 1 << RETRO_DEVICE_ID_JOYPAD_RIGHT;
    if (face & 0x10) b |= 1 << RETRO_DEVICE_ID_JOYPAD_Y;   /* square */
    if (face & 0x20) b |= 1 << RETRO_DEVICE_ID_JOYPAD_B;   /* cross */
    if (face & 0x40) b |= 1 << RETRO_DEVICE_ID_JOYPAD_A;   /* circle */
    if (face & 0x80) b |= 1 << RETRO_DEVICE_ID_JOYPAD_X;   /* triangle */
    if (sh & 0x01) b |= 1 << RETRO_DEVICE_ID_JOYPAD_L;
    if (sh & 0x02) b |= 1 << RETRO_DEVICE_ID_JOYPAD_R;
    if (sh & 0x04) b |= 1 << RETRO_DEVICE_ID_JOYPAD_L2;
    if (sh & 0x08) b |= 1 << RETRO_DEVICE_ID_JOYPAD_R2;
    if (sh & 0x10) b |= 1 << RETRO_DEVICE_ID_JOYPAD_SELECT;   /* share / create */
    if (sh & 0x20) b |= 1 << RETRO_DEVICE_ID_JOYPAD_START;    /* options */
    if (sh & 0x40) b |= 1 << RETRO_DEVICE_ID_JOYPAD_L3;
    if (sh & 0x80) b |= 1 << RETRO_DEVICE_ID_JOYPAD_R3;
    if (ps & 0x01) b |= 1 << BIT_PS;
    return b;
}

/* one input report of a DS4 or DualSense, as hidraw and the USB endpoint give it (the report id first) */
static void sony_report(pad_t *p, const uint8_t *r, ssize_t n) {
    int base = -1, ds5full = 0;
    if (p->sony == 4) {
        if (r[0] == 0x01 && n >= 10) base = 1;          /* USB, or Bluetooth's basic report */
        else if (r[0] == 0x11 && n >= 12) base = 3;     /* Bluetooth's full report */
    } else {
        if (r[0] == 0x01 && n >= 30) { base = 1; ds5full = 1; }   /* USB */
        else if (r[0] == 0x31 && n >= 30) { base = 2; ds5full = 1; } /* Bluetooth, full */
        else if (r[0] == 0x01 && n >= 10) base = 1;      /* Bluetooth's basic report (DS4's layout) */
    }
    if (base < 0) return;
    p->lx = r[base]; p->ly = r[base + 1];
    p->b = ds5full ? sony_bits(r[base + 7], r[base + 8], r[base + 9]) : sony_bits(r[base + 4], r[base + 5], r[base + 6]);
}

static void read_hidraw(pad_t *p) {
    uint8_t r[128];
    ssize_t n;
    while ((n = read(p->fd, r, sizeof r)) > 0) sony_report(p, r, n);
    if (n < 0 && errno != EAGAIN && errno != EINTR) pad_close(p, strerror(errno));
}

static void read_usbfs(pad_t *p) {
    struct usbdevfs_urb *u;
    while (ioctl(p->fd, USBDEVFS_REAPURBNDELAY, &u) == 0) {
        if (u->status == 0 && u->actual_length > 0) sony_report(p, u->buffer, u->actual_length);
        else if (u->status == -EPIPE) { unsigned int ep = p->ep; ioctl(p->fd, USBDEVFS_CLEAR_HALT, &ep); }
        else if (u->status == -ENODEV || u->status == -ESHUTDOWN) { pad_close(p, "unplugged"); return; }
        if (submit_urb(p) < 0) { pad_close(p, strerror(errno)); return; }
    }
    if (errno == ENODEV) pad_close(p, "unplugged");
}

static void read_evdev(pad_t *p) {
    struct input_event ev[64];
    ssize_t n;
    while ((n = read(p->fd, ev, sizeof ev)) > 0) {
        for (int i = 0; i < (int)(n / sizeof ev[0]); i++) {
            struct input_event *e = &ev[i];
            if (e->type == EV_KEY) {
                int id = -1;
                if (!p->generic) switch (e->code) {
                    case BTN_SOUTH: id = RETRO_DEVICE_ID_JOYPAD_B; break;   /* cross */
                    case BTN_EAST: id = RETRO_DEVICE_ID_JOYPAD_A; break;    /* circle */
                    case BTN_NORTH: id = RETRO_DEVICE_ID_JOYPAD_X; break;   /* triangle */
                    case BTN_WEST: id = RETRO_DEVICE_ID_JOYPAD_Y; break;    /* square */
                    case BTN_TL: id = RETRO_DEVICE_ID_JOYPAD_L; break;
                    case BTN_TR: id = RETRO_DEVICE_ID_JOYPAD_R; break;
                    case BTN_TL2: id = RETRO_DEVICE_ID_JOYPAD_L2; break;
                    case BTN_TR2: id = RETRO_DEVICE_ID_JOYPAD_R2; break;
                    case BTN_SELECT: id = RETRO_DEVICE_ID_JOYPAD_SELECT; break;
                    case BTN_START: id = RETRO_DEVICE_ID_JOYPAD_START; break;
                    case BTN_THUMBL: id = RETRO_DEVICE_ID_JOYPAD_L3; break;
                    case BTN_THUMBR: id = RETRO_DEVICE_ID_JOYPAD_R3; break;
                    case BTN_MODE: id = BIT_PS; break;
                    case BTN_DPAD_UP: id = RETRO_DEVICE_ID_JOYPAD_UP; break;
                    case BTN_DPAD_DOWN: id = RETRO_DEVICE_ID_JOYPAD_DOWN; break;
                    case BTN_DPAD_LEFT: id = RETRO_DEVICE_ID_JOYPAD_LEFT; break;
                    case BTN_DPAD_RIGHT: id = RETRO_DEVICE_ID_JOYPAD_RIGHT; break;
                } else {
                    /* a Sony controller without its driver: the HID buttons in the order square, cross, circle, triangle,
                       L1, R1, L2, R2, share, options, L3, R3, PS */
                    static const int ORDER[13] = {RETRO_DEVICE_ID_JOYPAD_Y, RETRO_DEVICE_ID_JOYPAD_B, RETRO_DEVICE_ID_JOYPAD_A,
                        RETRO_DEVICE_ID_JOYPAD_X, RETRO_DEVICE_ID_JOYPAD_L, RETRO_DEVICE_ID_JOYPAD_R, RETRO_DEVICE_ID_JOYPAD_L2,
                        RETRO_DEVICE_ID_JOYPAD_R2, RETRO_DEVICE_ID_JOYPAD_SELECT, RETRO_DEVICE_ID_JOYPAD_START,
                        RETRO_DEVICE_ID_JOYPAD_L3, RETRO_DEVICE_ID_JOYPAD_R3, BIT_PS};
                    int k = e->code >= BTN_TRIGGER && e->code < BTN_TRIGGER + 12 ? e->code - BTN_TRIGGER
                        : e->code == BTN_TRIGGER_HAPPY1 || e->code == 0x12c ? 12 : -1;
                    if (k >= 0) id = ORDER[k];
                }
                if (id >= 0) { if (e->value) p->keys |= 1u << id; else p->keys &= ~(1u << id); }
            } else if (e->type == EV_ABS) {
                if (e->code == ABS_HAT0X) p->hx = e->value < 0 ? -1 : e->value > 0;
                else if (e->code == ABS_HAT0Y) p->hy = e->value < 0 ? -1 : e->value > 0;
                else if (e->code == ABS_X) p->lx = e->value;
                else if (e->code == ABS_Y) p->ly = e->value;
            }
        }
    }
    if (n < 0 && errno != EAGAIN && errno != EINTR) pad_close(p, strerror(errno));
}

/* ------------------------------------------------------------------ sound
   The outputs, in order: PSX_AUDIO (a command, for tests), pacat, aplay, gst-launch-1.0 (each fed raw S16LE stereo on
   its stdin), then every ALSA playback device (/proc/asound/pcm), written to straight, converted to a format, channel
   count and rate it takes. The one in /var/opt/psx/sound (the last one "tone" played on) is used, else the first that
   opens. */
static pid_t snd_pid = -1;
static int snd_fd = -1;
static char snd_name[96] = "", snd_state[200] = "not started";
static int snd_rate = 44100;

static const char *find_prog(const char *name) {
    static char p[128];
    const char *dirs[] = {"/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", NULL};
    for (int i = 0; dirs[i]; i++) {
        snprintf(p, sizeof p, "%s/%s", dirs[i], name);
        if (!access(p, X_OK)) return p;
    }
    return NULL;
}

typedef struct { char key[32], label[96]; int card, dev; } out_t;   /* key: "pacat", "alsa 0 3" ... */
static out_t outs[24];
static int nouts;

static void outs_find(void) {
    nouts = 0;
    const char *e = getenv("PSX_AUDIO");
    if (e && *e) { snprintf(outs[nouts].key, 32, "PSX_AUDIO"); snprintf(outs[nouts++].label, 96, "PSX_AUDIO"); }
    const char *progs[] = {"pacat", "aplay", "gst-launch-1.0", NULL};
    for (int i = 0; progs[i]; i++) if (find_prog(progs[i])) { snprintf(outs[nouts].key, 32, "%s", progs[i]); snprintf(outs[nouts++].label, 96, "%s", progs[i]); }
    /* "00-03: id : name : playback 1 : capture 1" */
    FILE *f = fopen("/proc/asound/pcm", "r");
    char line[256];
    while (f && fgets(line, sizeof line, f) && nouts < 24) {
        int c, d;
        if (sscanf(line, "%d-%d:", &c, &d) != 2 || !strstr(line, "playback")) continue;
        char *n = strchr(line, ':'), *n2 = n ? strchr(n + 1, ':') : NULL, *n3 = n2 ? strchr(n2 + 1, ':') : NULL;
        char name[64] = "";
        if (n2 && n3) { *n3 = 0; n2++; while (*n2 == ' ') n2++; snprintf(name, sizeof name, "%s", n2); }
        size_t l = strlen(name);
        while (l && name[l - 1] == ' ') name[--l] = 0;
        out_t *o = &outs[nouts++];
        o->card = c; o->dev = d;
        snprintf(o->key, 32, "alsa %d %d", c, d);
        snprintf(o->label, 96, "ALSA card %d device %d%s%s", c, d, name[0] ? ": " : "", name);
    }
    if (f) fclose(f);
}

static void out_saved(char *key, size_t n) {
    char p[300];
    snprintf(p, sizeof p, "%s/sound", HOME);
    key[0] = 0;
    FILE *f = fopen(p, "r");
    if (f) { if (fgets(key, n, f)) key[strcspn(key, "\n")] = 0; fclose(f); }
}
static void out_save(const char *key) {
    char p[300];
    snprintf(p, sizeof p, "%s/sound", HOME);
    FILE *f = fopen(p, "w");
    if (f) { fprintf(f, "%s\n", key); fclose(f); }
}

/* ---- ALSA, straight to the device (the kernel's PCM ioctls; no libasound on the unit to lean on) */
static int alsa_fd = -1, alsa_ch, alsa_rate, alsa_bytes, alsa_fmt;
static double rs_pos = -1;          /* the resampler: where the next output frame falls, in input frames */
static int16_t rs_last[2];
static uint8_t *alsa_buf;
static size_t alsa_cap;

static struct snd_mask *hw_mask(struct snd_pcm_hw_params *p, int n) { return &p->masks[n - SNDRV_PCM_HW_PARAM_FIRST_MASK]; }
static struct snd_interval *hw_int(struct snd_pcm_hw_params *p, int n) { return &p->intervals[n - SNDRV_PCM_HW_PARAM_FIRST_INTERVAL]; }
static void hw_any(struct snd_pcm_hw_params *p) {
    memset(p, 0, sizeof *p);
    for (int n = SNDRV_PCM_HW_PARAM_FIRST_MASK; n <= SNDRV_PCM_HW_PARAM_LAST_MASK; n++) memset(hw_mask(p, n)->bits, 0xff, sizeof hw_mask(p, n)->bits);
    for (int n = SNDRV_PCM_HW_PARAM_FIRST_INTERVAL; n <= SNDRV_PCM_HW_PARAM_LAST_INTERVAL; n++) { hw_int(p, n)->min = 0; hw_int(p, n)->max = UINT_MAX; }
    p->rmask = ~0u; p->info = ~0u;
}
static void hw_set_mask(struct snd_pcm_hw_params *p, int n, unsigned v) {
    struct snd_mask *m = hw_mask(p, n);
    memset(m->bits, 0, sizeof m->bits);
    m->bits[v >> 5] = 1u << (v & 31);
}
static void hw_set_int(struct snd_pcm_hw_params *p, int n, unsigned v) { struct snd_interval *i = hw_int(p, n); i->min = i->max = v; i->integer = 1; i->openmin = i->openmax = 0; }
static int has_fmt(struct snd_pcm_hw_params *p, int f) { return (hw_mask(p, SNDRV_PCM_HW_PARAM_FORMAT)->bits[f >> 5] >> (f & 31)) & 1; }

static void alsa_close(void) {
    if (alsa_fd >= 0) { ioctl(alsa_fd, SNDRV_PCM_IOCTL_DROP); close(alsa_fd); alsa_fd = -1; }
}

/* opens card / dev for want_rate stereo S16; why: what went wrong */
static int alsa_open(int card, int dev, int want_rate, char *why, size_t whyn) {
    char node[64];
    snprintf(node, sizeof node, "/dev/snd/pcmC%dD%dp", card, dev);
    int fd = open(node, O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { snprintf(why, whyn, "%s", errno == EBUSY ? "in use by the car" : strerror(errno)); return -1; }
    struct snd_pcm_hw_params hp;
    hw_any(&hp);
    hw_set_mask(&hp, SNDRV_PCM_HW_PARAM_ACCESS, SNDRV_PCM_ACCESS_RW_INTERLEAVED);
    if (ioctl(fd, SNDRV_PCM_IOCTL_HW_REFINE, &hp) < 0) { snprintf(why, whyn, "takes no plain writes (%s)", strerror(errno)); close(fd); return -1; }
    int fmt, bytes;
    if (has_fmt(&hp, SNDRV_PCM_FORMAT_S16_LE)) { fmt = SNDRV_PCM_FORMAT_S16_LE; bytes = 2; }
    else if (has_fmt(&hp, SNDRV_PCM_FORMAT_S32_LE)) { fmt = SNDRV_PCM_FORMAT_S32_LE; bytes = 4; }
    else if (has_fmt(&hp, SNDRV_PCM_FORMAT_S24_LE)) { fmt = SNDRV_PCM_FORMAT_S24_LE; bytes = 4; }
    else { snprintf(why, whyn, "no 16 or 32-bit format"); close(fd); return -1; }
    struct snd_interval ci = *hw_int(&hp, SNDRV_PCM_HW_PARAM_CHANNELS), ri = *hw_int(&hp, SNDRV_PCM_HW_PARAM_RATE);
    unsigned ch = (ci.min <= 2 && ci.max >= 2) ? 2 : ci.min;
    unsigned rate = ((unsigned)want_rate >= ri.min && (unsigned)want_rate <= ri.max) ? (unsigned)want_rate
                  : (48000 >= ri.min && 48000 <= ri.max) ? 48000 : ri.min;
    if (!ch || ch > 64 || !rate) { snprintf(why, whyn, "odd device (%u channels, %u Hz)", ch, rate); close(fd); return -1; }
    int ok = 0;
    for (int attempt = 0; attempt < 2 && !ok; attempt++) {
        hw_any(&hp);
        hw_set_mask(&hp, SNDRV_PCM_HW_PARAM_ACCESS, SNDRV_PCM_ACCESS_RW_INTERLEAVED);
        hw_set_mask(&hp, SNDRV_PCM_HW_PARAM_FORMAT, fmt);
        hw_set_mask(&hp, SNDRV_PCM_HW_PARAM_SUBFORMAT, SNDRV_PCM_SUBFORMAT_STD);
        hw_set_int(&hp, SNDRV_PCM_HW_PARAM_CHANNELS, ch);
        hw_set_int(&hp, SNDRV_PCM_HW_PARAM_RATE, rate);
        if (attempt == 0) {            /* about 20 ms periods, 4 of them; the device's own choice if it won't */
            hw_int(&hp, SNDRV_PCM_HW_PARAM_PERIOD_SIZE)->min = rate / 50;
            hw_set_int(&hp, SNDRV_PCM_HW_PARAM_PERIODS, 4);
        }
        ok = ioctl(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &hp) == 0;
    }
    if (!ok) { snprintf(why, whyn, "won't take %u channels at %u Hz (%s)", ch, rate, strerror(errno)); close(fd); return -1; }
    snd_pcm_uframes_t period = hw_int(&hp, SNDRV_PCM_HW_PARAM_PERIOD_SIZE)->min, buffer = hw_int(&hp, SNDRV_PCM_HW_PARAM_BUFFER_SIZE)->min;
    struct snd_pcm_sw_params sp;
    memset(&sp, 0, sizeof sp);
    sp.tstamp_mode = SNDRV_PCM_TSTAMP_NONE;
    sp.period_step = 1;
    sp.avail_min = period;
    sp.start_threshold = period * 2 < buffer ? period * 2 : buffer;
    sp.stop_threshold = buffer;
    sp.boundary = buffer;
    while (sp.boundary * 2 <= LONG_MAX - buffer) sp.boundary *= 2;
    if (ioctl(fd, SNDRV_PCM_IOCTL_SW_PARAMS, &sp) < 0 || ioctl(fd, SNDRV_PCM_IOCTL_PREPARE) < 0) { snprintf(why, whyn, "won't start (%s)", strerror(errno)); close(fd); return -1; }
    alsa_close();
    alsa_fd = fd; alsa_ch = ch; alsa_rate = rate; alsa_bytes = bytes; alsa_fmt = fmt;
    rs_pos = -1; rs_last[0] = rs_last[1] = 0;
    snprintf(why, whyn, "%u channel%s, %u Hz, %s, %lu-frame periods", ch, ch == 1 ? "" : "s", rate,
             fmt == SNDRV_PCM_FORMAT_S16_LE ? "16-bit" : fmt == SNDRV_PCM_FORMAT_S32_LE ? "32-bit" : "24-bit", (unsigned long)period);
    return 0;
}

/* stereo S16 at src_rate into the device's format; returns the device frames written, -1: the device is full
   (dropped), -2: it fails */
static int alsa_write(const int16_t *src, size_t frames, int src_rate) {
    if (alsa_fd < 0 || !frames) return 0;
    size_t cap = (size_t)((double)frames * alsa_rate / src_rate) + 4, fb = (size_t)alsa_ch * alsa_bytes;
    if (cap * fb > alsa_cap) { uint8_t *nb = realloc(alsa_buf, cap * fb); if (!nb) return 0; alsa_buf = nb; alsa_cap = cap * fb; }
    double step = (double)src_rate / alsa_rate;
    size_t n = 0;
    while (rs_pos < (double)frames - 1 && n < cap) {
        int i = (int)floor(rs_pos);
        double f = rs_pos - i;
        const int16_t *a = i < 0 ? rs_last : src + 2 * i, *b = src + 2 * (i + 1);
        int l = (int)(a[0] + (b[0] - a[0]) * f), r = (int)(a[1] + (b[1] - a[1]) * f);
        uint8_t *o = alsa_buf + n * fb;
        memset(o, 0, fb);
        for (int c = 0; c < alsa_ch && c < 2; c++) {
            int v = alsa_ch == 1 ? (l + r) / 2 : c ? r : l;
            if (alsa_bytes == 2) ((int16_t *)o)[c] = (int16_t)v;
            else ((int32_t *)o)[c] = alsa_fmt == SNDRV_PCM_FORMAT_S24_LE ? v * 256 : v * 65536;
        }
        n++;
        rs_pos += step;
    }
    rs_pos -= frames;
    rs_last[0] = src[2 * (frames - 1)]; rs_last[1] = src[2 * (frames - 1) + 1];
    struct snd_xferi x = {.buf = alsa_buf, .frames = n};
    for (int tries = 0; tries < 2; tries++) {
        if (ioctl(alsa_fd, SNDRV_PCM_IOCTL_WRITEI_FRAMES, &x) == 0) return (int)x.result;
        if (errno == EAGAIN) return -1;
        if (errno == EPIPE || errno == ESTRPIPE || errno == EBADFD) ioctl(alsa_fd, SNDRV_PCM_IOCTL_PREPARE);   /* ran dry: start again */
        else return -2;
    }
    return -2;
}

static void snd_stop(void) {
    alsa_close();
    if (snd_fd >= 0) { close(snd_fd); snd_fd = -1; }
    if (snd_pid > 0) { kill(snd_pid, SIGTERM); waitpid(snd_pid, NULL, 0); snd_pid = -1; }
}

/* starts output o; why: the result in words */
static int out_start(const out_t *o, int rate, char *why, size_t whyn) {
    snd_stop();
    if (!strncmp(o->key, "alsa ", 5)) {
        if (alsa_open(o->card, o->dev, rate, why, whyn) < 0) return -1;
        snd_rate = rate;
        snprintf(snd_name, sizeof snd_name, "%s", o->label);
        return 0;
    }
    char cmd[400];
    const char *p = find_prog(o->key);
    if (!strcmp(o->key, "PSX_AUDIO")) snprintf(cmd, sizeof cmd, "%s", getenv("PSX_AUDIO"));
    else if (!p) { snprintf(why, whyn, "not found"); return -1; }
    else if (!strcmp(o->key, "pacat")) snprintf(cmd, sizeof cmd, "%s --raw --format=s16le --rate=%d --channels=2 --latency-msec=120", p, rate);
    else if (!strcmp(o->key, "aplay")) snprintf(cmd, sizeof cmd, "%s -q -t raw -f S16_LE -r %d -c 2 -B 120000", p, rate);
    else snprintf(cmd, sizeof cmd, "%s -q fdsrc fd=0 do-timestamp=true ! audio/x-raw,format=S16LE,rate=%d,channels=2,layout=interleaved"
                                   " ! queue ! audioconvert ! audioresample ! autoaudiosink", p, rate);
    int pfd[2];
    if (pipe2(pfd, O_CLOEXEC) < 0) { snprintf(why, whyn, "%s", strerror(errno)); return -1; }
    pid_t pid = fork();
    if (pid == 0) {
        dup2(pfd[0], 0);
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) dup2(devnull, 1);
        execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
        _exit(127);
    }
    close(pfd[0]);
    if (pid < 0) { close(pfd[1]); snprintf(why, whyn, "%s", strerror(errno)); return -1; }
    fcntl(pfd[1], F_SETFL, O_NONBLOCK);
    snd_pid = pid; snd_fd = pfd[1]; snd_rate = rate;
    snprintf(snd_name, sizeof snd_name, "%s", o->label);
    why[0] = 0;
    say("sound: %s", cmd);
    return 0;
}

static int snd_start(int rate) {
    char saved[64], why[160];
    outs_find();
    out_saved(saved, sizeof saved);
    snd_name[0] = 0;
    if (!nouts) { snprintf(snd_state, sizeof snd_state, "no sound output on this unit (no player, no ALSA playback device)"); return -1; }
    for (int pass = 0; pass < 2; pass++)
        for (int i = 0; i < nouts; i++) {
            if (pass == 0 && strcmp(outs[i].key, saved)) continue;
            if (out_start(&outs[i], rate, why, sizeof why) == 0) {
                snprintf(snd_state, sizeof snd_state, "playing through %s%s%s%s", outs[i].label, why[0] ? " (" : "", why, why[0] ? ")" : "");
                return 0;
            }
            say("sound: %s: %s", outs[i].label, why);
        }
    snprintf(snd_state, sizeof snd_state, "no output would start (%d tried)", nouts);
    return -1;
}

static void snd_reap(void) {
    int st;
    if (snd_pid > 0 && waitpid(snd_pid, &st, WNOHANG) == snd_pid) {
        snprintf(snd_state, sizeof snd_state, "%s stopped (%s %d): no sound", snd_name,
                 WIFEXITED(st) ? "exit" : "signal", WIFEXITED(st) ? WEXITSTATUS(st) : WTERMSIG(st));
        say("sound: %s", snd_state);
        snd_pid = -1;
        if (snd_fd >= 0) { close(snd_fd); snd_fd = -1; }
        npads_changed = 1;
    }
}

static size_t audio_batch_cb(const int16_t *data, size_t frames) {
    if (alsa_fd >= 0) alsa_write(data, frames, snd_rate);
    else if (snd_fd >= 0) { ssize_t w = write(snd_fd, data, frames * 4); (void)w; }   /* full: dropped, never waited for */
    return frames;
}
static void audio_cb(int16_t l, int16_t r) { int16_t s[2] = {l, r}; audio_batch_cb(s, 1); }

/* ------------------------------------------------------------------ the core */
static int running, paused, have_core_init;
static int game_rate = 44100;         /* the running game's sound rate */
static double fps = 60.0;
static char game[1024], game_name[256];
static uint8_t *card_copy;
static size_t card_size;
static double card_check;

static void core_log(enum retro_log_level level, const char *fmt, ...) {
    if (level < RETRO_LOG_INFO) return;
    char line[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
    say("core: %s", line);
}

static bool env_cb(unsigned cmd, void *data) {
    static char sysdir[300], savedir[300];
    switch (cmd & 0xffff) {
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: snprintf(sysdir, sizeof sysdir, "%s/bios", HOME); *(const char **)data = sysdir; return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: snprintf(savedir, sizeof savedir, "%s/saves", HOME); *(const char **)data = savedir; return true;
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
            enum retro_pixel_format f = *(enum retro_pixel_format *)data;
            if (f != RETRO_PIXEL_FORMAT_XRGB8888 && f != RETRO_PIXEL_FORMAT_RGB565 && f != RETRO_PIXEL_FORMAT_0RGB1555) return false;
            pixfmt = f; return true;
        }
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: ((struct retro_log_callback *)data)->log = core_log; return true;
        case RETRO_ENVIRONMENT_GET_CAN_DUPE: *(bool *)data = true; return true;
        case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS: return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE: {
            struct retro_variable *v = data;
            v->value = NULL;
            if (v->key && !strcmp(v->key, "pcsx_rearmed_show_bios_bootlogo")) { v->value = "enabled"; return true; }   /* (real BIOS only) */
            return false;
        }
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: *(bool *)data = false; return true;
        case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
            const struct retro_system_av_info *av = data;
            if (av->timing.fps > 1) fps = av->timing.fps;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_GEOMETRY:
        case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
        case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
        case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
        case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
        case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE:
        case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
            return true;
        case RETRO_ENVIRONMENT_SET_MESSAGE: {
            const struct retro_message *m = data;
            if (m && m->msg) { say("core message: %s", m->msg); send_line("{\"ev\":\"message\",\"text\":\"%s\"}", js(m->msg)); }
            return true;
        }
        case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE: *(int *)data = 3; return true;
        default: return false;
    }
}

static void input_poll_cb(void) {}

static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port > 1) return 0;
    uint32_t b = port_bits(port);
    if (device == RETRO_DEVICE_JOYPAD) {
        if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)(b & 0xffff);
        return id < 16 ? (b >> id) & 1 : 0;
    }
    if (device == RETRO_DEVICE_ANALOG && index == RETRO_DEVICE_INDEX_ANALOG_LEFT) {
        for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0 && pad_port(i) == (int)port)
            return (int16_t)(((id == RETRO_DEVICE_ID_ANALOG_X ? pads[i].lx : pads[i].ly) - 128) * 256);
    }
    return 0;
}

static void card_path(char *p, size_t n) { snprintf(p, n, "%s/saves/%s.srm", HOME, game_name); }

static void card_load(void) {
    size_t sz = retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
    void *mem = retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
    free(card_copy); card_copy = NULL; card_size = 0;
    if (!sz || !mem) return;
    char p[1400];
    card_path(p, sizeof p);
    FILE *f = fopen(p, "rb");
    if (f) { size_t got = fread(mem, 1, sz, f); fclose(f); say("memory card: %s (%zu bytes)", p, got); }
    card_copy = malloc(sz);
    if (card_copy) { memcpy(card_copy, mem, sz); card_size = sz; }
}

static void card_save(int force) {
    void *mem = retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
    if (!mem || !card_copy || (!force && !memcmp(mem, card_copy, card_size))) return;
    if (!memcmp(mem, card_copy, card_size)) return;
    char p[1400], t[1410];
    card_path(p, sizeof p);
    snprintf(t, sizeof t, "%s.tmp", p);
    FILE *f = fopen(t, "wb");
    if (!f) return;
    size_t w = fwrite(mem, 1, card_size, f);
    fclose(f);
    if (w == card_size && !rename(t, p)) { memcpy(card_copy, mem, card_size); say("memory card saved: %s", p); }
}

static void status(void);

static void game_unload(void) {
    if (!running) return;
    card_save(1);
    retro_unload_game();
    snd_stop();
    running = paused = 0;
    if (hdr) { hdr[6] = 0; hdr[7] = 0; }
    say("game stopped: %s", game_name);
    game[0] = game_name[0] = 0;
}

static int game_load(const char *path) {
    game_unload();
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode)) { send_line("{\"ev\":\"loaded\",\"ok\":false,\"text\":\"no such file\"}"); return -1; }
    snprintf(game, sizeof game, "%s", path);
    const char *b = strrchr(path, '/');
    snprintf(game_name, sizeof game_name, "%s", b ? b + 1 : path);
    char *dot = strrchr(game_name, '.');
    if (dot) *dot = 0;
    struct retro_game_info gi = {game, NULL, 0, NULL};
    say("loading %s", game);
    if (!retro_load_game(&gi)) {
        say("the core did not load %s", game);
        send_line("{\"ev\":\"loaded\",\"ok\":false,\"text\":\"the emulator could not start this game\"}");
        game[0] = game_name[0] = 0;
        return -1;
    }
    struct retro_system_av_info av;
    retro_get_system_av_info(&av);
    fps = av.timing.fps > 1 ? av.timing.fps : 60;
    retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
    retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);
    card_load();
    game_rate = (int)(av.timing.sample_rate + 0.5);
    snd_start(game_rate);
    running = 1; paused = 0;
    if (hdr) { hdr[5] = (uint32_t)(fps * 100); hdr[6] = 1; hdr[7] = 0; }
    say("running %s at %.2f fps, %ux%u", game_name, fps, av.geometry.base_width, av.geometry.base_height);
    send_line("{\"ev\":\"loaded\",\"ok\":true,\"game\":\"%s\"}", js(game_name));
    return 0;
}

/* ------------------------------------------------------------------ games */
static int game_ext(const char *n) {
    const char *d = strrchr(n, '.');
    if (!d) return 0;
    const char *ok[] = {".cue", ".chd", ".pbp", ".iso", ".img", ".bin", ".exe", ".m3u", NULL};
    for (int i = 0; ok[i]; i++) if (!strcasecmp(d, ok[i])) return 1;
    return 0;
}

/* a PlayStation BIOS by its name and size (scph1001.bin, SCPH5501.BIN ...: 512 KiB) */
static int is_bios(const char *name, off_t size) {
    return size == 524288 && !strncasecmp(name, "scph", 4) && strlen(name) > 4 && !strcasecmp(name + strlen(name) - 4, ".bin");
}

/* the BIOS the core will use (the first in /var/opt/psx/bios), or "" */
static const char *bios_name(void) {
    static char name[256];
    char dir[300];
    snprintf(dir, sizeof dir, "%s/bios", HOME);
    name[0] = 0;
    DIR *d = opendir(dir);
    struct dirent *e;
    while (d && (e = readdir(d))) {
        char p[600];
        struct stat st;
        snprintf(p, sizeof p, "%s/%s", dir, e->d_name);
        if (!stat(p, &st) && is_bios(e->d_name, st.st_size)) { snprintf(name, sizeof name, "%s", e->d_name); break; }
    }
    if (d) closedir(d);
    return name;
}

/* a BIOS found on a USB stick: copied to /var/opt/psx/bios under its lower-case name (the core's) */
static void bios_take(const char *path, const char *name) {
    char low[256], dst[600], tmp[610];
    size_t i;
    for (i = 0; name[i] && i < sizeof low - 1; i++) low[i] = (name[i] >= 'A' && name[i] <= 'Z') ? name[i] + 32 : name[i];
    low[i] = 0;
    snprintf(dst, sizeof dst, "%s/bios/%s", HOME, low);
    if (!access(dst, F_OK)) return;
    FILE *in = fopen(path, "rb");
    if (!in) return;
    snprintf(tmp, sizeof tmp, "%s.tmp", dst);
    FILE *out = fopen(tmp, "wb");
    char buf[65536];
    size_t n, total = 0;
    while (out && (n = fread(buf, 1, sizeof buf, in)) > 0) total += fwrite(buf, 1, n, out);
    fclose(in);
    if (!out) return;
    fclose(out);
    if (total == 524288 && !rename(tmp, dst)) {
        say("BIOS %s copied from %s: starting again with it", low, path);
        send_line("{\"ev\":\"message\",\"text\":\"PlayStation BIOS found on the USB stick (%s): the startup screen is on\"}", js(low));
        restart_now = 1;
    } else unlink(tmp);
}

static char list_buf[16000];
static size_t list_len;
static int list_n;

static int list_visits;              /* entries looked at on one stick: a big disk is not searched to the end */

static void list_dir(const char *dir, int depth) {
    if (depth > 3 || list_n >= 200) return;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) && list_n < 200 && list_visits++ < 5000) {
        if (e->d_name[0] == '.') continue;
        char p[1200];
        snprintf(p, sizeof p, "%s/%s", dir, e->d_name);
        struct stat st;
        if (stat(p, &st)) continue;
        if (S_ISDIR(st.st_mode)) { list_dir(p, depth + 1); continue; }
        if (S_ISREG(st.st_mode) && is_bios(e->d_name, st.st_size)) { bios_take(p, e->d_name); continue; }
        if (!S_ISREG(st.st_mode) || !game_ext(e->d_name)) continue;
        const char *dot = strrchr(e->d_name, '.');
        if (!strcasecmp(dot, ".bin")) {        /* a .bin beside its .cue: the .cue only */
            char cue[1200];
            snprintf(cue, sizeof cue, "%.*s.cue", (int)(strlen(p) - 4), p);
            if (!access(cue, F_OK)) continue;
            snprintf(cue, sizeof cue, "%.*s.CUE", (int)(strlen(p) - 4), p);
            if (!access(cue, F_OK)) continue;
        }
        int n = snprintf(list_buf + list_len, sizeof list_buf - list_len, "%s{\"name\":\"%s\",\"path\":\"%s\",\"mb\":%lld}",
                         list_n ? "," : "", js(e->d_name), js(p), (long long)(st.st_size >> 20));
        if (n < 0 || (size_t)n >= sizeof list_buf - list_len) break;
        list_len += n; list_n++;
    }
    closedir(d);
}

static void list_add(const char *name, const char *path) {
    int n = snprintf(list_buf + list_len, sizeof list_buf - list_len, "%s{\"name\":\"%s\",\"path\":\"%s\",\"mb\":0}",
                     list_n ? "," : "", js(name), js(path));
    if (n > 0 && (size_t)n < sizeof list_buf - list_len) { list_len += n; list_n++; }
}

/* the PlayStation's own menu (memory cards, CD player): with a real BIOS, a blank audio CD boots into it */
static void menu_disc(void) {
    char bin[300], cue[300];
    snprintf(bin, sizeof bin, "%s/menu.bin", RUN);
    snprintf(cue, sizeof cue, "%s/menu.cue", RUN);
    if (!access(cue, R_OK)) return;
    FILE *f = fopen(bin, "wb");
    if (!f) return;
    static const char zero[2352];
    for (int i = 0; i < 150; i++) fwrite(zero, 1, sizeof zero, f);   /* 2 s of silence */
    fclose(f);
    f = fopen(cue, "w");
    if (f) { fprintf(f, "FILE \"menu.bin\" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n"); fclose(f); }
}

/* /proc/mounts escapes space, tab, newline and backslash as \ooo */
static void unescape_mount(char *s) {
    char *o = s;
    for (; *s; s++) {
        if (s[0] == '\\' && s[1] >= '0' && s[1] <= '7' && s[2] >= '0' && s[2] <= '7' && s[3] >= '0' && s[3] <= '7') {
            *o++ = (char)((s[1] - '0') * 64 + (s[2] - '0') * 8 + (s[3] - '0'));
            s += 3;
        } else *o++ = *s;
    }
    *o = 0;
}

/* a USB stick, as the Store's updater finds one (whatever is mounted under /media), and wherever else head units put
   them: under /run/media, a USB disk (/dev/sd*) under /mnt, or a removable disk's file system anywhere */
static int stick_mount(const char *dev, const char *mnt, const char *fs) {
    static const char *rem[] = {"vfat", "msdos", "exfat", "texfat", "tfat", "ntfs", "ntfs3", "tntfs", "ufsd", "fuseblk", "hfsplus", NULL};
    for (int i = 0; rem[i]; i++) if (!strcmp(fs, rem[i])) return 1;
    if ((!strncmp(mnt, "/media/", 7) && mnt[7]) || (!strncmp(mnt, "/run/media/", 11) && mnt[11])) return 1;
    return !strncmp(mnt, "/mnt/", 5) && !strncmp(dev, "/dev/sd", 7);
}

/* each mount: cb(dev, mnt, fs) */
static void each_mount(void (*cb)(const char *, const char *, const char *, void *), void *arg) {
    FILE *m = fopen("/proc/mounts", "r");
    char dev[256], mnt[512], fs[64];
    while (m && fscanf(m, "%255s %511s %63s %*[^\n]", dev, mnt, fs) == 3) { unescape_mount(dev); unescape_mount(mnt); cb(dev, mnt, fs, arg); }
    if (m) fclose(m);
}

static char sticks_buf[2000];
static size_t sticks_len;
static int sticks_n;
static void jadd(char *buf, size_t cap, size_t *len, int *n, const char *item) {
    int k = snprintf(buf + *len, cap - *len, "%s\"%s\"", *n ? "," : "", js(item));
    if (k > 0 && (size_t)k < cap - *len) { *len += k; (*n)++; }
}
static void list_stick(const char *dev, const char *mnt, const char *fs, void *arg) {
    (void)arg;
    if (!stick_mount(dev, mnt, fs)) return;
    char item[700];
    int before = list_n;
    list_visits = 0;
    list_dir(mnt, 0);
    snprintf(item, sizeof item, "%s (%s): %d game%s", mnt, fs, list_n - before, list_n - before == 1 ? "" : "s");
    jadd(sticks_buf, sizeof sticks_buf, &sticks_len, &sticks_n, item);
}

static void list_games(void) {
    char games[300];
    list_len = 0; list_n = 0; list_buf[0] = 0;
    snprintf(games, sizeof games, "%s/games", HOME);
    if (bios_name()[0]) {
        char cue[300];
        menu_disc();
        snprintf(cue, sizeof cue, "%s/menu.cue", RUN);
        list_add("PlayStation menu (memory cards, CD player)", cue);
    }
    /* the test program shipped beside this binary (test/make_test_exe.py): colour bars, to see a picture with no game */
    char self[600] = "";
    ssize_t sl = readlink("/proc/self/exe", self, sizeof self - 20);
    if (sl > 0) {
        self[sl] = 0;
        char *slash = strrchr(self, '/');
        if (slash) {
            strcpy(slash, "/test.exe");
            if (!access(self, R_OK)) list_add("PS1 test picture (colour bars)", self);
        }
    }
    list_visits = 0;
    list_dir(games, 0);
    /* USB sticks (tests: PSX_TEST_USB, a folder taken for one) */
    sticks_len = 0; sticks_n = 0; sticks_buf[0] = 0;
    const char *tu = getenv("PSX_TEST_USB");
    if (tu) list_stick("/dev/sdtest", tu, "vfat", NULL);
    each_mount(list_stick, NULL);
    send_line("{\"ev\":\"games\",\"dir\":\"%s\",\"sticks\":[%s],\"games\":[%s]}", js(games), sticks_buf, list_buf);
}

/* ------------------------------------------------------------------ Bluetooth pairing, a test tone */
static pid_t pair_pid = -1, tone_pid = -1;

static void pair_start(void) {
    if (pair_pid > 0) return;
    const char *bt = find_prog("bluetoothctl");
    if (!bt) { send_line("{\"ev\":\"pair\",\"ok\":false,\"text\":\"this head unit has no bluetoothctl (BlueZ): pairing from here is not possible; try the controller over a USB cable\"}"); return; }
    char script[2048], log[300];
    snprintf(log, sizeof log, "%s/pair.log", RUN);
    /* look for 20 s, then pair, trust and connect the first PlayStation controller seen */
    snprintf(script, sizeof script,
        "BT=%s; L=%s; : > $L\n"
        "(echo 'power on'; echo 'agent NoInputNoOutput'; echo 'default-agent'; echo 'scan on'; sleep 20; echo 'scan off'; echo 'devices'; echo 'quit') | $BT >> $L 2>&1\n"
        "MAC=$(grep -E 'Device ([0-9A-Fa-f:]{17}) .*(Wireless Controller|DualSense|DUALSHOCK)' $L | sed -E 's/.*Device ([0-9A-Fa-f:]{17}).*/\\1/' | tail -n 1)\n"
        "[ -z \"$MAC\" ] && { echo 'RESULT no controller found'; exit 2; }\n"
        "(echo \"pair $MAC\"; sleep 6; echo \"trust $MAC\"; sleep 1; echo \"connect $MAC\"; sleep 5; echo 'quit') | $BT >> $L 2>&1\n"
        "grep -q -E 'Connection successful|Connected: yes' $L && { echo \"RESULT connected $MAC\"; exit 0; }\n"
        "echo \"RESULT paired $MAC, not connected\"; exit 3\n", bt, log);
    pid_t pid = fork();
    if (pid == 0) {
        int fd = open(log, O_WRONLY | O_APPEND | O_CREAT, 0644);
        if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); }
        execl("/bin/sh", "sh", "-c", script, (char *)NULL);
        _exit(127);
    }
    pair_pid = pid;
    say("pairing: looking for a controller for 20 s");
    send_line("{\"ev\":\"pair\",\"busy\":true,\"text\":\"Looking for a controller for 20 s: hold PS and Share (PS4) or PS and Create (PS5) until it flashes\"}");
}

static void pair_reap(void) {
    int st;
    if (pair_pid <= 0 || waitpid(pair_pid, &st, WNOHANG) != pair_pid) return;
    pair_pid = -1;
    char p[300], line[256], last[256] = "";
    snprintf(p, sizeof p, "%s/pair.log", RUN);
    FILE *f = fopen(p, "r");
    while (f && fgets(line, sizeof line, f)) if (!strncmp(line, "RESULT ", 7)) snprintf(last, sizeof last, "%s", line + 7);
    if (f) fclose(f);
    size_t n = strlen(last);
    while (n && (last[n - 1] == '\n')) last[--n] = 0;
    int ok = WIFEXITED(st) && WEXITSTATUS(st) == 0;
    say("pairing: %s", last[0] ? last : "ended");
    send_line("{\"ev\":\"pair\",\"ok\":%s,\"text\":\"%s\"}", ok ? "true" : "false", js(last[0] ? last : "ended without an answer"));
    scan_pads();
}

/* a 1 s test tone on the next output after the one last tested, which is then the one games use */
static void tone(void) {
    if (tone_pid > 0) return;
    if (running) { send_line("{\"ev\":\"tone\",\"ok\":true,\"text\":\"a game is running: its sound is the test\"}"); return; }
    char saved[64], why[160], tried[600] = "";
    outs_find();
    out_saved(saved, sizeof saved);
    if (!nouts) { send_line("{\"ev\":\"tone\",\"ok\":false,\"text\":\"no sound output on this unit: no player program and no ALSA playback device\"}"); return; }
    int from = 0;
    for (int i = 0; i < nouts; i++) if (!strcmp(outs[i].key, saved)) from = i + 1;
    int got = -1;
    for (int k = 0; k < nouts && got < 0; k++) {
        int i = (from + k) % nouts;
        if (out_start(&outs[i], 44100, why, sizeof why) == 0) { got = i; break; }
        size_t tl = strlen(tried);
        snprintf(tried + tl, sizeof tried - tl, "%s%s: %s", tl ? "; " : "", outs[i].label, why);
    }
    if (got < 0) {
        snprintf(snd_state, sizeof snd_state, "no output would start");
        send_line("{\"ev\":\"tone\",\"ok\":false,\"text\":\"No output would start. %s\"}", js(tried));
        return;
    }
    int16_t buf[2 * 4410];
    int ok = 1, is_alsa = alsa_fd >= 0;
    for (int k = 0; k < 10 && ok; k++) {          /* 1 s of 440 Hz */
        for (int i = 0; i < 4410; i++) {
            int16_t v = (int16_t)(8000 * sin(2 * M_PI * 440 * (k * 4410 + i) / 44100.0));
            buf[2 * i] = buf[2 * i + 1] = v;
        }
        if (is_alsa) {
            /* 10 ms at a time, each when the device has room for it (less than one of its periods): a device that
               makes no room for 2 s isn't playing */
            for (int i0 = 0; i0 < 4410 && ok; i0 += 441) {
                struct pollfd pf = {.fd = alsa_fd, .events = POLLOUT};
                if (poll(&pf, 1, 2000) <= 0 || alsa_write(buf + 2 * i0, 441, 44100) < 0) ok = 0;
            }
        } else {
            fcntl(snd_fd, F_SETFL, 0);
            ssize_t w = write(snd_fd, buf, sizeof buf);
            if (w < 0) ok = 0;
        }
    }
    if (is_alsa) {
        struct timespec ts = {0, 300 * 1000000L};     /* the last of it plays out */
        if (ok) nanosleep(&ts, NULL);
        else snprintf(why, sizeof why, "the device took no sound: it isn't playing");
        alsa_close();
    } else {
        close(snd_fd); snd_fd = -1;
        int st = 0;
        pid_t r = waitpid(snd_pid, &st, 0);
        snd_pid = -1;
        ok = ok && r > 0 && WIFEXITED(st) && WEXITSTATUS(st) == 0;
        if (!ok) snprintf(why, sizeof why, "it stopped (%s %d)", WIFEXITED(st) ? "exit" : "signal", WIFEXITED(st) ? WEXITSTATUS(st) : WTERMSIG(st));
    }
    out_save(outs[got].key);
    snd_name[0] = 0;                    /* nothing plays now */
    snprintf(snd_state, sizeof snd_state, "%s %s%s%s%s", ok ? "test tone played on" : "test tone failed on", outs[got].label,
             why[0] ? " (" : "", why, why[0] ? ")" : "");
    send_line("{\"ev\":\"tone\",\"ok\":%s,\"n\":%d,\"of\":%d,\"out\":\"%s\",\"text\":\"%s\",\"skipped\":\"%s\"}", ok ? "true" : "false",
              got + 1, nouts, js(outs[got].label), js(snd_state), js(tried));
    say("sound: %s%s%s", snd_state, tried[0] ? "; skipped " : "", tried);
    status();
}

/* ------------------------------------------------------------------ what the head unit shows (the app's "Car" page) */
static const char *PSEUDO_FS[] = {"proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "mqueue", "debugfs", "tracefs",
                                  "securityfs", "pstore", "bpf", "configfs", "hugetlbfs", "fusectl", "binfmt_misc", "autofs", "rpc_pipefs",
                                  "nsfs", "efivarfs", "selinuxfs", "ramfs", "smackfs", "devfs", NULL};
typedef struct { char *buf; size_t cap, len; int n; } jarr_t;
static void jarr(jarr_t *a, const char *item) { if (a->n < 40) jadd(a->buf, a->cap, &a->len, &a->n, item); }

static void sys_mount(const char *dev, const char *mnt, const char *fs, void *arg) {
    jarr_t *a = arg;
    for (int i = 0; PSEUDO_FS[i]; i++) if (!strcmp(fs, PSEUDO_FS[i])) return;
    char item[800];
    snprintf(item, sizeof item, "%s%s (%s, %s)", stick_mount(dev, mnt, fs) ? "USB stick: " : "", mnt, fs, dev);
    jarr(a, item);
}

static void sys_info(void) {
    static char b_mnt[4000], b_blk[1200], b_usb[3000], b_in[2500], b_snd[2500], b_proc[1500], b_prog[600];
    jarr_t mnt = {b_mnt, sizeof b_mnt, 0, 0}, blk = {b_blk, sizeof b_blk, 0, 0}, usb = {b_usb, sizeof b_usb, 0, 0},
           in = {b_in, sizeof b_in, 0, 0}, snd = {b_snd, sizeof b_snd, 0, 0}, proc = {b_proc, sizeof b_proc, 0, 0},
           prog = {b_prog, sizeof b_prog, 0, 0};
    b_mnt[0] = b_blk[0] = b_usb[0] = b_in[0] = b_snd[0] = b_proc[0] = b_prog[0] = 0;
    char line[512], item[600], v[128];
    each_mount(sys_mount, &mnt);
    /* USB disks the kernel sees, mounted or not */
    FILE *f = fopen("/proc/partitions", "r");
    while (f && fgets(line, sizeof line, f)) {
        unsigned long long kb;
        char name[64];
        if (sscanf(line, "%*u %*u %llu %63s", &kb, name) == 2 && !strncmp(name, "sd", 2)) {
            snprintf(item, sizeof item, "%s (%.1f GB)", name, kb / 1048576.0);
            jarr(&blk, item);
        }
    }
    if (f) fclose(f);
    /* USB devices, with the drivers on their interfaces */
    const char *root = "/sys/bus/usb/devices";
    DIR *d = opendir(root);
    struct dirent *e;
    while (d && (e = readdir(d))) {
        if (e->d_name[0] == '.' || strchr(e->d_name, ':')) continue;
        char dir[300], vid[16], pid[16], prod[96], drivers[200] = "";
        snprintf(dir, sizeof dir, "%s/%s", root, e->d_name);
        sysread(dir, "idVendor", vid, sizeof vid);
        if (!vid[0] || !strcmp(vid, "1d6b")) continue;         /* root hubs */
        sysread(dir, "idProduct", pid, sizeof pid);
        sysread(dir, "product", prod, sizeof prod);
        DIR *d2 = opendir(root);
        struct dirent *g;
        size_t nl = strlen(e->d_name);
        while (d2 && (g = readdir(d2))) {
            if (strncmp(g->d_name, e->d_name, nl) || g->d_name[nl] != ':') continue;
            char lp[400], target[300] = "";
            snprintf(lp, sizeof lp, "%s/%s/driver", root, g->d_name);
            ssize_t tl = readlink(lp, target, sizeof target - 1);
            const char *dn = "none";
            if (tl > 0) { target[tl] = 0; dn = strrchr(target, '/') ? strrchr(target, '/') + 1 : target; }
            if (!strstr(drivers, dn)) { size_t l = strlen(drivers); snprintf(drivers + l, sizeof drivers - l, "%s%s", l ? ", " : "", dn); }
        }
        if (d2) closedir(d2);
        snprintf(item, sizeof item, "%s:%s %s (drivers: %s)", vid, pid, prod[0] ? prod : "(no name)", drivers[0] ? drivers : "none");
        jarr(&usb, item);
    }
    if (d) closedir(d);
    /* input devices and raw HID nodes */
    int hidraw = 0;
    for (int n = 0; n < 32; n++) {
        char node[64], name[96] = "";
        snprintf(node, sizeof node, "/dev/input/event%d", n);
        if (access(node, F_OK)) continue;
        int fd = open(node, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd >= 0) { ioctl(fd, EVIOCGNAME(sizeof name - 1), name); close(fd); }
        snprintf(item, sizeof item, "event%d: %s", n, fd < 0 ? strerror(errno) : name[0] ? name : "(no name)");
        jarr(&in, item);
    }
    for (int n = 0; n < 16; n++) { char node[64]; snprintf(node, sizeof node, "/dev/hidraw%d", n); if (!access(node, F_OK)) hidraw++; }
    /* sound: the cards, and the outputs "tone" goes through */
    f = fopen("/proc/asound/cards", "r");
    while (f && fgets(line, sizeof line, f)) {
        char *t = line;
        while (*t == ' ') t++;
        if (*t < '0' || *t > '9') continue;
        line[strcspn(line, "\n")] = 0;
        snprintf(item, sizeof item, "card %s", t);
        jarr(&snd, item);
    }
    if (f) fclose(f);
    outs_find();
    for (int i = 0; i < nouts; i++) jarr(&snd, outs[i].label);
    /* the head unit's own sound and Bluetooth services, by their process names */
    static const char *words[] = {"audio", "pulse", "pipewire", "alsa", "snd", "sound", "gst", "amp", "blue", "bt", "hci", "media", "usb", NULL};
    d = opendir("/proc");
    while (d && (e = readdir(d))) {
        if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
        char pp[300], comm[64] = "";
        snprintf(pp, sizeof pp, "/proc/%s/comm", e->d_name);
        FILE *c = fopen(pp, "r");
        if (!c) continue;
        if (fgets(comm, sizeof comm, c)) comm[strcspn(comm, "\n")] = 0;
        fclose(c);
        int hit = 0;
        for (int i = 0; words[i] && !hit; i++) if (strcasestr(comm, words[i])) hit = 1;
        if (!hit || strstr(b_proc, comm)) continue;
        jarr(&proc, comm);
    }
    if (d) closedir(d);
    static const char *progs[] = {"pacat", "paplay", "pw-cat", "aplay", "amixer", "gst-launch-1.0", "gst-play-1.0", "bluetoothctl", "hciconfig", "btmgmt", NULL};
    for (int i = 0; progs[i]; i++) if (find_prog(progs[i])) jarr(&prog, progs[i]);
    send_line("{\"ev\":\"sys\",\"mounts\":[%s],\"disks\":[%s],\"usb\":[%s],\"input\":[%s],\"hidraw\":%d,\"usbfs\":%s,"
              "\"sound\":[%s],\"procs\":[%s],\"progs\":[%s],\"snd_dev\":%s,\"version\":\"%s\"}",
              b_mnt, b_blk, b_usb, b_in, hidraw, access("/dev/bus/usb", F_OK) ? "false" : "true", b_snd, b_proc, b_prog,
              access("/dev/snd", F_OK) ? "false" : "true", VERSION);
    (void)v;
}

/* ------------------------------------------------------------------ status */
static void status(void) {
    char padj[2048] = "";
    size_t n = 0;
    int k = 0;
    for (int i = 0; i < MAXPADS; i++) {
        if (pads[i].fd < 0) continue;
        n += snprintf(padj + n, sizeof padj - n, "%s{\"player\":%d,\"name\":\"%s\",\"via\":\"%s\"}", k++ ? "," : "", pad_port(i) + 1,
                      js(pads[i].name), pads[i].kind == K_EVDEV ? (pads[i].generic ? "evdev, no driver" : "evdev") : pads[i].kind == K_USBFS ? "USB, no driver" : "raw reports");
        if (n >= sizeof padj) break;
    }
    int hci = 0;
    DIR *d = opendir("/sys/class/bluetooth");
    struct dirent *e;
    while (d && (e = readdir(d))) if (!strncmp(e->d_name, "hci", 3)) hci++;
    if (d) closedir(d);
    int bluez = 0;
    d = opendir("/proc");
    while (d && (e = readdir(d))) {
        if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
        char p[300], comm[64] = "";
        snprintf(p, sizeof p, "/proc/%s/comm", e->d_name);
        FILE *f = fopen(p, "r");
        if (f) { if (fgets(comm, sizeof comm, f) && !strncmp(comm, "bluetoothd", 10)) bluez = 1; fclose(f); }
    }
    if (d) closedir(d);
    const char *bt = find_prog("bluetoothctl");
    char saved[64], saved_label[96] = "";
    outs_find();
    out_saved(saved, sizeof saved);
    for (int i = 0; i < nouts; i++) if (!strcmp(outs[i].key, saved)) snprintf(saved_label, sizeof saved_label, "%s", outs[i].label);
    send_line("{\"ev\":\"status\",\"version\":\"%s\",\"running\":%s,\"paused\":%s,\"game\":\"%s\",\"fps\":%.2f,\"pads\":[%s],"
              "\"sound\":{\"player\":\"%s\",\"state\":\"%s\",\"outputs\":%d,\"saved\":\"%s\"},"
              "\"bt\":{\"adapters\":%d,\"bluez\":%s,\"bluetoothctl\":%s,\"pairing\":%s},\"bios\":\"%s\",\"home\":\"%s\"}",
              VERSION, running ? "true" : "false", paused ? "true" : "false", js(game_name), fps, padj,
              js(snd_name), js(snd_state), nouts, js(saved_label),
              hci, bluez ? "true" : "false", bt ? "true" : "false", pair_pid > 0 ? "true" : "false", js(bios_name()), js(HOME));
}

/* ------------------------------------------------------------------ commands */
static void command(char *line) {
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = 0;
    if (!strcmp(line, "status")) status();
    else if (!strcmp(line, "list")) list_games();
    else if (!strncmp(line, "load ", 5)) {
        if (!game_ext(line + 5)) send_line("{\"ev\":\"loaded\",\"ok\":false,\"text\":\"not a PlayStation game file\"}");
        else { game_load(line + 5); status(); }
    } else if (!strcmp(line, "unload")) { game_unload(); status(); }
    /* paused, the sound device is let go: the car may want it (an ALSA device held here is one it can't open) */
    else if (!strcmp(line, "pause")) { if (running) { paused = 1; if (hdr) hdr[7] = 1; card_save(0); snd_stop(); snd_name[0] = 0; } status(); }
    else if (!strcmp(line, "resume")) { if (running) { paused = 0; if (hdr) hdr[7] = 0; if (alsa_fd < 0 && snd_fd < 0) snd_start(game_rate); } status(); }
    else if (!strcmp(line, "reset")) { if (running) retro_reset(); status(); }
    else if (!strcmp(line, "pair")) pair_start();
    else if (!strcmp(line, "tone")) tone();
    else if (!strcmp(line, "sys")) sys_info();
    else if (line[0]) send_line("{\"ev\":\"error\",\"text\":\"unknown command: %s\"}", js(line));
}

static void on_signal(int s) { (void)s; quit_now = 1; }

int main(int argc, char **argv) {
    const char *e;
    if ((e = getenv("PSX_RUN"))) snprintf(RUN, sizeof RUN, "%s", e);
    if ((e = getenv("PSX_HOME"))) snprintf(HOME, sizeof HOME, "%s", e);
    if (argc > 1 && !strcmp(argv[1], "--version")) { printf("psx-core %s\n", VERSION); return 0; }
    self_argv = argv;
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    for (int i = 0; i < MAXPADS; i++) pads[i].fd = -1;
    char p[400];
    const char *sub[] = {"", "/games", "/bios", "/saves", NULL};
    for (int i = 0; sub[i]; i++) { snprintf(p, sizeof p, "%s%s", HOME, sub[i]); mkdir(p, 0755); }
    log_open();
    signal(SIGSEGV, on_crash); signal(SIGBUS, on_crash); signal(SIGILL, on_crash); signal(SIGFPE, on_crash); signal(SIGABRT, on_crash);
    say("psx-core %s starting (uid %d, pid %d)", VERSION, (int)getuid(), (int)getpid());
    if (mkdir(RUN, 0755) < 0 && errno != EEXIST) say("can't make %s: %s", RUN, strerror(errno));
    chmod(RUN, 0755);
    if (shm_open_frames() < 0) { say("no frame buffer in %s: %s", RUN, strerror(errno)); return 1; }
    snprintf(p, sizeof p, "%s/ctl.sock", RUN);
    unlink(p);
    lfd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    snprintf(a.sun_path, sizeof a.sun_path, "%s", p);
    if (lfd < 0 || bind(lfd, (struct sockaddr *)&a, sizeof a) < 0 || listen(lfd, 2) < 0) { say("socket %s: %s", p, strerror(errno)); return 1; }
    chmod(p, 0666);        /* the app runs as another user */

    retro_set_environment(env_cb);
    retro_set_video_refresh(video_cb);
    retro_set_audio_sample(audio_cb);
    retro_set_audio_sample_batch(audio_batch_cb);
    retro_set_input_poll(input_poll_cb);
    retro_set_input_state(input_state_cb);
    retro_init();
    have_core_init = 1;
    say("ready: socket %s, games in %s/games", p, HOME);
    scan_pads();
    int mfd = open("/proc/mounts", O_RDONLY | O_CLOEXEC);
    if (mfd >= 0) { char junk[4096]; while (read(mfd, junk, sizeof junk) > 0) {} }
    list_games();                         /* a BIOS on a stick that was in before this started */

    double next = now_s(), last_scan = 0, last_card = 0;
    uint32_t last_menu_bits = 0;
    while (!quit_now) {
        if (restart_now && !running) {        /* the core scans the BIOS folder only when it starts */
            retro_deinit();
            snd_stop();
            say("starting again (a BIOS was added)");
            execv("/proc/self/exe", self_argv);
            say("could not start again: %s", strerror(errno));
            restart_now = 0;
            retro_init();
        }
        double t = now_s();
        if (t - last_scan > 2.0) { last_scan = t; scan_pads(); snd_reap(); pair_reap(); }
        if (running && t - last_card > 5.0) { last_card = t; card_save(0); }
        struct pollfd pf[3 + MAXPADS];
        int np = 0, map[MAXPADS];
        pf[np].fd = lfd; pf[np++].events = POLLIN;
        if (cfd >= 0) { pf[np].fd = cfd; pf[np++].events = POLLIN; }
        int base = np;
        for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0) { map[np - base] = i; pf[np].fd = pads[i].fd; pf[np++].events = pads[i].kind == K_USBFS ? POLLOUT : POLLIN; }
        int pend = np, mi = -1;
        if (mfd >= 0) { mi = np; pf[np].fd = mfd; pf[np++].events = POLLPRI; }
        int timeout = 500;
        if (running && !paused) { double w = next - now_s(); timeout = w > 0 ? (int)(w * 1000) : 0; }
        if (pair_pid > 0 && timeout > 250) timeout = 250;
        poll(pf, np, timeout);
        if (pf[0].revents & POLLIN) {
            int c = accept4(lfd, NULL, NULL, SOCK_CLOEXEC);
            if (c >= 0) { if (cfd >= 0) close(cfd); cfd = c; inlen = 0; say("the app connected"); status(); }
        }
        if (cfd >= 0 && np > 1 && pf[1].fd == cfd && (pf[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            ssize_t r = recv(cfd, inbuf + inlen, sizeof inbuf - 1 - inlen, 0);
            if (r <= 0) { close(cfd); cfd = -1; say("the app left"); if (running && !paused) { paused = 1; if (hdr) hdr[7] = 1; snd_stop(); snd_name[0] = 0; } }
            else {
                inlen += r; inbuf[inlen] = 0;
                char *s = inbuf, *nl;
                while ((nl = strchr(s, '\n'))) { *nl = 0; command(s); s = nl + 1; }
                inlen = strlen(s);
                memmove(inbuf, s, inlen + 1);
                if (inlen >= sizeof inbuf - 1) inlen = 0;
            }
        }
        /* a USB stick came or went (the kernel flags /proc/mounts): the games again, and a BIOS on it taken */
        if (mi >= 0 && (pf[mi].revents & (POLLPRI | POLLERR))) {
            char junk[4096];
            lseek(mfd, 0, SEEK_SET);
            while (read(mfd, junk, sizeof junk) > 0) {}
            say("the mounts changed: looking for games again");
            list_games();
        }
        for (int k = base; k < pend; k++) {
            if (!(pf[k].revents & (POLLIN | POLLOUT | POLLHUP | POLLERR))) continue;
            pad_t *pd = &pads[map[k - base]];
            if (pd->fd < 0) continue;
            if (pd->kind == K_HIDRAW) read_hidraw(pd);
            else if (pd->kind == K_USBFS) read_usbfs(pd);
            else read_evdev(pd);
        }
        /* the PS button: the app's menu; buttons for the app's menus while no game plays (any controller) */
        uint32_t b0 = 0;
        for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0) b0 |= pad_bits(&pads[i]);
        if ((b0 & (1u << BIT_PS)) && !(last_menu_bits & (1u << BIT_PS))) send_line("{\"ev\":\"menu\"}");
        if ((!running || paused) && b0 != last_menu_bits) send_line("{\"ev\":\"pad\",\"b\":%u}", b0);
        last_menu_bits = b0;
        if (npads_changed) { npads_changed = 0; status(); }
        if (running && !paused && now_s() >= next) {
            retro_run();
            next += 1.0 / fps;
            if (now_s() - next > 0.1) next = now_s();      /* fell behind: start the clock again */
        } else if (!running || paused) next = now_s();
    }
    game_unload();
    if (have_core_init) retro_deinit();
    snd_stop();
    say("stopped");
    return 0;
}
