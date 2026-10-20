#!/bin/bash
#
# setup.sh — WordLight installer, settings and maintenance tool
# =====================================================================
# Run this after a fresh Raspberry Pi OS install (or on an old Linux
# computer — everything except the Pi-only steps applies there too).
#
# Safe to run more than once. The FIRST time, it walks through a full
# install. Once WordLight is set up, it shows a menu instead (a little like
# raspi-config): status, system settings (time zone, computer name, Wi-Fi
# country, start on boot, login password), network shares, the Scripts
# folder and editor login, the Script Converter, the offline-network
# connectivity checks, updating WordLight, and password resets.
#
# ── Usage ────────────────────────────────────────────────────────────────
#   cd wordlight/setup
#   ./setup.sh
#
# Do NOT run this with sudo. It runs as your normal user, and uses sudo
# internally only for the specific commands that actually need it — the
# rest (npm install, editing your own project files) should NOT be done
# as root.
#
# ── Why this exists ─────────────────────────────────────────────────────
# WordLight's setup touches a lot of things: system packages, Node.js,
# Samba, HTTPS certificates, pm2, /boot/firmware/config.txt, and more.
# Doing all of that correctly by hand — especially with no IT background —
# is where small mistakes creep in. This script does it the same way,
# every time, and explains what it's doing at each step.
#
# ── I2C / OLED and reboots ──────────────────────────────────────────────
# If you choose to set up the OLED display, enabling I2C requires a
# reboot before it will work. This script will tell you clearly when
# that's needed, save its progress, and stop — reboot, log back in, and
# run ./setup.sh again. It will pick up exactly where it left off rather
# than starting over or re-asking questions you already answered.
#
# ── What it never does ──────────────────────────────────────────────────
# It never changes the network settings (static IP, Netplan, Wi-Fi
# networks): a mistake there can cut off the SSH connection you're using.
# GETTING_STARTED.md walks through those by hand.

set -uo pipefail
# Deliberately NOT using `set -e` — this script has a lot of conditional
# logic (checking whether a step is already done, whether a command
# exists, etc.) where a "failure" is an expected, normal outcome to
# branch on, not a reason to abort. Real errors are checked explicitly
# and reported clearly instead.

# ── Output helpers ───────────────────────────────────────────────────────

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }
step()  { echo ""; echo -e "${BOLD}${BLUE}══ $1${NC}"; }

die() { err "$1"; echo ""; err "Setup stopped — nothing after this point ran."; exit 1; }

# ── Paths ─────────────────────────────────────────────────────────────────

SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SETUP_DIR")"
STATE_FILE="$HOME/.wordlight-setup-state"
ENV_FILE="$PROJECT_DIR/.env"
ME="$(whoami)"

# The Script Converter's folders, all in this user's home next to WordLight
CONV_DIR="$HOME/script-converter"
CONV_VENV="$HOME/script-converter-venv"
CONV_SETTINGS="$HOME/script-converter-settings"
CONV_JOBS="$HOME/script-converter-jobs"
CONV_PM2="$HOME/script-converter.config.js"
CONV_GIT_DEFAULT="https://github.com/traisjames/script-converter.git"

cd "$PROJECT_DIR" || die "Could not find the WordLight project folder at $PROJECT_DIR"

[ "$(id -u)" -ne 0 ] || die "Please run this as your normal user, not with sudo: ./setup.sh"

# Every sudo in this script goes through here: when sudo is about to ask for
# a password, say whose password it wants and that typing won't show.
sudo() {
  if ! command sudo -n true 2>/dev/null; then
    echo -e "${YELLOW}🔑${NC} sudo needs YOUR login password ($ME). Nothing shows while you type it — that's normal." >&2
  fi
  command sudo "$@"
}

# .env holds the admin and editor passwords: only this login may read it.
[ -f "$ENV_FILE" ] && chmod 600 "$ENV_FILE" 2>/dev/null

# ── State tracking (what makes this safe to re-run) ─────────────────────
#
# Each completed step's name is appended as its own line in $STATE_FILE.
# step_done checks whether a given step has already run; mark_done
# records that it has. This is what lets the script be interrupted
# (e.g. for the I2C reboot) and resumed later without repeating work or
# re-asking questions that were already answered.

step_done() { [ -f "$STATE_FILE" ] && grep -qx "$1" "$STATE_FILE" 2>/dev/null; }
mark_done() { step_done "$1" || echo "$1" >> "$STATE_FILE"; }

# ── Small helpers used throughout ────────────────────────────────────────

# Prompts for a password twice and confirms they match. Echoes the
# password to stdout on success — use as:
#   PASS=$(prompt_password "...") || die "..."
#
# Caps retries at 5 and returns failure (exit code 1) rather than calling
# die()/exit directly — this function is always called via $(...) command
# substitution, which runs in a SUBSHELL. Calling exit inside a subshell
# only terminates that subshell, not the actual script — the parent would
# silently continue with an empty password instead of really stopping.
# Returning a non-zero status instead works correctly, since command
# substitution DOES propagate its exit code to the caller — every call
# site below checks it with `|| die "..."`.
prompt_password() {
  local prompt_text="$1" pass1 pass2 attempts=0
  while true; do
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 5 ]; then
      warn "No valid password entered after several attempts." >&2
      return 1
    fi
    read -rsp "$prompt_text: " pass1; echo >&2
    read -rsp "Confirm: " pass2; echo >&2
    if [ -z "$pass1" ]; then
      warn "Password can't be empty — try again." >&2
      continue
    fi
    if [ "$pass1" = "$pass2" ]; then
      echo "$pass1"
      return 0
    fi
    warn "Those didn't match — try again." >&2
  done
}

# Prompts with a default value shown in brackets; empty input keeps the default.
prompt_with_default() {
  local prompt_text="$1" default_value="$2" input
  read -rp "$prompt_text [$default_value]: " input
  echo "${input:-$default_value}"
}

prompt_yes_no() {
  local prompt_text="$1" default_answer="${2:-n}" input
  local hint="y/N"
  [ "$default_answer" = "y" ] && hint="Y/n"
  read -rp "$prompt_text [$hint]: " input
  input="${input:-$default_answer}"
  [[ "$input" =~ ^[Yy] ]]
}

pause_for_enter() { echo ""; read -rp "Press Enter to go back to the menu..." _; }

# .env is read by WordLight with dotenv, which cuts an unquoted value at "#",
# trims spaces and strips quotes. So values are written in whichever form
# dotenv reads back EXACTLY (bare, '...', "..." or `...`), checked against a
# copy of dotenv's own parser before the file is replaced. The file is
# rewritten in one step and kept readable by this login only (600).
#   envtool get KEY          prints the value WordLight will see
#   envtool set KEY VALUE    exit 3 if VALUE can't be stored faithfully
#   envtool check VALUE      exit 3 if VALUE couldn't be stored
read -r -d '' ENVTOOL_PY <<'PY'
import os, re, sys, tempfile
LINE = re.compile(r"""(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)""", re.M)
def parse(src):  # dotenv 16's parse(), line for line
    out = {}
    for m in LINE.finditer(re.sub(r"\r\n?", "\n", src)):
        v = (m.group(2) or "").strip()
        q = v[:1]
        v = re.sub(r"""^(['"`])([\s\S]*)\1$""", r"\2", v, flags=re.M)
        if q == '"':
            v = v.replace("\\n", "\n").replace("\\r", "\r")
        out[m.group(1)] = v
    return out
def encodings(v):
    return [v, "'" + v + "'", '"' + v + '"', "`" + v + "`"]
def build(text, key, line):
    lines = text.split("\n")
    pat = re.compile(r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=")
    hits = [i for i, l in enumerate(lines) if pat.match(l)]
    if hits:
        lines[hits[0]] = line
        lines = [l for i, l in enumerate(lines) if i not in hits[1:]]
    else:
        if lines and lines[-1] == "":
            lines.insert(len(lines) - 1, line)
        else:
            lines.append(line)
    return "\n".join(lines)
def pick(text, key, v):
    if "\n" in v or "\r" in v:
        return None
    before = parse(text); before.pop(key, None)
    for enc in encodings(v):
        new = build(text, key, key + "=" + enc)
        after = parse(new)
        if after.get(key) == v and {k: x for k, x in after.items() if k != key} == before:
            return new
    return None
path, cmd = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
if cmd == "get":
    v = parse(text).get(sys.argv[3])
    if v is not None:
        sys.stdout.write(v)
elif cmd == "check":
    sys.exit(0 if pick("", "K", sys.argv[3]) is not None else 3)
elif cmd == "set":
    new = pick(text, sys.argv[3], sys.argv[4])
    if new is None:
        sys.exit(3)
    if not new.endswith("\n"):
        new += "\n"
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".env.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(new)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
PY
envtool() { python3 -c "$ENVTOOL_PY" "$ENV_FILE" "$@"; }

# Sets KEY=VALUE in .env. Returns non-zero (and says so) if it couldn't.
set_env_value() {
  envtool set "$1" "$2" && return 0
  warn "Couldn't save $1 in .env exactly as typed, so nothing was changed."
  return 1
}

# True when a value (a password, say) can be stored in .env exactly as typed
env_value_ok() { envtool check "$1"; }

# Reads KEY from .env exactly as WordLight sees it (nothing if it isn't set).
# Never printed by this script for passwords — only compared.
env_get() { envtool get "$1" 2>/dev/null; }

is_pi() { tr -d '\0' 2>/dev/null < /proc/device-tree/model | grep "^Raspberry Pi" >/dev/null; }
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep "install ok installed" >/dev/null; }

# The Scripts folder and its share name (from .env, else the defaults)
scripts_dir()  { local d; d=$(env_get SCRIPTS_DIR); echo "${d:-$HOME/Scripts}"; }
scripts_name() { local n; n=$(env_get SCRIPTS_NAME); echo "${n:-CC Storage}"; }

# Who is connected to WordLight right now, asked the same way the Script
# Converter asks (plain http on WordLight's PORT, from this computer only).
# Returns 0 when anyone is connected (WL_NOBODY then says who, e.g. "1 reader,
# 2 controllers"); returns 1 when nobody is, or when WordLight didn't answer.
# WL_ANSWERED tells those two apart: yes or no.
WL_NOBODY="" WL_ANSWERED=no
wordlight_in_use() {
  local port answer rc
  WL_NOBODY="" WL_ANSWERED=no
  port=$(env_get PORT); port=${port:-3000}
  answer=$(curl -s --max-time 3 "http://127.0.0.1:${port}/api/connections" 2>/dev/null) || return 1
  [ -n "$answer" ] || return 1
  WL_NOBODY=$(printf '%s' "$answer" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(2)
if not isinstance(d, dict):
    sys.exit(2)
def say(n, k):
    if n == 1 and k.endswith("s") and k != "backstage":
        k = k[:-1]
    return "%d %s" % (n, k)
parts = [say(v, k) for k, v in d.items() if isinstance(v, int) and not isinstance(v, bool) and v > 0]
print(", ".join(parts))
sys.exit(0 if parts else 1)')
  rc=$?
  [ "$rc" -le 1 ] && WL_ANSWERED=yes
  [ "$rc" -eq 0 ]
}

restart_wordlight() {
  if wordlight_in_use; then
    warn "WordLight is in use right now ($WL_NOBODY), so it was NOT restarted."
    warn "The change takes effect after:  pm2 restart wordlight  (after the show)"
    return 1
  fi
  pm2 restart wordlight >/dev/null 2>&1 && ok "WordLight restarted." || warn "Couldn't restart WordLight (is it running? pm2 list)"
}

pm2_has() { pm2 describe "$1" >/dev/null 2>&1; }

# Which WordLight this is: the git commit, or package.json's version for a zip install
wl_version() {   # e.g. "0.9.0 (commit 5771ef1, 2026-10-19)" or "0.9.0 (installed from a zip)"
  local v="" c=""
  v=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$PROJECT_DIR/package.json" 2>/dev/null)
  [ -d "$PROJECT_DIR/.git" ] && c=$(git -C "$PROJECT_DIR" log -1 --format='%h, %cd' --date=short 2>/dev/null)
  if [ -n "$c" ]; then echo "${v:-?} (commit $c)"; else echo "${v:-?} (installed from a zip)"; fi
}

# Escapes a value for the right-hand side of a sed s|...|...| command
sed_repl() { printf '%s' "$1" | sed -e 's/[|&\\]/\\&/g'; }

# A value as a JavaScript string literal (JSON text is valid JavaScript)
js_str() { python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"; }

# Sets one  const NAME = '...';  line in public/global.js, escaped as
# JavaScript (so a name like "Children's Theatre" can't break the page), then
# has Node check the whole file; if that fails the old file is put back.
set_js_const() {   # set_js_const NAME VALUE
  local js="$PROJECT_DIR/public/global.js" bak
  [ -f "$js" ] || { warn "Couldn't find public/global.js — set $1 there by hand later."; return 1; }
  bak=$(mktemp); cp -p "$js" "$bak"
  if ! python3 - "$js" "$1" "$2" <<'PY'
import re, sys
path, name, value = sys.argv[1:4]
value = "".join(c for c in value if c >= " ")
lit = "'" + (value.replace("\\", "\\\\").replace("'", "\\'")
             .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")) + "'"
text = open(path, encoding="utf-8").read()
new, n = re.subn(r"^const " + re.escape(name) + r" = .*;[ \t]*$",
                 lambda m: "const " + name + " = " + lit + ";", text, count=1, flags=re.M)
if n != 1:
    sys.exit(2)
open(path, "w", encoding="utf-8").write(new)
PY
  then
    rm -f "$bak"; warn "Couldn't find the $1 line in public/global.js — nothing changed."; return 1
  fi
  if command -v node >/dev/null && ! node --check "$js" >/dev/null 2>&1; then
    cp -p "$bak" "$js"; rm -f "$bak"
    warn "That made public/global.js invalid, so it was put back as it was."; return 1
  fi
  rm -f "$bak"
}

# ═══════════════════════════════════════════════════════════════════════════
# SETTINGS (used by both the full install and the menu)
# ═══════════════════════════════════════════════════════════════════════════

# ── Time zone ────────────────────────────────────────────────────────────

do_timezone() {
  local cur choice tz
  cur=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)
  echo "Time zone now: ${cur:-unknown}   (the time here: $(date '+%a %-I:%M %p'))"
  echo "The converter's night window and every log use this computer's clock."
  echo ""
  echo "  1) America/New_York (Eastern)     5) America/Phoenix (Arizona)"
  echo "  2) America/Chicago (Central)      6) America/Anchorage (Alaska)"
  echo "  3) America/Denver (Mountain)      7) Pacific/Honolulu (Hawaii)"
  echo "  4) America/Los_Angeles (Pacific)  8) Type another (e.g. Europe/London)"
  read -rp "Choose 1-8, or Enter to keep ${cur:-it}: " choice
  case "$choice" in
    1) tz=America/New_York ;; 2) tz=America/Chicago ;; 3) tz=America/Denver ;;
    4) tz=America/Los_Angeles ;; 5) tz=America/Phoenix ;; 6) tz=America/Anchorage ;;
    7) tz=Pacific/Honolulu ;;
    8) read -rp "Time zone name: " tz ;;
    "") ok "Time zone kept: ${cur:-unchanged}."; return 0 ;;
    *) warn "Not a valid choice — time zone not changed."; return 1 ;;
  esac
  if ! timedatectl list-timezones 2>/dev/null | grep -x -- "$tz" >/dev/null; then
    warn "\"$tz\" isn't a time zone name this computer knows (see: timedatectl list-timezones)."
    return 1
  fi
  sudo timedatectl set-timezone "$tz" || { warn "Couldn't set the time zone."; return 1; }
  sudo timedatectl set-ntp true >/dev/null 2>&1
  ok "Time zone set to $tz. The time here is now $(date '+%a %-I:%M %p')."
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != yes ]; then
    warn "The clock isn't synchronized from the internet yet. On a network with no"
    warn "internet it can't be: a Raspberry Pi has no clock battery, so after a power"
    warn "cut its time can be wrong until it reaches the internet again."
  fi
}

# ── Computer name ────────────────────────────────────────────────────────

do_hostname() {
  local cur new
  cur=$(hostname)
  echo "Computer name now: $cur"
  echo "Other computers can usually reach this one as <name>.local. WordLight's"
  echo "certificate only lists IP addresses, so browsers warn at a .local name;"
  echo "QR codes and printed links keep using the IP address."
  read -rp "New name (letters, numbers, hyphens), or Enter to keep $cur: " new
  [ -z "$new" ] && { ok "Name kept: $cur."; return 0; }
  if ! [[ "$new" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
    warn "\"$new\" can't be a computer name (letters, numbers and hyphens only, no hyphen at the ends)."
    return 1
  fi
  sudo hostnamectl set-hostname "$new" || { warn "Couldn't change the name."; return 1; }
  if grep -qE '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
    sudo sed -i -E "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$new/" /etc/hosts
  else
    printf '127.0.1.1\t%s\n' "$new" | sudo tee -a /etc/hosts >/dev/null
  fi
  ok "Computer name set to $new."
  if ! systemctl is-active --quiet avahi-daemon 2>/dev/null; then
    if prompt_yes_no "Install avahi-daemon so others can find it as $new.local?" "y"; then
      sudo apt-get install -y -qq avahi-daemon >/dev/null && ok "avahi-daemon installed." \
        || warn "Couldn't install avahi-daemon (needs the internet)."
    fi
  fi
}

# ── Wi-Fi country (Raspberry Pi only) ────────────────────────────────────

do_wifi_country() {
  if ! is_pi || ! command -v raspi-config >/dev/null; then
    info "Wi-Fi country is a Raspberry Pi setting — skipped on this computer."
    return 0
  fi
  local cur new
  cur=$(sudo raspi-config nonint get_wifi_country 2>/dev/null)
  echo "Wi-Fi country now: ${cur:-not set}. The Pi's Wi-Fi only uses the channels"
  echo "allowed in this country, and may stay off until it's set."
  new=$(prompt_with_default "Two-letter country code" "${cur:-US}")
  new=$(printf '%s' "$new" | tr '[:lower:]' '[:upper:]')
  [[ "$new" =~ ^[A-Z]{2}$ ]] || { warn "Use a two-letter code such as US or GB."; return 1; }
  sudo raspi-config nonint do_wifi_country "$new" >/dev/null 2>&1 \
    && ok "Wi-Fi country set to $new." || warn "Couldn't set the Wi-Fi country."
}

# ── Start on boot ────────────────────────────────────────────────────────

boot_start_on() { systemctl is-enabled --quiet "pm2-$ME" 2>/dev/null; }

do_boot_start() {   # do_boot_start on|off
  local pm2bin; pm2bin=$(command -v pm2) || { warn "pm2 isn't installed yet."; return 1; }
  if [ "$1" = on ]; then
    pm2 save >/dev/null 2>&1
    sudo env PATH="$PATH" "$pm2bin" startup systemd -u "$ME" --hp "$HOME" >/dev/null 2>&1 \
      && ok "WordLight (and anything else pm2 runs) starts by itself after a reboot." \
      || warn "Couldn't set up start on boot. Run 'pm2 startup' and follow what it says."
  else
    sudo env PATH="$PATH" "$pm2bin" unstartup systemd -u "$ME" --hp "$HOME" >/dev/null 2>&1 \
      && ok "Start on boot is off: after a reboot, start things with  pm2 resurrect" \
      || warn "Couldn't turn start on boot off."
  fi
}

# ── Scripts folder ───────────────────────────────────────────────────────

# A share name Samba and every laptop will show exactly as typed
valid_share_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._\'-]{0,39}$ ]] || return 1
  local low; low=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$low" in "cc server"|"wordlight home"|global|homes|printers|print\$|ipc\$) return 1 ;; esac
}

do_scripts_folder() {
  local dir name owner
  echo "The Scripts folder holds the caption files. WordLight's editor and controller"
  echo "open them straight from it, and the network share shows it to laptops."
  dir=$(prompt_with_default "Scripts folder" "$(scripts_dir)")
  dir="${dir/#\~/$HOME}"
  case "$dir" in /*) ;; *) dir="$HOME/$dir" ;; esac       # a bare name means a folder in your home
  dir=$(realpath -m -- "$dir")
  case "$dir" in
    /|"$HOME"|"$PROJECT_DIR"|"$CONV_DIR"*|"$CONV_VENV"*|"$CONV_SETTINGS"*|"$CONV_JOBS"*)
      warn "$dir can't be the Scripts folder — choose a folder of its own (for example $HOME/Scripts)."
      return 1 ;;
  esac
  if [ -e "$dir" ]; then
    [ -d "$dir" ] || { warn "$dir is a file, not a folder."; return 1; }
    owner=$(stat -c %U "$dir")
    if [ "$owner" != "$ME" ]; then
      warn "$dir belongs to \"$owner\", not to $ME. The Scripts folder gets shared on the"
      warn "network and its permissions changed, so it must be a folder of your own. Nothing changed."
      return 1
    fi
  fi
  name=$(prompt_with_default "Name to show for it (also the network share's name)" "$(scripts_name)")
  if ! valid_share_name "$name"; then
    warn "\"$name\" can't be the share name: up to 40 letters, numbers, spaces and . _ ' -"
    warn "(and not \"CC Server\" or \"Wordlight Home\", which are taken). Nothing changed."
    return 1
  fi
  getent group scriptusers >/dev/null || sudo groupadd scriptusers
  sudo usermod -a -G scriptusers "$ME"
  mkdir -p "$dir" || { warn "Couldn't make $dir."; return 1; }
  sudo chgrp scriptusers "$dir" && sudo chmod 2775 "$dir"
  set_env_value "SCRIPTS_DIR" "$dir" && set_env_value "SCRIPTS_NAME" "$name" || return 1
  ok "Scripts folder: $dir (shown as \"$name\"). Files made there belong to the scriptusers group."
  mark_done "scripts-folder-set"
}

# ── Editor login ─────────────────────────────────────────────────────────

# Login names WordLight's login form takes as typed
valid_login_name() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,32}$ ]]; }

# Asks for a password until it's usable, up to 3 times. $1 is the prompt,
# $2 a password it must NOT equal (the other login's) and $3 what to call that.
# Echoes the password; non-zero if none was given.
ask_login_password() {
  local p tries=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    p=$(prompt_password "$1") || return 1
    if [ -n "$2" ] && [ "$p" = "$2" ]; then
      warn "That's the $3 password — this login needs a different one. Try again." >&2; continue
    fi
    if ! env_value_ok "$p"; then
      warn "That password uses all three of ' \" and \` — please leave one of them out. Try again." >&2; continue
    fi
    printf '%s' "$p"; return 0
  done
  return 1
}

do_editor_login() {
  local user pass admin_user tries=0
  echo "An editor login lets script volunteers open the editor and the Scripts folder,"
  echo "never the caption controller. Without one, the editor needs the admin login."
  admin_user=$(env_get ADMIN_USERNAME)
  while true; do
    tries=$((tries + 1))
    [ "$tries" -le 3 ] || { warn "No editor login set."; return 1; }
    user=$(prompt_with_default "Editor username" "$(env_get EDITOR_USERNAME | grep . || echo editor)")
    if ! valid_login_name "$user"; then
      warn "Use up to 32 letters, numbers and . _ - for the username."; continue
    fi
    if [ "$user" = "$admin_user" ]; then
      warn "\"$user\" is the admin username — the editor needs its own."; continue
    fi
    break
  done
  pass=$(ask_login_password "Editor password (not the admin password)" "$(env_get ADMIN_PASSWORD)" admin) \
    || { warn "No editor login set."; return 1; }
  set_env_value "EDITOR_USERNAME" "$user" && set_env_value "EDITOR_PASSWORD" "$pass" || return 1
  ok "Editor login \"$user\" set."
  mark_done "editor-login-set"
}

do_admin_password() {
  local pass
  pass=$(ask_login_password "New admin password" "$(env_get EDITOR_PASSWORD)" editor) \
    || { warn "Nothing was changed."; return 1; }
  set_env_value "ADMIN_PASSWORD" "$pass" || return 1
  ok "Admin password updated in .env."
}

# ── Samba (network shares) ───────────────────────────────────────────────

do_samba_shares() {
  local dir name guest comment tmp
  pkg_installed samba || { info "Installing Samba..."; sudo apt-get install -y -qq samba >/dev/null || { warn "Installing Samba failed (needs the internet)."; return 1; }; }
  step_done "scripts-folder-set" || do_scripts_folder || return 1
  dir=$(scripts_dir); name=$(scripts_name)
  valid_share_name "$name" || { warn "The Scripts share name \"$name\" (SCRIPTS_NAME in .env) can't be used — set it again with the Scripts folder option."; return 1; }
  getent group scriptusers >/dev/null || sudo groupadd scriptusers
  id WordMaker &>/dev/null || sudo useradd --no-create-home --shell /usr/sbin/nologin -G scriptusers WordMaker

  echo "Audience phones join the caption Wi-Fi too. If anyone can read the \"$name\""
  echo "share, any of them with a file-sharing app could copy the whole scripts."
  if prompt_yes_no "Let anyone on the network READ the \"$name\" share without a password?" "n"; then
    guest=yes; comment="everyone can read, $ME/WordMaker can write"
  else
    guest=no;  comment="$ME/WordMaker can read and write"
  fi
  [ -f "$SETUP_DIR/smb.conf.template" ] || { warn "setup/smb.conf.template is missing."; return 1; }
  tmp=$(mktemp)
  local e_me e_home e_proj e_dir e_name e_comment
  e_me=$(sed_repl "$ME"); e_home=$(sed_repl "$HOME"); e_proj=$(sed_repl "$PROJECT_DIR")
  e_dir=$(sed_repl "$dir"); e_name=$(sed_repl "$name"); e_comment=$(sed_repl "$comment")
  sed -e "s|{{USER}}|$e_me|g" -e "s|{{HOME}}|$e_home|g" -e "s|{{PROJECT_DIR}}|$e_proj|g" \
      -e "s|{{SCRIPTS_DIR}}|$e_dir|g" -e "s|{{SCRIPTS_SHARE}}|$e_name|g" \
      -e "s|{{SCRIPTS_GUEST}}|$guest|g" -e "s|{{SCRIPTS_COMMENT}}|$e_comment|g" \
      "$SETUP_DIR/smb.conf.template" > "$tmp"
  if ! testparm -s "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"; warn "The new Samba settings didn't pass Samba's own check (testparm); nothing changed."; return 1
  fi
  [ -f /etc/samba/smb.conf ] && sudo cp /etc/samba/smb.conf "/etc/samba/smb.conf.backup-$(date +%Y%m%d-%H%M%S)" \
    && info "Backed up the old Samba settings."
  sudo cp "$tmp" /etc/samba/smb.conf && rm -f "$tmp"
  sudo systemctl restart smbd nmbd 2>/dev/null || sudo systemctl restart smbd 2>/dev/null \
    || warn "Couldn't restart Samba automatically — a reboot will do it."
  sudo systemctl enable smbd >/dev/null 2>&1
  ok "Shares: \"CC Server\" ($PROJECT_DIR), \"$name\" ($dir), \"Wordlight Home\" ($HOME)."

  echo ""
  echo "Samba passwords: '$ME' can use every share; 'WordMaker' only the Scripts share."
  if sudo pdbedit -L 2>/dev/null | cut -d: -f1 | grep -x -- "$ME" >/dev/null && ! prompt_yes_no "'$ME' already has a Samba password. Set a new one?" "n"; then :
  else info "Samba password for '$ME' (full access):"; sudo smbpasswd -a "$ME"; fi
  if sudo pdbedit -L 2>/dev/null | cut -d: -f1 | grep -x WordMaker >/dev/null && ! prompt_yes_no "'WordMaker' already has a Samba password. Set a new one?" "n"; then :
  else info "Samba password for 'WordMaker' (Scripts share only):"; sudo smbpasswd -a WordMaker; fi
  mark_done "samba-configured"
}

# ── Script Converter (optional) ──────────────────────────────────────────

# Finds the converter's code folder (the one with convert.py) inside $1
find_converter_root() { find "$1" -maxdepth 3 -name convert.py -path '*/convert.py' -printf '%h\n' 2>/dev/null | head -1; }

do_converter() {
  local src="" kind root tmp certargs answer
  if wordlight_in_use; then
    warn "WordLight is in use right now ($WL_NOBODY). Installing the converter keeps"
    warn "this computer busy for minutes, so not now. Try again when nobody is connected."
    return 1
  fi
  echo "The Script Converter turns a show script (PDF or Word) into a WordLight caption"
  echo "file, from its own page at port 8090. It only works once WordLight has had"
  echo "nobody connected for 30 minutes, or between 1 and 6 am with no controller"
  echo "open, so it never slows a show down."
  echo ""
  echo "Where should it come from?"
  echo "  1) Download it with git ($CONV_GIT_DEFAULT, or another address)"
  echo "  2) A zip file already on this computer (for a computer with no internet)"
  echo "  3) A folder already on this computer"
  [ -d "$CONV_DIR/.git" ] && echo "  4) Update the copy that's here with git pull"
  read -rp "Choose: " kind
  tmp=$(mktemp -d)
  case "$kind" in
    1)
      command -v git >/dev/null || { warn "git isn't installed."; rm -rf "$tmp"; return 1; }
      src=$(prompt_with_default "git address" "$CONV_GIT_DEFAULT")
      # --: an address can't be taken as a git option. No prompt: a private
      # repository fails at once instead of asking for a GitHub login.
      GIT_TERMINAL_PROMPT=0 git clone -q -- "$src" "$tmp/code" \
        || { warn "git clone failed (no internet? a wrong address? a private repository?)."; rm -rf "$tmp"; return 1; }
      root="$tmp/code" ;;
    2)
      read -rp "Path to the zip file: " src; src="${src/#\~/$HOME}"
      [ -f "$src" ] || { warn "No file at $src."; rm -rf "$tmp"; return 1; }
      command -v unzip >/dev/null || sudo apt-get install -y -qq unzip >/dev/null || { warn "unzip isn't installed."; rm -rf "$tmp"; return 1; }
      unzip -q "$src" -d "$tmp/zip" || { warn "Couldn't unpack $src."; rm -rf "$tmp"; return 1; }
      root=$(find_converter_root "$tmp/zip") ;;
    3)
      read -rp "Path to the folder: " src; src="${src/#\~/$HOME}"
      root=$(find_converter_root "$src")
      if [ -n "$root" ]; then
        root=$(realpath -- "$root")
        local own
        for own in "$CONV_DIR" "$CONV_DIR.previous" "$CONV_VENV" "$CONV_SETTINGS" "$CONV_JOBS"; do
          own=$(realpath -m -- "$own")
          case "$root/" in
            "$own"/*)
              warn "$root is this computer's own converter (or its backup) — choose the folder"
              warn "with the NEW copy. Nothing changed."; rm -rf "$tmp"; return 1 ;;
          esac
        done
      fi ;;
    4)
      [ -d "$CONV_DIR/.git" ] || { warn "Not a valid choice."; rm -rf "$tmp"; return 1; }
      GIT_TERMINAL_PROMPT=0 git -C "$CONV_DIR" pull --ff-only || { warn "git pull failed — nothing changed."; rm -rf "$tmp"; return 1; }
      root="" ;;
    *) warn "Not a valid choice."; rm -rf "$tmp"; return 1 ;;
  esac

  # Swap the new copy in. The old one stays as .previous until this install
  # has finished; if anything below fails, conv_rollback puts it back.
  local swapped=false
  conv_rollback() {
    if [ "$swapped" = true ] && [ -d "$CONV_DIR.previous" ]; then
      rm -rf "$CONV_DIR" && mv "$CONV_DIR.previous" "$CONV_DIR" \
        && warn "The converter that was here before is back in $CONV_DIR, unchanged."
    fi
    rm -rf "$tmp"
  }
  if [ "$kind" != 4 ]; then
    [ -n "${root:-}" ] && [ -f "$root/convert.py" ] && [ -d "$root/scriptconv" ] \
      || { warn "That doesn't contain the Script Converter (no convert.py and scriptconv/)."; rm -rf "$tmp"; return 1; }
    if [ -e "$CONV_DIR" ]; then
      rm -rf "$CONV_DIR.previous"
      mv "$CONV_DIR" "$CONV_DIR.previous" || { warn "Couldn't move the old copy aside — nothing changed."; rm -rf "$tmp"; return 1; }
      swapped=true
    fi
    if [ "$kind" = 3 ]; then cp -a "$root" "$CONV_DIR"; else mv "$root" "$CONV_DIR"; fi \
      || { warn "Copying the new converter failed."; conv_rollback; return 1; }
    [ "$swapped" = true ] && info "The old copy is kept as $CONV_DIR.previous."
  fi
  rm -rf "$tmp"
  local version; version=$(grep -oE '^VERSION = "[^"]+"' "$CONV_DIR/scriptconv/__init__.py" 2>/dev/null | cut -d'"' -f2)
  ok "Script Converter ${version:-?} is in $CONV_DIR."

  local need=()
  pkg_installed python3-venv || need+=(python3-venv)
  pkg_installed tesseract-ocr || need+=(tesseract-ocr)
  if [ ${#need[@]} -gt 0 ]; then
    info "Installing ${need[*]}..."
    sudo apt-get install -y -qq "${need[@]}" >/dev/null \
      || warn "Couldn't install ${need[*]} (needs the internet). Scanned scripts need tesseract-ocr; install it when online."
  fi
  [ -x "$CONV_VENV/bin/python3" ] || python3 -m venv "$CONV_VENV" \
    || { warn "Couldn't make the Python environment (python3-venv?)."; conv_rollback; return 1; }
  info "Installing the converter's Python packages..."
  if [ -d "$CONV_DIR/wheels" ]; then
    "$CONV_VENV/bin/pip" install -q --no-index --find-links "$CONV_DIR/wheels" -r "$CONV_DIR/requirements.txt" \
      || { warn "Installing from the wheels folder failed."; conv_rollback; return 1; }
  else
    "$CONV_VENV/bin/pip" install -q -r "$CONV_DIR/requirements.txt" \
      || { warn "pip install failed. It needs the internet once, or a wheels/ folder in the zip."; conv_rollback; return 1; }
  fi
  info "Running the converter's self-tests (a minute or two on a Pi)..."
  answer=$( cd "$CONV_DIR" && "$CONV_VENV/bin/python3" convert.py selftest 2>&1 | grep -E '^(Ran |OK|FAILED)' | tr '\n' ' ')
  if [[ "$answer" == *OK* ]]; then ok "Self-tests: $answer"; else warn "Self-tests: ${answer:-no result}"; fi

  mkdir -p "$CONV_SETTINGS" "$CONV_JOBS"
  if [ ! -f "$CONV_SETTINGS/converter-password.txt" ]; then
    echo ""
    info "Set the converter page's own password (not WordLight's, so script volunteers"
    info "can use the converter without getting the caption controller):"
    ( cd "$CONV_DIR" && SCRIPTCONV_SETTINGS="$CONV_SETTINGS" "$CONV_VENV/bin/python3" convert.py password ) \
      || warn "Password not set — run it later: cd $CONV_DIR && SCRIPTCONV_SETTINGS=$CONV_SETTINGS $CONV_VENV/bin/python3 convert.py password"
  fi

  local args=(serve --pi)
  certargs=""
  if [ -f "$PROJECT_DIR/certs/cert.pem" ] && [ -f "$PROJECT_DIR/certs/key.pem" ]; then
    args+=(--cert "$PROJECT_DIR/certs/cert.pem" --key "$PROJECT_DIR/certs/key.pem"); certargs=yes
  fi
  [ -f "$CONV_PM2" ] && cp "$CONV_PM2" "$CONV_PM2.bak"
  # Every value below is written as a JSON string (valid JavaScript), so a
  # folder name with spaces or quotes can't break the file
  local j_dir j_venv j_set j_jobs j_sdir j_sname j_args
  j_dir=$(js_str "$CONV_DIR"); j_venv=$(js_str "$CONV_VENV/bin/python3")
  j_set=$(js_str "$CONV_SETTINGS"); j_jobs=$(js_str "$CONV_JOBS")
  j_sdir=$(js_str "$(scripts_dir)"); j_sname=$(js_str "$(scripts_name)")
  j_args=$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "${args[@]}")
  cat > "$CONV_PM2" <<PM2
// pm2 file for the Script Converter, made by WordLight's setup/setup.sh
// ($(date '+%Y-%m-%d')). setup.sh makes it again when it installs or updates the
// converter; the previous one is kept as script-converter.config.js.bak.
// serve --pi turns on the pause rules: the converter never works while
// WordLight is in use. With WordLight's certificate the page uses https.
module.exports = {
  apps: [{
    name: "script-converter",
    cwd: $j_dir,
    script: "convert.py",
    args: $j_args,
    interpreter: $j_venv,
    env: {
      SCRIPTCONV_SETTINGS: $j_set,
      SCRIPTCONV_JOBS: $j_jobs,
      SCRIPTCONV_SCRIPTS: $j_sdir,
      SCRIPTCONV_SCRIPTS_NAME: $j_sname,
      PYTHONUNBUFFERED: "1",
    },
    autorestart: true,
    kill_timeout: 8000,
    out_file: "/tmp/script-converter.log",
    error_file: "/tmp/script-converter.log",
    merge_logs: true,
  }],
};
PM2
  if pm2_has script-converter; then pm2 delete script-converter >/dev/null 2>&1; fi
  pm2 start "$CONV_PM2" >/dev/null || { warn "pm2 couldn't start the converter (see: pm2 logs script-converter)."; return 1; }
  pm2 save >/dev/null 2>&1
  local scheme=http; [ -n "$certargs" ] && scheme=https
  ok "The converter is running: $scheme://$(hostname -I | awk '{print $1}'):8090"
  mark_done "converter-installed"
}

# ── Offline network: answer the devices' internet checks ─────────────────

do_connectivity() {   # do_connectivity [once]   once: one action, then back (full install)
  local f="$SETUP_DIR/connectivity-check.sh"
  [ -f "$f" ] || { warn "setup/connectivity-check.sh is missing."; return 1; }
  [ -x "$f" ] || chmod +x "$f" 2>/dev/null
  echo "On a caption Wi-Fi with NO internet, phones and laptops notice that their"
  echo "\"am I online?\" checks fail, and drop the Wi-Fi or switch to cellular. This"
  echo "makes this computer give those checks the answers devices expect."
  echo "(Not needed if the caption network has internet.)"
  while true; do
    echo ""
    echo -e "${BOLD}Offline caption network${NC}  (now: $( [ -f /etc/wordlight/connectivity-check.state ] && echo set up || echo not set up))"
    echo "  1) Set it up, or set it up again"
    echo "  2) Run its checks"
    echo "  3) List the names, for whoever runs the network"
    echo "  4) Remove it"
    echo "  0) Back"
    local c; read -rp "Choose: " c
    case "$c" in
      1) sudo "$f" ;;
      2) sudo "$f" --test ;;
      3) "$f" --names ;;
      4) sudo "$f" --uninstall ;;
      *) return 0 ;;
    esac
    [ "${1:-}" = once ] && return 0
    pause_for_enter
  done
}

# ── Update WordLight ─────────────────────────────────────────────────────

# The two branding lines setup writes into public/global.js, kept across updates
save_branding()    { grep -E "^const (THEATER_NAME|SUPPORT_EMAIL) = " "$PROJECT_DIR/public/global.js" > "$1" 2>/dev/null; }
restore_branding() {
  [ -s "$1" ] || return 0
  python3 - "$PROJECT_DIR/public/global.js" "$1" <<'PY'
import sys
path, saved = sys.argv[1], sys.argv[2]
keep = {l.split("=")[0].strip(): l for l in open(saved, encoding="utf-8").read().splitlines() if l.strip()}
lines = open(path, encoding="utf-8").read().split("\n")
for i, l in enumerate(lines):
    k = l.split("=")[0].strip()
    if k in keep:
        lines[i] = keep[k]
open(path, "w", encoding="utf-8").write("\n".join(lines))
PY
}
OWN_FILES=(public/favicon.png public/iconlarge.png)

do_update_wordlight() {
  if wordlight_in_use; then
    warn "WordLight is in use right now ($WL_NOBODY). Updating restarts it, so it won't"
    warn "update now. Try again when nobody is connected."
    return 1
  fi
  local tmp; tmp=$(mktemp -d)
  save_branding "$tmp/branding"
  local f; for f in "${OWN_FILES[@]}"; do [ -f "$PROJECT_DIR/$f" ] && mkdir -p "$tmp/own/$(dirname "$f")" && cp -a "$PROJECT_DIR/$f" "$tmp/own/$f"; done
  local before after
  before=$(wl_version)
  local how=zip
  if [ -d "$PROJECT_DIR/.git" ]; then
    echo "  1) Download the newest version with git"
    echo "  2) From a zip file on this computer"
    read -rp "Choose [1]: " how; [ "${how:-1}" = 1 ] && how=git || how=zip
  fi
  if [ "$how" = git ]; then
    git -C "$PROJECT_DIR" checkout -- public/global.js "${OWN_FILES[@]}" 2>/dev/null
    local dirty; dirty=$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=no)
    if [ -n "$dirty" ]; then
      warn "These WordLight files were changed on this computer, so git can't update over them:"
      printf '%s\n' "$dirty" | sed 's/^/    /'
      restore_branding "$tmp/branding"; cp -a "$tmp/own/." "$PROJECT_DIR/" 2>/dev/null; rm -rf "$tmp"
      return 1
    fi
    if ! GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" pull --ff-only; then
      warn "git pull failed — WordLight wasn't changed."
      restore_branding "$tmp/branding"; cp -a "$tmp/own/." "$PROJECT_DIR/" 2>/dev/null; rm -rf "$tmp"
      return 1
    fi
  else
    local zip root
    read -rp "Path to the WordLight zip file: " zip; zip="${zip/#\~/$HOME}"
    [ -f "$zip" ] || { warn "No file at $zip."; rm -rf "$tmp"; return 1; }
    command -v unzip >/dev/null || sudo apt-get install -y -qq unzip >/dev/null || { warn "unzip isn't installed."; rm -rf "$tmp"; return 1; }
    unzip -q "$zip" -d "$tmp/zip" || { warn "Couldn't unpack $zip."; rm -rf "$tmp"; return 1; }
    root=$(find "$tmp/zip" -maxdepth 3 -name server.js -printf '%h\n' | while read -r d; do [ -f "$d/package.json" ] && echo "$d"; done | head -1)
    [ -n "$root" ] || { warn "That zip doesn't contain WordLight (no server.js and package.json)."; rm -rf "$tmp"; return 1; }
    # Copy everything except this computer's own files. A zip keeps times
    # without a time zone, so a zip made elsewhere can look "from the future".
    tar -C "$root" --exclude=./.env --exclude=./node_modules --exclude=./certs --exclude=./.git -cf - . \
      | tar -C "$PROJECT_DIR" --warning=no-timestamp -xf - || { warn "Copying the new files failed."; rm -rf "$tmp"; return 1; }
  fi
  restore_branding "$tmp/branding"
  cp -a "$tmp/own/." "$PROJECT_DIR/" 2>/dev/null
  rm -rf "$tmp"
  info "Installing WordLight's packages..."
  ( cd "$PROJECT_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null ) || { warn "npm install failed — WordLight wasn't restarted."; return 1; }
  after=$(wl_version)
  if [ "$before" = "$after" ]; then ok "WordLight updated (still $after)."; else ok "WordLight updated: $before -> $after."; fi
  restart_wordlight
  return 0
}

# ── Status ───────────────────────────────────────────────────────────────

show_status() {
  step "Status"
  local model; model=$(tr -d '\0' 2>/dev/null < /proc/device-tree/model || true)
  echo "Computer:   $(hostname)${model:+  ($model)}"
  echo "Addresses:  $(hostname -I 2>/dev/null)"
  echo "Time:       $(date '+%a %Y-%m-%d %-I:%M %p')  $(timedatectl show -p Timezone --value 2>/dev/null)  (synchronized: $(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo ?))"
  echo "Up since:   $(uptime -s 2>/dev/null)"
  local temp=""
  if command -v vcgencmd >/dev/null; then temp=$(vcgencmd measure_temp 2>/dev/null | cut -d= -f2)
  elif [ -r /sys/class/thermal/thermal_zone0/temp ]; then temp="$(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 ))'C"; fi
  [ -n "$temp" ] && echo "CPU temp:   $temp"
  command -v vcgencmd >/dev/null && echo "Throttling: $(vcgencmd get_throttled 2>/dev/null | cut -d= -f2) (0x0 = never)"
  echo "Disk free:  $(df -h --output=avail "$HOME" | tail -1 | tr -d ' ') in $HOME;  memory free: $(free -m | awk '/^Mem:/{print $7" MB of "$2" MB"}')"
  echo "Node.js:    $(node -v 2>/dev/null || echo 'not installed')"
  echo "WordLight:  $(wl_version),  ports $(env_get PORT)/$(env_get HTTPS_PORT)"
  if wordlight_in_use; then echo "In use now: $WL_NOBODY"
  elif [ "$WL_ANSWERED" = yes ]; then echo "In use now: nobody connected"
  else echo "In use now: ? (WordLight didn't answer — is it running? see pm2 below)"; fi
  echo "pm2:"
  pm2 jlist 2>/dev/null | python3 -c '
import json, sys, time
try:
    apps = json.load(sys.stdin)
except ValueError:
    apps = []
for a in apps:
    e = a.get("pm2_env", {})
    up = e.get("pm_uptime"); status = e.get("status", "?"); name = a.get("name", "?")
    mins = int((time.time() * 1000 - up) / 60000) if up and status == "online" else 0
    print("  %-18s %-9s up %dh %dm  restarts %s" % (name, status, mins // 60, mins % 60, e.get("restart_time", 0)))
if not apps:
    print("  nothing running under pm2")'
  echo "Start on boot: $(boot_start_on && echo on || echo off)"
  if [ -f "$CONV_DIR/scriptconv/__init__.py" ]; then
    echo "Converter:  $(grep -oE '^VERSION = "[^"]+"' "$CONV_DIR/scriptconv/__init__.py" | cut -d'"' -f2) in $CONV_DIR"
  else
    echo "Converter:  not installed"
  fi
  echo "Scripts:    $(scripts_dir) (\"$(scripts_name)\")$( [ -n "$(env_get EDITOR_PASSWORD)" ] && echo ';  editor login on' || echo ';  no editor login')"
  if systemctl is-active --quiet smbd 2>/dev/null; then
    echo "Samba:      on — shares: $(grep -E '^\[' /etc/samba/smb.conf | grep -v '^\[global\]' | tr -d '[]' | paste -sd, -)"
  else
    echo "Samba:      off"
  fi
  if [ -f /etc/wordlight/connectivity-check.state ]; then
    echo "Internet checks: answered here (mode $(grep '^mode=' /etc/wordlight/connectivity-check.state | cut -d= -f2), $(grep '^ip=' /etc/wordlight/connectivity-check.state | cut -d= -f2))"
  else
    echo "Internet checks: not set up"
  fi
  show_ports
}

# ── Ports: every port in use, what it is, and whether it's answering ──────

# Is anything listening on this port here? (ss needs no sudo for this.)
# 0 yes, 1 no, 2 can't tell (no ss)
port_listening() {   # port_listening tcp|udp PORT
  command -v ss >/dev/null || return 2
  local flag=t; [ "$1" = udp ] && flag=u
  ss -Hln"$flag" "sport = :$2" 2>/dev/null | grep . >/dev/null
}

# One line: port/protocol, kind, listening or not, what it is (and the address)
port_line() {   # port_line PORT tcp|udp KIND "what it is"
  local state rc
  port_listening "$2" "$1"; rc=$?
  case $rc in 0) state="listening" ;; 1) state="NOT listening" ;; *) state="?" ;; esac
  printf '  %-10s %-6s %-14s %s\n' "$1/$2" "$3" "$state" "$4"
}

show_ports() {
  local ip port https_port osc_port conv_port conv_scheme mode
  ip=$(hostname -I 2>/dev/null | awk '{print $1}'); ip=${ip:-this-computer}
  port=$(env_get PORT); port=${port:-3000}
  https_port=$(env_get HTTPS_PORT); https_port=${https_port:-3443}
  osc_port=$(env_get OSC_PORT); osc_port=${osc_port:-3001}
  echo ""
  echo "Ports (the addresses work from any device on the same network):"
  if [ "$(env_get HTTPS_ENABLED)" = false ]; then
    port_line "$port" tcp http "WordLight (HTTPS is off in .env): http://$ip:$port/home"
  else
    port_line "$https_port" tcp https "WordLight: https://$ip:$https_port/home"
    port_line "$port" tcp http "WordLight, sends browsers on to https (port $https_port)"
  fi
  port_line "$osc_port" udp OSC "WordLight cues from a lighting or sound board"
  if [ -f "$CONV_PM2" ] || pm2_has script-converter; then
    # The pm2 file's args, as a list ("--port", "8091") or one string (--port 8091)
    conv_port=$(grep -oE -- '--port[", =]+[0-9]+' "$CONV_PM2" 2>/dev/null | grep -oE '[0-9]+$')
    conv_port=${conv_port:-8090}
    conv_scheme=http; grep -q -- '--cert' "$CONV_PM2" 2>/dev/null && conv_scheme=https
    port_line "$conv_port" tcp "$conv_scheme" "Script Converter: $conv_scheme://$ip:$conv_port"
  fi
  if [ -f /etc/wordlight/connectivity-check.state ]; then
    mode=$(grep '^mode=' /etc/wordlight/connectivity-check.state | cut -d= -f2)
    port_line 80 tcp http "Offline network: devices' \"am I online?\" checks (nginx)"
    [ "$mode" = A ] && port_line 53 udp DNS "Offline network: the check names (dnsmasq)"
  fi
  if systemctl is-active --quiet smbd 2>/dev/null; then
    port_line 445 tcp SMB "Network shares (Samba): smb://$ip"
  fi
  port_line 22 tcp SSH "Logging in to this computer: ssh $ME@$ip"
}

# ═══════════════════════════════════════════════════════════════════════════
# MENUS — shown instead of the full install once one has finished
# ═══════════════════════════════════════════════════════════════════════════

system_menu() {
  while true; do
    echo ""
    echo -e "${BOLD}System settings${NC}"
    echo "  1) Time zone            (now: $(timedatectl show -p Timezone --value 2>/dev/null))"
    echo "  2) Computer name        (now: $(hostname))"
    echo "  3) Wi-Fi country        $(is_pi && echo '' || echo '(Raspberry Pi only)')"
    echo "  4) Start on boot        (now: $(boot_start_on && echo on || echo off))"
    echo "  5) Change the password of this login ($ME)"
    echo "  0) Back"
    local c; read -rp "Choose: " c
    case "$c" in
      1) do_timezone ;;
      2) do_hostname ;;
      3) do_wifi_country ;;
      4) if boot_start_on; then prompt_yes_no "Turn start on boot OFF?" "n" && do_boot_start off
         else do_boot_start on; fi ;;
      5) passwd ;;
      *) return 0 ;;
    esac
  done
}

maintenance_menu() {
  while true; do
    echo ""
    echo -e "${BOLD}🔦 WordLight setup — this computer is already set up.${NC}"
    echo ""
    echo "  1) Status"
    echo "  2) System settings (time zone, computer name, Wi-Fi country, start on boot, password)"
    echo "  3) Network shares (Samba): set up again"
    echo "  4) Reset a Samba password"
    echo "  5) Scripts folder"
    echo "  6) Editor login"
    echo "  7) Script Converter: install or update"
    echo "  8) Offline caption network: answer devices' internet checks"
    echo "  9) Update WordLight"
    echo "  10) Reset the WordLight admin password"
    echo "  11) Run the full setup again (safe — finished steps are skipped)"
    echo "  0) Exit"
    local choice; read -rp "Choose: " choice
    case "$choice" in
      1) show_status; pause_for_enter ;;
      2) system_menu ;;
      3) do_samba_shares; pause_for_enter ;;
      4)
        local who; who=$(prompt_with_default "Which Samba account ($ME or WordMaker)?" "$ME")
        if [ "$who" = "$ME" ] || [ "$who" = WordMaker ]; then
          sudo smbpasswd "$who" && ok "Samba password updated for $who."
        else
          warn "Only $ME and WordMaker have Samba accounts here."
        fi
        pause_for_enter ;;
      5) do_scripts_folder && restart_wordlight
         systemctl is-active --quiet smbd 2>/dev/null && prompt_yes_no "Point the network share at it too?" "y" && do_samba_shares
         pause_for_enter ;;
      6) do_editor_login && restart_wordlight; pause_for_enter ;;
      7) do_converter; pause_for_enter ;;
      8) do_connectivity ;;
      9)
        if do_update_wordlight; then
          # This setup.sh may have been updated too: start the menu again from the new one
          pause_for_enter; exec bash "$SETUP_DIR/setup.sh"
        fi
        pause_for_enter ;;
      10) do_admin_password && restart_wordlight; pause_for_enter ;;
      11)
        info "Re-running full setup — already-completed steps will be skipped."
        return 1 ;;   # signal: fall through to the full install flow below
      0|"") echo "No changes made."; return 0 ;;
      *) warn "Not a valid option." ;;
    esac
  done
}

if [ -f "$STATE_FILE" ] && grep -qx "pm2-started" "$STATE_FILE" 2>/dev/null; then
  # Only offer the menu once a full install has actually finished (reached
  # the final step). A state file that exists but hasn't reached that point
  # yet — e.g. mid-install, paused for the I2C reboot — should silently
  # continue the install instead, not be mistaken for "already fully set up."
  if maintenance_menu; then
    exit 0
  fi
  # "Run the full setup again" falls through here
fi

# ═══════════════════════════════════════════════════════════════════════════
# FULL INSTALL
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}🔦 WordLight Setup${NC}"
echo "This will take a little while — it's installing several things and"
echo "will ask you a handful of questions along the way. It's safe to stop"
echo "and re-run at any point; it won't repeat anything already done."
echo ""
echo "Some steps need sudo, so it asks for YOUR login password once, now."
echo "Nothing shows on screen while you type it — that's normal; press Enter at the end."
command sudo -v || die "sudo didn't accept the password (or this login can't use sudo)."

# ── Step: system packages ────────────────────────────────────────────────

step "System packages"

if ! step_done "apt-updated"; then
  info "Updating package lists (this can take a minute)..."
  sudo apt update || die "apt update failed — check your internet connection."
  mark_done "apt-updated"
  ok "Package lists updated."
else
  ok "Package lists already updated — skipping."
fi

if ! step_done "system-deps-installed"; then
  info "Installing required system packages..."
  # net-tools: provides ifconfig, used by the MOTD's IP address display
  # openssl: generates WordLight's self-signed HTTPS certificate
  # i2c-tools, python3-pil, python3-lgpio: only actually used if you set up the OLED display
  #   (python3-lgpio only exists on Raspberry Pi OS, so it's only asked for there)
  # samba: for the Scripts folder network share
  # sysstat: provides pidstat, useful for troubleshooting later
  # lsof: also useful for troubleshooting later
  # unzip: installing or updating from a zip file
  PKGS=(git curl net-tools openssl samba sysstat lsof unzip python3)
  if is_pi; then PKGS+=(i2c-tools python3-pil python3-lgpio); fi
  sudo apt install -y "${PKGS[@]}" || die "Installing system packages failed — see the error above."
  mark_done "system-deps-installed"
  ok "System packages installed."
else
  ok "System packages already installed — skipping."
fi

# ── Step: time zone ───────────────────────────────────────────────────────

step "Time zone"

if ! step_done "timezone-set"; then
  for _ in 1 2 3; do do_timezone && break; echo ""; done   # asked again after an answer it couldn't use
  mark_done "timezone-set"
else
  ok "Time zone already set ($(timedatectl show -p Timezone --value 2>/dev/null)) — skipping. Change it from the menu."
fi

# ── Step: Wi-Fi country (Raspberry Pi only) ──────────────────────────────

if is_pi && ! step_done "wifi-country-set"; then
  step "Wi-Fi country"
  do_wifi_country
  mark_done "wifi-country-set"
fi

# ── Step: Node.js ─────────────────────────────────────────────────────────

step "Node.js"

NODE_MIN=22   # package.json "engines": WordLight needs Node 22 or newer

NODE_NOW=$(node_major); NODE_NOW=${NODE_NOW:-0}
if ! step_done "nodejs-installed" || [ "$NODE_NOW" -lt "$NODE_MIN" ]; then
  NEED_INSTALL=true
  if command -v node &>/dev/null; then
    CURRENT_MAJOR=$(node_major)
    if [ "$CURRENT_MAJOR" -ge "$NODE_MIN" ] 2>/dev/null; then
      ok "Node.js $(node -v) is already installed and meets the minimum ($NODE_MIN+) — leaving it as-is."
      NEED_INSTALL=false
    else
      warn "Found Node.js $(node -v), which is older than WordLight supports ($NODE_MIN+). Installing a current version."
    fi
  fi

  if [ "$NEED_INSTALL" = true ]; then
    info "Installing current Node.js LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - \
      || die "Downloading the Node.js setup script failed — check your internet connection."
    sudo apt install -y nodejs || die "Installing Node.js failed — see the error above."
    [ "$(node_major)" -ge "$NODE_MIN" ] 2>/dev/null || die "Node.js $(node -v) is still older than $NODE_MIN."
    ok "Node.js $(node -v) installed."
  fi
  mark_done "nodejs-installed"
else
  ok "Node.js already handled — skipping ($(node -v 2>/dev/null || echo 'not found — this is unexpected'))."
fi

if ! step_done "pm2-installed"; then
  info "Installing pm2 (keeps WordLight running and restarts it if it ever crashes)..."
  sudo npm install -g pm2 || die "Installing pm2 failed — see the error above."
  mark_done "pm2-installed"
  ok "pm2 installed."
else
  ok "pm2 already installed — skipping."
fi

# ── Step: OLED display (optional, may require a reboot) ─────────────────

if is_pi; then
  step "OLED status display (optional)"

  if ! step_done "oled-choice-made"; then
    echo "This is the little screen + 4 buttons showing the server's IP address"
    echo "and QR codes, if you're using one. Skip this if you don't have it"
    echo "wired up yet."
    echo ""
    if prompt_yes_no "Set up the OLED display now?" "n"; then
      mark_done "wants-oled"

      CURRENT_I2C=$(sudo raspi-config nonint get_i2c 2>/dev/null || echo "1")
      if [ "$CURRENT_I2C" = "0" ]; then
        ok "I2C is already enabled."
        mark_done "oled-choice-made"
      else
        info "Enabling I2C (required for the OLED display)..."
        sudo raspi-config nonint do_i2c 0
        mark_done "oled-choice-made"
        echo ""
        warn "I2C has just been enabled, which needs a REBOOT to fully take effect."
        echo ""
        echo "    1. Run:  sudo reboot"
        echo "    2. Log back in once it's back up"
        echo "    3. Run this script again:  ./setup.sh"
        echo ""
        echo "It will continue exactly where it left off — nothing above this"
        echo "point will need to be redone."
        exit 0
      fi
    else
      mark_done "oled-choice-made"
      info "Skipping OLED setup. You can add it later by re-running this script."
    fi
  else
    if step_done "wants-oled"; then
      ok "OLED setup was previously selected — continuing."
    else
      ok "OLED setup was previously skipped — continuing without it."
    fi
  fi

  if step_done "wants-oled" && ! step_done "oled-python-deps-installed"; then
    info "Installing Python packages for the OLED display..."
    sudo pip3 install luma.oled "qrcode[pil]" --break-system-packages \
      || die "Installing OLED Python packages failed — see the error above."
    mark_done "oled-python-deps-installed"
    ok "OLED Python packages installed."
  fi
elif ! step_done "oled-choice-made"; then
  mark_done "oled-choice-made"   # not a Raspberry Pi: no OLED
fi

# ── Step: Theater branding ───────────────────────────────────────────────

step "Theater branding"

if ! step_done "theater-name-set"; then
  echo "This name appears on the audience reader screen's welcome message."
  THEATER_NAME=$(prompt_with_default "Your theater's name" "My Theater")
  set_js_const THEATER_NAME "$THEATER_NAME" && ok "Theater name set to \"$THEATER_NAME\"."

  echo ""
  echo "Optionally, an email address for people needing help with this system."
  echo "It appears as a link on the home page, which ANYONE who scans your QR"
  echo "code can reach — so use an address you're happy for audience members"
  echo "to see. Leave blank to show no contact link at all."
  SUPPORT_EMAIL=$(prompt_with_default "Support email (optional)" "")
  if set_js_const SUPPORT_EMAIL "$SUPPORT_EMAIL"; then
    if [ -n "$SUPPORT_EMAIL" ]; then
      ok "Support email set to \"$SUPPORT_EMAIL\"."
    else
      ok "No support email set — the contact link will stay hidden."
    fi
  fi

  echo ""
  info "Logo and icon: replace public/favicon.png and public/iconlarge.png"
  info "with your own theater's images whenever you're ready — no code"
  info "changes needed, just swap the files (same filenames)."
  mark_done "theater-name-set"
else
  ok "Theater name already set — skipping."
fi

# ── Step: .env configuration ─────────────────────────────────────────────

step "Server configuration (.env)"

if ! step_done "env-file-created"; then
  if [ ! -f "$ENV_FILE" ]; then
    cp "$PROJECT_DIR/env.example" "$ENV_FILE" || die "Couldn't create .env from env.example."
  fi
  chmod 600 "$ENV_FILE"   # it's about to hold passwords

  echo "Auto-generating a secure session secret..."
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  set_env_value "SESSION_SECRET" "$SESSION_SECRET" || die "Couldn't write .env."
  ok "Session secret generated."

  echo ""
  while true; do
    ADMIN_USERNAME=$(prompt_with_default "Admin username (for /controller and /editor login)" "admin")
    valid_login_name "$ADMIN_USERNAME" && break
    warn "Use up to 32 letters, numbers and . _ - for the username."
  done
  set_env_value "ADMIN_USERNAME" "$ADMIN_USERNAME" || die "Couldn't write .env."

  ADMIN_PASSWORD=$(ask_login_password "Admin password" "" "") || die "Could not get a valid admin password."
  set_env_value "ADMIN_PASSWORD" "$ADMIN_PASSWORD" || die "Couldn't write .env."
  unset ADMIN_PASSWORD
  ok "Admin login configured."

  echo ""
  echo "By default, WordLight runs on port 3000 (redirects to HTTPS on 3443)."
  echo "You can drop the port number from URLs later by using ports 80/443"
  echo "instead — see README.md's HTTPS section for that one-time step."
  echo "Keep 3000/3443 if this is an offline caption network: the devices'"
  echo "internet checks need port 80 (setup's \"Offline caption network\" option)."
  if prompt_yes_no "Use ports 80/443 now instead of 3000/3443?" "n"; then
    info "Granting Node permission to use ports below 1024..."
    sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")" \
      || warn "setcap failed — you can run this manually later, see README.md"
    set_env_value "PORT" "80" && set_env_value "HTTPS_PORT" "443" || die "Couldn't write .env."
    ok "Configured for ports 80/443."
  else
    set_env_value "PORT" "3000" && set_env_value "HTTPS_PORT" "3443" || die "Couldn't write .env."
    ok "Using default ports 3000/3443."
  fi

  mark_done "env-file-created"
else
  ok ".env already configured — skipping. Edit .env directly to make changes."
fi

if ! step_done "editor-login-choice-made"; then
  echo ""
  if prompt_yes_no "Add an editor login for script volunteers (editor and Scripts folder only)?" "y"; then
    do_editor_login
  fi
  mark_done "editor-login-choice-made"
fi

# ── Step: npm install ─────────────────────────────────────────────────────

step "Installing WordLight's dependencies"

if ! step_done "npm-install-done"; then
  info "Running npm install (this can take a few minutes on a Pi)..."
  npm install || die "npm install failed — see the error above."
  mark_done "npm-install-done"
  ok "Dependencies installed."
else
  ok "Dependencies already installed — skipping."
fi

# ── Step: Network guidance (informational only — see note below) ────────

step "Network setup"

if ! step_done "network-guidance-shown"; then
  echo "WordLight works best with an IP address that never changes — a"
  echo "changing IP breaks any printed QR codes/instructions between shows."
  echo "This computer's addresses now: $(hostname -I 2>/dev/null)"
  echo ""
  echo -n "Are you using Ethernet or WiFi for this computer? [ethernet/wifi]: "
  read -r NETWORK_CHOICE
  echo ""
  if [[ "$NETWORK_CHOICE" =~ ^[Ee] ]]; then
    info "For Ethernet, see GETTING_STARTED.md's 'Setting a Static IP' section."
  else
    info "For WiFi, see GETTING_STARTED.md's 'Setting a Static IP' section."
  fi
  info "This computer's network connections (name, then address) — GETTING_STARTED.md asks for the name:"
  ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print "     " $2 "  " a[1]}'
  echo ""
  warn "This script does NOT change your network configuration automatically."
  warn "A mistake there could disconnect this computer from the network entirely,"
  warn "including the SSH connection you're using right now — GETTING_STARTED.md"
  warn "walks through this safely, step by step, so nothing here is rushed."
  echo ""
  if prompt_yes_no "Change this computer's name (now: $(hostname))?" "n"; then do_hostname; fi
  mark_done "network-guidance-shown"
else
  ok "Network guidance already shown — skipping."
fi

# ── Step: Scripts folder and Samba ───────────────────────────────────────

step "Scripts folder and network shares (Samba)"

if ! step_done "scripts-folder-set"; then
  for _ in 1 2 3; do do_scripts_folder && break; echo ""; done
fi

if ! step_done "samba-configured"; then
  if prompt_yes_no "Share the Scripts folder (and WordLight's files) on the network now?" "y"; then
    do_samba_shares
    ok "Samba setup complete."
  else
    mark_done "samba-configured"
    info "Skipping Samba setup. It's in the menu when you run ./setup.sh again."
  fi
else
  ok "Samba already configured — skipping. Use the menu to set it up again or reset passwords."
fi

# ── Step: MOTD (optional) ─────────────────────────────────────────────────

step "Login welcome message (optional)"

if ! step_done "motd-installed"; then
  echo "This is the message shown when someone logs into the computer over SSH —"
  echo "can show live system stats, and optionally a personalized message."
  echo ""
  echo "  1) Full version — system stats plus a personalized welcome message"
  echo "  2) Simple version — system stats only"
  echo "  3) Skip — don't set this up"
  read -rp "Choose [1-3]: " MOTD_CHOICE

  case "$MOTD_CHOICE" in
    1)
      # The welcome message is a script that runs (as root) at every login, and
      # these two go inside its text, so only plain name/email characters.
      for _ in 1 2 3; do
        CONTACT_NAME=$(prompt_with_default "Your name (shown in the welcome message)" "the IT contact")
        [[ "$CONTACT_NAME" =~ ^[[:alnum:]\ .,\'_-]{1,60}$ ]] && break
        warn "Letters, numbers, spaces and . , ' _ - only, please."; CONTACT_NAME="the IT contact"
      done
      for _ in 1 2 3; do
        CONTACT_EMAIL=$(prompt_with_default "Contact email" "")
        [[ -z "$CONTACT_EMAIL" || "$CONTACT_EMAIL" =~ ^[[:alnum:]._%+-]+@[[:alnum:].-]+$ ]] && break
        warn "That doesn't look like an email address (name@example.org)."; CONTACT_EMAIL=""
      done
      if [ -f "$SETUP_DIR/motd.template" ]; then
        sudo mkdir -p /etc/update-motd.d
        sudo rm -f /etc/update-motd.d/*
        sed -e "s|{{CONTACT_NAME}}|$(sed_repl "$CONTACT_NAME")|g" \
            -e "s|{{CONTACT_EMAIL}}|$(sed_repl "$CONTACT_EMAIL")|g" \
            "$SETUP_DIR/motd.template" | sudo tee /etc/update-motd.d/50-motd >/dev/null
        sudo chmod +x /etc/update-motd.d/50-motd
        ok "Full welcome message installed."
      else
        warn "motd.template not found in setup/ — skipping."
      fi
      ;;
    2)
      if [ -f "$SETUP_DIR/motd-simple.template" ]; then
        sudo mkdir -p /etc/update-motd.d
        sudo rm -f /etc/update-motd.d/*
        sudo cp "$SETUP_DIR/motd-simple.template" /etc/update-motd.d/50-motd
        sudo chmod +x /etc/update-motd.d/50-motd
        ok "Simple welcome message installed."
      else
        warn "motd-simple.template not found in setup/ — skipping."
      fi
      ;;
    *)
      info "Skipping the welcome message."
      ;;
  esac
  mark_done "motd-installed"
else
  ok "Welcome message already handled — skipping."
fi

# ── Step: power_report utility (optional bonus) ──────────────────────────

if is_pi && ! step_done "power-report-installed"; then
  step "Power/throttling diagnostic"
  if [ -f "$SETUP_DIR/power_report" ]; then
    cp "$SETUP_DIR/power_report" "$HOME/power_report"
    chmod +x "$HOME/power_report"
    ok "Installed ~/power_report — run it any time to check for under-voltage or thermal throttling."
  fi
  mark_done "power-report-installed"
fi

# ── Step: Start WordLight with pm2 ────────────────────────────────────────

step "Starting WordLight"

if ! step_done "wordlight-started" && pm2_has wordlight; then
  ok "WordLight is already running under pm2."
  mark_done "wordlight-started"
elif ! step_done "wordlight-started"; then
  if step_done "wants-oled"; then
    info "Starting WordLight and the OLED display with pm2..."
    pm2 start "$PROJECT_DIR/ecosystem.config.js" || die "pm2 start failed — see the error above."
  else
    info "Starting WordLight with pm2..."
    pm2 start "$PROJECT_DIR/ecosystem.config.js" --only wordlight || die "pm2 start failed — see the error above."
  fi
  pm2 save >/dev/null
  mark_done "wordlight-started"
  # WordLight makes its HTTPS certificate on its first start; give it a moment
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$PROJECT_DIR/certs/cert.pem" ] && break; sleep 1; done
else
  ok "WordLight already started with pm2 — skipping. Use 'pm2 restart wordlight' to apply .env changes."
fi

if ! step_done "boot-start-set"; then
  if boot_start_on; then
    pm2 save >/dev/null 2>&1; ok "WordLight starts by itself after a reboot (already set up)."
  elif prompt_yes_no "Start WordLight by itself after every reboot? (recommended for show computers)" "y"; then
    do_boot_start on
  else
    info "Not set: after a reboot, start it with  pm2 resurrect  (or turn it on in the menu)."
  fi
  mark_done "boot-start-set"
fi

# ── Step: Script Converter (optional) ────────────────────────────────────

step "Script Converter (optional)"

if ! step_done "converter-choice-made"; then
  if prompt_yes_no "Install the Script Converter (show script -> caption file) on this computer?" "n"; then
    do_converter || warn "The converter isn't installed yet — it's in the menu when you run ./setup.sh again."
  else
    info "Skipped. It's in the menu when you run ./setup.sh again."
  fi
  mark_done "converter-choice-made"
else
  ok "Script Converter already handled — skipping. Use the menu to install or update it."
fi

# ── Step: Offline caption network (optional) ─────────────────────────────

step "Offline caption network (optional)"

if ! step_done "connectivity-choice-made"; then
  echo "If the caption Wi-Fi has NO internet, phones may drop it or switch to"
  echo "cellular. This computer can answer their \"am I online?\" checks."
  if prompt_yes_no "Set that up now?" "n"; then
    do_connectivity once
  else
    info "Skipped. It's in the menu when you run ./setup.sh again."
  fi
  mark_done "connectivity-choice-made"
else
  ok "Offline caption network already handled — skipping. It's in the menu."
fi

mark_done "pm2-started"   # the whole install has finished: the menu from now on

# ═══════════════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════════════

step "Setup complete!"

HTTPS_PORT_VAL=$(env_get HTTPS_PORT)
echo ""
echo -e "${GREEN}${BOLD}WordLight is set up and running.${NC}"
echo ""
echo "This computer's addresses:  $(hostname -I 2>/dev/null)"
echo "Then open:  https://<that address>:${HTTPS_PORT_VAL:-3443}/home"
echo ""
echo "(The first time any device connects, it'll show a one-time security"
echo "warning because the certificate is self-signed — this is expected,"
echo "see README.md if you want the full explanation.)"
echo ""
echo "Still to do, if you haven't already:"
echo "  • Set a static IP — see GETTING_STARTED.md"
echo "  • Replace public/favicon.png and public/iconlarge.png with your logo"
echo ""
echo "Run ./setup.sh again any time for the menu: status, settings, shares,"
echo "the Script Converter, updates and password resets."
echo ""
