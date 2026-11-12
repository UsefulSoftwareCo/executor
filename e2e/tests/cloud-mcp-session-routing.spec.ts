/**
 * Cloud's gateway routes an MCP request inside a session by the session id its object issued,
 * `<objectId>.<mac>.<sessionId>`, without checking the bearer or opening a database connection.
 * The session object checks the bearer on every request, and that the bearer's own
 * user/client/organization/grant names this object, before any work. These cases hold that
 * boundary: a forged or tampered id reaches no object, another user's bearer gets the answer an
 * unknown session gets, a missing or revoked bearer is refused as before, the previous signing key
 * still verifies and an unknown one does not, the stateless protocol and OAuth refresh keep
 * working, and a session the object no longer holds is not found until the client initializes again.
 * The gateway's spans name each request's JSON-RPC method and Executor tool from closed sets.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import type { SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const Token = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
/** The stateful revision; its sessions carry an `Mcp-Session-Id`. */
const stateful = "2025-06-18";
/** The stateless revision names itself in every request and has no session. */
const stateless = "2026-07-28";
const signedId =
  /^([0-9a-f]{64})\.([A-Za-z0-9_-]{43})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const sessionNotFound = "Session not found";

/** The key Alchemy minted for one logical id, read from this local Cloud's state. */
const RandomState = Schema.Struct({
  attr: Schema.Struct({ text: Schema.Struct({ __redacted__: Schema.String }) }),
});

/** The mac a session object makes over its id and the protocol's session id. */
const mac = (key: string, objectId: string, sessionId: string) =>
  createHmac("sha256", Buffer.from(key, "hex"))
    .update(`executor mcp session\n${objectId}\n${sessionId}`)
    .digest("base64url");

layer(HostedLive, { excludeTestServices: true })("Cloud MCP session routing", (it) => {
  it.effect(
    scenarios.cloudMcpSessionRouting.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            target = yield* Target,
            oauth = yield* McpOAuth,
            fs = yield* FileSystem.FileSystem,
            http = yield* HttpClient.HttpClient;
          const organization = actors.organization.id;

          const createKey = (actor: typeof actors.owner, name: string) =>
            Effect.gen(function* () {
              const created = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
                name,
              });
              expect(created.status).toBe(200);
              const key = yield* body(Token, created);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id })
                  .pipe(Effect.ignore),
              );
              return key;
            });

          /**
           * One MCP POST under its own trace; the answer is JSON or one SSE message. A `batch`
           * sends its messages as one array in place of `message`.
           */
          const post = (
            input: {
              readonly credential?: Redacted.Redacted<string> | undefined;
              readonly session?: string | undefined;
              readonly protocol?: string;
              readonly headers?: Readonly<Record<string, string>>;
              readonly query?: string;
            } & (
              | { readonly message: Readonly<Record<string, unknown>> }
              | { readonly batch: ReadonlyArray<Readonly<Record<string, unknown>>> }
            ),
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const traceId = randomBytes(16).toString("hex");
                const request = HttpClientRequest.post(
                  `${target.metadata.origin}/mcp${input.query ?? ""}`,
                ).pipe(
                  HttpClientRequest.setHeaders({
                    accept: "application/json, text/event-stream",
                    "x-executor-organization": organization,
                    traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
                    ...(input.credential === undefined
                      ? {}
                      : { authorization: `Bearer ${Redacted.value(input.credential)}` }),
                    ...(input.session === undefined ? {} : { "mcp-session-id": input.session }),
                    ...(input.protocol === undefined
                      ? {}
                      : { "mcp-protocol-version": input.protocol }),
                    ...input.headers,
                  }),
                );
                const response = yield* http.execute(
                  yield* HttpClientRequest.bodyJson(
                    request,
                    "batch" in input
                      ? input.batch.map((message) => ({ jsonrpc: "2.0", ...message }))
                      : { jsonrpc: "2.0", ...input.message },
                  ),
                );
                const text = yield* response.text;
                const data = text
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice("data:".length).trim())
                  .at(-1);
                return {
                  traceId,
                  status: response.status,
                  headers: response.headers,
                  text: data ?? text,
                };
              }),
            ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

          /** A stateful session: initialize, then the notification that completes it. */
          const initialize = (credential: Redacted.Redacted<string>, label: string) =>
            evidence.step(
              `Initialize a session (${label})`,
              Effect.gen(function* () {
                const answer = yield* post({
                  credential,
                  message: {
                    id: 1,
                    method: "initialize",
                    params: {
                      protocolVersion: stateful,
                      capabilities: {},
                      clientInfo: { name: `routing-${label}`, version: "1" },
                    },
                  },
                });
                expect(answer.status, answer.text).toBe(200);
                const session = answer.headers["mcp-session-id"];
                expect(session, "The object issues a signed session id").toMatch(signedId);
                const initialized = yield* post({
                  credential,
                  session,
                  protocol: stateful,
                  message: { method: "notifications/initialized" },
                });
                expect(initialized.status).toBe(202);
                return { session: session ?? "", trace: answer.traceId };
              }),
            );
          const listTools = (
            credential: Redacted.Redacted<string> | undefined,
            session: string,
            query?: string,
          ) =>
            post({
              credential,
              session,
              ...(query === undefined ? {} : { query }),
              protocol: stateful,
              message: { id: 2, method: "tools/list", params: {} },
            });
          const listsTools = (answer: { status: number; text: string }) => {
            expect(answer.status, answer.text).toBe(200);
            expect(answer.text).toContain('"execute"');
          };
          const notFound = (answer: { status: number; text: string }) => {
            expect(answer.status, answer.text).toBe(404);
            expect(answer.text).toContain(sessionNotFound);
          };
          const parts = (session: string) => {
            const match = signedId.exec(session);
            if (match === null) throw new Error("Not a signed session id");
            return { objectId: match[1] ?? "", mac: match[2] ?? "", sessionId: match[3] ?? "" };
          };

          /**
           * A finished request's spans, split at the session object: what the object ran and what
           * the gateway ran. `ready` says when the spans that prove the outcome have arrived.
           */
          const spans = (traceId: string, ready: (spans: ReadonlyArray<Span>) => boolean) =>
            telemetry.query(traceId).pipe(
              Effect.map((result) => result.data.map(({ span }) => span)),
              Effect.flatMap((all) =>
                ready(all)
                  ? Effect.succeed(all)
                  : Effect.fail(new Error("The request's spans have not reached Motel")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.map((all) => {
                const byId = new Map(all.map((span) => [span.spanId, span]));
                const inObject = (span: Span) => {
                  const seen = new Set<string>();
                  for (let at: Span | undefined = span; at !== undefined;) {
                    if (at.operationName === "mcp.session.request") return true;
                    if (at.parentSpanId === null || seen.has(at.parentSpanId)) return false;
                    seen.add(at.parentSpanId);
                    at = byId.get(at.parentSpanId);
                  }
                  return false;
                };
                const named = (list: ReadonlyArray<Span>, name: string) =>
                  list.filter((span) => span.operationName === name);
                const object = all.filter(inObject);
                const gateway = all.filter((span) => !inObject(span));
                return { all, object, gateway, named };
              }),
              Effect.tap((found) => evidence.json(`trace-${traceId}.json`, found.all)),
            );
          const hasTag = (name: string, value: string) => (list: ReadonlyArray<Span>) =>
            list.some((span) => span.tags[name] === value);
          const objectAnswered = (list: ReadonlyArray<Span>) =>
            list.some(
              (span) =>
                span.operationName === "mcp.session.request" &&
                span.tags["http.response.status_code"] !== undefined,
            );
          /**
           * The object answered and the gateway's spans have arrived too. The gateway exports its
           * spans apart from the object, so a step that reads them waits for its forward.
           */
          const forwardedAndAnswered = (list: ReadonlyArray<Span>) =>
            objectAnswered(list) &&
            list.some((span) => span.operationName === "mcp.session.forward");
          /** As above, and the gateway's request span, which can end in a later export, arrived. */
          const forwardedWithRequest = (list: ReadonlyArray<Span>) =>
            forwardedAndAnswered(list) &&
            list.some(
              (span) =>
                span.operationName === "mcp.session.forward" &&
                list.some((parent) => parent.spanId === span.parentSpanId),
            );

          /** A key Alchemy minted for this local Cloud, read from its state. */
          const state = yield* fs
            .readFileString(`${target.directory}/alchemy-state.json`)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Struct({ directory: Schema.String })),
                ),
              ),
            );
          const minted = (id: string) =>
            fs.readFileString(`${state.directory}/${id}.json`).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RandomState))),
              Effect.map((resource) => resource.attr.text.__redacted__),
            );
          const currentKey = minted("McpSessionKeyA");

          const owner = yield* createKey(actors.owner, "Session routing owner");
          const member = yield* createKey(actors.member, "Session routing member");
          const ownerSession = yield* initialize(owner.key, "owner");
          const memberSession = yield* initialize(member.key, "member");
          const victim = parts(ownerSession.session);

          yield* evidence.step(
            "A request inside a session reaches its object with no bearer check or connection in the gateway",
            Effect.gen(function* () {
              const initialized = yield* spans(ownerSession.trace, forwardedAndAnswered);
              expect(
                initialized.named(initialized.gateway, "auth.authenticate").length,
                "A request without a session id is authenticated in the gateway, as before",
              ).toBe(1);
              const listed = yield* listTools(owner.key, ownerSession.session);
              listsTools(listed);
              expect(
                Object.keys(listed.headers).filter((name) => name.startsWith("x-executor-session")),
                "The client sees none of the object's internal headers",
              ).toEqual([]);
              const trace = yield* spans(listed.traceId, forwardedAndAnswered);
              const forward = trace.named(trace.gateway, "mcp.session.forward");
              expect(forward.map((span) => span.tags["executor.mcp.route"])).toEqual(["session"]);
              expect(
                forward.map((span) => span.tags["executor.organization.id"]),
                "The forward names the organization the object authenticated",
              ).toEqual([organization]);
              expect(
                trace.named(trace.gateway, "auth.authenticate").length,
                "The gateway checks no bearer",
              ).toBe(0);
              expect(
                trace.named(trace.gateway, "sql.connect").length,
                "The gateway opens no database connection",
              ).toBe(0);
              expect(
                trace.named(trace.object, "auth.authenticate").length,
                "The object checks the bearer",
              ).toBe(1);
              expect(
                trace
                  .named(trace.object, "mcp.session.request")
                  .map((span) => span.tags["executor.mcp.object_id"]),
              ).toEqual([victim.objectId]);
            }),
          );

          yield* evidence.step(
            "The gateway names each request's JSON-RPC method and Executor tool, never a name the caller chose",
            Effect.gen(function* () {
              const chosen = `private_${randomUUID().replaceAll("-", "")}`;
              const inSession = (message: Readonly<Record<string, unknown>>) =>
                post({
                  credential: owner.key,
                  session: ownerSession.session,
                  protocol: stateful,
                  message,
                });
              const cases = [
                { label: "initialize", trace: ownerSession.trace, method: "initialize" },
                {
                  label: "a tool listing",
                  trace: (yield* listTools(owner.key, ownerSession.session)).traceId,
                  method: "tools/list",
                },
                {
                  label: "an Executor tool's call",
                  trace: (yield* inSession({
                    id: 3,
                    method: "tools/call",
                    params: { name: "describe", arguments: {} },
                  })).traceId,
                  method: "tools/call",
                  tool: "describe",
                },
                {
                  label: "a call naming a tool Executor lacks",
                  trace: (yield* inSession({
                    id: 4,
                    method: "tools/call",
                    params: { name: chosen, arguments: { [chosen]: chosen } },
                  })).traceId,
                  method: "tools/call",
                  tool: "other",
                },
                {
                  label: "a notification",
                  trace: (yield* inSession({
                    method: "notifications/cancelled",
                    params: { requestId: 99 },
                  })).traceId,
                  method: "notifications/cancelled",
                },
                {
                  label: "a method MCP does not define",
                  trace: (yield* inSession({ id: 5, method: chosen })).traceId,
                  method: "other",
                },
                // MCP defines these, but only a server sends them, so Executor's server never
                // takes them from a client.
                {
                  label: "a notification only a server sends",
                  trace: (yield* inSession({
                    method: "notifications/subscriptions/acknowledged",
                    params: { notifications: {} },
                  })).traceId,
                  method: "other",
                },
                {
                  label: "a request only a server sends",
                  trace: (yield* inSession({
                    id: 8,
                    method: "sampling/createMessage",
                    params: { messages: [], maxTokens: 1 },
                  })).traceId,
                  method: "other",
                },
                {
                  label: "a client's answer to a server request",
                  trace: (yield* inSession({ id: chosen, result: { action: "cancel" } })).traceId,
                  method: "response",
                },
                {
                  label: "a batch",
                  trace: (yield* post({
                    credential: owner.key,
                    session: ownerSession.session,
                    protocol: stateful,
                    batch: [
                      { id: 6, method: "ping" },
                      { id: 7, method: chosen },
                    ],
                  })).traceId,
                  method: "batch",
                },
              ];
              for (const { label, trace: traceId, method, tool } of cases) {
                const trace = yield* spans(traceId, forwardedWithRequest);
                const forward = trace.named(trace.gateway, "mcp.session.forward");
                const server = forward.map((span) =>
                  trace.all.find((parent) => parent.spanId === span.parentSpanId),
                );
                const recorded = (span: Span | undefined) => ({
                  name: span?.operationName,
                  system: span?.tags["rpc.system.name"],
                  method: span?.tags["rpc.method"],
                  tool: span?.tags["executor.mcp.tool"],
                });
                const expected = { system: "jsonrpc", method, tool };
                expect(forward.map(recorded), label).toEqual([
                  { name: "mcp.session.forward", ...expected },
                ]);
                expect(server.map(recorded), `${label}: the gateway's request span`).toEqual([
                  { name: "http.server POST", ...expected },
                ]);
                expect(
                  trace.gateway.filter((span) =>
                    JSON.stringify([span.operationName, span.tags]).includes(chosen),
                  ),
                  `${label}: no gateway span records the caller's names`,
                ).toEqual([]);
              }
            }),
          );

          /** A refused id is answered in the gateway: no forward, no object, no database. */
          const refusedInGateway = (label: string, session: string) =>
            evidence.step(
              label,
              Effect.gen(function* () {
                const answer = yield* listTools(owner.key, session);
                notFound(answer);
                const trace = yield* spans(
                  answer.traceId,
                  hasTag("executor.mcp.session_id", "refused"),
                );
                for (const name of [
                  "mcp.session.forward",
                  "mcp.session.request",
                  "auth.authenticate",
                  "sql.connect",
                ])
                  expect(trace.named(trace.all, name).length, `No ${name}`).toBe(0);
              }),
            );
          /** The mac with one byte changed, so it decodes to different bytes. */
          const flipped = (value: string) => {
            const bytes = Buffer.from(value, "base64url");
            bytes[10] = (bytes[10] ?? 0) ^ 0xff;
            return bytes.toString("base64url");
          };
          /** The same 256 bits spelled with different padding bits in the last character. */
          const respelled = (value: string) => {
            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            const last = alphabet.indexOf(value.at(-1) ?? "A");
            return `${value.slice(0, -1)}${alphabet[last ^ 1] ?? "A"}`;
          };
          yield* refusedInGateway(
            "A forged mac reaches no object",
            `${victim.objectId}.${flipped(victim.mac)}.${victim.sessionId}`,
          );
          yield* refusedInGateway(
            "An id naming another existing object under this mac reaches no object",
            `${parts(memberSession.session).objectId}.${victim.mac}.${victim.sessionId}`,
          );
          yield* refusedInGateway("A malformed id reaches no object", randomUUID());
          yield* refusedInGateway(
            "A non-canonical spelling of a valid mac reaches no object",
            `${victim.objectId}.${respelled(victim.mac)}.${victim.sessionId}`,
          );
          yield* refusedInGateway(
            "An upper-case object id reaches no object",
            `${victim.objectId.toUpperCase()}.${victim.mac}.${victim.sessionId}`,
          );

          yield* evidence.step(
            "Another user's valid bearer with a valid session id gets the unknown-session answer",
            Effect.gen(function* () {
              const answer = yield* listTools(member.key, ownerSession.session);
              notFound(answer);
              const trace = yield* spans(answer.traceId, objectAnswered);
              expect(
                trace
                  .named(trace.object, "mcp.session.request")
                  .map((span) => span.tags["executor.mcp.session_binding"]),
                "The object refuses a bearer whose key names another object",
              ).toEqual(["refused"]);
              expect(
                trace.all.filter((span) => span.operationName.endsWith("/tools/list")).length,
                "The protocol server never sees the request",
              ).toBe(0);
              // The victim's session is untouched and keeps working.
              listsTools(yield* listTools(owner.key, ownerSession.session));
              // The same bearer at another delivery mode is another grant, so another object.
              const native = yield* listTools(
                owner.key,
                ownerSession.session,
                "?elicitation_mode=native",
              );
              notFound(native);
              const nativeTrace = yield* spans(native.traceId, objectAnswered);
              expect(
                nativeTrace
                  .named(nativeTrace.object, "mcp.session.request")
                  .map((span) => span.tags["executor.mcp.session_binding"]),
              ).toEqual(["refused"]);
            }),
          );

          yield* evidence.step(
            "A missing or revoked bearer is refused as before",
            Effect.gen(function* () {
              const challenge = yield* post({
                message: {
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: stateful,
                    capabilities: {},
                    clientInfo: { name: "routing-anonymous", version: "1" },
                  },
                },
              });
              expect(challenge.status).toBe(401);
              const anonymous = yield* listTools(undefined, ownerSession.session);
              expect(anonymous.status).toBe(401);
              // Wait for whichever side answered: the gateway's refusal or an object's request.
              const unwoken = yield* spans(
                anonymous.traceId,
                (all) =>
                  hasTag("executor.mcp.session_id", "unauthenticated")(all) || objectAnswered(all),
              );
              expect(
                unwoken.all.some(
                  (span) => span.tags["executor.mcp.session_id"] === "unauthenticated",
                ),
                "The gateway refused the request",
              ).toBe(true);
              expect(
                unwoken.named(unwoken.all, "mcp.session.request").length,
                "A request with no bearer is refused in the gateway and wakes no object",
              ).toBe(0);
              expect(
                anonymous.headers["www-authenticate"],
                "The challenge names the same resource metadata",
              ).toBe(challenge.headers["www-authenticate"]);
              const revoked = yield* createKey(actors.owner, "Session routing revoked");
              const session = yield* initialize(revoked.key, "revoked");
              listsTools(yield* listTools(revoked.key, session.session));
              const deleted = yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
                keyId: revoked.id,
              });
              expect(deleted.status).toBe(200);
              const refused = yield* listTools(revoked.key, session.session);
              expect(refused.status).toBe(401);
              expect(refused.headers["www-authenticate"]).toBe(
                challenge.headers["www-authenticate"],
              );
            }),
          );

          yield* evidence.step(
            "An id signed with the previous key still verifies, and one with an unknown key does not",
            Effect.gen(function* () {
              const current = yield* currentKey;
              const previous = yield* minted("McpSessionKeyB");
              expect(
                mac(current, victim.objectId, victim.sessionId),
                "The current key signed the session's id",
              ).toBe(victim.mac);
              const withPrevious = `${victim.objectId}.${mac(previous, victim.objectId, victim.sessionId)}.${victim.sessionId}`;
              listsTools(yield* listTools(owner.key, withPrevious));
              yield* refusedInGateway(
                "An id signed with an unknown key reaches no object",
                `${victim.objectId}.${mac(randomBytes(32).toString("hex"), victim.objectId, victim.sessionId)}.${victim.sessionId}`,
              );
            }),
          );

          yield* evidence.step(
            "The stateless protocol is authenticated in the gateway, as before",
            Effect.gen(function* () {
              const meta = {
                "io.modelcontextprotocol/protocolVersion": stateless,
                "io.modelcontextprotocol/clientCapabilities": {},
              };
              const answer = yield* post({
                credential: owner.key,
                protocol: stateless,
                headers: { "mcp-method": "tools/list" },
                message: { id: 1, method: "tools/list", params: { _meta: meta } },
              });
              listsTools(answer);
              expect(answer.headers["mcp-session-id"]).toBeUndefined();
              const trace = yield* spans(answer.traceId, objectAnswered);
              expect(
                trace
                  .named(trace.gateway, "mcp.session.forward")
                  .map((span) => span.tags["executor.mcp.route"]),
              ).toEqual(["authenticated"]);
              expect(trace.named(trace.gateway, "auth.authenticate").length).toBe(1);
            }),
          );

          yield* browser.login(actors.owner);
          yield* evidence.step(
            "A refreshed OAuth token keeps its session",
            Effect.gen(function* () {
              const grant = yield* oauth.authorize;
              const first = Redacted.make(Redacted.value(grant.tokens).access_token);
              const session = yield* initialize(first, "oauth");
              listsTools(yield* listTools(first, session.session));
              const refreshed = yield* oauth.refresh(grant);
              const second = Redacted.make(Redacted.value(refreshed.tokens).access_token);
              expect(Redacted.value(second)).not.toBe(Redacted.value(first));
              listsTools(yield* listTools(second, session.session));
            }),
          );

          yield* evidence.step(
            "A signed id for a session the object never opened is not found, and the client starts a new one",
            Effect.gen(function* () {
              // The gateway accepts the id's signature and routes it; the object has no such session
              // in memory or in its storage. Sessions that outlive an eviction are covered by
              // cloud-mcp-session-restore.spec.ts.
              const forgotten = randomUUID();
              const lost = `${victim.objectId}.${mac(yield* currentKey, victim.objectId, forgotten)}.${forgotten}`;
              const answer = yield* listTools(owner.key, lost);
              notFound(answer);
              const trace = yield* spans(answer.traceId, objectAnswered);
              expect(
                trace
                  .named(trace.gateway, "mcp.session.forward")
                  .map((span) => span.tags["executor.mcp.route"]),
                "The gateway verified the id and the object answered",
              ).toEqual(["session"]);
              const again = yield* initialize(owner.key, "owner-again");
              expect(parts(again.session).objectId, "The same object starts the new session").toBe(
                victim.objectId,
              );
              listsTools(yield* listTools(owner.key, again.session));
            }),
          );
        }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer))),
      ),
    { timeout: 240_000 },
  );
});
