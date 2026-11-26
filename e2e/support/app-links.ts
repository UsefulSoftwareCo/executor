import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { Actors } from "./actors.ts";
import { App, Resource } from "./contracts.ts";
import type { Response } from "./platform.ts";
import { appsManifest } from "./apps-release.ts";
import {
  removeAppWhenStopped,
  confirmWebhookRemoval,
  settleWebhookSubscriptions,
  webhookSubscriptions,
} from "./webhook-sources.ts";
import { connectionsPath, requirementPath, type LinkScope } from "./app-accounts.ts";

export const AppLink = Schema.Struct({
  requirement: Schema.String,
  account: Schema.Struct({ id: Schema.String, label: Schema.String }),
  health: Schema.optional(
    Schema.Struct({
      info: Schema.NullOr(Schema.Unknown),
      infoCheckedAt: Schema.NullOr(Schema.String),
    }),
  ),
});
export const LinkRequirement = Schema.Struct({
  requirement: Schema.String,
  scope: Schema.Literals(["app", "user"]),
  provider: Schema.String,
  cardinality: Schema.Literals(["one", "many"]),
  accounts: Schema.Array(
    Schema.Struct({
      account: Schema.Struct({ id: Schema.String, label: Schema.String }),
      linked: Schema.Boolean,
    }),
  ),
});
export const Failure = Schema.Struct({
  _tag: Schema.String,
  slot: Schema.optional(Schema.String),
  requirement: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const Access = Schema.Struct({ revision: Schema.String });
const Subscription = Schema.Struct({ id: Schema.String, status: Schema.String });
const Listed = Schema.Struct({ id: Schema.String });
const Viewer = Schema.Struct({ userId: Schema.String });
const Directory = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });

export const keyProvider = (name: string) =>
  `defineProvider({ name: ${JSON.stringify(name)}, auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } })`;

export const ok = (response: Response) =>
  Effect.sync(() => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body;
  });

export const okBody = <A>(schema: Schema.ConstraintDecoder<A, never>, response: Response) =>
  ok(response).pipe(Effect.andThen(body(schema, response)));

export const refused = (response: Response, status: number, tag: string) =>
  Effect.gen(function* () {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    const failure = yield* body(Failure, response);
    expect(failure._tag).toBe(tag);
    return failure;
  });

export const appLinksFixture = (files: ReadonlyArray<{ path: string; content: string }>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `App links ${randomUUID().slice(0, 8)}`,
      files: [...files, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed),
      path = `${prefix}/apps/${app.id}`;
    const saved: { actor: Session; id: string }[] = [];
    const groups: string[] = [];
    const others: string[] = [];
    const userLinks: { actor: Session; requirement: string; account: string }[] = [];
    const sessions = new Map<string, Session>();
    const releaseWebhooks = (appPath: string) =>
      Effect.gen(function* () {
        const apps = yield* api.request(actors.owner, "GET", `${prefix}/apps`);
        expect(apps.status, JSON.stringify(apps.body)).toBe(200);
        const id = appPath.slice(appPath.lastIndexOf("/") + 1);
        if (!(yield* body(Schema.Array(Listed), apps)).some((item) => item.id === id)) return;
        const listed = yield* api.request(actors.owner, "GET", `${appPath}/accounts/app`);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        for (const item of yield* body(Schema.Array(AppLink), listed)) {
          const unlinked = yield* api.request(
            actors.owner,
            "DELETE",
            `${requirementPath(appPath, "app", item.requirement)}/${encodeURIComponent(item.account.id)}`,
          );
          expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
        }
        if (appPath === path)
          for (const item of userLinks) {
            const unlinked = yield* api.request(
              item.actor,
              "DELETE",
              `${requirementPath(appPath, "user", item.requirement)}/${encodeURIComponent(item.account)}`,
            );
            if (unlinked.status !== 200) {
              expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(404);
              expect((yield* body(Failure, unlinked))._tag).toBe("AccountNotFound");
            }
          }
        const confirmed = new Set<string>();
        const visible: Session[] = [];
        for (const actor of [actors.owner, actors.admin, actors.member]) {
          const read = yield* api.request(actor, "GET", `${appPath}/webhooks`);
          if (read.status === 403 || read.status === 401) {
            expect((yield* body(Failure, read))._tag, JSON.stringify(read.body)).toBe(
              read.status === 403 ? "OrganizationForbidden" : "Unauthorized",
            );
            continue;
          }
          expect(read.status, JSON.stringify(read.body)).toBe(200);
          visible.push(actor);
          const settled = yield* settleWebhookSubscriptions(actor, appPath, (rows) =>
            rows.every((row) => row.status === "disabled" || row.status === "stopped"),
          );
          for (const row of settled) {
            if (row.status !== "disabled" || confirmed.has(row.id)) continue;
            confirmed.add(row.id);
            const as = (row.actor === null ? undefined : sessions.get(row.actor)) ?? actor;
            const { response: removal } = yield* confirmWebhookRemoval(as, appPath, row.id);
            expect(removal.status, JSON.stringify(removal.body)).toBe(200);
            expect(yield* body(Subscription, removal)).toEqual({ id: row.id, status: "stopped" });
          }
        }
        for (const actor of visible)
          expect(
            (yield* webhookSubscriptions(actor, appPath)).filter((row) => row.status !== "stopped"),
          ).toEqual([]);
      });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const other of [path, ...others]) {
          yield* releaseWebhooks(other);
          yield* removeAppWhenStopped(actors.owner, other);
        }
        for (const item of saved)
          yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
        for (const group of groups) {
          const current = yield* api.request(actors.owner, "GET", `${prefix}/groups/${group}`);
          if (current.status === 200)
            yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${group}`, {
              revision: (yield* body(Group, current)).revision,
            });
        }
      }).pipe(Effect.orDie),
    );
    const share = (appPath: string) =>
      Effect.gen(function* () {
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
      });
    yield* share(path);
    const another = (content: string) =>
      Effect.gen(function* () {
        const created = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Other app ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content }, appsManifest],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const otherPath = `${prefix}/apps/${(yield* body(App, created)).id}`;
        others.push(otherPath);
        yield* share(otherPath);
        return otherPath;
      });
    const start = (actor: Session, scope: LinkScope, requirement: string, appPath: string = path) =>
      api.request(actor, "POST", connectionsPath(appPath, scope, requirement), {});
    const submit = (actor: Session, connection: string, token: string) =>
      api.request(actor, "POST", `${prefix}/connections/${connection}/submit`, {
        method: "key",
        label: token,
        fields: { token },
      });
    const connect = (actor: Session, scope: LinkScope, requirement: string, token: string) =>
      Effect.gen(function* () {
        const started = yield* start(actor, scope, requirement);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const response = yield* submit(actor, (yield* body(Resource, started)).id, token);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const account = (yield* body(Resource, response)).id;
        saved.push({ actor, id: account });
        if (scope === "user") userLinks.push({ actor, requirement, account });
        return account;
      });
    const appLinkPath = (requirement: string, account: string) =>
      `${requirementPath(path, "app", requirement)}/${encodeURIComponent(account)}`;
    const link = (actor: Session, requirement: string, account: string) =>
      api.request(actor, "PUT", appLinkPath(requirement, account));
    const unlink = (actor: Session, requirement: string, account: string) =>
      api.request(actor, "DELETE", appLinkPath(requirement, account));
    const links = (actor: Session = actors.owner) =>
      api.request(actor, "GET", `${path}/accounts/app`).pipe(
        Effect.tap(ok),
        Effect.flatMap((response) => body(Schema.Array(AppLink), response)),
      );
    const get = (actor: Session, scope: LinkScope, requirement: string) =>
      api.request(actor, "GET", requirementPath(path, scope, requirement));
    const call = (actor: Session, tool: string, kind: "query" | "mutation" = "query") =>
      api.request(actor, "POST", `${path}/tools/call`, { tool, kind, input: {} });
    const userIds = yield* Effect.all(
      [actors.owner, actors.admin, actors.member].map((actor) =>
        api.request(actor, "GET", "/api/viewer").pipe(
          Effect.flatMap((read) => body(Viewer, read)),
          Effect.map((viewer) => viewer.userId),
        ),
      ),
      { concurrency: 3 },
    );
    const [owner, admin, member] = userIds;
    if (owner === undefined || admin === undefined || member === undefined)
      return yield* Effect.die(new Error("Missing viewers"));
    sessions.set(owner, actors.owner).set(admin, actors.admin).set(member, actors.member);
    const group = (members: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const directory = yield* body(
          Directory,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        );
        const memberIds = members.map((user) => {
          const found = directory.members.find((item) => item.userId === user);
          if (found === undefined) throw new Error("Missing synthetic group member");
          return found.id;
        });
        const name = `App links ${randomUUID().slice(0, 8)}`;
        const created = yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
          name,
          description: "",
          memberIds,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const read = yield* body(Group, created);
        groups.push(read.id);
        const set = (next: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const current = yield* body(
              Group,
              yield* api.request(actors.owner, "GET", `${prefix}/groups/${read.id}`),
            );
            const changed = yield* api.request(
              actors.owner,
              "PATCH",
              `${prefix}/groups/${read.id}`,
              {
                name,
                description: "",
                memberIds: next.map((user) => {
                  const found = directory.members.find((item) => item.userId === user);
                  if (found === undefined) throw new Error("Missing synthetic group member");
                  return found.id;
                }),
                revision: current.revision,
              },
            );
            expect(changed.status, JSON.stringify(changed.body)).toBe(200);
          });
        return { id: read.id, set };
      });
    return {
      api,
      actors,
      prefix,
      app,
      path,
      ids: { owner, admin, member },
      another,
      start,
      submit,
      connect,
      link,
      unlink,
      links,
      get,
      call,
      group,
      saved: (actor: Session, id: string) => Effect.sync(() => saved.push({ actor, id })),
    };
  });
