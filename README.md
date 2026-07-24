# 🔦 WordLight

A self-hosted, real-time closed caption relay server for live theater, designed
to run on a Raspberry Pi. A **Controller** navigates a script; **Readers** on
audience members' phones see each line instantly, making performances
accessible to hard-of-hearing patrons.

WordLight is free and open for any theater to use. Everything shown to your
audience — the theater name, colors, and logo — is fully configurable per
installation (see [Branding your installation](#branding-your-installation)
below); nothing in this project is tied to any specific venue.

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
| `/editor` | Caption script editor | ✅ Yes |
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

---

## npm Packages

All dependencies are listed in `package.json` and installed with `npm install`.

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^4.18.2 | HTTP server and routing |
| `socket.io` | ^4.6.1 | Real-time WebSocket events |
| `cookie-session` | ^2.1.1 | Session management |
| `cookie-parser` | ^1.4.6 | Cookie parsing middleware |
| `dotenv` | ^16.3.1 | Load config from `.env` file |
| `qrcode` | ^1.5.3 | Generate QR code PNG for the home page |
| `os-monitor` | ^2.1.3 | System resource monitoring |

> **OSC support** uses Node's built-in `dgram` module — no extra package required.

---

## Quick Start

### 1. Install Node.js (if not already installed)

**On Raspberry Pi / Debian / Ubuntu:**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Verify:**
```bash
node --version   # should be v18 or higher
npm --version
```

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
npm install        # only needed if package.json changed
pm2 restart wordlight
```

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
place.

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
✅ WordLight server running!
   HTTPS:    generating self-signed certificate for: 192.168.1.42, 127.0.0.1
   HTTPS:    certificate generated successfully
   Home:     https://192.168.1.xx:3443/home
   HTTP:     port 3000 redirects to HTTPS
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
Two independent things help with this, and `ecosystem.config.js` is
already set up for both:

### 1. Log rotation

Without rotation, pm2's log files grow forever. Install and configure
the official rotation module:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

This keeps at most 7 rotated (and compressed) log files per process,
each capped at 10MB, automatically — no further action needed.

### 2. Moving logs to RAM (`/tmp`)

`ecosystem.config.js` already points both processes' logs at `/tmp`
instead of the default `~/.pm2/logs/`. **This only actually avoids SD
card writes if `/tmp` is RAM-backed** — and on Raspberry Pi OS, unlike
many other Linux distributions, **it is not RAM-backed by default.**
Without the extra step below, `/tmp` is just an ordinary folder on the
SD card like any other, so writes there still wear the card the same as
anywhere else — the ecosystem file alone doesn't achieve anything on
its own.

To actually make `/tmp` RAM-backed, add this line to `/etc/fstab`:

```bash
sudo nano /etc/fstab
```

```
tmpfs /tmp tmpfs defaults,noatime,size=100m 0 0
```

Then either reboot, or apply it immediately with:

```bash
sudo mount -a
```

Verify it worked:

```bash
df -h /tmp
```

You should see `tmpfs` listed as the filesystem type for `/tmp`, not
your SD card's device name.

> **Trade-off worth knowing:** once `/tmp` is RAM-backed, its contents —
> including these logs — are cleared on every reboot. That's fine for
> this use case (logs are mainly useful for live debugging during a
> show, not long-term history), but if something crashes right before a
> planned reboot, those specific logs won't survive to be inspected
> afterward. The `size=100m` cap also means logs can't consume more than
> 100MB of RAM even if rotation were somehow misconfigured.

If you'd rather not set up `tmpfs`, everything still works exactly the
same — logs simply stay on the SD card at `/tmp`, and you still get the
benefit of log rotation from step 1 above.

---

## How to Use

### Controller (Presenter)

1. Open `https://<pi-ip>:3443/controller` and log in.
2. Click **Load File** and choose a `.txt` script file.
3. Navigate with arrow keys, Space, Home/End, or click any line.
4. **`I`** — toggle the intermission overlay on all reader screens.
5. **`N`** — edit the speaker note for the current line.
6. **`/`** or **Ctrl+F** — search the script.
7. **Live type panel** — type a one-off caption that overrides the script instantly. The controller background turns dark orange as a reminder that live text is active.

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
one constant.

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

## Network Notes

- All devices must be on the **same Wi-Fi network** as the Pi.
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
| Server crashes on start | Run `npm install` again; check Node version ≥ 18 |
| QR code doesn't appear | Run `npm install` — the `qrcode` package may be missing |
| OSC commands not working | Check UDP port `3001` isn't blocked; verify the Pi IP |

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
