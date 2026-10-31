/**
 * Apps written before app and user accounts keep running on the host that has them. An app built
 * with the published `apps@0.0.1-beta.84`, a release of protocol 12, declares `{ accounts }`
 * and reads `ctx.accounts`. The host reads such a bundle's requirements as user requirements: each
 * caller's call runs with the account they linked, and an app manager cannot link an account to
 * it for everyone.
 *
 * Upgrading storage written before app accounts changes no stored state. The fixture builds an
 * app on that release with a member's schedule and a workflow run, then rebuilds the database as
 * the upgrade finds it: it undoes SDK 4.0.14 (see `beforeAppAccounts`) and labels the database
 * 4.0.13. The host's link step, which ships with it, stays recorded with the member's link. The
 * next start runs 4.0.14. The member's link, schedule copy and run are unchanged and the app has
 * no app links; the run's start key still deduplicates, and after a redeploy that adds an app
 * requirement, a manager links an account for everyone that the app's calls then use.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import {
  accountLinks,
  connectLocalAccount,
  connectionsPath,
  linkAccountResponse,
  type LinkScope,
} from "../support/app-accounts.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { localAccountLinks, localAgent, localAppPath } from "../support/local-links.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { beforeAppAccounts } from "../support/profile-removal-rollback.ts";
import { serverControl } from "../support/server-control.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Evidence } from "../support/evidence.ts";

/** The last `apps` release of protocol 12, resolved from the run's locked registry. */
const protocol12 = "0.0.1-beta.84";

// app-user-accounts: keep, as source of an earlier `apps` release.
/** One account requirement in the protocol-12 shape and a tool that returns its token. */
const files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, object, query, router, secrets, string } from "apps";
const service = defineProvider({ name: "Protocol 12 accounts fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) }),
} });
export default defineApp({ accounts: { service } }, {
  tools: router({
    token: query({ input: object({}), output: string() }, async (ctx) => ctx.accounts.service.fields.token),
  }),
});
`,
  },
  { path: "package.json", content: JSON.stringify({ dependencies: { apps: protocol12 } }) },
];

/** A deployed app's requirements, each with the scope the host recorded at deploy. */
const Requirements = Schema.Struct({
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ scope: Schema.String })),
  }),
});
const Access = Schema.Struct({ revision: Schema.String });
const Mismatch = Schema.Struct({
  _tag: Schema.Literal("RequirementMismatch"),
  requirement: Schema.String,
  scope: Schema.String,
  reason: Schema.String,
});
const Completed = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Json });

const providerSource = `const service = defineProvider({ name: "Upgrade accounts fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) }),
} });`;
// app-user-accounts: keep, as source of an earlier `apps` release.
/** The app before the upgrade: a protocol-12 account, a schedule of each member's and a workflow. */
const beforeUpgrade = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, interval, mutation, object, query, router, secrets, string, workflow } from "apps";
${providerSource}
const token = query({ input: object({}), output: string() }, async (ctx) => ctx.accounts.service.fields.token);
const tick = mutation({ input: object({}), output: string() }, async (ctx) => ctx.accounts.service.fields.token);
const capture = workflow({ input: object({}) }, async (ctx) => ctx.step.do("read", async (step) => step.accounts.service.fields.token));
export default defineApp({ accounts: { service } }, {
  tools: router({ token, tick }),
  workflows: { capture },
  schedules: { tick: interval({ minutes: 60 }, tick, {}) },
});
`,
  },
  { path: "package.json", content: JSON.stringify({ dependencies: { apps: protocol12 } }) },
];
/** The same app on the current release, with an app requirement its managers link. */
const afterUpgrade = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, mutation, object, query, router, secrets, string, userInterval, workflow,
  type MutationContext, type QueryContext, type WorkflowContext } from "apps";
${providerSource}
const team = defineProvider({ name: "Upgrade team fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) }),
} });
const requirements = { app: { accounts: { team } }, user: { accounts: { service } } };
const token = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  [ctx.user.accounts.service.fields.token, ctx.app.accounts.team.fields.token]);
const tick = mutation({ input: object({}), output: string() }, async (ctx: MutationContext<typeof requirements>) => ctx.user.accounts.service.fields.token);
const capture = workflow({ input: object({}) }, async (ctx: WorkflowContext<typeof requirements>) =>
  ctx.step.do("read", async (step) => step.user.accounts.service.fields.token));
export default defineApp(requirements, {
  tools: router({ token, tick }),
  workflows: { capture },
  schedules: { tick: userInterval({ minutes: 60 }, tick, {}) },
});
`,
  },
  appsManifest,
];

const Settings = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
});
const Run = Schema.Struct({ status: Schema.String, output: Schema.optionalKey(Schema.Json) });
class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}

/** One host's routes for the upgrade flow. */
interface UpgradeHost {
  readonly journal: "private_hosted" | "private_local";
  /** The host's table of app and user links. */
  readonly linkTable: "hosted_app_account_links" | "local_app_account_links";
  /** The subject a member's schedule copy records. */
  readonly actor: string;
  readonly deploy: (
    files: ReadonlyArray<{ path: string; content: string }>,
  ) => Effect.Effect<string, never, Api>;
  readonly redeploy: (
    files: ReadonlyArray<{ path: string; content: string }>,
  ) => Effect.Effect<void, never, Api>;
  /**
   * Connect a key account from the app for `requirement` in `scope`, which links it there: for
   * the caller, or for everyone.
   */
  readonly connect: (
    scope: LinkScope,
    requirement: string,
    token: string,
  ) => Effect.Effect<string, never, Api>;
  readonly call: (tool: string, kind: "query" | "mutation") => Effect.Effect<unknown, never, Api>;
  /** The app's links in one scope as `[requirement, account]` pairs. */
  readonly links: (
    scope: LinkScope,
  ) => Effect.Effect<ReadonlyArray<readonly [string, string]>, never, Api>;
  readonly schedules: Effect.Effect<ReadonlyArray<typeof Settings.Type>, never, Api>;
  readonly enableSchedule: Effect.Effect<void, never, Api>;
  /** Start `capture` under a start key and return the run's ID. */
  readonly start: (key: string) => Effect.Effect<string, never, Api>;
  readonly run: (id: string) => Effect.Effect<typeof Run.Type, never, Api>;
}

/** One parameterized statement against the stopped product's database. */
type Statement = { readonly sql: string; readonly params?: ReadonlyArray<string> };

/**
 * Build state before app accounts, upgrade the stopped product's storage, and check it after.
 * `storage` is the planned scenario's legacy storage write.
 */
const upgradeFlow = <E, R>(
  host: UpgradeHost,
  storage: (
    statements: readonly [Statement, ...Statement[]],
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, E, R>,
) =>
  Effect.gen(function* () {
    const app = yield* host.deploy(beforeUpgrade);
    const account = yield* host.connect("user", "service", "synthetic-upgrade-user");
    expect(yield* host.call("token", "query")).toBe("synthetic-upgrade-user");
    yield* host.enableSchedule;
    const key = `upgrade-${randomUUID()}`;
    const started = yield* host.start(key);
    const completed = yield* host.run(started).pipe(
      Effect.flatMap((run) =>
        ["queued", "running", "waiting"].includes(run.status)
          ? Effect.fail(new Pending())
          : Effect.succeed(run),
      ),
      Effect.retry({
        while: (error) => error instanceof Pending,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeout("20 seconds"),
    );
    expect(completed).toEqual({ status: "complete", output: "synthetic-upgrade-user" });
    const copies = yield* host.schedules;
    expect(copies).toEqual([
      expect.objectContaining({ name: "tick", actor: host.actor, enabled: true }),
    ]);

    const scheduleRows = {
      sql: "SELECT id, actor FROM executor_schedules WHERE app = $1 ORDER BY id",
      params: [app],
    };
    const sourceRows = {
      sql: "SELECT account, actor FROM executor_webhook_sources WHERE app = $1 ORDER BY account",
      params: [app],
    };
    const linkRows = {
      sql: `SELECT requirement, subject, account FROM ${host.linkTable}
        WHERE app = $1 ORDER BY requirement, account`,
      params: [app],
    };
    const linkStep = {
      sql: `SELECT name FROM ${host.journal}_migrations WHERE name = 'app_account_links'`,
    };
    const [schedulesBefore, sourcesBefore, runsBefore, linksBefore, stepBefore] = yield* storage([
      scheduleRows,
      sourceRows,
      {
        sql: "SELECT id, actor, start_key FROM executor_workflow_runs WHERE app = $1",
        params: [app],
      },
      linkRows,
      linkStep,
      ...beforeAppAccounts(),
    ]);
    // The host's link step stays recorded, holding the member's link and no app link.
    expect(stepBefore).toEqual([{ name: "app_account_links" }]);
    expect(linksBefore).toEqual([{ requirement: "service", subject: host.actor, account }]);
    expect(schedulesBefore).toEqual([{ id: copies[0]?.id, actor: host.actor }]);
    expect(runsBefore).toEqual([{ id: started, actor: host.actor, start_key: key }]);
    // Linking the account made it the app's webhook source, with the member as its actor.
    expect(sourcesBefore).toEqual([{ account, actor: host.actor }]);
    yield* serverControl("start");

    // Nothing was converted: the link, the schedule copy and the run are as they were, and the
    // app has no app links.
    expect(yield* host.links("user")).toEqual([["service", account]]);
    expect(yield* host.links("app")).toEqual([]);
    expect(yield* host.schedules).toEqual(copies);
    expect(yield* host.run(started)).toEqual(completed);
    expect(yield* host.call("token", "query")).toBe("synthetic-upgrade-user");
    // The start key still names the same run.
    expect(yield* host.start(key)).toBe(started);

    // Redeployed with an app requirement, the app's manager links an account for everyone that
    // calls use beside the member's link; the schedule copy stays the member's.
    yield* host.redeploy(afterUpgrade);
    const team = yield* host.connect("app", "team", "synthetic-upgrade-team");
    expect(yield* host.links("app")).toEqual([["team", team]]);
    expect(yield* host.links("user")).toEqual([["service", account]]);
    expect(yield* host.call("token", "query")).toEqual([
      "synthetic-upgrade-user",
      "synthetic-upgrade-team",
    ]);
    expect(yield* host.schedules).toEqual([
      expect.objectContaining({ id: copies[0]?.id, actor: host.actor, enabled: true }),
    ]);

    // What the upgrade wrote, read from storage.
    const [version, step, scopes, nullable, schedulesAfter, sourcesAfter, linksAfter] =
      yield* storage([
        { sql: "SELECT value FROM private_executor_settings WHERE key = 'version'" },
        linkStep,
        { sql: "SELECT id, scope FROM executor_workflow_runs WHERE app = $1", params: [app] },
        {
          sql: `SELECT table_name, is_nullable FROM information_schema.columns
          WHERE column_name = 'actor' AND table_name IN ('executor_schedules', 'executor_webhook_sources')
          ORDER BY table_name`,
        },
        scheduleRows,
        sourceRows,
        linkRows,
      ]);
    yield* serverControl("start");
    yield* (yield* Evidence).json("upgraded-storage.json", {
      before: { schedulesBefore, sourcesBefore, runsBefore, linksBefore, stepBefore },
      after: { version, step, scopes, nullable, schedulesAfter, sourcesAfter, linksAfter },
    });
    expect(version).toEqual([{ value: "4.0.23" }]);
    expect(step).toEqual([{ name: "app_account_links" }]);
    // The member's user link as it was, and the app link without a subject.
    expect(linksAfter).toEqual([
      { requirement: "service", subject: host.actor, account },
      { requirement: "team", subject: null, account: team },
    ]);
    expect(scopes).toEqual([{ id: started, scope: "user" }]);
    expect(nullable).toEqual([
      { table_name: "executor_schedules", is_nullable: "YES" },
      { table_name: "executor_webhook_sources", is_nullable: "YES" },
    ]);
    expect(schedulesAfter).toEqual(schedulesBefore);
    // The member's webhook source keeps its actor; the app link's has none.
    expect(sourcesAfter).toHaveLength(2);
    expect(sourcesAfter).toEqual(
      expect.arrayContaining([
        { account, actor: host.actor },
        { account: team, actor: null },
      ]),
    );
  });

layer(HostedLive, { excludeTestServices: true })("Protocol-12 accounts on hosted", (it) => {
  it.effect(scenarios.protocol12UserAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Protocol 12 accounts ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const saved: { actor: Session; id: string }[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const item of saved)
              yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
          }).pipe(Effect.orDie),
        );
        const read = yield* api.request(actors.owner, "GET", path);
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect((yield* body(Requirements, read)).requirements.accounts).toEqual({
          service: { scope: "user" },
        });
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        const opened = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
          revision: access.revision,
          audience: { kind: "everyone" },
        });
        expect(opened.status, JSON.stringify(opened.body)).toBe(200);

        /** Connect a key account from the app, which links it for the connecting member. */
        const connect = (actor: Session, token: string) =>
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
              { method: "key", label: token, fields: { token } },
            );
            expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
            const account = (yield* body(Resource, submitted)).id;
            saved.push({ actor, id: account });
            return account;
          });
        const token = (actor: Session) =>
          api.request(actor, "POST", `${path}/tools/call`, {
            tool: "token",
            kind: "query",
            input: {},
          });

        // Before a member links an account, the user requirement has none.
        const missing = yield* token(actors.admin);
        expect(missing.status, JSON.stringify(missing.body)).toBe(409);
        expect(missing.body).toMatchObject({ _tag: "AccountRequired", slot: "service" });

        // Each member's call runs with the account they linked.
        const owned = yield* connect(actors.owner, "synthetic-protocol12-owner");
        const admins = yield* connect(actors.admin, "synthetic-protocol12-admin");
        expect(yield* accountLinks(actors.owner, path)).toEqual([["service", owned]]);
        expect(yield* accountLinks(actors.admin, path)).toEqual([["service", admins]]);
        for (const [actor, expected] of [
          [actors.owner, "synthetic-protocol12-owner"],
          [actors.admin, "synthetic-protocol12-admin"],
        ] as const) {
          const called = yield* token(actor);
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          expect(called.body).toBe(expected);
        }

        // The requirement is a user requirement, so its manager cannot link an account to it for
        // everyone, and the app has no app links.
        const linked = yield* linkAccountResponse(actors.owner, path, "service", owned, "app");
        expect(linked.status, JSON.stringify(linked.body)).toBe(422);
        expect(yield* body(Mismatch, linked)).toMatchObject({
          requirement: "service",
          scope: "app",
          reason: "requirement",
        });
        expect(yield* accountLinks(actors.owner, path, "app")).toEqual([]);
        expect((yield* token(actors.owner)).body).toBe("synthetic-protocol12-owner");
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Protocol-12 accounts on local", (it) => {
  it.effect(scenarios.localProtocol12UserAccounts.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent } = yield* localAgent;
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Protocol 12 accounts ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String, ...Requirements.fields }) }),
          deployed,
        );
        expect(app.requirements.accounts).toEqual({ service: { scope: "user" } });
        const saved: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`);
            for (const account of saved)
              yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const token = api.request(agent, "POST", "/v1/tools/call", {
          app: app.id,
          tool: "token",
          kind: "query",
          input: {},
        });

        const missing = yield* token;
        expect(missing.status, JSON.stringify(missing.body)).toBe(409);
        expect(missing.body).toMatchObject({ _tag: "AccountRequired", slot: "service" });

        // Connecting from the app links the account, and the call runs with it.
        const account = (yield* connectLocalAccount(agent, {
          app: app.id,
          requirement: "service",
          method: "key",
          label: "Protocol 12",
          fields: { token: "synthetic-protocol12-local" },
        })).id;
        saved.push(account);
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["service", account]]);
        const called = yield* token;
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect((yield* body(Completed, called)).value).toBe("synthetic-protocol12-local");

        // The requirement is a user requirement: linking it as an app link is refused, and the
        // app has no app links.
        const linked = yield* linkAccountResponse(
          agent,
          localAppPath(app.id),
          "service",
          account,
          "app",
        );
        expect(linked.status, JSON.stringify(linked.body)).toBe(422);
        expect(yield* body(Mismatch, linked)).toMatchObject({
          requirement: "service",
          scope: "app",
          reason: "requirement",
        });
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([]);
        expect((yield* body(Completed, yield* token)).value).toBe("synthetic-protocol12-local");
      }),
    ),
  );
});

layer(HostedLive, { excludeTestServices: true })("App accounts storage upgrade on hosted", (it) => {
  it.effect(scenarios.appAccountsStorageUpgrade.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const owner = actors.owner;
        const viewer = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(owner, "GET", "/api/viewer"),
        );
        let path = "";
        const saved: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (path !== "") yield* api.request(owner, "DELETE", path);
            for (const id of saved) yield* api.request(owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        const ok = (response: { status: number; body: unknown }) =>
          Effect.sync(() => {
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return response.body;
          });
        yield* upgradeFlow(
          {
            journal: "private_hosted",
            linkTable: "hosted_app_account_links",
            actor: viewer.userId,
            deploy: (files) =>
              Effect.gen(function* () {
                const deployed = yield* api.request(owner, "POST", `${prefix}/apps/deploy`, {
                  name: `Upgrade accounts ${randomUUID().slice(0, 8)}`,
                  files,
                });
                yield* ok(deployed);
                const app = yield* body(App, deployed);
                path = `${prefix}/apps/${app.id}`;
                return app.id;
              }).pipe(Effect.orDie),
            redeploy: (files) =>
              api
                .request(owner, "POST", `${path}/deploy`, { files })
                .pipe(Effect.flatMap(ok), Effect.asVoid, Effect.orDie),
            connect: (scope, requirement, token) =>
              Effect.gen(function* () {
                const started = yield* api.request(
                  owner,
                  "POST",
                  connectionsPath(path, scope, requirement),
                  { destination: { kind: "personal" } },
                );
                yield* ok(started);
                const submitted = yield* api.request(
                  owner,
                  "POST",
                  `${prefix}/connections/${(yield* body(Resource, started)).id}/submit`,
                  { method: "key", label: token, fields: { token } },
                );
                yield* ok(submitted);
                const account = (yield* body(Resource, submitted)).id;
                saved.push(account);
                return account;
              }).pipe(Effect.orDie),
            call: (tool, kind) =>
              api
                .request(owner, "POST", `${path}/tools/call`, { tool, kind, input: {} })
                .pipe(Effect.flatMap(ok), Effect.orDie),
            links: (scope) =>
              Effect.suspend(() => accountLinks(owner, path, scope)).pipe(Effect.orDie),
            schedules: Effect.suspend(() => api.request(owner, "GET", `${path}/schedules`)).pipe(
              Effect.tap(ok),
              Effect.flatMap((response) => body(Schema.Array(Settings), response)),
              Effect.orDie,
            ),
            enableSchedule: Effect.suspend(() =>
              api.request(owner, "PATCH", `${path}/schedules/tick`, { enabled: true }),
            ).pipe(Effect.flatMap(ok), Effect.asVoid, Effect.orDie),
            start: (key) =>
              api
                .request(owner, "POST", `${path}/workflow-runs`, {
                  workflow: "capture",
                  input: {},
                  key,
                })
                .pipe(
                  Effect.tap(ok),
                  Effect.flatMap((response) => body(Resource, response)),
                  Effect.map((run) => run.id),
                  Effect.orDie,
                ),
            run: (id) =>
              api.request(owner, "GET", `${path}/workflow-runs/${id}`).pipe(
                Effect.tap(ok),
                Effect.flatMap((response) => body(Run, response)),
                Effect.orDie,
              ),
          },
          legacyStorage,
        );
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("App accounts storage upgrade on local", (it) => {
  it.effect(scenarios.localAppAccountsStorageUpgrade.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent } = yield* localAgent;
        let app = "";
        const saved: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (app !== "") yield* api.request(agent, "DELETE", `/v1/apps/${app}`);
            for (const id of saved) yield* api.request(agent, "DELETE", `/v1/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        const ok = (response: { status: number; body: unknown }) =>
          Effect.sync(() => {
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return response.body;
          });
        const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
        yield* upgradeFlow(
          {
            journal: "private_local",
            linkTable: "local_app_account_links",
            actor: "local",
            deploy: (files) =>
              api
                .request(agent, "POST", "/v1/apps/deploy", {
                  owner: "local",
                  name: `Upgrade accounts ${randomUUID().slice(0, 8)}`,
                  files,
                })
                .pipe(
                  Effect.tap(ok),
                  Effect.flatMap((response) => body(Deployed, response)),
                  Effect.map((deployed) => (app = deployed.app.id)),
                  Effect.orDie,
                ),
            redeploy: (files) =>
              Effect.suspend(() =>
                api.request(agent, "POST", "/v1/apps/deploy", { owner: "local", app, files }),
              ).pipe(Effect.flatMap(ok), Effect.asVoid, Effect.orDie),
            // A local connection request names only the requirement; its scope is the app's.
            connect: (_scope, requirement, token) =>
              Effect.suspend(() =>
                connectLocalAccount(agent, {
                  app,
                  requirement,
                  method: "key",
                  label: token,
                  fields: { token },
                }),
              ).pipe(
                Effect.map((account) => {
                  saved.push(account.id);
                  return account.id;
                }),
                Effect.orDie,
              ),
            call: (tool, kind) =>
              Effect.suspend(() =>
                api.request(agent, "POST", "/v1/tools/call", { app, tool, kind, input: {} }),
              ).pipe(
                Effect.tap(ok),
                Effect.flatMap((response) => body(Completed, response)),
                Effect.map((completed) => completed.value),
                Effect.orDie,
              ),
            links: (scope) =>
              Effect.suspend(() => localAccountLinks(agent, app, scope)).pipe(Effect.orDie),
            schedules: Effect.suspend(() =>
              api.request(agent, "GET", `/v1/apps/${app}/schedules`),
            ).pipe(
              Effect.tap(ok),
              Effect.flatMap((response) => body(Schema.Array(Settings), response)),
              Effect.orDie,
            ),
            enableSchedule: Effect.suspend(() =>
              api.request(agent, "PATCH", `/v1/apps/${app}/schedules/tick`, {
                actor: "local",
                enabled: true,
              }),
            ).pipe(Effect.flatMap(ok), Effect.asVoid, Effect.orDie),
            start: (key) =>
              Effect.suspend(() =>
                api.request(agent, "POST", `/v1/apps/${app}/workflow-runs`, {
                  workflow: "capture",
                  input: {},
                  key,
                }),
              ).pipe(
                Effect.tap(ok),
                Effect.flatMap((response) => body(Resource, response)),
                Effect.map((run) => run.id),
                Effect.orDie,
              ),
            run: (id) =>
              Effect.suspend(() =>
                api.request(agent, "GET", `/v1/apps/${app}/workflow-runs/${id}`),
              ).pipe(
                Effect.tap(ok),
                Effect.flatMap((response) => body(Run, response)),
                Effect.orDie,
              ),
          },
          legacyStorage,
        );
      }),
    ),
  );
});
