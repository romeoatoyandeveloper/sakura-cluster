/*
 * psx-core: the PlayStation emulator service behind the PSX app, for a BMW iDrive 7 (MGU) head unit.
 *
 * It runs PCSX-ReARMed (the libretro core, linked in: GPL-2.0, see ../README.md) as root, because only root can read
 * a game controller (/dev/input, /dev/hidraw) and reach the sound devices. The PSX app (apps/psx, the centre screen)
 * talks to it over a Unix socket and draws the frames it leaves in shared memory:
 *
 *   /dev/shm/psx-core/ctl.sock   commands, one per line, from the app:
 *                                  status | list | load <path> | unload | pause | resume | reset | pair | tone
 *                                and JSON lines back: {"ev":"status",...}, {"ev":"games",...}, {"ev":"loaded",...},
 *                                {"ev":"pad","b":<buttons>} (while no game runs or it is paused: menus), {"ev":"menu"}
 *                                (the PS button), {"ev":"pair",...}, {"ev":"tone",...}, {"ev":"error","text":...}
 *   /dev/shm/psx-core/frame      64-byte header (u32 LE: magic "PSXF", seq, slot, w, h, fps x 100, running, paused)
 *                                and two 1024 x 512 RGBA slots; the header's slot is the newest whole frame, seq
 *                                counts frames
 *
 * Controllers: PS4 (DualShock 4) and PS5 (DualSense), over USB or Bluetooth, first through the kernel's gamepad
 * driver (evdev: BTN_SOUTH ..., or a generic HID joystick's buttons in the Sony order), else straight from the
 * controller's own reports (hidraw), so no driver is needed. The first two found are players 1 and 2; the left stick
 * works as the d-pad too; the PS button opens the app's menu.
 * Sound: piped to pacat or aplay when the unit has one (else silent, said in the status).
 * Bluetooth: "pair" looks for a controller in pairing mode for 20 s with bluetoothctl (BlueZ), when the unit has it.
 * Games: /var/opt/psx/games and USB sticks (removable file systems in /proc/mounts), .cue .chd .pbp .iso .img .bin
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
#include "libretro.h"

#define VERSION "0.2.0"
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

/* ------------------------------------------------------------------ log */
static void say(const char *fmt, ...) {
    va_list ap;
    time_t t = time(NULL);
    struct tm tm;
    char ts[32];
    localtime_r(&t, &tm);
    strftime(ts, sizeof ts, "%H:%M:%S", &tm);
    fprintf(stderr, "%s psx-core: ", ts);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
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
    char line[16384];
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
enum { K_NONE, K_EVDEV, K_HIDRAW };
typedef struct {
    int fd, kind, sony, generic;
    char node[64], name[96];
    uint32_t b;                     /* buttons (retro joypad bits, BIT_PS for the PS button) */
    int lx, ly, hx, hy;            /* left stick (0..255), hat (-1..1) */
    uint32_t keys;                 /* evdev: face / shoulder keys held */
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
}

static void pad_close(pad_t *p, const char *why) {
    say("controller %s gone (%s)", p->node, why);
    close(p->fd);
    p->fd = -1;
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

static void read_hidraw(pad_t *p) {
    uint8_t r[128];
    ssize_t n;
    while ((n = read(p->fd, r, sizeof r)) > 0) {
        int base = -1, ds5full = 0;
        if (p->sony == 4) {
            if (r[0] == 0x01 && n >= 10) base = 1;          /* USB, or Bluetooth's basic report */
            else if (r[0] == 0x11 && n >= 12) base = 3;     /* Bluetooth's full report */
        } else {
            if (r[0] == 0x01 && n >= 30) { base = 1; ds5full = 1; }   /* USB */
            else if (r[0] == 0x31 && n >= 30) { base = 2; ds5full = 1; } /* Bluetooth, full */
            else if (r[0] == 0x01 && n >= 10) base = 1;      /* Bluetooth's basic report (DS4's layout) */
        }
        if (base < 0) continue;
        p->lx = r[base]; p->ly = r[base + 1];
        p->b = ds5full ? sony_bits(r[base + 7], r[base + 8], r[base + 9]) : sony_bits(r[base + 4], r[base + 5], r[base + 6]);
    }
    if (n < 0 && errno != EAGAIN && errno != EINTR) pad_close(p, strerror(errno));
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

/* ------------------------------------------------------------------ sound: piped to pacat or aplay */
static pid_t snd_pid = -1;
static int snd_fd = -1;
static char snd_name[32] = "", snd_state[128] = "not started";
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

static void snd_stop(void) {
    if (snd_fd >= 0) { close(snd_fd); snd_fd = -1; }
    if (snd_pid > 0) { kill(snd_pid, SIGTERM); waitpid(snd_pid, NULL, 0); snd_pid = -1; }
}

static int snd_start(int rate) {
    snd_stop();
    char cmd[256];
    const char *env = getenv("PSX_AUDIO"), *p;
    if (env && *env) { snprintf(cmd, sizeof cmd, "%s", env); snprintf(snd_name, sizeof snd_name, "PSX_AUDIO"); }
    else if ((p = find_prog("pacat"))) { snprintf(cmd, sizeof cmd, "%s --raw --format=s16le --rate=%d --channels=2 --latency-msec=120", p, rate); snprintf(snd_name, sizeof snd_name, "pacat"); }
    else if ((p = find_prog("aplay"))) { snprintf(cmd, sizeof cmd, "%s -q -t raw -f S16_LE -r %d -c 2 -B 120000", p, rate); snprintf(snd_name, sizeof snd_name, "aplay"); }
    else { snd_name[0] = 0; snprintf(snd_state, sizeof snd_state, "no sound player on this unit (pacat, aplay)"); return -1; }
    int pfd[2];
    if (pipe2(pfd, O_CLOEXEC) < 0) return -1;
    pid_t pid = fork();
    if (pid == 0) {
        dup2(pfd[0], 0);
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) dup2(devnull, 1);
        execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
        _exit(127);
    }
    close(pfd[0]);
    if (pid < 0) { close(pfd[1]); return -1; }
    fcntl(pfd[1], F_SETFL, O_NONBLOCK);
    snd_pid = pid; snd_fd = pfd[1]; snd_rate = rate;
    snprintf(snd_state, sizeof snd_state, "playing through %s", snd_name);
    say("sound: %s", cmd);
    return 0;
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
    if (snd_fd >= 0) { ssize_t w = write(snd_fd, data, frames * 4); (void)w; }   /* full: dropped, never waited for */
    return frames;
}
static void audio_cb(int16_t l, int16_t r) { int16_t s[2] = {l, r}; audio_batch_cb(s, 1); }

/* ------------------------------------------------------------------ the core */
static int running, paused, have_core_init;
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
    snd_start((int)(av.timing.sample_rate + 0.5));
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

static void list_dir(const char *dir, int depth) {
    if (depth > 3 || list_n >= 200) return;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) && list_n < 200) {
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
    list_dir(games, 0);
    /* USB sticks: removable file systems (tests: PSX_TEST_USB, a folder taken for one) */
    const char *tu = getenv("PSX_TEST_USB");
    if (tu) list_dir(tu, 0);
    FILE *m = fopen("/proc/mounts", "r");
    char dev[256], mnt[512], fs[64];
    while (m && fscanf(m, "%255s %511s %63s %*[^\n]", dev, mnt, fs) == 3) {
        if (strcmp(fs, "vfat") && strcmp(fs, "exfat") && strcmp(fs, "ntfs") && strcmp(fs, "ntfs3") && strcmp(fs, "fuseblk")) continue;
        list_dir(mnt, 0);
    }
    if (m) fclose(m);
    send_line("{\"ev\":\"games\",\"dir\":\"%s\",\"games\":[%s]}", js(games), list_buf);
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

static void tone(void) {
    if (tone_pid > 0) return;
    if (running) { send_line("{\"ev\":\"tone\",\"ok\":true,\"text\":\"a game is running: its sound is the test\"}"); return; }
    if (snd_start(44100) < 0) { send_line("{\"ev\":\"tone\",\"ok\":false,\"text\":\"%s\"}", js(snd_state)); return; }
    int16_t buf[2 * 4410];
    for (int k = 0; k < 10; k++) {          /* 1 s of 440 Hz */
        for (int i = 0; i < 4410; i++) {
            int16_t v = (int16_t)(8000 * sin(2 * M_PI * 440 * (k * 4410 + i) / 44100.0));
            buf[2 * i] = buf[2 * i + 1] = v;
        }
        fcntl(snd_fd, F_SETFL, 0);
        ssize_t w = write(snd_fd, buf, sizeof buf);
        (void)w;
    }
    close(snd_fd); snd_fd = -1;
    int st = 0;
    pid_t r = waitpid(snd_pid, &st, 0);
    snd_pid = -1;
    int ok = r > 0 && WIFEXITED(st) && WEXITSTATUS(st) == 0;
    snprintf(snd_state, sizeof snd_state, ok ? "the test tone played through %s" : "%s failed (%s %d)", snd_name,
             WIFEXITED(st) ? "exit" : "signal", WIFEXITED(st) ? WEXITSTATUS(st) : WTERMSIG(st));
    send_line("{\"ev\":\"tone\",\"ok\":%s,\"text\":\"%s\"}", ok ? "true" : "false", js(snd_state));
}

/* ------------------------------------------------------------------ status */
static void status(void) {
    char padj[2048] = "";
    size_t n = 0;
    int k = 0;
    for (int i = 0; i < MAXPADS; i++) {
        if (pads[i].fd < 0) continue;
        n += snprintf(padj + n, sizeof padj - n, "%s{\"player\":%d,\"name\":\"%s\",\"via\":\"%s\"}", k++ ? "," : "", pad_port(i) + 1,
                      js(pads[i].name), pads[i].kind == K_EVDEV ? (pads[i].generic ? "evdev, no driver" : "evdev") : "raw reports");
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
    send_line("{\"ev\":\"status\",\"version\":\"%s\",\"running\":%s,\"paused\":%s,\"game\":\"%s\",\"fps\":%.2f,\"pads\":[%s],"
              "\"sound\":{\"player\":\"%s\",\"state\":\"%s\",\"pacat\":%s,\"aplay\":%s},"
              "\"bt\":{\"adapters\":%d,\"bluez\":%s,\"bluetoothctl\":%s,\"pairing\":%s},\"bios\":\"%s\",\"home\":\"%s\"}",
              VERSION, running ? "true" : "false", paused ? "true" : "false", js(game_name), fps, padj,
              js(snd_name), js(snd_state), find_prog("pacat") ? "true" : "false", find_prog("aplay") ? "true" : "false",
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
    else if (!strcmp(line, "pause")) { if (running) { paused = 1; if (hdr) hdr[7] = 1; card_save(0); } status(); }
    else if (!strcmp(line, "resume")) { if (running) { paused = 0; if (hdr) hdr[7] = 0; } status(); }
    else if (!strcmp(line, "reset")) { if (running) retro_reset(); status(); }
    else if (!strcmp(line, "pair")) pair_start();
    else if (!strcmp(line, "tone")) tone();
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
    mkdir(RUN, 0755); chmod(RUN, 0755);
    const char *sub[] = {"", "/games", "/bios", "/saves", NULL};
    for (int i = 0; sub[i]; i++) { snprintf(p, sizeof p, "%s%s", HOME, sub[i]); mkdir(p, 0755); }
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
    say("psx-core %s: socket %s, games in %s/games", VERSION, p, HOME);
    scan_pads();

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
        struct pollfd pf[2 + MAXPADS];
        int np = 0, map[MAXPADS];
        pf[np].fd = lfd; pf[np++].events = POLLIN;
        if (cfd >= 0) { pf[np].fd = cfd; pf[np++].events = POLLIN; }
        int base = np;
        for (int i = 0; i < MAXPADS; i++) if (pads[i].fd >= 0) { map[np - base] = i; pf[np].fd = pads[i].fd; pf[np++].events = POLLIN; }
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
            if (r <= 0) { close(cfd); cfd = -1; say("the app left"); if (running && !paused) { paused = 1; if (hdr) hdr[7] = 1; } }
            else {
                inlen += r; inbuf[inlen] = 0;
                char *s = inbuf, *nl;
                while ((nl = strchr(s, '\n'))) { *nl = 0; command(s); s = nl + 1; }
                inlen = strlen(s);
                memmove(inbuf, s, inlen + 1);
                if (inlen >= sizeof inbuf - 1) inlen = 0;
            }
        }
        for (int k = base; k < np; k++) {
            if (!(pf[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            pad_t *pd = &pads[map[k - base]];
            if (pd->fd < 0) continue;
            if (pd->kind == K_HIDRAW) read_hidraw(pd); else read_evdev(pd);
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
