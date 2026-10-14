/**
 * An MCP tool call sends its checks and every read it makes for them together, in one batch: the
 * bearer recheck first, then the app, the access check with the caller's links to it, the
 * accounts, the SDK's app recheck for them and the grants of OAuth accounts, in one snapshot. An
 * MCP call names the accounts discovery resolved for it; the account reads use what the session's
 * last call naming the same accounts resolved, and the same batch reads the links live. A call
 * naming accounts the session has not called with yet reads the app and links first and sends the
 * account reads in a second batch. Every check still runs on every call against live rows; the
 * batch decides nothing a separate read would not.
 *
 * Self-host runs the batch under the PGlite client's lock, as Cloud runs it in one socket write
 * (see `cloud-tool-call-batch.spec.ts`). Each batch is one `sql.pipeline` span.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import {
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
  connectionsPath,
} from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";

const keySource = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Batch fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.user.accounts.service.fields.token),
  }),
}));`;

const oauthSource = (
  discover: string,
) => `import { defineApp, defineProvider, oauth2, object, string, query, router } from "apps";
const service = defineProvider({ name: "OAuth batch fixture", auth: {
  oauth: oauth2({ discover: ${JSON.stringify(discover)} })
} });
export default defineApp({ user: { accounts: { service } } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.user.accounts.service.fields.access_token),
  }),
}));`;

const accountlessSource = `import { defineApp, object, string, query, router } from "apps";
export default defineApp({}, {
  tools: router({ token: query({ input: object({}), output: string() }, async () => "synthetic-accountless") }),
});`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});

/** What one MCP tool call did before its app ran. */
interface CallTrace {
  /** `sql.pipeline` spans: each batch the call sent. */
  readonly batches: number;
  /** `sql.execute` spans outside the app's runtime. */
  readonly statements: number;
  /** Grant reads the resolve loop made itself, after the batch. */
  readonly liveGrantReads: number;
  readonly texts: ReadonlyArray<string>;
}

layer(HostedLive, { excludeTestServices: true })("Tool call batch", (it) => {
  it.effect(scenarios.toolCallBatch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          mcp = yield* McpClient,
          http = yield* HttpClient.HttpClient,
          issuer = yield* oauthSetupIssuer;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            accounts,
            (account) => api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`),
            { discard: true },
          ).pipe(Effect.orDie),
        );
        const deploy = (name: string, source: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: source }, appsManifest],
            });
            expect(deployed.status).toBe(200);
            const app = yield* body(App, deployed);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
            );
            return { app, path };
          });
        /** A connection from the app; the account it saves is linked for the owner. */
        const connection = (path: string) =>
          api
            .request(actors.owner, "POST", connectionsPath(path, "user", "service"), {})
            .pipe(Effect.flatMap((pending) => body(Resource, pending)));
        const keyAccount = (path: string, token: string) =>
          Effect.gen(function* () {
            const pending = yield* connection(path);
            const saved = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${pending.id}/submit`,
                {
                  method: "key",
                  label: "Synthetic",
                  fields: { token },
                },
              ),
            );
            accounts.push(saved.id);
            return saved.id;
          });
        // A call reads the caller's links to the app live. Each link change is settled before the
        // calls whose batches are measured: the owner's links read back as exactly the expected
        // accounts, so no call is made while a change is still being written.
        const settling: Record<string, Array<ReadonlyArray<string>>> = {};
        const settle = (path: string, expected: ReadonlyArray<string>) => {
          const attempts: Array<ReadonlyArray<string>> = [];
          return Effect.gen(function* () {
            for (;;) {
              const linked = yield* linkedAccountIds(actors.owner, path);
              attempts.push(linked);
              if (JSON.stringify(linked) === JSON.stringify(expected)) return;
              yield* Effect.sleep("100 millis");
            }
          }).pipe(
            Effect.timeout("30 seconds"),
            Effect.ensuring(
              Effect.suspend(() => {
                (settling[path] ??= []).push(...attempts);
                return evidence.json("batch-settled.json", settling);
              }),
            ),
          );
        };

        const key = yield* deploy("Batch key", keySource);
        const firstAccount = yield* keyAccount(key.path, "synthetic-first");
        yield* settle(key.path, [firstAccount]);

        /** An app with one linked OAuth account, signed in through the issuer. */
        const oauthApp = (name: string) =>
          Effect.gen(function* () {
            const deployed = yield* deploy(name, oauthSource(`${issuer.origin}/mcp`));
            const pending = yield* connection(deployed.path);
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${pending.id}/oauth/start`,
              { method: "oauth", label: "Synthetic OAuth" },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${pending.id}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            const account = (yield* body(Resource, completed)).id;
            accounts.push(account);
            yield* settle(deployed.path, [account]);
            return deployed;
          });
        const oauth = yield* oauthApp("Batch OAuth");
        const accountless = yield* deploy("Batch accountless", accountlessSource);
        yield* settle(accountless.path, []);

        const token = (name: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name,
            });
            expect(created.status).toBe(200);
            const pat = yield* body(Token, created);
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: pat.id })
                .pipe(Effect.orDie),
            );
            return pat;
          });
        const first = yield* mcp.connect((yield* token("Batch")).key, "batch", { organization });
        const second = yield* mcp.connect((yield* token("Batch sibling")).key, "batch-sibling", {
          organization,
        });
        type Client = typeof first;

        /** Run one execute that calls the target app's tool with its linked account; return what it did. */
        const call = (
          client: Client,
          target: { readonly app: typeof App.Type },
          operation: string,
        ) =>
          Effect.gen(function* () {
            const code = `return await tools[${JSON.stringify(target.app.slug)}].token({})`;
            const result = yield* client.use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            const { execution } = yield* Schema.decodeUnknownEffect(Execution)(
              result.structuredContent,
            );
            const request = (yield* evidence.requests)
              .filter((request) => request.path === "/mcp")
              .at(-1);
            if (request === undefined) return yield* Effect.die("MCP request evidence missing");
            const trace = yield* traceOf(request.traceId);
            return { execution, trace };
          });
        /** The last MCP tool call of a trace, once its whole trace has reached Motel. */
        const traceOf = (traceId: string) =>
          telemetry.query(traceId).pipe(
            Effect.flatMap((result) => {
              const root = result.data
                .filter((entry) => entry.span.operationName === "mcp.tool.call")
                .toSorted((a, b) => Date.parse(a.span.startTime) - Date.parse(b.span.startTime))
                .at(-1);
              const complete = result.data.some(
                (entry) => entry.span.tags["http.response.status_code"] === "200",
              );
              if (root === undefined || !complete)
                return Effect.fail(new Error("The completed server trace must reach Motel"));
              const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
              /** The span names between a span and the tool call, or undefined outside it. */
              const path = (spanId: string | null) => {
                const names: string[] = [];
                const visited = new Set<string>();
                let parent = spanId;
                while (parent !== null && !visited.has(parent)) {
                  if (parent === root.span.spanId) return names;
                  visited.add(parent);
                  const span = byId.get(parent);
                  names.push(span?.operationName ?? "");
                  parent = span?.parentSpanId ?? null;
                }
                return undefined;
              };
              const inside = result.data.filter(({ span }) => {
                const names = path(span.parentSpanId);
                return names !== undefined && !names.some((name) => name.startsWith("runtime."));
              });
              const statements = inside.filter(({ span }) => span.operationName === "sql.execute");
              const texts = statements.map(({ span }) =>
                String(span.tags["db.query.text"] ?? "")
                  .replace(/\s+/g, " ")
                  .slice(0, 80),
              );
              return statements.length === 0
                ? Effect.fail(new Error("The tool call's statements must reach Motel"))
                : Effect.succeed({
                    batches: inside.filter(({ span }) => span.operationName === "sql.pipeline")
                      .length,
                    statements: statements.length,
                    liveGrantReads: statements.filter(
                      ({ span }) =>
                        String(span.tags["db.query.text"] ?? "").includes(
                          "executor_oauth_grants",
                        ) && (path(span.parentSpanId) ?? []).includes("sdk.accounts.resolve"),
                    ).length,
                    texts,
                  } satisfies CallTrace);
            }),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            Effect.timeout("25 seconds"),
          );
        const recorded: Record<string, CallTrace> = {};
        const expectCall = (
          label: string,
          made: { readonly execution: typeof Execution.Type.execution; readonly trace: CallTrace },
          expected: {
            readonly value: string;
            readonly batches: number;
            readonly statements?: number;
          },
        ) =>
          Effect.sync(() => {
            recorded[label] = made.trace;
            expect(made.execution, label).toEqual({ ok: true, value: expected.value });
            expect(made.trace.batches, `${label}: batches`).toBe(expected.batches);
            if (expected.statements !== undefined)
              expect(made.trace.statements, `${label}: statements`).toBe(expected.statements);
          });

        yield* evidence.step(
          "A session's first call for an app reads its links, then sends its reads with them; later calls send one batch",
          Effect.gen(function* () {
            // First calls: the recheck with the app and links, then the reads for the linked
            // accounts: as many statements as reading one after another.
            yield* expectCall("key, first", yield* call(first, key, "Key account, first call"), {
              value: "synthetic-first",
              batches: 2,
              statements: 6,
            });
            yield* expectCall("key, warm", yield* call(first, key, "Key account, warm call"), {
              value: "synthetic-first",
              batches: 1,
              // Recheck, app, access check with the links, accounts, app recheck; no grant read.
              statements: 5,
            });
            const oauthFirst = yield* call(first, oauth, "OAuth account, first call");
            recorded["oauth, first"] = oauthFirst.trace;
            expect(oauthFirst.trace.batches, "OAuth account, first call").toBe(2);
            expect(oauthFirst.trace.statements, "OAuth account, first call").toBe(7);
            const oauthWarm = yield* call(first, oauth, "OAuth account, warm call");
            recorded["oauth, warm"] = oauthWarm.trace;
            expect(oauthWarm.trace.batches, "OAuth account, warm call").toBe(1);
            // The key account's five and its grant, read in the batch rather than after it.
            expect(oauthWarm.trace.statements).toBe(6);
            expect(oauthWarm.trace.liveGrantReads).toBe(0);
            yield* expectCall(
              "accountless, first",
              yield* call(first, accountless, "No accounts, first call"),
              { value: "synthetic-accountless", batches: 2, statements: 5 },
            );
            yield* expectCall(
              "accountless, warm",
              yield* call(first, accountless, "No accounts, warm call"),
              { value: "synthetic-accountless", batches: 1, statements: 4 },
            );
          }),
        );

        const other = yield* keyAccount(key.path, "synthetic-other");
        yield* evidence.step(
          "Another account linked in place of the first between calls is read with the live links, in one more batch",
          Effect.gen(function* () {
            // Connecting from the app replaced the first link: only plain requirements use the
            // provider, so the new account is the requirement's only one.
            yield* settle(key.path, [other]);
            // Discovery lists the other account, so the call names it. The session has run no call
            // with it: the first batch reads the app and links beside the recheck, the second the
            // app, the other account and the app recheck for it, as on the session's first call.
            yield* expectCall("key, switched", yield* call(first, key, "Call after a switch"), {
              value: "synthetic-other",
              batches: 2,
              statements: 6,
            });
            yield* expectCall(
              "key, warm after a switch",
              yield* call(first, key, "Warm after a switch"),
              {
                value: "synthetic-other",
                batches: 1,
                statements: 5,
              },
            );
          }),
        );

        yield* evidence.step(
          "Unlinking the app's only account refuses the call, and once it is linked again a call sends one batch",
          Effect.gen(function* () {
            yield* unlinkAccount(actors.owner, key.path, "service", other);
            yield* settle(key.path, []);
            const code = `return await tools[${JSON.stringify(key.app.slug)}].token({})`;
            const refused = yield* first
              .use("Call with no linked account", (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
              );
            yield* evidence.json("batch-unlinked.json", refused);
            expect(refused.execution.ok, "No linked account").toBe(false);
            yield* linkAccount(actors.owner, key.path, "service", other);
            yield* settle(key.path, [other]);
            // The refused call stopped at discovery, which lists an app without a linked account
            // with no tools, so it sent no batch. The call once linked names the account the
            // session's last call ran with, so its one batch reads that account beside the links.
            yield* expectCall("key, linked again", yield* call(first, key, "Call once linked"), {
              value: "synthetic-other",
              batches: 1,
              statements: 5,
            });
            yield* expectCall(
              "key, warm once linked again",
              yield* call(first, key, "Warm once linked"),
              {
                value: "synthetic-other",
                batches: 1,
                statements: 5,
              },
            );
          }),
        );

        yield* evidence.step(
          "A call whose batch read a grant another session is renewing waits for that renewal and uses its token",
          Effect.gen(function* () {
            // Its grants last 31 s, so each is inside the 30 s renewal window after a second.
            yield* issuer.configure({ refreshTokens: true, expiresIn: 31, refreshedExpiresIn: 31 });
            const renewing = yield* oauthApp("Batch OAuth renewal");
            // The sibling session is warm: its batch reads the account's grant. Its first call for
            // the app reads the links, then sends its reads with them.
            for (const [label, batches] of [
              ["Sibling session, first call", 2],
              ["Sibling session, warm call", 1],
            ] as const) {
              const made = yield* call(second, renewing, label);
              recorded[label] = made.trace;
              expect(made.execution.ok, label).toBe(true);
              expect(made.trace.batches, label).toBe(batches);
            }
            // Hold the next renewal after the service issued its tokens, and let the current grant
            // reach its renewal window.
            yield* issuer.configure({ hold: "refresh-issued" });
            yield* Effect.sleep("1500 millis");
            const before = yield* issuer.metrics;
            const renewal = yield* Effect.forkChild(call(first, renewing, "Renew the grant"));
            yield* issuer.metrics.pipe(
              Effect.flatMap((metrics) =>
                metrics.held > before.held
                  ? Effect.void
                  : Effect.fail(new Error("The renewal has not reached the service")),
              ),
              Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
            );
            // The renewal holds the grant's claim. The sibling's batch reads the claimed row.
            const waiting = yield* Effect.forkChild(
              call(second, renewing, "Call during the renewal"),
            );
            yield* Effect.sleep("1500 millis");
            yield* issuer.configure({ hold: null });
            yield* issuer.release;
            const renewed = yield* Fiber.join(renewal);
            const waited = yield* Fiber.join(waiting);
            const after = yield* issuer.metrics;
            recorded["oauth, renewing"] = renewed.trace;
            recorded["oauth, waited"] = waited.trace;
            yield* evidence.json("batch-renewal.json", {
              renewed: renewed.execution,
              waited: waited.execution,
              refreshes: after.refreshesIssued - before.refreshesIssued,
            });
            expect(after.refreshesIssued - before.refreshesIssued, "One renewal").toBe(1);
            expect(renewed.execution).toEqual({
              ok: true,
              value: `synthetic-refreshed-token-${after.refreshes}`,
            });
            expect(waited.execution, "The waiting call uses the renewed token").toEqual(
              renewed.execution,
            );
            expect(waited.trace.batches, "The waiting call sent one batch").toBe(1);
            expect(
              waited.trace.liveGrantReads,
              "It read the grant again after the claim it read in its batch",
            ).toBeGreaterThan(0);
          }),
        );
        yield* evidence.json("tool-call-batch.json", recorded);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
