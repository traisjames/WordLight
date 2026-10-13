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

// --- Quick-send caption presets for the Controller's live-type box.
// These are shared by every operator on every device, and travel with the
// project in git — so an emergency message is worded identically no matter
// who is running the booth. Individual operators can add their own extras
// on their own device from the Controller; those are stored locally and
// never overwrite these.
//
// Clicking a preset ARMS it; a second click sends it. Nothing reaches the
// audience on a single click, so a misclick is harmless.
//
// `emergency: true` only changes the styling (red) and sort order — the
// arm-then-send behaviour is identical for every preset, so there's no
// special case to remember under pressure.
//
// Keep emergency wording short, literal and actionable. It may be the only
// notification a deaf or hard-of-hearing patron receives.
const CAPTION_PRESETS = [
  {
    label: 'Fire alarm',
    text: 'FIRE ALARM. Please leave by the nearest exit.',
    emergency: true,
  },
  {
    label: 'Evacuate',
    text: 'Please leave the building now by the nearest exit. Follow staff directions.',
    emergency: true,
  },
  {
    label: 'Stay seated',
    text: 'Please stay in your seat and wait for instructions from staff.',
    emergency: true,
  },
  {
    label: 'Technical hold',
    text: 'Please hold while we resolve a technical issue.',
  },
  {
    label: 'Starting soon',
    text: 'The performance will begin shortly.',
  },
  {
    label: 'Resuming',
    text: 'The performance will resume shortly.',
  },
];

// --- Saved regular expressions for the editor's Find & Replace.
// Shared by every operator and versioned in git, so a pattern that took a
// while to get right doesn't live in one person's notes.
//
// `find` is a regular expression; `replace` is the replacement text.
// Backreferences may be written EITHER \1 or $1 — the editor accepts the
// sed/Perl style and converts it, because that's what most people type.
//
// Each pattern is applied to ONE LINE AT A TIME, which is why ^ and $ mean
// start and end of a line here. Patterns that need to span multiple lines
// won't work.
const REGEX_PRESETS = [
  {
    label:   'Fix speaker punctuation',
    find:    '(^.+?):+\\s+',
    replace: '$1: ',
    note:    'Collapses a doubled colon or extra spaces after a speaker name into ": "',
  },
  {
    label:   'Collapse repeated spaces',
    find:    '\\s{2,}',
    replace: ' ',
    note:    'Turns any run of two or more spaces into a single space',
  },
  {
    label:   'Trim trailing space',
    find:    '\\s+$',
    replace: '',
    note:    'Removes whitespace at the end of a line',
  },
  {
    label:   'Trim leading space',
    find:    '^\\s+',
    replace: '',
    note:    'Removes whitespace at the start of a line',
  },
  {
    label:   'Strip leading line numbers',
    find:    '^\\s*\\d+[.)\\]]?\\s+',
    replace: '',
    note:    'Removes "12. " or "12) " left over from a numbered script',
  },
  {
    label:   'Normalise ellipsis',
    find:    '\\.{3,}',
    replace: '\u2026',
    note:    'Three or more dots become a single ellipsis character',
  },
  {
    label:   'Double hyphen to em dash',
    find:    '\\s*--\\s*',
    replace: '\u2014',
    note:    'Converts -- into an em dash',
  },
  {
    label:   'Speaker name to UPPERCASE',
    find:    '(^[A-Za-z][A-Za-z .\'-]*?)(:)',
    replace: '$1$2',
    note:    'Matches a speaker name before the colon — pair with Replace All after editing the replacement if you want a specific name',
  },
];

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

// Every tag name WordLight understands, so tags work in any capitalization:
// [RED], [Red] and [red] all mean the same thing. Scripts get typed by hand
// under time pressure, and a capitalized tag silently rendering as literal
// text is the kind of thing nobody notices until it's on screen.
const TAG_NAMES = new Set(['b', 'i', 'u', ...Object.keys(COLOR_MAP)]);

// Lower-cases KNOWN tags only. Bracketed text that isn't a tag —
// [He exits stage left], [SOUND CUE 14], [Insert name here] — is left
// exactly as typed, so stage directions and cues still read correctly.
function normalizeTagCase(s) {
  return s.replace(/\[([A-Za-z]+)\]/g, (m, name) =>
    TAG_NAMES.has(name.toLowerCase()) ? '[' + name.toLowerCase() + ']' : m);
}
    

// ── Color tag parser (matches reader/server) ──────────────────────────────────
function parseColorTags(raw) {
  if (!raw) return '';
  // Escape HTML first so no arbitrary markup can sneak through
  let out = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Accept [RED] / [Red] as well as [red] — see normalizeTagCase above.
  out = normalizeTagCase(out);
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
  // Balance the spans — see balanceSpans() for why this can't just count.
  return balanceSpans(out);
}

/**
 * Makes span tags strictly balanced: drops </span> that would close more
 * than is open, and appends any that are missing at the end.
 *
 * Counting opens and closes and appending the difference is NOT enough.
 * A line like "[/][/][/] text" has zero opens and three closes, so the
 * difference is negative and nothing gets appended — but the output still
 * carries three stray </span>. That matters because callers insert this
 * output INSIDE a wrapper element:
 *
 *     '<span class="line-text">' + parseColorTags(line) + '</span>'
 *
 * A stray </span> closes that wrapper early, and the rest of the caption
 * escapes into the parent — losing its styling and, because the parent is
 * a flex row, jumping to the far side of the line. Stray closes are only
 * harmless at the top level of a container, which is not how this is used.
 *
 * Walking the string with a depth counter handles both directions in one
 * pass. Escaped text can't interfere: a literal "<" from the caption is
 * already "&lt;" by this point, so it can never match "<span".
 */
function balanceSpans(html) {
  let result = '';
  let depth  = 0;
  let i      = 0;

  while (i < html.length) {
    if (html.startsWith('<span', i)) {
      const end = html.indexOf('>', i);
      if (end === -1) { result += html.slice(i); break; }
      result += html.slice(i, end + 1);
      depth++;
      i = end + 1;
    } else if (html.startsWith('</span>', i)) {
      if (depth > 0) { result += '</span>'; depth--; }
      // else: silently drop — there is nothing open to close
      i += 7;
    } else {
      result += html[i];
      i++;
    }
  }

  while (depth > 0) { result += '</span>'; depth--; }
  return result;
}

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function stripColorTags(raw) {
  let out = normalizeTagCase(raw || '');
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
