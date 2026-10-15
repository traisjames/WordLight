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
