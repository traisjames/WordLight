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
- **Notes** (page numbers in bold, cues, scene titles) under their line;
  **# flags** (`#Check_Sound`, `#SFX` ...) in the notes; **line numbers**
  matching the editor.

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
