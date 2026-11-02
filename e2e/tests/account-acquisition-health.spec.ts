import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { acquisitionFixture } from "../support/account-acquisition-fixture.ts";
import { Resource } from "../support/contracts.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Health = Schema.Struct({
  driver: Schema.Struct({
    source: Schema.Struct({ kind: Schema.String, id: Schema.String, version: Schema.String }),
    checkable: Schema.Boolean,
    check: Schema.NullOr(
      Schema.Struct({ status: Schema.String, checkedAt: Schema.String, current: Schema.Boolean }),
    ),
  }),
});

layer(HostedLive, { excludeTestServices: true })("Driver account health", (it) => {
  it.effect(scenarios.accountAcquisitionHealth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* acquisitionFixture();
        const { account } = yield* f.create(f.actors.owner);
        const path = `${f.prefix}/accounts/${account}`;
        const check = () => f.api.request(f.actors.owner, "POST", `${path}/health`);
        const health = () =>
          f.api.request(f.actors.owner, "GET", path).pipe(
            Effect.flatMap((response) => body(Schema.Struct({ health: Health }), response)),
            Effect.map((detail) => detail.health.driver),
          );
        const healthy = (response: { status: number; body: unknown }) => {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toMatchObject({
            driver: {
              source: { kind: "driver", id: "synthetic-account-driver" },
              checkable: true,
              check: { status: "healthy", current: true },
            },
          });
        };
        yield* f.backend.driverHealth({ accountInfo: { displayName: "Checked identity" } });
        healthy(yield* check());
        const recorded = yield* health();
        expect(recorded.source.version).toBe("dpl_fixture_driver_revision");
        expect((yield* f.api.request(f.actors.member, "POST", `${path}/health`)).status).toBe(403);
        expect((yield* f.backend.calls).filter((call) => call.step === "check")).toHaveLength(1);
        expect((yield* f.api.request(f.actors.owner, "DELETE", f.manager.path)).status).toBe(200);
        expect(yield* f.backend.removeCalls).toEqual([]);
        yield* serverControl("restart");
        expect(yield* health()).toEqual(recorded);
        healthy(yield* check());

        for (const secret of ["opaque-1", Buffer.from("opaque-1").toString("base64")]) {
          yield* f.backend.driverHealth({ accountInfo: { displayName: secret } });
          const result = yield* check();
          expect(result.status).toBe(200);
          expect(result.body).toMatchObject({ driver: { check: { status: "check_failed" } } });
          expect(JSON.stringify(result.body)).not.toContain(secret);
          const retained = yield* f.api.request(f.actors.owner, "GET", path);
          expect(JSON.stringify(retained.body)).not.toContain(secret);
          expect(retained.body).toMatchObject({
            health: { info: { displayName: "Checked identity" } },
          });
        }
        yield* f.backend.driverHealth({});
        healthy(yield* check());
        const before = yield* health();
        const consumer = yield* f.deploy("Reconnect health consumer");
        const gate = yield* f.backend.holdCheck;
        const checking = yield* check().pipe(Effect.forkChild);
        yield* gate.started;
        const reconnect = yield* f.pending(f.actors.owner, consumer.app.id, account);
        expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(200);
        const connection = (yield* body(Resource, reconnect)).id;
        expect((yield* f.start(f.actors.owner, connection)).status).toBe(200);
        expect((yield* f.submit(f.actors.owner, connection)).body).toMatchObject({
          state: "connected",
          account: { id: account },
        });
        yield* gate.release;
        expect((yield* Fiber.join(checking)).status).toBe(200);
        expect((yield* health()).check).toMatchObject({
          checkedAt: before.check?.checkedAt,
          current: false,
        });
        healthy(yield* check());
        const pendingOld = yield* f.pending(f.actors.owner, consumer.app.id);
        expect(pendingOld.status).toBe(200);
        const oldAttempt = (yield* body(Resource, pendingOld)).id;
        expect((yield* f.start(f.actors.owner, oldAttempt)).status).toBe(200);
        yield* f.configure({
          revision: "replacement-revision",
          retained: ["dpl_fixture_driver_revision"],
        });
        healthy(yield* check());
        expect((yield* health()).source.version).toBe("dpl_fixture_driver_revision");
        const oldCompleted = yield* f.submit(f.actors.owner, oldAttempt);
        expect(oldCompleted.status, JSON.stringify(oldCompleted.body)).toBe(200);
        const oldAccount = (yield* body(Schema.Struct({ account: Resource }), oldCompleted)).account
          .id;
        f.trackAccount(f.actors.owner, oldAccount);
        const oldHealth = yield* f.api.request(
          f.actors.owner,
          "POST",
          `${f.prefix}/accounts/${oldAccount}/health`,
        );
        expect((yield* body(Health, oldHealth)).driver.source.version).toBe(
          "dpl_fixture_driver_revision",
        );
        const pendingNew = yield* f.pending(f.actors.owner, consumer.app.id);
        const newAttempt = (yield* body(Resource, pendingNew)).id;
        expect((yield* f.start(f.actors.owner, newAttempt)).status).toBe(200);
        const newCompleted = yield* f.submit(f.actors.owner, newAttempt);
        expect(newCompleted.status, JSON.stringify(newCompleted.body)).toBe(200);
        const newAccount = (yield* body(Schema.Struct({ account: Resource }), newCompleted)).account
          .id;
        f.trackAccount(f.actors.owner, newAccount);
        const newHealth = yield* f.api.request(
          f.actors.owner,
          "POST",
          `${f.prefix}/accounts/${newAccount}/health`,
        );
        expect((yield* body(Health, newHealth)).driver.source.version).toBe("replacement-revision");
        yield* f.configure({ revision: "replacement-revision" });
        expect((yield* check()).status).toBe(503);
        yield* f.configure({ check: false });
        expect((yield* check()).status).toBe(200);
        expect((yield* health()).checkable).toBe(false);
        yield* f.configure({ check: "void" });
        healthy(yield* check());
      }),
    ),
  );
});
