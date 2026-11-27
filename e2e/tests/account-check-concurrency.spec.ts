import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { body } from "../support/api.ts";
import { appLinksFixture } from "../support/app-links.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = defineProvider({
  name: "Concurrent check fixture",
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
  async health({ account }) {
    return { accountInfo: { externalId: account.fields.token, displayName: "synthetic" } };
  },
});
export default defineApp({ app: { accounts: { service } } }, async () => ({ tools: router({}) }));`;

const Holder = Schema.Tuple([Schema.Struct({ pid: Schema.Number })]);
const Backends = Schema.Array(Schema.Struct({ pid: Schema.Number }));
const ActiveVersion = Schema.Struct({ activeVersion: Schema.String });
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      check: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
});

layer(HostedLive, { excludeTestServices: true })("Account check concurrency", (it) => {
  it.effect(scenarios.accountFirstChecksTogether.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, app, path, connect } = yield* appLinksFixture([
          { path: "index.ts", content: source },
        ]);
        const account = yield* connect(actors.owner, "app", "service", "synthetic-concurrent-key");
        const { activeVersion } = yield* body(
          ActiveVersion,
          yield* api.request(actors.owner, "GET", path),
        );

        const locks = yield* cloudLocks;
        yield* Effect.addFinalizer(() => Effect.ignore(locks.release));
        const [holder] = yield* locks
          .hold({ sql: "select pg_backend_pid() as pid" })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.orDie);
        yield* locks.hold({
          sql: `insert into executor_account_checks
              (id, account, app, deployment, credential_generation, status, checked_at)
            values ($1, $2, $3, $4, 0, 'unknown', now() - interval '1 day')`,
          params: [`${account}:${app.id}`, account, app.id, activeVersion],
        });

        const check = api.request(actors.owner, "POST", `${prefix}/accounts/${account}/health`);
        const first = yield* Effect.forkChild(check);
        const second = yield* Effect.forkChild(check);
        yield* locks
          .run({
            sql: `select pid from pg_stat_activity
              where $1 = any(pg_blocking_pids(pid)) and query ilike '%executor_account_checks%'`,
            params: [holder!.pid],
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Backends)),
            Effect.filterOrFail(
              (rows) => rows.length === 2,
              () => new Error("The two checks did not both wait on the account's check row"),
            ),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
            Effect.orDie,
          );
        yield* locks.release;

        for (const fiber of [first, second]) {
          const response = yield* Fiber.join(fiber);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const health = yield* body(Health, response);
          expect(health.apps.find((entry) => entry.app === app.id)?.check?.status).toBe("healthy");
        }
      }),
    ),
  );
});
