#!/usr/bin/env node
/**
 * load_test.js — WordLight stress test tool
 * ===========================================
 * Opens many concurrent socket.io connections to a WordLight server,
 * mimicking real reader (audience) and backstage clients, and holds
 * them open while reporting live connection/memory stats.
 *
 * This is a STANDALONE tool — it lives in its own folder with its own
 * package.json so socket.io-client is never added as a dependency of
 * the actual WordLight server.
 *
 * ── Setup ─────────────────────────────────────────────────────────────────
 *   cd load-test
 *   npm install
 *
 * ── Basic usage (safe — read-only, never modifies server state) ────────────
 *   node load_test.js --host 192.168.1.42 --port 3000 --count 100
 *
 * ── With simulated controller navigation (see WARNING below) ───────────────
 *   node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
 *     --simulate-nav --confirm-overwrite-script
 *
 * ── With connection churn (simulates real-world flaky connections) ─────────
 *   node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
 *     --simulate-nav --confirm-overwrite-script \
 *     --churn-percent 5 --churn-interval-ms 5000
 *
 * ── With ungraceful disconnects mixed into churn ────────────────────────────
 *   node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
 *     --simulate-nav --confirm-overwrite-script \
 *     --churn-percent 5 --churn-interval-ms 5000 --ungraceful-percent 30
 *
 * ── All options ──────────────────────────────────────────────────────────
 *   --host <ip>                Server host/IP (default: 127.0.0.1)
 *   --port <n>                 Server port (default: 3000)
 *   --count <n>                Number of fake reader/backstage clients (default: 100)
 *   --ramp-ms <n>               Delay in ms between opening each connection (default: 50)
 *   --backstage-ratio <0-1>     Fraction of clients that identify as backstage (default: 0.2)
 *   --duration <seconds>        Auto-stop after this many seconds (default: 0 = run until Ctrl+C)
 *   --status-interval <seconds> How often to print stats (default: 5)
 *   --simulate-nav              Also simulate a controller advancing lines (see WARNING)
 *   --confirm-overwrite-script  Required alongside --simulate-nav — explicit opt-in
 *   --nav-interval-ms <n>       Time between simulated line advances (default: 2000)
 *   --demo-lines <n>            Number of fake script lines to load (default: 50)
 *   --churn-percent <0-100>     % of clients to disconnect+reconnect per cycle (default: 0 = off)
 *   --churn-interval-ms <n>     Time between churn cycles (default: 5000)
 *   --churn-reconnect-ms <n>    Base delay before a churned client reconnects (default: 500)
 *   --churn-reconnect-jitter-ms <n>  Random extra delay added to the above (default: 2500)
 *   --ungraceful-percent <0-100>  % of each churn cycle killed abruptly, no clean close
 *                               (default: 0 = off; requires --churn-percent > 0)
 *   --csv-file <path>           Path for the CSV stats log (default: load_test_stats.csv)
 *   --verbose                   Log every connect/disconnect/event individually
 *
 * ── Output ───────────────────────────────────────────────────────────────
 * Every status line — and every row in the CSV — includes a wall-clock
 * timestamp (HH:MM:SS), making it straightforward to cross-reference against
 * server-side captures (pidstat, lsof, pm2 logs) by time rather than having
 * to convert "elapsed seconds since test start" by hand.
 *
 * The CSV log (default load_test_stats.csv, one row per --status-interval)
 * is the most reliable way to analyze a run afterward — plot RSS over time,
 * correlate churn events with memory growth, etc. — without needing to
 * parse free-text console output.
 *
 * "Unexpected disconnects" are disconnects THIS SCRIPT did not itself
 * trigger — i.e. not a deliberate churn cycle or the final shutdown. A
 * network drop, a server-side drop, or the host machine's display going to
 * sleep and suspending a VM (which has happened during testing) will all
 * show up here, with the exact wall-clock time in the CSV — pinpointing
 * exactly when something went wrong without needing to reconstruct it from
 * server-side logs after the fact.
 *
 * ── About --churn-percent ───────────────────────────────────────────────────
 * Real audience members don't hold one perfectly stable connection for a
 * whole show — phones lock, apps get backgrounded, WiFi drops briefly. Churn
 * simulates this by disconnecting a random slice of currently-connected
 * clients every --churn-interval-ms, then reconnecting each one after a
 * randomised delay. Each client keeps its ORIGINAL reader ID across the
 * cycle — exactly like a real phone, whose ID is stored in localStorage and
 * survives a reconnect — so this exercises the "known reader reconnecting"
 * code path specifically, not just first-time connections.
 *
 * ── About --ungraceful-percent ──────────────────────────────────────────────
 * Every disconnect above — churn included — is CLEAN: socket.disconnect()
 * sends an explicit close signal the server processes immediately. Real
 * disruption often isn't clean: a phone losing signal, a cable pulling, or
 * a resource-exhaustion attempt that opens connections and never properly
 * closes them all look like the connection just went silent. The server can
 * only detect that via its own transport-level error handling or (worst
 * case) its ping/pong heartbeat timeout, not immediately.
 *
 * --ungraceful-percent controls what fraction of EACH churn cycle's
 * selected clients are killed this way instead of gracefully — forcibly
 * terminating the underlying WebSocket rather than sending a clean close.
 * This exercises a different server-side code path (an abrupt "transport
 * close/error", not the normal graceful disconnect reason) and is worth
 * comparing against the CSV's separate ungraceful_reconnect_* columns to
 * see whether recovery looks meaningfully different from a clean churn
 * cycle — the real question being: does the server clean these up
 * correctly once it does notice, with no leaked state left behind?
 *
 * Requires --churn-percent to be set — ungraceful kills only ever happen
 * as part of a churn cycle, not on their own.
 *
 * ── WARNING about --simulate-nav ────────────────────────────────────────────
 * This mode connects as a fake CONTROLLER and sends a 'load-script' event,
 * which REPLACES whatever script is currently loaded on the server — exactly
 * as if someone opened /controller and loaded a new file. Do not run this
 * against a server that is actively being used for a real show or rehearsal.
 * Use a dedicated test/staging Pi, or run it when you know nothing important
 * is loaded. The --confirm-overwrite-script flag exists so this can't happen
 * by accident — both flags must be present together.
 */

const { io } = require('socket.io-client');
const fs = require('fs');

// ── Argument parsing ──────────────────────────────────────────────────────
// Simple manual parser — no extra dependencies needed for a single script.
// Supports "--key value" pairs and standalone boolean "--flag" switches.

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    // If the next token is missing or is itself a flag, treat this as boolean true.
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++; // consume the value token
    }
  }
  return args;
}

const raw = parseArgs(process.argv.slice(2));

const CONFIG = {
  host:                  raw.host || '127.0.0.1',
  port:                  parseInt(raw.port || '3000', 10),
  count:                 parseInt(raw.count || '100', 10),
  rampMs:                parseInt(raw['ramp-ms'] || '50', 10),
  backstageRatio:        parseFloat(raw['backstage-ratio'] || '0.2'),
  duration:              parseInt(raw.duration || '0', 10),
  statusInterval:        parseInt(raw['status-interval'] || '5', 10),
  simulateNav:           !!raw['simulate-nav'],
  confirmOverwrite:      !!raw['confirm-overwrite-script'],
  navIntervalMs:         parseInt(raw['nav-interval-ms'] || '2000', 10),
  demoLines:             parseInt(raw['demo-lines'] || '50', 10),
  verbose:               !!raw.verbose,
  // Churn simulates real-world connection instability — phones locking,
  // backgrounding, briefly losing WiFi — rather than every client holding
  // one perfectly stable connection for the whole test. 0 = disabled
  // (default), matching the original steady-connection-only behaviour.
  churnPercent:          parseFloat(raw['churn-percent'] || '0'),
  churnIntervalMs:       parseInt(raw['churn-interval-ms'] || '5000', 10),
  churnReconnectMs:      parseInt(raw['churn-reconnect-ms'] || '500', 10),
  churnReconnectJitterMs: parseInt(raw['churn-reconnect-jitter-ms'] || '2500', 10),
  csvFile:               raw['csv-file'] || 'load_test_stats.csv',
  // What fraction of each churn cycle's selected clients are killed
  // UNGRACEFULLY — the underlying connection is silently severed with no
  // close signal sent, rather than a clean socket.disconnect(). This
  // mimics a phone losing signal, a network cable pulling, or a resource-
  // exhaustion attempt that opens connections and never properly closes
  // them. The server can only detect these via its own ping/pong heartbeat
  // timeout (socket.io defaults: ~45s worst case), not immediately — so
  // this specifically tests how long "ghost" connections linger and
  // whether the server cleans them up correctly once it does notice.
  // 0 = disabled (default) — all churn is graceful, as before.
  ungracefulPercent:     parseFloat(raw['ungraceful-percent'] || '0'),
};

// ── Safety check: simulate-nav requires explicit confirmation ──────────────
if (CONFIG.simulateNav && !CONFIG.confirmOverwrite) {
  console.error('\n❌ --simulate-nav requires --confirm-overwrite-script as well.\n');
  console.error('   This mode REPLACES whatever script is currently loaded on the');
  console.error('   server — do not run it against a server in active use for a');
  console.error('   real show or rehearsal. Add --confirm-overwrite-script to');
  console.error('   acknowledge this and proceed.\n');
  process.exit(1);
}

if (CONFIG.churnPercent < 0 || CONFIG.churnPercent > 100) {
  console.error('\n❌ --churn-percent must be between 0 and 100.\n');
  process.exit(1);
}

if (CONFIG.ungracefulPercent < 0 || CONFIG.ungracefulPercent > 100) {
  console.error('\n❌ --ungraceful-percent must be between 0 and 100.\n');
  process.exit(1);
}

if (CONFIG.ungracefulPercent > 0 && CONFIG.churnPercent <= 0) {
  console.error('\n❌ --ungraceful-percent requires --churn-percent to be set as well —');
  console.error('   ungraceful kills only happen as part of a churn cycle.\n');
  process.exit(1);
}

const SERVER_URL = `http://${CONFIG.host}:${CONFIG.port}`;

// ── Stats tracking ────────────────────────────────────────────────────────

const stats = {
  connected:            0,   // currently connected right now
  peakConnected:        0,   // highest simultaneous connection count seen
  totalConnects:        0,   // cumulative successful connections (including reconnects)
  totalDisconnects:     0,
  connectErrors:        0,
  stateUpdatesRecv:     0,   // total 'state-update' events received across all clients
  navAdvances:          0,   // how many times the fake controller has advanced a line
  churnEvents:          0,   // how many times a client was deliberately disconnected+reconnected
                              // (graceful + ungraceful combined — see the two below for the split)
  gracefulChurnEvents:   0,
  ungracefulChurnEvents: 0,
  unexpectedDisconnects: 0,  // disconnects we did NOT initiate ourselves — network drops,
                              // server-side drops, client machine sleeping, etc. A spike in
                              // this number pinpoints exactly when something went wrong
                              // without needing to cross-reference pidstat/lsof after the fact.
  reconnectTimesMs:     [],  // time from disconnect to next successful connect, per event
                              // since the last status print — drained on each printStatus call.
  reconnectCountAllTime: 0,  // cumulative versions of the same, for the final summary
  reconnectMinMsAllTime: null,
  reconnectMaxMsAllTime: null,
  reconnectSumMsAllTime: 0,
  // Same shape as the reconnect stats above, but tracked SEPARATELY for
  // ungraceful kills specifically — mixing these into the main reconnect
  // numbers would understate how much slower an unclean disconnect is to
  // recover from compared to a normal graceful one.
  ungracefulReconnectTimesMs:     [],
  ungracefulReconnectCountAllTime: 0,
  ungracefulReconnectMinMsAllTime: null,
  ungracefulReconnectMaxMsAllTime: null,
  ungracefulReconnectSumMsAllTime: 0,
};

const startTime = Date.now();

// Local wall-clock time as HH:MM:SS, for cross-referencing against pidstat/lsof
// logs captured on the server — this was the single most useful thing missing
// from earlier runs, since the status log only showed elapsed seconds and
// matching that up to a real timestamp required guessing the test's start time.
function wallClock() {
  return new Date().toTimeString().slice(0, 8);
}

// ── Create fake reader/backstage clients ────────────────────────────────────
//
// Connections are opened with a small stagger (CONFIG.rampMs between each)
// rather than all at once. This mimics how an audience actually arrives —
// gradually, not as a simultaneous burst — and avoids briefly hammering the
// server with 100 TCP handshakes in the same instant, which would test
// connection-burst handling rather than steady-state load.
//
// Each fake client is a persistent "slot" — { index, readerId, prefix, socket }
// — that keeps the SAME readerId for the whole run, even across churn-driven
// disconnect/reconnect cycles. This matters: a real phone's reader ID is
// stored in localStorage and survives reconnects, so a device dropping WiFi
// and coming back is the SAME reader reconnecting, not a new one. Testing it
// this way exercises the exact registerReader() reconnect path in server.js
// (the id-already-known case), not just first-time connections.

const clients = [];
let controllerSocket = null;

function makeReaderId(prefix) {
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-loadtest-${rand}`;
}

function connectClient(client) {
  const socket = io(SERVER_URL, {
    query: { type: 'reader', readerId: client.readerId },
    reconnection: true,       // real clients reconnect on drop — so should these
    reconnectionDelay: 1000,
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    stats.connected++;
    stats.totalConnects++;
    if (stats.connected > stats.peakConnected) stats.peakConnected = stats.connected;

    // If client.disconnectedAt is set, this connect is a RECONNECT following
    // an earlier disconnect (either churn-driven or unexpected) — record how
    // long it took. Not set on the very first connection, since there's
    // nothing to reconnect from yet. Routed into a separate ungraceful
    // bucket when the disconnect that preceded it was an ungraceful kill —
    // see killUngracefully() below — since mixing that in with normal
    // graceful reconnect times would hide how much slower recovery is from
    // an unclean disconnect.
    if (client.disconnectedAt) {
      const latencyMs = Date.now() - client.disconnectedAt;
      if (client.pendingReconnectWasUngraceful) {
        stats.ungracefulReconnectTimesMs.push(latencyMs);
        stats.ungracefulReconnectCountAllTime++;
        stats.ungracefulReconnectSumMsAllTime += latencyMs;
        if (stats.ungracefulReconnectMinMsAllTime === null || latencyMs < stats.ungracefulReconnectMinMsAllTime) stats.ungracefulReconnectMinMsAllTime = latencyMs;
        if (stats.ungracefulReconnectMaxMsAllTime === null || latencyMs > stats.ungracefulReconnectMaxMsAllTime) stats.ungracefulReconnectMaxMsAllTime = latencyMs;
        client.pendingReconnectWasUngraceful = false;
      } else {
        stats.reconnectTimesMs.push(latencyMs);
        stats.reconnectCountAllTime++;
        stats.reconnectSumMsAllTime += latencyMs;
        if (stats.reconnectMinMsAllTime === null || latencyMs < stats.reconnectMinMsAllTime) stats.reconnectMinMsAllTime = latencyMs;
        if (stats.reconnectMaxMsAllTime === null || latencyMs > stats.reconnectMaxMsAllTime) stats.reconnectMaxMsAllTime = latencyMs;
      }
      client.disconnectedAt = null;
    }

    if (CONFIG.verbose) console.log(`[${wallClock()}] [${client.index}] connected (${client.readerId})`);
  });

  socket.on('disconnect', (reason) => {
    stats.connected--;
    stats.totalDisconnects++;
    client.disconnectedAt = Date.now();

    if (client.expectingDisconnect) {
      if (CONFIG.verbose) console.log(`[${wallClock()}] [${client.index}] disconnected (${reason})`);
    } else {
      // We did NOT initiate this — a network drop, a server-side drop, or
      // (as happened during an earlier test) the host machine's display
      // sleeping and suspending the VM. This counter makes an incident like
      // that visible directly in this log at the moment it happens, instead
      // of needing to cross-reference server-side pidstat/lsof captures
      // after the fact to work out when something went wrong.
      stats.unexpectedDisconnects++;
      if (CONFIG.verbose) console.log(`[${wallClock()}] [${client.index}] ⚠ UNEXPECTED disconnect (${reason})`);
    }
    client.expectingDisconnect = false;
  });

  socket.on('connect_error', (err) => {
    stats.connectErrors++;
    if (CONFIG.verbose) console.log(`[${wallClock()}] [${client.index}] connect_error: ${err.message}`);
  });

  socket.on('state-update', () => {
    stats.stateUpdatesRecv++;
  });

  client.socket = socket;
}

// ── Ungraceful kill ────────────────────────────────────────────────────────
//
// Bypasses socket.io's clean close handshake by reaching into the underlying
// transport and forcibly terminating the raw WebSocket, rather than calling
// the normal socket.disconnect(). This is a genuinely different code path
// on the server: a graceful disconnect sends an explicit close packet the
// server processes immediately (reason "client namespace disconnect"); this
// instead looks like the connection just vanished, which the server can
// only notice via its own transport-level error handling or (in the worst
// case, e.g. real packet loss with no signal reaching the server at all)
// its ping/pong heartbeat timeout — socket.io defaults to a 25s ping
// interval + 20s timeout, so up to ~45s worst case before it would notice.
//
// Caveat worth knowing: on a healthy local network (like a test VM talking
// to a Pi on the same LAN), forcibly closing the local TCP socket usually
// still sends a TCP reset the server's OS receives quickly — so in practice
// this often gets detected in seconds, not the full 45s worst case. That
// worst case only really happens with genuine packet loss (a phone that
// truly drops off the network with no packets reaching the server either
// way), which isn't practical to simulate reliably from application-level
// JS. What this DOES reliably test: whether the server handles an unclean
// transport-level disconnect correctly (same cleanup as a graceful one, no
// leaked state) — it just may not do so as slowly as a true worst case.
//
// Because we deliberately avoid calling socket.disconnect() here, socket.io-
// client's own reconnection:true logic (already configured in connectClient)
// takes over automatically on this SAME socket object — no manual
// setTimeout+connectClient() call is needed or wanted here; creating a
// second socket for the same client while the original is also trying to
// auto-reconnect would risk two live connections for one readerId.
function killUngracefully(client) {
  const socket    = client.socket;
  const transport = socket && socket.io && socket.io.engine && socket.io.engine.transport;
  if (transport && transport.ws && typeof transport.ws.terminate === 'function') {
    transport.ws.terminate();
    return true;
  }
  return false;   // not on websocket transport yet (rare) — caller falls back to graceful
}

function spawnClient(index) {
  const isBackstage = Math.random() < CONFIG.backstageRatio;
  const prefix = isBackstage ? 'WEBB' : 'WEBR';
  const client = { index, readerId: makeReaderId(prefix), prefix, socket: null };
  clients.push(client);
  connectClient(client);
}

console.log(`\n🔦 WordLight load test`);
console.log(`   Target:            ${SERVER_URL}`);
console.log(`   Fake clients:      ${CONFIG.count} (${Math.round(CONFIG.backstageRatio * 100)}% backstage / ${Math.round((1 - CONFIG.backstageRatio) * 100)}% reader)`);
console.log(`   Ramp:              ${CONFIG.rampMs}ms between connections (~${((CONFIG.count * CONFIG.rampMs) / 1000).toFixed(1)}s total ramp-up)`);
console.log(`   Duration:          ${CONFIG.duration > 0 ? CONFIG.duration + 's' : 'until Ctrl+C'}`);
console.log(`   Simulate nav:      ${CONFIG.simulateNav ? 'YES — will overwrite loaded script' : 'no'}`);
if (CONFIG.churnPercent > 0) {
  console.log(`   Churn:             ${CONFIG.churnPercent}% of clients every ${CONFIG.churnIntervalMs}ms (reconnect after ${CONFIG.churnReconnectMs}-${CONFIG.churnReconnectMs + CONFIG.churnReconnectJitterMs}ms)`);
  if (CONFIG.ungracefulPercent > 0) {
    console.log(`   Ungraceful:        ${CONFIG.ungracefulPercent}% of churned clients killed abruptly (no clean close)`);
  }
} else {
  console.log(`   Churn:             off (steady connections only)`);
}
initCsv();

if (CONFIG.simulateNav) {
  console.log('⚠️  --simulate-nav is ON. Starting in 3 seconds — Ctrl+C now to abort if');
  console.log('   this server has a real script loaded that you don\'t want replaced.\n');
}

function startRampUp() {
  for (let i = 0; i < CONFIG.count; i++) {
    setTimeout(() => spawnClient(i), i * CONFIG.rampMs);
  }
}

// ── Simulated controller (optional, gated by --simulate-nav) ───────────────
//
// Connects as a real controller would, loads a small demo script, then
// advances the current line on a timer. This exercises the exact code path
// that matters most under load: server.js broadcasting a 'state-update' to
// every connected reader every time the line changes — the real-world
// equivalent of a presenter clicking through a show with a full house.

let navInterval = null;

function startSimulatedController() {
  controllerSocket = io(SERVER_URL, {
    query: { type: 'controller' },
    reconnection: true,
  });

  controllerSocket.on('connect', () => {
    console.log('[controller] connected — loading demo script...');

    const demoLines = [];
    for (let i = 1; i <= CONFIG.demoLines; i++) {
      demoLines.push(`Load test line ${i} of ${CONFIG.demoLines} — the quick brown fox jumps.`);
    }

    controllerSocket.emit('load-script', { lines: demoLines, currentIndex: 0 });

    let idx = 0;
    navInterval = setInterval(() => {
      idx = (idx + 1) % demoLines.length;
      controllerSocket.emit('update-index', { currentIndex: idx });
      stats.navAdvances++;
      if (CONFIG.verbose) console.log(`[controller] advanced to line ${idx + 1}`);
    }, CONFIG.navIntervalMs);
  });

  controllerSocket.on('connect_error', (err) => {
    console.error(`[controller] connect_error: ${err.message}`);
  });
}

// ── Churn simulation ─────────────────────────────────────────────────────
//
// Periodically disconnects a random slice of currently-connected clients,
// then reconnects each one after a short randomised delay — mimicking a
// phone locking, backgrounding, or briefly losing WiFi. Each client keeps
// its ORIGINAL readerId across the churn cycle (see connectClient/spawnClient
// above), so this specifically exercises the "known reader reconnecting"
// path in server.js's registerReader(), not first-time connections.
//
// Deliberately creates a brand NEW socket.io connection on reconnect rather
// than relying on socket.io-client's own automatic reconnection logic —
// calling socket.disconnect() explicitly (as done below) suppresses that
// built-in auto-reconnect, so this timer is the only thing bringing the
// client back, giving predictable, controllable churn timing.

let churnInterval = null;

function startChurn() {
  if (CONFIG.churnPercent <= 0) return;

  churnInterval = setInterval(() => {
    const eligible = clients.filter(c => c.socket && c.socket.connected);
    const churnQty = Math.round(clients.length * (CONFIG.churnPercent / 100));
    if (churnQty === 0 || eligible.length === 0) return;

    // Sample churnQty distinct clients at random from those currently connected
    const pool = eligible.slice();
    const toChurn = [];
    for (let i = 0; i < Math.min(churnQty, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      toChurn.push(pool.splice(idx, 1)[0]);
    }

    toChurn.forEach((client) => {
      client.expectingDisconnect = true;   // this disconnect is intentional — don't count it as unexpected
      stats.churnEvents++;

      const goUngraceful = CONFIG.ungracefulPercent > 0 &&
        Math.random() * 100 < CONFIG.ungracefulPercent;

      if (goUngraceful) {
        client.pendingReconnectWasUngraceful = true;
        const ok = killUngracefully(client);
        if (ok) {
          stats.ungracefulChurnEvents++;
          // No manual reconnect scheduling — socket.io-client's own
          // reconnection logic handles this automatically (see
          // killUngracefully's comment above for why).
          return;
        }
        // Couldn't get the raw websocket (rare) — fall through to graceful
        client.pendingReconnectWasUngraceful = false;
      }

      // Graceful path (the default, and the fallback above)
      client.socket.disconnect();
      stats.gracefulChurnEvents++;
      const delay = CONFIG.churnReconnectMs + Math.floor(Math.random() * CONFIG.churnReconnectJitterMs);
      setTimeout(() => connectClient(client), delay);
    });

    if (CONFIG.verbose) {
      console.log(`[${wallClock()}] [churn] cycled ${toChurn.length} clients` +
        (CONFIG.ungracefulPercent > 0 ? ` (${stats.gracefulChurnEvents} graceful / ${stats.ungracefulChurnEvents} ungraceful cumulative)` : ` (cumulative: ${stats.churnEvents})`));
    }
  }, CONFIG.churnIntervalMs);
}

// ── Status reporting ──────────────────────────────────────────────────────

// Reconnect latency stats (min/avg/max), computed from stats.reconnectTimesMs.
// Only reflects events SINCE THE LAST call — the array is drained each time
// so the numbers describe "since the last status line" rather than an
// all-time average that would get harder to move as the test goes on.
function drainReconnectStats() {
  const times = stats.reconnectTimesMs;
  stats.reconnectTimesMs = [];
  if (times.length === 0) return { min: null, avg: null, max: null, count: 0 };
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  return { min, avg, max, count: times.length };
}

// Same as above, but for the ungraceful-kill reconnect bucket specifically.
function drainUngracefulReconnectStats() {
  const times = stats.ungracefulReconnectTimesMs;
  stats.ungracefulReconnectTimesMs = [];
  if (times.length === 0) return { min: null, avg: null, max: null, count: 0 };
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  return { min, avg, max, count: times.length };
}

// CSV output — one row per status interval. Columns are written in a fixed
// order regardless of which flags are active (simulate-nav / churn off just
// leaves those columns at 0), so the file is always safe to load into a
// spreadsheet or parse with a script without conditional column handling.
function initCsv() {
  const csvHeader = 'wall_clock,elapsed_s,connected,peak_connected,total_connects,' +
    'total_disconnects,unexpected_disconnects,connect_errors,state_updates_recv,' +
    'nav_advances,churn_events,graceful_churn_events,ungraceful_churn_events,' +
    'reconnect_min_ms,reconnect_avg_ms,reconnect_max_ms,reconnect_count,' +
    'ungraceful_reconnect_min_ms,ungraceful_reconnect_avg_ms,ungraceful_reconnect_max_ms,' +
    'ungraceful_reconnect_count,client_rss_mb\n';
  fs.writeFileSync(CONFIG.csvFile, csvHeader);
  console.log(`   CSV log:           ${CONFIG.csvFile}\n`);
}

function appendCsvRow(elapsed, rssMb, reconnectStats, ungracefulReconnectStats) {
  const row = [
    wallClock(),
    elapsed,
    stats.connected,
    stats.peakConnected,
    stats.totalConnects,
    stats.totalDisconnects,
    stats.unexpectedDisconnects,
    stats.connectErrors,
    stats.stateUpdatesRecv,
    stats.navAdvances,
    stats.churnEvents,
    stats.gracefulChurnEvents,
    stats.ungracefulChurnEvents,
    reconnectStats.min ?? '',
    reconnectStats.avg ?? '',
    reconnectStats.max ?? '',
    reconnectStats.count,
    ungracefulReconnectStats.min ?? '',
    ungracefulReconnectStats.avg ?? '',
    ungracefulReconnectStats.max ?? '',
    ungracefulReconnectStats.count,
    rssMb,
  ].join(',') + '\n';
  fs.appendFileSync(CONFIG.csvFile, row);
}

function printStatus() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
  const reconnectStats = drainReconnectStats();
  const ungracefulReconnectStats = drainUngracefulReconnectStats();

  console.log(
    `[${wallClock()} | ${elapsed}s] connected: ${stats.connected}/${CONFIG.count}` +
    `  peak: ${stats.peakConnected}` +
    `  state-updates recv: ${stats.stateUpdatesRecv}` +
    (CONFIG.simulateNav ? `  nav advances: ${stats.navAdvances}` : '') +
    (CONFIG.churnPercent > 0 ? `  churn events: ${stats.churnEvents}` : '') +
    (CONFIG.ungracefulPercent > 0 ? ` (${stats.ungracefulChurnEvents} ungraceful)` : '') +
    `  connect errors: ${stats.connectErrors}` +
    (stats.unexpectedDisconnects > 0 ? `  ⚠ UNEXPECTED disconnects: ${stats.unexpectedDisconnects}` : '') +
    (reconnectStats.count > 0 ? `  reconnect: ${reconnectStats.min}/${reconnectStats.avg}/${reconnectStats.max}ms` : '') +
    (ungracefulReconnectStats.count > 0 ? `  ungraceful reconnect: ${ungracefulReconnectStats.min}/${ungracefulReconnectStats.avg}/${ungracefulReconnectStats.max}ms` : '') +
    `  [this script's own RAM: ${rssMb}MB]`
  );

  appendCsvRow(elapsed, rssMb, reconnectStats, ungracefulReconnectStats);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────

function shutdown() {
  console.log('\n🛑 Shutting down — disconnecting all clients...');
  if (navInterval) clearInterval(navInterval);
  if (churnInterval) clearInterval(churnInterval);
  clearInterval(statusTimer);

  clients.forEach((c) => {
    c.expectingDisconnect = true;   // shutdown disconnects are intentional, not unexpected
    if (c.socket) c.socket.disconnect();
  });
  if (controllerSocket) controllerSocket.disconnect();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n── Summary ──────────────────────────────────────────────');
  console.log(`   Duration:              ${elapsed}s`);
  console.log(`   Peak connected:        ${stats.peakConnected}`);
  console.log(`   Total connects:        ${stats.totalConnects} (includes reconnects)`);
  console.log(`   Total disconnects:     ${stats.totalDisconnects}`);
  console.log(`   Connect errors:        ${stats.connectErrors}`);
  console.log(`   Unexpected disconnects:${stats.unexpectedDisconnects}` +
    (stats.unexpectedDisconnects > 0 ? '  ⚠ see CSV for exact timestamp(s)' : ''));
  console.log(`   State-updates received:${stats.stateUpdatesRecv}`);
  if (CONFIG.simulateNav) console.log(`   Nav advances sent:     ${stats.navAdvances}`);
  if (CONFIG.churnPercent > 0) {
    console.log(`   Churn events:          ${stats.churnEvents}` +
      (CONFIG.ungracefulPercent > 0 ? ` (${stats.gracefulChurnEvents} graceful / ${stats.ungracefulChurnEvents} ungraceful)` : ''));
  }
  if (stats.reconnectCountAllTime > 0) {
    const avgAllTime = Math.round(stats.reconnectSumMsAllTime / stats.reconnectCountAllTime);
    console.log(`   Reconnect latency:     ${stats.reconnectMinMsAllTime}/${avgAllTime}/${stats.reconnectMaxMsAllTime}ms (min/avg/max, n=${stats.reconnectCountAllTime})`);
  }
  if (stats.ungracefulReconnectCountAllTime > 0) {
    const avgUngraceful = Math.round(stats.ungracefulReconnectSumMsAllTime / stats.ungracefulReconnectCountAllTime);
    console.log(`   Ungraceful reconnect:  ${stats.ungracefulReconnectMinMsAllTime}/${avgUngraceful}/${stats.ungracefulReconnectMaxMsAllTime}ms (min/avg/max, n=${stats.ungracefulReconnectCountAllTime})`);
  }
  console.log(`   CSV log written to:    ${CONFIG.csvFile}`);
  console.log('────────────────────────────────────────────────────────\n');

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────

const statusTimer = setInterval(printStatus, CONFIG.statusInterval * 1000);

if (CONFIG.simulateNav) {
  setTimeout(() => {
    startRampUp();
    startSimulatedController();
    startChurn();
  }, 3000);
} else {
  startRampUp();
  startChurn();
}

if (CONFIG.duration > 0) {
  setTimeout(shutdown, CONFIG.duration * 1000 + (CONFIG.simulateNav ? 3000 : 0));
}
