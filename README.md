# 🔦 WordLight

A self-hosted, real-time closed caption relay server for live theater, designed
to run on a Raspberry Pi. A **Controller** navigates a script; **Readers** on
audience members' phones see each line instantly, making performances
accessible to hard-of-hearing patrons.

WordLight is free and open for any theater to use. Everything shown to your
audience — the theater name, colors, and logo — is fully configurable per
installation (see [Branding your installation](#branding-your-installation)
below); nothing in this project is tied to any specific venue.

**Version 0.9.3.** What changed, version by version: `CHANGES.md`.

**New to this?** [GETTING_STARTED.md](GETTING_STARTED.md) walks through
everything from the shopping list to the first show, with no Linux
knowledge needed.

---

## Pages

| URL | Description | Auth? |
|-----|-------------|-------|
| `/home` | Home page — QR code, server status, links to all pages | No |
| `/reader` | Audience caption display | No |
| `/backstage` | Actor monitor — shows current line, note, and next few lines | No |
| `/preferences` | Reader display settings (font, size, colors) | No |
| `/help` | Script conventions, keyboard shortcuts, OSC commands | No |
| `/controller` | Load script, navigate lines, live type, intermission | ✅ Yes |
| `/editor` | Caption script editor | ✅ Admin or editor login |
| `/logging` | Unique reader usage stats | ✅ Yes |
| `/login` | Admin sign-in | — |

### API Endpoints

| URL | Description | Auth? |
|-----|-------------|-------|
| `/api/state` | Current caption state (JSON) | No |
| `/api/qr` | QR code PNG for the reader URL | No |
| `/api/auth/status` | Returns `{authenticated: true/false}` for the current session | No |
| `/api/log` | Reader session statistics | ✅ Yes |
| `/api/log/export` | Download session log as CSV | ✅ Yes |
| `/api/log/reset` | Clear session counters | ✅ Yes |
| `/api/scripts` | List a folder in the Scripts folder (`?folder=Season 26`) | ✅ Admin or editor login |
| `/api/scripts/file` | Open (`GET ?path=…`) or save (`POST ?folder=…&name=…&base=…`, text body) a caption file | ✅ Admin or editor login |
| `/api/connections` | `{controllers, readers, backstage}` connected now — for the Script Converter on the same Pi; also answered on the plain-http `PORT` | Pi itself only |
| `/api/check-admin` | `POST {password}` → `{ok}`: is this the admin (CC Server) password? For the Script Converter's bypass; wrong answers wait 1 s, 5 wrong in 15 min lock it; never the default password; also on the plain-http `PORT` | Pi itself only |
| `/api/converter-link` | `{available, scheme, port}`: is the Script Converter running on this computer, and where? For the home page's **Script Converter** button. Asks the converter at most every 30 s | No |

---

## npm Packages

All dependencies are listed in `package.json` and installed with `npm install`.

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^5.2.1 | HTTP server and routing |
| `socket.io` | ^4.8.3 | Real-time WebSocket events |
| `cookie-session` | ^2.1.1 | Session management |
| `cookie-parser` | ^1.4.7 | Cookie parsing middleware |
| `dotenv` | ^16.3.1 | Load config from `.env` file |
| `qrcode` | ^1.5.3 | Generate QR code PNG for the home page |
| `@pm2/io` | ^6.1.0 | Custom metrics for the pm2.io dashboard |

> **OSC support** uses Node's built-in `dgram` module — no extra package required.
>
> **HTTPS** uses Node's built-in `https` module and generates its own certificate
> with `openssl` — no extra package required.

### A note on versions

`express` is on the **5.x** line. Express 4 entered maintenance-only status in
April 2025 with end-of-life targeted from October 2026, so new installs should be
on 5.x. Express 5 requires Node 18 or newer, comfortably below this project's
minimum of Node 22.

Run `npm audit` after installing. If it reports vulnerabilities, `npm audit fix`
will usually resolve them — they're typically in transitive dependencies (packages
pulled in by the ones above) rather than anything listed here.

---

## Hardware requirements

One small computer runs the whole show; the audience uses their own phones.
For most theaters the real limits are the Wi-Fi and, if you use it, the
Script Converter, not the computer.

| | Minimum | Used at Des Moines Community Playhouse |
|---|---|---|
| **Computer** | Raspberry Pi 3 (any model) or newer, or any 64-bit Intel/AMD or ARM computer | Raspberry Pi 3 Model B |
| **Memory** | 1 GB | 1 GB |
| **Operating system** | A **64-bit** Linux: Raspberry Pi OS Lite (64-bit), Debian or Ubuntu | 64-bit Debian 13 "Trixie" |
| **Storage** | 8 GB microSD card (Raspberry Pi OS Lite takes about 3 GB) | |
| **Network** | Ethernet to a Wi-Fi router or access point (see below) | |
| **Power (Pi)** | The right supply: 5 V at 2.5 A for a Pi 3, 3 A for a Pi 4, 5 A for a Pi 5 | Pi 3 underclocked to 600 MHz, on a UPS |

**How much it has been tested with:** the Pi 3 at Des Moines Community
Playhouse, slowed to 600 MHz for a weak power supply, handled 100 simulated audience phones in the
load test with no problems and no memory growth. Larger audiences haven't
been tested yet. Before a big show, run `load-test/` with the number of
phones you expect (see `load-test/README.md`). On a 1 GB test computer,
WordLight, the Script Converter (idle) and the network shares together
still left about 630 MB of the memory free.

**Why 64-bit, and why a Pi 3 or newer:** current Node.js (version 24, which
the setup script installs) no longer comes in a 32-bit ARM version, and
Node 22, the last one that does, gets updates only until April 2027. The
64-bit Raspberry Pi OS runs on the Pi 3, 3A+, 3B+, 4, 400, 5, 500 and Zero
2 W. The Pi 1, Pi 2, Zero and Zero W only run the 32-bit system, so they
can't run WordLight.

- **512 MB boards** (Pi 3A+, Zero 2 W) will probably run WordLight alone,
  but that hasn't been tested, and they're too small for the Script
  Converter. Neither has an Ethernet socket.
- **Other computers:** an old laptop or mini PC with a 64-bit Intel/AMD or
  ARM processor works too (everything except the OLED display, which needs
  a Pi). The setup script needs Debian or Ubuntu; it has been tested on
  Ubuntu 24.04.
- **A Mac** has run WordLight for a whole show run: a 2017 MacBook Air
  (1.8 GHz Core i5, 8 GB) on macOS 12, lid open with the screen brightness
  turned down, and `caffeinate -d` running in Terminal so it never went to
  sleep. On a Mac, follow the Quick Start below by hand; the setup script,
  network shares and offline caption network are Linux-only. Node.js 24
  officially needs macOS 13.5 or newer, though it also runs on that Mac's
  macOS 12.7.6; Node 22 supports macOS 11 or newer, until April 2027.
- **Windows** hasn't been tried. Node.js runs there (Windows 10 or newer),
  but Windows has no `openssl`, so WordLight falls back to plain HTTP
  (phone screens can't be kept awake) unless OpenSSL is installed, and
  the pm2 log paths in `ecosystem.config.js` would need changing.
- **Storage:** 16 GB or more leaves room for the Script Converter, logs
  and updates. See "Reducing SD Card Wear" below.
- **Power:** a supply that's too weak makes a Pi slow itself down or
  crash. Use the official one for your model (the current is measured at
  the plug, so a long or thin cable counts against it). `~/power_report`,
  installed by the setup script, shows whether the Pi has ever been short
  of power. A small UPS protects the SD card from sudden power cuts.

**Wi-Fi.** Audience phones connect to a Wi-Fi network, and WordLight's
computer joins that network, preferably by Ethernet. Don't use the Pi's
own Wi-Fi as the hotspot: its Wi-Fi chip only handles about 8 devices at
once. Use a Wi-Fi router or access point made for the number of phones you
expect. If that network has no internet, see "Offline caption network"
under the setup script below.

**Audience and operator devices:** any phone, tablet or laptop with a
current web browser. Nothing to install. The operator needs a laptop or
tablet for the Caption Controller.

**Script Converter (optional):** runs on the same computer and uses at
most about one of the Pi's four cores. It is slow on a Pi: on the
Playhouse's Pi 3 (600 MHz, 1 GB) it read scanned scripts at about 35-37
seconds a page (98 pages in 58 minutes, 103 pages in 63 minutes): about
half an hour for a 50-page scan, an hour for 100 pages and an hour and a
half for 150. Making the captions afterwards takes under two minutes more. Memory is the tight
part: while reading, the converter used about 350-450 MB, leaving as
little as 170 MB free, so 1 GB is enough, but not by much. A Pi 4 or 5,
or a laptop, is faster. It waits whenever WordLight is in use, so it
never slows a show down.

**OLED status display (optional, Pi only):** a 128×64 I2C OLED (SSD1306 or
SSD1315) with 4 buttons on the Pi's GPIO pins. It shows the address and QR
codes. See `oled_display.py`.

---

## Setup script (easiest)

(Step by step from a blank SD card, including the fixed IP address the
setup doesn't set: [GETTING_STARTED.md](GETTING_STARTED.md).)

On a Raspberry Pi, or any Debian or Ubuntu computer, `setup/setup.sh` does
every step of the Quick Start below for you: system packages, Node.js, pm2,
your theater's name, the admin login, the editor login, the Scripts folder
and its network shares, the login welcome message, starting WordLight and
starting it after every reboot. It can also install the Script Converter
and set up the offline caption network (both optional).

```bash
cd ~
git clone https://github.com/traisjames/WordLight.git wordlight
cd wordlight
./setup/setup.sh
```

Run it as your normal user, **not** with `sudo`. It asks for your login
password once at the start (for the steps that need sudo); nothing shows
on screen while you type it, which is normal. The first install needs the
internet (system packages, Node.js and npm).

**From a zip instead of git** (GitHub's green **Code** button →
**Download ZIP**, then copy it to the computer):

```bash
cd ~
unzip WordLight-main.zip && mv WordLight-main wordlight
cd wordlight && ./setup/setup.sh
```

A fresh Ubuntu Server has no `unzip` yet (Raspberry Pi OS does), and
Linux's `tar` can't open zip files (a Mac's can). Use Python's instead,
then put back the "can run" mark that it doesn't keep:

```bash
python3 -m zipfile -e WordLight-main.zip . && mv WordLight-main wordlight
chmod +x wordlight/setup/*.sh
```

**Running it again** shows a menu instead of the full install: status,
system settings (time zone, computer name, Wi-Fi country on a Pi, start on
boot, login password), the network shares and Samba passwords, the Scripts
folder, the editor login, the Script Converter (install or update, from
git, a zip or a folder), the offline caption network, updating WordLight
(git, or a zip for a computer with no internet), resetting the admin
password, and backing up or restoring the Scripts folder, settings and
Script Converter (to a file or a USB flash drive; passwords are never in a
backup). Anything that restarts WordLight, or keeps the computer busy for
minutes, refuses while anyone is connected, so it can't interrupt a show.
It never changes the network settings (static IP, Wi-Fi networks): a
mistake there can cut off the connection you're using.

- **Passwords** go into `.env` exactly as typed (any characters), and
  `.env` is kept readable by your login only. The editor password must
  differ from the admin password.
- **The Scripts share** asks for a password by default. Audience phones
  join the caption Wi-Fi too, so a share anyone can read would let any of
  them copy whole scripts. Files saved there over the network belong to
  your login, so WordLight can always edit them.
- **Offline caption network.** On a Wi-Fi with no internet, phones and
  laptops notice that their "am I online?" checks fail, and drop the
  Wi-Fi or switch to cellular. `setup/connectivity-check.sh` (in the menu)
  makes this computer give those checks the answers devices expect, on
  port 80, so keep WordLight on 3000/3443 there. Either this computer
  answers the DNS part too (mode A: the network's DHCP must then hand out
  this computer as the only DNS server, but only after the script's own
  tests pass), or the network's DNS points the names here (mode B; the
  script lists the names). `setup/connectivity-check.sh --help` has the
  details.

The steps below are the same install done by hand.

---

## Quick Start

### 1. Install Node.js (if not already installed)

**On Raspberry Pi / Debian / Ubuntu:**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

The `setup_lts.x` URL always pulls the current Long Term Support release,
so this stays correct as new versions come out.

**On a Mac:** download the macOS installer from nodejs.org. Node 24
officially needs macOS 13.5 or newer; on older macOS, Node 22 (macOS 11 or
newer) is the supported choice.

**Verify:**
```bash
node --version   # should be v22 or higher
npm --version
```

> **Why v22 minimum:** Node 18 reached end-of-life on April 30 2025 and Node 20
> on April 30 2026 — neither receives security patches any more. As of late 2026
> the supported lines are **22** (Maintenance LTS), **24** (Active LTS, the best
> choice for a new install), and 26 (Current). If `node --version` reports 18 or
> 20, re-run the install command above to move to current LTS.

---

### 2. Download the project

Pick whichever you prefer — both end up in the same place.

**Option A — `git clone` (recommended)**

Easiest to keep updated later, and `git` is installed by default on
Raspberry Pi OS:

```bash
cd ~
git clone https://github.com/traisjames/WordLight.git wordlight
cd wordlight
```

**Option B — download and unpack with `curl`** (no `git` needed)

```bash
cd ~
curl -L https://github.com/traisjames/WordLight/archive/refs/heads/main.tar.gz | tar xz
mv WordLight-main wordlight
cd wordlight
```

The `mv` renames the extracted folder — GitHub tarballs unpack to
`WordLight-main` (repository name + branch), and the rest of this guide
assumes plain `wordlight`.

> If the `curl` command fails with "Not Found", the repository's default
> branch may be `master` rather than `main` — swap the word in the URL
> and the folder name.

**Then install the dependencies:**

```bash
npm install
```

---

### 2a. Updating later

**If you used `git clone`:**

```bash
cd ~/wordlight
git pull
npm install
pm2 restart wordlight
```

> **If `git pull` says "Your local changes would be overwritten by merge":**
> this usually means npm rewrote `package.json` or `package-lock.json` on this
> machine (installing a package directly does that as a side effect). Check what
> changed with `git diff`, then either discard it —
> `git checkout -- package.json package-lock.json` — or keep it with `git stash`,
> pull, and `git stash pop`. Nothing is lost either way; git stops before merging
> precisely so you can decide.

**If you used `curl`,** download into a fresh folder and copy your own
files across, rather than unpacking over the top:

```bash
cd ~
curl -L https://github.com/traisjames/WordLight/archive/refs/heads/main.tar.gz | tar xz
cp wordlight/.env WordLight-main/.env
cp wordlight/public/favicon.png wordlight/public/iconlarge.png WordLight-main/public/
mv wordlight wordlight-old && mv WordLight-main wordlight
cd wordlight && npm install && pm2 restart wordlight
```

> Whichever method you use, `.env`, your logo files, and the `certs/`
> folder are yours — never overwrite them with anything from a download.
> See `FILE_MAP.md` for the full list of what's safe to replace.

---

### 3. Configure credentials

```bash
cp env.example .env
nano .env          # or use any text editor
```

Edit these values in `.env`:

```
PORT=3000
OSC_PORT=3001
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
SESSION_SECRET=a-long-random-string-here
```

Generate a good `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

### 4. HTTPS is set up automatically

The first time the server starts, it generates its own self-signed HTTPS
certificate — no manual setup needed. This matters because the **Wake
Lock** feature (keeping an audience member's phone screen from
auto-locking mid-show) only works over HTTPS; without it, phones can lock
and hide the captions until someone taps their screen again.

Because the certificate is self-signed (a real certificate authority
won't issue one for a private LAN address), **each new device will show
a one-time "connection not private" warning** the first time it
connects — tapping through it (usually "Advanced" → "Proceed anyway") is
expected, not a sign anything is broken. Most browsers remember that
choice afterward.

By default the real app runs on port **3443** (`https://192.168.1.42:3443`),
with plain port 3000 redirecting there automatically — so even an old
bookmark or a typed URL without "https://" still ends up in the right
place. Port 3000 redirects `https://` requests too: some browsers (Chrome
with "Always use secure connections" on) try `https://…:3000` by
themselves, which used to end in an "invalid response" error. With HTTPS
off, port 3000 is WordLight itself, as plain http.

If you'd rather drop the port number entirely — so URLs and QR codes are
just `https://192.168.1.42/home` — run this **one-time** command on the Pi:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which node)
```

This grants Node permission to bind to ports below 1024 without needing
to run as root. Then set both `PORT=80` and `HTTPS_PORT=443` in your
`.env` file.

> **Note:** if Node is ever upgraded via `apt upgrade` (replacing the
> binary), this capability is lost and the command above needs to be run
> again. If the server fails to start with an `EACCES` error after an
> upgrade, this is why.

**Moving the Pi to a different venue's WiFi?** Nothing to do manually —
the certificate is checked against the Pi's current IP address every
time the server starts, and automatically regenerated if it's changed.

**Want to turn HTTPS off entirely?** Set `HTTPS_ENABLED=false` in `.env`
to run plain HTTP only — a genuine choice available any time, not just
what happens if certificate generation fails. Wake Lock won't be
available in this mode, but everything else works exactly the same.

> If you use git, add `certs/` to your `.gitignore` — `key.pem` is a
> private key and should never be committed or shared.

---

### 5. Start the server

```bash
npm start
```

You should see:
```
✅ WordLight 0.9.3 server running!
   HTTPS:    generating self-signed certificate for: 192.168.1.42, 127.0.0.1
   HTTPS:    certificate generated successfully
   Home:     https://192.168.1.xx:3443/home
   HTTP:     port 3000 redirects to HTTPS (http:// and https:// both work)
   OSC:      UDP port 3001  (/CC/next · /CC/prev · /CC/line/<n> · /CC/intermission · /CC/resume)
```

On future restarts, once a certificate already covers the Pi's current
IP, you'll see `HTTPS: using existing certificate` instead of the
generation messages.

---

### 6. Share the reader URL

Open `https://<pi-ip>:3443/home` in any browser (accept the one-time
security warning if this is a new device — see step 4 above).
The home page displays a **QR code** that audience members can scan.

---

## Run on Startup (Optional — Recommended for Pi)

Use `pm2` to keep both WordLight processes (the server and, if you're
using one, the OLED display) running across reboots. An `ecosystem.config.js`
file in the project root defines both at once:

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup       # follow the printed command to enable autostart
```

If you're not using the OLED display, that's fine — `oled_display.py`
simply won't be found and pm2 will report an error for that one process
only; `wordlight` (the actual server) starts normally either way. Remove
the `oled-display` entry from `ecosystem.config.js` to stop pm2 from
trying it at all.

---

## Reducing SD Card Wear (Optional)

SD cards have a limited number of write cycles before they wear out — a
real concern for a Pi that runs continuously across many show nights.
Two independent things help with this. `setup/setup.sh` does the first,
and on Raspberry Pi OS Trixie the second is already the default:

### 1. Log rotation

`setup/setup.sh` sets this up (its "Log rotation" step; on a computer set
up before it did, choose **Run the full setup again** in its menu). It
uses the system's own `logrotate`, which Raspberry Pi OS and Ubuntu
already have and run once a day, with one rule file,
`/etc/logrotate.d/wordlight`: WordLight's, the OLED display's and the
Script Converter's logs in `/tmp`, and pm2's own `~/.pm2/pm2.log`, are each
compressed and emptied once they pass 10 MB, and the 7 newest old copies
are kept. No extra process runs for it. To see what it would do:

```bash
sudo logrotate -d /etc/logrotate.d/wordlight
```

(pm2's `pm2-logrotate` module would also work, but it runs as one more
process the whole time, using memory a 1 GB Pi needs, and needs the
internet to install.)

### 2. Logs in memory (`/tmp`)

`ecosystem.config.js` points the logs at `/tmp` instead of the default
`~/.pm2/logs/`. That only avoids SD card writes if `/tmp` is in memory (a
`tmpfs`). Check with:

```bash
findmnt /tmp
```

It shows `tmpfs` when `/tmp` is in memory, and nothing when it's on the SD
card.

- **Raspberry Pi OS Trixie** (and other Debian 13 systems): `/tmp` is
  already in memory, up to half the RAM (about 450 MB on a 1 GB Pi 3).
  Nothing to do. This is also why log rotation matters: a log that keeps
  growing uses memory until the next reboot.
- **Raspberry Pi OS Bookworm and older, and Ubuntu:** `/tmp` is on the SD
  card (or disk). To move it into memory, add this line to `/etc/fstab`:

  ```bash
  sudo nano /etc/fstab
  ```

  ```
  tmpfs /tmp tmpfs defaults,noatime,size=100m 0 0
  ```

  Then reboot, or apply it at once with `sudo mount -a`, and check with
  `findmnt /tmp` again. The `size=100m` caps how much memory it can use.

> **Trade-off worth knowing:** once `/tmp` is in memory, its contents —
> including these logs — are cleared on every reboot. That's fine for
> this use case (logs are mainly useful for live debugging during a
> show, not long-term history), but if something crashes right before a
> planned reboot, those specific logs won't survive to be inspected
> afterward.

If `/tmp` stays on the SD card, everything still works exactly the same —
the logs are simply written to the card, and log rotation still keeps
them small.

---

## How to Use

### Controller (Presenter)

1. Open `https://<pi-ip>:3443/controller` and log in.
2. Click **Load File** and choose a `.txt` script file, or **📁 Scripts** to load one straight from the Scripts folder on the Pi.
3. Navigate with arrow keys, Space, Home/End, or click any line.
4. **`I`** — toggle the intermission overlay on all reader screens.
5. **`N`** — edit the speaker note for the current line.
6. **`/`** or **Ctrl+F** — search the script.
7. **Live type panel** — type a one-off caption that overrides the script instantly. The controller background turns dark orange as a reminder that live text is active.
8. **📄 Converter waiting / ⏸ Pause 6 hours** — appears at the right of the toolbar only when the Script Converter on the same Pi has a script it hasn't finished (see [Script Converter](#script-converter-optional) below).

### Backstage (`/backstage`)

Shows the current line, its speaker note (in green), and the next 3–4 lines. Designed for actors monitoring from the wings. Tap ⚙️ to adjust preferences — the back button returns to `/backstage`.

### Reader (Audience)

- Open `/reader` or scan the QR code on the home page.
- The current caption displays in large text; the previous 1–2 lines appear dimmer above.
- Tap ⚙️ to adjust text size, colors, and font — preferences are saved to the device.
- The preload animation plays once per 12-hour session.

### Editor (`/editor`)

A line-by-line script editor with:
- Color and style toolbar (`[red]`, `[b]`, `[i]`, `[u]`, `~`, `⏎`, `| Page…`)
- Find & replace (`Ctrl+H`)
- Live reader preview pane (drag the divider to resize)
- Collapsible script conventions reference panel
- Download as `.txt` (`Ctrl+S`)
- **📁 Scripts** opens a caption file from the Scripts folder on the Pi, and **💾 Save to Scripts** saves it there (`Ctrl+S` saves back to where it came from). No network share and no copy on the laptop needed.
- **🖨 Export PDF** makes a copy to read or print: the reader's fonts, a text size and line spacing, white pages (light colours darkened for paper) or dark pages (WordLight's own colours), bold speaker names, and with or without the notes, the `#` flags and line numbers. A preview beside the choices shows the result. Make PDF opens the browser's print box; choose **Save as PDF** there. The choices are remembered on that computer.

### Scripts folder and the editor login

The editor and the controller open caption files straight from the Scripts
folder (`/home/wordlight/Scripts`, the "CC Storage" share), and the editor
saves to it:

- Saving never writes over someone else's work. If the file was changed
  after you opened it (over the share, or in another editor), or a
  different file already has that name, yours is saved as
  "Name (2).txt" and the editor says so. The Script Converter's save to
  this folder follows the same rule.
- New files can be changed by everyone who can write to the share (they
  get the share's group and its 0664 mode).
- Only `.txt` files are shown; hidden files and anything outside the folder
  are never reachable.

**Editor login:** set `EDITOR_PASSWORD` (and optionally `EDITOR_USERNAME`,
default `editor`) in `.env` to give script volunteers their own login. It
opens the editor and the Scripts folder only; the controller and logging
still need the admin login, which also opens the editor. Without
`EDITOR_PASSWORD`, the editor needs the admin login. `SCRIPTS_DIR` and
`SCRIPTS_NAME` change the folder and what the buttons call it, e.g.
`SCRIPTS_NAME=CC Storage` to match the share's name (see `env.example`).

### Logging (Admin)

Open `/logging` to see unique reader devices, total sessions, and live connection counts. Export as CSV or reset counters.

---

## Script File Format

Plain `.txt` file, one caption per line.

```
Welcome to Finding Nemo Jr.  The show will begin shortly.
♫ PROLOGUE ♫ | Song 1, Page 1
[cyan]SEA CHORUS:[/] ♫ Just below the [b]Coral Sea[/]
[orange]NEMO:[/] Dad! ~ [red]MARLIN:[/] You get tired. ⏎ [orange]NEMO:[/] Ugh!
| Page 5
|
```

### Formatting Tags

| Syntax | Effect |
|--------|--------|
| `[red]text[/]` | Colored text — `red` `orange` `yellow` `green` `cyan` `blue` `purple` `pink` `gray` `white` |
| `[b]text[/]` | Bold |
| `[i]text[/]` | Italic |
| `[u]text[/]` | Underline |
| `♫ text ♫` | Music / song cue |
| `~` | Wide gap (two em spaces) — useful for multiple speakers on one line |
| `⏎` | Inline line break — displays two lines simultaneously in a single caption step |
| `caption\|note` | Speaker note — visible on Controller and Backstage only, never to the audience |
| `\| Page 5` | Blank reader line with a page marker note for Controller and Backstage |
| `\|` | Silent moment — blanks the audience display |

---

## Branding your installation

WordLight is designed to be re-used by any theater. Two things are meant to
be customized per installation:

**1. Theater name** — edit `THEATER_NAME` near the top of `public/global.js`:

```js
const THEATER_NAME = 'Your Theater Name Here';
```

This appears on the reader welcome screen and preloader. It's the only
place the name needs to be set — every page that uses it pulls from this
one constant. `setup/setup.sh` sets it during installation, and its menu
option **3) Theater name and support email** changes it (and
`SUPPORT_EMAIL`, the optional contact link on the home page) later.

**2. Icons and logo** — replace these two files in `public/` with your own
theater's artwork, keeping the same filenames:

| File | Used for |
|------|----------|
| `favicon.png` | Browser tab icon, Apple touch icon (home screen bookmarks) |
| `iconlarge.png` | Header logo (home page, reader, backstage) and preloader image |

No code changes are needed for the logo swap — just replace the files.

---

## Accessible Fonts

Both `/preferences` (the audience reader) and the Controller's Text
Settings include **OpenDyslexic** — a typeface specifically designed to
help with common dyslexia reading symptoms — as a font option, alongside
the usual system fonts.

**This works with no internet connection.** OpenDyslexic isn't loaded
from Google Fonts or any external source — the actual font files are
bundled in `public/fonts/` and served directly by the Pi,
the same way it serves every other file in this project. A device
selecting OpenDyslexic downloads it straight from the Pi over the local
network, exactly like it downloads the HTML and CSS — nothing ever
reaches the internet, so this works correctly even on a venue WiFi
that's intentionally not connected to it.

The font is licensed under the SIL Open Font License (OFL) v1.1, which
explicitly permits bundling and redistribution — the license text is
included alongside the font files at
`public/fonts/OFL.txt`, as its terms require. Official
source: [github.com/antijingoist/opendyslexic](https://github.com/antijingoist/opendyslexic).

---

## OSC Control

The server listens for UDP Open Sound Control messages on port `3001` (configurable via `OSC_PORT` in `.env`). This allows lighting/sound boards and show control systems to drive caption navigation.

All addresses are **case-insensitive**. Line numbers are **1-based** matching the Controller and Editor display.

| OSC Address | Action |
|-------------|--------|
| `/CC/next` | Advance to the next line |
| `/CC/prev` | Go back one line |
| `/CC/first` | Jump to line 1 |
| `/CC/last` | Jump to the last line |
| `/CC/line/37` | Jump to a specific line number |
| `/CC/intermission` | Show the "Please Stand By" overlay on all readers |
| `/CC/resume` | Hide the intermission overlay |

> OSC commands are documented on `/help` — this section is only visible to logged-in users.

---

## Script Converter (optional)

The Script Converter (a separate Python program) turns a show script PDF
or Word file into a WordLight caption file. When it runs on the same Pi,
reading a scanned script can use the whole Pi for an hour or more, so it
keeps its work away from shows by asking WordLight who is connected:

- WordLight answers `GET /api/connections` with
  `{"controllers": 1, "readers": 12, "backstage": 2}`, to requests from the
  Pi itself only. Readers counts audience phones; backstage counts the
  backstage and teleprompter screens. The home, logging and editor pages
  aren't counted. A closed page drops out at once; a phone that went to
  sleep drops out within about 45 seconds (socket.io's heartbeat).
- It is answered on the plain-http `PORT` (3000) as well as the HTTPS
  port, so the converter's default address,
  `http://127.0.0.1:3000/api/connections`, works with no redirect.
- The converter then never works while a controller is open, and during
  the day only once nobody has been connected for 30 minutes.

**The bypass, for testing.** Holding Shift while pressing "Send the script"
on the converter's page asks for the CC Server password (this admin
password, not the editor password). That one script then runs whatever the
pause rules say, even with a controller open or the converter paused; every
other script still waits. The converter asks WordLight to check the
password (`POST /api/check-admin`, from the Pi itself only) and never keeps
a copy. WordLight answers yes or no, never logs or returns the password,
waits a second before a "no", and after 5 wrong passwords in 15 minutes
refuses every try until they are 15 minutes old. With the shipped default
password (`changeme`) it always says no.

While the converter has unfinished work, the controller toolbar shows
**📄 Converter waiting** with a **⏸ Pause 6 hours** button. Pressing it
keeps the converter from starting for 6 hours, e.g. between a matinee and
an evening show (pressing again starts the 6 hours again). While paused it
shows **📄 Converter paused until …** and **▶ Resume**. Hovering over the
text shows what the converter is waiting for. Readers and backstage
screens never see any of this.

WordLight asks the converter only while a controller page is open (every 5
seconds, from the Pi to itself). If the converter isn't installed or isn't
running, nothing appears. Settings: `CONVERTER_URL` in `.env` (see
`env.example`). The setup script's converter option sets it to the right
address (`https://127.0.0.1:8090` when the converter uses WordLight's
certificate). Without it, the default is `http://127.0.0.1:8090`, and
WordLight switches to https by itself if the converter runs with a
certificate (on a Pi that can take 2 seconds the first time, because an
https converter there doesn't answer plain http at all). `off` turns the
button off.

**Installing it.** The setup script's Script Converter option installs it
next to WordLight (`~/script-converter`, with its own Python environment,
settings and jobs folders), from git, a zip or a folder. It sets the
converter page's own password, runs its self-tests, and starts it under
pm2 with WordLight's certificate and Scripts folder. Installing again
keeps the old copy as `~/script-converter.previous`, and puts it back if
the new one fails to install. A zip with a `wheels/` folder installs with
no internet at all.

**One link for everyone.** While the converter is running, WordLight's
home page shows a **Script Converter** button (under Editor) that opens
it at the same address, on the converter's own port. So the home page is
the only link people need. The converter's page still asks for its own
password.

---

## Network Notes

- All devices must be on the **same Wi-Fi network** as the Pi.
- If that Wi-Fi has **no internet**, devices may drop it: see "Offline caption network" under the setup script above.
- The server listens on `0.0.0.0` — accessible from any device on the LAN.
- The `/api/qr` QR code uses the incoming `Host` header, so it works correctly for both local IP addresses and public domain names.
- OSC uses UDP (not HTTP) — port `3001` must be reachable from your lighting/sound board on the local network.
- The HTTPS certificate is self-signed and automatically covers every IP address the Pi currently has (checked and regenerated on each startup if needed) — see step 4 in Quick Start above for what that means for end users.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't reach the Pi | Run `hostname -I` on the Pi; use that IP |
| Port 3443 (HTTPS) or 3000 (redirect) blocked | Try `HTTPS_PORT=8443` and/or `PORT=8080` in `.env` |
| `EACCES: permission denied` on port 80/443 | Run `sudo setcap 'cap_net_bind_service=+ep' $(which node)` — see step 4 above. This is also needed again after Node is upgraded via `apt`. |
| Browser shows "connection not private" | Expected on first connection from each device — the certificate is self-signed. Tap "Advanced" → "Proceed anyway" (wording varies by browser). |
| Server starts but says "Falling back to plain HTTP" | Certificate generation failed — usually means `openssl` isn't installed. Run `sudo apt-get install -y openssl` and restart the server. |
| Need to turn HTTPS off while troubleshooting | Set `HTTPS_ENABLED=false` in `.env` and restart — runs plain HTTP only until you set it back |
| Session not persisting | Make sure `SESSION_SECRET` is set in `.env` |
| Readers not updating | Check Wi-Fi — all devices need the same network |
| Server crashes on start | Run `npm install` again; check Node version ≥ 22 (`node --version`) |
| QR code doesn't appear | Run `npm install` — the `qrcode` package may be missing |
| OSC commands not working | Check UDP port `3001` isn't blocked; verify the Pi IP |
| Script Converter's pause button never appears | It only appears while the converter has unfinished work. Check the converter is running on the same Pi (`pm2 list`) and that `CONVERTER_URL` in `.env` isn't `off` or another computer's address |

---

## Project Structure

```
wordlight/
├── server.js            ← Main server (Express + Socket.io + OSC via dgram)
├── ecosystem.config.js  ← pm2 config for both processes — logs to /tmp, see "Reducing SD Card Wear"
├── package.json         ← Dependencies
├── env.example          ← Configuration template
├── .env                 ← Your actual config (do not share!)
├── certs/               ← Auto-generated self-signed HTTPS certificate
│   ├── cert.pem         ←   (created automatically on first run — do not share key.pem!)
│   ├── key.pem
│   └── cert-meta.json   ←   tracks which IPs the cert covers, for auto-refresh
└── public/
    ├── global.js        ← Shared JS (color parser, stripNote, extractNote, getOrCreateReaderId)
    ├── styles.css       ← Shared reader/backstage styles (incl. OpenDyslexic @font-face)
    ├── fonts/
    │   └── opendyslexic/ ← Self-hosted dyslexia-friendly font — see "Accessible Fonts"
    ├── home.html        ← Home page with QR code and navigation links
    ├── login.html       ← Admin login
    ├── controller.html  ← Script navigation, live type, intermission
    ├── backstage.html   ← Actor monitor with notes and upcoming lines
    ├── reader.html      ← Audience caption display
    ├── preferences.html ← Reader display settings
    ├── editor.html      ← Caption script editor
    ├── logging.html     ← Usage statistics
    └── help.html        ← Script conventions, shortcuts, and OSC reference
```
