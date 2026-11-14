/**
 * Hosted requests can be attributed and refusals explained without any credential reaching
 * telemetry. A request span names the kind of credential the request presented
 * (`auth.credential.kind`), its non-secret ID (`auth.credential.id`, an API key's ID) and the
 * verified user, and a 401 or 403 names why (`auth.failure.reason`): no credential, an
 * Authorization header of another form, a token or key nobody issued, a key since deleted, or a
 * write from another origin, which Better Auth refuses with its own code (`auth.failure.code`). A
 * bare 401 from Better Auth is a missing credential only when the request presented none; a
 * signed-in caller an endpoint refuses stays `unclassified`. On Cloud the span also names the
 * client's address (`client.address`), and creating or deleting an API key, a refused one-time
 * code, a refused role change, a consent, a refused agent revocation and a sign-out leave
 * `security.audit` log records, each naming the session that acted when one was loaded. A body
 * field an endpoint ignores changes nothing a record names. No span or record holds the key, the code or the email address,
 * nor any ID, organization or OAuth error a caller sent: a record names only stored records and
 * known codes. A sign-out is a confirmed revocation only where its session row was deleted. Each
 * request's handler logs arrive, however many requests run before or beside it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import type { SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const SessionIdentity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
  session: Schema.Struct({ id: Schema.String }),
});
const SocialStart = Schema.Struct({ url: Schema.RedactedFromValue(Schema.String) });
const accessRoute = "/api/organizations/:organization/access";
const LogRecords = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        body: Schema.String,
        attributes: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);
/** The named attributes of the trace's one `security.audit` record for `action`. */
const auditRecord = (logs: string, action: string, keys: ReadonlyArray<string>) => {
  const records = Schema.decodeUnknownSync(LogRecords)(logs).data.filter(
    (record) => record.body === "security.audit" && record.attributes["audit.action"] === action,
  );
  expect(records, `one ${action} record`).toHaveLength(1);
  return Object.fromEntries(keys.map((key) => [key, records[0]?.attributes[key]]));
};

layer(HostedLive, { excludeTestServices: true })("Security observability", (it) => {
  it.effect(
    scenarios.securityObservability.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            target = yield* Target;
          const cloud = target.metadata.target === "cloud";
          const traced = () => {
            const traceId = randomBytes(16).toString("hex");
            return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
          };
          /** A trace's delivered spans, once one of them is the request span of `route`. */
          const delivered = (label: string, traceId: string, route?: string) =>
            telemetry.query(traceId).pipe(
              Effect.map((result) => result.data.map(({ span }) => span)),
              Effect.flatMap((spans) =>
                spans.some(
                  (span) =>
                    span.operationName.startsWith("http.server ") &&
                    (route === undefined || span.tags["http.route"] === route),
                )
                  ? Effect.succeed(spans)
                  : Effect.fail(new Error("The request's spans have not reached the collector")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.tap((spans) => evidence.json(`${label}.json`, spans)),
            );
          /** `GET` the organization's access as `actor` with `headers`: its status and request span. */
          const access = (label: string, actor: Session, headers: Record<string, string> = {}) =>
            Effect.gen(function* () {
              const { traceId, traceparent } = traced();
              const response = yield* api.request(
                actor,
                "GET",
                `/api/organizations/${actors.organization.slug}/access`,
                undefined,
                { traceparent, ...headers },
              );
              const spans = yield* delivered(label, traceId, accessRoute);
              const served = spans.filter(
                (span) =>
                  span.operationName.startsWith("http.server ") &&
                  span.tags["http.route"] === accessRoute,
              );
              return { status: response.status, served, spans };
            });
          const named = (served: ReadonlyArray<Span>) =>
            served.map((span) => [
              span.tags["http.response.status_code"],
              span.tags["auth.credential.kind"],
              span.tags["auth.credential.id"],
              span.tags["executor.user.id"],
              span.tags["auth.failure.reason"],
            ]);
          const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
          /** The trace's `security.audit` records, once one names `action`. */
          const audit = (traceId: string, action: string) =>
            telemetry.logs(traceId).pipe(
              Effect.filterOrFail(
                (logs) => logs.includes(action),
                () => new Error(`The ${action} record has not reached the collector`),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.tap((logs) => evidence.json(`audit-${action}-${traceId}.json`, logs)),
            );

          const memberSession = yield* body(
            SessionIdentity,
            yield* api.request(actors.member, "GET", "/api/auth/get-session"),
          );
          const member = memberSession.user;
          const anonymous = yield* api.session();
          const created = traced();
          const createdResponse = yield* api.request(
            actors.member,
            "POST",
            "/api/auth/api-key/create",
            { name: "Security observability" },
            { traceparent: created.traceparent },
          );
          expect(createdResponse.status, JSON.stringify(createdResponse.body)).toBe(200);
          const key = yield* body(Key, createdResponse);
          const secret = Redacted.value(key.key);
          /** No delivered span or record may hold the key, the session cookie or the email. */
          const assertPrivate = (value: unknown) => {
            const json = JSON.stringify(value);
            expect(json, "The API key never reaches telemetry").not.toContain(secret);
            expect(json, "Nor does its unique part").not.toContain(secret.slice(-16));
          };

          yield* evidence.step(
            "A refused request names its credential's kind and why it was refused",
            Effect.gen(function* () {
              const missing = yield* access("missing", anonymous);
              expect(
                { status: missing.status, spans: named(missing.served) },
                "No credential at all",
              ).toEqual({
                status: 401,
                spans: [["401", "none", undefined, undefined, "missing"]],
              });
              const malformed = yield* access("malformed", anonymous, {
                authorization: "Basic c3ludGhldGljOnN5bnRoZXRpYw==",
              });
              expect(
                { status: malformed.status, spans: named(malformed.served) },
                "An Authorization header that is not a bearer",
              ).toEqual({
                status: 401,
                spans: [["401", undefined, undefined, undefined, "malformed"]],
              });
              const unknownToken = yield* access(
                "unknown-token",
                anonymous,
                bearer(randomBytes(24).toString("base64url")),
              );
              expect(
                { status: unknownToken.status, spans: named(unknownToken.served) },
                "An access token nobody issued",
              ).toEqual({
                status: 401,
                spans: [["401", "oauth_access_token", undefined, undefined, "unknown"]],
              });
              const unknownKey = yield* access(
                "unknown-key",
                anonymous,
                bearer(`exp_${randomBytes(24).toString("base64url")}`),
              );
              expect(
                { status: unknownKey.status, spans: named(unknownKey.served) },
                "An API key nobody issued",
              ).toEqual({
                status: 401,
                spans: [["401", "api_key", undefined, undefined, "unknown"]],
              });
              const accepted = yield* access("accepted", anonymous, bearer(secret));
              expect(
                { status: accepted.status, spans: named(accepted.served) },
                "A live key names its ID and its user, and no refusal",
              ).toEqual({
                status: 200,
                spans: [["200", "api_key", key.id, member.id, undefined]],
              });
              for (const request of [missing, malformed, unknownToken, unknownKey, accepted])
                assertPrivate(request.spans);
              if (cloud) {
                // Cloud records why Better Auth's own endpoints refused, from the fixed code they
                // answer with.
                const foreign = traced();
                const refusedWrite = yield* api.request(
                  actors.member,
                  "POST",
                  "/api/auth/api-key/create",
                  { name: "Security observability, foreign origin" },
                  { traceparent: foreign.traceparent, origin: "https://foreign.example.test" },
                );
                expect(refusedWrite.status, JSON.stringify(refusedWrite.body)).toBe(403);
                const written = (yield* delivered("foreign-origin", foreign.traceId)).filter(
                  (span) => span.operationName.startsWith("http.server "),
                );
                expect(
                  written.map((span) => [
                    span.tags["auth.failure.reason"],
                    span.tags["auth.failure.code"],
                  ]),
                  "A write from another origin is refused as one",
                ).toEqual([["origin_mismatch", "INVALID_ORIGIN"]]);
                // Better Auth answers a bare 401 both without a session and to a signed-in caller
                // it refuses: Cloud refuses OAuth client management to every session.
                const refusedClient = (label: string, actor: Session) =>
                  Effect.gen(function* () {
                    const { traceId, traceparent } = traced();
                    const response = yield* api.request(
                      actor,
                      "POST",
                      "/api/auth/oauth2/create-client",
                      { redirect_uris: ["https://client.example.test/callback"] },
                      { traceparent },
                    );
                    expect(response.status, JSON.stringify(response.body)).toBe(401);
                    return (yield* delivered(label, traceId))
                      .filter((span) => span.operationName.startsWith("http.server "))
                      .map((span) => [
                        span.tags["auth.failure.reason"],
                        span.tags["auth.credential.kind"],
                      ]);
                  });
                expect(
                  yield* refusedClient("client-privileges", actors.member),
                  "A signed-in caller the endpoint refuses has no session missing",
                ).toEqual([["unclassified", undefined]]);
                expect(
                  (yield* body(
                    SessionIdentity,
                    yield* api.request(actors.member, "GET", "/api/auth/get-session"),
                  )).session.id,
                  "and the session it presented is still valid",
                ).toBe(memberSession.session.id);
                expect(
                  yield* refusedClient("client-anonymous", anonymous),
                  "A request with no credential at all is missing one",
                ).toEqual([["missing", "none"]]);
              }
              if (cloud)
                expect(
                  accepted.served[0]?.tags["client.address"],
                  "Cloud names the address the request came from",
                ).toBeTypeOf("string");
            }),
          );

          yield* evidence.step(
            "A deleted key is refused as unknown, and still never recorded",
            Effect.gen(function* () {
              const deleted = traced();
              const deletion = yield* api.request(
                actors.member,
                "POST",
                "/api/auth/api-key/delete",
                // Better Auth ignores a field the endpoint does not take, whatever its value.
                { keyId: key.id, role: 42 },
                { traceparent: deleted.traceparent },
              );
              expect(deletion.status, JSON.stringify(deletion.body)).toBe(200);
              const refused = yield* access("deleted-key", anonymous, bearer(secret));
              expect({ status: refused.status, spans: named(refused.served) }).toEqual({
                status: 401,
                spans: [["401", "api_key", undefined, undefined, "unknown"]],
              });
              assertPrivate(refused.spans);
              if (!cloud) return;
              for (const [traceId, action] of [
                [created.traceId, "api_key.create"],
                [deleted.traceId, "api_key.delete"],
              ] as const) {
                const logs = yield* audit(traceId, action);
                expect(
                  auditRecord(logs, action, [
                    "audit.outcome",
                    "audit.target.id",
                    "executor.user.id",
                    "auth.credential.kind",
                    "auth.credential.id",
                  ]),
                  `${action} names the key it applied to and the session that acted`,
                ).toEqual({
                  "audit.outcome": "success",
                  "audit.target.id": key.id,
                  "executor.user.id": member.id,
                  "auth.credential.kind": "session",
                  "auth.credential.id": memberSession.session.id,
                });
                assertPrivate(logs);
              }
              // An action a product handler performs is recorded too, a refused one included.
              const revoke = traced();
              const revoked = yield* api.request(
                actors.member,
                "POST",
                `/api/organizations/${actors.organization.slug}/mcp-agents/agent-${randomUUID()}/revoke`,
                {},
                { traceparent: revoke.traceparent },
              );
              expect(revoked.status, JSON.stringify(revoked.body)).toBe(404);
              const revokeLogs = yield* audit(revoke.traceId, "mcp_agent.revoke");
              expect(revokeLogs, "The refused revocation names its outcome").toContain("failure");
              expect(revokeLogs, "and its user").toContain(member.id);
              expect(revokeLogs, "and the organization").toContain(actors.organization.id);
              // A wrong code for an address nobody asked a code for is refused like any other.
              const email = `security-observability-${randomUUID().slice(0, 8)}@example.test`;
              const otp = traced();
              const refusedOtp = yield* api.request(
                anonymous,
                "POST",
                "/api/auth/sign-in/email-otp",
                { email, otp: "000000" },
                { traceparent: otp.traceparent },
              );
              expect(refusedOtp.status, JSON.stringify(refusedOtp.body)).toBe(400);
              const logs = yield* audit(otp.traceId, "sign_in");
              expect(logs, "The refused sign-in names Better Auth's code").toContain("INVALID_OTP");
              expect(logs, "and its method").toContain("email_otp");
              expect(logs, "but never the address").not.toContain(email);
              expect(logs, "or the code").not.toContain('"000000"');
            }),
          );

          if (!cloud) return;

          yield* evidence.step(
            "Identifiers, organizations and error codes a caller sends never reach telemetry",
            Effect.gen(function* () {
              // Shaped like an ID or a fixed code, so only where a value comes from keeps it out.
              const marker = `hostile_${randomBytes(12).toString("hex")}`;
              const organizations = `/api/organizations/${actors.organization.slug}`;
              /**
               * Send a refused request in its own trace; its record, if `action` names one, and
               * every span and log of the trace arrive without the marker.
               */
              const refused = (
                label: string,
                action: string | undefined,
                send: (traceparent: string) => Effect.Effect<unknown, unknown>,
              ) =>
                Effect.gen(function* () {
                  const { traceId, traceparent } = traced();
                  yield* send(traceparent);
                  const logs = action === undefined ? "" : yield* audit(traceId, action);
                  if (action !== undefined)
                    expect(logs, `${label}: the record names its outcome`).toMatch(
                      /"audit\.outcome":\s*"failure"/u,
                    );
                  const spans = yield* delivered(label, traceId);
                  const traceLogs = yield* telemetry.logs(traceId);
                  // The marker is this request's own, so it may appear nowhere in the environment.
                  const searched = yield* telemetry.logsWholeEnvironment(marker);
                  for (const [where, value] of [
                    ["records", logs],
                    ["spans", JSON.stringify(spans)],
                    ["trace logs", traceLogs],
                    ["logs found by the marker", searched],
                  ] as const)
                    expect(value, `${label}: no ${where} hold the marker`).not.toContain(marker);
                  return logs;
                });
              const status =
                (expected: (status: number) => boolean) =>
                (response: { readonly status: number; readonly body: unknown }) =>
                  Effect.sync(() =>
                    expect(expected(response.status), JSON.stringify(response.body)).toBe(true),
                  );
              const post = (path: string, data: unknown) => (traceparent: string) =>
                api
                  .request(actors.member, "POST", path, data, { traceparent })
                  .pipe(Effect.tap(status((code) => code >= 400 && code < 500)));
              yield* refused(
                "key-delete",
                "api_key.delete",
                post("/api/auth/api-key/delete", { keyId: marker }),
              );
              // `apiKeyManagement` refuses a pin to an organization the creator is not in before
              // Better Auth's endpoint runs, so the request leaves no record at all.
              yield* refused(
                "key-create",
                undefined,
                post("/api/auth/api-key/create", {
                  name: "Security observability, hostile pin",
                  metadata: { organization: marker },
                }),
              );
              const role = yield* refused(
                "role-change",
                "member.role_change",
                post("/api/auth/organization/update-member-role", {
                  memberId: marker,
                  organizationId: marker,
                  role: "admin",
                }),
              );
              // Nothing but the product analytics plugin's after hook reads this endpoint's
              // session, and it runs before the audit plugin's because it is registered first.
              // Reordering the plugins, or removing that read, leaves the record without an actor.
              expect(
                auditRecord(role, "member.role_change", [
                  "audit.target.id",
                  "executor.organization.id",
                  "executor.user.id",
                  "auth.credential.kind",
                  "auth.credential.id",
                ]),
                "A refused role change names no member or organization, but the session that asked",
              ).toEqual({
                "audit.target.id": undefined,
                "executor.organization.id": undefined,
                "executor.user.id": member.id,
                "auth.credential.kind": "session",
                "auth.credential.id": memberSession.session.id,
              });
              yield* refused(
                "invitation",
                "invitation.create",
                post("/api/auth/organization/invite-member", {
                  email: `security-observability-${randomUUID().slice(0, 8)}@example.test`,
                  organizationId: marker,
                  role: "member",
                }),
              );
              yield* refused(
                "agent-revoke",
                "mcp_agent.revoke",
                post(`${organizations}/mcp-agents/${marker}/revoke`, {}),
              );
              yield* refused(
                "connection-revoke",
                "mcp_connection.revoke",
                post(`${organizations}/mcp-connections/${marker}/revoke`, {}),
              );
              // Better Auth returns a provider's `error` to the browser in its error redirect.
              const browser = yield* api.session();
              const started = yield* api.request(browser, "POST", "/api/auth/sign-in/social", {
                provider: "github",
                callbackURL: "/login",
                errorCallbackURL: "/login",
              });
              expect(started.status, JSON.stringify(started.body)).toBe(200);
              const authorization = new URL(
                Redacted.value((yield* body(SocialStart, started)).url),
              );
              const redirect = authorization.searchParams.get("redirect_uri");
              const state = authorization.searchParams.get("state");
              expect(redirect, "The sign-in names its callback").toBeTypeOf("string");
              expect(state, "and its state").toBeTypeOf("string");
              const callback = new URL(redirect ?? "");
              callback.searchParams.set("state", state ?? "");
              callback.searchParams.set("error", marker);
              const social = yield* refused("social-error", "sign_in", (traceparent) =>
                api
                  .request(browser, "GET", `${callback.pathname}${callback.search}`, undefined, {
                    traceparent,
                  })
                  // The redirect opens the sign-in page, which is not JSON.
                  .pipe(Effect.exit),
              );
              expect(social, "The provider's error is recorded as an unknown code").toMatch(
                /"audit\.failure":\s*"other"/u,
              );
              expect(social, "of a social sign-in").toContain("social");
            }),
          );

          yield* evidence.step(
            "A consent records the decision the endpoint took, whatever else the body holds",
            Effect.gen(function* () {
              const redirect = "http://127.0.0.1:9/callback";
              const registered = yield* api.request(
                anonymous,
                "POST",
                "/api/auth/oauth2/register",
                {
                  client_name: "Security observability consent",
                  redirect_uris: [redirect],
                  token_endpoint_auth_method: "none",
                  grant_types: ["authorization_code"],
                  response_types: ["code"],
                },
              );
              expect(registered.status, JSON.stringify(registered.body)).toBe(201);
              const { client_id: clientId } = yield* body(
                Schema.Struct({ client_id: Schema.String }),
                registered,
              );
              const query = new URLSearchParams({
                response_type: "code",
                client_id: clientId,
                redirect_uri: redirect,
                code_challenge: createHash("sha256")
                  .update(randomBytes(32).toString("base64url"))
                  .digest("base64url"),
                code_challenge_method: "S256",
                scope: "mcp",
                state: randomBytes(16).toString("hex"),
              });
              const opened = yield* api.request(
                actors.member,
                "GET",
                `/api/auth/oauth2/authorize?${query.toString()}`,
                undefined,
                { accept: "application/json" },
              );
              expect(opened.status, JSON.stringify(opened.body)).toBe(200);
              const consentPage = new URL(
                (yield* body(Schema.Struct({ url: Schema.String }), opened)).url,
                "https://consent.invalid",
              );
              const denied = traced();
              const denial = yield* api.request(
                actors.member,
                "POST",
                "/api/auth/oauth2/consent",
                // `role` is no consent field; Better Auth ignores it, and so must the record.
                { accept: false, oauth_query: consentPage.search.slice(1), role: 42 },
                { traceparent: denied.traceparent },
              );
              expect(denial.status, JSON.stringify(denial.body)).toBe(200);
              expect(
                auditRecord(yield* audit(denied.traceId, "oauth.consent"), "oauth.consent", [
                  "audit.outcome",
                  "audit.decision",
                  "audit.target.id",
                ]),
                "A denial is recorded as one, naming the client",
              ).toEqual({
                "audit.outcome": "success",
                "audit.decision": "deny",
                "audit.target.id": clientId,
              });
            }),
          );

          yield* evidence.step(
            "A sign-out is recorded where its session is deleted, and only then as revoked",
            Effect.gen(function* () {
              const session = yield* freshOwnerSession;
              const signedIn = yield* body(
                SessionIdentity,
                yield* api.request(session, "GET", "/api/auth/get-session"),
              );
              const out = traced();
              const signedOut = yield* api.request(
                session,
                "POST",
                "/api/auth/sign-out",
                {},
                {
                  traceparent: out.traceparent,
                },
              );
              expect(signedOut.status, JSON.stringify(signedOut.body)).toBe(200);
              const revoked = yield* audit(out.traceId, "session.revoke");
              expect(revoked, "The deletion is a success").toMatch(
                /"audit\.outcome":\s*"success"/u,
              );
              expect(revoked, "naming the deleted session").toContain(signedIn.session.id);
              expect(revoked, "and its user").toContain(signedIn.user.id);
              // A sign-out without a session deletes nothing, though Better Auth answers success.
              const nothing = traced();
              const empty = yield* api.request(
                anonymous,
                "POST",
                "/api/auth/sign-out",
                {},
                {
                  traceparent: nothing.traceparent,
                },
              );
              expect(empty.status, JSON.stringify(empty.body)).toBe(200);
              expect(
                yield* audit(nothing.traceId, "session.revoke"),
                "A sign-out that deleted no session is unconfirmed",
              ).toMatch(/"audit\.outcome":\s*"unconfirmed"/u);
            }),
          );

          yield* evidence.step(
            "A handler's log arrives from successive and concurrent requests",
            Effect.gen(function* () {
              // `security.audit` is an ordinary log a handler writes with its request's loggers.
              const revoke = Effect.gen(function* () {
                const { traceId, traceparent } = traced();
                const response = yield* api.request(
                  actors.member,
                  "POST",
                  `/api/organizations/${actors.organization.slug}/mcp-agents/agent-${randomUUID()}/revoke`,
                  {},
                  { traceparent },
                );
                expect(response.status, JSON.stringify(response.body)).toBe(404);
                return traceId;
              });
              const successive = yield* Effect.forEach([1, 2, 3], () => revoke);
              const concurrent = yield* Effect.all([revoke, revoke, revoke, revoke], {
                concurrency: "unbounded",
              });
              for (const traceId of [...successive, ...concurrent])
                expect(yield* audit(traceId, "mcp_agent.revoke")).toContain(member.id);
            }),
          );
        }),
      ),
    { timeout: 180_000 },
  );
});
