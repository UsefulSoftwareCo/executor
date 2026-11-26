---
title: MCP events
description: "Subscribe to app events from an MCP client over webhook delivery using events/list, events/subscribe, and events/unsubscribe."
---

Executor implements the draft `2026-07-28` MCP Events extension (`events/list`, `events/subscribe`, and `events/unsubscribe`) so an MCP client can receive push notifications when an app emits a declared event. Clients subscribe with a webhook callback URL and a Standard Webhooks signing secret (`whsec_...`), answer a verification challenge when Executor sends one, and receive signed HTTP POST deliveries for matching events.

- **Available on:** Local, Self-host, and Cloud (shipped in `2.0.0-beta.79`).
- **Prerequisites:**
  - Support for the draft **`2026-07-28`** MCP protocol revision (ordinary `2025-11-25` initialize responses do not advertise events). Send `MCP-Protocol-Version: 2026-07-28`, `MCP-Method: <method>`, `Accept: application/json, text/event-stream`, `Content-Type: application/json`, and the protocol `_meta` block on every `events/*` request.
  - An authorized MCP connection (OAuth grant, personal access token, or local server API key) with access to an app that declares events.
  - Use an HTTPS callback allowed by Executor’s destination policy. Local loopback HTTP can be available when the policy allows it. Verify each signed POST and echo a valid verification challenge in a successful JSON response.
- **Main JSON-RPC method:** `events/subscribe` against `/mcp`.

You'll know it worked when your webhook receiver verifies and echoes any `verification` challenge with HTTP `2xx`, `events/subscribe` returns a subscription `id` and `refreshBefore`, and emitting an app event delivers a signed JSON payload to your callback URL.

## How subscriptions work

Calling `events/list` on `/mcp` returns one shared event definition named `executor.app_event` (title `"Executor app events"`, delivery `["webhook"]`). You can subscribe in two ways:

1. **Broad or filtered via `executor.app_event`:** Pass `name: "executor.app_event"` with optional `arguments`:
   - `{}` subscribes to all events from every app your connection can access.
   - `{ app: "<app-slug>" }` subscribes to all events declared by that app.
   - `{ app: "<app-slug>", event: "<event-name>", ...filters }` subscribes to one event with its declared filter fields.
   - Delivered payloads wrap the event as `{ app, event, data }` inside the envelope's `data`.
2. **Direct app event name:** Pass `name: "<app-slug>.<event-name>"` with optional declared filter fields in `arguments` (for example `{ repo: "acme/widgets" }`). Delivered payloads place the event's fields directly in `data`.

If you use a [scoped connection](/docs/mcp/scoped-connections), enable either **All events** or the specific event names under that app on the **Connections** page. An exact event subscription returns `-32012` for a disallowed event, or `-32011` if the app cannot be resolved in your visible app list. Broad subscriptions are accepted and omit unauthorized occurrences at delivery.

## Subscribing and verifying a webhook

### Cloud and Self-host

1. Generate a Standard Webhooks signing secret: `whsec_` followed by base64-encoded random bytes (24 to 64 raw bytes).
2. Expose an HTTPS callback URL (no userinfo or URL fragment; redirects are not followed; Self-host may also accept callbacks on its own loopback address when `EXECUTOR_URL_ALLOW_LOOPBACK_HTTP=true`). Verify signatures and timestamp freshness before echoing `{"challenge":"<token>"}` with HTTP `200` for `{"type":"verification","challenge":"<token>"}`.
3. POST `events/subscribe` to `https://mcp.executor.sh/mcp` (Cloud) or `<your origin>/mcp` (Self-host) with the `2026-07-28` headers, `_meta`, `delivery: { mode: "webhook", url, secret }`, and an optional positive integer `ttlMs` (clamped to 60 seconds through 7 days; omit for 24 hours or send `null` for 7 days).
4. Renew before the returned `refreshBefore` (rather than computing expiry from your requested `ttlMs`) by calling `events/subscribe` again with the same credential, selector, arguments, and URL, or stop deliveries with `events/unsubscribe`.

You'll know it worked when `events/subscribe` returns `{ id, refreshBefore, ... }` and your receiver gets signed event deliveries. When a fresh verification is needed, the receiver first records a verified `msg_verification_<uuid>` request.

### Local

The same JSON-RPC flow runs against `http://127.0.0.1:4312/mcp` (or your server's reported port) using either a local OAuth bearer token or the local server API key, and your receiver may listen on loopback `http://127.0.0.1:<port>/...` while loopback HTTP is enabled. This is the Local default. On Self-host, you can configure it with `EXECUTOR_URL_ALLOW_LOOPBACK_HTTP`.

You'll know it worked when triggering the emitting app tool delivers a signed POST to your local receiver with `x-mcp-subscription-id` matching the subscription ID.

## Verifying signatures, rotation, and authorization

Every verification request and event delivery includes four headers:

- `webhook-id`: The verification message ID (`msg_verification_<uuid>`) or, for event deliveries, the event ID, which stays the same across retries.
- `webhook-timestamp`: Unix timestamp in seconds.
- `webhook-signature`: Space-separated Standard Webhooks signatures in format `v1,<base64 HMAC-SHA256(secretBytes, "${webhookId}.${webhookTimestamp}.${rawBody}")>`.
- `x-mcp-subscription-id`: The subscription ID returned by `events/subscribe`.

Verify Standard Webhooks signatures against the raw request bytes with a constant-time verifier (`crypto.timingSafeEqual`) and a timestamp tolerance (for example, 5 minutes). Reject invalid or stale requests before echoing a challenge or processing an event. Acknowledge a retry after processing that event for the intended subscription. If a receiver handles several subscriptions or event types, keep its deduplication state scoped to the subscription and source event.

- **Verification reuse:** By default, Executor can reuse a verification less than 24 hours old from a subscription marked active for the same callback URL and authorization identity, so a successful subscribe does not always send a new challenge. That identity is the OAuth grant, the hosted PAT in its selected organization and approval mode, or the Local administrator for API-key requests.
- **Secret rotation:** To rotate a subscription secret, resubscribe with the same credential, selector, arguments, and URL and a new secret. Executor sends a fresh challenge signed with the new and previous secrets. Once verification succeeds and the rotation is saved, deliveries use both secrets for the rest of the overlap. The overlap defaults to five minutes from the start of the rotation attempt. Configure the receiver to accept both secrets during the overlap.
- **Per-delivery authorization:** For each delivery attempt, Executor checks that the subscription is active and applies the target's current authorization. Hosted checks the grant or token, organization and app access, event permission, and access to recorded accounts (scoped policies can further restrict which account IDs qualify). Local OAuth checks the grant and its scope. Local API-key subscriptions use the installation's administrative access.

## Example

Run a complete Local walkthrough using `executor@2.0.0-beta.79` with no hosted target selected or remembered.

### 1. Create and deploy a synthetic emitter app

```bash
mkdir -p ./tracker
FRAMEWORK_VERSION=$(executor apps framework | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.version);')

cat <<EOF > ./tracker/package.json
{
  "name": "tracker",
  "private": true,
  "dependencies": {
    "apps": "${FRAMEWORK_VERSION}"
  }
}
EOF

cat <<'EOF' > ./tracker/index.ts
import { defineApp, event, mutation, number, object, router, string, type MutationContext } from "apps";

const issueOpened = event({
  description: "An issue was opened in a repository.",
  filters: { repo: string({ minLength: 3 }) },
  payload: object({ title: string(), number: number() }),
});

const requirements = { events: { "issue.opened": issueOpened } };

const open = mutation(
  { input: object({ repo: string(), title: string(), number: number() }) },
  async (ctx: MutationContext<typeof requirements>, input) => {
    ctx.events.emit(
      "issue.opened",
      { title: input.title, number: input.number },
      { filters: { repo: input.repo } },
    );
    return { emitted: true };
  },
);

export default defineApp(requirements, { tools: router({ open }) });
EOF

APP_ID=$(executor apps create --name "tracker" --files ./tracker | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.id);')
executor apps deploy --app "$APP_ID" --files ./tracker --message "Initial tracker emitter"
```

### 2. Start a verifying webhook receiver

The Local example handles one event subscription and keeps its deduplication state in memory. Save `receiver.mjs`, which verifies signatures with `timingSafeEqual`, checks a 5-minute timestamp window, rejects invalid or stale requests before parsing or echoing, and supports comma-separated secrets during rotation:

```js
// receiver.mjs
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const secrets = (process.env.WEBHOOK_SECRETS ?? "").split(",").filter(Boolean);
const toleranceSec = 300;
/** @type {Set<string>} */
const processed = new Set();

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {Buffer} rawBody
 */
function verifySignature(headers, rawBody) {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sigHeader = headers["webhook-signature"];
  if (typeof id !== "string" || typeof ts !== "string" || typeof sigHeader !== "string") return false;
  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > toleranceSec) {
    return false;
  }
  const presented = sigHeader.split(" ").filter((s) => s.startsWith("v1,"));
  for (const secret of secrets) {
    if (!secret.startsWith("whsec_")) continue;
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const expected = Buffer.from(
      "v1," + createHmac("sha256", key).update(`${id}.${ts}.`).update(rawBody).digest("base64"),
    );
    for (const candidate of presented) {
      const buf = Buffer.from(candidate);
      if (buf.length === expected.length && timingSafeEqual(buf, expected)) return true;
    }
  }
  return false;
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/hook") {
    res.writeHead(404).end();
    return;
  }
  /** @type {Buffer[]} */
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks);
    if (!verifySignature(req.headers, rawBody)) {
      res.writeHead(401).end();
      return;
    }
    let message;
    try {
      message = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (message.type === "verification") {
      console.log(JSON.stringify({ kind: "verification", id: req.headers["webhook-id"] }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: message.challenge }));
      return;
    }
    const webhookId = req.headers["webhook-id"];
    if (typeof webhookId === "string" && !processed.has(webhookId)) {
      processed.add(webhookId);
      console.log(JSON.stringify({ kind: "event", id: webhookId, subscription: req.headers["x-mcp-subscription-id"], body: message }));
    }
    res.writeHead(200).end();
  });
});

const port = Number(process.env.HOOK_PORT ?? 45123);
server.listen(port, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${port}/hook`);
});
```

Start the receiver with a generated secret (keep the secret in an environment variable rather than printing it):

```bash
WEBHOOK_SECRET="whsec_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
HOOK_URL="http://127.0.0.1:45123/hook"
WEBHOOK_SECRETS="$WEBHOOK_SECRET" HOOK_PORT=45123 node receiver.mjs > receiver.log 2>&1 &
RECEIVER_PID=$!
```

Wait for the listening message in `receiver.log`.

### 3. Subscribe over streamable HTTP (`2026-07-28`)

Set `MCP_TOKEN` to your Local server API key or a Local OAuth bearer token. If using the key, get it from your configured key source (see [Local CLI](/docs/run/cli)). Keep the token out of command output. If you changed the Local port, set `MCP_URL` to the reported URL ending in `/mcp`. The command checks the HTTP status and the JSON-RPC result. Confirm it prints `id` and `refreshBefore` before emitting:

```bash
MCP_URL="${MCP_URL:-http://127.0.0.1:4312/mcp}"
: "${MCP_TOKEN:?Set MCP_TOKEN to your Local API key or OAuth bearer token}"

curl --fail-with-body -sS -X POST "$MCP_URL" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "MCP-Method: events/subscribe" \
  -o subscription.json \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 1,
    \"method\": \"events/subscribe\",
    \"params\": {
      \"name\": \"tracker.issue.opened\",
      \"arguments\": { \"repo\": \"acme/widgets\" },
      \"delivery\": {
        \"mode\": \"webhook\",
        \"url\": \"${HOOK_URL}\",
        \"secret\": \"${WEBHOOK_SECRET}\"
      },
      \"_meta\": {
        \"io.modelcontextprotocol/protocolVersion\": \"2026-07-28\",
        \"io.modelcontextprotocol/clientCapabilities\": {}
      }
    }
  }" &&
  node -e '
    const { error, result } = require("./subscription.json");
    if (error || !result?.id || !result?.refreshBefore) {
      throw new Error("Subscription failed. Check subscription.json for the JSON-RPC response.");
    }
    console.log({ id: result.id, refreshBefore: result.refreshBefore });
  '
```

### 4. Emit an event and check receipt

```bash
executor call tools.tracker.open --input '{"repo":"acme/widgets","title":"Issue 1","number":1}'
cat receiver.log
```

Delivery may arrive after the emit command finishes. Check `receiver.log` again until it shows an `event` entry for the subscription ID (and a verified `verification` entry if Executor sent a fresh challenge) before unsubscribing. The event body has this shape:

```json
{
  "eventId": "4cda004a-36b3-4698-b5ca-c11e0c3010a6",
  "name": "tracker.issue.opened",
  "timestamp": "2026-11-26T12:00:00.000Z",
  "data": { "title": "Issue 1", "number": 1 },
  "cursor": null
}
```

### 5. Unsubscribe

Send `events/unsubscribe` with the `2026-07-28` headers, matching `_meta`, and the same `name`, `arguments`, and `delivery` (`mode` and `url`). Stop the receiver once the JSON-RPC response confirms completion:

```bash
curl --fail-with-body -sS -X POST "$MCP_URL" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "MCP-Method: events/unsubscribe" \
  -o unsubscribe.json \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 2,
    \"method\": \"events/unsubscribe\",
    \"params\": {
      \"name\": \"tracker.issue.opened\",
      \"arguments\": { \"repo\": \"acme/widgets\" },
      \"delivery\": { \"mode\": \"webhook\", \"url\": \"${HOOK_URL}\" },
      \"_meta\": {
        \"io.modelcontextprotocol/protocolVersion\": \"2026-07-28\",
        \"io.modelcontextprotocol/clientCapabilities\": {}
      }
    }
  }" &&
  node -e '
    const { error, result } = require("./unsubscribe.json");
    if (error || result?.resultType !== "complete") {
      throw new Error("Unsubscribe failed. Check unsubscribe.json for the JSON-RPC response.");
    }
    console.log("Unsubscribed");
  ' &&
  kill "$RECEIVER_PID"
```

## Limits

| Limit | Value |
| --- | --- |
| Delivery mode | `webhook` only (no cursor replay; requesting another mode or non-null cursor returns `-32014`) |
| Signing secret | `whsec_` prefix + base64 of 24–64 raw bytes |
| Subscription TTL | Positive integer clamped to 60 seconds–7 days; omit for 24 hours; `ttlMs: null` requests 7 days |
| Delivery retries | Up to 14 attempts (5 s exponential backoff capped at 1 hour, ~4 h 25 min scheduled delays) |
| Per-attempt timeout | 10 seconds |
| Event retention | 3 days |
| Payload size | 250 KiB max emitted JSON data; 256 KiB max delivery body; 100 emits per invocation |
| Permanent stop codes | HTTP `410` or `413` from the receiver stops retries for that delivery |

Error codes returned by `events/*`:

- `-32602`: Invalid parameters (nonpositive TTL, invalid TTL type, missing `_meta`, bad secret format, invalid URL, or invalid filters).
- `-32011`: App or event not found (or app not visible to this connection).
- `-32012`: Connection is not authorized for that event.
- `-32014`: Unsupported delivery mode, cursor replay requested, or existing subscription filters no longer match the event schema on renewal.
- `-32015`: Callback verification failed (`data.reason` describes why).

## Related

- [The MCP endpoint](/docs/mcp)
- [Scoped connections](/docs/mcp/scoped-connections)
- [Apps](/docs/apps)
- [Author an app](/docs/author-an-app)
