// Tiny shared WebSocket client. Auto-reconnects with backoff and
// dispatches incoming messages to per-type subscribers.
//
// Usage:
//   import { onMessage, send } from './js/ws-client.js';
//   onMessage('donation', (msg) => { ... });

const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const subs = new Map(); // type -> Set<callback>
let ws = null;
let backoff = 500;

function dispatch(msg) {
  const handlers = subs.get(msg.type);
  if (handlers) for (const cb of handlers) {
    try { cb(msg); } catch (e) { console.error('ws handler error', e); }
  }
  const wild = subs.get('*');
  if (wild) for (const cb of wild) {
    try { cb(msg); } catch (e) { console.error('ws wildcard handler error', e); }
  }
}

function connect() {
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    backoff = 500;
    dispatch({ type: '_open' });
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg && typeof msg.type === 'string') dispatch(msg);
  });
  ws.addEventListener('close', () => {
    ws = null;
    dispatch({ type: '_close' });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10000);
  });
  ws.addEventListener('error', () => {
    try { ws && ws.close(); } catch (_) { /* noop */ }
  });
}

export function onMessage(type, cb) {
  if (!subs.has(type)) subs.set(type, new Set());
  subs.get(type).add(cb);
  return () => subs.get(type).delete(cb);
}

export function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

connect();
