/** Departure cleanup commits independently and uses the existing webhook-source removal path. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { ok } from "../support/app-links.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { contributedApp } from "../support/contributed-app.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Contributed departures", (it) => {
  it.effect(scenarios.contributedAppDepartures.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* contributedApp;
        const { api, actors, prefix } = f;
        const personal = yield* f.connect(
          actors.admin,
          "app",
          "shared",
          "Departing personal account",
        );
        const shared = yield* f.connect(actors.admin, "app", "shared", "Departing shared account", {
          kind: "shared",
          audience: { kind: "everyone" },
        });
        const ordinary = yield* f.connect(
          actors.admin,
          "app",
          "ordinary",
          "Ordinary personal account",
        );
        const admin = yield* body(
          Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }),
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        yield* ok(
          yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: admin.user.email,
          }),
        );
        yield* f.waitForLinks([shared, ordinary]);
        // Removal unlinks the departed member's personal contribution, not saved credentials or shared accounts.
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${personal}`)).status,
        ).not.toBe(404);
        const own = yield* f.connect(actors.member, "app", "shared", "Leaving member's account");
        yield* ok(
          yield* api.request(actors.member, "POST", "/api/auth/organization/leave", {
            organizationId: actors.organization.id,
          }),
        );
        const remaining = yield* f.waitForLinks([shared, ordinary]);
        expect(remaining.map((link) => link.account.id)).not.toContain(own);
        const response = yield* f.call(actors.owner, "accounts");
        expect(response.body).toMatchObject({ shared: [shared] });
      }),
    ),
  );

  it.effect(scenarios.contributedAppDepartureRecovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* contributedApp;
        const { api, actors, prefix, ids } = f;
        yield* Effect.addFinalizer(() => serverControl("start").pipe(Effect.orDie));
        const removed = yield* f.connect(actors.member, "app", "shared", "Old server contribution");
        const retained = yield* f.connect(
          actors.member,
          "app",
          "shared",
          "Rejoined member's new link",
        );
        const ordinary = yield* f.connect(actors.owner, "app", "ordinary", "Ordinary account");
        // A running old server sees an ordinary member job. It can acknowledge it, leaving the durable
        // snapshots for the replacement server. The stopped fixture writes that older-server outcome.
        const [departures] = yield* legacyStorage([
          {
            sql: 'DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2',
            params: [actors.organization.id, ids.member],
          },
          {
            sql: "UPDATE hosted_provisioning SET status = 'succeeded' WHERE id LIKE 'contributed-departure-%' RETURNING id, kind",
          },
          // This contribution has since been replaced with a new link. A stale snapshot must not remove it.
          {
            sql: "UPDATE hosted_contributed_departures SET linked_at = linked_at - interval '1 second' WHERE account = $1",
            params: [retained],
          },
        ]).pipe(Effect.map((results) => [results[1]]));
        expect(departures).toHaveLength(1);
        expect(departures?.[0]).toMatchObject({ kind: "member" });
        const original = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
          departures?.[0],
        );
        yield* serverControl("start");
        yield* f.waitForLinks([retained, ordinary]);
        // Another restart does not replay completed cleanup or remove the preserved link.
        yield* serverControl("restart");
        yield* f.waitForLinks([retained, ordinary]);
        const [snapshots, oldJob, replacements, credentials] = yield* legacyStorage([
          { sql: "SELECT account FROM hosted_contributed_departures" },
          { sql: "SELECT status FROM hosted_provisioning WHERE id = $1", params: [original.id] },
          {
            sql: "SELECT id, status FROM hosted_provisioning WHERE id LIKE 'contributed-departure-%' AND id <> $1",
            params: [original.id],
          },
          { sql: "SELECT id FROM executor_accounts WHERE id = $1", params: [removed] },
        ]);
        expect(snapshots).toEqual([]);
        expect(oldJob).toEqual([{ status: "succeeded" }]);
        expect(replacements).toEqual([expect.objectContaining({ status: "succeeded" })]);
        expect(credentials).toEqual([{ id: removed }]);
        yield* serverControl("start");
        expect((yield* api.request(actors.owner, "GET", `${prefix}/apps/${f.app.id}`)).status).toBe(
          200,
        );
      }),
    ),
  );
});
