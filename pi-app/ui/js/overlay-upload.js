// Drag-and-drop (or tap-to-browse) uploader for the overlay GIFs.
//
// Each overlay (donation, redeem) has one optional image. This helper
// renders a dropzone inside a container element and wires up:
//   - drag over / drop of an image file
//   - tap/click to open the native file picker
//   - preview of the current image
//   - "Remove" to clear it
//
// Usage:
//   import { initOverlayUploader } from '/js/overlay-upload.js';
//   initOverlayUploader({ zoneId: 'donation-overlay-zone', kind: 'donation' });

const ACCEPT = 'image/gif,image/png,image/webp,image/jpeg';

export function initOverlayUploader({ zoneId, kind, title, hint }) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;

  zone.classList.add('dropzone');
  zone.innerHTML = `
    <div class="dropzone-preview" data-preview>none</div>
    <div class="dropzone-body">
      <div class="dropzone-title">${title || 'Overlay image'}</div>
      <div class="dropzone-hint">${hint || 'Drag a GIF/PNG here, or tap to choose. GIF, PNG, WebP or JPG.'}</div>
      <div class="dropzone-actions">
        <button type="button" class="ghost" data-choose>Choose file</button>
        <button type="button" class="danger" data-remove hidden>Remove</button>
        <span class="dropzone-hint" data-status></span>
      </div>
    </div>
    <input type="file" accept="${ACCEPT}" hidden data-input />
  `;

  const preview = zone.querySelector('[data-preview]');
  const chooseBtn = zone.querySelector('[data-choose]');
  const removeBtn = zone.querySelector('[data-remove]');
  const status  = zone.querySelector('[data-status]');
  const input   = zone.querySelector('[data-input]');

  function setStatus(msg) { status.textContent = msg || ''; }

  function setPreview(url) {
    if (url) {
      preview.innerHTML = `<img src="${url}?t=${Date.now()}" alt="overlay preview" />`;
      removeBtn.hidden = false;
    } else {
      preview.textContent = 'none';
      removeBtn.hidden = true;
    }
  }

  async function loadCurrent() {
    try {
      const j = await (await fetch('/api/assets/overlay')).json();
      if (j && j.ok) setPreview(j[kind]);
    } catch (_) {}
  }

  async function upload(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatus('Not an image file.');
      return;
    }
    setStatus('Uploading…');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const j = await (await fetch(`/api/assets/overlay/${kind}`, {
        method: 'POST', body: fd,
      })).json();
      if (j && j.ok) {
        setPreview(j.url);
        setStatus('Saved.');
        setTimeout(() => setStatus(''), 2000);
      } else {
        setStatus(`Error: ${(j && j.err) || 'upload failed'}`);
      }
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    }
  }

  async function remove() {
    setStatus('Removing…');
    try {
      const j = await (await fetch(`/api/assets/overlay/${kind}`, { method: 'DELETE' })).json();
      if (j && j.ok) { setPreview(null); setStatus(''); }
      else setStatus(`Error: ${(j && j.err) || 'remove failed'}`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    }
  }

  // --- Wiring ---
  const openPicker = () => input.click();
  zone.addEventListener('click', (e) => {
    // Don't reopen the picker when tapping the action buttons.
    if (e.target.closest('button')) return;
    openPicker();
  });
  chooseBtn.addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) upload(input.files[0]);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.add('dragover');
    })
  );
  ['dragleave', 'dragend'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('dragover');
    })
  );
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) upload(file);
  });

  loadCurrent();
}
