// Verifies a signed request from 402cron. No dependencies: node:crypto only.
//
// 402cron signs the BYTES of six fields, one per line:
//
//   timestamp \n deliveryId \n attempt \n METHOD \n path+query \n rawBody
//
// timestamp, deliveryId and attempt come from the X-402cron-Timestamp,
// X-402cron-Delivery-Id and X-402cron-Attempt headers. The signature arrives as
// X-402cron-Signature: sha256=<hex HMAC-SHA256, keyed with your signing secret>.
// The X-402cron-Event label is NOT signed: branch on it, but trust only what the
// signature covers.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Five minutes either way: generous for clock skew, short for replays. */
export const MAX_AGE_SECONDS = 300;

/** The exact bytes 402cron signs. `rawBody` must be the body as received, not re-serialized JSON. */
export function signedBytes({ timestamp, deliveryId, attempt, method, pathAndQuery, rawBody }) {
  const head = `${timestamp}\n${deliveryId}\n${attempt}\n${String(method).toUpperCase()}\n${pathAndQuery}\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(rawBody ?? '')]);
}

/**
 * Checks a delivery or a pause notice. Returns { ok: true, deliveryId, attempt, event }
 * or { ok: false, reason } — never throws on bad input.
 *
 * `headers` is Node's `req.headers` (lower-case names). `pathAndQuery` is `req.url`:
 * the path and query exactly as your server received them. If a proxy rewrites the
 * path before it reaches you, pass the ORIGINAL path — the signature covers it.
 */
export function verifyRequest({ secret, headers, method, pathAndQuery, rawBody, now = Date.now() }) {
  const get = (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const signature = get('x-402cron-signature');
  const timestamp = get('x-402cron-timestamp');
  const deliveryId = get('x-402cron-delivery-id');
  const attempt = get('x-402cron-attempt');
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!signature || !timestamp || !deliveryId || attempt === undefined) return { ok: false, reason: 'missing_headers' };

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_AGE_SECONDS) return { ok: false, reason: 'stale_or_bad_timestamp' };

  const expected = Buffer.from(
    'sha256=' +
      createHmac('sha256', secret)
        .update(signedBytes({ timestamp, deliveryId, attempt, method, pathAndQuery, rawBody }))
        .digest('hex'),
  );
  const provided = Buffer.from(String(signature));
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, deliveryId, attempt: Number(attempt), event: get('x-402cron-event') };
}
