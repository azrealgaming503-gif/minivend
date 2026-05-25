// MiniVend OAuth pairing relay — Deno Deploy edition.
//
// Same protocol as worker.js (the Cloudflare version), but uses
// Deno's built-in KV store and `Deno.serve` instead of Cloudflare
// Workers' KV namespace + `export default { fetch }` pattern.
//
// Deploy via dash.deno.com → New Project → Playground → paste this
// file → set env vars (see oauth-relay/README.md → "Deno Deploy").
//
// Required env vars (set in Project Settings on dash.deno.com):
//   SE_CLIENT_ID       — OAuth client id from streamelements.com/dashboard/apps
//   SE_CLIENT_SECRET   — paired with the above
//   CALLBACK_URL       — public URL of the callback HTML page,
//                        e.g. https://you.github.io/minivend/oauth-relay/callback.html
//   SE_SCOPES          — (optional) defaults to
//                        "tips:read activities:read channel:read"

const SE_AUTHORIZE   = "https://api.streamelements.com/oauth2/authorize";
const SE_TOKEN       = "https://api.streamelements.com/oauth2/token";
const SE_REVOKE      = "https://api.streamelements.com/oauth2/revoke";
const DEFAULT_SCOPES = "tips:read activities:read channel:read";

const PAIR_TTL_MS = 5 * 60 * 1000;

const kv = await Deno.openKv();

function getEnv(key: string, fallback = ""): string {
  return Deno.env.get(key) ?? fallback;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(), ...extra },
  });
}

function htmlPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>body{font-family:system-ui,sans-serif;background:#0a0b0e;color:#eee;` +
    `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}` +
    `.box{max-width:480px;text-align:center;background:#15171c;padding:24px;border-radius:14px;` +
    `border:1px solid #2a2e36;}h1{margin:0 0 12px;font-size:20px;}p{color:#aab;}</style>` +
    `<div class="box">${body}</div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

interface PairSlot {
  status: "pending" | "ready" | "error";
  created_at?: number;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

Deno.serve(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // ----- 1. Kiosk creates a pairing slot -----
  if (url.pathname === "/pair/new" && request.method === "POST") {
    const id  = randomId();
    const now = Date.now();
    await kv.set(["pair", id], {
      status: "pending",
      created_at: now,
    } as PairSlot, { expireIn: PAIR_TTL_MS });
    return json({ pairing_id: id, expires_at: now + PAIR_TTL_MS });
  }

  // ----- 2. Phone visits this to start the OAuth flow -----
  if (url.pathname === "/start") {
    const pair = url.searchParams.get("pair");
    if (!pair) return htmlPage("MiniVend", "<h1>Missing pairing id</h1>");
    const slot = await kv.get<PairSlot>(["pair", pair]);
    if (!slot.value) {
      return htmlPage(
        "MiniVend",
        '<h1>This pairing link expired.</h1><p>Return to the kiosk and tap <strong>Re-connect</strong>.</p>',
      );
    }
    const callback = getEnv("CALLBACK_URL");
    const scopes   = getEnv("SE_SCOPES", DEFAULT_SCOPES);
    const u = new URL(SE_AUTHORIZE);
    u.searchParams.set("client_id",     getEnv("SE_CLIENT_ID"));
    u.searchParams.set("redirect_uri",  callback);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope",         scopes);
    u.searchParams.set("state",         pair);
    return Response.redirect(u.toString(), 302);
  }

  // ----- 3. Callback page POSTs the code+state here for exchange -----
  if (url.pathname === "/exchange" && request.method === "POST") {
    let body: { code?: string; state?: string } | null = null;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const code  = body?.code;
    const state = body?.state;
    if (!code || !state) return json({ error: "missing_code_or_state" }, 400);

    const slot = await kv.get<PairSlot>(["pair", state]);
    if (!slot.value) return json({ error: "pairing_expired" }, 410);

    const form = new URLSearchParams();
    form.set("grant_type",    "authorization_code");
    form.set("client_id",     getEnv("SE_CLIENT_ID"));
    form.set("client_secret", getEnv("SE_CLIENT_SECRET"));
    form.set("code",          code);
    form.set("redirect_uri",  getEnv("CALLBACK_URL"));

    const tokenRes = await fetch(SE_TOKEN, {
      method:  "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:    form.toString(),
    });
    // deno-lint-ignore no-explicit-any
    const tokens: any = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.access_token) {
      await kv.set(["pair", state], {
        status: "error",
        error:  tokens.error_description || tokens.error || `http_${tokenRes.status}`,
      } as PairSlot, { expireIn: PAIR_TTL_MS });
      return json({ error: tokens.error || "token_exchange_failed" }, 400);
    }
    await kv.set(["pair", state], {
      status:        "ready",
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in:    tokens.expires_in,
      scope:         tokens.scope,
    } as PairSlot, { expireIn: PAIR_TTL_MS });
    return json({ ok: true });
  }

  if (url.pathname === "/done") {
    return htmlPage(
      "MiniVend",
      '<h1>You are connected.</h1><p>Return to the MiniVend kiosk — it should pick up the new tokens within a few seconds.</p>',
    );
  }

  // ----- 4. Kiosk polls for tokens -----
  if (url.pathname.startsWith("/pair/") && url.pathname.endsWith("/poll") && request.method === "GET") {
    const id = url.pathname.slice("/pair/".length, -"/poll".length);
    const slot = await kv.get<PairSlot>(["pair", id]);
    if (!slot.value) return new Response(null, { status: 404, headers: corsHeaders() });
    if (slot.value.status === "pending") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (slot.value.status === "ready") {
      await kv.delete(["pair", id]); // single-use
      return json({
        access_token:  slot.value.access_token,
        refresh_token: slot.value.refresh_token,
        expires_in:    slot.value.expires_in,
        scope:         slot.value.scope,
      });
    }
    if (slot.value.status === "error") {
      await kv.delete(["pair", id]);
      return json({ error: slot.value.error || "unknown" }, 400);
    }
    return json({ error: "unknown_state" }, 500);
  }

  // ----- 5. Refresh tokens -----
  if (url.pathname === "/refresh" && request.method === "POST") {
    let body: { refresh_token?: string } | null = null;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const refresh_token = body?.refresh_token;
    if (!refresh_token) return json({ error: "missing_refresh_token" }, 400);
    const form = new URLSearchParams();
    form.set("grant_type",    "refresh_token");
    form.set("client_id",     getEnv("SE_CLIENT_ID"));
    form.set("client_secret", getEnv("SE_CLIENT_SECRET"));
    form.set("refresh_token", refresh_token);
    const r = await fetch(SE_TOKEN, {
      method:  "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:    form.toString(),
    });
    // deno-lint-ignore no-explicit-any
    const tokens: any = await r.json().catch(() => ({}));
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
  if (url.pathname === "/revoke" && request.method === "POST") {
    let body: { access_token?: string } | null = null;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const access_token = body?.access_token;
    if (!access_token) return json({ error: "missing_access_token" }, 400);
    const form = new URLSearchParams();
    form.set("client_id",     getEnv("SE_CLIENT_ID"));
    form.set("client_secret", getEnv("SE_CLIENT_SECRET"));
    form.set("token",         access_token);
    const r = await fetch(SE_REVOKE, {
      method:  "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:    form.toString(),
    });
    return json({ ok: r.ok });
  }

  // Healthcheck.
  if (url.pathname === "/" || url.pathname === "/health") {
    return json({ ok: true, service: "minivend-oauth-relay", runtime: "deno-deploy" });
  }

  return new Response("not found", { status: 404 });
});
