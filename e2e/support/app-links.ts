/**
 * A hosted app with app requirements, which its managers fill by linking accounts for everyone,
 * removed with the accounts the scenario saved for it.
 */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { Actors } from "./actors.ts";
import { App, Resource } from "./contracts.ts";
import type { Response } from "./platform.ts";
import { appsManifest } from "./apps-release.ts";
import { removeAppWhenStopped } from "./webhook-sources.ts";
import { connectionsPath, requirementPath, type LinkScope } from "./app-accounts.ts";

/**
 * One account linked to one of the app's own requirements, as `/accounts/app` lists it. Only
 * people who can edit the app read the upstream identity its checks reported.
 */
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
/**
 * One requirement in one scope, as `/accounts/{app|user}/:requirement` reads it: its linked
 * accounts in link order, then the caller's other usable accounts of its provider.
 */
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
/** A failure's tag and, for an account requirement, which requirement in which scope. */
export const Failure = Schema.Struct({
  _tag: Schema.String,
  slot: Schema.optional(Schema.String),
  requirement: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const Access = Schema.Struct({ revision: Schema.String });
const Viewer = Schema.Struct({ userId: Schema.String });
const Directory = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });

/** A key-account provider definition named `name`, for an app source. */
export const keyProvider = (name: string) =>
  `defineProvider({ name: ${JSON.stringify(name)}, auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } })`;

/** Require a 200 response and return its body. */
export const ok = (response: Response) =>
  Effect.sync(() => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body;
  });

/** Require a 200 response and decode its body. */
export const okBody = <A>(schema: Schema.ConstraintDecoder<A, never>, response: Response) =>
  ok(response).pipe(Effect.andThen(body(schema, response)));

/** Require a refusal with this status and tag, and decode it. */
export const refused = (response: Response, status: number, tag: string) =>
  Effect.gen(function* () {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    const failure = yield* body(Failure, response);
    expect(failure._tag).toBe(tag);
    return failure;
  });

/**
 * Deploy `files` as a new app everyone in the organization may use. Removing it on cleanup waits
 * for its webhooks to stop and deletes the app's links, so the accounts saved through
 * `connect` can be deleted after it.
 */
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
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const other of [path, ...others]) yield* removeAppWhenStopped(actors.owner, other);
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
    /** Let everyone in the organization use the app at `appPath`. */
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
    /** Deploy another app everyone may use, removed on cleanup before the fixture's accounts. */
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
    /**
     * Start a connection from the app at `appPath` (the fixture's app by default) for
     * `requirement` in `scope`; the response is the caller's to check.
     */
    const start = (
      actor: Session,
      scope: LinkScope,
      requirement: string,
      destination: unknown,
      appPath: string = path,
    ) => api.request(actor, "POST", connectionsPath(appPath, scope, requirement), { destination });
    /** Submit a key for a started connection. */
    const submit = (actor: Session, connection: string, token: string) =>
      api.request(actor, "POST", `${prefix}/connections/${connection}/submit`, {
        method: "key",
        label: token,
        fields: { token },
      });
    /**
     * Connect a key account from the app for `requirement` in `scope`: for an app requirement this
     * links it for everyone, for a user requirement it links it for the connecting member.
     */
    const connect = (
      actor: Session,
      scope: LinkScope,
      requirement: string,
      token: string,
      destination: unknown = { kind: "personal" },
    ) =>
      Effect.gen(function* () {
        const started = yield* start(actor, scope, requirement, destination);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const response = yield* submit(actor, (yield* body(Resource, started)).id, token);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const account = (yield* body(Resource, response)).id;
        saved.push({ actor, id: account });
        return account;
      });
    const appLinkPath = (requirement: string, account: string) =>
      `${requirementPath(path, "app", requirement)}/${encodeURIComponent(account)}`;
    /** Link an account to one of the app's own requirements; the response is the caller's to check. */
    const link = (actor: Session, requirement: string, account: string) =>
      api.request(actor, "PUT", appLinkPath(requirement, account));
    /** Unlink an account from one of the app's own requirements; the response is the caller's to check. */
    const unlink = (actor: Session, requirement: string, account: string) =>
      api.request(actor, "DELETE", appLinkPath(requirement, account));
    /** The app's own links, oldest first per requirement, as `actor` lists them. */
    const links = (actor: Session = actors.owner) =>
      api.request(actor, "GET", `${path}/accounts/app`).pipe(
        Effect.tap(ok),
        Effect.flatMap((response) => body(Schema.Array(AppLink), response)),
      );
    /** Read one requirement of the app in `scope`; the response is the caller's to check. */
    const get = (actor: Session, scope: LinkScope, requirement: string) =>
      api.request(actor, "GET", requirementPath(path, scope, requirement));
    /** Call a tool as `actor`, with the app's own links and the caller's links. */
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
    /** Create a group of these members, removed on cleanup. */
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
        /** Replace the group's members. */
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
      /** Record an account saved outside `connect` for cleanup. */
      saved: (actor: Session, id: string) => Effect.sync(() => saved.push({ actor, id })),
    };
  });
