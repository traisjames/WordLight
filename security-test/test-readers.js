#!/usr/bin/env node
/**
 * test-readers.js — security harness for what an audience device can do
 * =====================================================================
 *
 * A reader (an audience phone or tablet) needs no login. It chooses its own ID,
 * in the address it connects with, and it can ask the server for anything a
 * public page can. Anyone on the venue network can write a program that
 * pretends to be one. This harness starts the REAL server.js on a throwaway
 * loopback port and checks that such a device cannot:
 *
 *   - read the script        GET /api/state needs the admin login, and a reader
 *                            is only ever sent the few lines it shows
 *   - fill the server up     IDs are cut to MAX_READER_ID_LENGTH characters and
 *                            copied (a cut-down string can keep the whole
 *                            original alive in memory), and no more than
 *                            MAX_UNIQUE_READER_IDS of them are remembered
 *   - forge a log row        control characters are removed from IDs, so an ID
 *                            with a line break can't start a new row in the
 *                            CSV session log
 *
 * and that ordinary readers (every kind of ID, renamed devices, no ID at all)
 * are still counted, and still sent their captions.
 *
 *   node test-readers.js                    test ../server.js
 *   node test-readers.js path/to/server.js  test another copy (the rest of the
 *                                           project must be around it)
 *   node test-readers.js --quick            skip the memory test
 *
 * Exit code 0 = all clear, 1 = at least one check failed, 2 = could not run.
 *
 * Nothing real is touched. The server gets its own ports, a throwaway admin
 * password, no .env (it is started in an empty folder), no certificates and an
 * empty Scripts folder, and listens on the loopback address only (see
 * server-probe.js). The script it is given is made up, and never printed.
 */

const fs     = require('fs');
const os     = require('os');
const net    = require('net');
const dgram  = require('dgram');
const path   = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  console.error("This test needs the 'ws' package, which comes with socket.io.");
  console.error('Run "npm install" in the project folder first.');
  process.exit(2);
}

// ── What to test ──────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const QUICK  = args.includes('--quick');
const SERVER = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'server.js'));
const PROBE  = path.join(__dirname, 'server-probe.js');
if (!fs.existsSync(SERVER)) {
  console.error(`Could not find ${SERVER}`);
  process.exit(2);
}

// Read the server's own limits and kinds of reader rather than hardcoding
// them, so this harness can't drift out of sync with what the server enforces.
const SRC = fs.readFileSync(SERVER, 'utf8');
function limit(name) {
  const m = SRC.match(new RegExp(name + '\\s*=\\s*([\\d_]+)'));
  return m ? parseInt(m[1].replace(/_/g, ''), 10) : null;
}
const MAX_ID_LENGTH = limit('MAX_READER_ID_LENGTH');
const MAX_IDS       = limit('MAX_UNIQUE_READER_IDS');
const prefixList    = (SRC.match(/READER_PREFIXES\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
const PREFIXES      = (prefixList.match(/'[^']+'/g) || []).map(s => s.slice(1, -1));
if (PREFIXES.length === 0) {
  console.error('Could not read READER_PREFIXES out of server.js.');
  process.exit(2);
}

// How big the flood in the memory test is. Before the fix, a wave of this many
// readers with 12,000-character IDs left about 12 MB behind; after it, well
// under 1 MB. The limit sits between the two.
const WAVE     = 1000;
const LIMIT_MB = 4;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── A throwaway server ────────────────────────────────────────────────────
const running = [];            // every server started, so none is left behind

function freePort(udp) {
  return new Promise((resolve, reject) => {
    const s = udp ? dgram.createSocket('udp4') : net.createServer();
    s.once('error', reject);
    const listening = () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    };
    if (udp) s.bind(0, '127.0.0.1', listening);
    else     s.listen(0, '127.0.0.1', listening);
  });
}

const tail = (text) => text.trim().split('\n').slice(-12).join('\n');

async function startServer({ cap } = {}) {
  const port    = await freePort(false);
  const oscPort = await freePort(true);
  const home    = fs.mkdtempSync(path.join(os.tmpdir(), 'wordlight-readers-'));
  const secret  = (bytes) => crypto.randomBytes(bytes).toString('hex');
  const srv = {
    port, home, output: '',
    adminPassword:  secret(12),
    editorPassword: secret(12),
  };
  const env = {
    PATH: process.env.PATH, HOME: home,
    PORT: String(port), HTTPS_ENABLED: 'false', OSC_PORT: String(oscPort),
    ADMIN_USERNAME: 'admin',   ADMIN_PASSWORD:  srv.adminPassword,
    EDITOR_USERNAME: 'editor', EDITOR_PASSWORD: srv.editorPassword,
    SESSION_SECRET: secret(16),
    SCRIPTS_DIR: path.join(home, 'Scripts'),
    CONVERTER_URL: 'off',
  };
  if (cap) env.WL_TEST_READER_CAP = String(cap);

  // Started in the empty folder, so dotenv finds no .env to read.
  srv.child = fork(SERVER, [], { cwd: home, env, silent: true, execArgv: ['--expose-gc', '--require', PROBE] });
  srv.child.stdout.on('data', d => { srv.output += d; });
  srv.child.stderr.on('data', d => { srv.output += d; });
  srv.exited = new Promise(resolve => srv.child.once('exit', resolve));
  srv.alive  = () => srv.child.exitCode === null && srv.child.signalCode === null;
  running.push(srv);

  srv.heap = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not report its memory')), 30000);
    const onMessage = (m) => {
      if (m && m.wlProbe === 'heap') {
        clearTimeout(timer);
        srv.child.off('message', onMessage);
        resolve(m.heapUsed);
      }
    };
    srv.child.on('message', onMessage);
    srv.child.send({ wlProbe: 'heap' });
  });

  srv.stop = async () => {
    if (srv.alive()) {
      srv.child.kill('SIGTERM');
      await Promise.race([srv.exited, sleep(3000)]);
    }
    if (srv.alive()) srv.child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  };

  const began = Date.now();
  for (;;) {
    if (!srv.alive()) throw new Error('the test server stopped while starting:\n' + tail(srv.output));
    try { if ((await fetch(`http://127.0.0.1:${port}/reader`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() - began > 20000) throw new Error('the test server did not start in 20 seconds:\n' + tail(srv.output));
    await sleep(150);
  }
  return srv;
}

// Whatever happens, no test server is left running and no folder left behind.
process.on('exit', () => {
  for (const srv of running) {
    try { srv.child.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(srv.home, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});
process.on('SIGINT', () => process.exit(130));

// ── Talking to it ─────────────────────────────────────────────────────────
// An answer that never arrives counts as status 0, so a server that has died
// shows up as failed checks rather than as a crash of the harness.
async function request(srv, route, { method = 'GET', cookie } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}${route}`, { method, headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, text: await res.text() };
  } catch {
    return { status: 0, text: '' };
  }
}
function json(response) {
  try { return JSON.parse(response.text); } catch { return null; }
}

// The cookie string for a login, or '' when it was refused.
async function login(srv, username, password) {
  const res = await fetch(`http://127.0.0.1:${srv.port}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}

// Raw Engine.IO / Socket.IO frames: "0" open, "40" connect, "42[...]" event,
// "43<id>[...]" acknowledgement, "2" and "3" ping and pong. Written by hand so
// the test needs nothing but 'ws', and can send what a real client never would.

// Joins as an audience reader. Resolves once the server has pushed the reader
// its state (or after `wait` ms, or when the connection fails). `idQuery` is
// the part of the address that carries the ID, e.g. '&readerId=WEBR-abc'.
function joinReader(srv, idQuery, { keepOpen = false, wait = 4000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/socket.io/?EIO=4&transport=websocket&type=reader${idQuery}`,
                             { perMessageDeflate: false });
    let state = null, done = false;
    const timer = setTimeout(() => finish(), wait);
    function finish(extra) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!keepOpen) ws.close();
      resolve({ ws, state, ...extra });
    }
    ws.on('message', (data) => {
      const text = data.toString();
      if (text[0] === '0') ws.send('40');
      else if (text === '2') ws.send('3');
      else if (text.startsWith('42["state-update",')) { state = JSON.parse(text.slice(2))[1]; finish(); }
    });
    ws.on('unexpected-response', (req, res) => finish({ refused: res.statusCode }));
    ws.on('error', () => finish());
    ws.on('close', () => finish());
  });
}

// Loads a script through a controller socket (the admin login's cookie is what
// lets it in). Resolves with the server's acknowledgement.
function loadScript(srv, cookie, lines, currentIndex) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/socket.io/?EIO=4&transport=websocket&type=controller`,
                             { headers: { Cookie: cookie }, perMessageDeflate: false });
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, error: 'no answer in 8 seconds' }), 8000);
    function finish(ack) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      resolve(ack);
    }
    ws.on('message', (data) => {
      const text = data.toString();
      if (text[0] === '0') ws.send('40');
      else if (text === '2') ws.send('3');
      else if (text.startsWith('44')) finish({ ok: false, error: 'the controller socket was refused' });
      else if (text.startsWith('40')) ws.send('421' + JSON.stringify(['load-script', { lines, currentIndex }]));
      else if (text.startsWith('431')) finish(JSON.parse(text.slice(3))[0]);
    });
    ws.on('unexpected-response', (req, res) => finish({ ok: false, error: `HTTP ${res.statusCode}` }));
    ws.on('error', () => finish({ ok: false, error: 'connection failed' }));
  });
}

// ── Checks ────────────────────────────────────────────────────────────────
let checks = 0, failed = 0;

function section(title) { console.log('\n' + title); }

function check(ok, label, detail) {
  checks++;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  return ok;
}

const idQuery = (id) => '&readerId=' + encodeURIComponent(id);
const MB      = 1024 * 1024;

async function main() {
  console.log(`Testing ${SERVER}`);
  const srv   = await startServer();
  const admin = await login(srv, 'admin', srv.adminPassword);
  const log   = async () => json(await request(srv, '/api/log', { cookie: admin }));
  const reset = () => request(srv, '/api/log/reset', { method: 'POST', cookie: admin });
  const open  = [];                                    // sockets to close between sections
  const join  = async (id, keep) => {
    const r = await joinReader(srv, idQuery(id), { keepOpen: keep });
    if (keep) open.push(r.ws);
    return r;
  };
  const closeAll = () => { open.splice(0).forEach(ws => ws.close()); };

  // A made-up script. One line, far from the one on show, carries a marker, so
  // "nothing of the script came back" can be checked without printing any of it.
  const MARK  = 'wl-' + crypto.randomBytes(6).toString('hex');
  const LINES = 400, CURRENT = 5;
  const lines = Array.from({ length: LINES }, (_, i) =>
    i === 300 ? `${MARK} is a long way from the line on show` : `Test line ${i} ${'lorem ipsum '.repeat(10)}`);
  const ack = await loadScript(srv, admin, lines, CURRENT);
  if (!ack || ack.ok !== true) throw new Error('could not load the test script: ' + (ack && ack.error));

  // ── 1. The script ───────────────────────────────────────────────────────
  section('GET /api/state: the whole script');
  const anon = await request(srv, '/api/state');
  check(anon.status === 401, 'refused without a login', `HTTP ${anon.status}`);
  check(!anon.text.includes(MARK), 'nothing of the script is in the answer', `${anon.text.length} bytes`);
  const editor = await login(srv, 'editor', srv.editorPassword);
  const edit   = await request(srv, '/api/state', { cookie: editor });
  check(edit.status === 401 && !edit.text.includes(MARK), 'refused for the editor login too', `HTTP ${edit.status}`);
  const full = await request(srv, '/api/state', { cookie: admin });
  const state = json(full);
  check(full.status === 200 && state && Array.isArray(state.lines) && state.lines.length === LINES,
        'the admin login still gets the full state', `HTTP ${full.status}`);

  const first   = await join('WEBR-' + crypto.randomUUID());
  const payload = first.state;
  check(!!payload && typeof payload.current === 'string' && payload.current.startsWith(`Test line ${CURRENT} `),
        'a reader is sent the current line as soon as it connects');
  const sent = payload ? JSON.stringify(payload) : '';
  check(!!payload && !('lines' in payload) && !sent.includes(MARK),
        'and only the few lines it shows, not the script', `${sent.length} bytes`);

  // ── 2. Ordinary readers ─────────────────────────────────────────────────
  section('Readers with ordinary IDs');
  await reset();
  const ids = [...PREFIXES.map(p => p + crypto.randomUUID()), 'Other-' + crypto.randomUUID()];
  for (const id of ids) await join(id, true);
  const counted = await log();
  check(counted && counted.uniqueReaders === ids.length,
        `all ${PREFIXES.length} kinds of ID, and one with no known prefix, are counted`,
        counted ? `${counted.uniqueReaders} of ${ids.length}` : 'no answer');
  check(counted && PREFIXES.every(p => counted.breakdown[p] === 1) && counted.breakdown.other === 1,
        'each is counted under its own kind');
  const backstage = PREFIXES.filter(p => p.endsWith('B-')).length;
  const conn = json(await request(srv, '/api/connections')) || {};
  check(conn.backstage === backstage, 'the backstage kinds join the backstage room', `${conn.backstage} of ${backstage}`);
  check(conn.readers === ids.length - backstage, 'and the audience count leaves them out', `${conn.readers} of ${ids.length - backstage}`);
  closeAll();

  const names = ['iOSR-Front Desk iPad & more', 'iOSR-Café ☕ 日本', 'ANDR-Pixel 7 (Lobby)'];
  for (const name of names) await join(name);
  const renamed = await log();
  check(renamed && renamed.uniqueReaders === ids.length + names.length,
        'renamed devices (spaces, &, accents, an emoji, Japanese) are counted',
        renamed ? `${renamed.uniqueReaders} of ${ids.length + names.length}` : 'no answer');

  // ── 3. IDs that are not text ────────────────────────────────────────────
  section('Readers with no usable ID');
  const odd = [
    ['no ID at all', ''],
    ['an empty ID',  '&readerId='],
  ];
  const before = await log();
  for (const [what, query] of odd) {
    const r = await joinReader(srv, query);
    check(!!r.state, `${what}: still sent its captions`);
  }
  const after = await log();
  check(after && before && after.uniqueReaders === before.uniqueReaders, 'none of them is counted as a unique reader');
  check(after && before && after.totalSessions === before.totalSessions + odd.length, 'but each is counted as a session');
  if (!check(srv.alive(), 'the server is still running')) return;

  // ── 4. Hostile IDs ──────────────────────────────────────────────────────
  section('Readers with hostile IDs');
  const hostile = 'ANDR-bad\r\nFORGED-ROW\u0000\u001b[31m\u0007\u007fend';
  const long    = 'ANDR-long-' + 'x'.repeat(10000);
  check(!!(await join(hostile)).state, 'a line break and other control characters in an ID: still sent its captions');
  check(!!(await join(long)).state,    'an ID of 10,000 characters: still sent its captions');
  // The ID twice: socket.io keeps the last one (some versions made it a list,
  // which is not text), so all that can be asked is that it counts at most once.
  const beforeTwice = await log();
  const twice = await joinReader(srv, '&readerId=ANDR-twice-a&readerId=ANDR-twice-b');
  const afterTwice = await log();
  check(!!twice.state, 'the ID sent twice: still sent its captions');
  check(afterTwice && beforeTwice && afterTwice.uniqueReaders - beforeTwice.uniqueReaders <= 1,
        'and counted as one reader at most');
  if (!check(srv.alive(), 'the server is still running')) return;

  // ── 5. The CSV session log ──────────────────────────────────────────────
  section('The CSV session log');
  const readers = ((await log()) || {}).uniqueReaders;  // each ID connected once, so one row each
  const csv     = await request(srv, '/api/log/export', { cookie: admin });
  check(csv.status === 200, 'can be downloaded', `HTTP ${csv.status}`);
  const all     = csv.text.split('\r\n');
  const rows    = all.slice(all.indexOf('Timestamp,Reader ID') + 1);
  const shape   = /^\d{4}-\d\d-\d\dT[\d:.]+Z,[^\u0000-\u001f\u007f]+$/;
  check(csv.status === 200 && readers >= ids.length + names.length + 2 &&
        rows.length === readers && rows.every(r => shape.test(r)),
        'every row is a timestamp and one line of printable text, one row to a reader',
        `${rows.length} rows for ${readers} readers`);
  check(csv.status === 200 && !/[\u0000-\u001f\u007f]/.test(csv.text.replace(/\r\n/g, '')),
        'no control character reached the log, only the line breaks between rows');
  const stored = (rows.find(r => r.includes(',ANDR-long-')) || ',').split(',')[1];
  const wanted = MAX_ID_LENGTH === null ? 64 : MAX_ID_LENGTH;
  check(MAX_ID_LENGTH !== null && stored.length > 0 && stored.length <= wanted,
        `an ID of 10,000 characters is kept to ${wanted} at most`, `${stored.length} characters kept`);
  check(names.every(n => rows.some(r => r.endsWith(',' + n))),
        'renamed devices are written out intact');
  closeAll();

  // ── 6. Memory ───────────────────────────────────────────────────────────
  if (QUICK) {
    console.log('\nMemory: skipped (--quick)');
  } else {
    section('Memory: what a flood of readers leaves behind');
    const floods = [
      [`${WAVE} readers with IDs of 12,000 characters`,
       (i) => `&readerId=ANDR-w1-${i}-` + 'x'.repeat(12000)],
      [`${WAVE} readers with normal IDs in very long addresses`,
       (i) => `&readerId=ANDR-w2-${i}-${crypto.randomUUID()}&junk=` + 'x'.repeat(12000)],
    ];
    for (const [label, query] of floods) {
      const start = await srv.heap();
      let connected = 0;
      for (let i = 0; i < WAVE; i += 100) {
        const batch = await Promise.all(Array.from({ length: Math.min(100, WAVE - i) }, (_, k) =>
          joinReader(srv, query(i + k), { wait: 8000 })));
        connected += batch.filter(r => r.state).length;
      }
      await sleep(1500);                               // let the server see them leave
      const grown = ((await srv.heap()) - start) / MB;
      check(connected >= WAVE * 0.95, `${label} connected`, `${connected} of ${WAVE}`);
      check(grown < LIMIT_MB, `${label}: the server holds on to little afterwards`,
            `live memory grew ${grown.toFixed(1)} MB, limit ${LIMIT_MB} MB`);
    }
  }

  await srv.stop();

  // ── 7. The limit on remembered IDs ──────────────────────────────────────
  section('The limit on remembered IDs (the server is started with it lowered to 5)');
  if (MAX_IDS === null) {
    check(false, 'server.js has a limit on the IDs it remembers (MAX_UNIQUE_READER_IDS)');
    return;
  }
  const capped = await startServer({ cap: 5 });
  const cookie = await login(capped, 'admin', capped.adminPassword);
  const count  = async () => json(await request(capped, '/api/log', { cookie })) || {};
  const warnings = async () => { await sleep(300); return (capped.output.match(/\[readers\]/g) || []).length; };
  const visit = async (n, tag) => {
    const got = [];
    for (let i = 0; i < n; i++) got.push((await joinReader(capped, idQuery(`ANDR-${tag}-${i}`))).state);
    return got;
  };

  await request(capped, '/api/log/reset', { method: 'POST', cookie });
  const got = await visit(9, 'a');
  const c1  = await count();
  check(c1.uniqueReaders === 5, 'readers past the limit are not remembered', `${c1.uniqueReaders} of 9 counted, limit 5`);
  check(got.every(Boolean) && c1.totalSessions === 9, 'but all 9 are sent their captions and counted as sessions');
  check(await warnings() === 1, 'one warning is logged, not one for every reader');

  await request(capped, '/api/log/reset', { method: 'POST', cookie });
  check((await count()).uniqueReaders === 0, 'Reset clears the count');
  await visit(7, 'b');
  check((await count()).uniqueReaders === 5, 'and new IDs are remembered again');
  check(await warnings() === 2, 'with a warning again when the limit is reached again');
  await capped.stop();
}

main().then(() => finish(), (err) => {
  console.error('\nCould not finish: ' + err.message);
  return finish(2);
});

async function finish(code) {
  await Promise.all(running.map(s => s.stop().catch(() => {})));
  if (code === undefined) {
    console.log('');
    console.log(failed === 0 ? `PASS — all ${checks} checks passed.` : `FAIL — ${failed} of ${checks} checks failed.`);
    code = failed === 0 ? 0 : 1;
  }
  process.exit(code);
}

// Don't hang for ever if something stops answering.
setTimeout(() => { console.error('\nGave up after 5 minutes.'); process.exit(2); }, 300000).unref();
