/**
 * Cloud's OAuth token endpoint answers MCP clients with RFC 6749 errors that are theirs to act on,
 * so these never reach Sentry. Its request span records what was asked and answered instead, from
 * closed vocabularies: the grant type, the OAuth error, rate limiting, why a refresh was refused,
 * whether refresh-token reuse detection ended a whole grant, how long ago a refused token was
 * replaced, and the family of MCP client the registration names.
 * Authorization and consent spans name that family too, so re-logins can be counted per client.
 * Registration spans name the family the body declares, the OAuth error a refusal carried and the
 * rule that refused it, never the description that quotes the client's input.
 */
import { randomBytes } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type UrlParams } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import type { SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpOAuth, type Grant } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";
import { sentryExceptions } from "../support/sentry-events.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const revokedEvent = "auth.token.refresh_family_revoked";
const grantMarker = "urn:e2e:private-grant-marker";
const clientName = "Claude Code (executor_e2e)";
const loopback = "http://127.0.0.1:9/callback";
const registrations = [
  { name: "Codex", family: "codex" },
  { name: "claudeai", family: "claude-ai" },
  { name: "Claude Desktop", family: "claude-desktop" },
  { name: "ChatGPT", family: "chatgpt" },
  { name: "Cursor", family: "cursor" },
  { name: "Visual Studio Code", family: "vscode" },
  { name: "Windsurf", family: "windsurf" },
  { name: "Executor CLI", family: "executor-cli" },
  { name: "Executor E2E client", family: "other" },
  { redirect: "https://claude.ai/api/mcp/auth_callback", family: "claude-ai" },
] as const;

const tokenRequest = (fields: UrlParams.Input) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const traceId = randomBytes(16).toString("hex");
    const status = yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.post(`${target.metadata.origin}/api/auth/oauth2/token`).pipe(
            HttpClientRequest.setHeaders({
              traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
            }),
            HttpClientRequest.bodyUrlParams(fields),
          ),
        );
        yield* response.text;
        return response.status;
      }),
    ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    return { traceId, status };
  });

const Registered = Schema.Struct({ client_id: Schema.NonEmptyString });
const register = (client: { readonly name?: string; readonly redirect?: string }) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const origin = target.metadata.origin;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(`${origin}/api/auth/oauth2/register`).pipe(
          HttpClientRequest.setHeaders({ origin }),
          HttpClientRequest.bodyJson({
            ...(client.name === undefined ? {} : { client_name: client.name }),
            redirect_uris: [client.redirect ?? loopback],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
        );
        const response = yield* http.execute(request);
        expect(response.status).toBe(201);
        const { client_id } = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Registered)),
        );
        return client_id;
      }),
    );
  });

const registrationRequest = (body: Record<string, unknown>) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const origin = target.metadata.origin;
    const traceId = randomBytes(16).toString("hex");
    const status = yield* Effect.scoped(
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(`${origin}/api/auth/oauth2/register`).pipe(
          HttpClientRequest.setHeaders({
            origin,
            traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
          }),
          HttpClientRequest.bodyJson(body),
        );
        const response = yield* http.execute(request);
        yield* response.text;
        return response.status;
      }),
    ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    return { traceId, status };
  });

const registrationSpan = (traceId: string) =>
  Effect.flatMap(Telemetry, (telemetry) => telemetry.query(traceId)).pipe(
    Effect.map((found) =>
      found.data
        .map(({ span }) => span)
        .find(
          (span) =>
            span.tags["url.path"] === "/api/auth/oauth2/register" &&
            span.tags["auth.register.error"] !== undefined,
        ),
    ),
    Effect.flatMap((span) =>
      span === undefined
        ? Effect.fail(new Error(`The registration span of trace ${traceId} has not arrived`))
        : Effect.succeed(span),
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
  );

const familySpans = (operation: string, path: string, family: string, since: number) =>
  Effect.flatMap(Telemetry, (telemetry) =>
    telemetry.searchWholeEnvironment(operation, {
      "url.path": path,
      "auth.token.client_family": family,
    }),
  ).pipe(
    Effect.map((found) =>
      found.data.map(({ span }) => span).filter((span) => Date.parse(span.startTime) >= since),
    ),
    Effect.flatMap((spans) =>
      spans.length === 0
        ? Effect.fail(new Error(`No ${operation} ${path} span names ${family} yet`))
        : Effect.succeed(spans),
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
  );

const refreshFields = (grant: Grant) => ({
  grant_type: "refresh_token",
  client_id: grant.clientId,
  refresh_token: Redacted.value(grant.tokens).refresh_token,
  resource: grant.resource,
});

const tokenSpan = (traceId: string) =>
  Effect.flatMap(Telemetry, (telemetry) => telemetry.query(traceId)).pipe(
    Effect.map((found) =>
      found.data
        .map(({ span }) => span)
        .find(
          (span) =>
            span.tags["url.path"] === "/api/auth/oauth2/token" &&
            span.tags["auth.token.grant_type"] !== undefined,
        ),
    ),
    Effect.flatMap((span) =>
      span === undefined
        ? Effect.fail(new Error(`The token span of trace ${traceId} has not arrived`))
        : Effect.succeed(span),
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
  );

const expectRecorded = (
  span: Span,
  expected: {
    readonly status: number;
    readonly grant: string;
    readonly error: string;
    readonly revoked: boolean;
    readonly rejection: string;
    readonly family: string;
  },
) => {
  expect(span.operationName).toBe("http.server POST");
  expect(span.tags).toMatchObject({
    "http.response.status_code": String(expected.status),
    "auth.token.grant_type": expected.grant,
    "auth.token.error": expected.error,
    "auth.token.rate_limited": "false",
    "auth.token.refresh_family_revoked": String(expected.revoked),
    "auth.token.refresh_rejection": expected.rejection,
    "auth.token.client_family": expected.family,
  });
  expect(span.events.filter(({ name }) => name === revokedEvent)).toHaveLength(
    expected.revoked ? 1 : 0,
  );
};

layer(HostedLive, { excludeTestServices: true })("OAuth token telemetry", (it) => {
  it.effect(scenarios.oauthTokenTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth;
        const started = (yield* Clock.currentTimeMillis) - 5_000;
        yield* browser.login(actors.owner);
        const stored = yield* evidence.step(
          "Authorize one MCP grant",
          oauth.authorizeNamed(clientName),
        );
        const first = yield* evidence.step(
          "The first instance refreshes the stored grant",
          oauth.refresh(stored),
        );

        expectRecorded(yield* tokenSpan(stored.codeExchangeTraceId), {
          status: 200,
          grant: "authorization_code",
          error: "none",
          revoked: false,
          rejection: "none",
          family: "claude-code",
        });

        const sibling = yield* tokenRequest(refreshFields(stored));
        expect(sibling.status).toBe(200);
        const unsupported = yield* tokenRequest({
          ...refreshFields(first),
          grant_type: grantMarker,
        });
        expect(unsupported.status).toBe(400);

        const locks = yield* cloudLocks;
        const rotatedAgo = (age: string) =>
          locks.run({
            sql: `update "oauthRefreshToken" set "rotationReplayExpiresAt" = now() - interval '1 minute',
              "revoked" = now() - interval '${age}', "rotatedAt" = now() - interval '${age}'
              where "clientId" = $1 and "rotatedAt" is not null`,
            params: [stored.clientId],
          });
        yield* rotatedAgo("2 hours");
        const superseded = yield* tokenRequest(refreshFields(stored));
        expect(superseded.status).toBe(400);
        const current = yield* tokenRequest(refreshFields(first));
        expect(current.status).toBe(200);
        yield* rotatedAgo("25 hours");
        const reused = yield* tokenRequest(refreshFields(stored));
        expect(reused.status).toBe(400);
        const ended = yield* tokenRequest(refreshFields(first));
        expect(ended.status).toBe(400);

        const named = (...grants: ReadonlyArray<string>) =>
          tokenRequest([
            ...grants.map((grant) => ["grant_type", grant] as const),
            ...Object.entries(refreshFields(first)).filter(([field]) => field !== "grant_type"),
          ]);
        const duplicated = yield* named("authorization_code", "refresh_token");
        expect(duplicated.status).toBe(400);
        const lastUnsupported = yield* named("refresh_token", grantMarker);
        expect(lastUnsupported.status).toBe(400);
        const padded = yield* named(" refresh_token\t");
        expect(padded.status).toBe(400);
        const uppercase = yield* named("REFRESH_TOKEN");
        expect(uppercase.status).toBe(400);

        const spans = {
          sibling: yield* tokenSpan(sibling.traceId),
          unsupported: yield* tokenSpan(unsupported.traceId),
          superseded: yield* tokenSpan(superseded.traceId),
          current: yield* tokenSpan(current.traceId),
          reused: yield* tokenSpan(reused.traceId),
          ended: yield* tokenSpan(ended.traceId),
          duplicated: yield* tokenSpan(duplicated.traceId),
          lastUnsupported: yield* tokenSpan(lastUnsupported.traceId),
          padded: yield* tokenSpan(padded.traceId),
          uppercase: yield* tokenSpan(uppercase.traceId),
        };
        expectRecorded(spans.sibling, {
          status: 200,
          grant: "refresh_token",
          error: "none",
          revoked: false,
          rejection: "none",
          family: "claude-code",
        });
        expectRecorded(spans.unsupported, {
          status: 400,
          grant: "other",
          error: "unsupported_grant_type",
          revoked: false,
          rejection: "none",
          family: "claude-code",
        });
        expectRecorded(spans.superseded, {
          status: 400,
          grant: "refresh_token",
          error: "invalid_grant",
          revoked: false,
          rejection: "superseded",
          family: "claude-code",
        });
        expectRecorded(spans.current, {
          status: 200,
          grant: "refresh_token",
          error: "none",
          revoked: false,
          rejection: "none",
          family: "claude-code",
        });
        expectRecorded(spans.reused, {
          status: 400,
          grant: "refresh_token",
          error: "invalid_grant",
          revoked: true,
          rejection: "reused",
          family: "claude-code",
        });
        const ages = [
          [spans.superseded, 2 * 3600],
          [spans.reused, 25 * 3600],
        ] as const;
        for (const [span, seconds] of ages) {
          const age = Number(span.tags["auth.token.refresh_revoked_age_seconds"]);
          expect(age).toBeGreaterThanOrEqual(seconds - 60);
          expect(age).toBeLessThan(seconds + 600);
          expect(span.tags["auth.token.refresh_rotated"]).toBe("true");
        }
        for (const span of [spans.sibling, spans.current, spans.ended, spans.duplicated])
          expect(span.tags["auth.token.refresh_revoked_age_seconds"]).toBeUndefined();
        const ref = (span: Span) => span.tags["auth.token.refresh_token_ref"];
        const storedRefs = [spans.sibling, spans.superseded, spans.reused].map(ref);
        const firstRefs = [spans.current, spans.ended, spans.duplicated, spans.padded].map(ref);
        expect(storedRefs[0]).toMatch(/^[0-9a-f]{16}$/u);
        expect(firstRefs[0]).toMatch(/^[0-9a-f]{16}$/u);
        expect(new Set(storedRefs)).toEqual(new Set([storedRefs[0]]));
        expect(new Set(firstRefs)).toEqual(new Set([firstRefs[0]]));
        expect(firstRefs[0]).not.toBe(storedRefs[0]);
        for (const span of [spans.unsupported, spans.lastUnsupported, spans.uppercase])
          expect(ref(span)).toBeUndefined();
        expectRecorded(spans.ended, {
          status: 400,
          grant: "refresh_token",
          error: "invalid_grant",
          revoked: false,
          rejection: "unknown_token",
          family: "claude-code",
        });
        for (const span of [spans.duplicated, spans.padded])
          expectRecorded(span, {
            status: 400,
            grant: "refresh_token",
            error: "invalid_grant",
            revoked: false,
            rejection: "unknown_token",
            family: "claude-code",
          });
        for (const span of [spans.lastUnsupported, spans.uppercase])
          expectRecorded(span, {
            status: 400,
            grant: "other",
            error: "unsupported_grant_type",
            revoked: false,
            rejection: "none",
            family: "claude-code",
          });

        const serialized = JSON.stringify(spans);
        const leaked = [
          Redacted.value(stored.tokens).refresh_token,
          Redacted.value(first.tokens).refresh_token,
          Redacted.value(first.tokens).access_token,
          stored.clientId,
          clientName,
          grantMarker,
        ].some((secret) => serialized.includes(secret));
        expect(leaked).toBe(false);

        const authorizations = yield* familySpans(
          "http.server GET",
          "/api/auth/oauth2/authorize",
          "claude-code",
          started,
        );
        const consents = yield* familySpans(
          "http.server POST",
          "/api/auth/oauth2/consent",
          "claude-code",
          started,
        );
        expect(consents.some((span) => span.tags["http.response.status_code"] === "200")).toBe(
          true,
        );
        const consentText = JSON.stringify([...authorizations, ...consents]);
        expect([stored.clientId, clientName].some((value) => consentText.includes(value))).toBe(
          false,
        );

        const families = yield* Effect.forEach(registrations, (client) =>
          Effect.gen(function* () {
            const clientId = yield* register(client);
            const refreshed = yield* tokenRequest({
              grant_type: "refresh_token",
              client_id: clientId,
              refresh_token: grantMarker,
            });
            expect(refreshed.status).toBe(400);
            return {
              expected: client.family,
              recorded: (yield* tokenSpan(refreshed.traceId)).tags["auth.token.client_family"],
            };
          }),
        );
        expect(families.map(({ recorded }) => recorded)).toEqual(
          families.map(({ expected }) => expected),
        );
        const unregistered = yield* tokenRequest({
          grant_type: "refresh_token",
          client_id: `unregistered-${randomBytes(8).toString("hex")}`,
          refresh_token: grantMarker,
        });
        const unnamed = yield* tokenRequest({
          grant_type: "refresh_token",
          refresh_token: grantMarker,
        });
        expect([unregistered.status, unnamed.status]).toEqual([400, 400]);
        for (const request of [unregistered, unnamed])
          expect((yield* tokenSpan(request.traceId)).tags["auth.token.client_family"]).toBe(
            "unknown",
          );

        const grants = {
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        const registrationCases = [
          {
            body: {
              ...grants,
              client_name: "Cursor",
              redirect_uris: ["https://localhost:8443/oauth/callback"],
            },
            expected: {
              status: 400,
              error: "invalid_redirect_uri",
              rejection: "redirect_uri_web_requires_https",
              family: "cursor",
            },
          },
          {
            body: { ...grants, client_name: "Cursor", redirect_uris: [`cursor://${grantMarker}`] },
            expected: {
              status: 400,
              error: "invalid_redirect_uri",
              rejection: "redirect_uris",
              family: "cursor",
            },
          },
          {
            body: {
              ...grants,
              client_name: "Codex",
              redirect_uris: [loopback],
              token_endpoint_auth_method: "tls_client_auth",
            },
            expected: {
              status: 400,
              error: "invalid_client_metadata",
              rejection: "token_endpoint_auth_method",
              family: "codex",
            },
          },
          {
            body: {
              ...grants,
              client_name: "Codex",
              redirect_uris: [loopback],
              scope: grantMarker,
            },
            expected: {
              status: 400,
              error: "invalid_scope",
              rejection: "scope",
              family: "codex",
            },
          },
          {
            body: { ...grants, client_name: 42, redirect_uris: [loopback] },
            expected: {
              status: 400,
              error: "invalid_client_metadata",
              rejection: "client_name",
              family: "unknown",
            },
          },
          {
            body: { ...grants, client_name: clientName, redirect_uris: [loopback] },
            expected: { status: 201, error: "none", rejection: "none", family: "claude-code" },
          },
        ];
        const registered = yield* Effect.forEach(registrationCases, ({ body }) =>
          registrationRequest(body),
        );
        expect(registered.map(({ status }) => status)).toEqual(
          registrationCases.map(({ expected }) => expected.status),
        );
        const registrationSpans = yield* Effect.forEach(registered, ({ traceId }) =>
          registrationSpan(traceId),
        );
        expect(
          registrationSpans.map((span) => ({
            status: Number(span.tags["http.response.status_code"]),
            error: span.tags["auth.register.error"],
            rejection: span.tags["auth.register.rejection"],
            family: span.tags["auth.token.client_family"],
          })),
        ).toEqual(registrationCases.map(({ expected }) => expected));
        const registrationText = JSON.stringify(registrationSpans);
        expect([grantMarker, clientName].some((value) => registrationText.includes(value))).toBe(
          false,
        );

        yield* Effect.sleep("2 seconds");
        const traces = new Set(
          [
            sibling,
            unsupported,
            superseded,
            current,
            reused,
            ended,
            duplicated,
            lastUnsupported,
            padded,
            uppercase,
            ...registered,
          ].map(({ traceId }) => traceId),
        );
        const reported = yield* sentryExceptions([...traces]);
        expect(reported).toEqual([]);
        yield* evidence.json(
          "token-spans.json",
          Object.fromEntries(
            Object.entries(spans).map(([step, span]) => [
              step,
              {
                tags: Object.fromEntries(
                  Object.entries(span.tags).filter(([key]) => key.startsWith("auth.token.")),
                ),
                events: span.events.map(({ name }) => name),
              },
            ]),
          ),
        );
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
});
