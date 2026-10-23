// backup-web.js — the logging page's "Download a backup" button
// =============================================================================
//
// Makes the same backup file as setup.sh's menu 13 (Back up), by running the
// same setup/backup_tool.py, so setup.sh's Restore reads either one. What goes
// in: the Scripts folder, WordLight's settings (.env with every password and
// the session secret taken out, the theater name and support email, the
// logos), and the Script Converter's program and settings (its jobs if asked).
//
// Admin login only. Like setup.sh, it refuses while anyone is connected
// (controllers, readers or backstage), so it can't slow a show down; the
// logging page itself isn't counted.
//
// A backup on a Pi 3 can take minutes, longer than a browser waits for one
// request, so it runs in the background: POST starts it, the page asks for
// the status every 2 seconds, then downloads the finished file. The file is
// made in ~/WordLight-backups (not /tmp, which is in memory on Raspberry Pi
// OS), so a copy also stays on the Pi, where setup.sh's Restore lists it.
//
//   GET  /api/backup/status          {available, reason, converter, jobsBytes, job}
//   POST /api/backup  {jobs: bool}   202 {started: true}; 409 {error} when in use or busy
//   GET  /api/backup/download?name=  the file (only WordLight-backup-*.tar.gz from that folder)
//
// Only counts and sizes from backup_tool.py are passed on, never file contents.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME = os.homedir();
// The Script Converter's folders: where setup.sh installs them (CONV_* in setup.sh)
const CONV_DIR      = path.join(HOME, 'script-converter');
const CONV_SETTINGS = path.join(HOME, 'script-converter-settings');
const CONV_JOBS     = path.join(HOME, 'script-converter-jobs');
const BACKUP_DIR    = path.join(HOME, 'WordLight-backups');
const OWN_FILES     = ['public/favicon.png', 'public/iconlarge.png'];   // setup.sh's OWN_FILES
const NAME_RE       = /^WordLight-backup-[A-Za-z0-9._-]+\.tar\.gz$/;
const MAX_RUN_MS    = 60 * 60 * 1000;   // a backup still running after an hour is stopped

let pythonChecked = null;   // null = not asked yet; then true / false
function pythonOk() {
  if (pythonChecked === null) {
    try {
      execFileSync('python3', ['-c', 'import tarfile, gzip, hashlib'], { timeout: 10000, stdio: 'ignore' });
      pythonChecked = true;
    } catch (e) {
      pythonChecked = false;
    }
  }
  return pythonChecked;
}

// Bytes in a folder, not following links (for the "include the jobs?" size)
function folderBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch (err) { /* gone */ } }
    }
  }
  return total;
}

function converterInstalled() { return fs.existsSync(path.join(CONV_DIR, 'convert.py')); }

function converterVersion() {
  try {
    const src = fs.readFileSync(path.join(CONV_DIR, 'scriptconv', '__init__.py'), 'utf8');
    const m = src.match(/^VERSION = "([^"]+)"/m);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

// The same text as setup.sh's wl_version: "0.9.3 (commit 43f3eef, 2026-10-23)"
function wordlightVersion(projectDir, version) {
  try {
    const c = execFileSync('git', ['-C', projectDir, 'log', '-1', '--format=%h, %cd', '--date=short'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (c && fs.existsSync(path.join(projectDir, '.git'))) return `${version} (commit ${c})`;
  } catch (e) { /* not a git clone */ }
  return `${version} (installed from a zip)`;
}

// Next free name: a second backup in the same minute gets -2, -3...
function freeName() {
  const host = os.hostname().replace(/[^A-Za-z0-9._-]/g, '-') || 'wordlight';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `WordLight-backup-${host}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  let name = `${base}.tar.gz`;
  for (let k = 2; fs.existsSync(path.join(BACKUP_DIR, name)) || fs.existsSync(path.join(BACKUP_DIR, name + '.partial')); k++) {
    name = `${base}-${k}.tar.gz`;
  }
  return name;
}

// "1 controller, 2 readers" — the same wording as setup.sh
function whoIsConnected(counts) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 && k !== 'backstage' ? k.replace(/s$/, '') : k}`)
    .join(', ');
}

function addBackupRoutes(app, opts) {
  const { requireAuth, getConnectionCounts, askConverter, scriptsDir, scriptsName, projectDir, version } = opts;
  const tool = path.join(projectDir, 'setup', 'backup_tool.py');
  let job = null;   // the backup running now, or the last one: {running, ok, name, size, summary, error, finished}

  function unavailable() {
    if (!fs.existsSync(tool)) return 'setup/backup_tool.py is missing (update WordLight).';
    if (!pythonOk()) return 'Backups need python3, which this computer doesn\'t have.';
    return '';
  }

  app.get('/api/backup/status', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const reason = unavailable();
    const conv = converterInstalled();
    res.json({
      available: !reason,
      reason,
      converter: conv,
      jobsBytes: conv && fs.existsSync(CONV_JOBS) ? folderBytes(CONV_JOBS) : 0,
      // elapsed from the server's clock, so a laptop with another time shows it right
      job: job && { ...job, elapsed: Math.round(((job.finished || Date.now()) - job.started) / 1000) },
    });
  });

  app.post('/api/backup', requireAuth, async (req, res) => {
    // Only the page's own fetch (JSON) starts a backup, never a plain form post
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
    const reason = unavailable();
    if (reason) return res.status(409).json({ error: reason });
    if (job && job.running) return res.status(409).json({ error: 'A backup is already being made.' });
    const counts = getConnectionCounts();
    const who = whoIsConnected(counts);
    if (who) {
      return res.status(409).json({
        error: `WordLight is in use right now (${who}). A backup works the Pi hard, so it ` +
               `doesn't run during a show. Close the controller and try again when nobody is connected.`,
      });
    }
    const withJobs = !!(req.body && req.body.jobs) && converterInstalled() && fs.existsSync(CONV_JOBS);
    if (withJobs) {
      const st = await askConverter('GET', '/api/status');
      if (st.ok && st.data && st.data.running) {
        return res.status(409).json({
          error: 'The Script Converter is working on a show right now, so its jobs could be saved ' +
                 'half-done. Try again when it has finished, or leave the jobs out.',
        });
      }
    }
    if (job && job.running) return res.status(409).json({ error: 'A backup is already being made.' });

    let tmp;
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-backup-'));
    } catch (e) {
      return res.status(500).json({ error: `Couldn't make ${BACKUP_DIR} (${e.code || e.message}).` });
    }

    const adds = [];
    if (fs.existsSync(scriptsDir)) adds.push(`scripts=${scriptsDir}`);
    try {
      const lines = fs.readFileSync(path.join(projectDir, 'public', 'global.js'), 'utf8')
        .split('\n').filter((l) => /^const (THEATER_NAME|SUPPORT_EMAIL) = /.test(l));
      if (lines.length) {
        fs.writeFileSync(path.join(tmp, 'branding.txt'), lines.join('\n') + '\n', { mode: 0o600 });
        adds.push(`wordlight/branding.txt=${path.join(tmp, 'branding.txt')}`);
      }
    } catch (e) { /* no global.js: nothing to add */ }
    for (const f of OWN_FILES) {
      if (fs.existsSync(path.join(projectDir, f))) adds.push(`wordlight/own/${f}=${path.join(projectDir, f)}`);
    }
    const convVersion = converterInstalled() ? converterVersion() : '';
    if (converterInstalled()) {
      adds.push(`converter/code=${CONV_DIR}`);
      if (fs.existsSync(CONV_SETTINGS)) adds.push(`converter/settings=${CONV_SETTINGS}`);
      if (withJobs) adds.push(`converter/jobs=${CONV_JOBS}`);
    }

    const name = freeName();
    const args = ['-n', '10', 'python3', tool, 'create', path.join(BACKUP_DIR, name),
      '--env', path.join(projectDir, '.env'),
      '--info', `WordLight=${wordlightVersion(projectDir, version)}`,
      ...(convVersion ? ['--info', `Script Converter=${convVersion}`] : []),
      '--info', `Scripts folder name=${scriptsName}`,
      ...adds.map((a) => `--add=${a}`)];

    job = { running: true, ok: false, name, size: 0, summary: [], error: '', started: Date.now(), finished: null, jobs: withJobs };
    const thisJob = job;
    let out = '';
    let child;
    try {
      child = spawn('nice', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      job.running = false; job.error = `Couldn't start the backup (${e.code || e.message}).`;
      fs.rmSync(tmp, { recursive: true, force: true });
      return res.status(500).json({ error: job.error });
    }
    const keep = (chunk) => { if (out.length < 20000) out += chunk; };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), MAX_RUN_MS);
    const done = (code, why) => {
      if (!thisJob.running) return;
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      const lines = out.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      thisJob.summary = lines.filter((l) => l.startsWith('  ')).map((l) => l.trim()).slice(0, 20);
      thisJob.running = false;
      thisJob.finished = Date.now();
      try { thisJob.size = fs.statSync(path.join(BACKUP_DIR, name)).size; } catch (e) { thisJob.size = 0; }
      thisJob.ok = code === 0 && thisJob.size > 0;
      if (!thisJob.ok) {
        const msg = lines.find((l) => l.startsWith('backup_tool:'));
        thisJob.error = why || (msg ? msg.replace(/^backup_tool:\s*/, '') : `The backup failed (exit ${code}).`);
      }
      console.log(`[backup] ${thisJob.ok ? 'Made' : 'FAILED'} ${name}` +
                  (thisJob.ok ? ` (${thisJob.size} bytes, ${Math.round((thisJob.finished - thisJob.started) / 1000)} s)` : `: ${thisJob.error}`));
    };
    child.on('error', (e) => done(-1, `Couldn't run python3 (${e.code || e.message}).`));
    child.on('close', (code) => done(code));
    console.log(`[backup] Making ${name}${withJobs ? ' (with the converter\'s jobs)' : ''}`);
    res.status(202).json({ started: true, name });
  });

  app.get('/api/backup/download', requireAuth, (req, res) => {
    const name = String(req.query.name || '');
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Not a backup file name.' });
    const full = path.join(BACKUP_DIR, name);
    let st;
    try { st = fs.lstatSync(full); } catch (e) { return res.status(404).json({ error: 'That backup isn\'t there any more.' }); }
    if (!st.isFile()) return res.status(404).json({ error: 'That backup isn\'t there any more.' });
    res.setHeader('Cache-Control', 'no-store');
    res.download(full, name);
  });
}

module.exports = { addBackupRoutes, BACKUP_DIR };
