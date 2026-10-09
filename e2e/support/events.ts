/**
 * Fixtures for MCP event scenarios: an app that emits `issue.opened`, and a receiver app whose
 * webhook checks Standard Webhooks signatures, echoes verification challenges and records what
 * arrived. The receiver gives a callback URL on the product's own origin, so deployed Cloudflare
 * needs no outside service.
 */
import { createProfile } from "./profiles.ts";
import { expect } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes, randomUUID } from "node:crypto";
import { Api, body } from "./api.ts";
import { Actors } from "./actors.ts";
import { App, Resource } from "./contracts.ts";
import { Target } from "./platform.ts";
import { appsManifest } from "./apps-release.ts";

const whsec = () => `whsec_${randomBytes(32).toString("base64")}`;
/** The receiver accepts a signature from either secret; the second is the rotated one. */
export const secrets = [whsec(), whsec()] as const;

export const receiverFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, secrets, object, string, number, query, mutation, router,
  type MutationContext, type QueryContext, type Webhook, type WebhookContext } from "apps";
const service = defineProvider({ name: "Event receiver", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
const requirements = { accounts: { service } };
const empty = object({});
const SECRETS = ${JSON.stringify(secrets)};
const decode = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
/** Standard Webhooks: v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>. */
const expected = async (secret, id, timestamp, text) => {
  const key = await crypto.subtle.importKey("raw", decode(secret.slice(6)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "v1," + encode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + "." + timestamp + "." + text)));
};
const inbox = {
  account: "service", config: empty, state: empty,
  async register() { return {}; },
  async unregister() {},
  async handle(ctx, { request }) {
    const id = request.headers.get("webhook-id") ?? "";
    const timestamp = request.headers.get("webhook-timestamp") ?? "";
    const presented = (request.headers.get("webhook-signature") ?? "").split(" ");
    const text = await request.text();
    const signedBy = [];
    for (const [index, secret] of SECRETS.entries())
      if (presented.includes(await expected(secret, id, timestamp, text))) signedBy.push(index);
    const variant = new URL(request.url).searchParams.get("variant") ?? "";
    const message = JSON.parse(text);
    const kind = message.type === "verification" ? "verification" : "event";
    let status = 200;
    if (kind === "event") {
      const next = ctx.sql.exec("SELECT seq, status FROM responses ORDER BY seq LIMIT 1").toArray()[0];
      if (next !== undefined) {
        status = next.status;
        ctx.sql.exec("DELETE FROM responses WHERE seq = ?", next.seq);
      }
    }
    ctx.sql.exec(
      "INSERT INTO deliveries (kind, variant, webhook_id, timestamp, subscription, signed_by, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      kind, variant, id, timestamp, request.headers.get("x-mcp-subscription-id") ?? "", signedBy.join(","), text, status,
    );
    if (kind === "verification")
      return Response.json({ challenge: variant === "refuse" ? "not the challenge" : message.challenge });
    return new Response(null, { status });
  },
} satisfies Webhook<WebhookContext<typeof requirements>, typeof empty, typeof empty>;
/** Answer the next event deliveries with these statuses, in order. */
const respond = mutation({ input: object({ statuses: object({ list: string() }) }) },
  async (ctx: MutationContext<typeof requirements>, { statuses }) => {
    for (const status of statuses.list.split(",").filter(Boolean))
      ctx.sql.exec("INSERT INTO responses (status) VALUES (?)", Number(status));
    return "ok";
  });
const deliveries = query({ input: empty }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec("SELECT kind, variant, webhook_id AS id, timestamp, subscription, signed_by AS signedBy, body, status FROM deliveries ORDER BY seq").toArray());
export default defineApp(requirements, { tools: router({ respond, deliveries }), webhooks: { inbox } });
`,
  },
  {
    path: "migrations/0001_deliveries.sql",
    content: `CREATE TABLE deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, variant TEXT NOT NULL,
  webhook_id TEXT NOT NULL, timestamp TEXT NOT NULL, subscription TEXT NOT NULL, signed_by TEXT NOT NULL,
  body TEXT NOT NULL, status INTEGER NOT NULL);
CREATE TABLE responses (seq INTEGER PRIMARY KEY AUTOINCREMENT, status INTEGER NOT NULL);
`,
  },
  appsManifest,
];

export const emitterFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, event, object, string, number, mutation, router, type MutationContext } from "apps";
const issueOpened = event({
  description: "An issue was opened in a repository.",
  filters: { repo: string({ minLength: 3 }) },
  payload: object({ title: string(), number: number() }),
});
const requirements = { accounts: {}, events: { "issue.opened": issueOpened } };
const open = mutation(
  { input: object({ repo: string(), title: string(), number: number(), id: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) => {
    ctx.events.emit("issue.opened", { title: input.title, number: input.number }, {
      filters: { repo: input.repo }, id: input.id,
    });
    return "emitted";
  },
);
/** An event that is not declared fails the call, and nothing it emitted before is kept. */
const broken = mutation({ input: object({ id: string() }) },
  async (ctx: MutationContext<typeof requirements>, { id }) => {
    ctx.events.emit("issue.opened", { title: "partial", number: 0 }, { filters: { repo: "acme/widgets" }, id });
    (ctx.events.emit as (name: string, data: unknown) => void)("issue.closed", {});
    return "unreachable";
  });
/** Events emitted in a transaction that rolls back are discarded with its writes. */
const rolledBack = mutation({ input: object({ id: string() }) },
  async (ctx: MutationContext<typeof requirements>, { id }) => {
    try {
      ctx.sql.transaction((tx) => {
        tx.exec("INSERT INTO opened (id) VALUES (?)", id);
        ctx.events.emit("issue.opened", { title: "rolled back", number: 0 }, { filters: { repo: "acme/widgets" }, id });
        throw new Error("Roll back");
      });
    } catch {}
    return ctx.sql.exec("SELECT count(*) AS count FROM opened WHERE id = ?", id).toArray()[0];
  });
export default defineApp(requirements, { tools: router({ open, broken, rolledBack }) });
`,
  },
  {
    path: "migrations/0001_opened.sql",
    content: "CREATE TABLE opened (id TEXT PRIMARY KEY NOT NULL);\n",
  },
  appsManifest,
];

export const Delivery = Schema.Struct({
  kind: Schema.Literals(["verification", "event"]),
  variant: Schema.String,
  id: Schema.String,
  timestamp: Schema.String,
  subscription: Schema.String,
  signedBy: Schema.String,
  body: Schema.String,
  status: Schema.Number,
});
export const Occurrence = Schema.fromJsonString(
  Schema.Struct({
    eventId: Schema.String,
    name: Schema.String,
    timestamp: Schema.String,
    data: Schema.Struct({ title: Schema.String, number: Schema.Number }),
    cursor: Schema.Null,
  }),
);
const Subscription = Schema.Struct({ callbackUrl: Schema.String, status: Schema.String });
const ProfileStatus = Schema.Struct({
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
});
export const RpcResult = Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) });
export const RpcError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optional(Schema.Unknown),
  }),
});
export const EventList = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      delivery: Schema.Array(Schema.String),
      inputSchema: Schema.Record(Schema.String, Schema.Unknown),
      payloadSchema: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});
export const Granted = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.String,
  cursor: Schema.Null,
});
export const Discovered = Schema.Struct({
  capabilities: Schema.Struct({ events: Schema.optional(Schema.Struct({})) }),
});

export const revision = "2026-07-28";
export const meta = {
  "io.modelcontextprotocol/protocolVersion": revision,
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** Deploy both apps and register the receiver's webhook. Created resources are removed at scope end. */
export const eventFixtures = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    target = yield* Target,
    http = yield* HttpClient.HttpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const suffix = randomUUID().slice(0, 8);
  const created: {
    apps: string[];
    account?: string;
    profile?: string;
    key?: string | undefined;
  } = {
    apps: [],
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (created.key)
        yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
          keyId: created.key,
        });
      if (created.profile && created.apps[0])
        yield* api.request(
          actors.owner,
          "DELETE",
          `${prefix}/apps/${created.apps[0]}/profiles/${created.profile}`,
        );
      for (const app of created.apps)
        yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`);
      if (created.account)
        yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${created.account}`);
    }).pipe(Effect.orDie),
  );
  const deploy = (name: string, files: typeof receiverFiles) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files,
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      created.apps.push(app.id);
      return app;
    });

  // The receiver's webhook is registered by profile setup and gives a public callback URL.
  const receiver = yield* deploy(`Event receiver ${suffix}`, receiverFiles);
  const profile = yield* createProfile(actors.owner, `${prefix}/apps/${receiver.id}`);
  created.profile = profile.id;
  const connection = yield* api.request(
    actors.owner,
    "POST",
    `${prefix}/apps/${receiver.id}/connections`,
    { requirement: "service", profile: profile.id },
  );
  expect(connection.status).toBe(200);
  const saved = yield* api.request(
    actors.owner,
    "POST",
    `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
    { method: "key", label: `Receiver ${suffix}`, fields: { token: "synthetic-events" } },
  );
  expect(saved.status).toBe(200);
  created.account = (yield* body(Resource, saved)).id;
  const setupDeadline = (yield* Clock.currentTimeMillis) + 30_000;
  for (;;) {
    const reconciled = yield* api.request(
      actors.owner,
      "POST",
      `${prefix}/apps/${receiver.id}/profiles/${profile.id}/reconcile`,
    );
    const status = yield* body(ProfileStatus, reconciled);
    if (status.status === "ready") break;
    expect(status.status, JSON.stringify(status)).not.toBe("failed");
    expect(yield* Clock.currentTimeMillis).toBeLessThan(setupDeadline);
    yield* Effect.sleep("200 millis");
  }
  const [hook] = yield* body(
    Schema.Array(Subscription),
    yield* api.request(
      actors.owner,
      "GET",
      `${prefix}/apps/${receiver.id}/webhooks?profile=${profile.id}`,
    ),
  );
  expect(hook?.status).toBe("active");
  const callbackUrl = hook!.callbackUrl;
  const callReceiver = (
    tool: "deliveries" | "respond",
    kind: "query" | "mutation",
    input: unknown,
  ) =>
    api.request(actors.owner, "POST", `${prefix}/apps/${receiver.id}/tools/call`, {
      profile: profile.id,
      tool,
      kind,
      input,
    });
  const deliveries = callReceiver("deliveries", "query", {}).pipe(
    Effect.flatMap((response) => body(Schema.Array(Delivery), response)),
  );
  /** Wait until the receiver holds what `ready` asks for; deliveries are asynchronous. */
  const awaitDeliveries = (
    ready: (all: ReadonlyArray<typeof Delivery.Type>) => boolean,
    seconds = 30,
  ) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + seconds * 1000;
      for (;;) {
        const all = yield* deliveries;
        if (ready(all)) return all;
        expect(yield* Clock.currentTimeMillis, JSON.stringify(all)).toBeLessThan(deadline);
        yield* Effect.sleep("300 millis");
      }
    });
  const events = (all: ReadonlyArray<typeof Delivery.Type>) =>
    all.filter((delivery) => delivery.kind === "event");

  const emitter = yield* deploy(`Issue events ${suffix}`, emitterFiles);
  const emit = (repo: string, number: number, id = randomUUID()) =>
    api
      .request(actors.owner, "POST", `${prefix}/apps/${emitter.id}/tools/call`, {
        tool: "open",
        kind: "mutation",
        input: { repo, title: `Issue ${number}`, number, id },
      })
      .pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
        ),
        Effect.as(id),
      );

  const rpcAs = (
    credential: Redacted.Redacted<string>,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(credential)),
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": revision,
          "mcp-method": method,
          "x-executor-organization": actors.organization.id,
        }),
      );
      const response = yield* http.execute(
        yield* HttpClientRequest.bodyJson(request, {
          jsonrpc: "2.0",
          id: 1,
          method,
          params: { ...params, _meta: meta },
        }),
      );
      return yield* response.json;
    }).pipe(Effect.scoped);
  const ok = <A>(schema: Schema.Decoder<A>, value: unknown) =>
    Schema.decodeUnknownEffect(RpcResult)(value).pipe(
      Effect.flatMap(({ result }) => Schema.decodeUnknownEffect(schema)(result)),
      Effect.tapError(() => Effect.sync(() => expect.fail(JSON.stringify(value)))),
    );
  const refused = (value: unknown) =>
    Schema.decodeUnknownEffect(RpcError)(value).pipe(
      Effect.map(({ error }) => error),
      Effect.tapError(() => Effect.sync(() => expect.fail(JSON.stringify(value)))),
    );
  /** A personal access token, deleted at scope end unless the scenario deletes it first. */
  const createKey = (name: string) =>
    Effect.gen(function* () {
      const key = yield* body(
        Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
        yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
      );
      yield* Effect.addFinalizer(() =>
        api
          .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
          .pipe(Effect.ignore),
      );
      return key;
    });
  return {
    prefix,
    suffix,
    receiver,
    emitter,
    callbackUrl,
    callReceiver,
    deliveries,
    awaitDeliveries,
    events,
    emit,
    rpcAs,
    ok,
    refused,
    createKey,
    name: `${emitter.slug}.issue.opened`,
  };
});
