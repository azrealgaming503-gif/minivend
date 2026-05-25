# MiniVend OAuth Pairing Relay

This is the tiny serverless piece that lets a MiniVend kiosk pair
with a StreamElements account using OAuth2 — no public URL on the
Pi, no JWT pasting, no port forwarding.

**You only need to deploy this once.** Every kiosk on the planet
can point at the same relay; the only per-streamer state is the
short-lived pairing slot (5 minutes, evicted from KV automatically).

## What it does

```
Pi  ──┐                                  ┌─ StreamElements
      │ 1. POST /pair/new                │
      │ 2. shows QR ─→ phone /start ────→│ /oauth2/authorize
      │                                   │ user taps Allow
      │ 3. callback.html ←────────────────│ /callback?code=&state=
      │    POSTs code+state to /exchange  │
      │    relay → /oauth2/token ────────→│
      │    relay stashes tokens in KV     │
      │ 4. Pi polls /pair/:id/poll        │
      │    receives tokens, opens         │
      │    wss://astro.streamelements.com │
      └──→──────────────────────────────→│
```

The relay owns the OAuth `client_secret`. The Pi never sees it.
Token refresh also goes through the relay (`POST /refresh`), so
secrets stay server-side forever.

## One-time setup

### 1. Register the OAuth app at StreamElements

1. Sign into <https://streamelements.com/dashboard/apps>.
2. Click **New application**.
3. Name it `MiniVend Kiosk`.
4. Redirect URI: the public URL where you'll host `callback.html`
   (see step 3). Example:
   `https://your-github-username.github.io/minivend/callback.html`
5. Scopes: `tips:read activities:read channel:read`
6. Save. Copy the **Client ID** and **Client Secret**.

### 2. Deploy the Cloudflare Worker

```bash
cd oauth-relay
npm install -g wrangler
wrangler login

# Create a KV namespace for pairing slots
wrangler kv:namespace create PAIR_KV
# → paste the printed id into wrangler.toml under [[kv_namespaces]]

# Edit wrangler.toml: set CALLBACK_URL to the public URL from step 1
# (you'll host the page in step 3).

# Store secrets (paste values when prompted)
wrangler secret put SE_CLIENT_ID
wrangler secret put SE_CLIENT_SECRET

# Deploy
wrangler deploy
# → prints: https://minivend-oauth-relay.<you>.workers.dev
```

### 3. Host `callback.html`

The simplest option is GitHub Pages on the MiniVend repo:

1. Edit `callback.html` and set `RELAY_URL` to the Worker URL
   Wrangler printed in step 2.
2. Commit + push.
3. In your GitHub repo settings → Pages, enable Pages from the
   `main` branch, root folder. Wait ~1 minute.
4. Visit `https://<you>.github.io/<repo>/oauth-relay/callback.html`
   to confirm. Use this URL as the SE redirect URI (step 1)
   and as `CALLBACK_URL` in `wrangler.toml` — they must match
   exactly.

### 4. Point every kiosk at the relay

On each Pi, edit `/opt/minivend/pi-app/.env`:

```env
SE_RELAY_URL=https://minivend-oauth-relay.<you>.workers.dev
```

then `sudo systemctl restart minivend-server`.

## Per-streamer flow (after setup)

1. Tap **Settings** → **StreamElements** → **Connect**.
2. Scan the QR with your phone.
3. Sign into StreamElements, tap **Allow**.
4. Kiosk shows "connected as `<username>`" within a few seconds.

Tips trigger the dispense pipeline immediately. Cooldowns, tiered
chambers, and donation history all still apply.

## Testing the relay locally

```bash
cd oauth-relay
wrangler dev --local
# → http://localhost:8787
curl -X POST http://localhost:8787/pair/new
# → { "pairing_id": "...", "expires_at": ... }
```

## Costs

Cloudflare Workers free tier: 100,000 requests/day. A single
streamer's kiosk uses ~50 requests/day total (polls, token
refresh). You'd need to host >2,000 kiosks before hitting limits.

## Security notes

- `SE_CLIENT_SECRET` is stored as a Wrangler secret, not in the
  Worker source. Treat it like a password.
- Pairing slots live for 5 minutes max in KV. Tokens stashed
  there are deleted as soon as the kiosk polls them.
- The relay is stateless beyond KV. There is no persistent log
  of any tokens or events.
- Use `wrangler secret list` to confirm secrets are set;
  `wrangler tail` to live-stream logs while debugging.

## Updating the relay

The relay rarely changes. If StreamElements changes the OAuth
endpoints, edit `worker.js` and `wrangler deploy` again. Existing
kiosks keep working since they only talk to the relay over a
stable URL.
