/**
 * WordLight — server.js
 * This is the file Node.js and NPM use to configure the server.
 * This file should be in the top folder for the caption application.
 * 
 */

// dotenv MUST be loaded before anything below reads process.env — otherwise
// every process.env.X || default falls through to the default every time,
// silently ignoring whatever is in .env. This bug existed for a long time:
// PORT, OSC_PORT, ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET were
// all being read before dotenv had loaded the file, so .env was effectively
// never applied no matter what it contained.
require('dotenv').config();

// --- Set port for server.
// Default 3000 works out of the box. To use port 80 (no ":3000" in URLs
// or QR codes), first run this one-time command on the Pi:
//   sudo setcap 'cap_net_bind_service=+ep' $(which node)
// Then set PORT=80 in your .env file. See env.example for details.
const PORT           = process.env.PORT           || 3000;
// --- Port for the REAL app over HTTPS. This is where browsers/QR codes
// actually connect once HTTPS is set up — PORT above becomes a simple
// redirect to this port instead. Default 3443 works with no extra setup;
// use 443 (no ":3443" in URLs) with the same setcap command as PORT above.
const HTTPS_PORT     = process.env.HTTPS_PORT      || 3443;
// --- Set to "false" to run plain HTTP only — an intentional choice, not
// just what happens if certificate generation fails. Defaults to enabled;
// nothing needs to be set for HTTPS to work normally. Useful if HTTPS ever
// causes a problem you haven't tracked down yet, or if you'd simply rather
// not deal with the one-time browser security warning on new devices.
// PORT above becomes the ONLY port in this mode — no redirect, since
// there's nothing to redirect to.
const HTTPS_ENABLED  = process.env.HTTPS_ENABLED   !== 'false';
// --- OSC (Open Sound Control) port for lighting/sound board integration
const OSC_PORT       = process.env.OSC_PORT       || 3001;
// --- Script Converter on this same Pi (optional). The controller page shows
// a "Pause 6 hours" button while the converter has unfinished work; WordLight
// asks the converter for that over this address. It must be on this computer
// (the converter only answers these requests from itself). http or https both
// work: if one fails, WordLight tries the other. Set to "off" to never ask.
const CONVERTER_URL  = process.env.CONVERTER_URL  || 'http://127.0.0.1:8090';
// --- Set the user name and password to access the Caption Controller and Logging.
// The fallbacks are named constants so the "you're still on defaults"
// warning further down compares against the REAL values. It previously
// checked a hardcoded string that matched neither default, so it could
// never actually fire.
const DEFAULT_ADMIN_PASSWORD = 'changeme';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
// --- Optional second login for script volunteers: the editor and the Scripts
// folder only, never the controller or logging. Leave EDITOR_PASSWORD unset to
// have no editor login (then the editor needs the admin login, as before).
const EDITOR_USERNAME = process.env.EDITOR_USERNAME || 'editor';
const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD || '';
// --- The Scripts folder (the "CC Storage" share setup.sh makes). The editor and
// the controller can open caption files from it, and the editor can save to
// it, straight from the browser. SCRIPTS_NAME is what the pages call it.
const SCRIPTS_DIR    = process.env.SCRIPTS_DIR    || require('path').join(require('os').homedir(), 'Scripts');
const SCRIPTS_NAME   = process.env.SCRIPTS_NAME   || 'Scripts';

// --- Secret string used for encryption.  For our use, we are not too worried about this, but...
// --- Usually you would use long random string for session security
// --- Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const DEFAULT_SESSION_SECRET = 'lightword-closed-captions';
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;


/**
 *
 * DO NOT CHANGE VALUES BELOW THIS LINE!
 *
 */

const express      = require('express');
const http         = require('http');
const https        = require('https');
const net          = require('net');
const fs           = require('fs');
const { execSync } = require('child_process');
const socketIo     = require('socket.io');
const session      = require('cookie-session');
const cookieParser = require('cookie-parser');
const path         = require('path');
const crypto       = require('crypto');

// --- pm2.io custom metrics ----------------------------------------------------
// Exposes live server state (connected readers, current line, intermission,
// etc.) in the pm2.io / PM2 Plus remote dashboard, without needing to open
// any of the app's own pages. Requiring this is harmless even when the
// process isn't linked to pm2.io — it just runs as a local no-op agent —
// so it's safe to leave in for every deployment.
// Named pm2io (not io) because the socket.io server instance below is
// already called "io" throughout this file.
const pm2io = require('@pm2/io');
const QRCode       = require('qrcode');
const { networkInterfaces } = require('os');
const dgram           = require('dgram');  // built-in — no package needed for OSC
const { ScriptsFolder, ScriptsError, MAX_BYTES: SCRIPTS_MAX_BYTES } = require('./scripts-folder');
const scriptsFolder   = new ScriptsFolder(SCRIPTS_DIR, SCRIPTS_NAME);

const app    = express();

// ── Detect this Pi's LAN IP addresses ──────────────────────────────────────
//
// Needed BEFORE the server is created, not after — the self-signed HTTPS
// certificate below needs to know every IP address the Pi might be reached
// at, so it can include them all. Moved here (early) from where this used
// to live near the bottom of the file for exactly that reason.
//
// serverInterfaces additionally keeps the INTERFACE NAME each address came
// from (e.g. 'wlan0', 'eth0') — used by /api/network-info to label
// addresses meaningfully for the controller page's connection-info tooltip.
let serverIPs = [];
let serverInterfaces = {};
(function detectIPs() {
  const nets = networkInterfaces();
  for (const [name, ifaces] of Object.entries(nets)) {
    for (const iface of ifaces) {
      const v4 = typeof iface.family === 'string' ? 'IPv4' : 4;
      if (iface.family === v4 && !iface.internal) {
        serverIPs.push(iface.address);
        serverInterfaces[name] = iface.address;
      }
    }
  }
})();

// ── Self-signed HTTPS certificate ────────────────────────────────────────
//
// A real certificate authority won't issue a certificate for a private LAN
// IP address, so this generates our own. Browsers will show a one-time
// "connection not private" warning on each new device the first time it
// connects — expected and harmless on a private venue network, not a sign
// anything is wrong. What this DOES unlock: HTTPS is required for the
// Wake Lock API, which is what keeps an audience member's phone screen
// from auto-locking mid-show.
//
// The certificate is regenerated automatically whenever it doesn't already
// cover every IP address this Pi currently has — so moving the Pi to a
// different venue's WiFi (a different IP) "just works" on the next start,
// with no manual step to remember. A small metadata file next to the
// certificate tracks which IPs it was last generated for.
const CERT_DIR       = path.join(__dirname, 'certs');
const CERT_FILE      = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE       = path.join(CERT_DIR, 'key.pem');
const CERT_META_FILE = path.join(CERT_DIR, 'cert-meta.json');

function generateOrRefreshCert() {
  const coverageNeeded = [...new Set([...serverIPs, '127.0.0.1'])];

  let needsRegen = true;
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE) && fs.existsSync(CERT_META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(CERT_META_FILE, 'utf8'));
      const covered = new Set(meta.ips || []);
      needsRegen = !coverageNeeded.every(ip => covered.has(ip));
    } catch (e) {
      needsRegen = true;   // metadata unreadable/corrupt — regenerate to be safe
    }
  }

  if (!needsRegen) {
    console.log('   HTTPS:    using existing certificate (covers current IP addresses)');
    return;
  }

  console.log('   HTTPS:    generating self-signed certificate for: ' + coverageNeeded.join(', '));
  fs.mkdirSync(CERT_DIR, { recursive: true });

  // subjectAltName is what modern browsers actually check — a bare CN is
  // ignored by every current browser. IP: entries are required (not DNS:)
  // for the certificate to be considered valid when accessed by IP address,
  // which is how this will almost always be reached on a LAN.
  const sanEntries = [
    'DNS:localhost',
    ...coverageNeeded.map(ip => `IP:${ip}`),
  ].join(',');

  const opensslCmd = [
    'openssl req -x509 -newkey rsa:2048',
    `-keyout "${KEY_FILE}"`,
    `-out "${CERT_FILE}"`,
    '-days 3650 -nodes',                 // 10 years — no external CA lifetime limits apply to a self-signed cert
    '-subj "/CN=WordLight"',
    `-addext "subjectAltName=${sanEntries}"`,
  ].join(' ');

  execSync(opensslCmd, { stdio: 'pipe' });
  fs.chmodSync(KEY_FILE, 0o600);   // private key — restrict to owner only
  fs.writeFileSync(CERT_META_FILE, JSON.stringify({
    ips:         coverageNeeded,
    generatedAt: new Date().toISOString(),
  }, null, 2));
  console.log('   HTTPS:    certificate generated successfully');
}

// ── Create the server — HTTPS if enabled and possible, plain HTTP otherwise ──
//
// Two distinct paths lead to plain HTTP: HTTPS_ENABLED=false (an
// intentional choice) or a certificate generation failure (e.g. openssl
// missing). Either way, the server must still start — captions need to
// work even without HTTPS, just without the Wake Lock benefit. The
// startup log below tells you which of the two reasons applies.
let usingHttps = HTTPS_ENABLED;

if (!HTTPS_ENABLED) {
  console.log('   HTTPS:    disabled (HTTPS_ENABLED=false in .env) — running plain HTTP only');
} else {
  try {
    generateOrRefreshCert();
  } catch (err) {
    usingHttps = false;
    console.error('\n⚠️  Could not generate HTTPS certificate:', err.message);
    console.error('   Falling back to plain HTTP — Wake Lock will be unavailable.');
    console.error('   Check that openssl is installed: sudo apt-get install -y openssl\n');
  }
}

let server;
if (usingHttps) {
  server = https.createServer({
    key:  fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  }, app);
} else {
  server = http.createServer(app);
}

// Caption scripts travel as a single socket payload. socket.io's default
// maxHttpBufferSize is 1 MB, which a long musical can exceed — and when it
// does, the packet is dropped at the transport layer with no application
// error. The controller would show the script loaded while every reader
// still had the previous one: an operator advancing lines in front of an
// audience seeing something else. Raised here, and enforced properly in
// the load-script handler below so oversized scripts get a real message.
const io = socketIo(server, {
  maxHttpBufferSize: 10 * 1024 * 1024,   // 10 MB
});

// Caption script limits. Generous — a long musical runs maybe 2,000–3,000
// lines and a caption line is a sentence — but bounded, so a malformed or
// malicious file can't exhaust memory on a Pi.
const MAX_SCRIPT_LINES = 20000;
const MAX_LINE_LENGTH  = 5000;


// Warn loudly if this install is still running on shipped defaults.
// Anyone who reads the public source knows these values, so an install
// that skipped .env setup has effectively no admin protection at all.
if (EDITOR_PASSWORD && EDITOR_PASSWORD === ADMIN_PASSWORD) {
  console.warn('\n⚠️  EDITOR_PASSWORD is the same as ADMIN_PASSWORD, so the editor login also');
  console.warn('   opens the controller. Give the editor login its own password in .env.\n');
}
if (EDITOR_PASSWORD && EDITOR_USERNAME === ADMIN_USERNAME) {
  console.warn('\n⚠️  EDITOR_USERNAME is the same as ADMIN_USERNAME; the editor login is off.');
  console.warn('   Give it its own name in .env (default: editor).\n');
}
if (SESSION_SECRET === DEFAULT_SESSION_SECRET || ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
  console.warn('\n⚠️  WARNING: still using default credentials!');
  if (ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
    console.warn('   ADMIN_PASSWORD is the shipped default — anyone can log in to');
    console.warn('   the controller, editor, and logging pages.');
  }
  if (SESSION_SECRET === DEFAULT_SESSION_SECRET) {
    console.warn('   SESSION_SECRET is the shipped default — login sessions are forgeable.');
  }
  console.warn('   Fix: copy env.example to .env and set real values, then restart.');
  console.warn('   Generate a secret with:');
  console.warn('     node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Named so the same middleware can be applied to socket.io handshakes below.
// Without that, sockets have no idea who's connecting.
const sessionMiddleware = session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 12 * 60 * 60 * 1000 } // Session is for 12 hours
});
app.use(sessionMiddleware);

// ── Socket authentication ──────────────────────────────────────────────────
//
// Sockets used to trust socket.handshake.query.type completely. Every control
// handler checked `if (clientType !== 'controller') return;` — but the client
// chose that value itself. Anyone who could reach the server could connect
// with ?type=controller and replace the script, jump lines, trigger
// intermission, or broadcast arbitrary text to every audience phone. The
// /controller PAGE was behind a login; the socket carrying all the actual
// control was not. On a venue network where the address is printed on a QR
// code in the lobby, that's a real path in.
//
// Now the Express session is shared with the handshake and checked before the
// connection is accepted.
io.engine.use(sessionMiddleware);

// Types that are legitimately public. The audience can't log in — they scan a
// QR code — so reader-family pages must stay open. These types can only
// receive broadcasts; none of the control handlers accept them.
const PUBLIC_SOCKET_TYPES = new Set(['reader', 'home']);
// Types that can change what the audience sees. These require a real session.
const PRIVILEGED_SOCKET_TYPES = new Set(['controller', 'logging']);

io.use((socket, next) => {
  const requested = socket.handshake.query.type;

  if (PUBLIC_SOCKET_TYPES.has(requested)) {
    socket.data.clientType = requested;
    return next();
  }

  if (PRIVILEGED_SOCKET_TYPES.has(requested)) {
    if (socket.request.session && socket.request.session.authenticated) {
      socket.data.clientType = requested;
      return next();
    }
    console.warn(`[socket] Rejected unauthenticated '${requested}' connection from ` +
                 `${socket.handshake.address}`);
    return next(new Error('AUTH_REQUIRED'));
  }

  // Unknown type — reject rather than guess. Anything legitimate is listed above.
  console.warn(`[socket] Rejected unknown client type '${requested}' from ` +
               `${socket.handshake.address}`);
  return next(new Error('UNKNOWN_CLIENT_TYPE'));
});
// Block direct .html requests to auth-protected pages so express.static
// cannot serve them without hitting requireAuth.
const PROTECTED_PAGES = ['controller.html', 'logging.html', 'editor.html'];
app.use((req, res, next) => {
  const file = req.path.replace(/^\//, '').toLowerCase();
  if (PROTECTED_PAGES.includes(file)) {
    return res.redirect(req.path.replace(/\.html$/i, ''));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// --- State -------------------------------------------------------------------

let captionState = {
  lines:        [],
  currentIndex: -1,
  liveText:     '',
  intermission: false,
  oscArmed:     false
};

let uniqueReaderIds   = new Set();
let totalSessionCount = 0;
const MAX_LOG  = 5000;
let sessionLog = [];

// --- pm2.io custom metrics ----------------------------------------------------
//
// These show up in the pm2.io / PM2 Plus dashboard under the app's "Custom
// Metrics" section — useful for seeing what the server is doing right now
// (who's connected, what line is showing) without opening any of the app's
// own pages. Metrics are simple named values updated via .set() whenever the
// underlying state changes; see updateXMetrics() below for where each is
// refreshed.

const connectedReadersMetric     = pm2io.metric({ name: 'Connected Readers' });
const connectedControllersMetric = pm2io.metric({ name: 'Connected Controllers' });
const currentLineMetric          = pm2io.metric({ name: 'Current Line' });
const currentCaptionMetric       = pm2io.metric({ name: 'Current Caption' });
const intermissionMetric         = pm2io.metric({ name: 'Intermission' });
const oscArmedMetric             = pm2io.metric({ name: 'OSC Armed' });
const uniqueReadersMetric        = pm2io.metric({ name: 'Unique Readers (Session)' });
const totalSessionsMetric        = pm2io.metric({ name: 'Total Sessions' });

// Environmental metrics reported by oled_display.py — pushed via
// POST /api/oled-metrics roughly every 10 seconds rather than computed
// here, since these describe the Pi's own hardware/network state, not
// anything server.js can see on its own.
const cpuTempMetric        = pm2io.metric({ name: 'CPU Temperature (°C)' });
const wifiIpMetric         = pm2io.metric({ name: 'WiFi IP' });
const ethIpMetric          = pm2io.metric({ name: 'Ethernet IP' });
const wifiSignalMetric     = pm2io.metric({ name: 'WiFi Signal (dBm)' });
const wifiQualityMetric    = pm2io.metric({ name: 'WiFi Link Quality (%)' });

// Strip [color]/[b]/[i]/[u] style tags and any |note suffix from a raw script
// line, for a clean, readable value in the "Current Caption" metric. This is
// a lightweight server-side equivalent of what parseColorTags/stripNote do
// in public/global.js — kept separate since the server doesn't load that
// client-side file.
function stripForMetric(raw) {
  if (!raw) return '';
  let out = raw.replace(/\[[a-zA-Z\/]+\]/g, '');   // remove [red], [/], [b], etc.
  const pipe = out.indexOf('|');
  if (pipe !== -1) out = out.slice(0, pipe);         // drop the speaker note
  return out.trim();
}

function updateConnectionMetrics() {
  connectedReadersMetric.set(io.sockets.adapter.rooms.get('readers')?.size || 0);
  connectedControllersMetric.set(io.sockets.adapter.rooms.get('controllers')?.size || 0);
}

// Live count of AUDIENCE readers only — excludes backstage. Backstage
// clients join both 'readers' (so broadcasts still reach them) and
// 'backstage' (so they can be subtracted back out here), so this is always
// exactly in sync with real room membership — no separate counter to drift.
function getAudienceReaderCount() {
  const totalReaders   = io.sockets.adapter.rooms.get('readers')?.size   || 0;
  const backstageCount = io.sockets.adapter.rooms.get('backstage')?.size || 0;
  return Math.max(0, totalReaders - backstageCount);
}

// Pushes the current audience-only count to every open controller tab.
// Called whenever the count could have changed — a reader connecting or
// disconnecting — so the live number on /controller stays current without
// polling.
function emitAudienceCount() {
  io.to('controllers').emit('audience-count', { count: getAudienceReaderCount() });
}

// Who is connected right now, for the Script Converter's pause rules
// (GET /api/connections below). Read straight from the socket.io rooms, like
// the counts above, so a closed tab drops out the moment its socket closes,
// and a phone that went to sleep drops out when it misses socket.io's
// heartbeat (about 45 seconds). The teleprompter connects as backstage.
// The home, logging and editor pages are not counted: none of them means a
// show is on (the editor doesn't connect to the server at all).
function getConnectionCounts() {
  return {
    controllers: io.sockets.adapter.rooms.get('controllers')?.size || 0,
    readers:     getAudienceReaderCount(),
    backstage:   io.sockets.adapter.rooms.get('backstage')?.size || 0,
  };
}

// True when a request comes from this computer itself (loopback) — for the
// endpoints only other programs on the Pi should reach: oled_display.py's
// metrics and the Script Converter's "who is connected?".
function isLocalRequest(req) {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// GET /api/connections — served on the main port AND on the plain-http
// redirect port (see the redirect server near the bottom), so the converter's
// default address, http://127.0.0.1:3000/api/connections, gets an answer
// directly whether or not HTTPS is on, without a redirect and a TLS
// handshake every two seconds.
function sendConnections(req, res) {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: 'This endpoint only accepts local requests' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(getConnectionCounts());
}

// POST /api/check-admin — the Script Converter's bypass, for testing: one
// script may be sent to run whatever the converter's pause rules say, but
// only with the CC Server password (this admin password, never the editor
// password). The converter asks here rather than keeping a copy. Like
// /api/connections it answers programs on this computer only, and on the
// plain-http port too. Answers {ok:true} or {ok:false, error}; the password
// is never logged or sent back. A wrong one is answered a second later, and
// after 5 wrong ones in 15 minutes every try is refused until they age out.
// The shipped default password ('changeme') never unlocks it.
const ADMIN_CHECK_LIMIT     = 5;
const ADMIN_CHECK_WINDOW_MS = 15 * 60 * 1000;
const adminCheckFailures    = [];   // times of wrong passwords

function samePassword(given, real) {
  // compare fixed-length hashes, so the time taken says nothing about the password
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(real)).digest();
  return crypto.timingSafeEqual(a, b);
}

function checkAdminPassword(req, res) {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ ok: false, error: 'This endpoint only accepts local requests' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  while (adminCheckFailures.length && now - adminCheckFailures[0] > ADMIN_CHECK_WINDOW_MS) {
    adminCheckFailures.shift();
  }
  if (adminCheckFailures.length >= ADMIN_CHECK_LIMIT) {
    return res.status(429).json({ ok: false,
      error: 'Too many wrong CC Server passwords. Try again in 15 minutes.' });
  }
  if (ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
    return res.json({ ok: false, error: 'WordLight still has its default admin password, so ' +
      'it can\'t unlock the bypass. Set ADMIN_PASSWORD in .env first.' });
  }
  const given = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (given && samePassword(given, ADMIN_PASSWORD)) {
    console.log('[converter] Script Converter bypass: the CC Server password was given');
    return res.json({ ok: true });
  }
  adminCheckFailures.push(now);
  console.log('[converter] Script Converter bypass: a wrong CC Server password was given');
  setTimeout(() => res.json({ ok: false, error: 'That isn\'t the CC Server password.' }), 1000);
}

function updateSessionMetrics() {
  uniqueReadersMetric.set(uniqueReaderIds.size);
  totalSessionsMetric.set(totalSessionCount);
}

function updateLineMetrics() {
  const total = Array.isArray(captionState.lines) ? captionState.lines.length : 0;
  const idx   = captionState.currentIndex;

  currentLineMetric.set(
    total > 0 && idx >= 0 ? `${idx + 1} / ${total}` : 'No script loaded'
  );

  let captionText;
  if (captionState.liveText && captionState.liveText.trim().length > 0) {
    captionText = 'LIVE: ' + stripForMetric(captionState.liveText);
  } else if (total > 0 && idx >= 0 && idx < total) {
    const text = stripForMetric(captionState.lines[idx]);
    captionText = text.length > 0 ? text : '(blank line)';
  } else {
    captionText = '(no script loaded)';
  }
  // Keep it short — pm2.io's dashboard shows metric values in a compact space.
  currentCaptionMetric.set(captionText.length > 60 ? captionText.slice(0, 57) + '...' : captionText);
}

function updateShowStateMetrics() {
  intermissionMetric.set(captionState.intermission ? 'ON' : 'off');
  oscArmedMetric.set(captionState.oscArmed ? 'ARMED' : 'off');
}

// --- Auth ---------------------------------------------------------------------

// Two logins: the admin login (ADMIN_USERNAME) opens everything; the editor
// login (EDITOR_USERNAME, only when EDITOR_PASSWORD is set) opens the editor
// and the Scripts folder, never the controller or logging. A session from
// the editor login has session.editor set and session.authenticated unset,
// so every existing admin check (pages and sockets) keeps refusing it.
function isAdmin(req)  { return !!(req.session && req.session.authenticated); }
function isEditor(req) { return isAdmin(req) || !!(req.session && req.session.editor); }

function requireAuth(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Sign in with the admin login.' });
  }
  if (isEditor(req)) {
    // Signed in, but only for the editor: say so, rather than a login loop.
    return res.status(403).send(EDITOR_ONLY_PAGE);
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

// The editor and the Scripts folder: the admin login or the editor login.
function requireEditor(req, res, next) {
  if (isEditor(req)) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Sign in again (reload the page).' });
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

const EDITOR_ONLY_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WordLight</title><link rel="stylesheet" href="/styles.css">
<style>body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:2rem;
max-width:26rem}h1{font-size:1.15rem;margin:0 0 .6rem}p{color:#94a3b8;line-height:1.5;margin:0 0 1.2rem}
a{display:inline-block;margin-right:.6rem;padding:.5rem .9rem;border-radius:6px;text-decoration:none;
background:var(--accent);color:#fff}a.alt{background:var(--border);color:var(--text)}</style></head>
<body><div class="card"><h1>This login opens the editor only</h1>
<p>You're signed in with the editor login, which opens the script editor and the Scripts folder.
The caption controller and logging need the admin login.</p>
<a href="/editor">Open the editor</a><a class="alt" href="/logout">Sign out</a></div></body></html>`;

// --- Routes ------------------------------------------------------------------

app.get('/',            (req, res) => res.redirect('/home'));
app.get('/home',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/login',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/reader',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));
app.get('/backstage',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'backstage.html')));
app.get('/teleprompt',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'teleprompt.html')));
app.get('/preferences', (req, res) => res.sendFile(path.join(__dirname, 'public', 'preferences.html')));
app.get('/editor',      requireEditor, (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/help',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'help.html')));
app.get('/controller',  requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'controller.html')));
app.get('/logging',     requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'logging.html')));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    const redirectTo = req.session.returnTo || '/controller';
    delete req.session.returnTo;
    return res.redirect(redirectTo);
  }
  // The editor login: the editor (and the Scripts folder) only.
  if (EDITOR_PASSWORD && EDITOR_USERNAME !== ADMIN_USERNAME &&
      username === EDITOR_USERNAME && password === EDITOR_PASSWORD) {
    req.session.authenticated = false;
    req.session.editor = true;
    delete req.session.returnTo;
    return res.redirect('/editor');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res, next) => {
    if (req.session) {
        req.session = null;
        res.redirect('/login');
    } else {
        res.redirect('/login');
    }
});

// --- Helpers ------------------------------------------------------------------

const READER_PREFIXES = ['WEBR-', 'WEBB-', 'iOSR-', 'iOSB-', 'ANDR-', 'ANDB-'];

function zeroBreakdown() {
  const counts = {};
  READER_PREFIXES.forEach(p => { counts[p] = 0; });
  counts['other'] = 0;
  return counts;
}

// Running per-prefix counts, updated incrementally (see registerReader below)
// rather than recomputed by scanning uniqueReaderIds on every call. At scale
// (tens of thousands of connections) a full Set scan on every single connect
// event becomes an O(N) cost paid N times — an O(N²) blowup overall — which
// is exactly what caused CPU to climb and the connection-accept rate to fall
// behind during a 100,000-connection load test. Maintaining a running total
// here keeps every connect O(1) regardless of how large uniqueReaderIds gets.
let breakdownCounts = zeroBreakdown();

function getReaderBreakdown() {
  return { ...breakdownCounts };   // shallow copy — cheap, fixed small size
}

/**
 * Register a reader ID as seen. Returns true if this was a NEW unique ID
 * (and updates uniqueReaderIds + breakdownCounts accordingly), or false if
 * this ID was already known (e.g. a reconnect) — in which case nothing
 * needs to change, keeping the common case just as cheap as before.
 */
function registerReader(readerId) {
  if (uniqueReaderIds.has(readerId)) return false;
  uniqueReaderIds.add(readerId);
  const prefix = READER_PREFIXES.find(p => readerId.startsWith(p));
  breakdownCounts[prefix ? prefix : 'other']++;
  return true;
}

// --- API ----------------------------------------------------------------------

app.get('/api/state', (req, res) => res.json(captionState));

// QR code image for the reader URL — used on the home page
app.get('/api/qr', async (req, res) => {
  const readerUrl = req.protocol + '://' + req.get('host') + '/reader';
  try {
    const buffer = await QRCode.toBuffer(readerUrl, {
      type: 'png', width: 300, margin: 1,
      color: { dark: '#000000', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('[QR] Generation failed:', err.message);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Auth status — public endpoint so help.html can show the OSC section
// only to authenticated users without a full page redirect.
app.get('/api/auth/status', (req, res) => {
  // authenticated: the admin login (as before); editor: the editor login or admin
  res.json({ authenticated: isAdmin(req), editor: isEditor(req) });
});

// --- Scripts folder ----------------------------------------------------------
//
// The editor and the controller open caption files straight from the Scripts
// folder, and the editor saves to it (see scripts-folder.js for the rules).
// Every route needs the editor login or the admin login.
//
//   GET  /api/scripts/status            {available, name}
//   GET  /api/scripts?folder=a/b        {name, folder, parts, folders, files}
//   GET  /api/scripts/file?path=a/b.txt {name, folder, text, sha, mtime}
//   POST /api/scripts/file?folder=a&name=b.txt&base=<sha>   body: the text
//        -> {name, folder, wanted, sha, same, replaced, renamed}
//
// The text goes as text/plain (not JSON), so the app-wide JSON body limit
// (100 kB) doesn't apply; a long musical's caption file is about that size.

function scriptsError(res, err) {
  if (err instanceof ScriptsError) return res.status(err.status).json({ error: err.message });
  console.error('[scripts] ' + err.message);
  const msg = err.code === 'EACCES' || err.code === 'EPERM'
    ? `WordLight isn't allowed to write in the ${scriptsFolder.label} folder.`
    : `Something went wrong with the ${scriptsFolder.label} folder (${err.code || err.message}).`;
  res.status(500).json({ error: msg });
}

app.get('/api/scripts/status', requireEditor, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ available: scriptsFolder.available(), name: scriptsFolder.label });
});

app.get('/api/scripts', requireEditor, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json(scriptsFolder.list(req.query.folder)); }
  catch (err) { scriptsError(res, err); }
});

app.get('/api/scripts/file', requireEditor, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json(scriptsFolder.read(req.query.path)); }
  catch (err) { scriptsError(res, err); }
});

app.post('/api/scripts/file', requireEditor,
  express.text({ type: 'text/plain', limit: SCRIPTS_MAX_BYTES }),
  (req, res) => {
    if (typeof req.body !== 'string') {
      return res.status(400).json({ error: 'Nothing was sent to save.' });
    }
    try {
      const r = scriptsFolder.save(req.query.folder, req.query.name, req.body,
                                   req.query.base || null);
      const where = r.folder ? `${scriptsFolder.label}/${r.folder}` : scriptsFolder.label;
      const how = r.same ? 'already there' : r.replaced ? 'replaced' :
                  r.renamed ? `new name, "${r.wanted}" left alone` : 'new file';
      console.log(`[scripts] Saved "${r.name}" in ${where} (${how}, ` +
                  `${isAdmin(req) ? 'admin' : 'editor'} login)`);
      res.json(r);
    } catch (err) { scriptsError(res, err); }
  });

// Network info for the controller page's connection-info tooltip — lists
// every detected interface (WiFi, wired, etc.) with its IP, plus the
// reader and OSC ports currently in use. Gated behind requireAuth for the
// same reason the OSC section on /help is: it reveals network/control
// surface details, so it's kept to logged-in operators only, matching that
// existing precedent rather than introducing a new, inconsistent rule.
app.get('/api/network-info', requireAuth, (req, res) => {
  res.json({
    interfaces: serverInterfaces,
    port:       PORT,
    oscPort:    OSC_PORT
  });
});

// Receives environmental stats from oled_display.py (CPU temp, network
// IPs, WiFi signal) and turns them into pm2.io custom metrics — the OLED
// script has no @pm2/io of its own, so it just POSTs plain JSON here on
// an interval instead. Restricted to localhost: oled_display.py always
// calls this via http://localhost, and this isn't sensitive data, but
// there's no reason to let anything else on the network post arbitrary
// values into the dashboard.
app.post('/api/oled-metrics', (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: 'This endpoint only accepts local requests' });
  }

  const { cpuTempC, wifiIp, ethIp, wifiSignalDbm, wifiQualityPct } = req.body || {};

  if (typeof cpuTempC === 'number')       cpuTempMetric.set(Math.round(cpuTempC * 10) / 10);
  if (typeof wifiSignalDbm === 'number')  wifiSignalMetric.set(wifiSignalDbm);
  if (typeof wifiQualityPct === 'number') wifiQualityMetric.set(wifiQualityPct);
  wifiIpMetric.set(wifiIp || 'not connected');
  ethIpMetric.set(ethIp || 'not connected');

  res.json({ success: true });
});

// Who is connected, for the Script Converter on this Pi: it asks every two
// seconds and only works while nobody is (see sendConnections above).
app.get('/api/connections', sendConnections);
app.post('/api/check-admin', checkAdminPassword);
// For the home page's "Script Converter" button (see sendConverterLink below).
app.get('/api/converter-link', sendConverterLink);

app.get('/api/log', requireAuth, (req, res) => {
  res.json({
    uniqueReaders: uniqueReaderIds.size,
    totalSessions: totalSessionCount,
    logEntries:    sessionLog.length,
    serverUptime:  Math.floor(process.uptime()),
    breakdown:     getReaderBreakdown()
  });
});

app.get('/api/log/export', requireAuth, (req, res) => {
  const lines = [
    '# WordLight Session Log',
    '# Generated: ' + new Date().toISOString(),
    '# Unique Readers: ' + uniqueReaderIds.size,
    '# Total Sessions: ' + totalSessionCount,
    '#',
    'Timestamp,Reader ID'
  ];
  for (const entry of sessionLog) {
    lines.push(entry.ts.replace(/,/g, '') + ',' + entry.readerId.replace(/,/g, ''));
  }
  const filename = 'caption-log-' + new Date().toISOString().slice(0, 10) + '.csv';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(lines.join('\r\n'));
});

app.post('/api/log/reset', requireAuth, (req, res) => {
  uniqueReaderIds.clear();
  breakdownCounts   = zeroBreakdown();
  totalSessionCount = 0;
  sessionLog        = [];
  io.to('logging').emit('log-updated', { uniqueReaders: 0, totalSessions: 0, logEntries: 0, breakdown: zeroBreakdown() });
  updateSessionMetrics();
  res.json({ success: true });
});

// --- Helpers ------------------------------------------------------------------

/**
 * Build the minimal payload sent to readers on every navigation.
 * Readers only ever display three lines: current, prev, prev2.
 * The full script array is never sent to readers.
 */
function readerPayload(state) {
  const { lines, currentIndex, liveText, intermission } = state;
  const ok = Array.isArray(lines) && currentIndex >= 0;
  return {
    current:      ok ? (lines[currentIndex]     || '') : '',
    prev:         ok ? (lines[currentIndex - 1] || '') : '',
    prev2:        ok ? (lines[currentIndex - 2] || '') : '',
    next:         ok ? (lines[currentIndex + 1] || '') : '',
    next2:        ok ? (lines[currentIndex + 2] || '') : '',
    next3:        ok ? (lines[currentIndex + 3] || '') : '',
    next4:        ok ? (lines[currentIndex + 4] || '') : '',
    currentIndex: currentIndex,
    liveText:     liveText,
    intermission: intermission
  };
}

// --- Script Converter (optional, on this same Pi) ---------------------------
//
// The Script Converter turns show scripts into caption files. On the Pi it
// keeps its work away from shows by asking GET /api/connections (above), so
// while a controller is open it never runs. What it can't know is that
// another show is coming in a couple of hours after the controller closes —
// so the controller page shows a "Pause 6 hours" button while the converter
// has unfinished work, and WordLight passes the press on.
//
// WordLight asks the converter only while a controller page is open, every
// few seconds, and pushes what it hears to the controllers as
// 'converter-status'. Nothing is ever sent to readers or backstage. If the
// converter isn't installed or isn't running, the answer is "not available"
// and the controller shows nothing.
//
// The converter's API (127.0.0.1 only, no password):
//   GET  /api/status  -> {app:"script-converter", unfinished, running, frozen,
//                         why, paused_until (epoch seconds or null), ...}
//   POST /api/pause   -> pause for 6 hours from now (again = 6 hours from now)
//   POST /api/resume  -> end the pause
// Both POSTs answer with the same JSON as /api/status.

const CONVERTER_OFF        = /^(off|false|no|none)$/i.test(CONVERTER_URL.trim());
const CONVERTER_POLL_MS    = 5000;
const CONVERTER_TIMEOUT_MS = 2000;
let   converterBase        = CONVERTER_URL.trim();   // may switch http <-> https once
let   converterStatus      = { available: false };
let   converterTimer       = null;
let   converterInFlight    = null;

if (!CONVERTER_OFF) {
  try {
    const host = new URL(converterBase).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
      console.warn(`⚠️  CONVERTER_URL (${converterBase}) is not on this computer. The Script ` +
                   `Converter only answers WordLight from the same Pi, so its pause button ` +
                   `won't appear on the controller.`);
    }
  } catch (e) {
    console.warn(`⚠️  CONVERTER_URL (${converterBase}) is not a valid address — the ` +
                 `Script Converter's pause button is turned off.`);
    converterBase = null;
  }
}

// One request to the converter. Always resolves (never rejects) with
// { ok: true, data } or { ok: false, reason }.
function converterRequest(base, method, apiPath) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(apiPath, base); } catch (e) { return resolve({ ok: false, reason: 'bad-url' }); }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method,
      timeout: CONVERTER_TIMEOUT_MS,
      // The converter's https (if used) has a self-signed certificate, and
      // this request never leaves the Pi, so there is nothing to verify.
      rejectUnauthorized: false,
      agent: false,
      headers: method === 'POST' ? { 'Content-Length': 0 } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, reason: 'http-' + res.statusCode });
        try { resolve({ ok: true, data: JSON.parse(body) }); }
        catch (e) { resolve({ ok: false, reason: 'bad-json' }); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
    req.end();
  });
}

// Like converterRequest, but if the answer failed in a way that means "wrong
// kind of connection" (http to an https converter or the other way round),
// try the other scheme once and keep using it if it works. Refused (nothing
// running) and real HTTP answers (an error status, or a body that isn't the
// converter's JSON) aren't retried. A timeout is: on the Pi, plain http sent
// to the converter's https port gets no answer at all (newer OpenSSL waits
// for the rest of a "TLS record" that never comes) instead of a reset.
async function askConverter(method, apiPath) {
  if (CONVERTER_OFF || !converterBase) return { ok: false, reason: 'off' };
  const first = await converterRequest(converterBase, method, apiPath);
  if (first.ok || ['ECONNREFUSED', 'bad-json'].includes(first.reason)
      || String(first.reason).startsWith('http-')) {
    return first;
  }
  const other = converterBase.startsWith('https:')
    ? converterBase.replace(/^https:/, 'http:')
    : converterBase.replace(/^http:/, 'https:');
  const second = await converterRequest(other, method, apiPath);
  if (second.ok) {
    console.log(`[converter] The Script Converter answers on ${other} — using that.`);
    converterBase = other;
    return second;
  }
  return first;
}

// What the controller page needs to know — only plain values, never the
// converter's raw answer.
function controllerConverterStatus(r) {
  if (!r.ok || !r.data || r.data.app !== 'script-converter') return { available: false };
  const d = r.data;
  return {
    available:   true,
    unfinished:  !!d.unfinished,
    working:     !!d.running && !d.frozen,
    why:         typeof d.why === 'string' ? d.why.slice(0, 400) : '',
    pausedUntil: typeof d.paused_until === 'number' ? d.paused_until : null,
  };
}

function setConverterStatus(next) {
  const changed = JSON.stringify(next) !== JSON.stringify(converterStatus);
  converterStatus = next;
  if (changed) io.to('controllers').emit('converter-status', converterStatus);
}

// Ask the converter now. Calls that overlap share one request.
function refreshConverterStatus() {
  if (!converterInFlight) {
    converterInFlight = askConverter('GET', '/api/status')
      .then((r) => setConverterStatus(controllerConverterStatus(r)))
      .finally(() => { converterInFlight = null; });
  }
  return converterInFlight;
}

function controllersConnected() {
  return (io.sockets.adapter.rooms.get('controllers')?.size || 0) > 0;
}

// Keep asking while at least one controller page is open; stop when the
// last one closes (nobody would see the answer).
function watchConverter() {
  if (CONVERTER_OFF || converterTimer) return;
  converterTimer = setInterval(() => {
    if (!controllersConnected()) {
      clearInterval(converterTimer);
      converterTimer = null;
      return;
    }
    refreshConverterStatus();
  }, CONVERTER_POLL_MS);
}

// GET /api/converter-link — whether the Script Converter runs on this
// computer, and on which scheme and port, so the home page can show a
// "Script Converter" button pointing at the same address the browser already
// uses (only the port and scheme differ). The home page is public, so this
// answers anyone, with only those three values: the converter's page asks
// for its own password. The converter is asked at most once every 30
// seconds, however many phones load the home page.
const CONVERTER_LINK_MS = 30 * 1000;
let   converterLink         = { available: false };
let   converterLinkAt       = 0;
let   converterLinkInFlight = null;

function converterLinkFrom(r) {
  if (!r.ok || !r.data || r.data.app !== 'script-converter' || !converterBase) return { available: false };
  try {
    const u = new URL(converterBase);
    const scheme = u.protocol === 'https:' ? 'https' : 'http';
    const port = Number(u.port) || (scheme === 'https' ? 443 : 80);
    return { available: true, scheme, port };
  } catch (e) {
    return { available: false };
  }
}

async function sendConverterLink(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (Date.now() - converterLinkAt > CONVERTER_LINK_MS) {
    if (!converterLinkInFlight) {
      converterLinkInFlight = askConverter('GET', '/api/status')
        .then((r) => { converterLink = converterLinkFrom(r); converterLinkAt = Date.now(); })
        .finally(() => { converterLinkInFlight = null; });
    }
    await converterLinkInFlight;
  }
  res.json(converterLink);
}

// --- Sockets -----------------------------------------------------------------

io.on('connection', (socket) => {
  // Set by the io.use() gate above after validating the session — deliberately
  // NOT read from handshake.query here, so a client can't claim a type it
  // wasn't granted.
  const clientType = socket.data.clientType;
  const readerId   = socket.handshake.query.readerId;

  // -- Reader ------------------------------------------------------------------
  if (clientType === 'reader') {
    socket.join('readers');
    // Backstage clients (WEBB-, iOSB-, ANDB- prefixes) ALSO join a second
    // 'backstage' room, in addition to 'readers' — broadcasts still reach
    // everyone via 'readers' unchanged, but this lets us compute an
    // audience-only count (readers room size minus backstage room size)
    // for the live counter on the controller page, without a separate
    // manual counter that could drift out of sync.
    if (readerId && READER_PREFIXES.some(p => p.endsWith('B-') && readerId.startsWith(p))) {
      socket.join('backstage');
    }
    totalSessionCount++;
    if (readerId) {
      registerReader(readerId);   // O(1) — updates uniqueReaderIds + breakdownCounts together
      sessionLog.push({ ts: new Date().toISOString(), readerId });
      if (sessionLog.length > MAX_LOG) sessionLog.shift();
    }
    // Readers receive only the three lines they need — never the full script
    socket.emit('state-update', readerPayload(captionState));
    // Only bother building/sending the logging update if someone is actually
    // viewing /logging — skips needless work on every connect otherwise.
    if (io.sockets.adapter.rooms.get('logging')?.size > 0) {
      io.to('logging').emit('log-updated', {
        uniqueReaders: uniqueReaderIds.size,
        totalSessions: totalSessionCount,
        logEntries:    sessionLog.length,
        breakdown:     getReaderBreakdown()
      });
    }
    updateConnectionMetrics();
    updateSessionMetrics();
    emitAudienceCount();
  }

  // -- Controller --------------------------------------------------------------
  if (clientType === 'controller') {
    socket.join('controllers');
    // Controllers receive the full state so they can render the script list
    socket.emit('state-update', captionState);
    socket.emit('osc-arm', { armed: captionState.oscArmed });
    updateConnectionMetrics();
    // Send the current audience count immediately so a freshly-opened
    // controller tab shows the right number right away, rather than
    // waiting for the next reader to connect or disconnect.
    socket.emit('audience-count', { count: getAudienceReaderCount() });
    // Script Converter: ask now (the last answer may be hours old), tell this
    // tab, and keep asking while any controller is open. The converter
    // checks WordLight every 2 seconds, so ask once more a little later to
    // pick up that it has seen this controller and stopped.
    if (!CONVERTER_OFF) {
      refreshConverterStatus().then(() => socket.emit('converter-status', converterStatus));
      setTimeout(refreshConverterStatus, 3000);
      watchConverter();
    }
  }

  // -- Logging page ------------------------------------------------------------
  if (clientType === 'logging') {
    socket.join('logging');
    socket.emit('log-updated', {
      uniqueReaders: uniqueReaderIds.size,
      totalSessions: totalSessionCount,
      logEntries:    sessionLog.length,
      breakdown:     getReaderBreakdown()
    });
  }

  // -- load-script: controller sends full lines array once on file load --------
  // Replies through the acknowledgement callback so the controller can tell
  // the difference between "loaded" and "silently rejected". Without this a
  // failed load leaves the operator and the audience looking at different
  // scripts with nothing on screen to say so.
  socket.on('load-script', (data, ack) => {
    const reply = (result) => { if (typeof ack === 'function') ack(result); };

    if (clientType !== 'controller') {
      return reply({ ok: false, error: 'Only the controller can load a script.' });
    }
    if (!data || !Array.isArray(data.lines)) {
      return reply({ ok: false, error: 'Script data was malformed.' });
    }
    if (data.lines.length > MAX_SCRIPT_LINES) {
      return reply({ ok: false, error:
        `Script has ${data.lines.length.toLocaleString()} lines — the limit is ` +
        `${MAX_SCRIPT_LINES.toLocaleString()}.` });
    }

    // Every element must be a string. A script file always yields strings
    // (the controller splits on newlines), but this handler is reachable by
    // anything holding a controller session, so it can't be assumed.
    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      if (typeof line !== 'string') {
        return reply({ ok: false, error: `Line ${i + 1} is not text.` });
      }
      if (line.length > MAX_LINE_LENGTH) {
        return reply({ ok: false, error:
          `Line ${i + 1} is ${line.length.toLocaleString()} characters — the limit ` +
          `is ${MAX_LINE_LENGTH.toLocaleString()}.` });
      }
    }

    captionState = {
      ...captionState,
      lines:        data.lines,
      currentIndex: typeof data.currentIndex === 'number' ? data.currentIndex : 0
    };
    // Other controller tabs need the full script to render their list
    socket.to('controllers').emit('state-update', captionState);
    // Readers only get the three-line display slice
    io.to('readers').emit('state-update', readerPayload(captionState));
    updateLineMetrics();

    reply({ ok: true, lines: data.lines.length });
  });

  // -- update-index: controller sends only the new index on each navigation ---
  socket.on('update-index', (data) => {
    if (clientType !== 'controller') return;
    if (typeof data.currentIndex !== 'number') return;
    const idx = data.currentIndex;
    if (idx < 0 || idx >= captionState.lines.length) return;
    captionState = { ...captionState, currentIndex: idx };
    // Other controller tabs receive just the new index (they already have lines)
    socket.to('controllers').emit('index-update', { currentIndex: idx });
    // Readers receive only the three lines they need to display
    io.to('readers').emit('state-update', readerPayload(captionState));
    updateLineMetrics();
  });

  // -- update-live-text --------------------------------------------------------
  socket.on('update-live-text', (data) => {
    if (clientType !== 'controller') return;
    const text = typeof data.liveText === 'string' ? data.liveText : '';
    captionState = { ...captionState, liveText: text };
    io.to('readers').emit('state-update', readerPayload(captionState));
    socket.to('controllers').emit('state-update', { liveText: text });
    updateLineMetrics();
  });

  // -- set-intermission --------------------------------------------------------
  socket.on('set-intermission', (data) => {
    if (clientType !== 'controller') return;
    captionState = { ...captionState, intermission: !!data.intermission };
    io.to('readers').emit('state-update', readerPayload(captionState));
    socket.to('controllers').emit('state-update', { intermission: captionState.intermission });
    updateShowStateMetrics();
  });

  // -- converter-pause / converter-resume --------------------------------------
  // The controller's Script Converter button. Passed on to the converter on
  // this Pi; every open controller gets the new state. Replies through the
  // acknowledgement so the button can say when the converter didn't answer.
  for (const [event, apiPath, done] of [
    ['converter-pause',  '/api/pause',  'paused for 6 hours'],
    ['converter-resume', '/api/resume', 'resumed'],
  ]) {
    socket.on(event, async (data, ack) => {
      const reply = (result) => { if (typeof ack === 'function') ack(result); };
      if (clientType !== 'controller') {
        return reply({ ok: false, error: 'Only the controller can do this.' });
      }
      const r = await askConverter('POST', apiPath);
      const next = controllerConverterStatus(r);
      if (!next.available) {
        return reply({ ok: false, error: 'The Script Converter did not answer.' });
      }
      setConverterStatus(next);
      console.log(`[converter] Script Converter ${done} from the controller`);
      reply({ ok: true, status: next });
      // The converter's "why" text catches up on its next check (2 s).
      setTimeout(refreshConverterStatus, 2500);
    });
  }

  // socket.io removes a disconnecting socket from all its rooms before this
  // fires, so recomputing room sizes here correctly reflects the post-
  // disconnect counts — this is what keeps the Connected Readers / Connected
  // Controllers metrics accurate as people leave, not just as they arrive.
  socket.on('disconnect', () => {
    updateConnectionMetrics();
    emitAudienceCount();
  });
});


// --- Start --------------------------------------------------------------------

const activePort   = usingHttps ? HTTPS_PORT : PORT;
const activeScheme = usingHttps ? 'https' : 'http';
// The version lives in package.json only (setup.sh's Status reads it there too)
const WORDLIGHT_VERSION = require('./package.json').version;

server.listen(activePort, '0.0.0.0', () => {
  console.log(`\n✅ WordLight ${WORDLIGHT_VERSION} server running!`);
  // Log a home-page URL for every detected network interface
  if (serverIPs.length === 0) {
    console.log(`   Home:    ${activeScheme}://localhost:${activePort}/home`);
  } else {
    serverIPs.forEach(ip => {
      console.log(`   Home:    ${activeScheme}://${ip}:${activePort}/home`);
    });
  }
  console.log(`   Scripts: ${scriptsFolder.root} ("${scriptsFolder.label}")` +
              (scriptsFolder.available() ? '' : ' — NOT THERE: editor and controller ' +
               'can\'t open it (set SCRIPTS_DIR in .env)'));
  console.log(`   Editor login: ${EDITOR_PASSWORD && EDITOR_USERNAME !== ADMIN_USERNAME
    ? `"${EDITOR_USERNAME}" (editor and Scripts folder only)`
    : 'off (set EDITOR_PASSWORD in .env); the editor uses the admin login'}`);

  // Give every pm2.io metric a real starting value immediately, rather than
  // leaving them blank in the dashboard until the first connect/navigation
  // event happens to fire.
  updateConnectionMetrics();
  updateSessionMetrics();
  updateLineMetrics();
  updateShowStateMetrics();
});

// ── HTTP → HTTPS redirect server ────────────────────────────────────────────
//
// Only started when HTTPS is actually active. Anyone who types or bookmarks
// a plain "http://" address (or an old bookmark from before HTTPS was set
// up) lands here instead of getting a confusing "can't connect" — every
// request is redirected straight to the HTTPS equivalent on HTTPS_PORT.
//
// PORT answers https too, with the same redirect. Browsers sometimes ask
// https://…:PORT by themselves (Chrome's "Always use secure connections"
// upgrades addresses with a port as well, and keeps the port), and a
// plain-http port can only answer that with a TLS error. The first byte a
// browser sends tells the two apart: every TLS connection starts with 22
// (0x16, a handshake record); plain http starts with a letter (GET, POST…).
// With HTTPS off (no certificate), none of this runs: PORT serves WordLight
// itself over plain http, as before.
if (usingHttps) {
  const redirectApp = express();
  // The exceptions to the redirect: the Script Converter's local questions
  // (loopback only) are answered here directly.
  redirectApp.get('/api/connections', sendConnections);
  redirectApp.post('/api/check-admin', express.json({ limit: '4kb' }), checkAdminPassword);
  redirectApp.use((req, res) => {
    const portSuffix = Number(HTTPS_PORT) === 443 ? '' : `:${HTTPS_PORT}`;
    res.redirect(301, `https://${req.hostname}${portSuffix}${req.originalUrl}`);
  });

  const plainRedirect = http.createServer(redirectApp);
  const tlsRedirect   = https.createServer({
    key:  fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  }, redirectApp);
  tlsRedirect.on('tlsClientError', () => { /* a client that gave up mid-handshake */ });

  const TLS_HANDSHAKE = 0x16;
  net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10 * 1000, () => socket.destroy());   // connected but never said anything
    socket.once('data', (first) => {
      socket.setTimeout(0);                                 // the http/https server takes over
      socket.pause();
      socket.unshift(first);
      (first[0] === TLS_HANDSHAKE ? tlsRedirect : plainRedirect).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  }).listen(PORT, '0.0.0.0', () => {
    console.log(`   HTTP:     port ${PORT} redirects to HTTPS (http:// and https:// both work)`);
  });
}

// ── OSC Server ────────────────────────────────────────────────────────────────
// Listens for UDP Open Sound Control messages so lighting/sound boards
// and show control systems can drive caption navigation.
//
// Commands (all case-insensitive):
//   /CC/next            advance to the next line
//   /CC/prev            go back one line
//   /CC/first           jump to line 1
//   /CC/last            jump to the last line
//   /CC/line/<n>        jump to line n (1-based, e.g. /CC/line/37)
//   /CC/intermission    show intermission overlay on all readers
//   /CC/resume          hide intermission overlay

function oscNavigate(idx) {
  if (!Array.isArray(captionState.lines) || captionState.lines.length === 0) return;
  idx = Math.max(0, Math.min(idx, captionState.lines.length - 1));
  captionState = { ...captionState, currentIndex: idx };
  io.to('readers').emit('state-update', readerPayload(captionState));
  io.to('controllers').emit('index-update', { currentIndex: idx });
  updateLineMetrics();
  console.log('[OSC] → line ' + (idx + 1));
}

function oscSetIntermission(on) {
  captionState = { ...captionState, intermission: on };
  io.to('readers').emit('state-update', readerPayload(captionState));
  io.to('controllers').emit('state-update', { intermission: on });
  updateShowStateMetrics();
  console.log('[OSC] Intermission ' + (on ? 'ON' : 'OFF'));
}

function oscSetArmed(on) {
  captionState = { ...captionState, oscArmed: on };
  io.to('controllers').emit('osc-arm', { armed: on });
  updateShowStateMetrics();
  console.log('[OSC] ' + (on ? '🟢 ARMED' : '⚪ DISARMED'));
}

// Parse the OSC address from a raw UDP buffer.
// OSC addresses are null-terminated ASCII strings at the start of the packet.
function parseOscAddress(buf) {
  const end = buf.indexOf(0);
  return buf.slice(0, end === -1 ? buf.length : end).toString('ascii');
}

try {
  const oscSocket = dgram.createSocket('udp4');

  oscSocket.on('message', (buf) => {
    const address = parseOscAddress(buf).toLowerCase().trim();
    if      (address === '/cc/next')         oscNavigate(captionState.currentIndex + 1);
    else if (address === '/cc/prev')         oscNavigate(captionState.currentIndex - 1);
    else if (address === '/cc/first')        oscNavigate(0);
    else if (address === '/cc/last')         oscNavigate((captionState.lines.length || 1) - 1);
    else if (address === '/cc/intermission') oscSetIntermission(true);
    else if (address === '/cc/resume')       oscSetIntermission(false);
    else if (address === '/cc/armed')        oscSetArmed(true);
    else if (address === '/cc/disarmed')     oscSetArmed(false);
    else {
      const m = address.match(/^\/cc\/line\/(\d+)$/);
      if (m) oscNavigate(parseInt(m[1], 10) - 1);
      else   console.log('❓[OSC] Unknown address: ' + address);
    }
  });

  oscSocket.on('error', (err) => {
    console.error('[OSC] Socket error:', err.message);
    oscSocket.close();
  });

  oscSocket.bind(OSC_PORT, '0.0.0.0', () => {
      console.log('\n✅ WordLight OSC Listener running!');
      if (serverIPs.length === 0) {
        console.log('   OSC:   localhost:' + PORT);
      } else {
        serverIPs.forEach(ip => {
          console.log('   OSC:  ' + ip + ':' + OSC_PORT);
        });
    }
     console.log('   OSC Commands:  /CC/next · /CC/prev · /CC/line/<n> · /CC/intermission · /CC/resume · /CC/armed · /CC/disarmed');
  });
} catch (err) {
  console.warn('❗️[OSC] Could not start OSC listener:', err.message);
}