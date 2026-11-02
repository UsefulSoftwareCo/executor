/** An app-owned remove handler re-enters the same authenticated product server over HTTP. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Fiber, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import {
  interactiveAccountBackend,
  interactiveAccountSource,
  interactiveBackendKey,
} from "../support/interactive-account-backend.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";
const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Resource });
/** PGlite's filesystem lock stays live for roughly ten seconds after a hard kill. */
const restartAfterCrash = Effect.gen(function* () {
  for (let attempt = 1; ; attempt++) {
    const started = yield* Effect.exit(serverControl("start"));
    if (Exit.isSuccess(started)) return;
    if (attempt === 20) return yield* started;
    yield* Effect.sleep("1 second");
  }
});
layer(HostedLive, { excludeTestServices: true })("Interactive removal callback", (it) => {
  it.effect(scenarios.interactiveAccountRemovalCallback.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const backend = yield* interactiveAccountBackend;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const callback = `${targetHosts(target).browser}${prefix}/access`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Removal callback ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: interactiveAccountSource(backend.origin, false, false, callback),
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.asVoid, Effect.orDie),
        );
        const pending = (scope: string, slot: string) =>
          api
            .request(actors.owner, "POST", `${path}/accounts/${scope}/${slot}/connections`, {})
            .pipe(Effect.flatMap((r) => body(Resource, r)));
        const key = yield* pending("app", "backend");
        // The callback credential belongs to the synthetic scenario owner and stays in sealed fields.
        const cookie = Redacted.value(yield* actors.owner.cookies)
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/connections/${key.id}/submit`, {
            method: "key",
            fields: { token: interactiveBackendKey, cookie },
          })).status,
        ).toBe(200);
        const make = Effect.gen(function* () {
          const connection = yield* pending("user", "identity"),
            cp = `${prefix}/connections/${connection.id}/interactive`;
          expect(
            (yield* api.request(actors.owner, "POST", `${cp}/start`, { method: "paste" })).status,
          ).toBe(200);
          const result = yield* api.request(actors.owner, "POST", `${cp}/submit`, {
            value: "http://localhost:48765/done?code=synthetic",
          });
          expect(result.status).toBe(200);
          return (yield* body(Connected, result)).account;
        });
        const first = yield* make;
        // The external backend records remove only after the authenticated callback returned 200.
        const unlinked = yield* api.request(
          actors.owner,
          "DELETE",
          `${path}/accounts/user/identity/${first.id}`,
        );
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
        expect((yield* backend.calls).filter((c) => c.step === "remove")).toHaveLength(1);
        // A hard crash leaves the committed claim and local link intact. It expires on restart.
        const crashed = yield* make;
        const held = yield* backend.holdRemoval;
        yield* Effect.addFinalizer(() => held.release);
        const crashing = yield* Effect.forkChild(
          api
            .request(actors.owner, "DELETE", `${path}/accounts/user/identity/${crashed.id}`)
            .pipe(Effect.exit),
        );
        yield* held.started;
        yield* serverControl("kill");
        yield* held.release;
        yield* Fiber.join(crashing);
        yield* restartAfterCrash;
        const callsBeforeExpiry = (yield* backend.calls).filter((c) => c.step === "remove").length;
        const stillClaimed = yield* api.request(
          actors.owner,
          "DELETE",
          `${path}/accounts/user/identity/${crashed.id}`,
        );
        expect(stillClaimed.status).toBe(409);
        expect(stillClaimed.body).toMatchObject({ _tag: "InteractiveRetirementBusy" });
        expect((yield* backend.calls).filter((c) => c.step === "remove")).toHaveLength(
          callsBeforeExpiry,
        );
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 21_000 });
        yield* serverControl("start");
        expect(
          (yield* api.request(
            actors.owner,
            "DELETE",
            `${path}/accounts/user/identity/${crashed.id}`,
          )).status,
        ).toBe(200);
        expect((yield* backend.calls).filter((c) => c.step === "remove").length).toBeGreaterThan(
          callsBeforeExpiry,
        );
        const second = yield* make;
        const racing = yield* pending("user", "identity");
        const cp = `${prefix}/connections/${racing.id}/interactive`;
        expect(
          (yield* api.request(actors.owner, "POST", `${cp}/start`, { method: "paste" })).status,
        ).toBe(200);
        const hold = yield* backend.holdSubmit;
        yield* Effect.addFinalizer(() => hold.release);
        const completing = yield* Effect.forkChild(
          api.request(actors.owner, "POST", `${cp}/submit`, {
            value: "http://localhost:48765/done?code=synthetic",
          }),
        );
        yield* hold.started;
        yield* backend.refuseRemoval(true);
        const before = (yield* backend.calls).filter((c) => c.step === "remove").length;
        const removed = yield* api.request(actors.owner, "DELETE", path);
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect((yield* backend.calls).filter((c) => c.step === "remove").length).toBeGreaterThan(
          before,
        );
        const afterBulk = (yield* backend.calls).filter((c) => c.step === "remove").length;
        yield* hold.release;
        expect((yield* Fiber.join(completing)).status).not.toBe(200);
        // Even though the app is gone, the sign-in's captured context still attempts compensation.
        expect((yield* backend.calls).filter((c) => c.step === "remove").length).toBeGreaterThan(
          afterBulk,
        );
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${second.id}`)).status,
        ).toBe(403);
      }),
    ),
  );
});
