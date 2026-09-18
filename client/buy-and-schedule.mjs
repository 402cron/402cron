// Buy 402cron credits with x402, register your endpoint, verify it and create a task.
//
//   npm install
//   DRY_RUN=1 node buy-and-schedule.mjs                 # read the price and sign, pay nothing
//   PRIVATE_KEY=0x... DESTINATION_URL=https://your.host/hook node buy-and-schedule.mjs
//
// PRIVATE_KEY is a Base wallet holding a little USDC (the trial is $0.02). Gas is not
// needed: the facilitator submits the transfer. Start your receiver (../receiver) at
// DESTINATION_URL BEFORE running this — the verification step calls it.
//
// The management token and the signing secret are each shown ONCE. This script saves
// them to 402cron-credentials.json next to it. Keep that file out of version control.

import { writeFileSync } from 'node:fs';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const API = 'https://402cron.com';
const PACK = process.env.PACK ?? 'trial';
const DRY_RUN = process.env.DRY_RUN === '1';
const DESTINATION_URL = process.env.DESTINATION_URL;
const CRON = process.env.CRON ?? '0 9 * * MON-FRI'; // 5 fields, always UTC
const TASK_NAME = process.env.TASK_NAME ?? 'daily-digest';

if (!DRY_RUN && !process.env.PRIVATE_KEY) fail('Set PRIVATE_KEY (or DRY_RUN=1 to only sign).');
if (!DRY_RUN && !DESTINATION_URL) fail('Set DESTINATION_URL to your https endpoint.');

// ── 1. The price, read the way every x402 client reads it: from the PAYMENT-REQUIRED header ──

const account = privateKeyToAccount(process.env.PRIVATE_KEY ?? generatePrivateKey());
const payments = new x402HTTPClient(
  x402Client.fromConfig({
    schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(toClientEvmSigner(account)) }],
    // An independent cap: never trust the seller for your own spending limit.
    spendControls: { maxAmountPerPayment: process.env.MAX_USD ?? '$0.05' },
  }),
);

const buyUrl = `${API}/buy/${PACK}`;
const offer = await fetch(buyUrl);
if (offer.status !== 402) fail(`Expected 402 from ${buyUrl}, got ${offer.status}: ${await offer.text()}`);
const required = payments.getPaymentRequiredResponse((name) => offer.headers.get(name));
const terms = required.accepts[0];
console.log(`${PACK}: ${Number(terms.amount) / 1e6} USDC on ${terms.network}, paid to ${terms.payTo}`);

let payload;
try {
  payload = await payments.createPaymentPayload(required);
} catch (error) {
  // Most often the spend cap above refusing a price higher than MAX_USD — on purpose.
  fail(`Not signing: ${error?.message ?? error}`);
}
console.log(`signed by ${account.address}`);
if (DRY_RUN) {
  console.log('DRY_RUN=1: stopping before payment. Nothing was paid.');
  process.exit(0);
}

// ── 2. Pay. The receipt carries the management token, shown once. ──

const paid = await fetch(buyUrl, { headers: payments.encodePaymentSignatureHeader(payload) });
const receipt = await paid.json();
if (!paid.ok) fail(`Payment refused (${paid.status}): ${JSON.stringify(receipt)}`);
console.log(`credited ${receipt.creditedDeliveries} deliveries, balance ${receipt.deliveriesLeft}`);

const token = receipt.managementToken;
if (!token) {
  fail(
    'No token in the receipt: this wallet already has one. Use it, or buy again with ?rotate=1 ' +
      '(the old token dies) — see https://402cron.com/docs?section=authentication',
  );
}
const credentials = { token, payment: receipt.payment };
save(credentials);

const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

// ── 3. Register the endpoint. The signing secret is shown once. ──

const registered = await call('POST', '/api/destinations', { url: DESTINATION_URL });
credentials.destinationId = registered.id;
credentials.signingSecret = registered.secret;
save(credentials);
console.log(`destination ${registered.id} registered (${registered.status}); signing secret saved`);
console.log('Give that secret to your receiver as SECRET_402CRON before the first scheduled run.');

// ── 4. Verify: 402cron POSTs a challenge to your URL, your receiver echoes it. ──

const verified = await call('POST', `/api/destinations/${registered.id}/verify`);
console.log(`verification: ${verified.status ?? 'ok'}`);

// ── 5. Schedule. ──

const task = await call('POST', '/api/tasks', {
  name: TASK_NAME,
  url: DESTINATION_URL,
  cron: CRON,
  body: JSON.stringify({ hello: 'from 402cron' }),
});
credentials.taskId = task.id;
save(credentials);
console.log(`task ${task.id} is live; next runs: ${JSON.stringify(task.nextRuns)}`);

// ── helpers ──

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  // Every refusal carries a stable `error` code and says what to do next.
  if (!response.ok) fail(`${method} ${path} → ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function save(data) {
  writeFileSync(new URL('./402cron-credentials.json', import.meta.url), JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
