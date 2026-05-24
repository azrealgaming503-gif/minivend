// Donation alert overlay. Subscribes to the shared WebSocket and shows
// a popup card when a donation arrives. Auto-dismisses after a few
// seconds; can be tapped to dismiss early.

import { onMessage } from './ws-client.js';

const DEFAULT_DURATION_MS = 7000;

function fmtAmount(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(n);
  } catch (_) {
    return `$${n.toFixed(2)}`;
  }
}

function ensureOverlay() {
  let el = document.getElementById('alert-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'alert-overlay';
  el.className = 'alert-overlay';
  el.innerHTML = `
    <div class="alert-card">
      <p class="alert-amount" data-amount></p>
      <p class="alert-name"   data-name></p>
      <p class="alert-message" data-message></p>
      <p class="alert-source" data-source></p>
    </div>
  `;
  el.addEventListener('click', hide);
  document.body.appendChild(el);
  return el;
}

let hideTimer = null;

function show({ name, amount, currency, message, source }) {
  const el = ensureOverlay();
  el.querySelector('[data-amount]').textContent  = fmtAmount(amount, currency);
  el.querySelector('[data-name]').textContent    = name || 'Anonymous';
  el.querySelector('[data-message]').textContent = message || '';
  el.querySelector('[data-source]').textContent  = source || '';
  el.classList.add('visible');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, DEFAULT_DURATION_MS);
}

function hide() {
  const el = document.getElementById('alert-overlay');
  if (!el) return;
  el.classList.remove('visible');
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

onMessage('donation', show);
