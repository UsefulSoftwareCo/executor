/**
 * Linking an account for everyone needs edit access to the app. The link's transaction
 * share-locks the admin's membership row before it writes, so a role change waits for the link
 * and the link waits for a role change already in progress. A demotion that is uncommitted when the
 * link reaches the lock commits while the link waits; the link must then use the committed role,
 * not one it read before the lock, and is refused. Only Cloud's Postgres runs the demotion beside
 * the waiting link: the scenario holds it in its own transaction and commits it once the link's
 * statement waits on the row.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { appLinksFixture, keyProvider, refused } from "../support/app-links.ts";
import { scenarios } from "../test-plan.ts";

/** An app with one plain app requirement. */
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
        const first = yield* fixture.connect(actors.owner, "app", "service", "synthetic-role-one", {
          kind: "shared",
          audience: { kind: "everyone" },
        });
        const second = yield* fixture.connect(
          actors.owner,
          "app",
          "service",
          "synthetic-role-two",
          { kind: "shared", audience: { kind: "everyone" } },
        );
        // Connecting the second account replaced the first's link.
        expect(yield* linked()).toEqual([["service", second]]);

        const locks = yield* cloudLocks;
        // Commit first, so a failed scenario does not leave the membership locked.
        yield* Effect.addFinalizer(() => Effect.ignore(locks.release));
        const [holder] = yield* locks
          .hold({ sql: "select pg_backend_pid() as pid" })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.orDie);
        // The admin's demotion, uncommitted: its row lock is held until release.
        yield* locks.hold({
          sql: `update member set role = 'member'
            where "organizationId" = $1 and "userId" = $2`,
          params: [actors.organization.id, ids.admin],
        });

        // The admin links the first account; its checks before the lock still read `admin`.
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
        // The demotion commits while the link waits on the membership row.
        yield* locks.release;

        // The link reads the committed role with its lock: refused, and nothing is linked.
        yield* refused(yield* Fiber.join(request), 403, "OrganizationForbidden");
        expect(yield* linked()).toEqual([["service", second]]);
      }),
    ),
  );
});
