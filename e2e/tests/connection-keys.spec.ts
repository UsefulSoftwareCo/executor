/**
 * A connection key is an API key bound to one scoped MCP connection, for headless agents, CI and
 * staff bots. Only the connection's owner mints one, it always expires, it works only at its
 * connection's MCP URL, the API never accepts it, revoking the connection deletes it, and every
 * mint is in the audit log. The owner lists a connection's keys without their secrets and revokes
 * one at a time, so a seat's key can be rotated without revoking the connection.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Telemetry } from "../support/evidence.ts";
import { Browser } from "../support/browser.ts";
import { McpClient } from "../support/mcp-client.ts";
import { ConnectionView, Execution, readWriteAppFiles } from "../support/mcp-connections.ts";

const Access = Schema.Struct({ revision: Schema.String });
const ConnectionKey = Schema.Struct({
  id: Schema.String,
  key: Schema.RedactedFromValue(Schema.String),
  connection: Schema.String,
  url: Schema.String,
  expiresAt: Schema.String,
});
const ConnectionWithTimes = Schema.Struct({
  ...ConnectionView.fields,
  createdAt: Schema.String,
});
const Keys = Schema.Struct({ apiKeys: Schema.Array(Schema.Struct({ id: Schema.String })) });
/** A listed connection key: never its secret. */
const KeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  start: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  lastRequest: Schema.NullOr(Schema.String),
});
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "connection-key-check", version: "1" },
  },
};

layer(HostedLive, { excludeTestServices: true })("Connection keys", (it) => {
  it.effect(scenarios.connectionKeys.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          telemetry = yield* Telemetry;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const receipt = randomUUID();
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Connection key app ${receipt.slice(0, 8)}`,
          files: readWriteAppFiles(receipt),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const appPath = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", appPath).pipe(Effect.ignore),
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${appPath}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${appPath}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const policy = [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }];
        // The member owns two connections, made in the dashboard with their browser session.
        const connect = (name: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.member, "POST", `${prefix}/mcp-connections`, {
              id: randomUUID(),
              name,
              apps: policy,
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            return yield* body(ConnectionWithTimes, created);
          });
        const bound = yield* connect(`Bound ${receipt.slice(0, 6)}`);
        const other = yield* connect(`Other ${receipt.slice(0, 6)}`);
        const keysPath = (connection: string) => `${prefix}/mcp-connections/${connection}/keys`;
        const mint = (actor: Session, connection: string, data: unknown, headers = {}) =>
          api.request(actor, "POST", keysPath(connection), data, headers);

        // Only its owner mints a key: an admin or the organization's owner sees no such connection.
        for (const actor of [actors.admin, actors.owner])
          expect((yield* mint(actor, bound.id, { expiresInSeconds: 3600 })).status).toBe(404);
        // Every key expires, within 90 days.
        for (const invalid of [{}, { expiresInSeconds: 1 }, { expiresInSeconds: 91 * 86400 }])
          expect((yield* mint(actors.member, bound.id, invalid)).status).toBe(400);

        // The owner mints one; the mint is in the audit log, with the key and the connection.
        const trace = randomBytes(16).toString("hex");
        const minted = yield* mint(
          actors.member,
          bound.id,
          { name: "Headless probe", expiresInSeconds: 3600 },
          { traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01` },
        );
        expect(minted.status, JSON.stringify(minted.body)).toBe(200);
        const key = yield* body(ConnectionKey, minted);
        expect(key.connection).toBe(bound.id);
        expect(key.url).toBe(bound.url);
        const lifetime = Date.parse(key.expiresAt) - Date.now();
        expect(lifetime).toBeGreaterThan(3500_000);
        expect(lifetime).toBeLessThanOrEqual(3600_000);
        const audit = yield* telemetry.logs(trace).pipe(
          Effect.filterOrFail((text) => text.includes(key.id)),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
        );
        expect(audit).toContain(bound.id);
        expect(audit).toContain("mcp-connection-key");
        expect(audit).not.toContain(Redacted.value(key.key));

        // At its connection's URL the key runs with the connection's policy.
        const scoped = yield* mcp.connect(key.key, "connection-key", {
          organization,
          connection: bound.id,
        });
        const read = yield* scoped
          .use("Read with the connection key", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: `return await tools[${JSON.stringify(app.slug)}].read({})` },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Execution)(result.structuredContent),
            ),
          );
        expect(read.execution).toEqual({ ok: true, value: { read: receipt } });

        // Anywhere else it is refused with a 403 that names the connection key.
        const asKey = (
          secret: Redacted.Redacted<string>,
          method: "GET" | "POST",
          path: string,
          data?: unknown,
        ) =>
          Effect.gen(function* () {
            return yield* api.request(yield* api.session(), method, path, data, {
              authorization: `Bearer ${Redacted.value(secret)}`,
              "x-executor-organization": organization,
              accept: "application/json, text/event-stream",
            });
          });
        for (const [label, path] of [
          ["plain MCP URL", "/mcp"],
          ["organization MCP URL", `/org/${organization}/mcp`],
          ["another connection", `/mcp?connection=${other.id}`],
        ] as const) {
          const refused = yield* asKey(key.key, "POST", path, initialize);
          expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(403);
          expect(JSON.stringify(refused.body), label).toContain(
            "works only at that connection's MCP URL",
          );
        }
        for (const [label, method, path, data] of [
          ["the API", "GET", `${prefix}/apps`, undefined],
          ["minting another key", "POST", keysPath(bound.id), { expiresInSeconds: 3600 }],
        ] as const) {
          const refused = yield* asKey(key.key, method, path, data);
          expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(403);
          expect(JSON.stringify(refused.body), label).toContain("ConnectionKeyRefused");
        }

        // It expires: a key minted for 5 seconds works at its own URL, then is refused there.
        const atConnection = (secret: Redacted.Redacted<string>, label: string) =>
          Effect.exit(
            Effect.gen(function* () {
              const client = yield* mcp.connect(secret, label, {
                organization,
                connection: bound.id,
              });
              return yield* client.use(`${label}: list tools`, (session, signal) =>
                session.listTools(undefined, { signal }),
              );
            }),
          );
        const brief = yield* body(
          ConnectionKey,
          yield* mint(actors.member, bound.id, { expiresInSeconds: 5 }),
        );
        expect(Exit.isSuccess(yield* atConnection(brief.key, "brief key"))).toBe(true);
        yield* Effect.sleep("6 seconds");
        expect(Exit.isFailure(yield* atConnection(brief.key, "expired key"))).toBe(true);

        // The owner can also create one in the dashboard; it is shown once and works the same way.
        const browser = yield* Browser;
        yield* browser.login(actors.member);
        yield* browser.use("Open the member's connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        yield* browser.use("Open the bound connection", (page) =>
          page.getByRole("link", { name: bound.name, exact: true }).click(),
        );
        yield* browser.use("Start a connection key", (page) =>
          page.getByRole("button", { name: "Create connection key", exact: true }).click(),
        );
        yield* browser.use("Create the key", (page) =>
          page.getByRole("button", { name: "Create key", exact: true }).click(),
        );
        const shown = yield* browser.use("Read the key shown once", (page) =>
          page
            .getByText(/^exp_[A-Za-z0-9_-]+$/)
            .first()
            .innerText(),
        );
        expect(
          Exit.isSuccess(yield* atConnection(Redacted.make(shown.trim()), "dashboard key")),
        ).toBe(true);

        // Revoking the connection stops the key at its URL and deletes it.
        expect(
          (yield* api.request(
            actors.member,
            "POST",
            `${prefix}/mcp-connections/${bound.id}/revoke`,
          )).status,
        ).toBeLessThan(300);
        expect(Exit.isFailure(yield* atConnection(key.key, "key after revocation"))).toBe(true);
        const remaining = yield* body(
          Keys,
          yield* api.request(actors.member, "GET", "/api/auth/api-key/list"),
        );
        expect(remaining.apiKeys.map((item) => item.id)).not.toContain(key.id);

        // Its owner can make a connection with the revoked one's ID again, so the URL agents were
        // given keeps its address. It is a new connection: keys minted for the revoked one stay
        // refused there and everywhere else, and only a key minted for the new one works.
        const create = (actor: Session, data: unknown) =>
          api.request(actor, "POST", `${prefix}/mcp-connections`, data);
        const again = yield* create(actors.member, {
          id: bound.id,
          name: `Again ${receipt.slice(0, 6)}`,
          apps: policy,
        });
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        const reused = yield* body(ConnectionWithTimes, again);
        expect(reused.url).toBe(bound.url);
        expect(Date.parse(reused.createdAt)).toBeGreaterThan(Date.parse(bound.createdAt));
        for (const [label, secret] of [
          ["API-minted key", key.key],
          ["dashboard key", Redacted.make(shown.trim())],
        ] as const) {
          expect(
            Exit.isFailure(yield* atConnection(secret, `${label} at the new connection`)),
            label,
          ).toBe(true);
          for (const path of [bound.url.slice(bound.url.indexOf("/mcp")), "/mcp"]) {
            const refused = yield* asKey(secret, "POST", path, initialize);
            expect(refused.status, `${label} at ${path}: ${JSON.stringify(refused.body)}`).toBe(
              401,
            );
          }
        }
        const fresh = yield* body(
          ConnectionKey,
          yield* mint(actors.member, bound.id, { name: "After reuse", expiresInSeconds: 3600 }),
        );
        expect(Exit.isSuccess(yield* atConnection(fresh.key, "key for the new connection"))).toBe(
          true,
        );
        // A retry with the same body returns the live connection unchanged; another body is a
        // different connection, and the ID is taken.
        const retried = yield* create(actors.member, {
          id: bound.id,
          name: reused.name,
          apps: policy,
        });
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect((yield* body(ConnectionWithTimes, retried)).createdAt).toBe(reused.createdAt);
        const taken = yield* create(actors.member, {
          id: bound.id,
          name: `Different ${receipt.slice(0, 6)}`,
          apps: policy,
        });
        expect(taken.status, JSON.stringify(taken.body)).toBe(409);
        expect(JSON.stringify(taken.body)).toContain("ConnectionIdTaken");
        // IDs belong to the user who made them: another member cannot take a live or revoked one.
        expect(
          (yield* api.request(
            actors.member,
            "POST",
            `${prefix}/mcp-connections/${other.id}/revoke`,
          )).status,
        ).toBeLessThan(300);
        for (const id of [bound.id, other.id]) {
          const refused = yield* create(actors.admin, { id, name: "Not theirs", apps: policy });
          expect(refused.status, JSON.stringify(refused.body)).toBe(409);
          expect(JSON.stringify(refused.body)).toContain("ConnectionIdTaken");
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.connectionKeyRevoke.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          telemetry = yield* Telemetry;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const receipt = randomUUID();
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Key rotation app ${receipt.slice(0, 8)}`,
          files: readWriteAppFiles(receipt),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const appPath = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", appPath).pipe(Effect.ignore),
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${appPath}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${appPath}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const connect = (name: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.member, "POST", `${prefix}/mcp-connections`, {
              id: randomUUID(),
              name,
              apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }],
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            return yield* body(ConnectionView, created);
          });
        const seat = yield* connect(`Seat ${receipt.slice(0, 6)}`);
        const other = yield* connect(`Other seat ${receipt.slice(0, 6)}`);
        const keysPath = (connection: string) => `${prefix}/mcp-connections/${connection}/keys`;
        const revokePath = (connection: string, key: string) =>
          `${keysPath(connection)}/${key}/revoke`;
        const mint = (name: string) =>
          Effect.gen(function* () {
            const minted = yield* api.request(actors.member, "POST", keysPath(seat.id), {
              name,
              expiresInSeconds: 90 * 86400,
            });
            expect(minted.status, JSON.stringify(minted.body)).toBe(200);
            return yield* body(ConnectionKey, minted);
          });

        // The seat's owner mints its current key and the replacement.
        const current = yield* mint(`Seat key ${receipt.slice(0, 6)}`);
        const replacement = yield* mint(`Replacement ${receipt.slice(0, 6)}`);

        // The owner lists both, newest first, with names and expiry but never the secrets.
        const listed = yield* api.request(actors.member, "GET", keysPath(seat.id));
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const keys = yield* body(Schema.Array(KeySummary), listed);
        expect(keys.map((key) => key.id).sort()).toEqual([current.id, replacement.id].sort());
        for (const [key, secret] of [
          [keys.find((item) => item.id === current.id), current.key],
          [keys.find((item) => item.id === replacement.id), replacement.key],
        ] as const) {
          expect(key?.expiresAt).not.toBeNull();
          expect(key?.start).not.toBeNull();
          expect(Redacted.value(secret).startsWith(key?.start ?? "-")).toBe(true);
          expect(Redacted.value(secret).length).toBeGreaterThan((key?.start ?? "").length + 16);
        }
        expect(keys.map((key) => key.name).sort()).toEqual(
          [`Replacement ${receipt.slice(0, 6)}`, `Seat key ${receipt.slice(0, 6)}`].sort(),
        );
        const listedText = JSON.stringify(listed.body);
        expect(listedText).not.toContain(Redacted.value(current.key));
        expect(listedText).not.toContain(Redacted.value(replacement.key));
        expect(listedText).not.toContain('"key"');
        // Another connection lists none of them.
        const otherKeys = yield* api.request(actors.member, "GET", keysPath(other.id));
        expect(otherKeys.status).toBe(200);
        expect(otherKeys.body).toEqual([]);

        // No one else can list or revoke them: an admin and the organization's owner see no such
        // connection, and the key itself is never accepted by the API.
        for (const actor of [actors.admin, actors.owner]) {
          expect((yield* api.request(actor, "GET", keysPath(seat.id))).status).toBe(404);
          expect((yield* api.request(actor, "POST", revokePath(seat.id, current.id))).status).toBe(
            404,
          );
        }
        const asKey = (
          secret: Redacted.Redacted<string>,
          method: "GET" | "POST",
          path: string,
          data?: unknown,
        ) =>
          Effect.gen(function* () {
            return yield* api.request(yield* api.session(), method, path, data, {
              authorization: `Bearer ${Redacted.value(secret)}`,
              "x-executor-organization": organization,
              accept: "application/json, text/event-stream",
            });
          });
        for (const [method, path] of [
          ["GET", keysPath(seat.id)],
          ["POST", revokePath(seat.id, current.id)],
        ] as const) {
          const refused = yield* asKey(replacement.key, method, path);
          expect(refused.status, JSON.stringify(refused.body)).toBe(403);
          expect(JSON.stringify(refused.body)).toContain("ConnectionKeyRefused");
        }
        // A key is revoked only through its own connection.
        const elsewhere = yield* api.request(
          actors.member,
          "POST",
          revokePath(other.id, current.id),
        );
        expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(404);
        expect(JSON.stringify(elsewhere.body)).toContain("ConnectionKeyNotFound");

        // Both keys work at the seat's URL before the rotation.
        const atConnection = (secret: Redacted.Redacted<string>, label: string) =>
          Effect.exit(
            Effect.gen(function* () {
              const client = yield* mcp.connect(secret, label, {
                organization,
                connection: seat.id,
              });
              return yield* client.use(`${label}: list tools`, (session, signal) =>
                session.listTools(undefined, { signal }),
              );
            }),
          );
        expect(Exit.isSuccess(yield* atConnection(current.key, "current key"))).toBe(true);
        expect(Exit.isSuccess(yield* atConnection(replacement.key, "replacement key"))).toBe(true);

        // The owner revokes the old key; the revocation is in the audit log.
        const trace = randomBytes(16).toString("hex");
        const revoked = yield* api.request(
          actors.member,
          "POST",
          revokePath(seat.id, current.id),
          undefined,
          { traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01` },
        );
        expect(revoked.status, JSON.stringify(revoked.body)).toBeLessThan(300);
        const audit = yield* telemetry.logs(trace).pipe(
          Effect.filterOrFail((text) => text.includes(current.id)),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
        );
        expect(audit).toContain(seat.id);
        expect(audit).toContain("mcp-connection-key");

        // The old key is refused at once at the seat's URL; the replacement keeps working.
        const refused = yield* asKey(current.key, "POST", `/mcp?connection=${seat.id}`, initialize);
        expect(refused.status, JSON.stringify(refused.body)).toBe(401);
        expect(Exit.isFailure(yield* atConnection(current.key, "revoked key"))).toBe(true);
        expect(Exit.isSuccess(yield* atConnection(replacement.key, "kept key"))).toBe(true);
        // The connection stands, with only the replacement listed; revoking again finds nothing.
        const connections = yield* body(
          Schema.Array(ConnectionView),
          yield* api.request(actors.member, "GET", `${prefix}/mcp-connections`),
        );
        expect(connections.map((connection) => connection.id)).toContain(seat.id);
        const remaining = yield* body(
          Schema.Array(KeySummary),
          yield* api.request(actors.member, "GET", keysPath(seat.id)),
        );
        expect(remaining.map((key) => key.id)).toEqual([replacement.id]);
        expect(
          (yield* api.request(actors.member, "POST", revokePath(seat.id, current.id))).status,
        ).toBe(404);

        // In the dashboard the owner sees the seat's key and revokes it after confirming.
        const browser = yield* Browser;
        yield* browser.login(actors.member);
        yield* browser.use("Open the member's connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        yield* browser.use("Open the seat's connection", (page) =>
          page.getByRole("link", { name: seat.name, exact: true }).click(),
        );
        const keyName = `Replacement ${receipt.slice(0, 6)}`;
        const keyList = (page: Page) => page.getByRole("region", { name: "Connection keys" });
        yield* browser.use("See the replacement key listed", (page) =>
          keyList(page)
            .getByRole("listitem")
            .filter({ hasText: keyName })
            .waitFor({ state: "visible" }),
        );
        const shownText = yield* browser.use("Read the key list", (page) =>
          keyList(page).innerText(),
        );
        expect(shownText).not.toContain(Redacted.value(replacement.key));
        expect(shownText).not.toContain(`Seat key ${receipt.slice(0, 6)}`);
        yield* browser.use("Start revoking the key", (page) =>
          keyList(page)
            .getByRole("button", { name: `Revoke ${keyName}`, exact: true })
            .click(),
        );
        yield* browser.use("Confirm the revocation", (page) =>
          page.getByRole("button", { name: "Revoke key", exact: true }).click(),
        );
        yield* browser.use("The key leaves the list", (page) =>
          keyList(page).getByText("No keys.", { exact: false }).waitFor({ state: "visible" }),
        );
        expect(Exit.isFailure(yield* atConnection(replacement.key, "dashboard-revoked key"))).toBe(
          true,
        );
        // The connection still stands after both revocations.
        const after = yield* body(
          Schema.Array(ConnectionView),
          yield* api.request(actors.member, "GET", `${prefix}/mcp-connections`),
        );
        expect(after.map((connection) => connection.id)).toContain(seat.id);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
