/**
 * WordLight — scripts-folder.js
 *
 * Lists, opens and saves caption files in the Scripts folder (the "CC
 * Storage" network share that setup.sh makes), so the editor and the
 * controller can use it straight from the browser — no network share to
 * connect to and nothing stored on the laptop.
 *
 * Saving never writes over someone else's work: if the file changed since
 * it was opened (someone saved it over the share, or in another editor),
 * or a different file already has that name, the new one is saved as
 * "Name (2).txt" and the page says so. The same rule the Script Converter
 * uses when it saves into this folder.
 *
 * New files get read/write for the folder's group (0664), like files made
 * over the share (its create mask), so everyone who can write to the share
 * can change them too.
 *
 * Paths from the browser are always relative to the Scripts folder and are
 * checked piece by piece: no "..", no hidden names, nothing that resolves
 * outside the folder (symbolic links included). Only .txt files are listed,
 * opened or written.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILE_MODE   = 0o664;
const MAX_BYTES   = 5 * 1024 * 1024;    // far more than the longest caption file
const MAX_NAME    = 200;
const MAX_TRIES   = 500;

class ScriptsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isHidden(name) {
  return name.startsWith('.') || name.startsWith('~');
}

function isTxt(name) {
  return /\.txt$/i.test(name);
}

/** The pieces of a relative folder or file path, or an error. */
function pieces(rel) {
  if (rel == null || rel === '' || rel === '/') return [];
  if (typeof rel !== 'string' || rel.length > 1000 || /[\0\\]/.test(rel)) {
    throw new ScriptsError('That folder name isn\'t allowed.');
  }
  const parts = rel.split('/').filter(p => p !== '');
  for (const p of parts) {
    if (p === '.' || p === '..' || isHidden(p)) {
      throw new ScriptsError('That folder name isn\'t allowed.');
    }
  }
  return parts;
}

/** Make a file name safe: the name only, not hidden, .txt, not too long. */
function cleanName(name) {
  let base = String(name || '').replace(/\\/g, '/').split('/').pop();
  base = base.replace(/[\0-\x1f\x7f]/g, '').trim().replace(/^[.~]+/, '').trim();
  if (!base) base = 'untitled.txt';
  if (!isTxt(base)) base += '.txt';
  if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME - 4).trim() + '.txt';
  return base;
}

class ScriptsFolder {
  /**
   * root: the Scripts folder (e.g. /home/wordlight/Scripts)
   * label: what the pages call it (e.g. "CC Storage")
   */
  constructor(root, label) {
    this.root  = root ? path.resolve(root) : null;
    this.label = label || (this.root ? path.basename(this.root) : 'Scripts');
  }

  available() {
    try { return !!this.root && fs.statSync(this.root).isDirectory(); }
    catch (e) { return false; }
  }

  /** Absolute path for relative pieces, checked to be inside the folder. */
  _resolve(parts) {
    if (!this.available()) throw new ScriptsError(`The ${this.label} folder isn't there.`, 404);
    const realRoot = fs.realpathSync(this.root);
    const abs = path.join(realRoot, ...parts);
    let real;
    try { real = fs.realpathSync(abs); }
    catch (e) { throw new ScriptsError('That isn\'t there any more.', 404); }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new ScriptsError('That isn\'t inside the folder.', 403);
    }
    return real;
  }

  /** {folder, parts, folders: [name], files: [{name, size, mtime}]} */
  list(rel) {
    const parts = pieces(rel);
    const dir   = this._resolve(parts);
    if (!fs.statSync(dir).isDirectory()) throw new ScriptsError('That isn\'t a folder.', 404);
    const realRoot = fs.realpathSync(this.root);
    const folders = [];
    const files   = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isHidden(ent.name)) continue;
      const full = path.join(dir, ent.name);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }   // broken link
      let real;
      try { real = fs.realpathSync(full); } catch (e) { continue; }
      if (!real.startsWith(realRoot + path.sep)) continue;       // a link out of the folder
      if (st.isDirectory()) folders.push(ent.name);
      else if (st.isFile() && isTxt(ent.name)) {
        files.push({ name: ent.name, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
    const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    folders.sort(byName);
    files.sort((a, b) => byName(a.name, b.name));
    return { name: this.label, folder: parts.join('/'), parts, folders, files };
  }

  /** {name, folder, text, sha, mtime} for a .txt file. */
  read(rel) {
    const parts = pieces(rel);
    if (parts.length === 0 || !isTxt(parts[parts.length - 1])) {
      throw new ScriptsError('Only .txt caption files can be opened.');
    }
    const file = this._resolve(parts);
    const st = fs.statSync(file);
    if (!st.isFile()) throw new ScriptsError('That isn\'t a file.', 404);
    if (st.size > MAX_BYTES) throw new ScriptsError('That file is too big to be a caption file.', 413);
    const buf = fs.readFileSync(file);
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // like a browser reading a file
    return {
      name: parts[parts.length - 1], folder: parts.slice(0, -1).join('/'),
      text, sha: sha256(buf), mtime: Math.round(st.mtimeMs),
    };
  }

  /**
   * Save text as folder/name. base: the sha the file had when it was opened
   * (null for a file that didn't come from this folder).
   * Returns {name, folder, wanted, sha, same, replaced, renamed}.
   */
  save(folderRel, name, text, base) {
    const parts = pieces(folderRel);
    const dir = this._resolve(parts);
    if (!fs.statSync(dir).isDirectory()) throw new ScriptsError('That folder isn\'t there any more.', 404);
    const data = Buffer.from(String(text), 'utf8');
    if (data.length > MAX_BYTES) throw new ScriptsError('That is too big to be a caption file.', 413);
    const wanted = cleanName(name);
    const sha = sha256(data);
    // "Show CC (2).txt" taken goes on to "Show CC (3).txt", not "Show CC (2) (2).txt"
    const m = wanted.slice(0, -4).match(/^(.*) \((\d+)\)$/);
    const stem  = m ? m[1] : wanted.slice(0, -4);
    const first = m ? parseInt(m[2], 10) : 1;
    const result = (fileName, how) => ({
      name: fileName, folder: parts.join('/'), wanted, sha,
      same: how === 'same', replaced: how === 'replaced', renamed: fileName !== wanted,
    });

    for (let n = 1; n < MAX_TRIES; n++) {
      const fileName = n === 1 ? wanted : `${stem} (${first + n - 1}).txt`;
      const target = path.join(dir, fileName);
      let there = null;
      try {
        const st = fs.lstatSync(target);
        there = st.isFile() ? sha256(fs.readFileSync(target)) : 'not-a-file';
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (there === null) {
        if (this._create(target, data)) return result(fileName, 'new');
        continue;                                   // taken a moment ago: next name
      }
      if (there === sha) return result(fileName, 'same');
      if (n === 1 && base && there === base) {      // still the version that was opened
        this._replace(target, data);
        return result(fileName, 'replaced');
      }
    }
    throw new ScriptsError('There are too many files with this name there.');
  }

  _temp(dir, data) {
    const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(tmp, data, { mode: FILE_MODE, flag: 'wx' });
    fs.chmodSync(tmp, FILE_MODE);                 // the mode above loses the group's write (umask)
    return tmp;
  }

  /** Make target, never over an existing file. false if it was taken. */
  _create(target, data) {
    const tmp = this._temp(path.dirname(target), data);
    try {
      try {
        fs.linkSync(tmp, target);                 // all at once, and fails if taken
        return true;
      } catch (e) {
        if (e.code === 'EEXIST') return false;
      }
      // a drive without hard links: write the file itself, still never over one
      try {
        fs.writeFileSync(target, data, { mode: FILE_MODE, flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
      }
      fs.chmodSync(target, FILE_MODE);
      return true;
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
    }
  }

  _replace(target, data) {
    const tmp = this._temp(path.dirname(target), data);
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
      throw e;
    }
  }
}

module.exports = { ScriptsFolder, ScriptsError, cleanName, pieces, MAX_BYTES };
