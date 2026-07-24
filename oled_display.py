#!/usr/bin/env python3
"""
oled_display.py — WordLight OLED status display
=====================================================
Raspberry Pi 3B + SSD1315 (SSD1306-compatible) 128×64 I2C OLED + 4 buttons

Shows the server IP address and a scannable QR code for the current page.
Pressing K1 cycles through pages (Home, Reader, Backstage).
A short press of K4 wakes the screen; it auto-off after SCREEN_TIMEOUT
seconds. HOLDING K4 for 3 seconds reboots the whole Raspberry Pi — see
"Reboot setup" below, this requires a one-time sudoers configuration
step or it will fail with a clear error shown on the OLED itself.

── Libraries used ────────────────────────────────────────────────────────────

  lgpio      — Low-level GPIO access, used directly (not via gpiozero).
               Buttons are read with simple manual polling in the main loop
               rather than gpiozero's Button class, whose background alert
               thread was measured (via strace) making 1,400+ poll syscalls
               per second even while idle — the actual cause of this
               script's earlier high CPU usage. Manual polling at 20 Hz
               uses a tiny fraction of that.

  luma.oled  — I2C display driver for the SSD1306/SSD1315 OLED.

  qrcode     — Generates QR code bitmaps.

  Pillow     — 2D image drawing (PIL).

── Installation ─────────────────────────────────────────────────────────────

  1. Enable I2C:
       sudo raspi-config → Interface Options → I2C → Enable → reboot

  2. Verify display is detected (should show 3c or 3d):
       sudo i2cdetect -y 1

  3. Install packages:
       sudo apt-get update
       sudo apt-get install -y python3 python3-pip python3-pil i2c-tools python3-lgpio
       sudo pip3 install luma.oled "qrcode[pil]" --break-system-packages
       # Pillow is already on Raspberry Pi OS — no install needed

  4. Start alongside the server with pm2. Both this script and server.js
     are defined together in ecosystem.config.js (in the project root,
     alongside server.js) — one command starts both:
       pm2 start ecosystem.config.js
       pm2 save
     See README.md's "Run on Startup" and "Reducing SD Card Wear" sections
     for what that file sets up (including where logs are written).

── Reboot setup (required for holding K4 to work) ─────────────────────────────

  This script normally runs as a regular (non-root) user under pm2, which
  cannot reboot the system on its own — `sudo reboot` would otherwise sit
  waiting for a password that never comes, since nothing is there to type
  it. A one-time sudoers rule grants passwordless permission for ONLY the
  reboot command specifically — not broad sudo access — to whichever user
  actually runs this script (replace "wordlight" below if yours differs):

    sudo visudo -f /etc/sudoers.d/wordlight-reboot

  Add this single line, then save and exit (visudo checks the syntax
  before saving, so a typo here can't accidentally lock out sudo entirely):

    wordlight ALL=(ALL) NOPASSWD: /sbin/reboot

  If /sbin/reboot doesn't exist on your system, check with `which reboot`
  first and use whatever path it reports instead (commonly /usr/sbin/reboot
  on some distributions).

  Without this step, holding K4 for 3 seconds will show a clear
  "Reboot failed" message on the OLED rather than silently doing nothing —
  but the reboot itself won't actually happen until this is set up.

── GPIO pin notes ───────────────────────────────────────────────────────────

  Pin numbers below are BCM (the numbers on pinout diagrams, not the
  physical header positions). Adjust if your module uses different pins.

  Buttons are wired active-LOW: the Pi holds each pin HIGH internally
  (via SET_PULL_UP), and pressing the button connects it to GND, which
  we read as a 0.
"""

# ── Imports ───────────────────────────────────────────────────────────────────

import time        # used in the idle loop
import threading   # used for the screen-off countdown timer
import socket      # used to discover the Pi's own LAN IP address
import os          # used to read CPU load averages and /proc/meminfo
import subprocess  # used to query network interface addresses
import re          # used to parse iwconfig output for WiFi signal strength
import json         # used to build the JSON body for the metrics push
import urllib.request  # used to POST metrics to the local server — stdlib
import urllib.error    # only, no new pip dependency needed for this
import ssl              # used to skip certificate verification for the
                         # loopback-only metrics push — see LOOPBACK_SSL_CONTEXT
import signal      # used to identify exactly which signal causes a shutdown
import traceback   # used to print full tracebacks for silent/background errors

import qrcode
from PIL import Image, ImageDraw, ImageFont, ImageOps
from luma.core.interface.serial import i2c
from luma.oled.device import ssd1306

# ── GPIO access via lgpio directly ───────────────────────────────────────────
#
# We talk to the GPIO chip directly through the lgpio library rather than
# using gpiozero's Button class.
#
# Investigation found that gpiozero's Button — even with the lgpio pin
# factory selected — sets up a continuous background alert thread the moment
# the object is created. That thread was measured making over 1,400 ppoll()
# syscalls per second (via strace), regardless of whether a button was ever
# pressed. That constant syscall churn is what caused the sustained 4-6% CPU
# usage — it shows up as kernel (%system) time, not Python execution time,
# which is why profilers like py-spy (which only sees Python code) reported
# near-0% while system tools like pidstat correctly showed the real cost.
#
# The fix: poll each button's raw pin state ourselves, at a low, fixed
# frequency (BUTTON_POLL_INTERVAL, 20 times per second) inside the main loop.
# A 50ms response time is imperceptible for a physical button press, and
# 20 reads/sec is roughly 70x fewer syscalls than gpiozero's internal rate.
import lgpio


# ── GPIO Configuration ────────────────────────────────────────────────────────
# BCM pin numbers — adjust to match your module's schematic.

PIN_K1 = 17   # K1 — cycle to next display page
PIN_K2 = 27   # K2 — (reserved)
PIN_K3 = 22   # K3 — (reserved)
PIN_K4 = 16   # K4 — wake screen / reset sleep timer

BUTTON_POLL_INTERVAL = 0.05   # seconds between pin state checks (20 Hz)
BUTTON_DEBOUNCE      = 0.3    # seconds to ignore repeat triggers after a press

# How long K4 must be held down (continuously, without releasing) before
# it triggers a full system reboot. A quick tap still just wakes the
# screen as before — this only fires on a genuinely deliberate hold, so
# it can't happen from an accidental brush of the button.
HOLD_TO_REBOOT_SECONDS = 3


# ── Server Configuration ──────────────────────────────────────────────────────

def read_env_value(key_name, default):
    """
    Read a single KEY=VALUE from the caption server's .env file, so this
    script never needs its own hardcoded copy that can drift out of sync
    with the actual server. Used for both PORT and HTTPS_PORT below.

    Looks for a file named '.env' in the same directory as this script
    (oled_display.py and server.js are expected to live side by side).
    Parses simple 'KEY=VALUE' lines — good enough for the standard dotenv
    format used by server.js, including lines with '#' comments and quoted
    values. If the file is missing, unreadable, or has no matching line,
    falls back to 'default' silently.
    """
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                if key.strip() == key_name:
                    # Strip inline comments, surrounding quotes, and whitespace
                    value = value.split('#', 1)[0].strip().strip('"').strip("'")
                    if value.isdigit():
                        return int(value)
    except FileNotFoundError:
        pass   # no .env — use the default; this is normal if it was never customised
    except Exception as exc:
        print(f'[OLED] Could not read .env for {key_name} ({exc}) — using default {default}')
    return default


HTTPS_PORT     = read_env_value('HTTPS_PORT', default=3443)  # matches HTTPS_PORT in server's .env, if present
SCREEN_TIMEOUT = 30     # seconds before the screen auto-off

# server.js's certificate is self-signed (see its own setup notes for why —
# real CAs won't issue certs for private LAN IPs). This context skips
# verifying it, used ONLY for push_metrics_to_server()'s loopback call to
# https://localhost — safe there specifically because loopback traffic
# never leaves the Pi, so there's no network path for anything else to
# impersonate the server on. Never reused for any request that leaves
# the machine.
LOOPBACK_SSL_CONTEXT = ssl.create_default_context()
LOOPBACK_SSL_CONTEXT.check_hostname = False
LOOPBACK_SSL_CONTEXT.verify_mode = ssl.CERT_NONE

# How often to push CPU temp / IPs / WiFi signal to server.js for the
# pm2.io dashboard. These are slow-changing environmental values, so a
# 10-second cadence is plenty — no need for per-second resolution here,
# unlike the button-polling loop this shares a thread with.
METRICS_PUSH_INTERVAL = 10


# ── Display Configuration ─────────────────────────────────────────────────────

I2C_ADDRESS = 0x3C   # change to 0x3D if the screen stays blank
I2C_PORT    = 1      # I2C bus (almost always 1 on a Pi)
DISP_WIDTH  = 128
DISP_HEIGHT = 64


# ── Pages ─────────────────────────────────────────────────────────────────────
# (label shown on screen, URL route). K1 cycles through these in order.

PAGES = [
    ('Home',      'home'),
    ('Reader',    'reader'),
    ('Backstage', 'backstage'),
    ('Network',   None),    # None = no URL/QR; shows both IP addresses
    ('Stats',     None),    # None = no URL/QR; shows CPU/RAM/temp
]


# ── Global State ──────────────────────────────────────────────────────────────

current_page = 0
screen_on    = True
sleep_timer  = None
device       = None
cached_ip    = None


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — IP ADDRESS DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

def get_interface_ips():
    """
    Return a dict of IPv4 addresses for the Pi's two main network interfaces.

      {'wlan0': '192.168.1.100', 'eth0': '10.0.0.42'}

    Any interface that is down or has no IPv4 address is omitted from the dict.

    How it works:
      Runs 'ip -4 addr show <interface>' for each interface and parses the
      'inet x.x.x.x/prefix' line. The 'ip' command is part of iproute2 which
      is installed on all Raspberry Pi OS builds.
    """
    ips = {}
    for iface in ('wlan0', 'eth0'):
        try:
            result = subprocess.run(
                ['ip', '-4', 'addr', 'show', iface],
                capture_output=True, text=True, timeout=2
            )
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.startswith('inet '):
                    # Line format: "inet 192.168.1.100/24 brd ..."
                    ips[iface] = line.split()[1].split('/')[0]
                    break
        except Exception:
            pass
    return ips


def get_local_ip():
    """
    Return the single best IP address for use in QR code URLs.

    Preference order: eth0 → wlan0 → UDP socket fallback → 127.0.0.1
    Ethernet is preferred as it is the primary network interface on this server.
    Result is cached after the first successful call.
    """
    global cached_ip
    if cached_ip:
        return cached_ip

    ips = get_interface_ips()
    if 'eth0' in ips:
        cached_ip = ips['eth0']
    elif 'wlan0' in ips:
        cached_ip = ips['wlan0']
    else:
        # Last resort — ask the OS which interface it would use to reach the internet
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            cached_ip = s.getsockname()[0]
            s.close()
        except Exception:
            cached_ip = '127.0.0.1'

    return cached_ip


def get_wifi_signal(interface='wlan0'):
    """
    Return WiFi signal strength as (signal_dbm, link_quality_pct), or
    (None, None) if unavailable (no WiFi interface, not connected, etc.).

    Tries two methods, in order of preference:

      1. /proc/net/wireless — a kernel-provided file, read directly with no
         subprocess spawned. Fastest and most reliable option; works on
         every Linux system with a wireless interface, regardless of which
         higher-level tools (iwconfig, iw, NetworkManager) are installed.

      2. `iwconfig <interface>` — used as a fallback if the proc file is
         ever missing or its format doesn't parse as expected. Confirmed
         working on this project's target hardware.

    Both were confirmed working via manual testing before this was written,
    rather than assumed — see the /proc/net/wireless format note below,
    since its columns are fixed-width and easy to misparse.
    """
    # ── Method 1: /proc/net/wireless ──────────────────────────────────────────
    #
    # Format (header row, then one row per interface):
    #   Inter-| sta-|   Link quality        |   Level    Noise |  ...
    #    face | tus |                        |    dBm      dBm |  ...
    #   wlan0: 0000   51.  -59.  -256    0      0      0      0 ...
    #
    # Note the trailing '.' after link quality and signal level — an
    # artifact of this file's fixed-width formatting, not decimal points;
    # stripped below before converting to a number.
    try:
        with open('/proc/net/wireless') as f:
            for line in f:
                line = line.strip()
                if line.startswith(interface + ':'):
                    fields = line.split(':', 1)[1].split()
                    # fields[0]=status, [1]=link quality, [2]=signal level (dBm)
                    link_quality_raw = float(fields[1].rstrip('.'))
                    signal_dbm       = float(fields[2].rstrip('.'))
                    # Raw link quality is typically on a 0–70 scale — convert
                    # to a percentage so it means the same thing regardless
                    # of which method (this one or iwconfig) supplied it.
                    quality_pct = round(100 * link_quality_raw / 70)
                    return int(signal_dbm), quality_pct
    except Exception:
        pass   # fall through to method 2

    # ── Method 2: iwconfig <interface> ────────────────────────────────────────
    #
    # Example relevant output line:
    #   Link Quality=51/70  Signal level=-59 dBm
    try:
        result = subprocess.run(
            ['iwconfig', interface],
            capture_output=True, text=True, timeout=2
        )
        output = result.stdout
        quality_match = re.search(r'Link Quality=(\d+)/(\d+)', output)
        signal_match  = re.search(r'Signal level=(-?\d+)\s*dBm', output)

        signal_dbm = int(signal_match.group(1)) if signal_match else None
        quality_pct = None
        if quality_match:
            num, den = int(quality_match.group(1)), int(quality_match.group(2))
            quality_pct = round(100 * num / den) if den else None

        if signal_dbm is not None:
            return signal_dbm, quality_pct
    except Exception:
        pass

    return None, None   # neither method worked — no WiFi, or not connected


def push_metrics_to_server():
    """
    POST current environmental stats (CPU temp, network IPs, WiFi signal) to
    server.js, which exposes them as pm2.io custom metrics — the same
    mechanism already used for Connected Readers, Current Line, etc. This
    keeps ALL pm2.io metric definitions in one place (server.js) rather than
    needing a second, separate integration just for this script, and avoids
    adding any new pip dependency (uses only Python's built-in urllib).

    Uses HTTPS with certificate verification turned OFF. server.js's
    certificate is self-signed (see its own setup notes for why), and
    Python's urllib validates certificates by default the same way a
    browser does — which would otherwise reject our own server's cert here.
    Disabling verification is safe specifically because this request never
    leaves the Pi: it's a loopback call to https://localhost, so there's no
    network path for anyone else to impersonate the server on.

    Errors are caught and logged, never raised — a failed metrics push
    (server briefly restarting, network hiccup) must never crash the OLED
    script, whose main job (display + buttons) has nothing to do with this.
    """
    try:
        stats = get_system_stats()
        ips = get_interface_ips()
        signal_dbm, quality_pct = get_wifi_signal()

        payload = json.dumps({
            'cpuTempC':        stats.get('temp_c'),
            'wifiIp':          ips.get('wlan0'),
            'ethIp':           ips.get('eth0'),
            'wifiSignalDbm':   signal_dbm,
            'wifiQualityPct':  quality_pct,
        }).encode('utf-8')

        req = urllib.request.Request(
            f'https://localhost:{HTTPS_PORT}/api/oled-metrics',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        urllib.request.urlopen(req, timeout=3, context=LOOPBACK_SSL_CONTEXT)

    except Exception as exc:
        # Common during normal operation (e.g. server.js mid-restart) —
        # log quietly rather than treating this as a real error.
        print(f'[OLED] Metrics push failed (will retry in {METRICS_PUSH_INTERVAL}s): {exc}')




def make_qr(url, size):
    """
    Generate a QR code for url and return it as a 1-bit PIL Image at size×size.

    Error correction level L (lowest) is used because it produces the fewest
    modules, keeping the code as large as possible at 60×60 px.
    NEAREST-neighbour resize preserves the hard black/white edges.
    """
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=0,
    )
    qr.add_data(url)
    qr.make(fit=True)
    # Use explicit colour strings so Pillow gets full 0–255 RGB values.
    # "black" on "white" is the standard QR format; we then invert it
    # so the modules appear as lit (white) pixels on the OLED's black background.
    img = qr.make_image(fill_color="black", back_color="white").convert('L')
    img = ImageOps.invert(img).convert('1')
    return img.resize((size, size), Image.NEAREST)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — DISPLAY RENDERING
# ═══════════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3a — SYSTEM STATS (for the Stats page)
# ═══════════════════════════════════════════════════════════════════════════════

def get_system_stats():
    """
    Read and return live system statistics from the Pi's kernel interfaces.
    No third-party packages needed — everything comes from built-in sources.

    Returns a dict with keys:
      load1, load5, load15  — CPU load averages over 1, 5, and 15 minutes.
                              A value of 1.0 means one full CPU core is busy.
                              Pi 3B has 4 cores, so <4.0 is generally healthy.
      mem_used_mb           — RAM currently in use, in megabytes.
      mem_total_mb          — Total installed RAM, in megabytes.
      temp_c                — CPU temperature in degrees Celsius.
    """
    # ── CPU load averages ─────────────────────────────────────────────────────
    # os.getloadavg() reads /proc/loadavg — a kernel file that the OS updates
    # every 5 seconds. Returns a tuple of three floats.
    load1, load5, load15 = os.getloadavg()

    # ── RAM usage from /proc/meminfo ──────────────────────────────────────────
    # /proc/meminfo lists many memory counters in kilobytes.
    # 'MemAvailable' is the most accurate measure of free RAM — it accounts for
    # cache and buffers that the OS can reclaim, unlike 'MemFree' which ignores them.
    mem_total_kb = mem_available_kb = 0
    try:
        with open('/proc/meminfo') as f:
            for line in f:
                if line.startswith('MemTotal:'):
                    mem_total_kb = int(line.split()[1])
                elif line.startswith('MemAvailable:'):
                    mem_available_kb = int(line.split()[1])
                if mem_total_kb and mem_available_kb:
                    break   # found both — no need to read further
    except Exception:
        pass
    mem_used_mb  = (mem_total_kb - mem_available_kb) // 1024
    mem_total_mb = mem_total_kb // 1024

    # ── CPU temperature ───────────────────────────────────────────────────────
    # /sys/class/thermal/thermal_zone0/temp reports the temperature in
    # millidegrees Celsius (e.g. 52400 = 52.4°C). We divide by 1000.
    # Falls back to vcgencmd (Raspberry Pi firmware tool) if the sysfs file
    # is unavailable for any reason.
    temp_c = 0.0
    try:
        with open('/sys/class/thermal/thermal_zone0/temp') as f:
            temp_c = int(f.read().strip()) / 1000.0
    except Exception:
        try:
            import subprocess
            result = subprocess.run(
                ['vcgencmd', 'measure_temp'],
                capture_output=True, text=True, timeout=2
            )
            # output format: "temp=52.4'C"
            temp_c = float(result.stdout.strip().replace("temp=", "").replace("'C", ""))
        except Exception:
            pass

    return {
        'load1':        load1,
        'load5':        load5,
        'load15':       load15,
        'mem_used_mb':  mem_used_mb,
        'mem_total_mb': mem_total_mb,
        'temp_c':       temp_c,
    }


def build_network_frame():
    """
    Full-width network info page showing both WiFi and Ethernet addresses.

    Uses the full 128×64 canvas — no QR code column on this page.
    Reads IPs fresh every time the page is drawn so it reflects any
    reconnection that happened while a different page was showing.

    Layout:
      ┌──────────────────────────────────────────────┐
      │ Network Info                                 │
      │ ─────────────────────────────────────────── │
      │ WiFi  192.168.1.100                         │
      │       (or "not connected")                  │
      │ Eth   10.0.0.42                             │
      │       (or "not connected")                  │
      │ Port  3000                                  │
      └──────────────────────────────────────────────┘

    The default PIL font is ~6px per character, giving ~21 chars per line
    at full width — enough for a complete IPv4 address with a short label.
    """
    canvas = Image.new('1', (DISP_WIDTH, DISP_HEIGHT), 0)
    draw   = ImageDraw.Draw(canvas)
    font   = ImageFont.load_default()

    # Read IPs fresh — not cached — so this page is always current
    ips = get_interface_ips()
    wifi_ip = ips.get('wlan0', None)
    eth_ip  = ips.get('eth0',  None)

    # Title and divider
    draw.text((2, 1), 'Network Info', font=font, fill=1)
    draw.line([(0, 11), (DISP_WIDTH - 1, 11)], fill=1)

    # WiFi row — label on line 1, IP on same line, "not connected" if absent
    draw.text((2, 14), 'WiFi', font=font, fill=1)
    if wifi_ip:
        draw.text((32, 14), wifi_ip, font=font, fill=1)
    else:
        draw.text((32, 14), 'not connected', font=font, fill=1)

    # Ethernet row
    draw.text((2, 28), 'Eth', font=font, fill=1)
    if eth_ip:
        draw.text((32, 28), eth_ip, font=font, fill=1)
    else:
        draw.text((32, 28), 'not connected', font=font, fill=1)

    # Port reminder
    draw.text((2, 42), 'Port', font=font, fill=1)
    draw.text((32, 42), str(HTTPS_PORT), font=font, fill=1)

    # Small hint at bottom
    draw.text((2, 55), 'K1: next page', font=font, fill=1)

    return canvas


def build_stats_frame():
    """
    Build a full-width 128×64 stats display — no QR code on this page.

    Layout (each text row is ~10px tall, default PIL font ~6px per char):

      ┌──────────────────────────────────────────────┐
      │ System Stats                                 │
      │ ─────────────────────────────────────────── │
      │ Load: 0.12  0.34  0.56                      │
      │       1min  5min  15min                     │
      │ RAM:  234 / 926 MB  (25%)                   │
      │ Temp: 52.4 C                                │
      └──────────────────────────────────────────────┘
    """
    canvas = Image.new('1', (DISP_WIDTH, DISP_HEIGHT), 0)
    draw   = ImageDraw.Draw(canvas)
    font   = ImageFont.load_default()

    s = get_system_stats()

    # Title
    draw.text((2, 1), 'System Stats', font=font, fill=1)
    draw.line([(0, 11), (DISP_WIDTH - 1, 11)], fill=1)

    # CPU load averages — values on one line, labels on the next
    draw.text((2,  14), 'Load:', font=font, fill=1)
    draw.text((38, 14), f'{s["load1"]:.2f}', font=font, fill=1)
    draw.text((68, 14), f'{s["load5"]:.2f}', font=font, fill=1)
    draw.text((98, 14), f'{s["load15"]:.2f}', font=font, fill=1)
    draw.text((38, 23), '1min', font=font, fill=1)
    draw.text((68, 23), '5min', font=font, fill=1)
    draw.text((98, 23), '15m', font=font, fill=1)

    # RAM — used / total with percentage
    if s['mem_total_mb'] > 0:
        pct = int(s['mem_used_mb'] / s['mem_total_mb'] * 100)
        ram_str = f'{s["mem_used_mb"]}/{s["mem_total_mb"]}MB {pct}%'
    else:
        ram_str = 'unavailable'
    draw.text((2, 35), 'RAM:', font=font, fill=1)
    draw.text((32, 35), ram_str, font=font, fill=1)

    # CPU temperature — degree symbol is ASCII 176
    draw.text((2, 47), f'Temp: {s["temp_c"]:.1f}\xb0C', font=font, fill=1)

    return canvas


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3b — FRAME DISPATCHER
# ═══════════════════════════════════════════════════════════════════════════════

def build_frame():
    """
    Dispatcher — returns the correct PIL Image for the current page.
    Pages with route=None are local-only and get their own renderer.
    The label is used to pick which renderer to call.
    All other pages use the standard QR + info layout.
    """
    label, route = PAGES[current_page]
    if route is None:
        if label == 'Network':
            return build_network_frame()
        return build_stats_frame()
    return build_qr_frame(route)


def build_reboot_countdown_frame(seconds_held, seconds_required):
    """
    Shown while K4 is being held down, before the reboot threshold is
    reached. Gives clear, live feedback that a hold is in progress and how
    much longer it needs to continue — so releasing early to cancel is an
    obvious, low-friction option rather than a guess.
    """
    canvas = Image.new('1', (DISP_WIDTH, DISP_HEIGHT), 0)
    draw   = ImageDraw.Draw(canvas)
    font   = ImageFont.load_default()

    seconds_left = max(0, seconds_required - seconds_held)

    draw.text((2, 4), 'Hold to reboot...', font=font, fill=1)

    # Big countdown number, roughly centred
    big_text = str(int(seconds_left) + 1)  # +1 so it reads 3,2,1 not 2,1,0
    draw.text((DISP_WIDTH // 2 - 6, 22), big_text, font=font, fill=1)

    # Simple progress bar across the bottom
    bar_w = DISP_WIDTH - 20
    bar_x = 10
    bar_y = 48
    progress = min(1.0, seconds_held / seconds_required)
    draw.rectangle([bar_x, bar_y, bar_x + bar_w, bar_y + 8], outline=1, fill=0)
    draw.rectangle([bar_x, bar_y, bar_x + int(bar_w * progress), bar_y + 8], outline=1, fill=1)

    draw.text((2, 58), 'Release to cancel', font=font, fill=1)
    return canvas


def build_rebooting_frame():
    """
    Shown for a brief moment right before the reboot command actually
    runs — final, unambiguous confirmation that it's happening, since the
    screen will go dark shortly after as the whole system shuts down.
    """
    canvas = Image.new('1', (DISP_WIDTH, DISP_HEIGHT), 0)
    draw   = ImageDraw.Draw(canvas)
    font   = ImageFont.load_default()

    draw.text((30, 26), 'Rebooting...', font=font, fill=1)
    draw.text((14, 40), 'Back in a moment', font=font, fill=1)
    return canvas


def build_qr_frame(route):
    """
    Build the standard QR + info layout for server pages (Home, Reader, Backstage).

    Layout — split at x=64 by a vertical line:

      Left (0–63) : 60×60 QR code, centred vertically
      Right (66–127): page label, IP, port/route, scan hint

      ┌────────────────────────────────────────────────┐
      │                  │ <label>                     │
      │  QR code (60×60) │ ──────────────────          │
      │                  │ 192.168.x.y                 │
      │                  │ :3000/home                  │
      │                  │                             │
      │                  │ Scan → QR                   │
      └────────────────────────────────────────────────┘

    Long IPs (>11 chars) are split at the last-octet boundary across two lines.
    """
    canvas = Image.new('1', (DISP_WIDTH, DISP_HEIGHT), 0)
    draw   = ImageDraw.Draw(canvas)
    font   = ImageFont.load_default()

    ip    = get_local_ip()
    label = PAGES[current_page][0]
    url   = f'https://{ip}:{HTTPS_PORT}/{route}'

    # Left column — QR code
    qr_size = 60
    qr_x    = 2
    qr_y    = (DISP_HEIGHT - qr_size) // 2
    canvas.paste(make_qr(url, qr_size), (qr_x, qr_y))

    # Vertical divider
    draw.line([(64, 0), (64, DISP_HEIGHT - 1)], fill=1)

    # Right column — text
    x = 66
    draw.text((x, 1), label, font=font, fill=1)
    draw.line([(x, 11), (DISP_WIDTH - 2, 11)], fill=1)

    if len(ip) > 11:
        split = ip.rfind('.', 0, -4)
        draw.text((x, 14), ip[:split + 1], font=font, fill=1)
        draw.text((x, 24), ip[split + 1:], font=font, fill=1)
        text_y = 34
    else:
        draw.text((x, 14), ip, font=font, fill=1)
        text_y = 24

    draw.text((x, text_y),      f':{HTTPS_PORT}', font=font, fill=1)
    draw.text((x, text_y + 10), f'/{route}',       font=font, fill=1)
    draw.text((x, 54),          'Scan \u2192 QR',  font=font, fill=1)

    return canvas


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — SCREEN POWER MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

def cancel_timer():
    """Cancel the pending sleep timer if one is running."""
    global sleep_timer
    if sleep_timer and sleep_timer.is_alive():
        sleep_timer.cancel()
    sleep_timer = None


def arm_timer():
    """Start (or restart) the SCREEN_TIMEOUT countdown."""
    global sleep_timer
    cancel_timer()
    sleep_timer = threading.Timer(SCREEN_TIMEOUT, do_sleep)
    sleep_timer.daemon = True
    sleep_timer.start()


def do_sleep():
    """
    Called when the sleep timer fires. Blanks the display.

    This runs on a background Timer thread, not the main thread. If
    device.hide() were to raise an exception here, Python would normally
    just print a traceback from the background thread and otherwise
    continue silently — it would NOT explain a full process restart.
    The try/except below makes any such failure loud and visible in the
    logs instead of possibly being swallowed, so we can rule this out
    (or catch it) while diagnosing the restart issue.
    """
    global screen_on
    try:
        screen_on = False
        device.hide()   # turns off pixels; content stays in OLED RAM
        print('[OLED] Screen off (timeout)')
    except Exception:
        print('[OLED] ERROR in do_sleep():')
        traceback.print_exc()


def wake():
    """Turn the display back on, redraw, and restart the sleep countdown."""
    global screen_on
    screen_on = True
    device.show()
    refresh()
    arm_timer()
    print('[OLED] Screen on')


def refresh():
    """Redraw the current page. Does nothing if the screen is off."""
    if screen_on and device:
        device.display(build_frame())


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — BUTTON CALLBACKS
# ═══════════════════════════════════════════════════════════════════════════════
#
# These functions are called from the manual polling loop in main() when a
# HIGH→LOW transition (button press) is detected on the corresponding pin.
# Debouncing is handled in the polling loop via BUTTON_DEBOUNCE, not here.

def on_k1():
    """
    K1 — cycle to the next display page.
    If the screen is off, the first press wakes it without advancing the page.
    """
    global current_page
    if not screen_on:
        wake()
        return
    current_page = (current_page + 1) % len(PAGES)
    print(f'[OLED] Page → {PAGES[current_page][0]}')
    refresh()
    arm_timer()


def on_k4():
    """
    K4 short press — wake the screen, or reset the sleep timer if already
    on. The reboot behaviour lives separately in the main loop's hold-
    detection logic below, not here — this function only ever handles a
    normal, quick tap.
    """
    if screen_on:
        arm_timer()
    else:
        wake()


def trigger_reboot():
    """
    Called once, the moment K4 has been held for HOLD_TO_REBOOT_SECONDS.
    Shows a final confirmation screen, gives the OLED a moment to actually
    finish drawing it (I2C writes take a small but nonzero amount of time,
    and the whole system is about to go down), then runs the reboot itself.

    Requires passwordless sudo access to the reboot command specifically —
    see the setup note in this file's top docstring. If that hasn't been
    configured yet, the failure is shown directly on the OLED rather than
    failing silently, so it's obvious what still needs to be set up.
    """
    print('[OLED] K4 held for 3s — rebooting the Pi now')
    device.show()
    device.display(build_rebooting_frame())
    time.sleep(1.2)   # let the display actually finish rendering before the system goes down

    try:
        subprocess.run(['sudo', '/sbin/reboot'], check=True, timeout=10)
    except Exception as exc:
        print(f'[OLED] Reboot command failed: {exc}')
        canvas = Image.new('1', (DISP_WIDTH, DISP_HEIGHT), 0)
        draw   = ImageDraw.Draw(canvas)
        font   = ImageFont.load_default()
        draw.text((2, 10),  'Reboot failed:',        font=font, fill=1)
        draw.text((2, 24),  'sudo not configured?',  font=font, fill=1)
        draw.text((2, 38),  'See file header for',   font=font, fill=1)
        draw.text((2, 48),  'sudoers setup steps.',  font=font, fill=1)
        device.display(canvas)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — STARTUP AND MAIN LOOP
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    global device
    global screen_on

    # ── Initialise OLED ───────────────────────────────────────────────────────
    try:
        serial = i2c(port=I2C_PORT, address=I2C_ADDRESS)
        device = ssd1306(serial, width=DISP_WIDTH, height=DISP_HEIGHT)
    except Exception as exc:
        print(f'[OLED] Failed to open display at 0x{I2C_ADDRESS:02X}: {exc}')
        print('[OLED] Check I2C is enabled (sudo raspi-config) and wiring.')
        print('[OLED] Run: sudo i2cdetect -y 1   to list detected devices.')
        return

    # ── Initialise buttons via direct lgpio polling ──────────────────────────
    #
    # We open the GPIO chip once and claim K1 and K4 as inputs with the
    # internal pull-up resistor enabled. Buttons read HIGH (1) when not
    # pressed and LOW (0) when pressed (pulled to ground).
    #
    # No callback/alert mechanism is set up here — we deliberately poll the
    # raw pin values ourselves in the main loop below at a fixed, low rate.
    # This avoids gpiozero's internal alert thread, which was found (via
    # strace) to poll at 1,400+ times per second even while idle.
    gpio_chip = lgpio.gpiochip_open(0)
    lgpio.gpio_claim_input(gpio_chip, PIN_K1, lgpio.SET_PULL_UP)
    lgpio.gpio_claim_input(gpio_chip, PIN_K4, lgpio.SET_PULL_UP)

    ip = get_local_ip()
    print(f'[OLED] Ready — IP: {ip}  Port: {HTTPS_PORT} (https)')
    print(f'[OLED] Showing: {PAGES[current_page][0]}')
    print(f'[OLED] K1 = cycle pages   K4 = wake screen (hold 3s = reboot Pi)')
    print(f'[OLED] Polling buttons at {1 / BUTTON_POLL_INTERVAL:.0f} Hz (low-CPU mode)')

    refresh()
    arm_timer()
    threading.Thread(target=push_metrics_to_server, daemon=True).start()

    # ── Idle loop with manual button polling ─────────────────────────────────
    #
    # Reads both button pins every BUTTON_POLL_INTERVAL seconds (default
    # 50 ms = 20 times/sec). A press is detected as a HIGH→LOW transition
    # (previous reading was 1, current reading is 0). BUTTON_DEBOUNCE
    # ignores further presses on the same pin for a short window afterward,
    # matching the mechanical switch debounce behaviour we had with gpiozero.
    #
    # Catching Exception (not just KeyboardInterrupt) means that if the loop
    # is ever broken by something unexpected, it gets logged with a full
    # traceback instead of failing silently.
    last_k1_state = 1   # 1 = not pressed (pulled HIGH)
    last_k4_state = 1
    last_k1_time  = 0.0
    last_k4_time  = 0.0
    last_metrics_push = 0.0   # time.monotonic() of the last metrics push

    # K4 hold-to-reboot state — see trigger_reboot() and
    # build_reboot_countdown_frame() above for the rest of this feature.
    k4_press_started_at   = None   # monotonic time K4 was first pressed, or None
    k4_reboot_triggered   = False  # guards against firing trigger_reboot() twice
    k4_last_shown_second  = None   # avoids redrawing the countdown 20x/sec

    try:
        while True:
            now = time.monotonic()

            k1_state = lgpio.gpio_read(gpio_chip, PIN_K1)
            if k1_state == 0 and last_k1_state == 1 and (now - last_k1_time) > BUTTON_DEBOUNCE:
                last_k1_time = now
                on_k1()
            last_k1_state = k1_state

            k4_state = lgpio.gpio_read(gpio_chip, PIN_K4)

            # Press started (edge HIGH -> LOW)
            if k4_state == 0 and last_k4_state == 1 and (now - last_k4_time) > BUTTON_DEBOUNCE:
                k4_press_started_at  = now
                k4_reboot_triggered  = False
                k4_last_shown_second = None
                # Make sure the countdown is actually visible even if the
                # screen happened to be asleep when the hold began —
                # otherwise holding K4 from an off-screen state gives no
                # feedback at all until the reboot threshold is reached.
                if not screen_on:
                    screen_on = True
                    device.show()

            # Still held — check hold duration every tick
            if k4_state == 0 and k4_press_started_at is not None and not k4_reboot_triggered:
                held = now - k4_press_started_at
                if held >= HOLD_TO_REBOOT_SECONDS:
                    k4_reboot_triggered = True
                    trigger_reboot()
                else:
                    # Only redraw when the displayed whole-second count
                    # actually changes — no need to hit the I2C display
                    # 20 times a second for a number that only changes
                    # once a second.
                    whole_second = int(held)
                    if whole_second != k4_last_shown_second:
                        k4_last_shown_second = whole_second
                        device.display(build_reboot_countdown_frame(held, HOLD_TO_REBOOT_SECONDS))

            # Released (edge LOW -> HIGH)
            if k4_state == 1 and last_k4_state == 0:
                last_k4_time = now
                if not k4_reboot_triggered:
                    # Released before reaching the threshold — either a
                    # normal short tap, or a hold that was cancelled by
                    # letting go early. Either way, treat it as the usual
                    # short-press action and restore the real page,
                    # clearing away the countdown that was on screen.
                    on_k4()
                    refresh()
                k4_press_started_at = None

            last_k4_state = k4_state

            # Push environmental metrics on a background thread, never
            # inline here — push_metrics_to_server() makes a network call
            # with up to a 3s timeout, and this loop's whole job is snappy
            # button response at 20Hz. A thread means a slow/stuck request
            # can never delay a button press being noticed. Updating
            # last_metrics_push BEFORE the thread finishes (not after)
            # prevents spawning overlapping pushes if one call runs long.
            if now - last_metrics_push >= METRICS_PUSH_INTERVAL:
                last_metrics_push = now
                threading.Thread(target=push_metrics_to_server, daemon=True).start()

            time.sleep(BUTTON_POLL_INTERVAL)
    except KeyboardInterrupt:
        print('[OLED] Shutting down (signal)')
    except Exception:
        print('[OLED] Shutting down (unexpected error in idle loop):')
        traceback.print_exc()
    finally:
        cancel_timer()
        device.hide()
        device.cleanup()
        lgpio.gpiochip_close(gpio_chip)


if __name__ == '__main__':
    main()
