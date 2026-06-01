// Touch-friendly USB file browser + import for kiosk asset pages.
//
// Usage:
//   import { openUsbBrowser } from '/js/usb-browser.js';
//   openUsbBrowser({ target: 'idle', title: 'Import idle animation' });

const TARGET_LABELS = {
  idle:    'idle animation',
  alerts:  'donation alert image',
  sticker: 'donation sticker',
};

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function kindLabel(entry) {
  if (entry.kind === 'pack') return 'animation pack';
  if (entry.kind === 'dir') return 'folder';
  return fmtSize(entry.size) || 'file';
}

export function openUsbBrowser({ target, title, onImported }) {
  const label = TARGET_LABELS[target] || 'file';
  const modalTitle = title || `Import ${label} from USB`;

  const backdrop = document.createElement('div');
  backdrop.className = 'usb-backdrop';
  backdrop.innerHTML = `
    <div class="usb-panel" role="dialog" aria-modal="true">
      <header class="usb-header">
        <h2 class="usb-title"></h2>
        <button type="button" class="usb-close ghost" aria-label="Close">✕</button>
      </header>
      <div class="usb-volumes-wrap" hidden>
        <p class="usb-hint meta">Select a USB drive</p>
        <div class="usb-volumes"></div>
      </div>
      <div class="usb-browse-wrap" hidden>
        <div class="usb-toolbar">
          <button type="button" class="usb-up ghost" disabled>↑ Up</button>
          <span class="usb-path meta"></span>
        </div>
        <div class="usb-list"></div>
        <p class="usb-status meta"></p>
      </div>
      <footer class="usb-footer">
        <button type="button" class="usb-import primary" disabled>Import</button>
        <button type="button" class="usb-cancel ghost">Cancel</button>
      </footer>
    </div>
  `;

  const titleEl = backdrop.querySelector('.usb-title');
  const volWrap = backdrop.querySelector('.usb-volumes-wrap');
  const volList = backdrop.querySelector('.usb-volumes');
  const browseWrap = backdrop.querySelector('.usb-browse-wrap');
  const upBtn = backdrop.querySelector('.usb-up');
  const pathEl = backdrop.querySelector('.usb-path');
  const listEl = backdrop.querySelector('.usb-list');
  const statusEl = backdrop.querySelector('.usb-status');
  const importBtn = backdrop.querySelector('.usb-import');
  const closeBtn = backdrop.querySelector('.usb-close');
  const cancelBtn = backdrop.querySelector('.usb-cancel');

  titleEl.textContent = modalTitle;

  let volumeId = null;
  let volumeLabel = '';
  let cwd = '';
  let selected = null;

  function close() {
    backdrop.remove();
  }

  function setStatus(msg, isErr = false) {
    statusEl.textContent = msg || '';
    statusEl.style.color = isErr ? 'var(--danger)' : 'var(--text-2)';
  }

  function updateImportBtn() {
    importBtn.disabled = !selected || selected.kind === 'dir';
    if (!selected) {
      importBtn.textContent = 'Import';
    } else if (selected.kind === 'dir') {
      importBtn.textContent = 'Open folder first';
    } else {
      importBtn.textContent = `Import "${selected.name}"`;
    }
  }

  async function loadVolumes() {
    volWrap.hidden = false;
    browseWrap.hidden = true;
    volList.innerHTML = '<div class="meta">Looking for USB drives…</div>';
    setStatus('');

    let j;
    try {
      j = await (await fetch('/api/usb/volumes')).json();
    } catch (e) {
      volList.innerHTML = '';
      setStatus(`Could not reach server: ${e.message}`, true);
      return;
    }

    if (!j.ok) {
      volList.innerHTML = '';
      setStatus(j.err || 'error', true);
      return;
    }

    if (j.volumes.length === 0) {
      volList.innerHTML = `
        <div class="usb-empty">
          <p>No USB drive detected.</p>
          <p class="meta">Plug in a USB stick and wait a few seconds, then tap <strong>Refresh</strong>.</p>
        </div>`;
      const refresh = document.createElement('button');
      refresh.className = 'primary';
      refresh.textContent = 'Refresh';
      refresh.addEventListener('click', loadVolumes);
      volList.appendChild(refresh);
      return;
    }

    volList.innerHTML = '';
    if (j.volumes.length === 1) {
      pickVolume(j.volumes[0]);
      return;
    }

    for (const v of j.volumes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'usb-volume-btn';
      btn.innerHTML = `
        <span class="usb-volume-label">${v.label}</span>
        <span class="meta">${v.fstype || 'drive'}</span>`;
      btn.addEventListener('click', () => pickVolume(v));
      volList.appendChild(btn);
    }
  }

  function pickVolume(v) {
    volumeId = v.id;
    volumeLabel = v.label;
    cwd = '';
    selected = null;
    volWrap.hidden = true;
    browseWrap.hidden = false;
    updateImportBtn();
    browse();
  }

  async function browse() {
    listEl.innerHTML = '<div class="meta">Loading…</div>';
    setStatus('');

    const q = new URLSearchParams({ volume: volumeId, path: cwd });
    let j;
    try {
      j = await (await fetch(`/api/usb/browse?${q}`)).json();
    } catch (e) {
      listEl.innerHTML = '';
      setStatus(e.message, true);
      return;
    }

    if (!j.ok) {
      listEl.innerHTML = '';
      setStatus(j.err || 'browse failed', true);
      return;
    }

    cwd = j.path || '';
    pathEl.textContent = cwd
      ? `${volumeLabel} / ${cwd}`
      : volumeLabel;
    upBtn.disabled = !cwd;

    listEl.innerHTML = '';
    if (j.entries.length === 0) {
      listEl.innerHTML = '<div class="meta usb-list-empty">This folder is empty (no supported images or videos).</div>';
      return;
    }

    for (const ent of j.entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'usb-entry';
      row.dataset.kind = ent.kind;
      if (selected && selected.path === ent.path) row.classList.add('selected');

      const icon = ent.kind === 'dir' ? '📁' : ent.kind === 'pack' ? '🎬' : '🖼';
      row.innerHTML = `
        <span class="usb-entry-icon">${icon}</span>
        <span class="usb-entry-text">
          <span class="usb-entry-name">${ent.name}</span>
          <span class="meta usb-entry-meta">${kindLabel(ent)}</span>
        </span>`;

      row.addEventListener('click', () => {
        if (ent.kind === 'dir') {
          cwd = ent.path;
          selected = null;
          browse();
          return;
        }
        selected = ent;
        listEl.querySelectorAll('.usb-entry').forEach((el) => el.classList.remove('selected'));
        row.classList.add('selected');
        updateImportBtn();
      });

      listEl.appendChild(row);
    }
    updateImportBtn();
  }

  upBtn.addEventListener('click', () => {
    if (!cwd) return;
    const parts = cwd.split('/').filter(Boolean);
    parts.pop();
    cwd = parts.join('/');
    selected = null;
    browse();
  });

  async function doImport() {
    if (!selected || selected.kind === 'dir') return;
    importBtn.disabled = true;
    setStatus(`Copying ${selected.name}…`);

    try {
      const r = await fetch('/api/usb/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          volume: volumeId,
          path: selected.path,
          target,
          activate: true,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setStatus(j.err || 'import failed', true);
        importBtn.disabled = false;
        updateImportBtn();
        return;
      }
      setStatus(`Imported ${j.imported.name}`);
      if (typeof onImported === 'function') onImported(j);
      setTimeout(close, 600);
    } catch (e) {
      setStatus(e.message, true);
      importBtn.disabled = false;
      updateImportBtn();
    }
  }

  importBtn.addEventListener('click', doImport);
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  document.body.appendChild(backdrop);
  loadVolumes();
}
