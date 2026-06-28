// Tap-reliability helper for a flaky capacitive panel.
//
// IMPORTANT: this NEVER blocks or cancels a real click. An earlier
// version required a minimum press duration and swallowed shorter taps —
// that made buttons fire their :active highlight (on touch-down) but then
// drop the navigation, intermittently, because human taps are often
// <110ms. That was wrong and is gone.
//
// What this does instead — fixes the panel's actual failure mode:
//   The controller sometimes reports `pointerup` a few pixels off the
//   element the touch started on, so the browser never fires `click` and
//   the button lights up but nothing happens. On a clean tap (started and
//   ended on the same actionable element, little movement, not an instant
//   noise blip) we make sure the click fires. If the native click already
//   happened, we do nothing — so there's never a double activation.
//
// Mouse input is ignored entirely (desktop dev is unaffected).

const MIN_TAP_MS = 35;   // shorter than this = noise blip, don't synthesize
const MOVE_TOL   = 24;   // px of travel still considered a tap (not a drag)
const ASSIST_MS  = 120;  // wait this long for the native click before assisting

function actionable(el) {
  return (el && el.closest) ? el.closest('a[href], button') : null;
}

let start = null;          // { el, x, y, t, id }
let lastClickEl = null;
let lastClickAt = 0;

window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  start = {
    el: actionable(e.target),
    x: e.clientX, y: e.clientY,
    t: e.timeStamp, id: e.pointerId,
  };
}, true);

// Record every genuine click so the assist below can dedupe against it.
window.addEventListener('click', (e) => {
  lastClickEl = actionable(e.target);
  lastClickAt = e.timeStamp;
}, true);

window.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') return;
  const s = start;
  start = null;
  if (!s || !s.el || s.id !== e.pointerId) return;

  const dur   = e.timeStamp - s.t;
  const moved = Math.hypot(e.clientX - s.x, e.clientY - s.y);
  if (dur < MIN_TAP_MS) return;          // instant blip — likely noise
  if (moved > MOVE_TOL) return;          // a drag/swipe, not a tap
  if (actionable(e.target) !== s.el) return; // ended on a different element

  const target = s.el;
  setTimeout(() => {
    // If the browser already delivered a click to this element, it was
    // handled normally — don't fire a second one.
    if (target === lastClickEl && (performance.now() - lastClickAt) < ASSIST_MS + 60) return;
    // Native click was lost (up drifted off the element) — fire it.
    target.click();
  }, ASSIST_MS);
}, true);

window.addEventListener('pointercancel', () => { start = null; }, true);
