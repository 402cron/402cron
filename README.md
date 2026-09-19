# 402cron — cron for AI agents, paid per delivery

[![402cron MCP connector](https://glama.ai/mcp/connectors/com.402cron/402cron/badges/score.svg)](https://glama.ai/mcp/connectors/com.402cron/402cron)

402cron calls your https endpoint on a cron schedule, signs every request, and retries what fails.
An agent can set it up on its own: no account, no card, no human in the loop. Payment is
[x402](https://x402.org) — USDC on Base — and the only identity is the wallet that paid.

> This repository holds documentation and runnable examples. The service runs at
> https://402cron.com; its source code is not published.

## Links

- https://402cron.com — the service
- https://402cron.com/docs — machine-readable documentation (JSON; try `?section=quickstart`)
- https://402cron.com/openapi.json — OpenAPI 3.1
- https://402cron.com/llms.txt — the service, explained for a model
- https://402cron.com/mcp — remote MCP server (streamable HTTP), listed in the official MCP Registry as `com.402cron/402cron`
- https://402cron.com/.well-known/agent-card.json — A2A agent card
- https://402cron.com/api/pricing — the tariff, machine-readable
- https://402cron.com/terms — terms · abuse@402cron.com

## Further reading

- [Nobody complains: 28 silent failures of a paid API for AI agents](https://402cron.com/blog/silent-failures-paid-agent-api): x402 payment headers, agent catalogs, A2A cards and calling out from Cloudflare Workers, each with the cause, the fix and the check that catches it. Useful if you are building your own paid API for agents.

## Pricing

| Pack | Price | Deliveries | Per delivery |
|---|---|---|---|
| `trial` | $0.02 | 20 | $0.001 |
| `starter` | $2 | 4,000 | $0.0005 |
| `month` | $25 | 50,000 | $0.0005 |

The balance counts deliveries, not money, and never expires. Each delivery **attempt** uses one
credit, so a failing delivery costs at most three. Current prices: https://402cron.com/api/pricing.

## How it works

1. **Buy.** `GET https://402cron.com/buy/trial` answers `402` with the price in the
   `PAYMENT-REQUIRED` header. Pay with any x402 client. The receipt carries your management
   token, shown once.
2. **Register.** `POST /api/destinations` with `{"url": "https://your.host/hook"}` returns the
   destination id and its signing secret, shown once.
3. **Verify.** Call `POST /api/destinations/{id}/verify`. We POST a challenge to your URL and your
   endpoint echoes it back. The permission then covers that path and everything below it.
4. **Schedule.** `POST /api/tasks` with `{"name", "url", "cron", "body"}`. The response shows the
   next three runs.

Management calls take `Authorization: Bearer <token>`. Lost the token? Buy again from the same
wallet with `?rotate=1`; the old token stops working.

## What your endpoint receives

Three kinds of requests arrive at the same URL. `X-402cron-Event` tells them apart:

| `X-402cron-Event` | When | Signed | Your endpoint should |
|---|---|---|---|
| `verify` | once, when you call `/verify` | no | answer with the `X-402cron-Challenge` value as the body, within 5 s |
| `delivery` | on schedule, on retries, and when you call `/run` | yes | check the signature and answer `2xx` within 2 s |
| `task_paused` | once, when a task pauses | yes | read `reasonCode`, fix the cause, `POST` the `resume` URL |

The signature is `X-402cron-Signature: sha256=<hex>`, an HMAC-SHA256 keyed with your signing
secret over the bytes of:

```
{X-402cron-Timestamp}\n{X-402cron-Delivery-Id}\n{X-402cron-Attempt}\n{METHOD}\n{path+query}\n{raw body}
```

The event label is not signed: branch on it, but trust what the signature covers. Delivery is
**at least once** — the same `X-402cron-Delivery-Id` can arrive twice, so treat a repeat as
already handled. Deliveries also carry `X-402cron-Task-Id` and `X-402cron-Deliveries-Left`.

## Retries and pausing

- A timeout or an unreachable host is retried: up to 3 attempts, 60 s and 120 s apart.
- A `4xx` or `5xx` is your server's answer, so it is not retried.
- 3 failed attempts, 20 refusals in a row, or 10 server errors in a row pause the task. You get one
  `task_paused` notice; resuming is one call.

## Limits

- `cron`: 5 fields, always UTC, one minute at the finest. Names (`MON-FRI`, `JAN`) and macros
  (`@daily`, `@hourly`, …) work; anything unsupported is refused with a code that says why.
- Destinations must be `https://`.
- Body up to 64 KB, custom headers up to 8 KB.

All limits: https://402cron.com/docs?section=limits

## Examples

| Folder | What it is | Run |
|---|---|---|
| [`receiver/node`](receiver/node) | a destination endpoint, no dependencies | `SECRET_402CRON=… node server.mjs` |
| [`receiver/python`](receiver/python) | the same, standard library only | `SECRET_402CRON=… python server.py` |
| [`client`](client) | buy a trial with x402, register, verify, schedule | `npm install`, then `DRY_RUN=1 node buy-and-schedule.mjs` |

Both receivers answer the challenge, verify signatures, drop duplicate deliveries and log pause
notices. The client reads the price from the `PAYMENT-REQUIRED` header like any standard x402
client, caps what it may spend (`MAX_USD`, default `$0.05`), and with `DRY_RUN=1` signs without
paying anything. On Windows PowerShell, set variables with `$env:SECRET_402CRON="…"` first.

## Use it from an MCP client

Claude Code:

```
claude mcp add --transport http 402cron https://402cron.com/mcp --header "Authorization: Bearer <token>"
```

Other clients: add a remote (streamable HTTP) server at `https://402cron.com/mcp` with the same
header. `get_pricing`, `get_docs` and `get_service_status` work without a token. There is no
purchase tool on purpose: pay over plain HTTP, because a signed payment should not travel through a
model's context.

## Guarantee

We guarantee that we tried to deliver your task — not what someone else's server does with it.
Full terms: https://402cron.com/terms

## License

The examples in this repository are MIT-licensed — see [LICENSE](LICENSE).
