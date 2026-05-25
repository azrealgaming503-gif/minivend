// On-screen number pad for touchscreen kiosks.
//
// The kiosk has no physical keyboard and Wayland/cage doesn't ship
// an OSK, so tapping a <input type=number> normally does nothing
// useful. This module intercepts focus + click on number inputs and
// pops up a big-button modal pad. Tap digits, decimal/sign as
// allowed by the input's attributes, then OK to commit.
//
// Usage:
//   import { attachNumpad } from '/js/numpad.js';
//   attachNumpad();   // grabs every input[type=number] on the page
//
// Or attach to a specific subtree:
//   attachNumpad(document.getElementById('my-form'));
//
// Options on the input element:
//   min, max, step      — honored when validating
//   data-numpad-decimal — force "decimal allowed" even if step is integer
//   data-numpad-title   — title shown above the pad

let openPad = null;

function buildPad() {
  const root = document.createElement('div');
  root.className = 'numpad-backdrop';
  root.innerHTML = `
    <div class="numpad" role="dialog" aria-modal="true">
      <div class="numpad-header">
        <div class="numpad-title">Enter number</div>
        <div class="numpad-display" data-display>0</div>
        <div class="numpad-hint"   data-hint></div>
      </div>
      <div class="numpad-grid">
        <button class="numpad-key" data-key="1">1</button>
        <button class="numpad-key" data-key="2">2</button>
        <button class="numpad-key" data-key="3">3</button>
        <button class="numpad-key numpad-act" data-key="back">⌫</button>

        <button class="numpad-key" data-key="4">4</button>
        <button class="numpad-key" data-key="5">5</button>
        <button class="numpad-key" data-key="6">6</button>
        <button class="numpad-key numpad-act" data-key="clear">C</button>

        <button class="numpad-key" data-key="7">7</button>
        <button class="numpad-key" data-key="8">8</button>
        <button class="numpad-key" data-key="9">9</button>
        <button class="numpad-key numpad-act" data-key="sign" data-sign>±</button>

        <button class="numpad-key" data-key="dot" data-dot>.</button>
        <button class="numpad-key" data-key="0">0</button>
        <button class="numpad-key numpad-act" data-key="cancel">Cancel</button>
        <button class="numpad-key numpad-ok"  data-key="ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

function destroyPad() {
  if (!openPad) return;
  openPad.root.remove();
  openPad = null;
}

function commitTo(input, raw) {
  // Honor min/max/step from the input.
  const stepStr = input.getAttribute('step');
  let value = parseFloat(raw);
  if (!Number.isFinite(value)) value = 0;
  const min = parseFloat(input.getAttribute('min'));
  const max = parseFloat(input.getAttribute('max'));
  if (Number.isFinite(min) && value < min) value = min;
  if (Number.isFinite(max) && value > max) value = max;
  // Round to step precision if integer step.
  if (stepStr && /^\d+$/.test(stepStr)) value = Math.round(value);
  input.value = String(value);
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function open(input) {
  if (openPad) destroyPad();
  const root = buildPad();
  const display = root.querySelector('[data-display]');
  const hint    = root.querySelector('[data-hint]');
  const title   = root.querySelector('.numpad-title');
  const dotBtn  = root.querySelector('[data-dot]');
  const signBtn = root.querySelector('[data-sign]');

  title.textContent = input.dataset.numpadTitle ||
                      input.getAttribute('aria-label') ||
                      input.getAttribute('placeholder') ||
                      'Enter number';

  const stepStr = input.getAttribute('step');
  const decimalAllowed = ('numpadDecimal' in input.dataset) ||
                          (stepStr && stepStr !== '' && /\./.test(stepStr)) ||
                          (stepStr === '' || stepStr == null);
  const minAttr = input.getAttribute('min');
  const negativeAllowed = (minAttr == null) || (parseFloat(minAttr) < 0);
  if (!decimalAllowed)  dotBtn.disabled = true;
  if (!negativeAllowed) signBtn.disabled = true;

  const minStr = input.getAttribute('min');
  const maxStr = input.getAttribute('max');
  const minHint = minStr != null ? `min ${minStr}` : '';
  const maxHint = maxStr != null ? `max ${maxStr}` : '';
  hint.textContent = [minHint, maxHint].filter(Boolean).join(' · ');

  let buffer = (input.value || '').replace(/[^\d.\-]/g, '');
  if (buffer === '0' || buffer === '') buffer = '';

  function render() {
    display.textContent = buffer === '' ? '0' : buffer;
  }
  function press(key) {
    if (key === 'cancel') return destroyPad();
    if (key === 'ok')     { commitTo(input, buffer || '0'); return destroyPad(); }
    if (key === 'back')   { buffer = buffer.slice(0, -1); return render(); }
    if (key === 'clear')  { buffer = '';                  return render(); }
    if (key === 'sign')   {
      if (!negativeAllowed) return;
      buffer = buffer.startsWith('-') ? buffer.slice(1) : '-' + buffer;
      return render();
    }
    if (key === 'dot') {
      if (!decimalAllowed) return;
      if (buffer.includes('.')) return;
      buffer = (buffer === '' || buffer === '-') ? buffer + '0.' : buffer + '.';
      return render();
    }
    // digit
    if (/^[0-9]$/.test(key)) {
      // prevent leading-zero runs like 0007
      if (buffer === '0' || buffer === '-0') {
        buffer = (buffer.startsWith('-') ? '-' : '') + key;
      } else if (buffer.length < 12) {
        buffer = buffer + key;
      }
      return render();
    }
  }
  root.addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]');
    if (!k) {
      // tap on backdrop dismisses
      if (e.target === root) destroyPad();
      return;
    }
    if (k.disabled) return;
    press(k.dataset.key);
  });
  // Keyboard fallback (useful for laptop testing).
  function onKey(e) {
    if (e.key === 'Escape') return destroyPad();
    if (e.key === 'Enter')  return press('ok');
    if (e.key === 'Backspace') return press('back');
    if (e.key === '.' || e.key === ',') return press('dot');
    if (/^[0-9]$/.test(e.key)) return press(e.key);
  }
  document.addEventListener('keydown', onKey);
  openPad = {
    root,
    cleanup: () => document.removeEventListener('keydown', onKey),
  };
  render();
}

const NATIVE_FOCUS = new WeakSet();

function attach(input) {
  if (input.dataset.numpadAttached === '1') return;
  input.dataset.numpadAttached = '1';
  // Don't allow the on-screen keyboard or native focus glow — we
  // own the input experience for these.
  input.setAttribute('readonly', '');
  input.style.caretColor = 'transparent';
  input.addEventListener('focus', (e) => {
    // The readonly + custom handler is enough; this just keeps the
    // focus halo styling consistent.
    e.target.blur();
  });
  input.addEventListener('click',      () => open(input));
  input.addEventListener('touchstart', (e) => { e.preventDefault(); open(input); }, { passive: false });
}

export function attachNumpad(root = document) {
  const inputs = root.querySelectorAll(
    'input[type=number], input[data-numpad]'
  );
  inputs.forEach(attach);
  // Re-scan when nodes are added (tier rows, etc.).
  if (!root.__numpadObserver) {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches && node.matches('input[type=number], input[data-numpad]')) attach(node);
          node.querySelectorAll &&
            node.querySelectorAll('input[type=number], input[data-numpad]').forEach(attach);
        }
      }
    });
    obs.observe(root === document ? document.body : root, { childList: true, subtree: true });
    root.__numpadObserver = obs;
  }
}

// Convenience auto-attach: import './numpad.js' (no call) does it for you.
// We don't auto-attach by default to keep import side-effect-free; callers
// should call attachNumpad() after their DOM is ready.
