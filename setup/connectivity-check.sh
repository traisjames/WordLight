#!/bin/bash
#
# connectivity-check.sh — make this computer answer the "am I online?" checks
# =============================================================================
# Phones, tablets and laptops test every Wi-Fi network they join by asking a
# few well-known addresses (captive.apple.com, connectivitycheck.gstatic.com,
# www.msftconnecttest.com, ...). On a caption network with NO internet those
# checks fail, and devices drop the Wi-Fi, switch to cellular, or keep
# nagging "No internet". This script makes this computer give each check the
# exact answer the device expects, so audience devices stay on the caption
# Wi-Fi.
#
# Two parts, both needed:
#   1. DNS:  the check names must lead to this computer
#   2. HTTP: port 80 here must give each OS its exact reply (nginx)
#
# Two ways to do the DNS part:
#   Mode A  "this computer does DNS": dnsmasq runs here and answers the check
#           names. The network's DHCP must then hand out THIS computer as the
#           only DNS server. Set this up and test it BEFORE that DHCP change,
#           or every device on the network loses DNS.
#   Mode B  "the network does DNS": whoever runs the network points the check
#           names at this computer on their own DNS. Only nginx runs here.
#
# Usage (needs sudo):
#   sudo ./connectivity-check.sh                    asks for what it needs
#   sudo ./connectivity-check.sh --ip 192.168.30.2 --mode A
#   sudo ./connectivity-check.sh --test             re-run the checks only
#   sudo ./connectivity-check.sh --names            print the names for the network company
#   sudo ./connectivity-check.sh --uninstall        remove it all again
#   add --yes to skip the questions (with --ip and --mode given)
#
# Safe to run more than once. It never touches the network settings
# (Netplan), WordLight, or WordLight's ports (3000, 3443, UDP 3001).

set -uo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${BLUE}→${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }
die()  { err "$1"; exit 1; }

STATE_DIR=/etc/wordlight
STATE_FILE=$STATE_DIR/connectivity-check.state
# Which packages this script installed. Kept after --uninstall, so a later
# set-up-and-remove still knows nginx/dnsmasq were only here for this.
PKG_FILE=$STATE_DIR/connectivity-check.packages
NGINX_SITE=/etc/nginx/sites-available/connectivity-check
NGINX_LINK=/etc/nginx/sites-enabled/connectivity-check
DNSMASQ_CONF=/etc/dnsmasq.d/connectivity-check.conf
CHECK_LOG=/var/log/nginx/connectivity-check.log
DEFAULT_IP=192.168.30.2

APPLE_NAMES=(captive.apple.com www.apple.com www.appleiphonecell.com www.itools.info
             www.ibook.info www.airport.us www.thinkdifferent.us)
ANDROID_NAMES=(connectivitycheck.gstatic.com connectivitycheck.android.com clients1.google.com
               clients3.google.com www.google.com play.googleapis.com connect.rom.miui.com
               connectivitycheck.platform.hicloud.com)
WINDOWS_NAMES=(www.msftconnecttest.com ipv6.msftconnecttest.com www.msftncsi.com)
WIN_DNS_NAME=dns.msftncsi.com
WIN_DNS_ANSWER=131.107.255.255

APPLE_BODY='<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>'

# ── arguments ──────────────────────────────────────────────────────────────

IP="" MODE="" ACTION="install" YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --ip)        IP="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --ip=*)      IP="${1#*=}"; shift ;;
    --mode)      MODE="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --mode=*)    MODE="${1#*=}"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --test)      ACTION="test"; shift ;;
    --names)     ACTION="names"; shift ;;
    --yes|-y)    YES=true; shift ;;
    -h|--help)   sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "Unknown option: $1 (see --help)" ;;
  esac
done
MODE=$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')
[ -z "$MODE" ] || [ "$MODE" = A ] || [ "$MODE" = B ] || die "--mode must be A or B"

state_get() { [ -f "$STATE_FILE" ] && grep -E "^$1=" "$STATE_FILE" | tail -1 | cut -d= -f2-; }

print_names() {
  echo "Names to point at the caption computer (${1:-the address of this computer}):"
  for n in "${APPLE_NAMES[@]}" "${ANDROID_NAMES[@]}" "${WINDOWS_NAMES[@]}"; do echo "  $n"; done
  echo "And one name that must NOT point here:"
  echo "  $WIN_DNS_NAME  ->  $WIN_DNS_ANSWER"
}
if [ "$ACTION" = names ]; then print_names "${IP:-$(state_get ip)}"; exit 0; fi

[ "$(id -u)" -eq 0 ] || die "This needs sudo:  sudo $0 $*"

state_set() {
  mkdir -p "$STATE_DIR"
  touch "$STATE_FILE"
  if grep -qE "^$1=" "$STATE_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$STATE_FILE"; else echo "$1=$2" >> "$STATE_FILE"; fi
}
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep "install ok installed" >/dev/null; }
ours() { [ -f "$PKG_FILE" ] && grep -qx "$1" "$PKG_FILE"; }          # did this script install package $1?
mark_ours() { mkdir -p "$STATE_DIR"; ours "$1" || echo "$1" >> "$PKG_FILE"; }

# All IPv4 addresses on this computer, one "interface address" per line
list_ips() { ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print $2" "a[1]}'; }
has_ip() { list_ips | awk '{print $2}' | grep -x -- "$1" >/dev/null; }
valid_ip() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local o; for o in "${BASH_REMATCH[@]:1}"; do [ $((10#$o)) -le 255 ] || return 1; done
}

# Who listens on a port: prints "address program" lines (tcp and udp)
listeners() {
  ss -H -lntup "sport = :$1" 2>/dev/null | awk '{
      addr=$5; prog="?";
      if (match($0, /users:\(\("[^"]+"/)) { prog=substr($0, RSTART+9, RLENGTH-10) }
      print addr" "prog }' | sort -u
}

# ── self-test ──────────────────────────────────────────────────────────────

# A DNS question straight to one server, with Python only (no dig needed).
# Prints the first IPv4 answer, "NOANSWER", or "NOREPLY".
dns_ask() {
  python3 - "$1" "$2" <<'PY'
import socket, struct, sys, random
server, name = sys.argv[1], sys.argv[2]
qid = random.randint(0, 65535)
q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
for part in name.rstrip(".").split("."):
    q += bytes([len(part)]) + part.encode()
q += b"\x00" + struct.pack(">HH", 1, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
try:
    s.sendto(q, (server, 53))
    data, _ = s.recvfrom(2048)
except OSError:
    print("NOREPLY"); sys.exit()
an = struct.unpack(">H", data[6:8])[0]
i = 12
while data[i]:
    i += data[i] + 1
i += 5
for _ in range(an):
    if data[i] & 0xC0 == 0xC0:
        i += 2
    else:
        while data[i]:
            i += data[i] + 1
        i += 1
    rtype, _, _, rdlen = struct.unpack(">HHIH", data[i:i + 10])
    i += 10
    if rtype == 1 and rdlen == 4:
        print(".".join(str(b) for b in data[i:i + 4])); sys.exit()
    i += rdlen
print("NOANSWER")
PY
}

PASSES=0 FAILS=0
check() {   # check "<what>" <got> <want>
  if [ "$2" = "$3" ]; then ok "PASS  $1"; PASSES=$((PASSES + 1))
  else err "FAIL  $1 (got: ${2:-nothing})"; FAILS=$((FAILS + 1)); fi
}
http_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$1:80:$IP" "http://$1$2"; }
http_body()   { curl -s --max-time 5 --resolve "$1:80:$IP" "http://$1$2"; }

self_test() {
  echo ""
  echo -e "${BOLD}Self-test against $IP (mode $MODE)${NC}"
  if [ "$MODE" = A ]; then
    check "DNS  captive.apple.com -> $IP"              "$(dns_ask "$IP" captive.apple.com)" "$IP"
    check "DNS  connectivitycheck.gstatic.com -> $IP"  "$(dns_ask "$IP" connectivitycheck.gstatic.com)" "$IP"
    check "DNS  www.msftconnecttest.com -> $IP"        "$(dns_ask "$IP" www.msftconnecttest.com)" "$IP"
    check "DNS  $WIN_DNS_NAME -> $WIN_DNS_ANSWER"      "$(dns_ask "$IP" "$WIN_DNS_NAME")" "$WIN_DNS_ANSWER"
    check "DNS  any other name gets no address"        "$(dns_ask "$IP" example.com)" "NOANSWER"
  fi
  check "Apple    hotspot-detect.html: status 200"     "$(http_status captive.apple.com /hotspot-detect.html)" 200
  check "Apple    hotspot-detect.html: Success page"   "$(http_body captive.apple.com /hotspot-detect.html)" "$APPLE_BODY"
  check "Android  generate_204: status 204"            "$(http_status connectivitycheck.gstatic.com /generate_204)" 204
  check "Android  generate_204: empty reply"           "$(http_body connectivitycheck.gstatic.com /generate_204 | wc -c | tr -d ' ')" 0
  check "Windows  connecttest.txt: status 200"         "$(http_status www.msftconnecttest.com /connecttest.txt)" 200
  check "Windows  connecttest.txt: exact text"         "$(http_body www.msftconnecttest.com /connecttest.txt)" "Microsoft Connect Test"
  check "Windows  ncsi.txt (older): exact text"        "$(http_body www.msftncsi.com /ncsi.txt)" "Microsoft NCSI"
  echo ""
  if [ "$FAILS" -eq 0 ]; then ok "All $PASSES checks passed."; else err "$FAILS of $((PASSES + FAILS)) checks failed."; fi
  echo "Watch devices checking in:  sudo tail -f $CHECK_LOG"
  [ "$FAILS" -eq 0 ]
}

# ── uninstall ──────────────────────────────────────────────────────────────

uninstall() {
  local was_mode; was_mode=$(state_get mode)
  if [ "$was_mode" = A ] && [ "$YES" != true ]; then
    warn "If the network still hands out this computer as its DNS server, every"
    warn "device on it loses DNS once dnsmasq stops. Ask for that to be changed back first."
    read -rp "Remove it now? [y/N]: " a; [[ "$a" =~ ^[Yy] ]] || { echo "Nothing changed."; exit 0; }
  fi
  # Older versions kept this in the state file
  [ "$(state_get installed_nginx)" = yes ] && mark_ours nginx
  [ "$(state_get installed_dnsmasq)" = yes ] && mark_ours dnsmasq
  if [ -e "$NGINX_LINK" ] || [ -e "$NGINX_SITE" ]; then
    rm -f "$NGINX_LINK" "$NGINX_SITE"
    if command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then systemctl reload nginx 2>/dev/null; fi
    ok "Removed the nginx replies."
  fi
  if ours nginx; then
    local other_sites
    other_sites=$(find /etc/nginx/sites-enabled /etc/nginx/conf.d -mindepth 1 -maxdepth 1 ! -name default 2>/dev/null | wc -l)
    if [ "$other_sites" -eq 0 ]; then
      systemctl disable --now nginx >/dev/null 2>&1 && ok "Stopped nginx (it was only here for this)."
    else
      info "nginx was installed for this, but now serves other sites too, so it keeps running."
    fi
  fi
  if [ -e "$DNSMASQ_CONF" ]; then rm -f "$DNSMASQ_CONF"; ok "Removed the dnsmasq names."; fi
  if ours dnsmasq; then
    systemctl disable --now dnsmasq >/dev/null 2>&1 && ok "Stopped dnsmasq (it was only here for this)."
  elif pkg_installed dnsmasq && systemctl is-active --quiet dnsmasq; then
    systemctl restart dnsmasq 2>/dev/null
  fi
  rm -f "$STATE_FILE"
  info "The packages themselves are still installed. To remove them too:  sudo apt remove nginx dnsmasq"
  exit 0
}
[ "$ACTION" = uninstall ] && uninstall

# ── which address and which mode ───────────────────────────────────────────

# Set up before? Offer to keep that address and mode, or choose again.
if [ -z "$IP" ] && [ -z "$MODE" ] && [ -n "$(state_get ip)" ]; then
  if [ "$ACTION" = test ] || [ "$YES" = true ]; then
    IP=$(state_get ip); MODE=$(state_get mode)
  else
    read -rp "Keep the address $(state_get ip) and mode $(state_get mode) from last time? [Y/n]: " a
    if [[ ! "${a:-y}" =~ ^[Nn] ]]; then IP=$(state_get ip); MODE=$(state_get mode); else KEEP_ASKING=true; fi
  fi
fi
[ -n "$IP" ] || [ "${KEEP_ASKING:-}" = true ] || IP=$(state_get ip)
if [ -z "$IP" ] && [ "${KEEP_ASKING:-}" != true ] && has_ip "$DEFAULT_IP"; then IP=$DEFAULT_IP; fi
if [ -z "$IP" ]; then
  [ "$YES" = true ] && die "Give the caption-network address with --ip."
  echo "This computer's addresses:"
  list_ips | sed 's/^/  /'
  read -rp "Which address is on the caption network? " IP
fi
valid_ip "$IP" || die "\"$IP\" isn't a valid IPv4 address (four numbers 0-255, like 192.168.30.2)."
has_ip "$IP" || die "$IP isn't an address of this computer (see: ip -4 addr). Nothing changed."

[ -n "$MODE" ] || [ "${KEEP_ASKING:-}" = true ] || MODE=$(state_get mode)
if [ -z "$MODE" ]; then
  [ "$YES" = true ] && die "Choose --mode A or --mode B."
  echo ""
  echo "Who answers the DNS part?"
  echo "  A) This computer (installs dnsmasq). The network's DHCP must then give"
  echo "     out $IP as the ONLY DNS server, but only after this passes its tests."
  echo "  B) The network company's own DNS points the names here (no dnsmasq)."
  read -rp "Choose [A/B]: " MODE
  MODE=$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')
  [ "$MODE" = A ] || [ "$MODE" = B ] || die "Please choose A or B."
fi

if [ "$ACTION" = test ]; then self_test; exit $?; fi

# ── pre-checks ─────────────────────────────────────────────────────────────

MODEL=$(tr -d '\0' 2>/dev/null < /proc/device-tree/model || true)
if [[ "$MODEL" != Raspberry* ]]; then
  warn "This doesn't look like a Raspberry Pi (a test machine?). That's fine for testing;"
  warn "on show days the caption Pi is the one that must answer."
fi
[[ "$IP" == 192.168.30.* ]] || warn "$IP isn't on the caption network (192.168.30.x) — fine for a test."

blocked=false
while read -r addr prog; do
  [ -z "$addr" ] && continue
  if [ "$prog" != nginx ]; then
    err "Port 80 is already used by \"$prog\" ($addr)."
    [ "$prog" = node ] && err "That is probably WordLight set to PORT=80: set PORT=3000 in .env and restart it first."
    blocked=true
  fi
done < <(listeners 80)
if [ "$MODE" = A ]; then
  while read -r addr prog; do
    [ -z "$addr" ] && continue
    case "$addr" in 127.*|"[::1]"*) continue ;; esac       # a local resolver (systemd-resolved) is fine
    case "$addr" in "$IP":*|0.0.0.0:*|"*:"*|"[::]:"*) ;; *) continue ;; esac
    if [ "$prog" != dnsmasq ]; then err "Port 53 on $IP is already used by \"$prog\" ($addr)."; blocked=true; fi
  done < <(listeners 53)
fi
$blocked && die "Nothing was changed."

if [ "$MODE" = A ] && pkg_installed dnsmasq && ! ours dnsmasq && [ "$(state_get installed_dnsmasq)" != yes ]; then
  others=$( { grep -hvE '^\s*(#|$)' /etc/dnsmasq.conf 2>/dev/null
              find /etc/dnsmasq.d -maxdepth 1 -type f ! -name connectivity-check.conf -exec grep -hvE '^\s*(#|$)' {} + 2>/dev/null; } | wc -l)
  if [ "$others" -gt 0 ]; then
    warn "dnsmasq is already set up on this computer for something else ($others setting lines)."
    warn "This adds listen-address=$IP and no-resolv, which may change what it does now."
    if [ "$YES" != true ]; then
      read -rp "Go on anyway? [y/N]: " a; [[ "$a" =~ ^[Yy] ]] || die "Nothing was changed."
    fi
  fi
fi

# ── install ────────────────────────────────────────────────────────────────

export DEBIAN_FRONTEND=noninteractive
need_pkgs=()
pkg_installed nginx || { need_pkgs+=(nginx); mark_ours nginx; }
command -v curl >/dev/null || need_pkgs+=(curl)
if [ "$MODE" = A ] && ! pkg_installed dnsmasq; then need_pkgs+=(dnsmasq); mark_ours dnsmasq; fi

if [ "$MODE" = A ]; then
  # Written before dnsmasq is installed, so its first start already uses it.
  # Comments on their own lines: dnsmasq doesn't allow them after an option.
  mkdir -p /etc/dnsmasq.d
  {
    echo "# WordLight: answer the devices' connectivity checks (connectivity-check.sh)."
    echo "# Answers only on the caption-network address, so a local resolver is never in the way."
    echo "listen-address=$IP"
    echo "# bind-dynamic: like bind-interfaces, and it also copes with the address coming up after dnsmasq"
    echo "bind-dynamic"
    echo "# No upstream servers: every other name fails at once instead of timing out"
    echo "no-resolv"
    echo "# No DHCP here: the network's router hands out addresses"
    for n in "${APPLE_NAMES[@]}" "${ANDROID_NAMES[@]}" "${WINDOWS_NAMES[@]}"; do echo "address=/$n/$IP"; done
    echo "# Windows only looks this one up; it must NOT point here"
    echo "address=/$WIN_DNS_NAME/$WIN_DNS_ANSWER"
  } > "$DNSMASQ_CONF"
  ok "dnsmasq names written for $IP."
fi

if [ ${#need_pkgs[@]} -gt 0 ]; then
  info "Installing ${need_pkgs[*]} (needs the internet this once)..."
  apt-get update -qq || warn "apt update failed — trying the install anyway."
  apt-get install -y -qq "${need_pkgs[@]}" >/dev/null || die "Installing ${need_pkgs[*]} failed. This needs the internet once; nothing else was changed."
fi

if [ "$MODE" = A ] && [ -f /etc/default/dnsmasq ]; then
  # Keep dnsmasq from making itself THIS computer's own DNS server (resolvconf),
  # which would cut this computer off from every other name.
  if grep -qE '^#?\s*DNSMASQ_EXCEPT=' /etc/default/dnsmasq; then
    sed -i -E 's/^#?\s*DNSMASQ_EXCEPT=.*/DNSMASQ_EXCEPT="lo"/' /etc/default/dnsmasq
  else
    echo 'DNSMASQ_EXCEPT="lo"' >> /etc/default/dnsmasq
  fi
fi

{
  echo "# WordLight: the exact replies devices expect from their connectivity checks"
  echo "# (connectivity-check.sh). Port 80 only; WordLight itself is on 3000/3443."
  echo "server {"
  echo "    listen 80;"
  echo "    server_name ${APPLE_NAMES[*]};"
  echo "    access_log $CHECK_LOG;"
  echo "    default_type text/html;"
  echo "    location / {"
  echo "        return 200 '$APPLE_BODY';"
  echo "    }"
  echo "}"
  echo ""
  echo "server {"
  echo "    listen 80;"
  echo "    server_name ${ANDROID_NAMES[*]};"
  echo "    access_log $CHECK_LOG;"
  echo "    location / {"
  echo "        return 204;"
  echo "    }"
  echo "}"
  echo ""
  echo "server {"
  echo "    listen 80;"
  echo "    server_name ${WINDOWS_NAMES[*]};"
  echo "    access_log $CHECK_LOG;"
  echo "    default_type text/plain;"
  echo "    location = /connecttest.txt { return 200 'Microsoft Connect Test'; }"
  echo "    location = /ncsi.txt        { return 200 'Microsoft NCSI'; }"
  echo "    location /                  { return 404; }"
  echo "}"
} > "$NGINX_SITE"
ln -sf "$NGINX_SITE" "$NGINX_LINK"
nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx didn't accept the new site (see above)."; }
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx || die "nginx didn't start."
ok "nginx replies installed."

if [ "$MODE" = A ]; then
  systemctl enable dnsmasq >/dev/null 2>&1
  systemctl restart dnsmasq || die "dnsmasq didn't start (see: sudo journalctl -u dnsmasq -n 20)."
  ok "dnsmasq answering on $IP."
else
  if [ -e "$DNSMASQ_CONF" ]; then
    rm -f "$DNSMASQ_CONF"
    if ours dnsmasq; then systemctl disable --now dnsmasq >/dev/null 2>&1
    else systemctl restart dnsmasq >/dev/null 2>&1; fi
    ok "Mode B: removed this script's dnsmasq names (the network's DNS does it)."
  fi
fi

state_set ip "$IP"
state_set mode "$MODE"

self_test; result=$?
echo ""
if [ "$MODE" = A ]; then
  info "Next, only now that the tests pass: ask the network company to have DHCP give out"
  info "$IP as the ONLY DNS server, and to make sure devices still get a default gateway."
else
  info "Next: ask the network company to point these names at $IP on their DNS:"
  print_names "$IP" | sed 's/^/    /'
fi
echo ""
echo "Good to know:"
echo "  • Android also checks over https, which can't be answered here: it shows"
echo "    \"Limited connectivity\" and needs one tap to stay connected."
echo "  • Devices with their own encrypted DNS (Private DNS, DNS apps) skip this."
echo "  • A device that thinks the Wi-Fi has internet stops using cellular while joined."
echo "  • Devices remember the last result: to test again, Forget the network and rejoin."
exit $result
