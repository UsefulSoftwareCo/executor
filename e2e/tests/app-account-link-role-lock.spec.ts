import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { appLinksFixture, keyProvider, refused } from "../support/app-links.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = ${keyProvider("Role lock fixture")};
export default defineApp({ app: { accounts: { service } } }, async () => ({ tools: router({}) }));`;

const Holder = Schema.Tuple([Schema.Struct({ pid: Schema.Number })]);
const Backends = Schema.Array(Schema.Struct({ pid: Schema.Number }));

layer(HostedLive, { excludeTestServices: true })("App account link role lock", (it) => {
  it.effect(scenarios.hostedAppLinkRoleLock.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { actors, ids } = fixture;
        const linked = (actor = actors.owner) =>
          fixture
            .links(actor)
            .pipe(Effect.map((links) => links.map((link) => [link.requirement, link.account.id])));
        const first = yield* fixture.connect(actors.admin, "app", "service", "synthetic-role-one");
        const second = yield* fixture.connect(actors.owner, "app", "service", "synthetic-role-two");
        expect(yield* linked()).toEqual([["service", second]]);

        const locks = yield* cloudLocks;
        yield* Effect.addFinalizer(() => Effect.ignore(locks.release));
        const [holder] = yield* locks
          .hold({ sql: "select pg_backend_pid() as pid" })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.orDie);
        yield* locks.hold({
          sql: `update member set role = 'member'
            where "organizationId" = $1 and "userId" = $2`,
          params: [actors.organization.id, ids.admin],
        });

        const request = yield* Effect.forkChild(fixture.link(actors.admin, "service", first));
        yield* locks
          .run({
            sql: `select pid from pg_stat_activity
              where $1 = any(pg_blocking_pids(pid)) and query ilike '%from member%for share%'`,
            params: [holder!.pid],
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Backends)),
            Effect.filterOrFail(
              (rows) => rows.length === 1,
              () => new Error("The link did not wait on the admin's membership"),
            ),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
            Effect.orDie,
          );
        yield* locks.release;

        yield* refused(yield* Fiber.join(request), 403, "OrganizationForbidden");
        expect(yield* linked()).toEqual([["service", second]]);
      }),
    ),
  );
});
