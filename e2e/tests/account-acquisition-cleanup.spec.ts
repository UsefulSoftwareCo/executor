import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { acquisitionFixture } from "../support/account-acquisition-fixture.ts";
import { linkAccount } from "../support/app-accounts.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Resource });

layer(HostedLive, { excludeTestServices: true })("Driver acquisition output and cleanup", (it) => {
  it.effect(scenarios.accountAcquisitionStartPrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* acquisitionFixture();
        const actor = f.actors.member;
        const { account } = yield* f.create(actor);
        const cancelled: string[] = [];
        for (const field of ["url", "code", "message", "label", "placeholder"] as const) {
          for (const encoded of [false, true]) {
            yield* f.backend.exposeStartReference({ field, encoded });
            const pending = yield* f.pending(actor, f.manager.app.id, account);
            expect(pending.status).toBe(200);
            const connection = (yield* body(Resource, pending)).id;
            const refused = yield* f.start(actor, connection);
            expect(refused.status).toBe(422);
            cancelled.push(`private-session-${cancelled.length + 2}`);
            const calls = yield* f.backend.calls;
            expect(calls.filter((call) => call.step === "start").at(-1)?.ref).toBe("opaque-1");
            expect(
              calls.filter((call) => call.step === "cancel").map((call) => call.session),
            ).toEqual(cancelled);
            const retained = yield* f.api.request(
              actor,
              "GET",
              `${f.connectPath(connection)}/status`,
            );
            expect(retained.status).toBe(200);
            expect((yield* f.backend.calls).length).toBe(calls.length);
            for (const response of [refused, retained]) {
              expect(JSON.stringify(response.body)).not.toContain("opaque-1");
              expect(JSON.stringify(response.body)).not.toContain(
                Buffer.from("opaque-1").toString("base64"),
              );
            }
            expect(
              (yield* f.api.request(actor, "POST", `${f.connectPath(connection)}/cancel`)).status,
            ).toBe(200);
          }
        }
        yield* f.backend.exposeStartReference();
        const pending = yield* f.pending(actor, f.manager.app.id, account);
        expect(pending.status).toBe(200);
        const connection = (yield* body(Resource, pending)).id;
        const safe = yield* f.start(actor, connection);
        expect(safe.status).toBe(200);
        const calls = (yield* f.backend.calls).length;
        expect((yield* f.start(actor, connection)).body).toEqual(safe.body);
        expect((yield* f.backend.calls).length).toBe(calls);
        expect(
          (yield* f.api.request(actor, "POST", `${f.connectPath(connection)}/cancel`)).status,
        ).toBe(200);
        expect(yield* f.backend.removeCalls).toEqual([]);
        expect((yield* f.api.request(actor, "GET", `${f.prefix}/accounts/${account}`)).status).toBe(
          200,
        );
      }),
    ),
  );
  it.effect(scenarios.accountAcquisitionFailurePrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* acquisitionFixture();
        const actor = f.actors.member;
        const { account } = yield* f.create(actor);
        for (const step of ["submit", "status"] as const) {
          for (const message of ["opaque-1", Buffer.from("opaque-1").toString("base64")]) {
            const pending = yield* f.pending(actor, f.manager.app.id, account);
            expect(pending.status).toBe(200);
            const connection = (yield* body(Resource, pending)).id;
            expect((yield* f.start(actor, connection)).status).toBe(200);
            yield* f.backend.failAcquisition(message);
            const status = () => f.api.request(actor, "GET", `${f.connectPath(connection)}/status`);
            const failed = yield* step === "submit" ? f.submit(actor, connection) : status();
            expect(failed.status).toBe(200);
            expect(failed.body).toMatchObject({ state: "failed" });
            const calls = (yield* f.backend.calls).length;
            const retained = yield* status();
            expect(retained.body).toEqual(failed.body);
            expect((yield* f.backend.calls).length).toBe(calls);
            expect(JSON.stringify(failed.body)).not.toContain("opaque-1");
            expect(JSON.stringify(failed.body)).not.toContain(
              Buffer.from("opaque-1").toString("base64"),
            );
            expect(
              (yield* f.api.request(actor, "POST", `${f.connectPath(connection)}/cancel`)).status,
            ).toBe(200);
          }
        }
        expect(yield* f.backend.removeCalls).toEqual([]);
        expect((yield* f.api.request(actor, "GET", `${f.prefix}/accounts/${account}`)).status).toBe(
          200,
        );
      }),
    ),
  );
  it.effect(scenarios.accountAcquisitionIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* acquisitionFixture();
        let sequence = 0;
        for (const step of ["submit", "status"] as const) {
          for (const encoded of [false, true]) {
            const reference = `opaque-${++sequence}`;
            const label = encoded ? Buffer.from(reference).toString("base64") : reference;
            yield* f.backend.setAccountInfo({ displayName: label });
            const pending = yield* f.pending(f.actors.member);
            expect(pending.status).toBe(200);
            const connection = (yield* body(Resource, pending)).id;
            expect((yield* f.start(f.actors.member, connection)).status).toBe(200);
            const status = () =>
              f.api.request(f.actors.member, "GET", `${f.connectPath(connection)}/status`);
            if (step === "status")
              expect((yield* status()).body).toMatchObject({ state: "waiting" });
            const response = yield* step === "submit"
              ? f.submit(f.actors.member, connection)
              : status();
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const { account } = yield* body(Connected, response);
            f.trackAccount(f.actors.member, account.id);
            const detail = yield* f.api.request(
              f.actors.member,
              "GET",
              `${f.prefix}/accounts/${account.id}`,
            );
            expect(detail.status).toBe(200);
            for (const value of [response.body, detail.body]) {
              expect(JSON.stringify(value)).not.toContain(reference);
              expect(JSON.stringify(value)).not.toContain(
                Buffer.from(reference).toString("base64"),
              );
            }
          }
        }
      }),
    ),
  );

  it.effect(scenarios.accountAcquisitionCleanup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* acquisitionFixture();
        const actor = f.actors.member;
        const { account } = yield* f.create(actor);
        const accountPath = `${f.prefix}/accounts/${account}`;
        const consumer = yield* f.deploy("Reconnect generation consumer");
        yield* linkAccount(actor, consumer.path, "identity", account);
        const used = () =>
          f.api.request(actor, "POST", `${consumer.path}/tools/call`, {
            tool: "ids",
            kind: "query",
            input: {},
          });
        const reconnect = () =>
          Effect.gen(function* () {
            const pending = yield* f.pending(actor, consumer.app.id, account);
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const id = (yield* body(Resource, pending)).id;
            expect((yield* f.start(actor, id)).status).toBe(200);
            return id;
          });
        const older = yield* reconnect();
        const hold = yield* f.backend.holdNextSubmit;
        const finishing = yield* f.submit(actor, older).pipe(Effect.forkChild);
        yield* hold.started;
        const newer = yield* reconnect();
        expect((yield* f.submit(actor, newer)).body).toMatchObject({
          state: "connected",
          account: { id: account },
        });
        yield* hold.release;
        expect((yield* Fiber.join(finishing)).status).toBe(422);
        expect((yield* used()).body).toEqual([
          { id: account, method: "paste", fields: { ref: "opaque-3" } },
        ]);
        const cancellations = () =>
          f.backend.calls.pipe(
            Effect.map((calls) =>
              calls.filter((call) => call.step === "cancel").map((call) => call.session),
            ),
          );
        expect(yield* cancellations()).toEqual(["private-session-2"]);
        expect(yield* f.backend.removeCalls).toEqual([]);

        const stale = yield* reconnect();
        const latest = yield* reconnect();
        expect((yield* f.submit(actor, latest)).body).toMatchObject({
          state: "connected",
          account: { id: account },
        });
        const cancel = (id: string) => f.api.request(actor, "POST", `${f.connectPath(id)}/cancel`);
        expect((yield* cancel(stale)).status).toBe(200);
        expect((yield* cancel(stale)).status).toBe(200);
        expect(yield* cancellations()).toEqual(["private-session-2", "private-session-4"]);
        expect((yield* used()).body).toEqual([
          { id: account, method: "paste", fields: { ref: "opaque-5" } },
        ]);
        expect(yield* f.backend.removeCalls).toEqual([]);

        const deleted = yield* reconnect();
        expect((yield* f.api.request(actor, "DELETE", accountPath)).status).toBe(200);
        for (const other of [f.actors.owner, f.actors.admin])
          expect(
            (yield* f.api.request(other, "POST", `${f.connectPath(deleted)}/cancel`)).status,
          ).toBe(403);
        expect(yield* cancellations()).toEqual(["private-session-2", "private-session-4"]);
        expect((yield* cancel(deleted)).status).toBe(200);
        expect(yield* cancellations()).toEqual([
          "private-session-2",
          "private-session-4",
          "private-session-6",
        ]);
        expect((yield* f.backend.removeCalls).map((call) => call.ref)).toEqual(["opaque-5"]);
        expect((yield* f.api.request(actor, "GET", accountPath)).status).toBe(403);
      }),
    ),
  );
});
