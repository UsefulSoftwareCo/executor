import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { acquisitionFixture } from "../support/account-acquisition-fixture.ts";
import { linkAccount, unlinkAccount } from "../support/app-accounts.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Reusable hosted accounts", (it) => {
  it.effect(scenarios.accountAcquisition.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const f = yield* acquisitionFixture();
        const { api, actors, backend } = f;
        const { account, connection } = yield* f.create(actors.member);
        const accountPath = `${f.prefix}/accounts/${account}`;
        const first = yield* f.deploy("First reusable account consumer");
        const second = yield* f.deploy("Second reusable account consumer");
        yield* linkAccount(actors.member, first.path, "identity", account);
        yield* linkAccount(actors.member, second.path, "identity", account);
        const used = (path: string) =>
          api.request(actors.member, "POST", `${path}/tools/call`, {
            tool: "ids",
            kind: "query",
            input: {},
          });
        expect((yield* used(first.path)).body).toEqual([
          { id: account, method: "paste", fields: { ref: "opaque-1" } },
        ]);
        expect((yield* used(second.path)).body).toEqual((yield* used(first.path)).body);
        const before = (yield* backend.calls).length;
        for (const other of [actors.owner, actors.admin]) {
          expect(
            (yield* api.request(other, "GET", `${f.connectPath(connection)}/status`)).status,
          ).toBe(403);
          expect((yield* f.submit(other, connection)).status).toBe(403);
          expect(
            (yield* api.request(other, "POST", `${f.connectPath(connection)}/cancel`)).status,
          ).toBe(403);
          expect((yield* f.pending(other, first.app.id, account)).status).toBe(403);
          expect((yield* api.request(other, "DELETE", accountPath)).status).toBe(403);
        }
        expect((yield* backend.calls).length).toBe(before);
        const detail = yield* api.request(actors.member, "GET", accountPath);
        expect(detail.status).toBe(200);
        const saved = yield* body(
          Schema.Struct({ account: Schema.Struct({ owner: Schema.String }) }),
          detail,
        );
        expect(
          (yield* backend.calls).filter((call) => call.step === "start").map((call) => call.caller),
        ).toEqual([saved.account.owner]);
        expect(JSON.stringify(detail.body)).not.toContain("opaque-1");
        expect((yield* api.request(actors.owner, "DELETE", f.manager.path)).status).toBe(200);
        expect(yield* backend.removeCalls).toEqual([]);
        expect((yield* used(second.path)).status).toBe(200);
        yield* unlinkAccount(actors.member, first.path, "identity", account);
        expect((yield* used(second.path)).status).toBe(200);
        yield* unlinkAccount(actors.member, second.path, "identity", account);
        expect((yield* api.request(actors.member, "GET", accountPath)).status).toBe(200);
        expect(yield* backend.removeCalls).toEqual([]);
        yield* linkAccount(actors.member, first.path, "identity", account);
        yield* linkAccount(actors.member, second.path, "identity", account);

        const pending = yield* f.pending(actors.member, first.app.id, account);
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const reconnect = (yield* body(Resource, pending)).id;
        expect((yield* f.start(actors.member, reconnect)).status).toBe(200);
        expect((yield* f.submit(actors.member, reconnect)).body).toMatchObject({
          state: "connected",
          account: { id: account },
        });
        expect((yield* used(second.path)).body).toEqual([
          { id: account, method: "paste", fields: { ref: "opaque-2" } },
        ]);
        const removal = yield* backend.holdRemoval;
        yield* backend.refuseRemoval(true);
        const deleting = yield* api
          .request(actors.member, "DELETE", accountPath)
          .pipe(Effect.forkChild);
        yield* removal.started;
        expect((yield* api.request(actors.member, "DELETE", accountPath)).status).toBe(409);
        expect((yield* api.request(actors.member, "GET", accountPath)).status).toBe(200);
        yield* removal.release;
        expect((yield* Fiber.join(deleting)).status).toBe(503);
        expect((yield* api.request(actors.member, "GET", accountPath)).status).toBe(200);
        yield* backend.refuseRemoval(false);
        expect((yield* api.request(actors.member, "DELETE", accountPath)).status).toBe(200);
        const calls = yield* backend.removeCalls;
        expect(calls).toHaveLength(2);
        expect(calls.map((call) => call.ref)).toEqual(["opaque-2", "opaque-2"]);
        expect(calls[0]?.operation).toBeTruthy();
        expect(calls[1]?.operation).toBe(calls[0]?.operation);
        expect((yield* api.request(actors.member, "GET", accountPath)).status).toBe(403);
        expect((yield* api.request(actors.member, "DELETE", accountPath)).status).toBe(403);
        expect(yield* backend.removeCalls).toHaveLength(2);

        const pendingLoss = yield* f.pending(actors.member, first.app.id);
        const lossAttempt = (yield* body(Resource, pendingLoss)).id;
        expect((yield* f.start(actors.member, lossAttempt)).status).toBe(200);
        const connectedLoss = yield* f.submit(actors.member, lossAttempt);
        expect(connectedLoss.status, JSON.stringify(connectedLoss.body)).toBe(200);
        const lossAccount = (yield* body(Schema.Struct({ account: Resource }), connectedLoss))
          .account.id;
        f.trackAccount(actors.member, lossAccount);
        const lossPath = `${f.prefix}/accounts/${lossAccount}`;
        yield* backend.loseNextRemovalResponse;
        expect((yield* api.request(actors.member, "DELETE", lossPath)).status).toBe(503);
        expect((yield* api.request(actors.member, "GET", lossPath)).status).toBe(200);
        const effects = yield* backend.removalEffects;
        expect(effects.map((call) => call.ref)).toEqual(["opaque-2", "opaque-3"]);
        expect((yield* api.request(actors.member, "DELETE", lossPath)).status).toBe(200);
        expect(yield* backend.removalEffects).toEqual(effects);
        const retried = (yield* backend.removeCalls).slice(2);
        expect(retried.map((call) => call.knownReference)).toEqual([true, false]);
        expect(retried[0]?.operation).toBeTruthy();
        expect(retried[1]?.operation).toBe(retried[0]?.operation);
        expect((yield* api.request(actors.member, "GET", lossPath)).status).toBe(403);
      }),
    ),
  );
});
