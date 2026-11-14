/**
 * Local consent accepts the grant settings the sign-in page sends. Its page offers no choice yet,
 * but its grants follow the same record rule as hosted ones, and `/mcp/whoami` describes them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployLocalMcpApp } from "../support/mcp-app.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import {
  ConnectionView,
  Execution,
  consentTo,
  readWriteAppFiles,
  revokeClientGrants,
} from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { rawRequest } from "../support/role-hosts.ts";

/** `GET /mcp/whoami` with a bearer and no cookies, as a CLI sends it. */
const whoami = (token: Redacted.Redacted<string> | undefined, query = "") =>
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* rawRequest(`${target.metadata.origin}/mcp/whoami${query}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${Redacted.value(token)}` },
    });
    const parsed =
      response.text === ""
        ? null
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(response.text);
    return { ...response, body: parsed };
  });

layer(TestLive, { excludeTestServices: true })("Local MCP grant choice", (it) => {
  it.effect(scenarios.localGrantChoice.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const admin = target.apiKey;
        const headers = { authorization: `Bearer ${Redacted.value(admin)}` };
        const receipt = randomUUID();
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Grant choice ${receipt.slice(0, 8)}`,
            files: readWriteAppFiles(receipt),
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const hidden = yield* deployLocalMcpApp;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const create = (name: string, apps: readonly unknown[]) =>
          api
            .request(operator, "POST", "/dashboard/api/mcp/connections", {
              id: randomUUID(),
              name,
              apps,
            })
            .pipe(Effect.flatMap((created) => body(ConnectionView, created)));
        const connection = yield* create("Read only", [
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
        ]);
        const other = yield* create("Other", [
          { app: hidden.app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } },
        ]);
        const plain = `${target.metadata.origin}/mcp`;
        const consent = yield* evidence.step(
          "Choose the connection in the local consent of the plain MCP URL",
          consentTo(operator, plain, {
            "x-executor-grant-settings": JSON.stringify({
              access: { kind: "connection", id: connection.id },
            }),
          }),
        );
        clients.push(consent.clientId);
        expect(consent.consentResources).toEqual([plain]);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const hiddenPath = `tools[${JSON.stringify(hidden.app.slug)}]`;
        const limited = (label: string, options: { readonly connection?: string } = {}) =>
          Effect.gen(function* () {
            const client = yield* mcp.connect(token, label, options);
            const run = (operation: string, code: string) =>
              client
                .use(operation, (client, signal) =>
                  client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                  ),
                );
            const [read, write, excluded] = yield* Effect.all(
              [
                run("Call the connection's read tool", `return await ${appPath}.read({})`),
                run(
                  "Call a tool the connection excludes",
                  `return await ${appPath}.write({message: "x"})`,
                ),
                run(
                  "Call an app the connection excludes",
                  `return await ${hiddenPath}.echo({message: "x"})`,
                ),
              ],
              { concurrency: 3 },
            );
            expect(read.execution).toEqual({ ok: true, value: { read: receipt } });
            expect(write.execution.ok).toBe(false);
            expect(excluded.execution.ok).toBe(false);
          });
        yield* evidence.step(
          "The plain MCP URL serves only the chosen connection",
          limited("local-chosen-plain"),
        );
        yield* evidence.step(
          "An address naming another connection still serves the chosen one",
          limited("local-chosen-other-address", { connection: other.id }),
        );
        yield* evidence.step(
          "whoami describes the connection grant and the administrative key",
          Effect.gen(function* () {
            const scoped = yield* whoami(token, "?elicitation_mode=browser");
            expect(scoped.status, scoped.text).toBe(200);
            expect(scoped.body).toEqual({
              organization: null,
              access: { kind: "connection", id: connection.id, name: connection.name, apps: 1 },
              mode: "model",
            });
            // The administrative key has no record: full access in the URL's mode.
            const key = yield* whoami(admin, "?elicitation_mode=native");
            expect(key.status, key.text).toBe(200);
            expect(key.body).toEqual({
              organization: null,
              access: { kind: "all" },
              mode: "native",
            });
            const keyConnection = yield* whoami(admin, `?connection=${connection.id}`);
            expect(keyConnection.status).toBe(403);
            expect(keyConnection.body).toMatchObject({
              error: { data: { code: "GrantForbidden" } },
            });
            const anonymous = yield* whoami(undefined);
            expect(anonymous.status).toBe(401);
            expect(anonymous.challenge).toContain(
              "/.well-known/oauth-protected-resource/mcp?elicitation_mode=model",
            );
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
