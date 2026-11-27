import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { accountLinks, connectionsPath } from "../support/app-accounts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Evidence } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import {
  beforeAppAccounts,
  beforeProfileRemoval,
  profileAppCopiesPending,
} from "../support/profile-removal-rollback.ts";
import { serverControl } from "../support/server-control.ts";

const sourceOf = (
  secondary: boolean,
  tock: boolean,
) => `import { defineApp, defineProvider, secrets, query, mutation, userInterval, object, string, router,
  type QueryContext, type MutationContext } from "apps";
const service = defineProvider({ name: "Profile schedule service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
const requirements = { user: { accounts: { primary: service, ${secondary ? "secondary: service, " : ""}extras: service.many() } } };
const tick = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements>) => {
  const ran = ctx.user.accounts.primary.id + "|" + ${secondary ? 'ctx.user.accounts.secondary.id + "|" + ' : ""}ctx.user.accounts.extras.map((account) => account.id).join(",");
  ctx.sql.exec("INSERT INTO ticks (ran) VALUES (?)", ran);
  return ran;
});
const ticks = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec<{ ran: string }>("SELECT ran FROM ticks ORDER BY seq").toArray().map((row) => row.ran));
export default defineApp(requirements, async () => ({
  tools: router({ tick, ticks }),
  schedules: { tick: userInterval({ minutes: 1 }, tick, {})${tock ? ", tock: userInterval({ minutes: 60 }, tick, {})" : ""} },
}));`;
const migration = {
  path: "migrations/0001_ticks.sql",
  content: "CREATE TABLE ticks (seq INTEGER PRIMARY KEY AUTOINCREMENT, ran TEXT NOT NULL);\n",
};

const Copy = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  name: Schema.String,
  actor: Schema.String,
  enabled: Schema.Boolean,
  nextAt: Schema.NullOr(Schema.String),
  accountRequired: Schema.optional(Schema.String),
});
const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, scheduleId: Schema.String, status: Schema.String }),
);
const Ticks = Schema.Array(Schema.String);
const Viewer = Schema.Struct({ userId: Schema.String });
const ListedApp = Schema.Struct({ ...App.fields, owner: Schema.String });
const Definitions = Schema.Array(Schema.Struct({ name: Schema.String, tool: Schema.String }));
const Failure = Schema.Struct({ _tag: Schema.String });

const profile = (row: {
  readonly id: string;
  readonly app: string;
  readonly owner: string;
  readonly subject: string;
  readonly name?: string;
  readonly accounts: Readonly<Record<string, string | readonly string[]>>;
  readonly enabled: boolean;
  readonly createdAt: string;
}) => ({
  sql: `INSERT INTO executor_installations (id, app, owner, subject, name, idempotency_key,
      accounts, webhook_config, revision, enabled, status, failure, reconciled_deployment,
      reconciled_revision, request, lease, lease_until, created_at)
    VALUES ($1, $2, $3, $4, $5, $1, $6, '{}', 1, $7, $8, NULL, NULL, NULL, $9, NULL,
      '1970-01-01 00:00:00', $10)`,
  params: [
    row.id,
    row.app,
    row.owner,
    row.subject,
    row.name ?? null,
    JSON.stringify(row.accounts),
    row.enabled,
    row.enabled ? "ready" : "disabled",
    JSON.stringify({ accounts: row.accounts, webhookConfig: {} }),
    row.createdAt,
  ],
});
const schedule = (row: {
  readonly id: string;
  readonly app: string;
  readonly profile: string;
  readonly owner: string;
  readonly actor: string;
  readonly enabled: boolean;
  readonly name?: string;
}) => ({
  sql: `INSERT INTO executor_schedules (id, app, installation, owner, name, actor, timing, enabled,
      approval_mode, next_at, active_run, revision)
    VALUES ($1, $2, $3, $4, $7, $5, '{"kind":"interval","milliseconds":60000}', $6,
      'automatic', CASE WHEN $6 THEN TIMESTAMP '2099-01-01' ELSE NULL END, NULL, 'legacy')`,
  params: [row.id, row.app, row.profile, row.owner, row.actor, row.enabled, row.name ?? "tick"],
});
const run = (row: {
  readonly id: string;
  readonly schedule: string;
  readonly app: string;
  readonly profile: string;
  readonly owner: string;
}) => ({
  sql: `INSERT INTO executor_scheduled_runs (id, schedule_id, app, installation, owner,
      name, status, scheduled_at, started_at, finished_at, request_id, expires_at,
      failure, runner, revision, answer)
    VALUES ($1, $2, $3, $4, $5, 'tick', 'succeeded', TIMESTAMP '2026-01-02',
      TIMESTAMP '2026-01-02', TIMESTAMP '2026-01-02', NULL, NULL, NULL, 'legacy',
      'legacy', NULL)`,
  params: [row.id, row.schedule, row.app, row.profile, row.owner],
});

type Role = "owner" | "admin" | "member";
interface ProfileSpec {
  readonly id: string;
  readonly subject: string;
  readonly name?: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly extras: ReadonlyArray<string>;
  readonly enabled?: boolean;
}
interface ScheduleSpec {
  readonly id: string;
  readonly name?: string;
  readonly profile: string;
  readonly actor: string;
  readonly enabled: boolean;
}

const upgradeFixture = (
  accounts: ReadonlyArray<readonly [Role, string]>,
  options: { readonly secondary?: boolean; readonly tock?: boolean } = {},
) =>
  Effect.gen(function* () {
    const secondary = options.secondary === true;
    const tock = options.tock === true;
    const actors = yield* Actors,
      api = yield* Api,
      evidence = yield* Evidence;
    const prefix = `/api/organizations/${actors.organization.id}`,
      owner = `organization:${actors.organization.id}`,
      suffix = randomUUID().slice(0, 8);
    const created = { apps: [] as string[], accounts: [] as { actor: Session; id: string }[] };
    yield* Effect.addFinalizer(() =>
      serverControl("start").pipe(
        Effect.andThen(
          Effect.forEach(
            [
              ...created.apps.map((app) => ({
                actor: actors.owner,
                path: `${prefix}/apps/${app}`,
              })),
              ...created.accounts.map((item) => ({
                actor: item.actor,
                path: `${prefix}/accounts/${item.id}`,
              })),
            ],
            (item) => api.request(item.actor, "DELETE", item.path),
            { discard: true },
          ),
        ),
        Effect.orDie,
      ),
    );
    const userId = (actor: Session) =>
      api
        .request(actor, "GET", "/api/viewer")
        .pipe(Effect.flatMap((response) => body(Viewer, response)))
        .pipe(Effect.map((viewer) => viewer.userId));
    const call = (actor: Session, app: string, tool: "tick" | "ticks") =>
      api.request(actor, "POST", `${prefix}/apps/${app}/tools/call`, {
        tool,
        kind: tool === "tick" ? "mutation" : "query",
        input: {},
      });
    const ticks = (actor: Session, app: string) =>
      call(actor, app, "ticks").pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
        ),
        Effect.flatMap((response) => body(Ticks, response)),
      );
    const fixture = yield* evidence.step(
      "Create the app, its data, accounts and members through the product",
      Effect.gen(function* () {
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Profile schedules ${suffix}`,
          files: [
            { path: "index.ts", content: sourceOf(secondary, tock) },
            migration,
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        created.apps.push(app.id);
        const appPath = `${prefix}/apps/${app.id}`;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${appPath}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${appPath}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const connect = ([role, label]: readonly [Role, string]) =>
          Effect.gen(function* () {
            const actor = actors[role];
            const connection = yield* api.request(
              actor,
              "POST",
              connectionsPath(appPath, "user", "primary"),
              {},
            );
            expect(connection.status, JSON.stringify(connection.body)).toBe(200);
            const saved = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
              { method: "key", label: `${label} ${suffix}`, fields: { token: label } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            created.accounts.push({ actor, id: account });
            return [label, account] as const;
          });
        const ids = Object.fromEntries(
          yield* Effect.forEach(accounts, connect, { concurrency: 4 }),
        ) as Record<string, string>;
        const [alice, bob, ownerUser] = yield* Effect.all(
          [userId(actors.member), userId(actors.admin), userId(actors.owner)],
          { concurrency: 3 },
        );
        return { app: app.id, appName: app.name, accounts: ids, alice, bob, ownerUser };
      }),
    );
    yield* evidence.json("fixture.json", fixture);
    const id = (name: string) => `${name}_${suffix}`;
    const deleteAccount = (role: Role, label: string) =>
      Effect.gen(function* () {
        const account = fixture.accounts[label]!;
        expect(
          (yield* api.request(actors[role], "DELETE", `${prefix}/accounts/${account}`)).status,
        ).toBe(200);
        created.accounts = created.accounts.filter((item) => item.id !== account);
      });
    const writeTick = (actor: Session) =>
      Effect.gen(function* () {
        const wrote = yield* call(actor, fixture.app, "tick");
        expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
        return yield* ticks(actor, fixture.app);
      });
    const upgradeStatements = (input: {
      readonly profiles: ReadonlyArray<ProfileSpec>;
      readonly schedules: ReadonlyArray<ScheduleSpec>;
      readonly runs?: ReadonlyArray<readonly [string, string]>;
    }) => {
      const profileOf = new Map(input.schedules.map((row) => [row.id, row.profile]));
      return [
        { sql: "SELECT migration_id, name FROM private_hosted_migrations ORDER BY migration_id" },
        { sql: "SELECT value FROM private_executor_settings WHERE key = 'version'" },
        ...beforeAppAccounts(),
        { sql: "DELETE FROM private_hosted_migrations WHERE migration_id >= 9" },
        { sql: "DROP TABLE hosted_app_account_links" },
        ...beforeProfileRemoval(),
        ...profileAppCopiesPending("private_hosted"),
        { sql: `UPDATE private_executor_settings SET value = '4.0.12' WHERE key = 'version'` },
        ...input.profiles.map((row, index) =>
          profile({
            id: id(row.id),
            app: fixture.app,
            owner,
            subject: row.subject,
            ...(row.name === undefined ? {} : { name: row.name }),
            accounts: secondary
              ? {
                  primary: row.primary,
                  secondary: row.secondary ?? row.primary,
                  extras: row.extras,
                }
              : { primary: row.primary, extras: row.extras },
            enabled: row.enabled ?? true,
            createdAt: `2026-01-${String(index + 1).padStart(2, "0")} 00:00:00`,
          }),
        ),
        ...input.schedules.map((row) =>
          schedule({ ...row, id: id(row.id), profile: id(row.profile), app: fixture.app, owner }),
        ),
        ...(input.runs ?? []).map(([runId, scheduleId]) =>
          run({
            id: id(runId),
            schedule: id(scheduleId),
            profile: id(profileOf.get(scheduleId)!),
            app: fixture.app,
            owner,
          }),
        ),
      ] as const;
    };
    const appPath = `${prefix}/apps/${fixture.app}`;
    const listed = api.request(actors.owner, "GET", `${prefix}/apps`).pipe(
      Effect.tap((response) =>
        Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
      ),
      Effect.flatMap((response) => body(Schema.Array(ListedApp), response)),
    );
    const copiesOf = (labels: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const apps = yield* listed;
        yield* evidence.json("apps.json", apps);
        const original = apps.find((item) => item.id === fixture.app);
        const copies = apps.filter((item) => item.name.startsWith(`${fixture.appName} (`));
        created.apps.unshift(...copies.map((item) => item.id));
        expect(
          copies.map((item) => item.name).toSorted(),
          "one copy per other account set",
        ).toEqual(labels.map((label) => `${fixture.appName} (${label})`).toSorted());
        expect(copies.every((item) => item.owner === original?.owner)).toBe(true);
        return Object.fromEntries(
          labels.map((label) => [
            label,
            copies.find((item) => item.name === `${fixture.appName} (${label})`)!.id,
          ]),
        );
      });
    const schedulesOf = (target: string) =>
      api.request(actors.owner, "GET", `${prefix}/apps/${target}/schedules`).pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
        ),
        Effect.flatMap((response) => body(Schema.Array(Copy), response)),
        Effect.map((rows) =>
          rows
            .map((row) => ({
              id: row.id,
              actor: row.actor,
              enabled: row.enabled,
              nextAt: row.nextAt,
            }))
            .toSorted((left, right) => left.id.localeCompare(right.id)),
        ),
      );
    const runs = api
      .request(actors.owner, "GET", `${prefix}/scheduled-runs`)
      .pipe(Effect.flatMap((response) => body(Runs, response)));
    const runAndWait = (actor: Session, target: string, copy: string, count: number) =>
      Effect.gen(function* () {
        const response = yield* api.request(
          actor,
          "POST",
          `${prefix}/apps/${target}/schedules/tick/copies/${copy}/run`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* ticks(actor, target).pipe(
          Effect.flatMap((rows) =>
            rows.length >= count
              ? Effect.succeed(rows)
              : Effect.fail(new Error(`${rows.length} of ${count} runs`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
        );
      });
    const resume = (actor: Session, target: string, copy: string) =>
      api.request(actor, "PATCH", `${prefix}/apps/${target}/schedules/tick/copies/${copy}`, {
        enabled: true,
      });
    return {
      actors,
      api,
      evidence,
      prefix,
      appPath,
      fixture,
      id,
      deleteAccount,
      writeTick,
      upgradeStatements,
      listed,
      copiesOf,
      schedulesOf,
      runs,
      ticks,
      runAndWait,
      resume,
    };
  });
const expectSchedules = (
  rows: ReadonlyArray<{ id: string; actor: string; enabled: boolean; nextAt: string | null }>,
  expected: ReadonlyArray<{ id: string; actor: string; enabled: boolean }>,
) => {
  expect(rows.map(({ id, actor, enabled }) => ({ id, actor, enabled }))).toEqual(
    expected.toSorted((left, right) => left.id.localeCompare(right.id)),
  );
  expect(rows.every((row) => (row.nextAt !== null) === row.enabled)).toBe(true);
};

layer(HostedLive, { excludeTestServices: true })("Legacy profile schedules", (it) => {
  it.effect(scenarios.legacyProfileSchedules.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const setup = yield* upgradeFixture([
          ["member", "alice-one"],
          ["member", "alice-two"],
          ["admin", "bob-one"],
          ["admin", "bob-two"],
        ]);
        const { actors, api, evidence, prefix, appPath, fixture, id } = setup;
        const { alice, bob, app } = fixture;
        const {
          "alice-one": aliceOne,
          "alice-two": aliceTwo,
          "bob-one": bobOne,
          "bob-two": bobTwo,
        } = fixture.accounts as Record<string, string>;
        const before = yield* setup.writeTick(actors.member);
        expect(before).toHaveLength(1);
        const [recorded, current] = yield* legacyStorage(
          setup.upgradeStatements({
            profiles: [
              { id: "ins_alice_main", subject: alice!, primary: aliceOne!, extras: [aliceOne!] },
              {
                id: "ins_alice_work",
                subject: alice!,
                name: "Work",
                primary: aliceTwo!,
                extras: [aliceTwo!],
              },
              {
                id: "ins_bob_old",
                subject: bob!,
                primary: bobTwo!,
                extras: [bobTwo!],
                enabled: false,
              },
              { id: "ins_bob_main", subject: bob!, primary: bobOne!, extras: [bobOne!] },
            ],
            schedules: [
              { id: "sch_alice_main", profile: "ins_alice_main", actor: alice!, enabled: false },
              { id: "sch_alice_work", profile: "ins_alice_work", actor: alice!, enabled: true },
              { id: "sch_bob_old", profile: "ins_bob_old", actor: bob!, enabled: true },
              { id: "sch_bob_main", profile: "ins_bob_main", actor: bob!, enabled: true },
            ],
          }),
        );
        expect(
          recorded?.map((row) => row.name),
          "step 9 is the latest hosted step",
        ).toContain("app_account_links");
        yield* serverControl("start");

        const copies = yield* evidence.step(
          "Each other account set became a copy of the app, shared as the app is",
          Effect.gen(function* () {
            const found = yield* setup.copiesOf(["Work", "Default"]);
            const work = found.Work!;
            const definitions = yield* api.request(
              actors.member,
              "GET",
              `${prefix}/apps/${work}/schedules/definitions`,
            );
            expect(definitions.status, JSON.stringify(definitions.body)).toBe(200);
            expect(
              (yield* body(Definitions, definitions)).map((row) => [row.name, row.tool]),
            ).toEqual([["tick", "tick"]]);
            for (const actor of [actors.member, actors.admin, actors.owner])
              expect((yield* api.request(actor, "GET", `${prefix}/apps/${work}`)).status).toBe(200);
            return { work, bobOld: found.Default! };
          }),
        );

        yield* evidence.step(
          "Each set's enabled profiles link their accounts for their member only",
          Effect.gen(function* () {
            const work = `${prefix}/apps/${copies.work}`;
            expect(
              yield* accountLinks(actors.member, appPath),
              "the app keeps Alice's oldest enabled profile's account, for both requirements",
            ).toEqual([
              ["extras", aliceOne],
              ["primary", aliceOne],
            ]);
            expect(yield* accountLinks(actors.member, work), "the copy links Work's").toEqual([
              ["extras", aliceTwo],
              ["primary", aliceTwo],
            ]);
            expect(yield* accountLinks(actors.admin, work), "Bob links nothing there").toEqual([]);
            expect(yield* accountLinks(actors.owner, work)).toEqual([]);
            expect(yield* accountLinks(actors.admin, appPath)).toEqual([
              ["extras", bobOne],
              ["primary", bobOne],
            ]);
            expect(
              yield* accountLinks(actors.admin, `${prefix}/apps/${copies.bobOld}`),
              "a disabled profile links no account",
            ).toEqual([]);
          }),
        );

        yield* evidence.step(
          "Each profile's schedule moved to its account set's app with its enabled state",
          Effect.gen(function* () {
            expectSchedules(yield* setup.schedulesOf(app), [
              { id: id("sch_alice_main"), actor: alice!, enabled: false },
              { id: id("sch_bob_main"), actor: bob!, enabled: true },
            ]);
            expectSchedules(yield* setup.schedulesOf(copies.work), [
              { id: id("sch_alice_work"), actor: alice!, enabled: true },
            ]);
            expectSchedules(yield* setup.schedulesOf(copies.bobOld), [
              { id: id("sch_bob_old"), actor: bob!, enabled: false },
            ]);
          }),
        );

        yield* evidence.step(
          "App data stays with the app; the copy's database starts empty",
          Effect.gen(function* () {
            expect(yield* setup.ticks(actors.member, app)).toEqual(before);
            expect(yield* setup.ticks(actors.member, copies.work)).toEqual([]);
          }),
        );

        yield* evidence.step(
          "Each schedule runs as its member with the account linked to its app",
          Effect.gen(function* () {
            const resumed = yield* setup.resume(actors.member, app, id("sch_alice_main"));
            expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
            yield* setup.runAndWait(actors.member, app, id("sch_alice_main"), 2);
            expect(yield* setup.runAndWait(actors.admin, app, id("sch_bob_main"), 3)).toEqual([
              ...before,
              `${aliceOne}|${aliceOne}`,
              `${bobOne}|${bobOne}`,
            ]);
            expect(
              yield* setup.runAndWait(actors.member, copies.work, id("sch_alice_work"), 1),
            ).toEqual([`${aliceTwo}|${aliceTwo}`]);
            expect(yield* setup.ticks(actors.member, app)).toHaveLength(3);
            const configured = yield* api.request(
              actors.member,
              "PATCH",
              `${prefix}/apps/${copies.work}/schedules/tick`,
              { enabled: true },
            );
            expect(configured.status, JSON.stringify(configured.body)).toBe(200);
            expect((yield* body(Copy, configured)).id).toBe(id("sch_alice_work"));
          }),
        );

        yield* serverControl("restart");
        const [ledger, version, plans] = yield* legacyStorage([
          {
            sql: "SELECT name FROM private_hosted_migrations WHERE name = 'app_account_links'",
          },
          { sql: "SELECT value FROM private_executor_settings WHERE key = 'version'" },
          { sql: "SELECT id, status FROM executor_profile_app_copies ORDER BY id" },
        ]);
        expect(ledger).toEqual([{ name: "app_account_links" }]);
        expect(version, "every step from 4.0.12 ran to the current version").toEqual(current);
        expect(plans).toEqual(
          [copies.work, copies.bobOld].toSorted().map((copy) => ({ id: copy, status: "copied" })),
        );
      }),
    ),
  );

  it.effect(scenarios.legacyProfileScheduleMerge.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const setup = yield* upgradeFixture(
          [
            ["member", "alice-gone"],
            ["member", "alice-a"],
            ["member", "alice-b"],
            ["admin", "bob-one"],
            ["admin", "bob-two"],
            ["owner", "owner-one"],
            ["owner", "owner-two"],
          ],
          { secondary: true },
        );
        const { actors, evidence, prefix, appPath, fixture, id } = setup;
        const { alice, bob, ownerUser, app } = fixture;
        const {
          "alice-gone": gone,
          "alice-a": aliceA,
          "alice-b": aliceB,
          "bob-one": bobOne,
          "bob-two": bobTwo,
          "owner-one": ownerOne,
          "owner-two": ownerTwo,
        } = fixture.accounts as Record<string, string>;
        yield* setup.deleteAccount("member", "alice-gone");
        const departed = `departed-${randomUUID().slice(0, 8)}`;
        const [recorded] = yield* legacyStorage(
          setup.upgradeStatements({
            profiles: [
              {
                id: "ins_bob_one",
                subject: bob!,
                primary: bobOne!,
                secondary: bobTwo!,
                extras: [bobOne!],
              },
              {
                id: "ins_bob_two",
                subject: bob!,
                primary: bobOne!,
                secondary: bobTwo!,
                extras: [bobOne!],
              },
              { id: "ins_owner_one", subject: ownerUser!, primary: ownerOne!, extras: [ownerTwo!] },
              { id: "ins_owner_two", subject: ownerUser!, primary: ownerOne!, extras: [ownerTwo!] },
              { id: "ins_alice_gone", subject: alice!, primary: gone!, extras: [] },
              {
                id: "ins_alice_one",
                subject: alice!,
                name: "Wide",
                primary: aliceA!,
                extras: [aliceB!],
              },
              { id: "ins_alice_two", subject: alice!, primary: aliceA!, extras: [aliceA!] },
              {
                id: "ins_alice_both",
                subject: alice!,
                primary: aliceA!,
                extras: [aliceA!, aliceB!],
                enabled: false,
              },
              { id: "ins_departed_one", subject: departed, primary: ownerOne!, extras: [] },
              { id: "ins_departed_two", subject: departed, primary: ownerTwo!, extras: [] },
            ],
            schedules: [
              { id: "sch_bob_one", profile: "ins_bob_one", actor: bob!, enabled: false },
              { id: "sch_bob_two", profile: "ins_bob_two", actor: bob!, enabled: true },
              { id: "sch_owner_one", profile: "ins_owner_one", actor: ownerUser!, enabled: true },
              { id: "sch_owner_two", profile: "ins_owner_two", actor: ownerUser!, enabled: false },
              { id: "sch_alice_gone", profile: "ins_alice_gone", actor: alice!, enabled: true },
              { id: "sch_alice_one", profile: "ins_alice_one", actor: alice!, enabled: true },
              { id: "sch_alice_two", profile: "ins_alice_two", actor: alice!, enabled: true },
              { id: "sch_alice_both", profile: "ins_alice_both", actor: alice!, enabled: false },
              {
                id: "sch_departed_one",
                profile: "ins_departed_one",
                actor: departed,
                enabled: true,
              },
              {
                id: "sch_departed_two",
                profile: "ins_departed_two",
                actor: departed,
                enabled: true,
              },
            ],
            runs: [
              ["run_bob_one_a", "sch_bob_one"],
              ["run_bob_one_b", "sch_bob_one"],
              ["run_bob_two", "sch_bob_two"],
            ],
          }),
        );
        expect(
          recorded?.map((row) => row.name),
          "step 9 is the latest hosted step",
        ).toContain("app_account_links");
        yield* serverControl("start");

        const copies = yield* setup.copiesOf(["Profile 2", "Wide"]);
        yield* evidence.step(
          "Schedules of one account set merge; ones that cannot run as they did are paused",
          Effect.gen(function* () {
            expectSchedules(yield* setup.schedulesOf(app), [
              { id: id("sch_bob_two"), actor: bob!, enabled: true },
              { id: id("sch_owner_one"), actor: ownerUser!, enabled: true },
              { id: id("sch_alice_gone"), actor: alice!, enabled: false },
              { id: id("sch_departed_one"), actor: departed, enabled: false },
            ]);
            expectSchedules(yield* setup.schedulesOf(copies["Profile 2"]!), [
              { id: id("sch_departed_two"), actor: departed, enabled: false },
            ]);
            expectSchedules(yield* setup.schedulesOf(copies.Wide!), [
              { id: id("sch_alice_one"), actor: alice!, enabled: false },
            ]);
            expect(yield* accountLinks(actors.member, `${prefix}/apps/${copies.Wide}`)).toEqual([
              ["extras", aliceB],
              ["extras", aliceA],
              ["primary", aliceA],
              ["secondary", aliceA],
            ]);
            const history = (yield* setup.runs).filter(
              (row) => row.scheduleId === id("sch_bob_two"),
            );
            expect(history.map((row) => row.id).toSorted()).toEqual(
              [id("run_bob_one_a"), id("run_bob_one_b"), id("run_bob_two")].toSorted(),
            );
            expect(yield* accountLinks(actors.owner, appPath)).toEqual([
              ["extras", ownerTwo],
              ["primary", ownerOne],
              ["secondary", ownerOne],
            ]);
            expect(yield* accountLinks(actors.admin, appPath)).toEqual([
              ["extras", bobOne],
              ["primary", bobOne],
              ["secondary", bobTwo],
            ]);
            expect(yield* accountLinks(actors.member, appPath), "a deleted account").toEqual([]);
          }),
        );

        yield* evidence.step(
          "A paused schedule never runs with an account its profile did not have",
          Effect.gen(function* () {
            const blocked = yield* setup.resume(actors.member, app, id("sch_alice_gone"));
            expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
            expect((yield* body(Failure, blocked))._tag).toBe("AccountRequired");
            const departedResume = yield* setup.resume(actors.owner, app, id("sch_departed_one"));
            expect(departedResume.status, JSON.stringify(departedResume.body)).toBe(403);
            expect(yield* setup.runAndWait(actors.admin, app, id("sch_bob_two"), 1)).toEqual([
              `${bobOne}|${bobTwo}|${bobOne}`,
            ]);
            expect(
              (yield* setup.runs).filter((row) => row.scheduleId === id("sch_bob_two")),
            ).toHaveLength(4);
            expect(yield* setup.runAndWait(actors.owner, app, id("sch_owner_one"), 2)).toEqual([
              `${bobOne}|${bobTwo}|${bobOne}`,
              `${ownerOne}|${ownerOne}|${ownerTwo}`,
            ]);
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.legacyProfileCopyResumeRetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const setup = yield* upgradeFixture(
          [
            ["member", "alice-one"],
            ["member", "alice-two"],
          ],
          { tock: true },
        );
        const { actors, api, evidence, prefix, fixture, id } = setup;
        const { alice } = fixture;
        const { "alice-one": aliceOne, "alice-two": aliceTwo } = fixture.accounts as Record<
          string,
          string
        >;
        const work = id("sch_alice_work");
        const early = id("sch_alice_early");
        const fault = [
          { sql: "CREATE SEQUENCE executor_test_resume_fault" },
          {
            sql: `CREATE FUNCTION executor_test_resume_fault() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN
                IF nextval('executor_test_resume_fault') = 1 THEN
                  RAISE EXCEPTION 'synthetic storage failure';
                END IF;
                RETURN NEW;
              END $$`,
          },
          {
            sql: `CREATE TRIGGER executor_test_resume_fault BEFORE UPDATE ON executor_schedules
              FOR EACH ROW WHEN (OLD.id = '${work}' AND NOT OLD.enabled AND NEW.enabled)
              EXECUTE FUNCTION executor_test_resume_fault()`,
          },
        ];
        yield* legacyStorage([
          ...setup.upgradeStatements({
            profiles: [
              { id: "ins_alice_main", subject: alice!, primary: aliceOne!, extras: [] },
              {
                id: "ins_alice_work",
                subject: alice!,
                name: "Work",
                primary: aliceTwo!,
                extras: [aliceTwo!],
              },
            ],
            schedules: [
              { id: "sch_alice_main", profile: "ins_alice_main", actor: alice!, enabled: true },
              { id: "sch_alice_work", profile: "ins_alice_work", actor: alice!, enabled: true },
              {
                id: "sch_alice_early",
                name: "tock",
                profile: "ins_alice_work",
                actor: alice!,
                enabled: true,
              },
            ],
          }),
          ...fault,
        ]);
        yield* serverControl("start");
        const copy = (yield* setup.copiesOf(["Work"])).Work!;
        const plan = (expected: string) =>
          Effect.gen(function* () {
            const [plans, attempts] = yield* legacyStorage([
              {
                sql: "SELECT status, enable FROM executor_profile_app_copies WHERE id = $1",
                params: [copy],
              },
              { sql: "SELECT last_value::int AS attempts FROM executor_test_resume_fault" },
            ]);
            expect(plans).toEqual([
              { status: expected, enable: expected === "pending" ? [work] : [] },
            ]);
            yield* serverControl("start");
            return attempts;
          });

        yield* evidence.step(
          "The failed resume leaves the copy made and linked, its schedule paused and its plan pending",
          Effect.gen(function* () {
            expect(yield* accountLinks(actors.member, `${prefix}/apps/${copy}`)).toEqual([
              ["extras", aliceTwo],
              ["primary", aliceTwo],
            ]);
            expectSchedules(yield* setup.schedulesOf(copy), [
              { id: early, actor: alice!, enabled: true },
              { id: work, actor: alice!, enabled: false },
            ]);
            const paused = yield* api.request(
              actors.member,
              "PATCH",
              `${prefix}/apps/${copy}/schedules/tock/copies/${early}`,
              { enabled: false },
            );
            expect(paused.status, JSON.stringify(paused.body)).toBe(200);
            expect(yield* plan("pending"), "one failed attempt").toEqual([{ attempts: 1 }]);
          }),
        );

        yield* evidence.step(
          "The next start resumes it, keeps the other paused, copies nothing again and completes the plan",
          Effect.gen(function* () {
            expect(yield* setup.copiesOf(["Work"])).toEqual({ Work: copy });
            expectSchedules(yield* setup.schedulesOf(copy), [
              { id: early, actor: alice!, enabled: false },
              { id: work, actor: alice!, enabled: true },
            ]);
            expect(yield* plan("copied"), "resumed on the second attempt").toEqual([
              { attempts: 2 },
            ]);
            expect(yield* setup.runAndWait(actors.member, copy, work, 1)).toEqual([
              `${aliceTwo}|${aliceTwo}`,
            ]);
          }),
        );
      }),
    ),
  );
});
