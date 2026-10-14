import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { authorizationFixture } from "../support/authorization.ts";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
/**
 * An app with a `read` query and a `write` mutation and two of the owner's accounts, `first` and
 * `second`, connected from the app for one requirement, in that order. A plain requirement links
 * only the newer; many() links both. The MCP grant has two entries for the app: reading with the
 * first account and writing with the second.
 */
const grantEntryFixture = (requirement: "service" | "service.many()") =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      browser = yield* Browser,
      oauth = yield* McpOAuth,
      mcp = yield* McpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const tokens =
      requirement === "service"
        ? "ctx.user.accounts.service.fields.token"
        : 'ctx.user.accounts.service.map((account) => account.fields.token).join(",")';
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `Grant entry app ${randomUUID().slice(0, 8)}`,
      files: [
        {
          path: "index.ts",
          content: `import { defineApp, defineProvider, secrets, query, mutation, object, string, router } from "apps";
const service = defineProvider({ name: "Grant entry fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: ${requirement} } } }, async () => ({ tools: router({
  read: query({ input: object({}) }, async ctx => \`read \${${tokens}}\`),
  write: mutation({ input: object({}) }, async ctx => \`write \${${tokens}}\`),
}) }));`,
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed),
      path = `${prefix}/apps/${app.id}`;
    const accounts: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "DELETE", path);
        for (const id of accounts)
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
      }).pipe(Effect.orDie),
    );
    const connectAccount = (token: string) =>
      Effect.gen(function* () {
        const connection = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "user", "service"),
          { destination: { kind: "personal" } },
        );
        expect(connection.status, JSON.stringify(connection.body)).toBe(200);
        const request = yield* body(Resource, connection);
        const submitted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${request.id}/submit`,
          { method: "key", label: `${token} account`, fields: { token } },
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const account = yield* body(Resource, submitted);
        accounts.push(account.id);
        return account.id;
      });
    const ids = { first: yield* connectAccount("first"), second: yield* connectAccount("second") };
    yield* browser.login(actors.owner);
    const grant = yield* oauth.authorize;
    // Two entries for one app: reading with the first account, writing with the second.
    expect(
      (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
        id: grant.grantId,
        policy: {
          kind: "tools",
          approval: "client",
          apps: [
            {
              app: app.id,
              tools: { kind: "selected", names: ["read"] },
              targets: [{ kind: "account", id: ids.first }],
            },
            {
              app: app.id,
              tools: { kind: "selected", names: ["write"] },
              targets: [{ kind: "account", id: ids.second }],
            },
          ],
        },
      })).status,
    ).toBe(200);
    const client = yield* mcp.connect(
      Redacted.make(Redacted.value(grant.tokens).access_token),
      "grant-entries",
    );
    const run = (code: string) =>
      client
        .use("Execute under the two-entry grant", (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
        )
        .pipe(
          Effect.flatMap((result) =>
            Schema.decodeUnknownEffect(Execution)(result.structuredContent),
          ),
        );
    /** Call a tool with the owner's linked accounts. */
    const call = (tool: "read" | "write") =>
      run(`return await tools[${JSON.stringify(app.slug)}].${tool}({})`);
    /** The owner's linked accounts, by name, oldest link first. */
    const linked = linkedAccountIds(actors.owner, path).pipe(
      Effect.map((linked) =>
        linked.map((id) => (id === ids.first ? "first" : id === ids.second ? "second" : id)),
      ),
    );
    const link = (name: keyof typeof ids) => linkAccount(actors.owner, path, "service", ids[name]);
    const unlink = (name: keyof typeof ids) =>
      unlinkAccount(actors.owner, path, "service", ids[name]);
    /** Why a call with the owner's linked accounts is refused, from its tool error. */
    const refusal = (tool: "read" | "write") =>
      run(
        `try { await tools[${JSON.stringify(app.slug)}].${tool}({}); return null; } catch (error) { return String(error.message); }`,
      ).pipe(Effect.map(({ execution }) => execution));
    return { app, call, linked, link, unlink, refusal };
  });
layer(HostedLive, { excludeTestServices: true })("Shared authorization", (it) => {
  it.effect(scenarios.liveGrantRestrictions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, evidence, mcp, app, receipt, hidden, grant, addTool } =
          yield* authorizationFixture("mcp");
        yield* addTool;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "shared-policy",
        );
        const execute = (code: string) =>
          client.use("Execute under the selected MCP grant", (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
        const [allowed, denied, hiddenCall] = yield* Effect.all(
          [
            execute(
              `return await tools[${JSON.stringify(app.slug)}].echo({message: "shared policy"})`,
            ),
            execute(`return await tools[${JSON.stringify(app.slug)}].later({message: "denied"})`),
            execute(
              `return await tools[${JSON.stringify(hidden.app.slug)}].echo({message: "denied"})`,
            ),
          ],
          { concurrency: 3 },
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(allowed.structuredContent)).execution,
        ).toEqual({ ok: true, value: { message: "shared policy", receipt } });
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(denied.structuredContent)).execution.ok,
        ).toBe(false);
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(hiddenCall.structuredContent)).execution.ok,
        ).toBe(false);
        yield* evidence.step(
          "Deployment changes retain selections and later narrowing affects active clients",
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
                id: grant.grantId,
                policy: { kind: "tools", apps: [], approval: "client" },
              })).status,
            ).toBe(200);
            const revokedTool = yield* execute(
              `return await tools[${JSON.stringify(app.slug)}].echo({message: "denied"})`,
            );
            expect(
              (yield* Schema.decodeUnknownEffect(Execution)(revokedTool.structuredContent))
                .execution.ok,
            ).toBe(false);
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.grantEntryAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { call, linked, link } = yield* grantEntryFixture("service");
        // Connecting the second account replaced the first in the plain requirement.
        expect(yield* linked).toEqual(["second"]);
        const [writeSecond, readSecond] = yield* Effect.all([call("write"), call("read")], {
          concurrency: 2,
        });
        expect(writeSecond.execution).toEqual({ ok: true, value: "write second" });
        // Neither entry permits reading with the second account.
        expect(readSecond.execution.ok, JSON.stringify(readSecond)).toBe(false);
        // Linking the first account again replaces the second.
        yield* link("first");
        expect(yield* linked).toEqual(["first"]);
        const [readFirst, writeFirst] = yield* Effect.all([call("read"), call("write")], {
          concurrency: 2,
        });
        expect(readFirst.execution).toEqual({ ok: true, value: "read first" });
        // Neither entry permits writing with the first account.
        expect(writeFirst.execution.ok, JSON.stringify(writeFirst)).toBe(false);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.grantEntryManyAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { app, call, linked, link, unlink, refusal } =
          yield* grantEntryFixture("service.many()");
        // many() links both accounts, and a call uses every linked account.
        expect(yield* linked).toEqual(["first", "second"]);
        // Discovery lists an entry's tools with the accounts a call uses, which must all be ones
        // the entry permits. No entry permits both linked accounts, so neither tool is listed.
        const [readBoth, writeBoth] = yield* Effect.all([refusal("read"), refusal("write")], {
          concurrency: 2,
        });
        expect({ readBoth, writeBoth }).toEqual({
          readBoth: { ok: true, value: `Unknown tool '${app.slug}.read'.` },
          writeBoth: { ok: true, value: `Unknown tool '${app.slug}.write'.` },
        });
        // With only the first account linked, reading runs and writing is refused.
        yield* unlink("second");
        expect(yield* linked).toEqual(["first"]);
        const [readFirst, writeFirst] = yield* Effect.all([call("read"), call("write")], {
          concurrency: 2,
        });
        expect(readFirst.execution, JSON.stringify(readFirst)).toEqual({
          ok: true,
          value: "read first",
        });
        expect(writeFirst.execution.ok, JSON.stringify(writeFirst)).toBe(false);
        // With only the second, writing runs and reading is refused.
        yield* link("second");
        yield* unlink("first");
        expect(yield* linked).toEqual(["second"]);
        const [writeSecond, readSecond] = yield* Effect.all([call("write"), call("read")], {
          concurrency: 2,
        });
        expect(writeSecond.execution, JSON.stringify(writeSecond)).toEqual({
          ok: true,
          value: "write second",
        });
        expect(readSecond.execution.ok, JSON.stringify(readSecond)).toBe(false);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
