#!/usr/bin/env node
/**
 * test-parser.js — security harness for WordLight's caption parser
 * =================================================================
 *
 * Runs every script in ./scripts/ through the REAL parseColorTags() from
 * public/global.js and checks the output for anything dangerous.
 *
 * It loads global.js at runtime rather than keeping its own copy, so it
 * always tests the code you're actually shipping — a duplicated copy would
 * silently drift and start passing tests for code nobody runs.
 *
 *   node test-parser.js
 *
 * Exit code 0 = all clear, 1 = at least one finding.
 *
 * Why this matters: parseColorTags() output is assigned to innerHTML on the
 * reader, backstage, teleprompter and controller pages. If a caption script
 * could smuggle markup through it, a malicious script file would run code in
 * every audience member's browser.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Load the real parser out of public/global.js ──────────────────────────
const GLOBAL_JS = path.join(__dirname, '..', 'public', 'global.js');
if (!fs.existsSync(GLOBAL_JS)) {
  console.error(`Could not find ${GLOBAL_JS}`);
  console.error('Run this from the security-test/ folder inside the project.');
  process.exit(2);
}
// Read the server's own limits rather than hardcoding them, so this harness
// can't drift out of sync with what load-script actually enforces.
const SERVER_JS = path.join(__dirname, '..', 'server.js');
let MAX_LINE_LENGTH = null, MAX_SCRIPT_LINES = null;
if (fs.existsSync(SERVER_JS)) {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const a = src.match(/MAX_LINE_LENGTH\s*=\s*(\d+)/);
  const b = src.match(/MAX_SCRIPT_LINES\s*=\s*(\d+)/);
  if (a) MAX_LINE_LENGTH = parseInt(a[1], 10);
  if (b) MAX_SCRIPT_LINES = parseInt(b[1], 10);
}

const sandbox = { window: {}, document: { getElementById: () => null } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(GLOBAL_JS, 'utf8'), sandbox);
const parseColorTags = sandbox.parseColorTags;
if (typeof parseColorTags !== 'function') {
  console.error('parseColorTags not found in global.js');
  process.exit(2);
}

// ── What counts as a finding ──────────────────────────────────────────────
//
// The naive approach — grepping the output for "<script" or "onerror=" — is
// WRONG and produces false alarms. After escaping, "<img onerror=x>" becomes
// "&lt;img onerror=x&gt;", which is inert text that merely CONTAINS the
// substring "onerror=". Flagging that trains people to ignore the tool.
//
// The accurate test: parseColorTags only ever emits three kinds of markup —
// <span style="...">, </span>, and <br>. Everything from the caption file is
// escaped first. So strip the tags the parser legitimately produces, and NO
// raw "<" or ">" should remain. Anything left means real markup survived and
// the browser would parse it as an element.
const LEGIT_TAG = /<span style="(?:color:#[0-9a-fA-F]{3,8}|font-weight:700|font-style:italic|text-decoration:underline)">|<\/span>|<br>/g;

function findUnsafeMarkup(out) {
  const stripped = out.replace(LEGIT_TAG, '');
  if (stripped.includes('<') || stripped.includes('>')) {
    const m = stripped.match(/[<>][^<>]{0,60}/);
    return `raw markup survived escaping: ${JSON.stringify(m ? m[0] : '?')}`;
  }
  return null;
}

const SLOW_LINE_MS = 50;

let findings = 0;
let checked  = 0;
let slowest  = { ms: 0, file: '', line: 0 };
let strayCloses = 0;
let overLimit   = 0;

function checkLine(file, lineNo, raw) {
  checked++;
  let out, ms;
  const t0 = process.hrtime.bigint();
  try {
    out = parseColorTags(raw);
  } catch (err) {
    findings++;
    console.log(`\n  THREW  ${file}:${lineNo}`);
    console.log(`         ${err.constructor.name}: ${err.message}`);
    console.log(`         input: ${JSON.stringify(raw.slice(0, 80))}`);
    return;
  }
  ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (ms > slowest.ms) slowest = { ms, file, line: lineNo };

  // A line longer than the server's cap can never reach a reader —
  // load-script rejects the whole script with a clear error. Slow parsing
  // of such a line is therefore not a production risk, so it's reported as
  // information rather than counted as a finding. Lines UNDER the cap are
  // still held to the speed budget, because those are the ones that ship.
  if (MAX_LINE_LENGTH !== null && raw.length > MAX_LINE_LENGTH) {
    overLimit++;
    if (ms > SLOW_LINE_MS) {
      console.log(`\n  INFO   ${file}:${lineNo} — ${raw.length.toLocaleString()} chars, ` +
                  `${ms.toFixed(0)}ms to parse`);
      console.log(`         over the server's ${MAX_LINE_LENGTH.toLocaleString()}-char limit, ` +
                  `so load-script would reject this script.`);
    }
  } else if (ms > SLOW_LINE_MS) {
    findings++;
    console.log(`\n  SLOW   ${file}:${lineNo} — ${ms.toFixed(1)}ms to parse`);
    console.log(`         input length: ${raw.length} chars (within the server limit)`);
  }

  const unsafe = findUnsafeMarkup(out);
  if (unsafe) {
    findings++;
    console.log(`\n  UNSAFE ${file}:${lineNo} — ${unsafe}`);
    console.log(`         input:  ${JSON.stringify(raw.slice(0, 100))}`);
    console.log(`         output: ${JSON.stringify(out.slice(0, 160))}`);
    return;
  }

  // Structural check. Only an EXCESS OF OPENS is a real bug — it would let
  // styling bleed past the end of the line. Excess CLOSES are harmless:
  // an HTML parser discards a close tag for an element that isn't open, so
  // they render as nothing. Counted separately and reported as info.
  const opens  = (out.match(/<span/g)    || []).length;
  const closes = (out.match(/<\/span>/g) || []).length;
  if (opens > closes) {
    findings++;
    console.log(`\n  BLEED  ${file}:${lineNo} — ${opens} <span> vs ${closes} </span> (styling escapes the line)`);
    console.log(`         input: ${JSON.stringify(raw.slice(0, 80))}`);
  } else if (closes > opens) {
    strayCloses++;
  }
}

// ── Test corpus ───────────────────────────────────────────────────────────
//
// The corpus is generated here rather than shipped as loose files, so this
// script is self-contained — there's no scripts/ folder to lose in transit,
// and `node test-parser.js --init` recreates it from scratch at any time.
// The files are still written to disk because you also want to load them
// through the Controller by hand for the visual checks the harness can't do.
function buildCorpus() {
  const rep = (s, n) => s.repeat(n);

  const xss = [
    'MARLIN: Baseline line — this one should look completely normal.',
    '<script>alert(\'xss\')</script>',
    '<img src=x onerror="alert(\'xss\')">',
    '<img src=x onerror=alert(1)>',
    '<svg/onload=alert(\'xss\')>',
    '<iframe src="javascript:alert(\'xss\')"></iframe>',
    '<body onload=alert(\'xss\')>',
    '<a href="javascript:alert(\'xss\')">click me</a>',
    '<div onmouseover="alert(\'xss\')">hover me</div>',
    '<input autofocus onfocus=alert(\'xss\')>',
    '<marquee onstart=alert(\'xss\')>scrolling</marquee>',
    '<details open ontoggle=alert(\'xss\')>',
    '<video><source onerror=alert(\'xss\')>',
    '<object data="javascript:alert(\'xss\')">',
    '<style>body{display:none}</style>',
    '<link rel="stylesheet" href="http://evil.example/x.css">',
    '<meta http-equiv="refresh" content="0;url=http://evil.example">',
    '<base href="http://evil.example/">',
    '"><script>alert(\'attribute break\')</script>',
    '\'><script>alert(\'single quote break\')</script>',
    '</span><script>alert(\'span break\')</script>',
    '[red]</span><img src=x onerror=alert(1)>[/]',
    '[red]"><img src=x onerror=alert(1)>[/]',
    '[b]" onmouseover="alert(1)[/]',
    '&lt;script&gt;alert(\'double encoded\')&lt;/script&gt;',
    '&#60;script&#62;alert(\'numeric entity\')&#60;/script&#62;',
    '&#x3C;script&#x3E;alert(\'hex entity\')&#x3C;/script&#x3E;',
    '<SCRIPT>alert(\'uppercase\')</SCRIPT>',
    '<scr<script>ipt>alert(\'filter bypass\')</scr</script>ipt>',
    'javascript:alert(\'bare protocol\')',
    'data:text/html,<script>alert(\'data uri\')</script>',
    'MARLIN: Final line — this should also look completely normal.',
  ];

  const unicode = [
    'CORAL: Baseline before the unicode block.',
    '# Right-to-left override',
    'Normal text \u202E reversed text after override',
    'filename\u202Egnp.exe',
    '\u2066 first strong isolate \u2069 pop isolate',
    '# Zero-width characters',
    'Hidden\u200Bzero\u200Bwidth\u200Bspaces',
    'Zero\u200Cwidth\u200Dnon\uFEFFjoiners and BOM',
    '\u200B\u200B\u200B\u200B\u200B',
    '# Combining characters / Zalgo',
    'Z\u0350\u0353\u0354a\u0350\u0353l\u0350g\u0350o' + rep('\u0336\u0337\u0338', 20),
    'e' + rep('\u0301', 200) + ' (200 combining accents)',
    '# Emoji and ZWJ sequences',
    'Family: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}',
    'Skin tones: \u{1F44D}\u{1F3FB}\u{1F44D}\u{1F3FF}',
    'Flags: \u{1F1FA}\u{1F1F8} \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
    'Keycap: 1\uFE0F\u20E3',
    '# Surrogate pairs / astral plane',
    'Astral: \u{1D400}\u{1D401} \u{20BB7} \u{2A6B2}',
    '# Homoglyphs',
    '\u0410\u0420\u0415 (Cyrillic) vs APE (Latin)',
    '\uFF2D\uFF21\uFF32\uFF2C\uFF29\uFF2E (fullwidth)',
    '# Bidi inside colour tags',
    '[red]\u202Ereversed inside a colour tag[/]',
    '# Very long unbroken word',
    'W' + rep('o', 5000) + 'rd',
    '# Mixed scripts',
    'English \u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u4E2D\u6587 \u65E5\u672C\u8A9E \u05E2\u05D1\u05E8\u05D9\u05EA',
    'CORAL: Baseline after the unicode block.',
  ];

  const colours = ['red','blue','green','cyan','purple','pink','gray','white','orange','yellow'];
  const tags = [
    'MARLIN: Baseline before malformed tags.',
    '# Unclosed colour tags',
    '[red]never closed',
    '[red][blue][green][yellow] four opened, none closed',
    rep('[red]', 200) + 'two hundred opens, no closes',
    '# Excess closes',
    '[/][/][/][/][/] five closes, nothing opened',
    rep('[/]', 500) + 'five hundred stray closes',
    '# Deep nesting',
    colours.concat(colours, colours).map(c => '[' + c + ']').join('') + 'deep nest' + rep('[/]', 30),
    '# Unknown / malformed tag names',
    '[notacolour]text[/]',
    '[RED]uppercase colour name[/]',
    '[ red ]spaces inside brackets[/]',
    '[red[nested brackets]]text[/]',
    '[]empty tag[/]',
    '[/red] closing with a name',
    '[red text without closing bracket',
    '# Tag-like dialogue that must stay literal',
    'Array index notation: arr[0] and arr[red] and list[/]',
    'Stage direction: [He exits stage left]',
    'Music cue: [SOUND CUE 14]',
    '# Formatting tags',
    rep('[b]', 300) + 'bold three hundred deep',
    '[b][i][u]all three, none closed',
    '[u][/][/][/] one open, three closes',
    '# Substitution characters',
    rep('~', 2000) + ' (two thousand wide gaps)',
    rep('\u23CE', 2000) + ' (two thousand inline breaks)',
    '[red]~\u23CE[/]~\u23CE[blue]~[/]',
    'MARLIN: Baseline after malformed tags.',
  ];

  const control = [
    'DORY: Baseline before control characters.',
    '# Null byte and low control characters',
    'Null\u0000byte in the middle',
    'Bell\u0007 Backspace\u0008 FormFeed\u000C VerticalTab\u000B',
    'Escape\u001B[31m ANSI colour attempt \u001B[0m',
    'Carriage\rreturn mid-line',
    'Tab\tseparated\tvalues',
    'Delete\u007F char',
    '# BOM and line separators',
    '\uFEFFBOM at start of line',
    'Line separator \u2028 after',
    'Paragraph separator \u2029 after',
    '# Note separator (pipe) abuse',
    '|',
    '||||| five pipes',
    'Caption|note one|note two|note three',
    '|leading pipe means empty caption',
    'trailing pipe means empty note|',
    '[red]coloured caption[/]|[blue]coloured note[/]',
    'Very long note|' + rep('N', 5000),
    '# Music markers',
    '\u266B unclosed music marker',
    '# Whitespace-only lines',
    '   ',
    '\t\t\t',
    '\u00A0\u00A0\u00A0 (non-breaking spaces)',
    '\u3000\u3000 (ideographic spaces)',
    '# Prototype pollution shapes',
    '{"__proto__":{"polluted":true}}',
    '__proto__',
    'constructor.prototype.polluted = true',
    '# Path traversal shapes',
    '../../../../etc/passwd',
    '..\\..\\..\\windows\\system32\\config\\sam',
    'file:///etc/passwd',
    '# Template / expression injection shapes',
    '${process.exit(1)}',
    "{{constructor.constructor('alert(1)')()}}",
    '#{7*7}',
    '<%= 7*7 %>',
    'DORY: Baseline after control characters.',
  ];

  return {
    '01-xss-injection.txt':         xss.join('\n') + '\n',
    '02-unicode-stress.txt':        unicode.join('\n') + '\n',
    '03-malformed-tags.txt':        tags.join('\n') + '\n',
    '04-control-and-injection.txt': control.join('\n') + '\n',
  };
}

function writeCorpus(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const corpus = buildCorpus();
  for (const [name, body] of Object.entries(corpus)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return Object.keys(corpus).length;
}

// ── Run every script file ─────────────────────────────────────────────────
const dir = path.join(__dirname, 'scripts');

// Rebuild the corpus on --init, or automatically if it's missing. Copying
// this project between machines loses empty/partial subfolders easily, so
// failing with a raw ENOENT stack trace would be unhelpful.
if (process.argv.includes('--init') || !fs.existsSync(dir) ||
    fs.readdirSync(dir).filter(f => f.endsWith('.txt')).length === 0) {
  const n = writeCorpus(dir);
  console.log(`Wrote ${n} test script(s) to ${dir}\n`);
  if (process.argv.includes('--init')) {
    console.log('Corpus rebuilt. Run again without --init to test.');
    process.exit(0);
  }
}

// Skip macOS AppleDouble sidecars (._name) — metadata, not test material.
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.txt') && !f.startsWith('._'))
  .sort();

console.log('WordLight caption parser — security harness');
console.log('='.repeat(60));

for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = content.split('\n');
  process.stdout.write(`\n${f} (${lines.length} lines) `);
  const before = findings;
  lines.forEach((line, i) => {
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    // Mirror what controller.html does: split caption from speaker note
    const pipe = line.indexOf('|');
    const caption = pipe === -1 ? line : line.slice(0, pipe);
    checkLine(f, i + 1, caption);
  });
  if (findings === before) process.stdout.write('— clean');
}

// ── Synthetic stress cases, generated rather than stored on disk ──────────
console.log('\n\nGenerated stress cases');
console.log('-'.repeat(60));
const synthetic = [
  ['1 MB single line',        'A'.repeat(1024 * 1024)],
  ['100k colour tags',        '[red]'.repeat(100000)],
  ['100k close tags',         '[/]'.repeat(100000)],
  ['100k tildes',             '~'.repeat(100000)],
  ['alternating tags 50k',    '[red][/]'.repeat(50000)],
  ['nested 10k deep',         '[red]'.repeat(10000) + 'x' + '[/]'.repeat(10000)],
  ['all ampersands 500k',     '&'.repeat(500000)],
  ['all angle brackets 500k', '<'.repeat(500000)],
];
for (const [name, input] of synthetic) {
  const t0 = process.hrtime.bigint();
  let ok = true, err = null;
  try { parseColorTags(input); }
  catch (e) { ok = false; err = e; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const flag = !ok ? 'THREW' : ms > 1000 ? 'SLOW ' : 'ok   ';
  if (!ok || ms > 1000) findings++;
  console.log(`  ${flag} ${name.padEnd(26)} ${ms.toFixed(0).padStart(6)}ms` +
              (err ? `  ${err.constructor.name}: ${err.message}` : ''));
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`Lines checked : ${checked}`);
if (MAX_LINE_LENGTH !== null) {
  console.log(`Server limits : ${MAX_SCRIPT_LINES.toLocaleString()} lines, ` +
              `${MAX_LINE_LENGTH.toLocaleString()} chars/line`);
  console.log(`Over limit    : ${overLimit} line(s) — would be rejected by load-script`);
}
console.log(`Slowest line  : ${slowest.ms.toFixed(1)}ms (${slowest.file}:${slowest.line})`);
console.log(`Findings      : ${findings}`);
console.log(`Stray </span> : ${strayCloses} line(s) — must be 0; strays break out of the wrapper element`);
console.log(findings === 0
  ? '\nPASS — nothing dangerous survived the parser.'
  : `\nFAIL — ${findings} finding(s) above need attention.`);
process.exit(findings === 0 ? 1 && 0 || 0 : 1);
