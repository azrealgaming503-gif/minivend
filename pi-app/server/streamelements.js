// StreamElements OAuth client + Astro realtime subscriber.
//
// Why this exists
// ---------------
// We want the kiosk to react to live tips from StreamElements without
// the streamer ever pasting a JWT or punching holes through their
// router. OAuth2 is the official, ToS-clean way to do that — but the
// OAuth flow needs a redirect URI, and a kiosk doesn't have one.
//
// We solve that with a tiny "pairing relay" (a free Cloudflare Worker,
// source in /oauth-relay) that owns the OAuth client_secret and brokers
// the dance between the streamer's phone and this kiosk:
//
//   Pi  ─┐                                            ┌─ SE OAuth
//        │ 1. POST /pair/new                          │
//        │    → returns pairing_id                    │
//        │                                            │
//        │ 2. show QR  ──→  phone visits relay/start  │
//        │                  ─→  relay redirects ─────→│
//        │                                            │
//        │                  ←─── SE redirects ────────│
//        │                  ←─ relay /callback        │
//        │                  ←  relay exchanges code   │
//        │                  ←  relay stores tokens    │
//        │                                            │
//        │ 3. GET /pair/:id/poll (every 2s)           │
//        │    ← returns tokens once ready             │
//        └──→ open WS to wss://astro.streamelements.com
//             (outbound only — no inbound surface)
//
// Token refresh also goes through the relay (POST /refresh) so we never
// embed the client_secret in any kiosk.
//
// Fallback: if the streamer doesn't want to wait for the relay or is
// running offline, they can paste a JWT from the SE dashboard. We use
// that JWT directly as the Astro auth token. Same realtime stream,
// same tip events.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

const AUTHORIZE_URL = 'https://api.streamelements.com/oauth2/authorize';
const TOKEN_URL     = 'https://api.streamelements.com/oauth2/token';
const REVOKE_URL    = 'https://api.streamelements.com/oauth2/revoke';
const ME_URL        = 'https://api.streamelements.com/kappa/v2/channels/me';
const ASTRO_URL     = 'wss://astro.streamelements.com';

const ASTRO_TOPIC   = 'channel.activities';
// Stream online/offline status topic. Requires the `stream-live:read`
// scope; existing tokens authorized before this scope was added will be
// rejected when subscribing (handled gracefully — live detection just
// stays unavailable until the streamer reconnects their account).
const STATUS_TOPIC  = 'channel.stream.status';
const SCOPES        = ['tips:read', 'activities:read', 'channel:read', 'stream-live:read'];

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 60_000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const POLL_DEFAULT_MS   = 2000;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeWrite(file, body, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, file);
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

class StreamElementsClient extends EventEmitter {
  constructor({ tokensFile, relayUrl, redirectUri, clientId, pollIntervalMs }) {
    super();
    this.tokensFile  = tokensFile;
    this.relayUrl    = (relayUrl || '').replace(/\/+$/, '');
    this.redirectUri = redirectUri || '';
    this.clientId    = clientId || '';
    this.pollMs      = pollIntervalMs || POLL_DEFAULT_MS;

    // State (transient — recomputed from tokens + WS state).
    this.tokens   = null;     // { mode: 'oauth' | 'jwt', access_token, refresh_token?, expires_at? }
    this.account  = null;     // { id, username, provider, displayName }
    this.ws       = null;
    this.connected = false;
    this.lastError = null;
    this.lastEventAt = null;

    // Live stream status (from the channel.stream.status topic):
    //   live          — true/false once known, null while unknown.
    //   liveSupported — true if the status subscription succeeded,
    //                   false if rejected (token lacks stream-live:read),
    //                   null until we've tried.
    this.live = null;
    this.liveSupported = null;
    this._subNonces = {}; // subscribe nonce -> topic, to route responses

    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._refreshTimer = null;
    this._pingTimer = null;
    this._subscribedRoom = null;
    this._stopped = false;

    this._loadTokens();
  }

  // ---------- persistence ----------

  _loadTokens() {
    const raw = safeRead(this.tokensFile);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.access_token) {
        this.tokens  = parsed;
        this.account = parsed.account || null;
      }
    } catch (_) { /* corrupt — ignore */ }
  }

  _saveTokens() {
    if (!this.tokens) {
      try { fs.unlinkSync(this.tokensFile); } catch (_) {}
      return;
    }
    safeWrite(this.tokensFile, JSON.stringify({
      ...this.tokens,
      account: this.account,
      saved_at: Date.now(),
    }, null, 2));
  }

  // ---------- public state ----------

  status() {
    return {
      configured: !!this.tokens,
      mode: this.tokens && this.tokens.mode,
      connected: this.connected,
      account: this.account,
      hasRelay: !!this.relayUrl,
      relayUrl: this.relayUrl || null,
      clientId: this.clientId || null,
      scopes: SCOPES,
      expiresAt: this.tokens && this.tokens.expires_at || null,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      live: this.live,
      liveSupported: this.liveSupported,
    };
  }

  // ---------- pairing (via Cloudflare Worker relay) ----------

  async createPairing() {
    if (!this.relayUrl) throw new Error('OAuth relay URL is not configured');
    const res = await fetch(`${this.relayUrl}/pair/new`, { method: 'POST' });
    if (!res.ok) throw new Error(`relay /pair/new ${res.status}`);
    const json = await res.json();
    if (!json || !json.pairing_id) throw new Error('relay returned no pairing_id');

    const authUrl = `${this.relayUrl}/start?pair=${encodeURIComponent(json.pairing_id)}`;
    return { pairingId: json.pairing_id, authUrl, expiresAt: json.expires_at || null };
  }

  async pollPairing(pairingId) {
    if (!this.relayUrl) throw new Error('OAuth relay URL is not configured');
    const res = await fetch(`${this.relayUrl}/pair/${encodeURIComponent(pairingId)}/poll`);
    if (res.status === 204) return { status: 'pending' };
    if (res.status === 404) return { status: 'expired' };
    if (!res.ok) throw new Error(`relay poll ${res.status}`);
    const json = await res.json();
    if (json && json.error)        return { status: 'error', error: json.error };
    if (json && json.access_token) {
      await this.setOauthTokens(json);
      return { status: 'ok', account: this.account };
    }
    return { status: 'pending' };
  }

  // ---------- token management ----------

  async setOauthTokens({ access_token, refresh_token, expires_in, scope }) {
    const expires_at = Date.now() + Math.max(60, Number(expires_in) || 3600) * 1000;
    this.tokens = {
      mode: 'oauth',
      access_token,
      refresh_token: refresh_token || null,
      expires_at,
      scope: scope || SCOPES.join(' '),
    };
    await this._fetchAccount();
    this._saveTokens();
    this._scheduleRefresh();
    this._reconnect();
  }

  async setJwt(jwt) {
    if (!jwt || typeof jwt !== 'string' || jwt.length < 40) {
      throw new Error('JWT looks invalid');
    }
    this.tokens = { mode: 'jwt', access_token: jwt.trim(), expires_at: null };
    await this._fetchAccount();
    this._saveTokens();
    this._reconnect();
  }

  async disconnect() {
    this._stopped = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'disconnect'); } catch (_) {}
      this.ws = null;
    }
    // Best-effort token revoke (don't block on failure)
    if (this.tokens && this.tokens.mode === 'oauth' && this.relayUrl && this.tokens.access_token) {
      try {
        await fetch(`${this.relayUrl}/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access_token: this.tokens.access_token }),
        });
      } catch (_) {}
    }
    this.tokens  = null;
    this.account = null;
    this.connected = false;
    this.live = null;
    this.liveSupported = null;
    this._saveTokens();
    this.emit('state');
  }

  async _refresh() {
    if (!this.tokens || this.tokens.mode !== 'oauth' || !this.tokens.refresh_token) return false;
    if (!this.relayUrl) {
      this.lastError = 'refresh requires relay (no client_secret on Pi)';
      this.emit('state');
      return false;
    }
    try {
      const res = await fetch(`${this.relayUrl}/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.tokens.refresh_token }),
      });
      if (!res.ok) throw new Error(`relay /refresh ${res.status}`);
      const json = await res.json();
      if (!json.access_token) throw new Error('relay refresh returned no access_token');
      await this.setOauthTokens({
        access_token:  json.access_token,
        refresh_token: json.refresh_token || this.tokens.refresh_token,
        expires_in:    json.expires_in,
        scope:         json.scope,
      });
      return true;
    } catch (e) {
      this.lastError = `refresh failed: ${e.message}`;
      this.emit('state');
      return false;
    }
  }

  _scheduleRefresh() {
    clearTimeout(this._refreshTimer); this._refreshTimer = null;
    if (!this.tokens || this.tokens.mode !== 'oauth' || !this.tokens.expires_at) return;
    const due = this.tokens.expires_at - Date.now() - REFRESH_MARGIN_MS;
    const ms  = Math.max(15_000, due);
    this._refreshTimer = setTimeout(() => this._refresh(), ms);
  }

  // ---------- account info ----------

  async _fetchAccount() {
    if (!this.tokens) return;
    try {
      const res = await fetch(ME_URL, {
        headers: { authorization: `Bearer ${this.tokens.access_token}` },
      });
      if (!res.ok) {
        this.lastError = `channels/me ${res.status}`;
        return;
      }
      const j = await res.json();
      this.account = {
        id:          j._id || j.id,
        username:    j.username,
        displayName: j.displayName || j.username,
        provider:    j.provider,
        avatar:      j.avatar,
      };
    } catch (e) {
      this.lastError = `channels/me ${e.message}`;
    }
  }

  // ---------- Astro WebSocket ----------

  start() {
    this._stopped = false;
    if (this.tokens) this._reconnect();
  }

  _reconnect() {
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    if (!this.tokens || this._stopped) return;
    this._open();
  }

  _open() {
    let ws;
    try {
      ws = new WebSocket(ASTRO_URL);
    } catch (e) {
      this.lastError = `ws ${e.message}`;
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this._reconnectAttempts = 0;
      this.lastError = null;
      this.emit('state');
    });

    ws.on('message', (raw) => this._onMessage(raw));

    ws.on('close', (code, reason) => {
      this.connected = false;
      // Live status is no longer trustworthy once the socket drops.
      this.live = null;
      this.lastError = `closed code=${code} reason=${(reason || '').toString().slice(0, 80) || '-'}`;
      this.emit('state');
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.lastError = `ws error: ${err.message}`;
      this.emit('state');
    });

    ws.on('ping', () => { try { ws.pong(); } catch (_) {} });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'welcome') {
      this._subscribe();
      return;
    }
    if (msg.type === 'response') {
      const topic = msg.nonce ? this._subNonces[msg.nonce] : null;
      if (msg.error) {
        // A rejected stream-status subscription is expected for tokens
        // issued before the stream-live:read scope existed. Treat it as
        // "live detection unavailable" rather than a fatal auth error —
        // do NOT refresh (the refreshed token has the same old scopes,
        // which would just loop).
        if (topic === STATUS_TOPIC) {
          this.liveSupported = false;
          this.live = null;
          this.emit('state');
          return;
        }
        this.lastError = `subscribe error: ${msg.error} ${msg.data && msg.data.message || ''}`.trim();
        this.emit('state');
        // err_unauthorized usually means expired token — try a refresh.
        if (/unauth/i.test(msg.error)) this._refresh();
      } else {
        if (topic === STATUS_TOPIC) {
          // Subscribed OK; the current isLive arrives as a separate
          // message (and on every subsequent online/offline change).
          this.liveSupported = true;
        } else {
          this.connected = true;
        }
        this.emit('state');
      }
      return;
    }
    if (msg.type === 'message' && msg.topic === STATUS_TOPIC) {
      const d = msg.data || {};
      if (typeof d.isLive === 'boolean') {
        this.live = d.isLive;
        this.liveSupported = true;
        this.emit('state');
      }
      return;
    }
    if (msg.type === 'message' && msg.topic === ASTRO_TOPIC) {
      this._handleActivity(msg.data || msg);
      return;
    }
    // Some servers wrap differently — handle 'event' too.
    if (msg.event && msg.data) this._handleActivity(msg);
  }

  _subscribe(retry = 0) {
    if (!this.tokens || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.account || !this.account.id) {
      if (retry >= 1) {
        this.lastError = 'no channel id (auth probably failed)';
        this.emit('state');
        return;
      }
      // No channel id yet — try to grab one once, then subscribe.
      this._fetchAccount().then(() => this._subscribe(retry + 1));
      return;
    }
    this._subscribedRoom = this.account.id;
    this._subNonces = {};
    // Donations/activities feed (required) + live status feed (optional).
    this._sendSubscribe(ASTRO_TOPIC);
    this._sendSubscribe(STATUS_TOPIC);
  }

  _sendSubscribe(topic) {
    if (!this.tokens || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.account || !this.account.id) return;
    const nonce = crypto.randomUUID();
    this._subNonces[nonce] = topic;
    const sub = {
      type: 'subscribe',
      nonce,
      data: {
        topic,
        room: this.account.id,
        token: this.tokens.access_token,
        token_type: this.tokens.mode === 'jwt' ? 'jwt' : 'oauth2',
      },
    };
    try { this.ws.send(JSON.stringify(sub)); } catch (_) {}
  }

  _scheduleReconnect() {
    this._clearTimers();
    if (this._stopped || !this.tokens) return;
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts)
    );
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._open(), backoff);
  }

  _clearTimers() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pingTimer)      { clearInterval(this._pingTimer);    this._pingTimer = null; }
  }

  _handleActivity(payload) {
    // payload shape: { event/type: 'tip', data: { ... }, provider, ... }
    const evt = payload.type || payload.event;
    if (evt !== 'tip') return;
    const data = payload.data || {};
    const tip = {
      source: 'streamelements',
      name: data.username || data.displayName || 'Anonymous',
      amount: Number(data.amount) || 0,
      currency: data.currency || 'USD',
      message: data.message || '',
      provider: payload.provider || data.provider || null,
      tipId: data.tipId || data._id || null,
      raw: payload,
    };
    this.lastEventAt = Date.now();
    this.emit('tip', tip);
    this.emit('state');
  }
}

module.exports = { StreamElementsClient, SCOPES };
