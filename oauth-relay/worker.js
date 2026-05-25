// MiniVend OAuth pairing relay.
//
// Purpose
// -------
// The kiosk is on a LAN. StreamElements' OAuth flow needs an https
// redirect URI. So we run this tiny Worker as the OAuth client:
//
//   1. Kiosk: POST /pair/new           → returns { pairing_id, expires_at }
//   2. Phone:  GET  /start?pair=ID     → 302 to SE /oauth2/authorize
//   3. SE:     GET  /callback?code=&state=ID
//        we exchange code → tokens, stash in KV under `pair:ID`
//   4. Kiosk: GET  /pair/ID/poll       → returns tokens once, deletes them
//   5. Kiosk: POST /refresh            → refreshes tokens (client_secret stays here)
//   6. Kiosk: POST /revoke             → revokes a token at SE
//
// Tokens never live in KV for more than ~5 minutes. The kiosk pulls
// them out as soon as it sees the user finish authorizing.
//
// Required Worker secrets (wrangler secret put NAME):
//   SE_CLIENT_ID       — the OAuth client id from streamelements.com/dashboard/apps
//   SE_CLIENT_SECRET   — paired with the above
//   ALLOWED_ORIGINS    — comma-separated list, e.g. "https://yourname.github.io"
//                        (used by the callback page; can be "*" for now)
//
// Required Worker binding:
//   PAIR_KV            — a KV namespace named PAIR_KV
//
// Required vars in wrangler.toml:
//   CALLBACK_URL       — public URL of the callback HTML page, e.g.
//                        "https://you.github.io/minivend/callback.html"
//   SE_SCOPES          — space-separated OAuth scopes, default:
//                        "tips:read activities:read channel:read"
//
// Deploy: see oauth-relay/README.md.

const SE_AUTHORIZE = 'https://api.streamelements.com/oauth2/authorize';
const SE_TOKEN     = 'https://api.streamelements.com/oauth2/token';
const SE_REVOKE    = 'https://api.streamelements.com/oauth2/revoke';
const DEFAULT_SCOPES = 'tips:read activities:read channel:read';

const PAIR_TTL_SEC = 5 * 60;          // pairing slot lives 5 min
const TOKENS_TTL_SEC = 5 * 60;        // tokens linger in KV up to 5 min for the kiosk to fetch

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function randomId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function htmlPage(title, body) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>body{font-family:system-ui,sans-serif;background:#0a0b0e;color:#eee;` +
    `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}` +
    `.box{max-width:480px;text-align:center;background:#15171c;padding:24px;border-radius:14px;` +
    `border:1px solid #2a2e36;}h1{margin:0 0 12px;font-size:20px;}p{color:#aab;}</style>` +
    `<div class="box">${body}</div>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    // ----- 1. Kiosk creates a pairing slot -----
    if (url.pathname === '/pair/new' && request.method === 'POST') {
      const id = randomId();
      const now = Date.now();
      await env.PAIR_KV.put(`pair:${id}`, JSON.stringify({
        status: 'pending', created_at: now,
      }), { expirationTtl: PAIR_TTL_SEC });
      return json({
        pairing_id: id,
        expires_at: now + PAIR_TTL_SEC * 1000,
      });
    }

    // ----- 2. Phone visits this to start the OAuth flow -----
    if (url.pathname === '/start') {
      const pair = url.searchParams.get('pair');
      if (!pair) return htmlPage('MiniVend', '<h1>Missing pairing id</h1>');
      const slot = await env.PAIR_KV.get(`pair:${pair}`);
      if (!slot) {
        return htmlPage('MiniVend',
          '<h1>This pairing link expired.</h1><p>Return to the kiosk and tap <strong>Re-connect</strong>.</p>');
      }
      const redirect = env.CALLBACK_URL;
      const scopes = env.SE_SCOPES || DEFAULT_SCOPES;
      const u = new URL(SE_AUTHORIZE);
      u.searchParams.set('client_id', env.SE_CLIENT_ID);
      u.searchParams.set('redirect_uri', redirect);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', scopes);
      u.searchParams.set('state', pair);
      return Response.redirect(u.toString(), 302);
    }

    // ----- 3a. Callback page (hosted on GH Pages, points its fetch here) -----
    //
    // The callback HTML doesn't have access to client_secret, so it
    // posts {code, state} here and we do the exchange. We expose the
    // result back at /pair/:id/poll for the kiosk.
    if (url.pathname === '/exchange' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'bad_json' }, 400); }
      const { code, state } = body || {};
      if (!code || !state) return json({ error: 'missing_code_or_state' }, 400);

      const slot = await env.PAIR_KV.get(`pair:${state}`);
      if (!slot) return json({ error: 'pairing_expired' }, 410);

      const form = new URLSearchParams();
      form.set('grant_type', 'authorization_code');
      form.set('client_id', env.SE_CLIENT_ID);
      form.set('client_secret', env.SE_CLIENT_SECRET);
      form.set('code', code);
      form.set('redirect_uri', env.CALLBACK_URL);

      const tokenRes = await fetch(SE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const tokens = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokens.access_token) {
        await env.PAIR_KV.put(`pair:${state}`, JSON.stringify({
          status: 'error',
          error: tokens.error_description || tokens.error || `http_${tokenRes.status}`,
        }), { expirationTtl: TOKENS_TTL_SEC });
        return json({ error: tokens.error || 'token_exchange_failed' }, 400);
      }
      await env.PAIR_KV.put(`pair:${state}`, JSON.stringify({
        status: 'ready',
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in:    tokens.expires_in,
        scope:         tokens.scope,
      }), { expirationTtl: TOKENS_TTL_SEC });
      return json({ ok: true });
    }

    // ----- 3b. Friendly status page that the callback HTML may redirect to -----
    if (url.pathname === '/done') {
      return htmlPage('MiniVend',
        '<h1>You are connected.</h1><p>Return to the MiniVend kiosk — it should pick up the new tokens within a few seconds.</p>');
    }

    // ----- 4. Kiosk polls for tokens -----
    if (url.pathname.startsWith('/pair/') && url.pathname.endsWith('/poll') && request.method === 'GET') {
      const id = url.pathname.slice('/pair/'.length, -'/poll'.length);
      const raw = await env.PAIR_KV.get(`pair:${id}`);
      if (!raw) return new Response(null, { status: 404, headers: corsHeaders() });
      const slot = JSON.parse(raw);
      if (slot.status === 'pending') return new Response(null, { status: 204, headers: corsHeaders() });
      if (slot.status === 'ready') {
        await env.PAIR_KV.delete(`pair:${id}`);   // single-use
        return json({
          access_token:  slot.access_token,
          refresh_token: slot.refresh_token,
          expires_in:    slot.expires_in,
          scope:         slot.scope,
        });
      }
      if (slot.status === 'error') {
        await env.PAIR_KV.delete(`pair:${id}`);
        return json({ error: slot.error || 'unknown' }, 400);
      }
      return json({ error: 'unknown_state' }, 500);
    }

    // ----- 5. Refresh tokens (kiosk → relay → SE) -----
    if (url.pathname === '/refresh' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'bad_json' }, 400); }
      const refresh_token = body && body.refresh_token;
      if (!refresh_token) return json({ error: 'missing_refresh_token' }, 400);
      const form = new URLSearchParams();
      form.set('grant_type', 'refresh_token');
      form.set('client_id', env.SE_CLIENT_ID);
      form.set('client_secret', env.SE_CLIENT_SECRET);
      form.set('refresh_token', refresh_token);
      const r = await fetch(SE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const tokens = await r.json().catch(() => ({}));
      if (!r.ok || !tokens.access_token) {
        return json({ error: tokens.error || `http_${r.status}` }, 400);
      }
      return json({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token || refresh_token,
        expires_in:    tokens.expires_in,
        scope:         tokens.scope,
      });
    }

    // ----- 6. Revoke -----
    if (url.pathname === '/revoke' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'bad_json' }, 400); }
      const access_token = body && body.access_token;
      if (!access_token) return json({ error: 'missing_access_token' }, 400);
      const form = new URLSearchParams();
      form.set('client_id', env.SE_CLIENT_ID);
      form.set('client_secret', env.SE_CLIENT_SECRET);
      form.set('token', access_token);
      const r = await fetch(SE_REVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      return json({ ok: r.ok });
    }

    // Healthcheck for the kiosk's "is the relay reachable" indicator.
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'minivend-oauth-relay' });
    }

    return new Response('not found', { status: 404 });
  },
};
