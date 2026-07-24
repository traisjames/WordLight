// ── Per-theater settings ─────────────────────────────────────────────────────
// These two are the only things most installations need to change.
// setup.sh sets THEATER_NAME for you during installation.

// --- Name of your theater! Shown on the reader welcome screen.
const THEATER_NAME = 'Your Theater Name';

// --- Who should people contact for help with this system? Shown as an
// "Email the developer!" link on the public home page. Leave it as an
// empty string ('') to hide that link entirely.
//
// The home page is reachable by anyone who scans your QR code, so only
// put an address here you're happy for audience members to see — a
// role-based address (production@, boxoffice@) is usually a better
// choice than a personal one.
//
// This defaults to the project maintainer, so questions about WordLight
// itself reach someone who can answer them. If you'd rather your own
// audience contacted YOU instead, change it here or re-run setup.sh.
const SUPPORT_EMAIL = 'production@dmplayhouse.com';

// ── Color Tag Parser ─────────────────────────────────────────────────────────
const COLOR_MAP = {
  red:    '#ef4444',
  orange: '#f97316',
  yellow: '#fbbf24',
  green:  '#4ade80',
  cyan:   '#22d3ee',
  blue:   '#60a5fa',
  purple: '#a78bfa',
  pink:   '#f472b6',
  gray:   '#9ca3af',
  grey:   '#9ca3af',
  white:  '#ffffff',
};
    

// ── Color tag parser (matches reader/server) ──────────────────────────────────
function parseColorTags(raw) {
  if (!raw) return '';
  // Escape HTML first so no arbitrary markup can sneak through
  let out = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Wide gap spacer — ~ becomes two em spaces (≈ 2 tab widths)
  out = out.split('~').join('&emsp;&emsp;');
  // Inline line break — ⏎ forces a new display line within a single script line
  out = out.split('⏎').join('<br>');
  // Bold and italic
  out = out.split('[b]').join('<span style="font-weight:700">');
  out = out.split('[i]').join('<span style="font-style:italic">');
  out = out.split('[u]').join('<span style="text-decoration:underline">');
  // Replace each [colorname] using split/join — no regex escaping needed
  for (const [name, hex] of Object.entries(COLOR_MAP)) {
    out = out.split('[' + name + ']').join('<span style="color:' + hex + '">');
  }
  // Close tags
  out = out.split('[/]').join('</span>');
  // Auto-close any unclosed spans
  const opens  = (out.match(/<span/g)   || []).length;
  const closes = (out.match(/<\/span>/g) || []).length;
  for (let i = 0; i < opens - closes; i++) out += '</span>';
  return out;
}

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function stripColorTags(raw) {
  let out = raw || '';
  for (const name of Object.keys(COLOR_MAP)) out = out.split('[' + name + ']').join('');
  return out.split('[/]').join('');
}

// Return only the caption portion of a raw line (everything before the first '|').
function stripNote(raw) {
  if (!raw) return '';
  const pipe = raw.indexOf('|');
  return pipe === -1 ? raw : raw.slice(0, pipe).trim();
}

// Return only the note portion of a raw line (everything after the first '|'), or ''.
function extractNote(raw) {
  if (!raw) return '';
  const pipe = raw.indexOf('|');
  return pipe === -1 ? '' : raw.slice(pipe + 1).trim();
}
  
// ── Reader ID ────────────────────────────────────────────────────────────────
// Centralised here so all reader pages (reader, backstage) can share it.
// Stored in localStorage — identifies this device for usage tracking.
// Contains no personal data.
// prefix — short string prepended to the ID, e.g. 'WB' or 'BS'.
// Each prefix uses its own localStorage key so reader and backstage
// devices each get a stable, distinct ID on the same device.
function getOrCreateReaderId(prefix) {
  const key = 'captionReaderId-' + (prefix || 'XX');
  let id = localStorage.getItem(key);
  if (!id) {
    const uuid = crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    id = (prefix || 'XX') + '-' + uuid;
    localStorage.setItem(key, id);
  }
  return id;
}

// ── Theater name ─────────────────────────────────────────────────────────────
// Fills any element with id="theatername" on pages that have one.
// Null-guarded so global.js can be safely loaded on every page.
const theatername = document.getElementById('theatername');
if (theatername) theatername.innerHTML = THEATER_NAME;
