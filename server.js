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
// --- Set the user name and password to access the Caption Controller and Logging.
// The fallbacks are named constants so the "you're still on defaults"
// warning further down compares against the REAL values. It previously
// checked a hardcoded string that matched neither default, so it could
// never actually fire.
const DEFAULT_ADMIN_PASSWORD = 'changeme';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

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
const fs           = require('fs');
const { execSync } = require('child_process');
const socketIo     = require('socket.io');
const session      = require('cookie-session');
const cookieParser = require('cookie-parser');
const path         = require('path');

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

const io = socketIo(server);


// Warn loudly if this install is still running on shipped defaults.
// Anyone who reads the public source knows these values, so an install
// that skipped .env setup has effectively no admin protection at all.
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
app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 12 * 60 * 60 * 1000 } // Session is for 12 hours
}));
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

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

// --- Routes ------------------------------------------------------------------

app.get('/',            (req, res) => res.redirect('/home'));
app.get('/home',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/login',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/reader',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));
app.get('/backstage',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'backstage.html')));
app.get('/teleprompt',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'teleprompt.html')));
app.get('/preferences', (req, res) => res.sendFile(path.join(__dirname, 'public', 'preferences.html')));
app.get('/editor',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
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
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
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
  const ip = req.ip || req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
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

// --- Sockets -----------------------------------------------------------------

io.on('connection', (socket) => {
  const clientType = socket.handshake.query.type;
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
  socket.on('load-script', (data) => {
    if (clientType !== 'controller') return;
    if (!Array.isArray(data.lines)) return;
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

server.listen(activePort, '0.0.0.0', () => {
  console.log('\n✅ WordLight server running!');
  // Log a home-page URL for every detected network interface
  if (serverIPs.length === 0) {
    console.log(`   Home:    ${activeScheme}://localhost:${activePort}/home`);
  } else {
    serverIPs.forEach(ip => {
      console.log(`   Home:    ${activeScheme}://${ip}:${activePort}/home`);
    });
  }

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
if (usingHttps) {
  const redirectApp = express();
  redirectApp.use((req, res) => {
    const portSuffix = HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`;
    res.redirect(301, `https://${req.hostname}${portSuffix}${req.originalUrl}`);
  });
  http.createServer(redirectApp).listen(PORT, '0.0.0.0', () => {
    console.log(`   HTTP:     port ${PORT} redirects to HTTPS`);
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