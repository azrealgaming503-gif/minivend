// Paste a StreamElements overlay link (the same OBS browser-source URL
// from the SE overlay editor) so the kiosk can display it fullscreen.
//
// Usage:
//   import { initSeOverlayUrl } from '/js/overlay-se-url.js';
//   initSeOverlayUrl({ formId: 'donation-se-form', kind: 'donation' });

export function initSeOverlayUrl({ formId, kind, title }) {
  const form = document.getElementById(formId);
  if (!form) return;

  const seKey = kind === 'redeem' ? 'redeemSe' : 'donationSe';
  form.innerHTML = `
    <div class="se-url-form">
      <label class="se-url-label" for="${formId}-input">${title || 'StreamElements overlay link'}</label>
      <input id="${formId}-input" type="url" inputmode="url" autocomplete="off"
             placeholder="https://streamelements.com/overlay/…" data-input
             data-keyboard-title="StreamElements overlay link" />
      <div class="row se-url-actions">
        <button type="button" class="primary" data-save>Save link</button>
        <button type="button" class="danger" data-clear hidden>Clear</button>
        <span class="meta se-url-status" data-status></span>
      </div>
    </div>
  `;

  const input = form.querySelector('[data-input]');
  const saveBtn = form.querySelector('[data-save]');
  const clearBtn = form.querySelector('[data-clear]');
  const status = form.querySelector('[data-status]');

  function setStatus(msg) { status.textContent = msg || ''; }

  function applyUrl(url) {
    input.value = url || '';
    clearBtn.hidden = !url;
  }

  async function loadCurrent() {
    try {
      const j = await (await fetch('/api/assets/overlay')).json();
      if (j && j.ok) applyUrl(j[seKey] || null);
    } catch (_) {}
  }

  async function save() {
    const url = (input.value || '').trim();
    if (!url) {
      setStatus('Paste a link first.');
      return;
    }
    setStatus('Saving…');
    try {
      const j = await (await fetch(`/api/assets/overlay-se/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })).json();
      if (j && j.ok) {
        applyUrl(j[seKey] || j.url);
        setStatus('Saved. Overlay stays loaded like OBS.');
        setTimeout(() => setStatus(''), 3000);
      } else {
        setStatus(`Error: ${(j && j.err) || 'save failed'}`);
      }
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    }
  }

  async function clear() {
    setStatus('Clearing…');
    try {
      const j = await (await fetch(`/api/assets/overlay-se/${kind}`, { method: 'DELETE' })).json();
      if (j && j.ok) { applyUrl(null); setStatus(''); }
      else setStatus(`Error: ${(j && j.err) || 'clear failed'}`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    }
  }

  saveBtn.addEventListener('click', save);
  clearBtn.addEventListener('click', clear);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  });

  loadCurrent();
}
