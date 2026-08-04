// On-screen QWERTY keyboard for touchscreen kiosks.
//
// Sibling to numpad.js, same theory: the kiosk has no physical
// keyboard and Wayland/cage doesn't ship an OSK, so tapping a
// text input would otherwise do nothing useful. This module
// intercepts focus + click on text-ish inputs and pops up a big
// modal QWERTY pad. Tap letters / shift / number row / etc, then
// "Done" to commit the value back to the input.
//
// Only attaches on the physical kiosk (localhost). Remote PC / phone
// browsers keep native inputs so Ctrl+V / paste works for JWTs, URLs, etc.
//
// Usage:
//   import { attachKeyboard } from '/js/keyboard.js';
//   attachKeyboard();         // grab every text input on the page
//   attachKeyboard(root);     // limit to a subtree
//
// What inputs are auto-grabbed:
//   <input type="text">
//   <input type="email">
//   <input type="url">
//   <input type="password">
//   <input type="search">
//   <input>                  (no type = defaults to "text")
//   <textarea>
//   any element with data-keyboard
//
// Opt-out a specific input with data-no-keyboard.
//
// Element knobs:
//   data-keyboard-title="Chamber 1 label"   prompt above the pad
//   data-keyboard-mode="email"              switch the layout/keys
//                                           (text | email | url | password)

import { isKiosk } from './kiosk-sync.js';

let openPad = null;

const LAYOUT_LOWER = [
  ['1','2','3','4','5','6','7','8','9','0'],
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l',"'"],
  ['shift','z','x','c','v','b','n','m',',','.','back'],
];
const LAYOUT_UPPER = [
  ['1','2','3','4','5','6','7','8','9','0'],
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L','"'],
  ['shift','Z','X','C','V','B','N','M','!','?','back'],
];
const LAYOUT_SYM = [
  ['1','2','3','4','5','6','7','8','9','0'],
  ['!','@','#','$','%','^','&','*','(',')'],
  ['-','_','=','+','/','\\','[',']','{','}'],
  ['shift','<','>',';',':','"','\'','`','~','|','back'],
];

function destroyPad() {
  if (!openPad) return;
  openPad.cleanup && openPad.cleanup();
  openPad.root.remove();
  openPad = null;
}

function buildKey(key, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'kbd-key';
  if (key === 'shift' || key === 'back' || key === 'space' ||
      key === 'sym'   || key === 'cancel' || key === 'done') {
    b.classList.add('kbd-key-act');
  }
  if (key === 'done')  b.classList.add('kbd-key-ok');
  if (key === 'space') b.classList.add('kbd-key-space');
  b.dataset.key = key;
  b.textContent = label != null ? label : key;
  return b;
}

function renderLayout(grid, layout, opts) {
  grid.innerHTML = '';
  for (const row of layout) {
    const r = document.createElement('div');
    r.className = 'kbd-row';
    for (const key of row) {
      let label = key;
      if (key === 'shift') label = '⇧';
      if (key === 'back')  label = '⌫';
      r.appendChild(buildKey(key, label));
    }
    grid.appendChild(r);
  }
  // Bottom utility row.
  const bottom = document.createElement('div');
  bottom.className = 'kbd-row kbd-row-bottom';
  bottom.appendChild(buildKey('sym',    opts.symMode ? 'ABC' : '?123'));
  if (opts.mode === 'email') {
    bottom.appendChild(buildKey('@',     '@'));
  }
  bottom.appendChild(buildKey('space',  ' '));
  if (opts.mode === 'url' || opts.mode === 'email') {
    bottom.appendChild(buildKey('.',     '.'));
  }
  bottom.appendChild(buildKey('cancel', 'Cancel'));
  bottom.appendChild(buildKey('done',   'Done'));
  grid.appendChild(bottom);
}

function open(input) {
  if (openPad) destroyPad();

  const root = document.createElement('div');
  root.className = 'kbd-backdrop';
  root.innerHTML = `
    <div class="kbd-pad" role="dialog" aria-modal="true">
      <div class="kbd-header">
        <div class="kbd-title" data-title>Enter text</div>
        <div class="kbd-display">
          <span data-display></span><span class="kbd-caret"></span>
        </div>
        <div class="kbd-hint" data-hint></div>
      </div>
      <div class="kbd-grid" data-grid></div>
    </div>
  `;
  document.body.appendChild(root);

  const title   = root.querySelector('[data-title]');
  const display = root.querySelector('[data-display]');
  const hint    = root.querySelector('[data-hint]');
  const grid    = root.querySelector('[data-grid]');

  title.textContent =
    input.dataset.keyboardTitle ||
    input.getAttribute('aria-label') ||
    input.getAttribute('placeholder') ||
    'Enter text';

  const mode = (input.dataset.keyboardMode ||
                (input.type === 'email'    ? 'email' :
                 input.type === 'url'      ? 'url'   :
                 input.type === 'password' ? 'password' : 'text'));
  const isPassword = (input.type === 'password');
  const maxLen = parseInt(input.getAttribute('maxlength'), 10);
  if (Number.isFinite(maxLen)) hint.textContent = `up to ${maxLen} characters`;

  // ----- state -----
  let buffer    = input.value || '';
  let shift     = false;     // momentary uppercase
  let shiftLock = false;     // double-tap shift to lock caps
  let symMode   = false;     // ?123 view

  function activeLayout() {
    if (symMode) return LAYOUT_SYM;
    if (shift || shiftLock) return LAYOUT_UPPER;
    return LAYOUT_LOWER;
  }
  function render() {
    renderLayout(grid, activeLayout(), { mode, symMode });
    if (shiftLock) {
      const k = grid.querySelector('[data-key="shift"]');
      if (k) k.classList.add('kbd-locked');
    } else if (shift) {
      const k = grid.querySelector('[data-key="shift"]');
      if (k) k.classList.add('kbd-active');
    }
    display.textContent = isPassword
      ? '•'.repeat(buffer.length)
      : buffer || '';
  }

  function commit() {
    input.value = buffer;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function press(key) {
    if (key === 'cancel') return destroyPad();
    if (key === 'done')   { commit(); return destroyPad(); }
    if (key === 'back')   { buffer = buffer.slice(0, -1); return render(); }
    if (key === 'space')  { return type(' '); }
    if (key === 'sym')    { symMode = !symMode; return render(); }
    if (key === 'shift')  {
      if (shiftLock)      { shiftLock = false; shift = false; }
      else if (shift)     { shiftLock = true; }
      else                { shift = true; }
      return render();
    }
    // Anything else is a literal character.
    type(key);
  }
  function type(ch) {
    if (Number.isFinite(maxLen) && buffer.length >= maxLen) return;
    buffer += ch;
    if (shift && !shiftLock) { shift = false; render(); return; }
    // Just update the display; layout doesn't change.
    display.textContent = isPassword ? '•'.repeat(buffer.length) : buffer;
  }

  root.addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]');
    if (!k) {
      if (e.target === root) destroyPad();  // tap backdrop dismisses
      return;
    }
    if (k.disabled) return;
    press(k.dataset.key);
  });

  // Physical keyboard / paste fallback (USB keyboard on the kiosk, or
  // rare cases where the pad is open and a host still delivers keys).
  function onKey(e) {
    if (e.key === 'Escape')     return destroyPad();
    if (e.key === 'Enter')      return press('done');
    if (e.key === 'Backspace')  return press('back');
    if (e.key === ' ')          return press('space');
    // Let the browser fire a paste event for Ctrl/Cmd+V.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      type(e.key);
    }
  }
  function onPaste(e) {
    const text = (e.clipboardData || window.clipboardData)
      ? (e.clipboardData || window.clipboardData).getData('text')
      : '';
    if (!text) return;
    e.preventDefault();
    for (const ch of text) {
      if (Number.isFinite(maxLen) && buffer.length >= maxLen) break;
      buffer += ch;
    }
    if (shift && !shiftLock) shift = false;
    render();
  }
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste);

  openPad = {
    root,
    cleanup: () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    },
  };
  render();
}

function isTextLike(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.dataset.noKeyboard !== undefined) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT')    return false;
  if ('keyboard' in el.dataset)  return true;
  const t = (el.getAttribute('type') || 'text').toLowerCase();
  return ['text', 'email', 'url', 'password', 'search', ''].includes(t);
}

function attach(input) {
  if (input.dataset.keyboardAttached === '1') return;
  input.dataset.keyboardAttached = '1';
  // We own the focus experience. Mark readonly so the (hypothetical)
  // OS on-screen keyboard never opens, hide the native caret because
  // we render our own, and intercept clicks.
  input.setAttribute('readonly', '');
  input.style.caretColor = 'transparent';
  input.addEventListener('focus', (e) => e.target.blur());
  input.addEventListener('click',      () => open(input));
  input.addEventListener('touchstart', (e) => { e.preventDefault(); open(input); }, { passive: false });
}

export function attachKeyboard(root = document) {
  // PC / phone on the LAN: leave native focus + paste alone.
  if (!isKiosk()) return;

  const candidates = root.querySelectorAll(
    'input[type=text], input[type=email], input[type=url], ' +
    'input[type=password], input[type=search], input:not([type]), ' +
    'textarea, [data-keyboard]'
  );
  candidates.forEach((el) => { if (isTextLike(el)) attach(el); });
  if (!root.__keyboardObserver) {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (isTextLike(node)) attach(node);
          if (node.querySelectorAll) {
            node.querySelectorAll(
              'input[type=text], input[type=email], input[type=url], ' +
              'input[type=password], input[type=search], input:not([type]), ' +
              'textarea, [data-keyboard]'
            ).forEach((el) => { if (isTextLike(el)) attach(el); });
          }
        }
      }
    });
    obs.observe(root === document ? document.body : root, { childList: true, subtree: true });
    root.__keyboardObserver = obs;
  }
}
