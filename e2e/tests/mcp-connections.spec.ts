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
  targetRefusal,
} from "../support/mcp-connections.ts";
import { holdTools, untilHeld } from "../support/held-call.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
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
        // Bearer credentials cannot manage connections, including a full-access grant.
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
            // A connection's token cannot be used at another URL, even the full-access one.
            const moved = yield* Effect.exit(
              mcp.connect(Redacted.make(Redacted.value(grant.tokens).access_token), "moved"),
            );
            expect(Exit.isFailure(moved)).toBe(true);
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
await ${tools}.enter({});
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
          call("entered", "query").pipe(
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
        // The connection does not allow the replacement, so the call is refused for that and
        // never runs with it.
        expect(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TargetRefusal))(
            execution.value.second.refused,
          ),
        ).toEqual(targetRefusal(app.id, replacement));
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
        yield* browser.use("Close the full-size screenshot", (page) =>
          page.keyboard.press("Escape"),
        );
        yield* browser.use("Choose Cursor plugin setup", (page) =>
          page.getByRole("button", { name: "Cursor", exact: true }).click(),
        );
        expect(
          yield* browser.use("Cursor links to our published plugin", (page) =>
            page
              .getByRole("link", { name: "Install Executor for Cursor", exact: true })
              .getAttribute("href"),
          ),
        ).toBe("https://cursor.com/marketplace/usefulsoftwareco");
        yield* browser.use("Choose Grok Bot plugin setup", (page) =>
          page.getByRole("button", { name: "Grok Bot", exact: true }).click(),
        );
        expect(
          yield* browser.use("Grok Bot uses the same plugin", (page) =>
            page
              .getByRole("link", { name: "Install Executor for Grok Bot", exact: true })
              .getAttribute("href"),
          ),
        ).toBe("https://cursor.com/marketplace/usefulsoftwareco");
        yield* browser.use("Grok Bot installs the plugin by command", (page) =>
          page.getByText("/add-plugin executor", { exact: true }).waitFor(),
        );
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
        yield* browser.use("Start a new connection", (page) =>
          page.getByRole("button", { name: "Create a scoped connection", exact: true }).click(),
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
        yield* browser.use("Revoke the connection", (page) =>
          page.getByRole("button", { name: "Revoke", exact: true }).click(),
        );
        yield* browser.use("Confirm revocation", (page) =>
          page.getByRole("button", { name: "Revoke connection", exact: true }).click(),
        );
        yield* browser.use("The page returns to agent setup", (page) =>
          page
            .getByRole("button", { name: "Create a scoped connection", exact: true })
            .waitFor({ state: "visible" }),
        );
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
          {
            destination: { kind: "personal" },
          },
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
});
