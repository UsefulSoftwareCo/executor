/** Scoped connections: each has its own MCP URL, and its grants follow the current record. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import {
  accountLinks,
  connectionsPath,
  linkAccount,
  linkedAccountIds,
} from "../support/app-accounts.ts";
import {
  ConnectionView,
  Execution,
  consentTo,
  readWriteAppFiles,
  revokeClientGrants,
  TargetRefusal,
} from "../support/mcp-connections.ts";
import { holdTools, untilHeld } from "../support/held-call.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { managementApp } from "../support/management-app.ts";
import { targetHosts } from "../support/role-hosts.ts";

const Search = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
});

/** Deploy the read/write fixture into the scenario's organization. */
const deployReadWriteApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const receipt = randomUUID();
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Scoped app ${receipt.slice(0, 8)}`,
    files: readWriteAppFiles(receipt),
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
  return { app, receipt };
});

/** Create a connection through the browser-only product route. */
const createConnection = (session: Session, apps: readonly unknown[]) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const created = yield* api.request(
      session,
      "POST",
      `/api/organizations/${actors.organization.id}/mcp-connections`,
      { id: randomUUID(), name: `Connection ${randomUUID().slice(0, 6)}`, apps },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return yield* body(ConnectionView, created);
  });

/** Run code through one MCP client's `execute` tool and decode its completion. */
const executor =
  (client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>) =>
  (operation: string, code: string) =>
    client
      .use(operation, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
      )
      .pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Execution)(result.structuredContent)),
      );

layer(HostedLive, { excludeTestServices: true })("Scoped MCP connections", (it) => {
  it.effect(scenarios.scopedConnectionAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const [{ app, receipt }, hidden] = yield* Effect.all([deployReadWriteApp, deployMcpApp], {
          concurrency: 2,
        });
        const connection = yield* evidence.step(
          "Create a connection with one app's read-only tools",
          createConnection(actors.owner, [
            { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
          ]),
        );
        expect(connection.url).toBe(`${targetHosts(target).mcp}/mcp?connection=${connection.id}`);
        expect(connection.policy.apps).toEqual([
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
        ]);
        // MCP grants cannot manage connections, including a full-access one: the API refuses MCP tokens.
        yield* browser.login(actors.owner);
        const full = yield* evidence.step(
          "Authorize the full-access URL for comparison",
          oauth.authorize,
        );
        const fullBearer = {
          authorization: `Bearer ${Redacted.value(full.tokens).access_token}`,
        };
        expect(
          (yield* api.request(
            yield* api.session(),
            "GET",
            `${prefix}/mcp-connections`,
            undefined,
            fullBearer,
          )).status,
        ).toBe(401);
        const grant = yield* evidence.step(
          "Authorize the connection's own URL through browser consent",
          oauth.authorizeConnection(connection.id),
        );
        const scoped = executor(
          yield* mcp.connect(Redacted.make(Redacted.value(grant.tokens).access_token), "scoped", {
            connection: connection.id,
          }),
        );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const hiddenPath = `tools[${JSON.stringify(hidden.app.slug)}]`;
        yield* evidence.step(
          "Discovery and calls include only the connection's read-only tool",
          Effect.gen(function* () {
            const found = yield* scoped(
              "Search the connection's catalog",
              `return await tools.search({query: ${JSON.stringify(app.name)}, limit: 20})`,
            );
            const paths = (yield* Schema.decodeUnknownEffect(Search)(
              found.execution.value,
            )).items.map((item) => item.path);
            expect(paths).toContain(`${appPath}.read`);
            expect(paths).not.toContain(`${appPath}.write`);
            const hiddenSearch = yield* scoped(
              "Search for an excluded app",
              `return await tools.search({query: ${JSON.stringify(hidden.name)}, limit: 20})`,
            );
            expect(
              (yield* Schema.decodeUnknownEffect(Search)(hiddenSearch.execution.value)).items,
            ).toEqual([]);
            const [read, write, excluded] = yield* Effect.all(
              [
                scoped("Call the read tool", `return await ${appPath}.read({})`),
                scoped("Call the write tool", `return await ${appPath}.write({message: "denied"})`),
                scoped(
                  "Call an excluded app",
                  `return await ${hiddenPath}.echo({message: "denied"})`,
                ),
              ],
              { concurrency: 3 },
            );
            expect(read.execution).toEqual({ ok: true, value: { read: receipt } });
            expect(write.execution.ok).toBe(false);
            expect(excluded.execution.ok).toBe(false);
          }),
        );
        yield* evidence.step(
          "The full-access grant is unchanged",
          Effect.gen(function* () {
            const unscoped = executor(
              yield* mcp.connect(Redacted.make(Redacted.value(full.tokens).access_token), "full"),
            );
            const [write, other] = yield* Effect.all(
              [
                unscoped("Full access writes", `return await ${appPath}.write({message: "ok"})`),
                unscoped(
                  "Full access uses other apps",
                  `return await ${hiddenPath}.echo({message: "ok"})`,
                ),
              ],
              { concurrency: 2 },
            );
            expect(write.execution).toEqual({ ok: true, value: { wrote: "ok" } });
            expect(other.execution).toEqual({
              ok: true,
              value: { message: "ok", receipt: hidden.receipt },
            });
            // At the full-access URL, a connection's token still reaches only its connection: the
            // grant's record, not the URL, decides what it serves.
            const moved = executor(
              yield* mcp.connect(Redacted.make(Redacted.value(grant.tokens).access_token), "moved"),
            );
            const [movedRead, movedWrite, movedOther] = yield* Effect.all(
              [
                moved("Read at the full-access URL", `return await ${appPath}.read({})`),
                moved(
                  "Write at the full-access URL",
                  `return await ${appPath}.write({message: "denied"})`,
                ),
                moved(
                  "Another app at the full-access URL",
                  `return await ${hiddenPath}.echo({message: "denied"})`,
                ),
              ],
              { concurrency: 3 },
            );
            expect(movedRead.execution).toEqual({ ok: true, value: { read: receipt } });
            expect(movedWrite.execution.ok).toBe(false);
            expect(movedOther.execution.ok).toBe(false);
          }),
        );
        yield* evidence.step(
          "Editing the connection changes a connected client's next call",
          Effect.gen(function* () {
            const updated = yield* api.request(
              actors.owner,
              "PUT",
              `${prefix}/mcp-connections/${connection.id}`,
              {
                name: connection.name,
                apps: [
                  {
                    app: app.id,
                    runsAs: [{ kind: "app" }],
                    tools: { kind: "selected", names: ["write"] },
                  },
                ],
              },
            );
            expect(updated.status, JSON.stringify(updated.body)).toBe(200);
            const [read, write] = yield* Effect.all(
              [
                scoped("Read is no longer selected", `return await ${appPath}.read({})`),
                scoped(
                  "The selected write tool runs",
                  `return await ${appPath}.write({message: "selected"})`,
                ),
              ],
              { concurrency: 2 },
            );
            expect(read.execution.ok).toBe(false);
            expect(write.execution).toEqual({ ok: true, value: { wrote: "selected" } });
          }),
        );
        yield* evidence.step(
          "Revoking the connection ends its grants and URL",
          Effect.gen(function* () {
            expect(
              (yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/mcp-connections/${connection.id}/revoke`,
              )).status,
            ).toBe(200);
            const after = yield* Effect.exit(
              scoped("Call after revocation", `return await ${appPath}.write({message: "x"})`),
            );
            expect(Exit.isFailure(after)).toBe(true);
            expect(yield* oauth.refreshStatus(grant)).not.toBe(200);
            const listed = yield* body(
              Schema.Array(ConnectionView),
              yield* api.request(actors.owner, "GET", `${prefix}/mcp-connections`),
            );
            expect(listed.map((item) => item.id)).not.toContain(connection.id);
            const reused = yield* consentTo(actors.owner, connection.url);
            expect(reused.refused).toBe("invalid_target");
          }),
        );
        yield* evidence.step(
          "A connection made again with the revoked ID is new; the old grant stays revoked",
          Effect.gen(function* () {
            const again = yield* api.request(actors.owner, "POST", `${prefix}/mcp-connections`, {
              id: connection.id,
              name: connection.name,
              apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }],
            });
            expect(again.status, JSON.stringify(again.body)).toBe(200);
            expect((yield* body(ConnectionView, again)).url).toBe(connection.url);
            const old = yield* Effect.exit(
              scoped(
                "The revoked grant's token at the URL again",
                `return await ${appPath}.read({})`,
              ),
            );
            expect(Exit.isFailure(old)).toBe(true);
            expect(yield* oauth.refreshStatus(grant)).not.toBe(200);
            const renewed = yield* oauth.authorizeConnection(connection.id);
            const current = executor(
              yield* mcp.connect(
                Redacted.make(Redacted.value(renewed.tokens).access_token),
                "again",
                {
                  connection: connection.id,
                },
              ),
            );
            const read = yield* current("A new grant reads", `return await ${appPath}.read({})`);
            expect(read.execution).toEqual({ ok: true, value: { read: receipt } });
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.scopedConnectionAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Account app ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Connection account fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({ who: query({ input: object({}) }, async ctx => ctx.user.accounts.service.fields.token) }) }));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [],
          clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        // Connecting from the app saves the account and links it for the owner.
        const connectAccount = (token: string) =>
          Effect.gen(function* () {
            const connection = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(path, "user", "service"),
              {},
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
        // Each account connected for the plain requirement replaces the one linked before; the
        // replaced accounts stay saved.
        const work = yield* connectAccount("work");
        const personal = yield* connectAccount("personal");
        const bare = yield* connectAccount("bare");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([bare]);
        // A bare account: saved, but no longer linked to the app.
        yield* linkAccount(actors.owner, path, "service", work);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([work]);
        const connection = yield* createConnection(actors.owner, [
          { app: app.id, runsAs: [{ kind: "account", id: work }], tools: { kind: "all" } },
        ]);
        expect(connection.policy.apps[0]?.runsAs).toEqual([{ kind: "account", id: work }]);
        const consent = yield* consentTo(actors.owner, connection.url);
        clients.push(consent.clientId);
        expect(consent.status, JSON.stringify(consent)).toBe(200);
        const run = executor(
          yield* mcp.connect(yield* consent.tokens, "accounts", { connection: connection.id }),
        );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        // The connection sees only its account, and the call runs as it.
        const called = yield* run("The selected account runs", `return await ${appPath}.who({})`);
        expect(called.execution).toEqual({ ok: true, value: "work" });
        // A call cannot name another account instead.
        const named = yield* run(
          "A call that names another account is refused before it runs",
          `try { return await ${appPath}.who({ $accounts: { service: ${JSON.stringify(personal)} } }); } catch (error) { return JSON.parse(error.message); }`,
        );
        expect(named.execution).toMatchObject({
          ok: true,
          value: { code: "AccountChoiceUnsupported", status: 400 },
        });
        // A member who can use the app cannot save a connection that runs as the owner's own
        // account: it is refused for the account and nothing is linked for the member.
        const access = `${path}/access`;
        const { revision } = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", access),
        );
        const shared = yield* api.request(actors.owner, "PATCH", access, {
          revision,
          audience: { kind: "everyone" },
        });
        expect(shared.status, JSON.stringify(shared.body)).toBe(200);
        const borrowed = yield* api.request(actors.member, "POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: `Connection ${randomUUID().slice(0, 6)}`,
          apps: [{ app: app.id, runsAs: [{ kind: "account", id: work }], tools: { kind: "all" } }],
        });
        expect(borrowed.status, JSON.stringify(borrowed.body)).toBe(400);
        expect(borrowed.body).toMatchObject({ _tag: "ConnectionAccessInvalid", reason: "account" });
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        // Another account linked in place of the connection's is outside the connection: the
        // call is refused and nothing is substituted.
        yield* linkAccount(actors.owner, path, "service", personal);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([personal]);
        const other = yield* run(
          "Another linked account is outside the connection",
          `return await ${appPath}.who({})`,
        );
        expect(other.execution.ok, JSON.stringify(other)).toBe(false);
        expect(JSON.stringify(other)).not.toContain('"personal"');
        // Selecting a bare account links it to the app, as connecting it from the app would, in
        // place of the plain requirement's linked account.
        const bareConnection = yield* createConnection(actors.owner, [
          { app: app.id, runsAs: [{ kind: "account", id: bare }], tools: { kind: "all" } },
        ]);
        expect(bareConnection.policy.apps[0]?.runsAs).toEqual([{ kind: "account", id: bare }]);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([bare]);
        const bareConsent = yield* consentTo(actors.owner, bareConnection.url);
        clients.push(bareConsent.clientId);
        const bareRun = executor(
          yield* mcp.connect(yield* bareConsent.tokens, "bare", { connection: bareConnection.id }),
        );
        const bareCall = yield* bareRun(
          "The linked bare account runs",
          `return await ${appPath}.who({})`,
        );
        expect(bareCall.execution).toEqual({ ok: true, value: "bare" });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.scopedConnectionLinkSwappedMidExecution.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Swap app ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, query, mutation, object, string, boolean, router } from "apps";
const service = defineProvider({ name: "Swap account fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({
  who: query({ input: object({}) }, async ctx => ctx.user.accounts.service.fields.token),
  ${holdTools}
}) }));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [],
          clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
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
              {},
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
        const replacement = yield* connectAccount("replacement");
        const granted = yield* connectAccount("granted");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([granted]);
        const connection = yield* createConnection(actors.owner, [
          { app: app.id, runsAs: [{ kind: "account", id: granted }], tools: { kind: "all" } },
        ]);
        const consent = yield* consentTo(actors.owner, connection.url);
        clients.push(consent.clientId);
        const client = yield* mcp.connect(yield* consent.tokens, "link-swap", {
          connection: connection.id,
        });
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        const run = yield* client
          .use("Call with the granted account, wait, and call again", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `const first = await ${tools}.who({});
await ${tools}.hold({});
let second;
try { second = await ${tools}.who({}); } catch (error) { second = { refused: String(error.message) }; }
return { first, second };`,
                },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(Effect.forkChild);
        const call = (tool: string, kind: "query" | "mutation") =>
          api
            .request(actors.owner, "POST", `${path}/tools/call`, { tool, kind, input: {} })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
              ),
            );
        yield* untilHeld(
          call("holding", "query").pipe(
            Effect.flatMap((response) => body(Schema.Boolean, response)),
          ),
        );
        // The link is replaced while the execution is held; the connection still names the first.
        yield* linkAccount(actors.owner, path, "service", replacement);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([replacement]);
        yield* call("release", "mutation");
        const result = yield* Fiber.join(run);
        yield* evidence.json("link-swap-execution.json", result.structuredContent);
        const { execution } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({
                first: Schema.String,
                second: Schema.Struct({ refused: Schema.String }),
              }),
            }),
          }),
        )(result.structuredContent);
        expect(execution.value.first).toBe("granted");
        // The pinned account is no longer linked. Report setup recovery, not an organization
        // permission failure, and never run with or name the replacement.
        expect(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TargetRefusal))(
            execution.value.second.refused,
          ),
        ).toMatchObject({
          code: "ConnectionAccountUnlinked",
          status: 409,
          message: `This connection runs as account ${granted}, which is no longer linked to this app for you. Relink it, or edit the connection to run as another of your accounts.`,
          recovery: {
            action: "Relink the account, or edit the connection to run as another account.",
          },
          retryable: false,
        });
        expect(execution.value.second.refused).not.toContain(replacement);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.scopedConnectionConsent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const { app } = yield* deployReadWriteApp;
        const connection = yield* createConnection(actors.owner, [
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } },
        ]);
        const clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        const member = yield* consentTo(actors.member, connection.url);
        expect(member.status).toBe(403);
        const elsewhere = yield* consentTo(actors.owner, connection.url, {
          "x-executor-organization": `org_${randomUUID().replaceAll("-", "")}`,
        });
        expect(elsewhere.status).toBe(403);
        // Another user can neither read nor change it.
        const memberList = yield* body(
          Schema.Array(ConnectionView),
          yield* api.request(actors.member, "GET", `${prefix}/mcp-connections`),
        );
        expect(memberList.map((item) => item.id)).not.toContain(connection.id);
        expect(
          (yield* api.request(
            actors.member,
            "POST",
            `${prefix}/mcp-connections/${connection.id}/revoke`,
          )).status,
        ).toBe(404);
        const owner = yield* consentTo(actors.owner, connection.url);
        clients.push(owner.clientId);
        expect(owner.status).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.scopedConnectionDashboard.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const { app } = yield* deployReadWriteApp;
        const list = api
          .request(actors.owner, "GET", `${prefix}/mcp-connections`)
          .pipe(Effect.flatMap((response) => body(Schema.Array(ConnectionView), response)));
        yield* browser.login(actors.owner);
        // LAN HTTP exposes getRandomValues, but not randomUUID. Keep the real API and UI.
        if (target.metadata.target === "self-host")
          yield* browser.use("Reproduce missing native UUIDs on HTTP", (page) =>
            page.addInitScript(() => {
              Reflect.deleteProperty(Crypto.prototype, "randomUUID");
            }),
          );
        yield* browser.use("Open Connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        if (target.metadata.target === "self-host")
          expect(
            yield* browser.use("Native browser UUIDs are unavailable", (page) =>
              page.evaluate(() => typeof crypto.randomUUID),
            ),
          ).toBe("undefined");
        yield* browser.use("Connect with full access", (page) =>
          page
            .getByRole("listitem", { name: "Full access" })
            .getByRole("button", { name: "Connect", exact: true })
            .click(),
        );
        yield* browser.use("Show assistant-specific instructions", (page) =>
          page.getByRole("heading", { name: "Connect an assistant", exact: true }).waitFor(),
        );
        yield* browser.use("Choose Codex", (page) =>
          page.getByRole("button", { name: "Codex", exact: true }).click(),
        );
        yield* browser.use("Allow clipboard access", (page) =>
          page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
        );
        yield* browser.use("Copy the Codex sign-in command", (page) =>
          page.getByRole("button", { name: "Copy sign-in command", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied sign-in command", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe("codex mcp login executor");
        yield* browser.use("Copy the Codex command", (page) =>
          page.getByRole("button", { name: "Copy assistant setup", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied command", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(`codex mcp add executor --url '${targetHosts(target).mcp}/mcp'`);
        yield* browser.use("Switch to OpenCode", (page) =>
          page.getByRole("button", { name: "OpenCode", exact: true }).click(),
        );
        yield* browser.use("Copy the OpenCode command", (page) =>
          page.getByRole("button", { name: "Copy assistant setup", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied OpenCode command", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(`opencode mcp add executor --url '${targetHosts(target).mcp}/mcp'`);
        yield* browser.use("Copy the OpenCode sign-in command", (page) =>
          page.getByRole("button", { name: "Copy sign-in command", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied OpenCode sign-in command", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe("opencode mcp auth executor");
        yield* browser.use("Switch to Claude", (page) =>
          page.getByRole("button", { name: "Claude", exact: true }).click(),
        );
        expect(
          yield* browser.use("Claude offers its connector settings", (page) =>
            page
              .getByRole("link", { name: "Open Claude connectors", exact: true })
              .getAttribute("href"),
          ),
        ).toBe("https://claude.ai/customize/connectors");
        yield* browser.use("The captured screenshot loads beside the steps", (page) =>
          page.waitForFunction(() => {
            const image = document.querySelector(
              `img[alt="Claude's Add custom connector dialog with Executor entered"]`,
            );
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
          }),
        );
        yield* browser.checkpoint("Claude setup with live screenshot");
        yield* browser.use("Enlarge the Claude screenshot", (page) =>
          page
            .getByRole("button", {
              name: "Enlarge screenshot: Claude’s Add custom connector dialog",
              exact: true,
            })
            .click(),
        );
        yield* browser.use("The full-size screenshot opens", (page) =>
          page
            .getByRole("dialog", { name: "Claude’s Add custom connector dialog" })
            .getByRole("img")
            .waitFor({ state: "visible" }),
        );
        // Radix paints the dialog and moves focus into it before the render that makes it the
        // topmost layer: until then the setup dialog beneath still owns Escape, and Escape closes
        // both. That render is the one where the setup dialog stops taking pointer input and the
        // full-size screenshot starts to.
        yield* browser.use("The full-size screenshot takes focus", (page) =>
          page
            .getByRole("dialog", { name: "Claude’s Add custom connector dialog" })
            .and(page.locator(":focus-within"))
            .waitFor(),
        );
        yield* browser.use("The full-size screenshot is the topmost dialog", (page) =>
          page.waitForFunction(
            ({ top, beneath }) => {
              const dialog = (title: string) =>
                [...document.querySelectorAll('[role="dialog"]')].find(
                  (element) =>
                    document.getElementById(element.getAttribute("aria-labelledby") ?? "")
                      ?.textContent === title,
                );
              const screenshot = dialog(top),
                setup = dialog(beneath);
              return (
                screenshot !== undefined &&
                setup !== undefined &&
                getComputedStyle(screenshot).pointerEvents === "auto" &&
                getComputedStyle(setup).pointerEvents === "none"
              );
            },
            { top: "Claude’s Add custom connector dialog", beneath: "Connect Full access" },
          ),
        );
        yield* browser.use("Close the full-size screenshot", (page) =>
          page.keyboard.press("Escape"),
        );
        yield* browser.use("Choose Grok Bot setup", (page) =>
          page.getByRole("button", { name: "Grok Bot", exact: true }).click(),
        );
        yield* browser.use("Grok Bot gets a message to add the MCP server", (page) =>
          page
            .getByText("Add Executor as a remote MCP server named executor", { exact: false })
            .waitFor(),
        );
        expect(
          yield* browser.use("Grok Bot no longer links to the plugin", (page) =>
            page.getByRole("link", { name: "Install Executor for Grok Bot", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Assistant setup with sign-in instructions");
        yield* browser.use("Choose personal access token setup", (page) =>
          page.getByRole("tab", { name: "Personal access token", exact: true }).click(),
        );
        expect(
          yield* browser.use("Token setup names this organization's MCP address", (page) =>
            page
              .getByRole("tabpanel")
              .getByText(`/org/${actors.organization.slug}/mcp`, { exact: false })
              .first()
              .waitFor()
              .then(() =>
                page.getByRole("link", { name: "Manage tokens", exact: true }).getAttribute("href"),
              ),
          ),
        ).toBe(`/account/tokens?organization=${actors.organization.slug}`);
        yield* browser.use("Close the full-access setup", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Start a new connection", (page) =>
          page.getByRole("link", { name: "New connection", exact: true }).click(),
        );
        yield* browser.use("Name the connection", (page) =>
          page.getByLabel("Name", { exact: true }).fill("Support assistant"),
        );
        yield* browser.use("Find the app", (page) =>
          page.getByRole("searchbox", { name: "Search apps" }).fill(app.name),
        );
        yield* browser.use("Include the app", (page) =>
          page.getByRole("checkbox", { name: app.name }).click(),
        );
        yield* browser.use("Open the tool scope", (page) =>
          page.getByRole("combobox", { name: `Tools for ${app.name}` }).click(),
        );
        yield* browser.use("Choose read-only tools", (page) =>
          page.getByRole("option", { name: "Read-only tools", exact: true }).click(),
        );
        yield* browser.checkpoint("New connection with one read-only app");
        yield* browser.use("Create the connection", (page) =>
          page.getByRole("button", { name: "Create connection", exact: true }).click(),
        );
        yield* browser.use("The saved connection opens", (page) =>
          page
            .getByRole("heading", { name: "Support assistant", exact: true })
            .waitFor({ state: "visible" }),
        );
        const [saved] = yield* list;
        expect(saved?.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(saved?.policy.apps).toEqual([
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
        ]);
        yield* browser.use("Open the connection's setup", (page) =>
          page.getByRole("button", { name: "Connect", exact: true }).click(),
        );
        yield* browser.use("The connection shows its own MCP URL", (page) =>
          page
            .getByText(`${targetHosts(target).mcp}/mcp?connection=${saved?.id}`)
            .first()
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Choose Codex for the scoped connection", (page) =>
          page.getByRole("button", { name: "Codex", exact: true }).click(),
        );
        yield* browser.use("Copy the scoped setup command", (page) =>
          page.getByRole("button", { name: "Copy assistant setup", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the scoped setup command", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(
          `codex mcp add executor --url '${targetHosts(target).mcp}/mcp?connection=${saved?.id}'`,
        );
        yield* browser.checkpoint("Saved connection with its MCP URL");
        yield* browser.use("Close the connection's setup", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Return to the connection list", (page) =>
          page
            .getByRole("navigation")
            .getByRole("link", { name: "Connections", exact: true })
            .click(),
        );
        yield* browser.use("The list shows the connection's app on its card", (page) =>
          page
            .getByRole("listitem", { name: "Support assistant" })
            .getByText(app.name, { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Connections listing full access and the saved connection");
        yield* browser.use("Open the connection from its card", (page) =>
          page
            .getByRole("listitem", { name: "Support assistant" })
            .getByRole("link", { name: "Support assistant", exact: true })
            .click(),
        );
        yield* browser.use("Open the connection's actions", (page) =>
          page.getByRole("button", { name: "More actions", exact: true }).click(),
        );
        yield* browser.use("Revoke the connection", (page) =>
          page.getByRole("menuitem", { name: "Revoke connection", exact: true }).click(),
        );
        yield* browser.use("Confirm revocation", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Revoke connection", exact: true })
            .click(),
        );
        expect(
          yield* browser.use("The page returns to the list without the connection", (page) =>
            page
              .getByRole("listitem", { name: "Full access" })
              .waitFor({ state: "visible" })
              .then(() => page.getByRole("listitem", { name: "Support assistant" }).count()),
          ),
        ).toBe(0);
        expect(yield* list).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.scopedConnectionAppAccount.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `App account ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = defineProvider({ name: "Connection app account fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ app: { accounts: { team } } }, async () => ({ tools: router({ team: query({ input: object({}) }, async ctx => ctx.app.accounts.team.fields.token) }) }));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [],
          clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        // The app's links go with it, so its account can be deleted after.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        // The owner manages the app: connecting for its app requirement links the account for
        // everyone.
        const started = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "app", "team"),
          {},
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const submitted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, started)).id}/submit`,
          { method: "key", label: "Team account", fields: { token: "synthetic-team" } },
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const team = (yield* body(Resource, submitted)).id;
        accounts.push(team);
        expect(yield* accountLinks(actors.owner, path, "app")).toEqual([["team", team]]);
        // An app link, not a user link: the owner's user links, which connections run as, do not
        // include it.
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([]);

        // A connection cannot name the app's linked account: it runs the app, which brings its
        // account.
        const named = yield* api.request(actors.owner, "POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: `Connection ${randomUUID().slice(0, 6)}`,
          apps: [{ app: app.id, runsAs: [{ kind: "account", id: team }], tools: { kind: "all" } }],
        });
        expect(named.status, JSON.stringify(named.body)).toBe(400);
        expect(named.body).toMatchObject({ _tag: "ConnectionAccessInvalid", reason: "account" });

        const connection = yield* createConnection(actors.owner, [
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } },
        ]);
        expect(connection.policy.apps[0]?.runsAs).toEqual([{ kind: "app" }]);
        const consent = yield* consentTo(actors.owner, connection.url);
        clients.push(consent.clientId);
        expect(consent.status, JSON.stringify(consent)).toBe(200);
        const run = executor(
          yield* mcp.connect(yield* consent.tokens, "app-account", { connection: connection.id }),
        );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        // The call runs with the app's linked account through the app.
        const called = yield* run(
          "The app's linked account runs",
          `return await ${appPath}.team({})`,
        );
        expect(called.execution).toEqual({ ok: true, value: "synthetic-team" });
        // Discovery describes no account for the app requirement.
        const described = yield* run(
          "Describe the app's tool",
          `return await tools.search.describe({ paths: [${JSON.stringify(`${app.slug}.team`)}] })`,
        );
        expect(described.execution.ok, JSON.stringify(described)).toBe(true);
        expect(JSON.stringify(described)).not.toContain(team);
        expect(JSON.stringify(described)).not.toContain("Team account");

        // Neither the connections nor the grants list the app's linked account.
        const listed = yield* api.request(actors.owner, "GET", `${prefix}/mcp-connections`);
        expect(listed.status).toBe(200);
        const views = yield* body(Schema.Array(ConnectionView), listed);
        expect(views.find((view) => view.id === connection.id)?.policy.apps).toEqual([
          expect.objectContaining({ app: app.id, runsAs: [{ kind: "app" }] }),
        ]);
        expect(JSON.stringify(listed.body)).not.toContain(team);
        const grants = yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants");
        expect(grants.status).toBe(200);
        expect(JSON.stringify(grants.body)).toContain(consent.clientId);
        expect(JSON.stringify(grants.body)).not.toContain(team);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.memberOwnScopedConnections.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const hidden = yield* deployReadWriteApp;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Member connection app ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Member connection account", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({ who: query({ input: object({}) }, async ctx => ctx.user.accounts.service.fields.token) }) }));`,
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
        const shared = yield* api.request(actors.owner, "GET", `${path}/access`);
        const { revision } = yield* body(Schema.Struct({ revision: Schema.String }), shared);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const connectAccount = (actor: typeof actors.owner, token: string) =>
          Effect.gen(function* () {
            const started = yield* api.request(
              actor,
              "POST",
              connectionsPath(path, "user", "service"),
              { destination: { kind: "personal" } },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const submitted = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${(yield* body(Resource, started)).id}/submit`,
              { method: "key", label: `${token} account`, fields: { token } },
            );
            expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
            const account = (yield* body(Resource, submitted)).id;
            accounts.push(account);
            return account;
          });
        const ownerAccount = yield* connectAccount(actors.owner, "owner");
        const memberAccount = yield* connectAccount(actors.member, "member");
        const ownerName = `Owner seat ${randomUUID().slice(0, 6)}`;
        const memberName = `Member seat ${randomUUID().slice(0, 6)}`;
        const renamed = `${memberName} renamed`;
        const save = (actor: typeof actors.owner, apps: readonly unknown[], name: string) =>
          api.request(actor, "POST", `${prefix}/mcp-connections`, {
            id: randomUUID(),
            name,
            apps,
          });
        const ownedApps = [
          { app: app.id, runsAs: [{ kind: "account", id: memberAccount }], tools: { kind: "all" } },
        ];
        const ownerSaved = yield* save(
          actors.owner,
          [
            {
              app: app.id,
              runsAs: [{ kind: "account", id: ownerAccount }],
              tools: { kind: "all" },
            },
          ],
          ownerName,
        );
        expect(ownerSaved.status, JSON.stringify(ownerSaved.body)).toBe(200);
        const ownerConnection = yield* body(ConnectionView, ownerSaved);
        const created = yield* save(actors.member, ownedApps, memberName);
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        expect(connection.policy.apps).toEqual(ownedApps);
        const memberListed = yield* api.request(actors.member, "GET", `${prefix}/mcp-connections`);
        expect(memberListed.status, JSON.stringify(memberListed.body)).toBe(200);
        const listed = yield* body(Schema.Array(ConnectionView), memberListed);
        expect(listed.map((item) => item.id)).toContain(connection.id);
        expect(listed.map((item) => item.id)).not.toContain(ownerConnection.id);
        const updated = yield* api.request(
          actors.member,
          "PUT",
          `${prefix}/mcp-connections/${connection.id}`,
          { name: renamed, apps: ownedApps },
        );
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        expect((yield* body(ConnectionView, updated)).name).toBe(renamed);
        expect(
          (yield* api.request(
            actors.member,
            "PUT",
            `${prefix}/mcp-connections/${ownerConnection.id}`,
            {
              name: renamed,
              apps: ownedApps,
            },
          )).status,
        ).toBe(404);
        expect(
          (yield* api.request(
            actors.member,
            "POST",
            `${prefix}/mcp-connections/${ownerConnection.id}/revoke`,
          )).status,
        ).toBe(404);

        yield* browser.login(actors.member);
        yield* browser.use("Open Connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        yield* browser.use("The member's connection is listed", (page) =>
          page.getByRole("listitem", { name: renamed, exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Another member's connection is not listed", (page) =>
            page.getByRole("listitem", { name: ownerName, exact: true }).count(),
          ),
        ).toBe(0);

        const issued = yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
          name: "Member connection key",
        });
        expect(issued.status).toBe(200);
        const token = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
          issued,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.ignore),
        );
        const bearer = {
          authorization: `Bearer ${Redacted.value(token.key)}`,
        };
        const asKey = (method: "GET" | "POST" | "PUT", route: string, data?: unknown) =>
          Effect.gen(function* () {
            return yield* api.request(yield* api.session(), method, route, data, bearer);
          });
        const keyList = yield* asKey("GET", `${prefix}/mcp-connections`);
        expect(keyList.status).toBe(200);
        const keyViews = yield* body(Schema.Array(ConnectionView), keyList);
        expect(keyViews.map((item) => item.id)).toContain(connection.id);
        expect(keyViews.map((item) => item.id)).not.toContain(ownerConnection.id);
        const keyUpdated = yield* asKey("PUT", `${prefix}/mcp-connections/${connection.id}`, {
          name: renamed,
          apps: ownedApps,
        });
        expect(keyUpdated.status, JSON.stringify(keyUpdated.body)).toBe(200);
        const keysPath = `${prefix}/mcp-connections/${connection.id}/keys`;
        const minted = yield* asKey("POST", keysPath, { expiresInSeconds: 3600 });
        expect(minted.status, JSON.stringify(minted.body)).toBe(200);
        const KeySummary = Schema.Struct({
          id: Schema.String,
          name: Schema.NullOr(Schema.String),
          start: Schema.NullOr(Schema.String),
          createdAt: Schema.String,
          expiresAt: Schema.NullOr(Schema.String),
          lastRequest: Schema.NullOr(Schema.String),
        });
        const key = yield* body(Schema.Struct({ id: Schema.String }), minted);
        const listedKeys = yield* asKey("GET", keysPath);
        expect(listedKeys.status, JSON.stringify(listedKeys.body)).toBe(200);
        const keys = yield* body(Schema.Array(KeySummary), listedKeys);
        expect(keys.map((item) => item.id)).toContain(key.id);
        expect((yield* asKey("POST", `${keysPath}/${key.id}/revoke`)).status).toBeLessThan(300);
        const keysAfter = yield* asKey("GET", keysPath);
        expect(keysAfter.status, JSON.stringify(keysAfter.body)).toBe(200);
        expect(
          (yield* body(Schema.Array(KeySummary), keysAfter)).map((item) => item.id),
        ).not.toContain(key.id);
        const keyOwned = yield* asKey("POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: `Key seat ${randomUUID().slice(0, 6)}`,
          apps: ownedApps,
        });
        expect(keyOwned.status, JSON.stringify(keyOwned.body)).toBe(200);
        expect((yield* body(ConnectionView, keyOwned)).policy.apps).toEqual(ownedApps);

        const hiddenAttempt = yield* asKey("POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: "Hidden app",
          apps: [{ app: hidden.app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }],
        });
        expect(hiddenAttempt.status, JSON.stringify(hiddenAttempt.body)).toBe(400);
        expect(hiddenAttempt.body).toMatchObject({
          _tag: "ConnectionAccessInvalid",
          reason: "app",
        });
        const borrowed = yield* asKey("POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: "Borrowed account",
          apps: [
            {
              app: app.id,
              runsAs: [{ kind: "account", id: ownerAccount }],
              tools: { kind: "all" },
            },
          ],
        });
        expect(borrowed.status, JSON.stringify(borrowed.body)).toBe(400);
        expect(borrowed.body).toMatchObject({
          _tag: "ConnectionAccessInvalid",
          reason: "account",
        });
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([memberAccount]);
        const foreign = [
          yield* asKey("PUT", `${prefix}/mcp-connections/${ownerConnection.id}`, {
            name: renamed,
            apps: ownedApps,
          }),
          yield* asKey("POST", `${prefix}/mcp-connections/${ownerConnection.id}/revoke`),
          yield* asKey("POST", `${prefix}/mcp-connections/${ownerConnection.id}/keys`, {
            expiresInSeconds: 3600,
          }),
          yield* asKey(
            "POST",
            `${prefix}/mcp-connections/${ownerConnection.id}/keys/${key.id}/revoke`,
          ),
        ];
        for (const response of foreign) {
          expect(response.status, JSON.stringify(response.body)).toBe(404);
          expect(response.body).toMatchObject({ _tag: "ConnectionNotFound" });
        }

        const group = {
          name: "Members cannot",
          description: "",
          memberIds: [] as const,
        };
        for (const response of [
          yield* api.request(actors.member, "POST", `${prefix}/groups`, group),
          yield* asKey("POST", `${prefix}/groups`, group),
        ]) {
          expect(response.status, JSON.stringify(response.body)).toBe(403);
          expect(response.body).toMatchObject({ _tag: "OrganizationForbidden" });
        }

        expect(
          (yield* asKey("POST", `${prefix}/mcp-connections/${connection.id}/revoke`)).status,
        ).toBeLessThan(300);
        const afterRevoke = yield* asKey("GET", `${prefix}/mcp-connections`);
        expect(afterRevoke.status, JSON.stringify(afterRevoke.body)).toBe(200);
        expect(
          (yield* body(Schema.Array(ConnectionView), afterRevoke)).map((item) => item.id),
        ).not.toContain(connection.id);
        const ownerListed = yield* api.request(actors.owner, "GET", `${prefix}/mcp-connections`);
        expect(ownerListed.status, JSON.stringify(ownerListed.body)).toBe(200);
        expect(
          (yield* body(Schema.Array(ConnectionView), ownerListed)).map((item) => item.id),
        ).toContain(ownerConnection.id);
      }),
    ),
  );

  it.effect(scenarios.memberConnectionNoWidening.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const { app: executor, account: executorAccount } = yield* managementApp(actors.member);
        const mesh = yield* deployReadWriteApp;
        const meshPath = `${prefix}/apps/${mesh.app.id}`;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${meshPath}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${meshPath}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const executorEntry = {
          app: executor.id,
          runsAs: [{ kind: "account", id: executorAccount }],
          tools: { kind: "all" },
        };
        const meshEntry = {
          app: mesh.app.id,
          runsAs: [{ kind: "app" }],
          tools: { kind: "all" },
        };
        const save = (name: string, apps: readonly unknown[]) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.member, "POST", `${prefix}/mcp-connections`, {
              id: randomUUID(),
              name,
              apps,
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            return yield* body(ConnectionView, created);
          });
        const full = yield* save(`Full ${randomUUID().slice(0, 6)}`, [executorEntry, meshEntry]);
        const scoped = yield* save(`Scoped ${randomUUID().slice(0, 6)}`, [executorEntry]);
        const narrowed = yield* save(`Narrow ${randomUUID().slice(0, 6)}`, [
          { ...executorEntry, tools: { kind: "selected", names: ["mcpConnections.create"] } },
        ]);
        const clients: string[] = [];
        yield* revokeClientGrants(actors.member, () => clients);
        const agent = (connection: typeof full) =>
          Effect.gen(function* () {
            const consent = yield* consentTo(actors.member, connection.url);
            clients.push(consent.clientId);
            expect(consent.status, JSON.stringify(consent)).toBe(200);
            const client = yield* mcp.connect(yield* consent.tokens, connection.id, {
              connection: connection.id,
            });
            const tool = `tools[${JSON.stringify(executor.slug)}]`;
            const run = (step: string, code: string) =>
              client
                .use(step, (session, signal) =>
                  session.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Schema.decodeUnknownEffect(
                      Schema.Struct({
                        status: Schema.Literal("completed"),
                        execution: Schema.Struct({
                          ok: Schema.Literal(true),
                          value: Schema.Struct({
                            ok: Schema.Boolean,
                            error: Schema.optional(Schema.Struct({ status: Schema.Number })),
                            value: Schema.optional(Schema.Unknown),
                          }),
                        }),
                      }),
                    )(result.structuredContent),
                  ),
                );
            return { run, tool };
          });
        const invoke = (tool: string, method: string, input: unknown) =>
          `try { return { ok: true, value: await ${tool}.${method}(${JSON.stringify(input)}) }; } catch (error) { return { ok: false, error: JSON.parse(error.message) }; }`;
        const fullAgent = yield* agent(full);
        const meshId = randomUUID();
        const created = yield* fullAgent.run(
          "A full connection creates a narrower Mesh connection",
          invoke(fullAgent.tool, "mcpConnections.create", {
            body: { id: meshId, name: "Mesh seat", apps: [meshEntry] },
          }),
        );
        expect(created.execution.value.ok, JSON.stringify(created.execution.value)).toBe(true);
        const minted = yield* fullAgent.run(
          "A full connection mints a key inside its scope",
          invoke(fullAgent.tool, "mcpConnections.mintKey", {
            path: { connection: meshId },
            body: { expiresInSeconds: 3600 },
          }),
        );
        expect(minted.execution.value.ok, JSON.stringify(minted.execution.value)).toBe(true);

        const scopedAgent = yield* agent(scoped);
        const widened = yield* scopedAgent.run(
          "A scoped connection cannot create an all-apps connection",
          invoke(scopedAgent.tool, "mcpConnections.create", {
            body: {
              id: randomUUID(),
              name: "All apps",
              apps: [executorEntry, meshEntry],
            },
          }),
        );
        expect(widened.execution.value).toMatchObject({ ok: false, error: { status: 403 } });
        const widerKey = yield* scopedAgent.run(
          "A scoped connection cannot mint a key for a wider connection",
          invoke(scopedAgent.tool, "mcpConnections.mintKey", {
            path: { connection: full.id },
            body: { expiresInSeconds: 90 * 24 * 60 * 60 },
          }),
        );
        expect(widerKey.execution.value).toMatchObject({ ok: false, error: { status: 403 } });

        const narrowAgent = yield* agent(narrowed);
        const unmanaged = yield* narrowAgent.run(
          "A narrowed connection without manage is refused",
          invoke(narrowAgent.tool, "mcpConnections.create", {
            body: {
              id: randomUUID(),
              name: "Still narrow",
              apps: [executorEntry],
            },
          }),
        );
        expect(unmanaged.execution.value).toMatchObject({ ok: false, error: { status: 403 } });
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.adminConnectionKeyNoWidening.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const { app: executorApp, account: executorAccount } = yield* managementApp(actors.admin);
        const mesh = yield* deployReadWriteApp;
        const meshPath = `${prefix}/apps/${mesh.app.id}`;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${meshPath}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${meshPath}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const executorEntry = {
          app: executorApp.id,
          runsAs: [{ kind: "account", id: executorAccount }],
          tools: { kind: "all" },
        };
        const meshEntry = {
          app: mesh.app.id,
          runsAs: [{ kind: "app" }],
          tools: { kind: "all" },
        };
        const save = (name: string, apps: readonly unknown[]) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.admin, "POST", `${prefix}/mcp-connections`, {
              id: randomUUID(),
              name,
              apps,
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            return yield* body(ConnectionView, created);
          });
        const scoped = yield* save(`Scoped ${randomUUID().slice(0, 6)}`, [executorEntry]);
        const wide = yield* save(`Wide ${randomUUID().slice(0, 6)}`, [executorEntry, meshEntry]);
        // Another member's connections stay unreachable, including an admin's.
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/mcp-connections/${wide.id}/keys`, {
            expiresInSeconds: 3600,
          })).status,
        ).toBe(404);

        const minted = yield* api.request(
          actors.admin,
          "POST",
          `${prefix}/mcp-connections/${scoped.id}/keys`,
          { name: "Scoped connection key", expiresInSeconds: 3600 },
        );
        expect(minted.status, JSON.stringify(minted.body)).toBe(200);
        const key = yield* body(
          Schema.Struct({
            id: Schema.String,
            key: Schema.RedactedFromValue(Schema.String),
          }),
          minted,
        );
        const bearer = {
          authorization: `Bearer ${Redacted.value(key.key)}`,
          "x-executor-organization": actors.organization.id,
        };
        const asKey = (method: "GET" | "POST", route: string, data?: unknown) =>
          Effect.gen(function* () {
            return yield* api.request(yield* api.session(), method, route, data, bearer);
          });
        // The connection key is the bearer on the hosted API, with no Executor app self-call.
        for (const response of [
          yield* asKey("POST", `${prefix}/mcp-connections`, {
            id: randomUUID(),
            name: "Wider than the key",
            apps: [executorEntry, meshEntry],
          }),
          yield* asKey("POST", `${prefix}/mcp-connections/${wide.id}/keys`, {
            expiresInSeconds: 3600,
          }),
          yield* asKey("GET", `${prefix}/mcp-connections/${wide.id}/keys`),
        ]) {
          expect(response.status, JSON.stringify(response.body)).toBe(403);
          expect(response.body).toMatchObject({ _tag: "ConnectionKeyRefused" });
        }

        // Warm the Executor app from an unscoped key first. A later scoped call must not reuse
        // that worker's outbound, which has no calling connection.
        const issued = yield* api.request(actors.admin, "POST", "/api/auth/api-key/create", {
          name: "Admin full key",
        });
        expect(issued.status).toBe(200);
        const fullKey = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
          issued,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "POST", "/api/auth/api-key/delete", { keyId: fullKey.id })
            .pipe(Effect.ignore),
        );
        const tool = `tools[${JSON.stringify(executorApp.slug)}]`;
        const invoke = (method: string, input: unknown) =>
          `try { return { ok: true, value: await ${tool}.${method}(${JSON.stringify(input)}) }; } catch (error) { return { ok: false, error: JSON.parse(error.message) }; }`;
        const Program = Schema.Struct({
          ok: Schema.Boolean,
          error: Schema.optional(Schema.Struct({ code: Schema.String, status: Schema.Number })),
          value: Schema.optional(Schema.Unknown),
        });
        const run = (
          secret: typeof key.key,
          connection: string | undefined,
          step: string,
          code: string,
        ) =>
          Effect.gen(function* () {
            const client = yield* mcp.connect(secret, step, {
              organization: actors.organization.id,
              ...(connection === undefined ? {} : { connection }),
            });
            const result = yield* executor(client)(step, code);
            return yield* Schema.decodeUnknownEffect(Program)(result.execution.value);
          });
        const warmed = yield* run(
          fullKey.key,
          undefined,
          "An unscoped key lists connections through the Executor app",
          invoke("mcpConnections.list", {}),
        );
        expect(warmed.ok, JSON.stringify(warmed)).toBe(true);

        const widened = yield* run(
          key.key,
          scoped.id,
          "A scoped connection key cannot create a wider connection",
          invoke("mcpConnections.create", {
            body: {
              id: randomUUID(),
              name: "Wider than the connection",
              apps: [executorEntry, meshEntry],
            },
          }),
        );
        expect(widened, JSON.stringify(widened)).toMatchObject({
          ok: false,
          error: { status: 403, code: "OrganizationForbidden" },
        });
        const outside = yield* run(
          key.key,
          scoped.id,
          "A scoped connection key cannot mint a key outside its scope",
          invoke("mcpConnections.mintKey", {
            path: { connection: wide.id },
            body: { expiresInSeconds: 3600 },
          }),
        );
        expect(outside, JSON.stringify(outside)).toMatchObject({
          ok: false,
          error: { status: 403, code: "OrganizationForbidden" },
        });
        const listed = yield* run(
          key.key,
          scoped.id,
          "A scoped connection key cannot list keys outside its scope",
          invoke("mcpConnections.listKeys", { path: { connection: wide.id } }),
        );
        expect(listed, JSON.stringify(listed)).toMatchObject({
          ok: false,
          error: { status: 403, code: "OrganizationForbidden" },
        });

        // A connection that grants every tool of its apps can still narrow and mint inside it.
        const full = yield* save(`Full ${randomUUID().slice(0, 6)}`, [executorEntry, meshEntry]);
        const fullMinted = yield* api.request(
          actors.admin,
          "POST",
          `${prefix}/mcp-connections/${full.id}/keys`,
          { expiresInSeconds: 3600 },
        );
        expect(fullMinted.status, JSON.stringify(fullMinted.body)).toBe(200);
        const fullConnectionKey = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String) }),
          fullMinted,
        );
        const meshId = randomUUID();
        const narrowed = yield* run(
          fullConnectionKey.key,
          full.id,
          "A full connection key creates a narrower connection",
          invoke("mcpConnections.create", {
            body: { id: meshId, name: "Mesh seat", apps: [meshEntry] },
          }),
        );
        expect(narrowed.ok, JSON.stringify(narrowed)).toBe(true);
        const mintedInside = yield* run(
          fullConnectionKey.key,
          full.id,
          "A full connection key mints inside its scope",
          invoke("mcpConnections.mintKey", {
            path: { connection: meshId },
            body: { expiresInSeconds: 3600 },
          }),
        );
        expect(mintedInside.ok, JSON.stringify(mintedInside)).toBe(true);

        // Nested tools.call: the Executor app calls the API again. The connection must still bind.
        const nested = (step: string, app: string, body: unknown) =>
          run(key.key, scoped.id, step, invoke("tools.call", { path: { app }, body }));
        const nestedWiden = yield* nested("nestedWiden", executorApp.id, {
          tool: "mcpConnections.create",
          input: {
            body: {
              id: randomUUID(),
              name: "Nested wider",
              apps: [executorEntry, meshEntry],
            },
          },
        });
        expect(nestedWiden, JSON.stringify(nestedWiden)).toMatchObject({
          ok: false,
          error: { status: 403, code: "OrganizationForbidden" },
        });
        const nestedMint = yield* nested("nestedMint", executorApp.id, {
          tool: "mcpConnections.mintKey",
          input: {
            path: { connection: wide.id },
            body: { expiresInSeconds: 3600 },
          },
        });
        expect(nestedMint, JSON.stringify(nestedMint)).toMatchObject({
          ok: false,
          error: { status: 403, code: "OrganizationForbidden" },
        });
        const directMesh = yield* nested("directMesh", mesh.app.id, {
          tool: "read",
          input: {},
        });
        expect(directMesh, JSON.stringify(directMesh)).toMatchObject({
          ok: false,
          error: { status: 403, code: "OrganizationForbidden" },
        });
        const afterNested = yield* api.request(actors.admin, "GET", `${prefix}/mcp-connections`);
        expect(afterNested.status, JSON.stringify(afterNested.body)).toBe(200);
        expect(JSON.stringify(afterNested.body)).not.toContain("Nested wider");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
