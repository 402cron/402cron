// A minimal 402cron destination. No dependencies.
//
//   SECRET_402CRON=<signing secret from POST /api/destinations> node server.mjs
//
// It must be reachable over public https — put it behind your usual reverse proxy
// or tunnel. PORT defaults to 3000.
//
// Three kinds of requests arrive at the same URL, told apart by X-402cron-Event:
//   verify       once, when you call POST /api/destinations/{id}/verify. Unsigned.
//                Answer with the X-402cron-Challenge value as the body.
//   delivery     on schedule, on retries, and when you call /run. Signed.
//   task_paused  one courtesy notice when a task pauses. Signed.

import { createServer } from 'node:http';
import { verifyRequest } from './verify.mjs';

const SECRET = process.env.SECRET_402CRON ?? '';
const PORT = Number(process.env.PORT ?? 3000);

// Delivery is AT LEAST ONCE: if our acknowledgement is lost, the same delivery id
// arrives again. Remember what you handled — in a database, not in memory, in production.
const handled = new Set();

function reply(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const event = req.headers['x-402cron-event'];

  if (event === 'verify') {
    // Proves you control this URL. Echo the value, nothing else.
    return reply(res, 200, String(req.headers['x-402cron-challenge'] ?? ''));
  }

  const check = verifyRequest({
    secret: SECRET,
    headers: req.headers,
    method: req.method,
    pathAndQuery: req.url,
    rawBody,
  });
  if (!check.ok) {
    // A 4xx is a refusal: 402cron does not retry it, and 20 in a row pause the task.
    console.warn(`refused: ${check.reason}`);
    return reply(res, 401, check.reason);
  }

  if (event === 'task_paused') {
    const notice = JSON.parse(rawBody.toString('utf8') || '{}');
    console.log(`task ${notice.taskId} paused (${notice.reasonCode}): ${notice.reason}`);
    console.log(`resume with: POST ${notice.resume}`);
    return reply(res, 200, 'ok');
  }

  if (handled.has(check.deliveryId)) return reply(res, 200, 'already handled');
  handled.add(check.deliveryId);

  // Answer within 2 seconds — the timeout is for ACCEPTANCE, not for finishing.
  reply(res, 202, 'accepted');
  setImmediate(() => doTheWork(check, rawBody));
});

function doTheWork(check, rawBody) {
  // Your job goes here.
  console.log(`delivery ${check.deliveryId} (attempt ${check.attempt}): ${rawBody.toString('utf8').slice(0, 200)}`);
}

server.listen(PORT, () => {
  if (!SECRET) console.warn('SECRET_402CRON is not set: verification will pass, deliveries will be refused.');
  console.log(`listening on :${PORT}`);
});
