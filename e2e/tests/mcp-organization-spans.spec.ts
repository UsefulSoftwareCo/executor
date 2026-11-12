/**
 * Hosted MCP spans name the organization they run for and the caller by their opaque IDs, so one
 * organization's failures can be told apart from an outage and the users they reach counted.
 * Every MCP operation span records both from its start: the tools (`mcp.search`, `mcp.describe`,
 * `mcp.call`, `mcp.execute`, `mcp.resume`, `mcp.skills`), the event methods (`mcp.events.*`), the
 * catalog reads under them and the tool calls they make (`mcp.tool.call`, `mcp.tool.resume`),
 * failed ones included. A tool call's bearer recheck names them from its start too, so a recheck
 * refused before its statement answers still does.
 *
 * A bearer check names only the caller's own organization, with the caller (the grant's or the
 * key's user), once it knows the organization is theirs. A grant's organization is known when its
 * statement answers, so a refusal after that, such as a grant used at an organization URL that
 * names none, keeps both. An unpinned key's is known only once its membership holds, so a key
 * refused for an organization its user does not belong to names no organization, on any span; a
 * pinned key refused for another organization names its own while its user is a member there; it
 * is deleted with that membership, so once the user has left it names none. A refused request never names the
 * organization it asked for, so it cannot count against that organization's failures. Its request
 * span still names the key's verified user and why it was refused (`auth.failure.reason`).
 *
 * On Cloud the gateway's forward of a request it authenticated names both even when the session
 * object never answers; a request routed by its session id learns only the organization, from the
 * object's answer, so one the object never answers names neither: the gateway never guesses.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Organization, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry, type DeliveredSpan } from "../support/evidence.ts";
import {
  EventList,
  Granted,
  RpcError,
  RpcResult,
  eventFixtures,
  secrets,
} from "../support/events.ts";
import { holdTools, untilHeld } from "../support/held-call.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";

type Span = DeliveredSpan;

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const organizationId = "executor.organization.id";
const userId = "executor.user.id";

const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const SessionIdentity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
});

const appSource = `import { defineApp, query, mutation, object, string, boolean, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({
  tools: router({
    echo: query({ description: "Echo text", input: object({ text: string() }) }, async (_ctx, { text }) => ({ text })),
    approved: mutation({ description: "Echo text once approved", input: object({ text: string() }), approval: always() }, async (_ctx, { text }) => ({ text })),
    ${holdTools}
  }),
}));`;

/** The operation spans the tools' calls record; each must name the organization and the caller. */
const operations = [
  "mcp.search",
  "mcp.describe",
  "mcp.call",
  "mcp.execute",
  "mcp.resume",
  "mcp.skills",
  "mcp.tool.call",
  "mcp.tool.resume",
  "mcp.catalog",
  "mcp.discovery.apps",
  "mcp.discovery.accounts",
  "mcp.discovery.tools",
];
/** Operation spans a path records only sometimes; any that is delivered must name it too. */
const occasional = /^mcp\.(?:discovery\.|search\.discovery$|describe\.discovery$)/u;

/** The stateful revision, whose sessions carry an `Mcp-Session-Id`. */
const stateful = "2025-06-18";
/** The stateless revision names itself in every request and has no session. */
const stateless = "2026-07-28";
const statelessMeta = {
  "io.modelcontextprotocol/protocolVersion": stateless,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const initialize = {
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: stateful,
    capabilities: {},
    clientInfo: { name: "organization-spans", version: "1" },
  },
};

const named = (spans: ReadonlyArray<Span>, name: string) =>
  spans.filter((span) => span.operationName === name);
/**
 * A refused request's bearer check and its request span have both reached the collector. A Cloud
 * isolate exports every span that has ended with whichever request flushes first, so a concurrent
 * request can deliver the check before the request span it runs under has ended.
 */
const checkedAndAnswered = (spans: ReadonlyArray<Span>) =>
  named(spans, "auth.authenticate").length > 0 && named(spans, "http.server POST").length > 0;
const exception = (span: Span) =>
  span.events.find((event) => event.name === "exception")?.attributes["exception.type"];

/** Shared by both scenarios: keys, one raw MCP POST under its own trace, and a trace's spans. */
const helpers = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence,
    telemetry = yield* Telemetry,
    target = yield* Target,
    http = yield* HttpClient.HttpClient;
  /** An API key of `actor` (the owner by default), pinned to `pinned` when it names one. */
  const createKey = (
    name: string,
    options: { readonly actor?: Session; readonly pinned?: string } = {},
  ) =>
    Effect.gen(function* () {
      const actor = options.actor ?? actors.owner;
      const created = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
        name,
        ...(options.pinned === undefined ? {} : { metadata: { organization: options.pinned } }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const key = yield* body(Key, created);
      yield* Effect.addFinalizer(() =>
        api
          .request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id })
          .pipe(Effect.ignore),
      );
      return key;
    });
  const post = (input: {
    readonly credential: Redacted.Redacted<string>;
    readonly path?: string;
    readonly session?: string | undefined;
    readonly protocol?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly message: Readonly<Record<string, unknown>>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const traceId = randomBytes(16).toString("hex");
        const request = HttpClientRequest.post(
          `${target.metadata.origin}${input.path ?? "/mcp"}`,
        ).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${Redacted.value(input.credential)}`,
            "x-executor-organization": actors.organization.id,
            traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
            ...(input.session === undefined ? {} : { "mcp-session-id": input.session }),
            ...(input.protocol === undefined ? {} : { "mcp-protocol-version": input.protocol }),
            ...input.headers,
          }),
        );
        const response = yield* http.execute(
          yield* HttpClientRequest.bodyJson(request, { jsonrpc: "2.0", ...input.message }),
        );
        const text = yield* response.text;
        return { traceId, status: response.status, headers: response.headers, text };
      }),
    ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
  /** A trace's delivered spans once `ready` holds for them. */
  const spans = (traceId: string, ready: (spans: ReadonlyArray<Span>) => boolean) =>
    telemetry
      .settled(traceId, ready)
      .pipe(Effect.tap((all) => evidence.json(`trace-${traceId}.json`, all)));
  /** The Better Auth user ID and email of `actor`'s session. */
  const identity = (actor: Session) =>
    api.request(actor, "GET", "/api/auth/get-session").pipe(
      Effect.flatMap((response) => body(SessionIdentity, response)),
      Effect.map(({ user }) => user),
    );
  return { createKey, identity, post, spans };
});

layer(HostedLive, { excludeTestServices: true })("MCP organization spans", (it) => {
  it.effect(
    scenarios.mcpOrganizationSpans.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            oauth = yield* McpOAuth,
            mcp = yield* McpClient,
            target = yield* Target;
          const { createKey, identity, post, spans } = yield* helpers;
          const organization = actors.organization.id;
          // Every key and grant below is the owner's unless it names another actor.
          const owner = (yield* identity(actors.owner)).id;
          const prefix = `/api/organizations/${organization}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Organization spans ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: appSource }, appsManifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed),
            path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.ignore),
          );
          const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
          /** The delivered spans of every MCP request since `before`, once `ready` holds for them. */
          // The request list is read again on each attempt: the MCP client records a request when
          // its response starts, and sends some, such as notifications, beside the calls.
          const deliveredSince = (before: number, ready: (spans: ReadonlyArray<Span>) => boolean) =>
            telemetry.settled(
              evidence.requests.pipe(
                Effect.map((requests) =>
                  requests
                    .slice(before)
                    .filter((request) => request.path === "/mcp")
                    .map((request) => request.traceId),
                ),
              ),
              ready,
            );

          const key = yield* createKey("Organization spans");
          const client = yield* mcp.connect(key.key, "organization-spans", { organization });

          yield* evidence.step(
            "Each MCP operation span and the catalog reads under it name the organization and the caller",
            Effect.gen(function* () {
              const before = (yield* evidence.requests).length;
              const callTool = (label: string, name: string, args: Record<string, unknown>) =>
                client.use(label, (client, signal) =>
                  client.callTool({ name, arguments: args }, undefined, { signal }),
                );
              yield* callTool("Search", "search", { query: "echo" });
              yield* callTool("Describe", "describe", { paths: [tool("echo")] });
              const called = yield* callTool("Call", "call", {
                calls: { path: tool("echo"), input: { text: "called" } },
              });
              expect(JSON.stringify(called.structuredContent)).toContain("called");
              const executed = yield* callTool("Execute", "execute", {
                code: `return (await ${tool("echo")}({ text: "executed" })).text;`,
              });
              expect(JSON.stringify(executed.structuredContent)).toContain("executed");
              yield* callTool("Execute a program that fails", "execute", {
                code: `throw new Error("A synthetic program failure");`,
              });
              yield* callTool("List skills", "skills", {});
              // No app has this slug, so the read fails before it rechecks the grant, which would
              // name the organization itself.
              const missingSkill = yield* callTool("Read a skill of a missing app", "skills", {
                app: `missing-${randomUUID().slice(0, 8)}`,
                name: "missing-skill",
              });
              expect(missingSkill.isError, "The skill read fails").toBe(true);
              // The approved call runs when the answer arrives, as `mcp.tool.resume`.
              const paused = yield* callTool("Execute a call that needs approval", "execute", {
                code: `return (await ${tool("approved")}({ text: "approved" })).text;`,
              });
              const { requestId } = yield* Schema.decodeUnknownEffect(Pending)(
                paused.structuredContent,
              );
              const resumed = yield* callTool("Approve the call and resume", "resume", {
                requestId,
                response: { action: "accept" },
              });
              expect(JSON.stringify(resumed.structuredContent)).toContain("approved");
              const delivered = yield* deliveredSince(
                before,
                (all) =>
                  operations.every((name) => named(all, name).length > 0) &&
                  named(all, "mcp.execute").length === 3 &&
                  named(all, "mcp.skills").length === 2,
              );
              const recorded = delivered.filter(
                (span) =>
                  operations.includes(span.operationName) || occasional.test(span.operationName),
              );
              yield* evidence.json(
                "operation-spans.json",
                recorded.map((span) => ({ name: span.operationName, tags: span.tags })),
              );
              expect(
                recorded
                  .filter(
                    (span) =>
                      span.tags[organizationId] !== organization || span.tags[userId] !== owner,
                  )
                  .map((span) => [
                    span.operationName,
                    span.tags[organizationId],
                    span.tags[userId],
                  ]),
                "Every MCP operation span names the organization and the key's user",
              ).toEqual([]);
              expect(
                named(delivered, "mcp.execute")
                  .map((span) => span.tags["executor.outcome"])
                  .sort(),
                "The failed program's span is among them",
              ).toEqual(["completed", "failed", "pending"]);
              expect(
                named(delivered, "mcp.skills")
                  .map((span) => [span.tags["executor.skill.operation"], span.status])
                  .sort(),
                "So is the failed skill read's",
              ).toEqual([
                ["list", "ok"],
                ["read", "error"],
              ]);
              expect(
                named(delivered, "mcp.tool.resume").map((span) => span.tags["executor.tool.name"]),
                "The approved call ran as a resume",
              ).toEqual(["approved"]);
            }),
          );

          yield* evidence.step(
            "Each event method's span names the organization and the caller, a refused subscription included",
            Effect.gen(function* () {
              const { callbackUrl, name } = yield* eventFixtures;
              // Events are a stateless-revision extension, sent as a client such as ChatGPT sends them.
              const rpc = (method: string, params: Readonly<Record<string, unknown>>) =>
                post({
                  credential: key.key,
                  protocol: stateless,
                  headers: { "mcp-method": method },
                  message: { id: 1, method, params: { ...params, _meta: statelessMeta } },
                });
              const answered = <A>(schema: Schema.Decoder<A>, text: string) =>
                Schema.decodeUnknownEffect(Schema.fromJsonString(RpcResult))(text).pipe(
                  Effect.flatMap(({ result }) => Schema.decodeUnknownEffect(schema)(result)),
                );
              const delivery = { mode: "webhook", url: callbackUrl };
              const filters = { repo: "acme/widgets" };
              const listed = yield* rpc("events/list", {});
              expect(
                (yield* answered(EventList, listed.text)).events.map((event) => event.name),
              ).toContain(name);
              const subscribed = yield* rpc("events/subscribe", {
                name,
                arguments: filters,
                delivery: { ...delivery, secret: secrets[0] },
                ttlMs: 60 * 60_000,
              });
              yield* answered(Granted, subscribed.text);
              // No app has this slug, so the subscription is refused before it rechecks the grant,
              // which would name the organization itself.
              const refused = yield* rpc("events/subscribe", {
                name: `missing-${randomUUID().slice(0, 8)}.issue.opened`,
                arguments: filters,
                delivery: { ...delivery, secret: secrets[0] },
              });
              expect(
                (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RpcError))(refused.text))
                  .error.code,
                "No app has such an event",
              ).toBe(-32011);
              const unsubscribed = yield* rpc("events/unsubscribe", {
                name,
                arguments: filters,
                delivery,
              });
              yield* answered(Schema.Struct({}), unsubscribed.text);
              const recorded = yield* Effect.forEach(
                [listed, subscribed, refused, unsubscribed],
                ({ traceId }) =>
                  spans(traceId, (all) =>
                    all.some((span) => span.operationName.startsWith("mcp.events.")),
                  ).pipe(
                    Effect.map((all) =>
                      all
                        .filter((span) => span.operationName.startsWith("mcp.events."))
                        .map((span) => [
                          span.operationName,
                          span.status,
                          span.tags[organizationId],
                          span.tags[userId],
                        ]),
                    ),
                  ),
              );
              expect(recorded, "Each method's span names the organization and the caller").toEqual([
                [["mcp.events.list", "ok", organization, owner]],
                [["mcp.events.subscribe", "ok", organization, owner]],
                [["mcp.events.subscribe", "error", organization, owner]],
                [["mcp.events.unsubscribe", "ok", organization, owner]],
              ]);
            }),
          );

          yield* evidence.step(
            "A tool call's recheck refused before its statement answers names the organization and the caller",
            Effect.gen(function* () {
              // Its own key, revoked while its program is held between two calls: the next call's
              // recheck finds no key, so it fails before it reads any organization from a row.
              const held = yield* createKey("Organization spans, revoked while held");
              const heldClient = yield* mcp.connect(held.key, "organization-spans-held", {
                organization,
              });
              const before = (yield* evidence.requests).length;
              const run = yield* heldClient
                .use("Execute a program held between two calls", (client, signal) =>
                  client.callTool(
                    {
                      name: "execute",
                      arguments: {
                        code: `await ${tool("hold")}({});
try { return await ${tool("echo")}({ text: "after" }); } catch { return "refused"; }`,
                      },
                    },
                    undefined,
                    { signal },
                  ),
                )
                .pipe(Effect.forkChild);
              const call = (name: string, kind: "query" | "mutation") =>
                api
                  .request(actors.owner, "POST", `${path}/tools/call`, {
                    tool: name,
                    kind,
                    input: {},
                  })
                  .pipe(
                    Effect.tap((response) =>
                      Effect.sync(() =>
                        expect(response.status, JSON.stringify(response.body)).toBe(200),
                      ),
                    ),
                  );
              yield* untilHeld(
                call("holding", "query").pipe(
                  Effect.flatMap((response) => body(Schema.Boolean, response)),
                ),
              );
              const revoked = yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
                keyId: held.id,
              });
              expect(revoked.status).toBe(200);
              yield* call("release", "mutation");
              const result = yield* Fiber.join(run);
              expect(JSON.stringify(result.structuredContent)).toContain("refused");
              const delivered = yield* deliveredSince(
                before,
                (all) =>
                  named(all, "auth.authenticate").some((span) => span.status === "error") &&
                  named(all, "mcp.tool.call").length === 2,
              );
              const checks = named(delivered, "auth.authenticate");
              yield* evidence.json(
                "held-checks.json",
                checks.map((span) => ({ status: span.status, tags: span.tags })),
              );
              expect(
                named(delivered, "mcp.tool.call")
                  .map((span) => [
                    span.tags["executor.tool.name"],
                    span.status,
                    span.tags[organizationId],
                    span.tags[userId],
                  ])
                  .sort(),
                "Each of the program's tool calls names the organization and the caller, the refused one included",
              ).toEqual([
                ["echo", "error", organization, owner],
                ["hold", "ok", organization, owner],
              ]);
              expect(
                checks
                  .filter((span) => span.status === "error")
                  .map((span) => [exception(span), span.tags[organizationId], span.tags[userId]]),
                "The refused recheck names the organization and the user it was checking",
              ).toEqual([["McpUnauthorized", organization, owner]]);
              expect(
                checks.map((span) => [span.tags[organizationId], span.tags[userId]]),
                "So do the request's own check and the rechecks that passed",
              ).toEqual(checks.map(() => [organization, owner]));
            }),
          );

          yield* browser.login(actors.owner);
          const grant = yield* evidence.step(
            "Authorize an MCP grant in the browser",
            oauth.authorize,
          );
          yield* evidence.step(
            "A bearer check refused after it resolves the organization names it and the grant's user",
            Effect.gen(function* () {
              // The grant resolves its organization; the URL then names no organization at all.
              const refused = yield* post({
                credential: Redacted.make(Redacted.value(grant.tokens).access_token),
                path: `/org/missing-${randomUUID().slice(0, 8)}/mcp`,
                message: initialize,
              });
              expect(refused.status).toBe(403);
              const checks = named(
                yield* spans(refused.traceId, (all) => named(all, "auth.authenticate").length > 0),
                "auth.authenticate",
              );
              expect(
                checks.map((span) => [
                  span.status,
                  exception(span),
                  span.tags[organizationId],
                  span.tags[userId],
                ]),
                "The refused check names the grant's organization and user by their IDs",
              ).toEqual([["error", "McpForbidden", organization, owner]]);
            }),
          );

          yield* evidence.step(
            "A key refused for an organization its user does not belong to never names that organization",
            Effect.gen(function* () {
              /**
               * The bearer check of a request that names `reference`, which refuses it, every span
               * of that request that names an organization, and the caller, credential and reason
               * its request span names.
               */
              const refusedCheck = (credential: Redacted.Redacted<string>, reference: string) =>
                Effect.gen(function* () {
                  const refused = yield* post({
                    credential,
                    headers: { "x-executor-organization": reference },
                    message: initialize,
                  });
                  expect(refused.status).toBe(403);
                  const all = yield* spans(refused.traceId, checkedAndAnswered);
                  return {
                    checks: named(all, "auth.authenticate").map((span) => [
                      span.status,
                      exception(span),
                      span.tags[organizationId],
                      span.tags[userId],
                    ]),
                    naming: all
                      .filter((span) => span.tags[organizationId] !== undefined)
                      .map((span) => span.operationName)
                      .sort(),
                    request: all
                      .filter((span) => span.operationName === "http.server POST")
                      .map((span) => [
                        span.tags[userId],
                        span.tags["auth.credential.kind"],
                        span.tags["auth.failure.reason"],
                      ]),
                  };
                });
              const member = yield* identity(actors.member);
              const memberKey = yield* createKey("Organization spans, member", {
                actor: actors.member,
              });
              const memberPinned = yield* createKey("Organization spans, member pinned", {
                actor: actors.member,
                pinned: organization,
              });
              if (target.metadata.target === "cloud") {
                // Only Cloud lets a user hold several organizations, so only there can a key name
                // one its user never joined, or a key pinned to one name another.
                const created = yield* api.request(
                  actors.owner,
                  "POST",
                  "/api/auth/organization/create",
                  {
                    name: "Organization spans, another",
                    slug: `organization-spans-${randomUUID().slice(0, 8)}`,
                    keepCurrentActiveOrganization: true,
                  },
                );
                expect(created.status, JSON.stringify(created.body)).toBe(200);
                const other = yield* body(Organization, created);
                yield* Effect.addFinalizer(() =>
                  api
                    .request(actors.owner, "DELETE", `/api/organizations/${other.id}`)
                    .pipe(Effect.ignore),
                );
                expect(
                  yield* refusedCheck(memberKey.key, other.slug),
                  "An unpinned key names no organization its user never joined; the request names its user",
                ).toEqual({
                  checks: [["error", "McpForbidden", undefined, undefined]],
                  naming: [],
                  request: [[member.id, "api_key", "not_member"]],
                });
                const pinned = yield* createKey("Organization spans, pinned", {
                  pinned: organization,
                });
                expect(
                  yield* refusedCheck(pinned.key, other.id),
                  "A pinned key refused for another organization names only its own, with its user",
                ).toEqual({
                  checks: [["error", "McpForbidden", organization, owner]],
                  naming: ["auth.authenticate", "http.server POST"],
                  request: [[owner, "api_key", "organization_mismatch"]],
                });
              }
              // On both products the member leaves the organization. Its unpinned key outlives
              // the membership, and names the organization it left by its slug.
              const rejoin = Effect.gen(function* () {
                const invited = yield* api.request(
                  actors.owner,
                  "POST",
                  "/api/auth/organization/invite-member",
                  {
                    organizationId: organization,
                    email: member.email,
                    role: "member",
                    resend: true,
                  },
                );
                expect(invited.status, JSON.stringify(invited.body)).toBe(200);
                const accepted = yield* api.request(
                  actors.member,
                  "POST",
                  "/api/auth/organization/accept-invitation",
                  { invitationId: (yield* body(Resource, invited)).id },
                );
                expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
              });
              yield* Effect.acquireUseRelease(
                api
                  .request(actors.owner, "POST", "/api/auth/organization/remove-member", {
                    organizationId: organization,
                    memberIdOrEmail: member.email,
                  })
                  .pipe(
                    Effect.tap((response) =>
                      Effect.sync(() =>
                        expect(response.status, JSON.stringify(response.body)).toBe(200),
                      ),
                    ),
                  ),
                () =>
                  Effect.gen(function* () {
                    expect(
                      yield* refusedCheck(memberKey.key, actors.organization.slug),
                      "An unpinned key names no organization its user left; the request names its user",
                    ).toEqual({
                      checks: [["error", "McpForbidden", undefined, undefined]],
                      naming: [],
                      request: [[member.id, "api_key", "not_member"]],
                    });
                    // A pinned key ends with its membership, so the request is refused before
                    // any check names an organization.
                    const pinnedLeft = yield* post({
                      credential: memberPinned.key,
                      headers: { "x-executor-organization": actors.organization.slug },
                      message: initialize,
                    });
                    expect(
                      pinnedLeft.status,
                      "A key pinned to the organization its user left",
                    ).toBe(401);
                    const left = yield* spans(pinnedLeft.traceId, checkedAndAnswered);
                    expect(
                      {
                        naming: left.filter((span) => span.tags[organizationId] !== undefined),
                        request: left
                          .filter((span) => span.operationName === "http.server POST")
                          .map((span) => [
                            span.tags["auth.credential.kind"],
                            span.tags["auth.failure.reason"],
                          ]),
                      },
                      "names no organization",
                    ).toEqual({ naming: [], request: [["api_key", "unknown"]] });
                  }),
                () => rejoin.pipe(Effect.orDie),
              );
            }),
          );
        }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.cloudMcpForwardOrganization.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors,
            evidence = yield* Evidence;
          const { createKey, identity, post, spans } = yield* helpers;
          const organization = actors.organization.id;
          const owner = (yield* identity(actors.owner)).id;
          const key = yield* createKey("Forward organization");
          // The session object fails the request before its handler runs, so its answer is an
          // empty 500 without the organization the object would have named.
          const lost = { "x-executor-test-fault": "request-lost" };
          const forwarded = (traceId: string) =>
            spans(traceId, (all) => named(all, "mcp.session.forward").length > 0).pipe(
              Effect.map((all) =>
                named(all, "mcp.session.forward").map((span) => [
                  span.tags["executor.mcp.route"],
                  span.tags[organizationId],
                  span.tags[userId],
                ]),
              ),
            );

          yield* evidence.step(
            "The forward of a request the gateway authenticated names its organization and user though the object never answers",
            Effect.gen(function* () {
              const answer = yield* post({
                credential: key.key,
                protocol: stateless,
                headers: { ...lost, "mcp-method": "tools/list" },
                message: { id: 1, method: "tools/list", params: { _meta: statelessMeta } },
              });
              expect(answer.status).toBe(500);
              expect(yield* forwarded(answer.traceId)).toEqual([
                ["authenticated", organization, owner],
              ]);
            }),
          );

          const opened = yield* post({ credential: key.key, message: initialize });
          expect(opened.status).toBe(200);
          const session = opened.headers["mcp-session-id"];
          expect(session, "The object issued a session").toBeDefined();

          yield* evidence.step(
            "The forward of a request routed by its session id names the organization the object answers with; the object's own span names the user",
            Effect.gen(function* () {
              const answer = yield* post({
                credential: key.key,
                session,
                protocol: stateful,
                message: { id: 2, method: "tools/list", params: {} },
              });
              expect(answer.status).toBe(200);
              const all = yield* spans(
                answer.traceId,
                (all) =>
                  named(all, "mcp.session.forward").length > 0 &&
                  named(all, "mcp.session.request").length > 0,
              );
              expect(
                named(all, "mcp.session.forward").map((span) => [
                  span.tags["executor.mcp.route"],
                  span.tags[organizationId],
                  span.tags[userId],
                ]),
                "The gateway names the organization the object authenticated, and no user",
              ).toEqual([["session", organization, undefined]]);
              expect(
                named(all, "mcp.session.request").map((span) => [
                  span.tags[organizationId],
                  span.tags[userId],
                ]),
                "So does the object's own request span",
              ).toEqual([[organization, owner]]);
            }),
          );

          yield* evidence.step(
            "The forward of a request routed by its session id names neither when the object never answers",
            Effect.gen(function* () {
              const answer = yield* post({
                credential: key.key,
                session,
                protocol: stateful,
                headers: lost,
                message: { id: 2, method: "tools/list", params: {} },
              });
              expect(answer.status).toBe(500);
              expect(
                yield* forwarded(answer.traceId),
                "The gateway does not guess the organization or user of a request it did not authenticate",
              ).toEqual([["session", undefined, undefined]]);
            }),
          );
        }),
      ),
    { timeout: 120_000 },
  );
});
