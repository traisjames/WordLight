/**
 * WordLight — scripts-picker.js
 *
 * The "Scripts folder" dialog shared by the editor and the controller: walk
 * the folders, pick a caption file to open, or pick a folder and a name to
 * save as. It talks to /api/scripts (see scripts-folder.js on the server);
 * the page does the actual opening or saving with what this returns.
 *
 *   ScriptsPicker.status()  -> Promise<{available, name}>
 *   ScriptsPicker.open({ mode: 'open' })
 *       -> Promise<{name, folder, text, sha, mtime} | null>
 *   ScriptsPicker.open({ mode: 'save', name: 'Show CC.txt', folder: '' })
 *       -> Promise<{folder, name} | null>
 *
 * While the dialog is open it takes every key press, so the page's own
 * shortcuts (Space = next line on the controller) can't fire behind it.
 */
(function () {
  'use strict';

  const CSS = `
  .sp-overlay { position: fixed; inset: 0; z-index: 1000; display: flex;
    align-items: center; justify-content: center; padding: 1rem;
    background: rgba(2, 6, 23, 0.72); }
  .sp-dialog { width: min(36rem, 100%); max-height: calc(100vh - 2rem); display: flex;
    flex-direction: column; background: var(--surface, #1e293b); color: var(--text, #e2e8f0);
    border: 1px solid var(--border, #334155); border-radius: 10px;
    box-shadow: 0 20px 50px rgba(0,0,0,0.5); font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px; }
  .sp-head { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border, #334155); }
  .sp-head strong { flex: 1; font-size: 0.95rem; font-weight: 600; }
  .sp-x { background: none; border: none; color: var(--muted, #64748b); font-size: 1rem;
    cursor: pointer; padding: 0.2rem 0.4rem; border-radius: 4px; }
  .sp-x:hover { color: var(--text, #e2e8f0); background: var(--border, #334155); }
  .sp-path { display: flex; align-items: center; flex-wrap: wrap; gap: 0.15rem;
    padding: 0.5rem 1rem; font-size: 0.82rem; color: var(--muted, #64748b);
    border-bottom: 1px solid var(--border, #334155); }
  .sp-crumb { background: none; border: none; color: #93c5fd; cursor: pointer; font: inherit;
    padding: 0.15rem 0.3rem; border-radius: 4px; }
  .sp-crumb:hover { background: var(--border, #334155); }
  .sp-crumb[aria-current] { color: var(--text, #e2e8f0); cursor: default; background: none; }
  .sp-list { list-style: none; margin: 0; padding: 0.35rem 0; overflow-y: auto;
    min-height: 8rem; max-height: 50vh; }
  .sp-item { width: 100%; display: flex; align-items: baseline; gap: 0.6rem; text-align: left;
    background: none; border: none; border-left: 3px solid transparent; color: inherit;
    font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
  .sp-item:hover { background: rgba(99,102,241,0.10); }
  .sp-item:focus-visible { outline: 2px solid var(--accent, #6366f1); outline-offset: -2px; }
  .sp-item[aria-selected="true"] { background: var(--current-bg, #1e3a5f);
    border-left-color: var(--current-border, #3b82f6); }
  .sp-item .sp-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .sp-item .sp-meta { font-size: 0.75rem; color: var(--muted, #64748b); white-space: nowrap; }
  .sp-empty { padding: 1rem; color: var(--muted, #64748b); font-size: 0.85rem; }
  .sp-msg { padding: 0 1rem; font-size: 0.82rem; min-height: 0; }
  .sp-msg:not(:empty) { padding: 0.5rem 1rem; }
  .sp-msg.error { color: #fca5a5; }
  .sp-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
    padding: 0.75rem 1rem; border-top: 1px solid var(--border, #334155); }
  .sp-foot label { font-size: 0.8rem; color: var(--muted, #64748b); }
  .sp-foot input { flex: 1 1 12rem; min-width: 0; background: var(--bg, #0f172a);
    color: var(--text, #e2e8f0); border: 1px solid var(--border, #334155); border-radius: 6px;
    padding: 0.45rem 0.6rem; font: inherit; outline: none; }
  .sp-foot input:focus { border-color: var(--accent, #6366f1); }
  .sp-spacer { flex: 1; }
  .sp-btn { border: none; border-radius: 6px; padding: 0.45rem 0.9rem; font: inherit;
    font-size: 0.85rem; font-weight: 500; cursor: pointer; }
  .sp-btn.primary { background: var(--accent, #6366f1); color: #fff; }
  .sp-btn.primary:hover:not(:disabled) { background: var(--accent-h, #4f46e5); }
  .sp-btn.secondary { background: var(--border, #334155); color: var(--text, #e2e8f0); }
  .sp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  `;

  let styled = false;
  function addStyle() {
    if (styled) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    styled = true;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    let data = null;
    try { data = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error((data && data.error) || `The server answered ${r.status}.`);
    return data;
  }

  function when(ms) {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' }
                                             : { year: 'numeric', month: 'short', day: 'numeric' })
      + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function size(bytes) {
    return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
  }

  function status() {
    return getJSON('/api/scripts/status').catch(() => ({ available: false, name: 'Scripts' }));
  }

  function open(opts) {
    opts = opts || {};
    const saving = opts.mode === 'save';
    addStyle();
    return new Promise((resolve) => {
      const lastFocus = document.activeElement;
      let folder = opts.folder || '';
      let label  = opts.label || 'Scripts';
      let selected = null;          // file name picked in this folder
      let busy = false;

      const overlay = el('div', 'sp-overlay');
      const dialog  = el('div', 'sp-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const head  = el('div', 'sp-head');
      const title = el('strong', null, '');
      title.id = 'sp-title';
      dialog.setAttribute('aria-labelledby', 'sp-title');
      const x = el('button', 'sp-x', '✕');
      x.type = 'button';
      x.title = 'Close (Esc)';
      head.append(title, x);
      const crumbs = el('div', 'sp-path');
      const list   = el('ul', 'sp-list');
      list.setAttribute('role', 'listbox');
      const msg    = el('div', 'sp-msg');
      msg.setAttribute('aria-live', 'polite');
      const foot   = el('div', 'sp-foot');
      let nameInput = null;
      if (saving) {
        const lab = el('label', null, 'Save as');
        nameInput = el('input');
        nameInput.type = 'text';
        nameInput.id = 'sp-name';
        nameInput.value = opts.name || 'untitled.txt';
        nameInput.autocomplete = 'off';
        nameInput.spellcheck = false;
        lab.htmlFor = 'sp-name';
        foot.append(lab, nameInput);
      } else {
        foot.append(el('span', 'sp-spacer'));
      }
      const cancel  = el('button', 'sp-btn secondary', 'Cancel');
      cancel.type = 'button';
      const primary = el('button', 'sp-btn primary', saving ? 'Save here' : 'Open');
      primary.type = 'button';
      foot.append(cancel, primary);
      dialog.append(head, crumbs, list, msg, foot);
      overlay.append(dialog);
      document.body.append(overlay);

      function setTitle() {
        title.textContent = (saving ? '💾 Save to ' : '📁 Open from ') + label;
      }

      function say(text, isError) {
        msg.textContent = text || '';
        msg.className = 'sp-msg' + (isError ? ' error' : '');
      }

      function updatePrimary() {
        primary.disabled = busy || (saving ? !nameInput.value.trim() : !selected);
      }

      function finish(result) {
        window.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
        resolve(result);
      }

      async function choose() {
        if (primary.disabled) return;
        if (saving) {
          finish({ folder, name: nameInput.value.trim() });
          return;
        }
        busy = true; updatePrimary(); say('Opening…');
        try {
          const path = (folder ? folder + '/' : '') + selected;
          finish(await getJSON('/api/scripts/file?path=' + encodeURIComponent(path)));
        } catch (e) {
          busy = false; updatePrimary(); say(e.message, true);
        }
      }

      function drawCrumbs(parts) {
        crumbs.innerHTML = '';
        const all = [label, ...parts];
        all.forEach((p, i) => {
          if (i > 0) crumbs.append(el('span', null, '/'));
          const b = el('button', 'sp-crumb', (i === 0 ? '📁 ' : '') + p);
          b.type = 'button';
          if (i === all.length - 1) b.setAttribute('aria-current', 'location');
          else b.addEventListener('click', () => go(parts.slice(0, i).join('/')));
          crumbs.append(b);
        });
      }

      async function go(target) {
        busy = true; updatePrimary(); say('');
        let data;
        try {
          data = await getJSON('/api/scripts?folder=' + encodeURIComponent(target));
        } catch (e) {
          busy = false; updatePrimary(); say(e.message, true);
          if (target) go('');           // that folder went away: back to the top
          return;
        }
        busy = false;
        folder = data.folder;
        label = data.name || label;
        selected = null;
        setTitle();
        drawCrumbs(data.parts || []);
        list.innerHTML = '';
        for (const f of data.folders) {
          const li = el('li');
          const b = el('button', 'sp-item');
          b.type = 'button';
          b.append(el('span', 'sp-name', '📁 ' + f));
          b.addEventListener('click', () => go((folder ? folder + '/' : '') + f));
          li.append(b);
          list.append(li);
        }
        for (const f of data.files) {
          const li = el('li');
          const b = el('button', 'sp-item');
          b.type = 'button';
          b.setAttribute('role', 'option');
          b.setAttribute('aria-selected', 'false');
          b.dataset.name = f.name;
          b.append(el('span', 'sp-name', '📄 ' + f.name),
                   el('span', 'sp-meta', when(f.mtime) + ' · ' + size(f.size)));
          b.addEventListener('click', () => {
            selected = f.name;
            list.querySelectorAll('.sp-item[aria-selected]').forEach(
              o => o.setAttribute('aria-selected', String(o.dataset.name === f.name)));
            if (saving) nameInput.value = f.name;
            updatePrimary();
          });
          b.addEventListener('dblclick', () => { if (!saving) choose(); });
          li.append(b);
          list.append(li);
        }
        if (!data.folders.length && !data.files.length) {
          list.append(el('li', 'sp-empty', 'No caption files (.txt) here.'));
        }
        updatePrimary();
        const first = list.querySelector('.sp-item');
        if (saving) nameInput.focus();
        else if (first) first.focus();
        else cancel.focus();
      }

      // While open, every key press is ours: the page's shortcuts must not fire.
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
        if (e.key === 'Enter' && saving && document.activeElement === nameInput) {
          e.preventDefault(); e.stopPropagation(); choose(); return;
        }
        const item = document.activeElement;
        if (e.key === 'Enter' && !saving && item && item.dataset && item.dataset.name) {
          e.preventDefault(); e.stopPropagation();      // Enter on a file opens it
          item.click();
          choose();
          return;
        }
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.contains(item)) {
          const items = [...list.querySelectorAll('.sp-item')];
          const i = items.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1);
          if (items[i]) { e.preventDefault(); items[i].focus(); }
        }
        if (e.key === 'Tab') {          // keep Tab inside the dialog
          const items = [...dialog.querySelectorAll('button:not(:disabled), input')];
          const i = items.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
          else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
        }
        e.stopPropagation();
      }
      window.addEventListener('keydown', onKey, true);

      x.addEventListener('click', () => finish(null));
      cancel.addEventListener('click', () => finish(null));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
      primary.addEventListener('click', choose);
      if (nameInput) nameInput.addEventListener('input', updatePrimary);

      setTitle();
      go(folder);
    });
  }

  window.ScriptsPicker = { status, open };
})();
