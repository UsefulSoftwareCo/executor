/**
 * Sign-in chooses an MCP grant's connection and approval mode. The consent sends them in
 * `x-executor-grant-settings`; the URL only preselects them. Every request then reads both from the
 * grant record, whatever address the client uses, and `/mcp/whoami` describes them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import {
  ConnectionView,
  Execution,
  clientGrantId,
  consentTo,
  revokeClientGrants,
} from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";

const settingsHeader = "x-executor-grant-settings";
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  approvalUrl: Schema.optional(Schema.String),
});
const Organizations = Schema.Array(
  Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
);
const Agents = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    access: Schema.Unknown,
    mode: Schema.optional(Schema.String),
  }),
);
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });

/** An account-free app with a read tool, a write tool and a tool that always asks for approval. */
const deployApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const receipt = randomUUID();
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Grant choice ${receipt.slice(0, 8)}`,
    files: [
      {
        path: "index.ts",
        content: `
import { defineApp, mutation, object, query, router, string } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({
  tools: router({
    read: query({ description: "Read the receipt", input: object({}) }, async () => ({ read: ${JSON.stringify(receipt)} })),
    write: mutation({ description: "Write a message", input: object({ message: string() }) }, async (_, input) => ({ wrote: input.message })),
    review: mutation({ description: "Review after approval", input: object({}), approval: always() }, async () => ({ reviewed: true })),
  }),
}));
`,
      },
      appsManifest,
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
  return { app, receipt, path: `tools[${JSON.stringify(app.slug)}]` };
});

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

/** The scenario organization's slug and name, as `/mcp/whoami` names it. */
const organizationOf = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const listed = yield* body(
    Organizations,
    yield* api.request(actors.owner, "GET", "/api/auth/organization/list"),
  );
  const found = listed.find((item) => item.id === actors.organization.id);
  if (found === undefined) return yield* Effect.die("The scenario organization is not listed");
  return found;
});

/** `GET /mcp/whoami` on the MCP origin with a bearer and no cookies, as a CLI sends it. */
const whoami = (
  token: Redacted.Redacted<string> | undefined,
  query = "",
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* rawRequest(`${targetHosts(target).mcp}/mcp/whoami${query}`, {
      headers: {
        ...headers,
        ...(token === undefined ? {} : { authorization: `Bearer ${Redacted.value(token)}` }),
      },
    });
    const parsed =
      response.text === ""
        ? null
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(response.text);
    return { ...response, body: parsed };
  });

/** Run code through one MCP client's `execute` tool and return its structured result. */
const runner =
  (client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>) =>
  (operation: string, code: string) =>
    client
      .use(operation, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
      )
      .pipe(Effect.map((result) => result.structuredContent));

layer(HostedLive, { excludeTestServices: true })("MCP grant choice at sign-in", (it) => {
  it.effect(scenarios.grantChoiceConnection.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          mcp = yield* McpClient,
          target = yield* Target;
        const plain = `${targetHosts(target).mcp}/mcp`;
        const [{ app, receipt, path }, hidden, organization] = yield* Effect.all(
          [deployApp, deployMcpApp, organizationOf],
          { concurrency: 3 },
        );
        const connection = yield* createConnection(actors.owner, [
          { app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
        ]);
        // Another connection, which an address may name, that would allow the hidden app.
        const other = yield* createConnection(actors.owner, [
          { app: hidden.app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } },
        ]);
        const clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        const consent = yield* evidence.step(
          "Choose the connection on the sign-in page of the plain MCP URL",
          consentTo(actors.owner, plain, {
            "x-executor-organization": actors.organization.id,
            [settingsHeader]: JSON.stringify({
              access: { kind: "connection", id: connection.id },
            }),
          }),
        );
        clients.push(consent.clientId);
        expect(consent.consentResources).toEqual([plain]);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const hiddenPath = `tools[${JSON.stringify(hidden.app.slug)}]`;
        const limited = (label: string, options: { readonly connection?: string } = {}) =>
          Effect.gen(function* () {
            const call = runner(yield* mcp.connect(token, label, options));
            const run = (operation: string, code: string) =>
              call(operation, code).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Execution)));
            const [read, write, excluded] = yield* Effect.all(
              [
                run("Call the connection's read tool", `return await ${path}.read({})`),
                run(
                  "Call a tool the connection excludes",
                  `return await ${path}.write({message: "x"})`,
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
          limited("chosen-plain"),
        );
        yield* evidence.step(
          "An address naming another connection still serves the chosen one",
          limited("chosen-other-address", { connection: other.id }),
        );
        const described = yield* whoami(token);
        expect(described.status, JSON.stringify(described.body)).toBe(200);
        expect(described.body).toEqual({
          organization: { id: organization.id, slug: organization.slug, name: organization.name },
          access: { kind: "connection", id: connection.id, name: connection.name, apps: 1 },
          mode: "model",
        });
        const grant = yield* clientGrantId(actors.owner, consent.clientId);
        const agents = yield* body(
          Agents,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/organizations/${actors.organization.id}/mcp-agents`,
          ),
        );
        expect(agents.find((agent) => agent.id === grant)).toMatchObject({
          access: { kind: "connection", connection: connection.id, name: connection.name },
          mode: "model",
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.grantChoiceBrowserMode.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          mcp = yield* McpClient,
          target = yield* Target;
        const plain = `${targetHosts(target).mcp}/mcp`;
        const { path } = yield* deployApp;
        const clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        const consent = yield* evidence.step(
          "Choose browser approval on the sign-in page of the plain MCP URL",
          consentTo(actors.owner, plain, {
            "x-executor-organization": actors.organization.id,
            [settingsHeader]: JSON.stringify({ mode: "browser" }),
          }),
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const asksInBrowser = (label: string, options: { readonly mode?: "model" | "native" }) =>
          Effect.gen(function* () {
            const run = runner(yield* mcp.connect(token, label, options));
            const pending = yield* run(
              "Call a tool that needs approval",
              `return await ${path}.review({})`,
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Pending)));
            // Browser mode links the approval page; model mode asks the client to resume.
            expect(pending.approvalUrl).toBeDefined();
            const url = new URL(pending.approvalUrl ?? "");
            const review = `/api/mcp/approvals/${encodeURIComponent(pending.requestId)}${url.search}`;
            const page = yield* api.request(actors.owner, "GET", review);
            expect(page.status, JSON.stringify(page.body)).toBe(200);
          });
        yield* evidence.step(
          "The plain MCP URL asks for approval in the browser",
          asksInBrowser("browser-plain", {}),
        );
        yield* evidence.step(
          "An address naming model mode still asks in the browser",
          asksInBrowser("browser-model-address", { mode: "model" }),
        );
        const described = yield* whoami(token, "?elicitation_mode=native");
        expect(described.status, JSON.stringify(described.body)).toBe(200);
        expect(described.body).toMatchObject({ access: { kind: "all" }, mode: "browser" });
        const grant = yield* clientGrantId(actors.owner, consent.clientId);
        const agents = yield* body(
          Agents,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/organizations/${actors.organization.id}/mcp-agents`,
          ),
        );
        expect(agents.find((agent) => agent.id === grant)).toMatchObject({
          access: { kind: "all" },
          mode: "browser",
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.grantChoiceRefusals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const hosts = targetHosts(target);
        const plain = `${hosts.mcp}/mcp`;
        const { app } = yield* deployApp;
        const apps = [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }];
        const [owned, members, revoked] = yield* Effect.all(
          [
            createConnection(actors.owner, apps),
            // The member's own connection; the owner's app is not one a member may include.
            createConnection(actors.member, []),
            createConnection(actors.owner, apps),
          ],
          { concurrency: 3 },
        );
        expect(
          (yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/mcp-connections/${revoked.id}/revoke`,
          )).status,
        ).toBe(200);
        const clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        const organization = { "x-executor-organization": actors.organization.id };
        const choose = (id: string) =>
          JSON.stringify({ access: { kind: "connection", id }, mode: "browser" });
        const attempt = (headers: Record<string, string>, resource = plain, scope?: string) =>
          consentTo(actors.owner, resource, headers, scope).pipe(
            Effect.tap((consent) => Effect.sync(() => clients.push(consent.clientId))),
            Effect.map((consent) => consent.status),
          );
        expect(yield* attempt({ ...organization, [settingsHeader]: choose(members.id) })).toBe(403);
        expect(yield* attempt({ ...organization, [settingsHeader]: choose(revoked.id) })).toBe(403);
        expect(
          yield* attempt({
            "x-executor-organization": `org_${randomUUID().replaceAll("-", "")}`,
            [settingsHeader]: choose(owned.id),
          }),
        ).toBe(403);
        // A connection's access comes from its record, so a policy cannot accompany one.
        expect(
          yield* attempt({
            ...organization,
            [settingsHeader]: choose(owned.id),
            "x-executor-grant": JSON.stringify({ kind: "all" }),
          }),
        ).toBe(400);
        expect(yield* attempt({ ...organization, [settingsHeader]: "{" })).toBe(400);
        expect(
          yield* attempt({ ...organization, [settingsHeader]: JSON.stringify({ mode: "phone" }) }),
        ).toBe(400);
        // An API grant has no mode or connection to choose.
        expect(
          yield* attempt(
            { ...organization, [settingsHeader]: JSON.stringify({ mode: "model" }) },
            `${hosts.api}/api`,
            "executor offline_access",
          ),
        ).toBe(400);
        // None of the refused approvals left a grant.
        const listed = yield* body(
          Schema.Array(Schema.Struct({ clientId: Schema.String })),
          yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants"),
        );
        expect(listed.filter((grant) => clients.includes(grant.clientId))).toEqual([]);
        // The same choice of the owner's own connection in its organization is approved.
        expect(yield* attempt({ ...organization, [settingsHeader]: choose(owned.id) })).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.mcpWhoamiHosted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const plain = `${targetHosts(target).mcp}/mcp`;
        const organization = yield* organizationOf;
        const expectedOrganization = {
          id: organization.id,
          slug: organization.slug,
          name: organization.name,
        };
        // Without a credential it answers as the MCP endpoint does: the OAuth challenge.
        const anonymous = yield* whoami(undefined);
        expect(anonymous.status).toBe(401);
        expect(anonymous.challenge).toContain(
          "/.well-known/oauth-protected-resource/mcp?elicitation_mode=model",
        );
        const clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        const consent = yield* consentTo(actors.owner, plain, {
          "x-executor-organization": actors.organization.id,
        });
        clients.push(consent.clientId);
        const all = yield* whoami(yield* consent.tokens);
        expect(all.status, JSON.stringify(all.body)).toBe(200);
        expect(all.body).toEqual({
          organization: expectedOrganization,
          access: { kind: "all" },
          mode: "model",
        });
        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "whoami",
        });
        expect(created.status).toBe(200);
        const key = yield* body(Token, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const named = { "x-executor-organization": actors.organization.id };
        // A token has no record, so its mode is the URL's.
        const pat = yield* whoami(key.key, "?elicitation_mode=native", named);
        expect(pat.status, JSON.stringify(pat.body)).toBe(200);
        expect(pat.body).toEqual({
          organization: expectedOrganization,
          access: { kind: "all" },
          mode: "native",
        });
        const patConnection = yield* whoami(key.key, "?connection=another-connection", named);
        expect(patConnection.status).toBe(403);
        expect(patConnection.body).toMatchObject({ error: { data: { code: "GrantForbidden" } } });
      }),
    ),
  );
});
