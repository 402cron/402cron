"""A minimal 402cron destination. Standard library only.

    SECRET_402CRON=<signing secret from POST /api/destinations> python server.py

It must be reachable over public https -- put it behind your usual reverse proxy
or tunnel. PORT defaults to 3000.

Three kinds of requests arrive at the same URL, told apart by X-402cron-Event:
  verify       once, when you call POST /api/destinations/{id}/verify. Unsigned.
               Answer with the X-402cron-Challenge value as the body.
  delivery     on schedule, on retries, and when you call /run. Signed.
  task_paused  one courtesy notice when a task pauses. Signed.

402cron signs the BYTES of six fields, one per line:
  timestamp \\n deliveryId \\n attempt \\n METHOD \\n path+query \\n rawBody
The X-402cron-Event label is not signed: branch on it, trust only what the
signature covers.
"""

import hashlib
import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("SECRET_402CRON", "")
PORT = int(os.environ.get("PORT", "3000"))
MAX_AGE_SECONDS = 300  # five minutes either way: clock skew yes, replays no

# Delivery is AT LEAST ONCE: if our acknowledgement is lost, the same delivery id
# arrives again. Remember what you handled -- in a database, in production.
handled = set()
handled_lock = threading.Lock()


def signed_bytes(timestamp, delivery_id, attempt, method, path_and_query, raw_body):
    head = f"{timestamp}\n{delivery_id}\n{attempt}\n{method.upper()}\n{path_and_query}\n"
    return head.encode("utf-8") + raw_body


def verify_request(headers, method, path_and_query, raw_body, now=None):
    """Returns (delivery_id, None) when the signature holds, else (None, reason)."""
    signature = headers.get("X-402cron-Signature")
    timestamp = headers.get("X-402cron-Timestamp")
    delivery_id = headers.get("X-402cron-Delivery-Id")
    attempt = headers.get("X-402cron-Attempt")
    if not SECRET:
        return None, "no_secret_configured"
    if not (signature and timestamp and delivery_id and attempt is not None):
        return None, "missing_headers"
    try:
        age = abs((now if now is not None else time.time()) - int(timestamp))
    except ValueError:
        return None, "stale_or_bad_timestamp"
    if age > MAX_AGE_SECONDS:
        return None, "stale_or_bad_timestamp"
    digest = hmac.new(
        SECRET.encode("utf-8"),
        signed_bytes(timestamp, delivery_id, attempt, method, path_and_query, raw_body),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest("sha256=" + digest, signature):
        return None, "bad_signature"
    return delivery_id, None


def do_the_work(delivery_id, raw_body):
    # Your job goes here.
    print(f"delivery {delivery_id}: {raw_body[:200].decode('utf-8', 'replace')}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, text):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def handle_request(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(length) if length else b""
        event = self.headers.get("X-402cron-Event")

        if event == "verify":
            # Proves you control this URL. Echo the value, nothing else.
            return self.reply(200, self.headers.get("X-402cron-Challenge", ""))

        delivery_id, reason = verify_request(self.headers, self.command, self.path, raw_body)
        if reason:
            # A 4xx is a refusal: 402cron does not retry it, and 20 in a row pause the task.
            print(f"refused: {reason}", flush=True)
            return self.reply(401, reason)

        if event == "task_paused":
            notice = json.loads(raw_body or b"{}")
            print(f"task {notice.get('taskId')} paused ({notice.get('reasonCode')}): {notice.get('reason')}", flush=True)
            print(f"resume with: POST {notice.get('resume')}", flush=True)
            return self.reply(200, "ok")

        with handled_lock:
            if delivery_id in handled:
                return self.reply(200, "already handled")
            handled.add(delivery_id)

        # Answer within 2 seconds -- the timeout is for ACCEPTANCE, not for finishing.
        self.reply(202, "accepted")
        threading.Thread(target=do_the_work, args=(delivery_id, raw_body), daemon=True).start()

    # A task may use any of these methods; verification and pause notices are POST.
    do_POST = do_GET = do_PUT = do_PATCH = do_DELETE = do_HEAD = handle_request


if __name__ == "__main__":
    if not SECRET:
        print("SECRET_402CRON is not set: verification will pass, deliveries will be refused.", flush=True)
    print(f"listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
