/**
 * An MCP tool call checks its access and reads its stored state before the app runs, and each
 * SQL statement is a network round trip from Cloud's session object to the database. The check
 * reads the app, then checks membership with the app's policy and reads the caller's linked
 * accounts in one statement. The call then reads the app and the accounts it runs, after that
 * check, and rechecks the caller's use of the app with its accounts in one more statement. An
 * OAuth account's grant is read in one more. The statement count under `mcp.tool.call`, outside
 * the app's own runtime, is the regression guard.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { linkedAccountIds, connectionsPath } from "../support/app-accounts.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const keySource = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Statement fixture", auth: {
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
const service = defineProvider({ name: "OAuth statement fixture", auth: {
  oauth: oauth2({ discover: ${JSON.stringify(discover)} })
} });
export default defineApp({ user: { accounts: { service } } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.user.accounts.service.fields.access_token),
  }),
}));`;

const unlinkedSource = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Unlinked statement fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => "synthetic-unlinked-" + ctx.user.accounts.service.length),
  }),
}));`;

const accountlessSource = `import { defineApp, object, string, query, router } from "apps";
export default defineApp({}, {
  tools: router({ token: query({ input: object({}), output: string() }, async () => "synthetic-accountless") }),
});`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Tool call statements", (it) => {
  it.effect(scenarios.toolCallStatements.title, (context) =>
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
            (account) =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
                .pipe(Effect.map((response) => expect(response.status).toBe(200))),
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
              api.request(actors.owner, "DELETE", path).pipe(
                Effect.map((response) => expect(response.status).toBe(200)),
                Effect.orDie,
              ),
            );
            return { app, path };
          });
        // Connecting an account from the app links it for the owner.
        const connection = (path: string) =>
          api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}).pipe(
            Effect.tap((pending) => Effect.sync(() => expect(pending.status).toBe(200))),
            Effect.flatMap((pending) => body(Resource, pending)),
          );
        const linked = (path: string, account: string) =>
          Effect.gen(function* () {
            accounts.push(account);
            expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
          });

        const key = yield* deploy("Tool call statements", keySource);
        const keyConnection = yield* connection(key.path);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${keyConnection.id}/submit`,
          { method: "key", label: "Synthetic", fields: { token: "synthetic-statements" } },
        );
        expect(saved.status).toBe(200);
        yield* linked(key.path, (yield* body(Resource, saved)).id);

        const oauth = yield* deploy(
          "OAuth tool call statements",
          oauthSource(`${issuer.origin}/mcp`),
        );
        const oauthConnection = yield* connection(oauth.path);
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${oauthConnection.id}/oauth/start`,
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
          `${prefix}/connections/${oauthConnection.id}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        yield* linked(oauth.path, (yield* body(Resource, completed)).id);

        const unlinked = yield* deploy("Unlinked tool call statements", unlinkedSource);
        const accountless = yield* deploy("Accountless tool call statements", accountlessSource);

        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Tool call statements",
        });
        expect(created.status).toBe(200);
        const token = yield* body(Token, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(token.key, "pat", { organization });

        /** Call the tool with the caller's linked accounts and return the SQL made before the app ran. */
        const statements = (target: typeof key, returned: string, operation: string) =>
          Effect.gen(function* () {
            const code = `return await tools[${JSON.stringify(target.app.slug)}].token({})`;
            const called = yield* client.use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            expect(JSON.stringify(called.structuredContent)).toContain(returned);
            const request = (yield* evidence.requests)
              .filter((request) => request.path === "/mcp")
              .at(-1);
            if (request === undefined)
              return yield* Effect.die(new Error("MCP request evidence missing"));
            // Statements the session makes for the call: everything under the tool call except
            // the app's own runtime, which reads nothing for this tool.
            const reads = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) => {
                const root = result.data.find(
                  (entry) => entry.span.operationName === "mcp.tool.call",
                );
                const complete = result.data.some(
                  (entry) => entry.span.tags["http.response.status_code"] === "200",
                );
                if (root === undefined || !complete)
                  return Effect.fail(new Error("The completed server trace must reach Motel"));
                const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
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
                const reads = result.data.flatMap(({ span }) => {
                  if (span.operationName !== "sql.execute") return [];
                  const names = path(span.parentSpanId);
                  if (names === undefined || names.some((name) => name.startsWith("runtime.")))
                    return [];
                  return [
                    String(span.tags["db.query.text"] ?? "")
                      .replace(/\s+/g, " ")
                      .slice(0, 80),
                  ];
                });
                return reads.length === 0
                  ? Effect.fail(new Error("SQL descendants must reach Motel"))
                  : Effect.succeed(reads);
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.timeout("25 seconds"),
            );
            return { traceId: request.traceId, count: reads.length, statements: reads };
          });

        const keyCall = yield* statements(
          key,
          "synthetic-statements",
          "Call a tool with a linked key account",
        );
        const oauthCall = yield* statements(
          oauth,
          "synthetic-access-token",
          "Call a tool with a linked OAuth account",
        );
        const emptyCall = yield* statements(
          unlinked,
          "synthetic-unlinked-0",
          "Call a tool whose requirement has no linked accounts",
        );
        const appCall = yield* statements(
          accountless,
          "synthetic-accountless",
          "Call a tool of an app without requirements",
        );
        yield* evidence.json("tool-call-statements.json", {
          key: keyCall,
          oauth: oauthCall,
          empty: emptyCall,
          app: appCall,
        });
        expect(
          keyCall.count,
          "Authentication, the check's read of the app, one access and links check, the call's two reads and one recheck",
        ).toBe(6);
        expect(
          oauthCall.count,
          "The key account's statements and one read of the OAuth grant",
        ).toBe(7);
        expect(
          emptyCall.count,
          "Authentication, the check's read of the app, one access and links check, the call's read of the app and one recheck",
        ).toBe(5);
        expect(
          appCall.count,
          "Authentication, the check's read of the app, one access check, the call's read of the app and one recheck",
        ).toBe(5);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
