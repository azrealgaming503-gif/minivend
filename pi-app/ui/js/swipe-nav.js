// Shared swipe-to-navigate for the kiosk.
//
// A deliberate vertical drag navigates to another page. Phantom flicks
// from the flaky capacitive panel are rejected by three guards:
//   - MIN_TIME: instant "teleport" contacts (no real drag) are ignored.
//   - MIN_MOVES: a real swipe streams touchmove events; a glitch jumps
//     from press to release with none.
//   - minDist: the travel must exceed ~16% of screen height (with a hard
//     floor) so a tap or tiny graze never triggers navigation.
//
// Usage:
//   import { installSwipeNav } from '/js/swipe-nav.js';
//   installSwipeNav({ direction: 'up',   to: '/menu' }); // idle screen
//   installSwipeNav({ direction: 'down', to: '/' });     // menu screen

const MIN_TIME  = 70;    // ms — reject instant controller "jump" flicks
const MAX_TIME  = 1000;  // ms — longer than this isn't a flick
const MAX_DRIFT = 70;    // px sideways before it's not a vertical swipe
const MIN_MOVES = 2;     // streamed touchmove events required (touch only)

export function installSwipeNav({ direction, to }) {
  let startY = null, startX = null, startT = 0, moves = 0;
  const minDist = () => Math.max(110, window.innerHeight * 0.16);

  function onStart(e) {
    const p = e.touches ? e.touches[0] : e;
    startY = p.clientY; startX = p.clientX; startT = Date.now(); moves = 0;
  }
  function onMove() { moves++; }
  function onEnd(e) {
    if (startY === null) return;
    const p = e.changedTouches ? e.changedTouches[0] : e;
    const isTouch = !!e.changedTouches;
    const dy = p.clientY - startY;
    const dx = p.clientX - startX;
    const dt = Date.now() - startT;
    startY = startX = null;
    if (dt < MIN_TIME || dt > MAX_TIME) return;
    if (isTouch && moves < MIN_MOVES) return;
    if (Math.abs(dx) > MAX_DRIFT) return;
    const travel = direction === 'up' ? -dy : dy;
    if (travel > minDist()) location.href = to;
  }

  window.addEventListener('touchstart', onStart, { passive: true });
  window.addEventListener('touchmove',  onMove,  { passive: true });
  window.addEventListener('touchend',   onEnd,   { passive: true });
  window.addEventListener('mousedown',  onStart);
  window.addEventListener('mouseup',    onEnd);
}
