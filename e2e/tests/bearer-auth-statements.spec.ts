/**
 * MCP and API bearer authentication reads the token, its grant, consent and connection, and
 * the caller's membership in one SQL statement. MCP authenticates every request and every tool
 * call inside `execute`, and each statement is a network round trip to Cloud's database, so the
 * statement count under `auth.authenticate` is the regression guard. The PAT and OAuth paths
 * read different rows, so both are checked, through MCP and through the Executor API. Each
 * `auth.authenticate` also names the organization it resolved, by its opaque ID, so its latency
 * can be split by organization.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { scenarios } from "../test-plan.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Bearer authentication", (it) => {
  it.effect(scenarios.bearerAuthStatements.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const organization = actors.organization.id;

        /**
         * SQL statements under each `auth.authenticate` span of a completed request's trace, and
         * the organization each recorded.
         */
        const statements = (traceId: string) =>
          telemetry.query(traceId).pipe(
            Effect.flatMap((result) => {
              const roots = result.data.filter(
                (entry) => entry.span.operationName === "auth.authenticate",
              );
              const complete = result.data.some(
                (entry) => entry.span.tags["http.response.status_code"] === "200",
              );
              if (roots.length === 0 || !complete)
                return Effect.fail(new Error("The completed server trace must reach Motel"));
              const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
              const under = (root: string, spanId: string | null) => {
                const visited = new Set<string>();
                let parent = spanId;
                while (parent !== null && !visited.has(parent)) {
                  if (parent === root) return true;
                  visited.add(parent);
                  parent = byId.get(parent)?.parentSpanId ?? null;
                }
                return false;
              };
              return Effect.succeed(
                roots.map((root) => ({
                  statements: result.data.filter(
                    ({ span }) =>
                      span.operationName === "sql.execute" &&
                      under(root.span.spanId, span.parentSpanId),
                  ).length,
                  organization: root.span.tags["executor.organization.id"],
                })),
              );
            }),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            Effect.timeout("25 seconds"),
          );
        const lastMcpRequest = evidence.requests.pipe(
          Effect.map((requests) => requests.filter((request) => request.path === "/mcp").at(-1)),
          Effect.flatMap((request) =>
            request === undefined
              ? Effect.die(new Error("MCP request evidence missing"))
              : Effect.succeed(request),
          ),
        );
        const expectOneStatement = (label: string, traceId: string) =>
          Effect.gen(function* () {
            const roots = yield* statements(traceId);
            yield* evidence.json(`${label}-auth-statements.json`, { traceId, roots });
            expect(
              roots.map((root) => root.statements),
              `${label} authenticates with one SQL statement`,
            ).toEqual(roots.map(() => 1));
            expect(
              roots.map((root) => root.organization),
              `${label} records the organization it authenticated for`,
            ).toEqual(roots.map(() => organization));
          });

        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Bearer statements",
        });
        expect(created.status).toBe(200);
        const key = yield* body(Token, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );

        yield* evidence.step(
          "A PAT authenticates the Executor API with one statement",
          Effect.gen(function* () {
            const anonymous = yield* api.session();
            const context = yield* api.request(anonymous, "GET", "/api/context", undefined, {
              authorization: `Bearer ${Redacted.value(key.key)}`,
              "x-executor-organization": organization,
            });
            expect(context.status).toBe(200);
            const request = (yield* evidence.requests).at(-1);
            if (request === undefined)
              return yield* Effect.die(new Error("Request evidence missing"));
            yield* expectOneStatement("pat-api", request.traceId);
          }),
        );

        yield* evidence.step(
          "A PAT authenticates MCP with one statement",
          Effect.gen(function* () {
            const client = yield* mcp.connect(key.key, "pat", { organization });
            yield* client.use("List tools with the PAT", (client) => client.listTools());
            yield* expectOneStatement("pat-mcp", (yield* lastMcpRequest).traceId);
          }),
        );

        yield* browser.login(actors.owner);
        const grant = yield* evidence.step(
          "Authorize an MCP grant in the browser",
          oauth.authorize,
        );
        yield* evidence.step(
          "An OAuth grant authenticates MCP with one statement",
          Effect.gen(function* () {
            const client = yield* mcp.connect(
              Redacted.make(Redacted.value(grant.tokens).access_token),
              "oauth",
            );
            yield* client.use("List tools with the OAuth grant", (client) => client.listTools());
            yield* expectOneStatement("oauth-mcp", (yield* lastMcpRequest).traceId);
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
