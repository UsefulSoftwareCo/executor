/** Scoped connections: each has its own MCP URL, and its grants follow the current record. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Redacted, Schema } from "effect";
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
import { Profile } from "../support/hosted-profile.ts";
import {
  ConnectionView,
  Execution,
  consentTo,
  readWriteAppFiles,
  revokeClientGrants,
} from "../support/mcp-connections.ts";
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

  it.effect(scenarios.scopedConnectionProfiles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Profile app ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Connection profile fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({ who: query({ input: object({}) }, async ctx => ctx.accounts.service.fields.token) }) }));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const profiles: string[] = [],
          accounts: string[] = [],
          clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const id of profiles)
              yield* api.request(actors.owner, "DELETE", `${path}/profiles/${id}`);
            yield* api.request(actors.owner, "DELETE", path);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        const profileWithAccount = (token: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.owner, "POST", `${path}/profiles`, {
              accounts: {},
              name: token,
              idempotencyKey: token,
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const profile = yield* body(Profile, created);
            profiles.push(profile.id);
            const connection = yield* api.request(actors.owner, "POST", `${path}/connections`, {
              profile: profile.id,
              requirement: "service",
              destination: { kind: "personal" },
            });
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
            return { profile: profile.id, account: account.id };
          });
        const work = yield* profileWithAccount("work");
        const personal = yield* profileWithAccount("personal");
        const connection = yield* createConnection(actors.owner, [
          { app: app.id, runsAs: [{ kind: "profile", id: work.profile }], tools: { kind: "all" } },
        ]);
        const consent = yield* consentTo(actors.owner, connection.url);
        clients.push(consent.clientId);
        expect(consent.status, JSON.stringify(consent)).toBe(200);
        const run = executor(
          yield* mcp.connect(yield* consent.tokens, "profiles", { connection: connection.id }),
        );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const listed = yield* run(
          "Only the selected profile has a namespace",
          `return Object.keys(${appPath}.profiles ?? {}).length`,
        );
        expect(listed.execution).toEqual({ ok: true, value: 1 });
        const called = yield* run(
          "The selected profile runs",
          `const [only] = Object.keys(${appPath}.profiles); return await ${appPath}.profiles[only].who({})`,
        );
        expect(called.execution).toEqual({ ok: true, value: "work" });
        // Choosing a bare account saves a profile for that account, then references it.
        const bare = yield* createConnection(actors.owner, [
          {
            app: app.id,
            runsAs: [{ kind: "account", id: personal.account }],
            tools: { kind: "all" },
          },
        ]);
        const runsAs = bare.policy.apps[0]?.runsAs ?? [];
        expect(runsAs).toHaveLength(1);
        const created = runsAs[0];
        if (created?.kind !== "profile") return yield* Effect.die("Expected a saved profile");
        profiles.push(created.id);
        expect([work.profile, personal.profile]).not.toContain(created.id);
        const saved = yield* body(
          Schema.Struct({ ...Profile.fields, name: Schema.NullOr(Schema.String) }),
          yield* api.request(actors.owner, "GET", `${path}/profiles/${created.id}`),
        );
        expect(saved.accounts).toEqual({ service: personal.account });
        expect(saved.name).toBe("personal account");
        const bareConsent = yield* consentTo(actors.owner, bare.url);
        clients.push(bareConsent.clientId);
        const bareRun = executor(
          yield* mcp.connect(yield* bareConsent.tokens, "bare", { connection: bare.id }),
        );
        const personalCall = yield* bareRun(
          "The new profile runs as the chosen account",
          `const [only] = Object.keys(${appPath}.profiles); return await ${appPath}.profiles[only].who({})`,
        );
        expect(personalCall.execution).toEqual({ ok: true, value: "personal" });
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
        yield* browser.use("Open Connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
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
        expect(saved?.policy.apps).toEqual([
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
        ]);
        yield* browser.use("The connection shows its own MCP URL", (page) =>
          page
            .getByText(`${targetHosts(target).mcp}/mcp?connection=${saved?.id}`)
            .first()
            .waitFor({ state: "visible" }),
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
});
