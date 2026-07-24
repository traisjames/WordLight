#!/bin/bash
#
# setup.sh — WordLight installer & maintenance tool
# =====================================================
# Run this after a fresh Raspberry Pi OS install (or on an old Linux
# computer — everything except the OLED display steps applies there too).
#
# Safe to run more than once. The FIRST time, it walks through a full
# install. If it detects WordLight is already set up, it instead offers a
# small maintenance menu (reset passwords, etc.) instead of starting over.
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

cd "$PROJECT_DIR" || die "Could not find the WordLight project folder at $PROJECT_DIR"

# ── State tracking (what makes this safe to re-run) ─────────────────────
#
# Each completed step's name is appended as its own line in $STATE_FILE.
# step_done checks whether a given step has already run; mark_done
# records that it has. This is what lets the script be interrupted
# (e.g. for the I2C reboot) and resumed later without repeating work or
# re-asking questions that were already answered.

step_done() { [ -f "$STATE_FILE" ] && grep -qx "$1" "$STATE_FILE" 2>/dev/null; }
mark_done() { echo "$1" >> "$STATE_FILE"; }

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

# Sets KEY=VALUE in .env, replacing an existing line or appending if the
# key isn't present yet. Escapes / and & so values containing them
# (passwords, generated secrets) don't corrupt the sed replacement.
set_env_value() {
  local key="$1" value="$2"
  local escaped_value
  escaped_value=$(printf '%s' "$value" | sed -e 's/[\/&]/\\&/g')
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s/^${key}=.*/${key}=${escaped_value}/" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# MAINTENANCE MENU — shown instead of the full install if one was already run
# ═══════════════════════════════════════════════════════════════════════════

maintenance_menu() {
  echo ""
  echo -e "${BOLD}An existing WordLight setup was found on this machine.${NC}"
  echo ""
  echo "  1) Reset the Samba password for 'wordlight'"
  echo "  2) Reset the Samba password for 'WordMaker'"
  echo "  3) Reset the WordLight admin password (controller/editor login)"
  echo "  4) Run full setup again (safe — already-completed steps are skipped)"
  echo "  5) Exit without changes"
  echo ""
  read -rp "Choose an option [1-5]: " choice

  case "$choice" in
    1)
      info "You'll be asked to set a new Samba password for 'wordlight' below."
      sudo smbpasswd wordlight
      ok "Samba password updated for wordlight."
      ;;
    2)
      info "You'll be asked to set a new Samba password for 'WordMaker' below."
      sudo smbpasswd WordMaker
      ok "Samba password updated for WordMaker."
      ;;
    3)
      local new_admin_pass
      new_admin_pass=$(prompt_password "New admin password") || die "Could not get a valid password — nothing was changed."
      set_env_value "ADMIN_PASSWORD" "$new_admin_pass"
      ok "Admin password updated in .env."
      warn "This only takes effect after a restart: pm2 restart wordlight"
      ;;
    4)
      info "Re-running full setup — already-completed steps will be skipped."
      return 1   # signal: fall through to the full install flow below
      ;;
    5)
      echo "No changes made."
      ;;
    *)
      warn "Not a valid option — no changes made."
      ;;
  esac
  return 0
}

if [ -f "$STATE_FILE" ] && grep -qx "pm2-started" "$STATE_FILE" 2>/dev/null; then
  # Only offer the maintenance menu once a full install has actually
  # finished (reached the final step). A state file that exists but
  # hasn't reached that point yet — e.g. mid-install, paused for the I2C
  # reboot — should silently continue the install instead, not be
  # mistaken for "already fully set up."
  if maintenance_menu; then
    exit 0
  fi
  # choice 4 falls through here to continue into the full install below
fi

# ═══════════════════════════════════════════════════════════════════════════
# FULL INSTALL
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}🔦 WordLight Setup${NC}"
echo "This will take a little while — it's installing several things and"
echo "will ask you a handful of questions along the way. It's safe to stop"
echo "and re-run at any point; it won't repeat anything already done."

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
  # samba: for the Scripts folder network share
  # sysstat: provides pidstat, useful for troubleshooting later
  # lsof: also useful for troubleshooting later
  sudo apt install -y git curl net-tools openssl i2c-tools python3-pil python3-lgpio samba sysstat lsof \
    || die "Installing system packages failed — see the error above."
  mark_done "system-deps-installed"
  ok "System packages installed."
else
  ok "System packages already installed — skipping."
fi

# ── Step: Node.js ─────────────────────────────────────────────────────────

step "Node.js"

if ! step_done "nodejs-installed"; then
  NEED_INSTALL=true
  if command -v node &>/dev/null; then
    CURRENT_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "$CURRENT_MAJOR" -ge 18 ] 2>/dev/null; then
      ok "Node.js $(node -v) is already installed and meets the minimum (18+) — leaving it as-is."
      NEED_INSTALL=false
    else
      warn "Found Node.js $(node -v), which is older than this project supports (18+). Installing a current version."
    fi
  fi

  if [ "$NEED_INSTALL" = true ]; then
    info "Installing current Node.js LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - \
      || die "Downloading the Node.js setup script failed — check your internet connection."
    sudo apt install -y nodejs || die "Installing Node.js failed — see the error above."
    ok "Node.js $(node -v) installed."
  fi
  mark_done "nodejs-installed"
else
  ok "Node.js already handled — skipping ($(node -v 2>/dev/null || echo 'not found — this is unexpected')))."
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

step "OLED status display (optional)"

if ! step_done "oled-choice-made"; then
  echo "This is the little screen + 4 buttons showing the server's IP address"
  echo "and QR codes, if you're using one. Skip this if you're running"
  echo "WordLight on a computer without one, or don't have it wired up yet."
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

# ── Step: Theater branding ───────────────────────────────────────────────

step "Theater branding"

if ! step_done "theater-name-set"; then
  echo "This name appears on the audience reader screen's welcome message."
  THEATER_NAME=$(prompt_with_default "Your theater's name" "My Theater")
  GLOBAL_JS="$PROJECT_DIR/public/global.js"
  if [ -f "$GLOBAL_JS" ]; then
    # Escape sed special characters in the theater name before substituting
    ESCAPED_NAME=$(printf '%s' "$THEATER_NAME" | sed -e "s/[\/&]/\\\\&/g")
    sed -i "s/const THEATER_NAME = '.*';/const THEATER_NAME = '${ESCAPED_NAME}';/" "$GLOBAL_JS"
    ok "Theater name set to \"$THEATER_NAME\"."
  else
    warn "Couldn't find public/global.js — set THEATER_NAME there manually later."
  fi

  echo ""
  echo "Optionally, an email address for people needing help with this system."
  echo "It appears as a link on the home page, which ANYONE who scans your QR"
  echo "code can reach — so use an address you're happy for audience members"
  echo "to see. Leave blank to show no contact link at all."
  SUPPORT_EMAIL=$(prompt_with_default "Support email (optional)" "")
  if [ -f "$GLOBAL_JS" ]; then
    ESCAPED_EMAIL=$(printf '%s' "$SUPPORT_EMAIL" | sed -e "s/[\/&]/\\\\&/g")
    sed -i "s/const SUPPORT_EMAIL = '.*';/const SUPPORT_EMAIL = '${ESCAPED_EMAIL}';/" "$GLOBAL_JS"
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
  ok "Theater name already set — skipping. Re-run and choose option 4 to change it."
fi

# ── Step: .env configuration ─────────────────────────────────────────────

step "Server configuration (.env)"

if ! step_done "env-file-created"; then
  if [ ! -f "$ENV_FILE" ]; then
    cp "$PROJECT_DIR/.env.example" "$ENV_FILE" || die "Couldn't create .env from .env.example."
  fi

  echo "Auto-generating a secure session secret..."
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  set_env_value "SESSION_SECRET" "$SESSION_SECRET"
  ok "Session secret generated."

  echo ""
  ADMIN_USERNAME=$(prompt_with_default "Admin username (for /controller and /editor login)" "admin")
  set_env_value "ADMIN_USERNAME" "$ADMIN_USERNAME"

  ADMIN_PASSWORD=$(prompt_password "Admin password") || die "Could not get a valid admin password."
  set_env_value "ADMIN_PASSWORD" "$ADMIN_PASSWORD"
  ok "Admin login configured."

  echo ""
  echo "By default, WordLight runs on port 3000 (redirects to HTTPS on 3443)."
  echo "You can drop the port number from URLs later by using ports 80/443"
  echo "instead — see README.md's HTTPS section for that one-time step."
  if prompt_yes_no "Use ports 80/443 now instead of 3000/3443?" "n"; then
    info "Granting Node permission to use ports below 1024..."
    sudo setcap 'cap_net_bind_service=+ep' "$(which node)" \
      || warn "setcap failed — you can run this manually later, see README.md"
    set_env_value "PORT" "80"
    set_env_value "HTTPS_PORT" "443"
    ok "Configured for ports 80/443."
  else
    set_env_value "PORT" "3000"
    set_env_value "HTTPS_PORT" "3443"
    ok "Using default ports 3000/3443."
  fi

  mark_done "env-file-created"
else
  ok ".env already configured — skipping. Edit .env directly to make changes."
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
  echo ""
  echo -n "Are you using Ethernet or WiFi for this Pi? [ethernet/wifi]: "
  read -r NETWORK_CHOICE
  echo ""
  if [[ "$NETWORK_CHOICE" =~ ^[Ee] ]]; then
    info "For Ethernet, see GETTING_STARTED.md's 'Setting a Static IP' section"
    info "(interface name is usually eth0)."
  else
    info "For WiFi, see GETTING_STARTED.md's 'Setting a Static IP' section"
    info "(interface name is usually wlan0)."
  fi
  echo ""
  warn "This script does NOT change your network configuration automatically."
  warn "A mistake there could disconnect this Pi from the network entirely,"
  warn "including the SSH connection you're using right now — GETTING_STARTED.md"
  warn "walks through this safely, step by step, so nothing here is rushed."
  mark_done "network-guidance-shown"
else
  ok "Network guidance already shown — skipping."
fi

# ── Step: Samba (Scripts folder sharing) ─────────────────────────────────

step "Script storage (Samba)"

if ! step_done "samba-configured"; then
  if prompt_yes_no "Set up the Scripts network share now?" "y"; then
    info "Creating the scriptusers group and WordMaker account..."
    getent group scriptusers >/dev/null || sudo groupadd scriptusers
    id WordMaker &>/dev/null || sudo useradd --no-create-home --shell /usr/sbin/nologin -G scriptusers WordMaker
    sudo usermod -a -G scriptusers "$(whoami)"

    SCRIPTS_DIR="$HOME/Scripts"
    mkdir -p "$SCRIPTS_DIR"
    sudo chgrp scriptusers "$SCRIPTS_DIR"
    sudo chmod 2775 "$SCRIPTS_DIR"
    ok "Scripts folder ready at $SCRIPTS_DIR"

    if [ -f /etc/samba/smb.conf ]; then
      sudo cp /etc/samba/smb.conf "/etc/samba/smb.conf.backup-$(date +%s)"
      info "Backed up your existing Samba config before making changes."
    fi

    if [ -f "$SETUP_DIR/smb.conf.template" ]; then
      if [ ! -d /etc/samba ]; then
        warn "/etc/samba doesn't exist — Samba may not have installed correctly."
        warn "Skipping the Samba config file install. Check 'sudo apt install samba' ran without errors, then re-run this script."
      else
        sudo cp "$SETUP_DIR/smb.conf.template" /etc/samba/smb.conf
        sudo systemctl restart smbd nmbd 2>/dev/null || sudo systemctl restart smb nmb 2>/dev/null \
          || warn "Couldn't restart Samba services automatically — you may need to reboot."
        ok "Samba configuration installed."
      fi
    else
      warn "smb.conf.template not found in setup/ — skipping Samba config file install."
    fi

    echo ""
    echo "Now set Samba passwords for the two accounts that can access the"
    echo "Scripts share. Anyone without one of these gets read-only access."
    echo ""
    info "Setting Samba password for 'wordlight' (full access):"
    sudo smbpasswd -a "$(whoami)"
    info "Setting Samba password for 'WordMaker' (Scripts folder only):"
    sudo smbpasswd -a WordMaker

    mark_done "samba-configured"
    ok "Samba setup complete."
  else
    mark_done "samba-configured"
    info "Skipping Samba setup. Re-run this script to set it up later."
  fi
else
  ok "Samba already configured — skipping. Use the maintenance menu to reset passwords."
fi

# ── Step: MOTD (optional) ─────────────────────────────────────────────────

step "Login welcome message (optional)"

if ! step_done "motd-installed"; then
  echo "This is the message shown when someone logs into the Pi over SSH —"
  echo "can show live system stats, and optionally a personalized message."
  echo ""
  echo "  1) Full version — system stats plus a personalized welcome message"
  echo "  2) Simple version — system stats only"
  echo "  3) Skip — don't set this up"
  read -rp "Choose [1-3]: " MOTD_CHOICE

  case "$MOTD_CHOICE" in
    1)
      CONTACT_NAME=$(prompt_with_default "Your name (shown in the welcome message)" "the IT contact")
      CONTACT_EMAIL=$(prompt_with_default "Contact email" "")
      if [ -f "$SETUP_DIR/motd.template" ]; then
        sudo mkdir -p /etc/update-motd.d
        sudo rm -f /etc/update-motd.d/*
        sed -e "s/{{CONTACT_NAME}}/${CONTACT_NAME}/g" \
            -e "s/{{CONTACT_EMAIL}}/${CONTACT_EMAIL}/g" \
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

step "Power/throttling diagnostic (optional)"

if ! step_done "power-report-installed"; then
  if [ -f "$SETUP_DIR/power_report" ]; then
    cp "$SETUP_DIR/power_report" "$HOME/power_report"
    chmod +x "$HOME/power_report"
    ok "Installed ~/power_report — run it any time to check for under-voltage or thermal throttling."
  fi
  mark_done "power-report-installed"
fi

# ── Step: Start WordLight with pm2 ────────────────────────────────────────

step "Starting WordLight"

if ! step_done "pm2-started"; then
  info "Starting WordLight (and the OLED display, if enabled) with pm2..."
  pm2 start "$PROJECT_DIR/ecosystem.config.js" || die "pm2 start failed — see the error above."
  pm2 save

  echo ""
  info "One manual step left: making WordLight start automatically on boot."
  echo "pm2 needs you to copy-paste ONE command it generates below — this"
  echo "changes based on your exact system, so it can't be fully automated:"
  echo ""
  pm2 startup | tail -n 5
  echo ""
  warn "Copy the 'sudo env PATH=...' line above (if shown) and run it now."

  mark_done "pm2-started"
else
  ok "WordLight already started with pm2 — skipping. Use 'pm2 restart wordlight' to apply .env changes."
fi

# ═══════════════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════════════

step "Setup complete!"

HTTPS_PORT_VAL=$(grep '^HTTPS_PORT=' "$ENV_FILE" | cut -d= -f2)
echo ""
echo -e "${GREEN}${BOLD}WordLight is set up and running.${NC}"
echo ""
echo "Find this Pi's address with:  hostname -I"
echo "Then open:  https://<that address>:${HTTPS_PORT_VAL}/home"
echo ""
echo "(The first time any device connects, it'll show a one-time security"
echo "warning because the certificate is self-signed — this is expected,"
echo "see README.md if you want the full explanation.)"
echo ""
echo "Still to do, if you haven't already:"
echo "  • Set a static IP — see GETTING_STARTED.md"
echo "  • Replace public/favicon.png and public/iconlarge.png with your logo"
echo "  • Run the 'pm2 startup' command shown above, if you haven't yet"
echo ""
echo "Re-run this script (./setup.sh) any time — it'll offer a menu to"
echo "reset passwords instead of starting over."
echo ""
