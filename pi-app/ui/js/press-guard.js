// Minimum-press filter for a flaky capacitive panel.
//
// The touchscreen occasionally emits ultra-brief "blip" contacts (EMI /
// grounding noise) that fire a click on whatever is under them, causing
// buttons to trigger from a graze or a phantom touch. Requiring the
// finger to stay down for a minimum duration before a tap counts filters
// those out — a deliberate press always clears the bar, a stray blip
// doesn't.
//
// Scope: only affects `click` (i.e. button/link taps). Games and jog
// controls use pointerdown/up directly and are intentionally untouched so
// they stay responsive. Mouse input is exempt so desktop dev still works.

const MIN_PRESS_MS = 110;       // how long a tap must be held to count
const SWALLOW_WINDOW_MS = 350;  // how long to wait for the rejected click

const downAt = new Map();       // pointerId -> pointerdown timestamp
let swallowUntil = 0;           // suppress the next click until this time

window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  downAt.set(e.pointerId, e.timeStamp);
}, true);

window.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') return;
  const t = downAt.get(e.pointerId);
  downAt.delete(e.pointerId);
  if (t != null && (e.timeStamp - t) < MIN_PRESS_MS) {
    // Too brief to be a real press — arm the click swallow.
    swallowUntil = e.timeStamp + SWALLOW_WINDOW_MS;
  }
}, true);

window.addEventListener('click', (e) => {
  if (swallowUntil && e.timeStamp <= swallowUntil) {
    swallowUntil = 0;
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

window.addEventListener('pointercancel', (e) => { downAt.delete(e.pointerId); }, true);
