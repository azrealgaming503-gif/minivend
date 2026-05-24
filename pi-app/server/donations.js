// Donation webhook receivers.
//
// We support StreamElements (HMAC-signed) and Ko-fi (shared-token in body),
// because between them they cover the vast majority of streamer setups
// without ever needing the streamer to paste a JWT into the device.
//
// Both endpoints normalize their payload into a common shape:
//   { source, name, amount, currency, message, raw }
// and call the handler passed to `mount(...)`.

const crypto = require('crypto');
const express = require('express');

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Wraps express.json() but keeps a copy of the raw body on req.rawBody
// so we can recompute HMAC signatures.
function rawJson() {
  return express.json({
    limit: '64kb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  });
}

function verifySeSignature(req, secret) {
  if (!secret) return true; // dev mode — accept anything
  const sig = req.get('x-se-signature') || req.get('x-signature') || '';
  if (!sig) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || Buffer.from(''))
    .digest('hex');
  // SE has historically prefixed signatures with "sha256="; accept both.
  const provided = sig.replace(/^sha256=/i, '').trim();
  return timingSafeEqualStr(expected, provided);
}

function normalizeSe(body) {
  // SE sends an envelope like:
  //   { type, provider, data: { username, amount, currency, message, ... } }
  const data = body && body.data ? body.data : {};
  return {
    source: 'streamelements',
    name: data.username || data.displayName || 'Anonymous',
    amount: Number(data.amount) || 0,
    currency: data.currency || 'USD',
    message: data.message || '',
    raw: body,
  };
}

function normalizeKofi(body) {
  // Ko-fi posts form-urlencoded with a single `data` field whose value
  // is the JSON payload. We accept either the parsed object or the raw form.
  let payload = body;
  if (body && typeof body.data === 'string') {
    try { payload = JSON.parse(body.data); } catch (_) { payload = body; }
  }
  return {
    source: 'kofi',
    name: payload.from_name || 'Anonymous',
    amount: Number(payload.amount) || 0,
    currency: payload.currency || 'USD',
    message: payload.message || '',
    raw: payload,
    verification_token: payload.verification_token,
  };
}

function mount(app, { config, onDonation }) {
  // StreamElements: JSON body, HMAC signature in header.
  app.post('/hooks/streamelements', rawJson(), (req, res) => {
    if (!verifySeSignature(req, config.donations.seSecret)) {
      return res.status(401).json({ ok: false, err: 'bad_signature' });
    }
    const evt = normalizeSe(req.body || {});
    if (evt.amount <= 0) {
      // Subs, follows, etc. — accept silently but don't dispense.
      return res.json({ ok: true, dispatched: false });
    }
    onDonation(evt);
    res.json({ ok: true, dispatched: true });
  });

  // Ko-fi: posts urlencoded form by default; some integrations use JSON.
  app.post('/hooks/kofi',
    express.urlencoded({ limit: '64kb', extended: false }),
    express.json({ limit: '64kb' }),
    (req, res) => {
      const evt = normalizeKofi(req.body || {});
      if (config.donations.kofiToken &&
          !timingSafeEqualStr(evt.verification_token, config.donations.kofiToken)) {
        return res.status(401).json({ ok: false, err: 'bad_token' });
      }
      if (evt.amount > 0) onDonation(evt);
      res.json({ ok: true, dispatched: evt.amount > 0 });
    }
  );

  // Manual test trigger from the dashboard.
  app.post('/hooks/test', express.json({ limit: '4kb' }), (req, res) => {
    const body = req.body || {};
    onDonation({
      source: 'test',
      name: body.name || 'TestUser',
      amount: Number(body.amount) || 5,
      currency: body.currency || 'USD',
      message: body.message || 'Test donation from dashboard',
      raw: body,
    });
    res.json({ ok: true });
  });
}

module.exports = { mount };
