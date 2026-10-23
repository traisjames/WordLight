# WordLight 0.9.4: Download a backup from the logging page (2026-10-23)

Built on the GitHub copy at commit 43f3eef (0.9.3).

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `backup-web.js` | project root | new: the backup routes |
| `server.js` | project root | changed: adds the backup routes (about 10 lines) |
| `public/logging.html` | public/ | changed: the Backup panel |
| `package.json`, `package-lock.json` | project root | changed: version 0.9.4 |
| `README.md`, `GETTING_STARTED.md`, `FILE_MAP.md`, `CHANGES.md` | project root | changed |

No new npm packages. Update with setup.sh's menu 10; nothing else to run.

## What changed

**A backup without a terminal.** The logging page (admin login) has a new
Backup panel: **Make and download a backup**, with a checkbox to include the
Script Converter's jobs (it shows their size). It makes the same file as
setup.sh's menu 13, by running the same `setup/backup_tool.py`, so setup.sh's
Restore reads it the same way: the Scripts folder, WordLight's settings
without any password, and the Script Converter's program and settings.

- Admin login only. The editor login and signed-out requests get 401; a
  backup is only started by the page's own JSON request, never a plain form
  post.
- It refuses while anyone is connected (controllers, readers, backstage; the
  logging page itself isn't counted), the same rule as setup.sh, and refuses
  the jobs while the converter is working on a show.
- It runs in the background (`nice -n 10`) and the page asks for its status
  every 2 seconds, because on a Pi 3 a backup can take longer than a browser
  waits for one request. The page then downloads the file and offers
  "Download it again".
- The file is made in `~/WordLight-backups` rather than `/tmp`, which is in
  memory on Raspberry Pi OS, so a copy also stays on the Pi, where setup.sh's
  Restore lists it.
- The download only serves `WordLight-backup-*.tar.gz` files from that
  folder, and is never cached.
- Without `python3` (or `setup/backup_tool.py`) the panel says so and the
  button is off. Only counts and sizes come back to the page, never file
  contents.

New routes, all behind the admin login: `GET /api/backup/status`,
`POST /api/backup`, `GET /api/backup/download?name=`.

## Tests (on the test VM, Ubuntu 24.04, after updating it from 0.9.1 to 0.9.3 with menu 9 there)

- Signed out: 401. Editor login: 401. A form post: 415. With a fake reader
  connected: 409 ("1 reader"). A name like `../../.env`: 400. A backup
  that isn't there: 404.
- Backup with the converter's jobs: made, read back and checked; the download
  is byte-identical to the copy left on the VM, passes `backup_tool.py check`,
  records the version (0.9.3, commit 43f3eef), and has none of the password
  values from `.env`.
- Travis tried the page in a browser: it made and downloaded the backup.

# WordLight 0.9.3: setup.sh: back up and restore, to a file or a flash drive (2026-10-23)

Built on the GitHub copy at commit d460f86 (0.9.2).

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `setup/backup_tool.py` | setup/ | new: makes, checks and restores backup files |
| `setup/setup.sh` | setup/ | changed: menu 13 (Back up or restore); the Script Converter install can take a folder from a restore |
| `package.json`, `package-lock.json` | project root | changed: version 0.9.3 |
| `README.md`, `GETTING_STARTED.md`, `FILE_MAP.md`, `CHANGES.md` | project root | changed |

No new npm packages, and nothing new to install: backups use Python's own
`tarfile`, and `lsblk` and `mount` come with every Linux. After updating
(menu 10), the new option is there; nothing needs to be run again.

## What changed

**Menu option 13: Back up or restore.** Options 1-12 keep their numbers.

**Backing up** makes one `.tar.gz` file with what a fresh install can't
make again: the Scripts folder, WordLight's settings (its `.env` with every
password and the session secret taken out, the theater name and support
email, the logos), and the Script Converter's program (its repository is
private, so a new Pi can't download it) and settings, plus its jobs if
asked. It goes into `~/WordLight-backups` (chmod 700, on the Wordlight Home
share) or onto a USB flash drive. Flash drives: setup lists the USB drives
it finds (never the one the computer starts from), mounts the one chosen at
`/mnt/wordlight-usb` so this login can write to it (FAT32, exFAT, NTFS or
ext4; a Mac-only format is refused with a hint to erase it as ExFAT), and
unmounts it afterwards. A drive that's already mounted (a Pi with the
desktop does that) is used where it is. The file is written under a
temporary name, read back all the way through and every file checked
against the checksums inside it, and only then gets its real name,
`WordLight-backup-<computer>-<date>-<time>.tar.gz` (a second one in the same
minute gets `-2`). It warns before a FAT32 drive's 4 GB file limit and when
there may not be room.

Left out on purpose: every password (the admin and editor passwords, the
session secret, the converter page's password; the Samba passwords were
never in a file), so a lost flash drive gives nobody a login and forgotten
passwords can be replaced at restore. Also left out: symbolic links,
`__pycache__`/`.git` folders, and files this login can't read, which are
counted on screen. Only counts and sizes are shown, never file contents.

**Restoring** checks the chosen backup first (from the backups folder, a
flash drive mounted read-only, or a typed path), then asks about each part
before anything changes, shows a summary and waits for "Go ahead?":

- Scripts folder: merge (new files added, identical ones skipped, and a
  file that differs here is kept with the backup's copy added as
  "Name (2).txt", the editor's rule), replace (the folder becomes exactly
  the backup), or skip. Files get the folder's usual 0664 / 2775.
- WordLight settings: lists what differs (ports, user names, the Scripts
  folder's name, `CONVERTER_URL`, theater name, email, logos) and asks once.
  `SCRIPTS_DIR` is never copied: it's a path on the other computer.
- Script Converter: installed from the backup when it isn't here (through
  the normal install, with its self-tests); a different installed version
  is only replaced if you say so (default no). Its settings are put back
  (changed files replaced) and missing jobs added (jobs already here are
  left alone).

Everything it replaces goes into `~/WordLight-before-restore-<date-time>`
first (chmod 700), with a copy of `.env`, so a restore can be undone by
hand. It ends by offering new admin, editor and converter page passwords
(No keeps the current ones), then restarts the converter and WordLight.
Both backing up and restoring refuse while anyone is connected to
WordLight; restoring also refuses while the converter is working on a show.

## Tests (on the test VM, Ubuntu 24.04, WordLight 0.9.1 + these files)

- Backup to `~/WordLight-backups` with jobs (5.4 MB from 11 MB): none of the
  password values from `.env` anywhere in the file; the link and an
  unreadable file left out and counted; system `tar` reads it; damaged and
  cut-short copies fail the check; refused with a fake reader connected.
- Backup to a FAT32 flash drive: mounted, written, checked, unmounted, then
  checked again separately from the drive. Already-mounted drive used in
  place. Two backups in one minute named `…` and `…-2`.
- Restore, merge: an edited caption file kept and the backup's copy added
  as "(2)", a deleted one back, a new one kept, `OSC_PORT` and the theater
  name back, a converter word list back, a moved-away job back identical,
  a new admin password set.
- Restore, replace, with no converter installed: Scripts folder identical
  to the backup, old files in the before-restore folder; converter
  installed from the backup identical to the original, 398 self-tests OK,
  both apps running.
- Restore from the flash drive: mounted read-only, everything recognized
  as already the same, unmounted.

# WordLight 0.9.2: setup.sh: log rotation, OLED reboot, theater name in the menu (2026-10-22)

Built on the GitHub copy at commit 5851154 (0.9.1). The changes were
committed as c7ffa9f ("Work on the OLED display") and 55abd59 ("Change how
logs are managed"); this entry and the version number came last.

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `setup/setup.sh` | setup/ | changed: self-test progress, OLED reboot rule, menu 3 (theater name and support email), log rotation |
| `oled_display.py` | project root | changed: comments, and the "Reboot failed" screen points to setup.sh |
| `ecosystem.config.js` | project root | changed: comments only (where the logs go, log rotation) |
| `.gitignore` | project root | changed: ignores `__pycache__/` |
| `gitignore.txt` | project root | deleted: an old copy of `.gitignore` |
| `package.json`, `package-lock.json` | project root | changed: version 0.9.2 |
| `README.md`, `GETTING_STARTED.md`, `CHANGES.md` | project root | changed |

No new npm packages. On a computer set up with an older setup.sh: update
WordLight (menu 10), then choose **12) Run the full setup again** once.
Finished steps are skipped, and it adds the log rotation rule and, where
the OLED display was set up, the reboot rule.

## What changed

**Log rotation.** WordLight, the OLED display and the Script Converter log
to `/tmp`, and on Raspberry Pi OS Trixie `/tmp` is in memory (checked on
the Playhouse Pi: a tmpfs of up to 452 MB, half its RAM), so a log that
keeps growing used memory until the next reboot. Setup's new "Log
rotation" step adds `/etc/logrotate.d/wordlight` for the system's own
logrotate, which already runs once a day: each of those logs, and pm2's
`~/.pm2/pm2.log`, is compressed and emptied once it passes 10 MB, and the 7
newest old copies are kept. It empties the log in place, so pm2 keeps
writing without a restart. The rule is checked with logrotate's dry run
before it goes in. No extra process runs for it, which is why it isn't
pm2's pm2-logrotate module (one more process using memory on a 1 GB Pi,
and it needs the internet to install). The README's "Reducing SD Card
Wear" section said Raspberry Pi OS keeps `/tmp` on the SD card, which is no
longer true on Trixie; it now says how to check (`findmnt /tmp`) and keeps
the `/etc/fstab` line for Bookworm and Ubuntu.

**Holding K4 on the OLED reboots the Pi again on a fresh install.** The
OLED script reboots with `sudo /sbin/reboot`, and under pm2 there is no
terminal for sudo to ask for a password, so it showed "Reboot failed"
unless a sudoers rule had been added by hand. The OLED step now adds
`/etc/sudoers.d/wordlight-reboot`, one line letting this login run
`/sbin/reboot` and nothing else without a password. `visudo` checks it
before it goes in, and if the whole sudoers setup then fails its check,
the file is taken out again. The "Reboot failed" screen now says to run
setup.sh again.

**Menu option 3: Theater name and support email.** Both used to be set
once at install and then only by editing `public/global.js` by hand. The
menu asks for both, with Enter keeping what's there and `-` removing the
email. The install's branding step uses the same code. An email that
doesn't look like an address is asked again (before, a typo was written
as it was). The other menu options move down one: Update WordLight is now
10, and Run the full setup again is 12.

**The converter's self-tests show progress.** The message said "a minute
or two on a Pi"; on the Playhouse's Pi 3 they took 8 minutes (481 s for
398 tests). It now says "about 8 minutes on a Pi 3, less on newer Pis",
and a line under it counts "N of 398 tests (P%)" while they run. The
tests' own lines are only counted, never shown (a failing test can print
script text), and the line is skipped when the output isn't a terminal.
The final "Ran 398 tests ... OK" line is the same as before.

## Tested

On the Ubuntu test VM, each piece on its own (that VM isn't a Pi, so the
OLED step doesn't run there):

- **Self-tests** against Script Converter 0.7.28, in a terminal: the count
  climbed to 398 of 398 and the line cleared before the result. With
  output to a file: no progress lines.
- **Reboot rule:** the first run added it (0440 root:root, `visudo -c`
  OK), the second said "already set up", and `sudo -l` lists only
  `/sbin/reboot` without a password, with everything else still asking
  for one. (The test tool refuses any command naming the reboot command,
  so actually running it was never tried.)
- **Menu option 3**, against a copy of `global.js`: Enter twice changed
  nothing; a name with an apostrophe, double quotes and "&" was written
  escaped and read back exactly; a bad email was asked again; `-` removed
  the email; `node --check` passed after each change. The install path on
  the repo's own `global.js` gave "My Theater" and no email.
- **Log rotation:** the first run added the rule, the second said
  "already set up", the dry run was clean, and with the WordLight log
  padded to 11 MB a real run turned it into a 28 KB compressed copy
  (owned by the login, not root) and emptied the log in place (same
  file), leaving the small logs alone.

# GETTING_STARTED.md: the beginner guide (2026-10-20)

Built on the GitHub copy at commit 5c6fe10 (0.9.1). Documentation only:
no code changed, so the version stays 0.9.1.

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `GETTING_STARTED.md` | project root | new |
| `README.md`, `FILE_MAP.md`, `CHANGES.md` | project root | changed: links to the guide |

## What changed

**GETTING_STARTED.md**, the guide `setup/setup.sh` has been pointing to,
is written: for a theater with no IT person, from the shopping list to
show day. It covers Raspberry Pi Imager (Raspberry Pi OS Lite 64-bit,
host name, user, SSH), logging in from a Mac or Windows, updating the
system, **Setting a Static IP** (the section setup.sh names: a router
DHCP reservation first, then on the Pi with `nmcli` for Raspberry Pi OS
Trixie's `netplan-eth0` connection, then Ubuntu Server's netplan), every
question the setup asks with a suggested answer, a test run, the logo
and theater name, the OLED wiring, the network shares from a Mac or
Windows, the Script Converter, the setup menu, what to write down, a
show-day checklist, and common problems. Photos can be added later:
the places are marked in the file (`docs/images/…`).

Setting the address on the Pi itself (Option 2) follows the Raspberry Pi
OS documentation. The connection names (`netplan-eth0`,
`netplan-wlan0-<network>`) and NetworkManager's saved files in
`/etc/netplan/` were checked on the Playhouse Pi; changing the address
there hasn't been tried yet.

---

# WordLight 0.9.1: fixes from the first days on the Playhouse Pi (2026-10-20)

Built on the GitHub copy at commit 99d6f01 (0.9.0).

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `server.js` | project root | changed: port 3000 answers https too; finds an https converter on the Pi |
| `package.json`, `package-lock.json` | project root | changed: version 0.9.1; the lock file's Node line now matches (22+) |
| `setup/setup.sh` | setup/ | changed: sets `CONVERTER_URL`; Update restores `package-lock.json` |
| `README.md`, `CHANGES.md` | project root | changed |

No new npm packages. Restart after copying: `pm2 restart wordlight`.

## What changed

**The Script Converter button (and the controller's "Converter waiting")
didn't appear on the Pi.** With no `CONVERTER_URL` in `.env`, WordLight
first asks the converter over plain http and, if that fails, tries https.
On the Pi, plain http sent to the converter's https port gets no answer at
all (its newer OpenSSL waits for the rest of a "TLS record" that never
comes), and WordLight counted a timeout as a real "no". It now tries the
other scheme after a timeout too, so it finds an https converter within 2
seconds and keeps using that address. Elsewhere (Ubuntu here) the
converter hangs up at once, which was already handled.

**setup.sh's converter option now sets `CONVERTER_URL`** in WordLight's
`.env` to the converter's exact address (`https://127.0.0.1:8090` with
WordLight's certificate, `http://…` without) and restarts WordLight if
that changed, so nothing has to be guessed. A `CONVERTER_URL` someone set
by hand (`off`, or another address) is left alone.

**Port 3000 answers `https://` as well as `http://`**, with the same
redirect to port 3443. Chrome with "Always use secure connections" on
tries `https://…:3000` by itself, which got an "invalid response"
(ERR_SSL_PROTOCOL_ERROR) instead of the redirect. The first byte a browser
sends tells the two apart (every TLS connection starts with 22). The
converter's local questions on port 3000 work as before. With HTTPS off
(`HTTPS_ENABLED=false`, or no `openssl`), nothing changes: port 3000 is
WordLight itself over plain http. Also: with `HTTPS_PORT=443` the redirect
no longer adds `:443`.

**Update WordLight (git) no longer stops on `package-lock.json`.** The
repo's lock file said Node 18+ while `package.json` says 22+, so every
`npm install` rewrote that line and git then counted the file as "changed
on this computer". The lock file now matches, and Update restores it
before pulling anyway (only npm ever changes it).

## Tested

Against the real converter code (run with a certificate, as on the Pi), a
stand-in that hangs on plain http exactly as the Pi does ("timed out after
3002 milliseconds with 0 bytes received"), and `CONVERTER_URL=https://…`:
0.9.0 showed `available: false` with the hanging one, 0.9.1 finds it in
2 s, and with the https address in 41 ms. Port 3000: plain http, https,
other host names, the converter's calls, 60 mixed requests at once, a
silent connection (closed after 10 s), junk bytes (400), headless Chromium
from `http://` and `https://` on port 3000 landing on the 3443 page with
the converter button showing; with HTTPS off and with no openssl, port
3000 serves WordLight over plain http as before. The setup's
`CONVERTER_URL` step in 10 combinations. `npm install` leaves the lock
file unchanged. `node --check`, `bash -n` and shellcheck are clean.

---

# WordLight 0.9.0: version numbers (2026-10-19)

Built on the GitHub copy at commit 5771ef1.

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `package.json`, `package-lock.json` | project root | changed: version 0.9.0 |
| `server.js` | project root | changed: the start-up message shows the version |
| `setup/setup.sh` | setup/ | changed: Status and Update show the version |
| `README.md`, `CHANGES.md` | project root | changed |

No new npm packages. Restart after copying: `pm2 restart wordlight`.

## What changed

WordLight now has a version number, **0.9.0**, kept in one place:
`package.json`. The server's start-up message (`pm2 logs wordlight`) says
"WordLight 0.9.0 server running!", and setup's Status and Update WordLight
show it with the git commit, e.g. `0.9.0 (commit 5771ef1, 2026-10-19)`, or
`0.9.0 (installed from a zip)`. Before, Status showed only the commit, or
npm's placeholder `1.0.0` for a zip install.

Everything in this file up to now makes up 0.9.0. From here on: the last
number goes up for fixes (0.9.1), the middle one for new features
(0.10.0), and 1.0.0 is for when a theater can install WordLight on its own
with GETTING_STARTED.md.

## Tested

`node --check`, `bash -n` and shellcheck are clean. The server prints its
version at start; Status's version line for a git copy, a zip copy, and a
zip copy inside some other git folder, with `set -u` as setup.sh runs.

---

# WordLight: Script Converter button on the home page, ports in setup's Status (2026-10-19)

Built on the GitHub copy at commit 2b9f138.

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `server.js` | project root | changed: `GET /api/converter-link` |
| `public/home.html` | public/ | changed: Script Converter button |
| `setup/setup.sh` | setup/ | changed: ports list in Status |
| `README.md`, `CHANGES.md` | project root | changed |

No new npm packages. Restart after copying: `pm2 restart wordlight`.

## What changed

**Script Converter button on the home page** (under Editor), so the home
page is the only link people need. It shows only while the converter is
running on this computer, and opens it at the same address the home page
was opened with, on the converter's own port and scheme (https when it
uses WordLight's certificate). The converter's page still asks for its own
password. The home page asks the new `GET /api/converter-link`, which
answers only `{available, scheme, port}` and asks the converter at most
once every 30 seconds, however many phones load the home page.

**setup.sh Status lists every port:** WordLight's https and http ports
(or http only when `HTTPS_ENABLED=false`), its OSC port (UDP), the Script
Converter's port and scheme, the offline network's port 80 (and DNS port 53
in mode A), Samba (445) and SSH (22). Each line shows the protocol,
whether something is listening there right now, what it is, and the
address to open.

## Tested

In a test copy: the endpoint with no converter, an https converter (found
by itself from the default http address), an http converter, and
`CONVERTER_URL=off`; 50 home page loads in a row asked the converter once.
The page in headless Chromium: the button is hidden or shown and points at
the right address in each case, with no page errors. The ports list with
HTTPS on and off, both kinds of converter pm2 file, a different converter
port, and the offline network in modes A and B. `node --check`, `bash -n`
and shellcheck are clean.

---

# WordLight: the new setup script and settings menu (2026-10-14)

Built on the GitHub copy at commit 108c30a. Nothing in WordLight itself
changed (server.js, public/ and package.json are untouched).

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `setup/setup.sh` | setup/ | rewritten: full install, then a settings menu |
| `setup/connectivity-check.sh` | setup/ | new: offline caption network |
| `setup/smb.conf.template` | setup/ | changed: names filled in by setup.sh |
| `README.md`, `FILE_MAP.md`, `CHANGES.md` | project root | changed |

After copying by hand: `chmod +x setup/setup.sh setup/connectivity-check.sh`.

## What changed

**The full install** (first run) now also sets the time zone, the Wi-Fi
country (Pi), an editor login, the Scripts folder, start on boot, and
optionally the Script Converter and the offline caption network. It asks
for the sudo password once at the start, with a note that typing doesn't
show. Node 22 is the minimum. The OLED display app is only started when
the OLED was set up. Pi-only steps are skipped on other computers.

**Running it again shows a menu** (a little like `raspi-config`): status,
system settings (time zone, computer name, Wi-Fi country, start on boot,
login password), Samba shares and passwords, the Scripts folder, the
editor login, the Script Converter, the offline caption network, updating
WordLight (git, or a zip for a computer with no internet; `.env`,
`certs/`, the logo files and the theater name and email are kept), the
admin password, and the full setup again. Restarting WordLight, updating
and installing the converter refuse while anyone is connected.

**Safer with any input:**

- `.env` values are written so that WordLight's dotenv reads them back
  exactly. Before, a password with `#` was cut at the `#` (a strong
  password could quietly become a 3-letter one), and spaces and quotes
  were changed. `.env` is now readable by its owner only (600), and setup
  fixes that on existing installs too.
- The theater name and support email are written as proper JavaScript
  text, then checked with Node. Before, a name with an apostrophe
  ("Children's Theatre") broke `public/global.js` and with it every page.
- The Scripts folder must be a folder of your own, given as a full path (a
  bare name means a folder in your home). Before, any existing folder
  (even a system folder) was accepted and made writable through the
  network share. Share names are checked too.
- The welcome-message name and email take ordinary characters only (that
  message is a script that runs at every login).
- Login names and passwords are checked: the editor and admin need
  different usernames and different passwords, and a refused answer is
  asked again.
- The Script Converter can't be "installed" from its own folder, and a
  failed install puts the previous copy back. git never stops to ask for a
  GitHub login.

**Samba** (`smb.conf.template`): the real user, home, WordLight folder,
Scripts folder and share name are filled in. The Scripts share asks
**"Let anyone READ it without a password?" with No as the default**,
since audience phones on the caption Wi-Fi could otherwise copy whole
scripts. Files saved there belong to the setup user (`force user`), so
WordLight can always edit them.

**`setup/connectivity-check.sh`** (new): makes this computer answer
Apple's, Android's and Windows' connectivity checks on a caption network
with no internet. Mode A runs dnsmasq here (the network's DHCP then hands
out this computer as the only DNS server, but only after the tests pass);
mode B leaves DNS to the network. It checks port 80 and 53 first, runs its
own 12 checks (7 in mode B) without needing `dig`, can list the names for
the network company, and removes everything again, stopping nginx and
dnsmasq only if it installed them for this. Run with `--help`.

## Tested

On an Ubuntu 24.04 VM rolled back to before WordLight was installed, two
full rounds: the full install, every menu option, and deliberately bad or
hostile answers (command tricks in names, addresses and menu choices,
impossible IPs, a fake time zone, the wrong zip, a git address that tries
to run a command, system folders as the Scripts folder, a password with
`# "' $()` and a space). The admin login works with that password and
refuses its first 3 letters. `bash -n` and shellcheck are clean. Not
tested yet on a real Raspberry Pi (OLED, Wi-Fi country, power report).

---

# WordLight: the Script Converter's bypass (2026-10-13)

Built on the GitHub copy at commit 69f5f8f. Goes with Script Converter 0.7.11.

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `server.js` | project root | changed: `POST /api/check-admin` |
| `README.md`, `CHANGES.md` | project root | changed |

No new npm packages (`crypto` is built into Node). Restart after copying:
`pm2 restart wordlight`.

## What changed

**`POST /api/check-admin`**, for the Script Converter's bypass (testing):
holding Shift while pressing "Send the script" on the converter's page lets
one script run whatever the converter's pause rules say, but only with the
CC Server password, which is this admin password and never the editor
password. The converter asks WordLight to check it instead of keeping a
copy.

- Answers only programs on the Pi itself (like `/api/connections`), on the
  HTTPS port and on the plain-http `PORT`, which the converter uses.
- `{"password": "..."}` in, `{"ok": true}` or `{"ok": false, "error": "..."}`
  out. The password is compared by hash with a constant-time compare, and
  is never logged or sent back; the log says only "[converter] Script
  Converter bypass: the CC Server password was given" (or "a wrong ... was
  given").
- A wrong password is answered a second later. After 5 wrong ones in 15
  minutes every try is refused (429) until they are 15 minutes old, the
  right password included.
- The shipped default admin password (`changeme`) never unlocks it.

---

# WordLight: Export PDF in the editor (2026-10-13)

Built on the GitHub copy at commit 1fae57a.

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `public/editor.html` | `public/` | changed: 🖨 Export PDF button and its box |
| `README.md`, `CHANGES.md` | project root | changed |

No server change, no new npm packages, no restart needed (reload the editor page).

## What changed

**🖨 Export PDF** (next to Download) makes a copy of the caption file to read
or print. The box asks for:

- **Font**: the same list as the reader's Preferences page (OpenDyslexic comes
  from WordLight's own font files, so it works on any computer).
- **Text size** (10 to 28 pt) and **line spacing** (tight, normal, roomy, double).
- **Page**: white, for printing, where the light colours (yellow, green, cyan,
  white) become a darker shade of the same colour so they read on paper; or
  dark, WordLight's black background and its own colours, for a screen.
- **Bold speaker names**: the label before the first colon at the start of a
  caption line (or after a ⏎) is bold when it is coloured, when every word
  starts with a capital ("and", "&", "except" aside), or when the same label
  starts three or more lines. The name keeps its colour. A line that begins
  with dialogue like "Listen: ..." can be caught by the capitals rule.
- **Notes** (page numbers in bold, cues, scene titles) under their line;
  **# flags** (`#Check_Sound`, `#SFX` ...) in the notes; **line numbers**
  matching the editor. On dark pages the notes are WordLight's note green
  (as in the editor preview and the controller); on white pages, grey.
  With flags off, a flag goes with its own words
  (`#Check_Spelling <word>`, `#Fill_In <what>`), so only notes for reading
  are left.
- **Preview** beside the choices: the whole file drawn as the page will
  look, redrawn on every change (it keeps its scroll place).

Make PDF opens the browser's print box; set Destination to **Save as PDF**
(Safari: the PDF button). The PDF is named after the file. The choices are
remembered in that browser.

Why the print box and not a direct download: the browser's printing keeps the
text real (searchable, selectable), embeds whichever font was picked, and needs
no PDF library on the Pi. A direct-download PDF could only use fonts bundled
with WordLight.

---

# WordLight: Scripts folder and editor login (2026-10-13)

Built on the GitHub copy at commit 595c539 ("Oct 12 Update"). It **includes
the Script Converter link from the 2026-10-12 zip**, so this zip alone brings
a GitHub copy up to date.

## Files (same folders as the repo)

| File | Goes to | New or changed |
|---|---|---|
| `server.js` | project root | changed: editor login, Scripts folder routes (and the converter link) |
| `scripts-folder.js` | project root | **new**: list, open and save in the Scripts folder |
| `public/scripts-picker.js` | `public/` | **new**: the Scripts folder dialog |
| `public/editor.html` | `public/` | changed: 📁 Scripts, 💾 Save to Scripts, Sign out |
| `public/controller.html` | `public/` | changed: 📁 Scripts next to Load File (and the converter button) |
| `public/styles.css` | `public/` | changed: one rule, `[hidden]` always hides |
| `env.example` | project root | changed: EDITOR_*, SCRIPTS_* (commented out) |
| `README.md`, `FILE_MAP.md` | project root | changed |

No new npm packages. After copying: add to `.env` (then `pm2 restart wordlight`):

    EDITOR_PASSWORD=<a password for script volunteers, not the admin one>
    SCRIPTS_NAME=CC Storage

`SCRIPTS_DIR` isn't needed when WordLight runs as the user whose home has the
`Scripts` folder (setup.sh makes `~/Scripts`). The start-up log says which
folder it uses and whether the editor login is on.

## What changed

**Editor login.** `EDITOR_USERNAME` (default `editor`) + `EDITOR_PASSWORD`:
opens `/editor` and the Scripts folder only. The controller and logging say
"This login opens the editor only" instead of looping back to the login
page, and a controller socket is refused, as before. The admin login opens
everything, the editor included. Without `EDITOR_PASSWORD` there is no
editor login.

**`/editor` now needs a login.** The README always said so, but `server.js`
served it to anyone. It now needs the admin or the editor login.

**Scripts folder** (`SCRIPTS_DIR`, default `~/Scripts`; `SCRIPTS_NAME` is
what the buttons say):
- Editor: **📁 Scripts** opens a caption file from the folder (and its
  folders); **💾 Save to Scripts** saves back to where it came from, or asks
  for a folder and name for a file from the laptop or a new one. `Ctrl+S`
  saves back when the file came from the folder, and downloads otherwise
  (as before). The file name in the header shows where it came from.
- Controller: **📁 Scripts** next to Load File loads a script straight from
  the folder, the same way as Load File (server check and error messages
  included). While the dialog is open, Space, arrows and `I` do nothing to
  the show.
- Saving never writes over someone else's work: a file changed since it was
  opened, or another file with that name, is left alone and yours is saved
  as "Name (2).txt", with a message saying so. The same rule as the Script
  Converter's save to this folder.
- New files get mode 0664 and the share's group (scriptusers, from the
  folder's setgid bit), so WordMaker can change them over the share.
- Only `.txt` files are listed; hidden names, `..` and links that lead out of
  the folder are refused. 5 MB per file at most.
- API: `GET /api/scripts/status`, `GET /api/scripts?folder=`,
  `GET /api/scripts/file?path=`, `POST /api/scripts/file?folder=&name=&base=`
  (text body, so the app's 100 kB JSON limit doesn't apply). All need the
  editor or admin login; without one they answer 401.

## Tested in the sandbox

- 27 checks on scripts-folder.js: listing, refusing `..`/hidden/links out,
  BOM dropped, replace when unchanged, "(2)" when changed elsewhere, "(3)"
  after "(2)" (not "(2) (2)"), no overwrite for laptop files, same text kept,
  names cleaned, mode 0664, a drive without hard links, no temp files left.
- 47 HTTP checks: no login gets 302/401 everywhere; editor login gets the
  editor and the folder, 403 on controller/logging, 401 on /api/log, and its
  controller socket is refused; admin gets everything; a 256 KB caption file
  opened and saved back; 6 MB refused; traversal refused; saved files
  `-rw-rw-r--` group scriptusers in a setgid folder.
- Chromium, editor login, 1280 and 390 px: open from a subfolder, edit,
  Ctrl+S back, a change made "over the share" kept and the save going to
  "(2)" with the message, a new file saved through the dialog. Admin
  controller: keys inside the dialog don't reach the show, the script loads
  on the server (40 lines), Space is "next line" again afterwards. No page
  errors.
