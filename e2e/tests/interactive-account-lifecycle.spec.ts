/** App-owned account lifecycle through real hosted HTTP and a controlled external backend. */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  interactiveAccountBackend,
  interactiveAccountSource,
  interactiveBackendKey,
} from "../support/interactive-account-backend.ts";
import { linkedAccountIds } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
const Account = Schema.Struct({ id: Schema.String, method: Schema.String, label: Schema.String });
const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Account });
const Access = Schema.Struct({ revision: Schema.String });
layer(HostedLive, { excludeTestServices: true })("Interactive account lifecycle", (it) => {
  it.effect(scenarios.interactiveAccountLifecycle.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const backend = yield* interactiveAccountBackend;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Interactive lifecycle ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: interactiveAccountSource(backend.origin, true) },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response),
          path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.asVoid, Effect.orDie),
        );
        const access = yield* api
          .request(actors.owner, "GET", `${path}/access`)
          .pipe(Effect.flatMap((r) => body(Access, r)));
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const pending = (actor: Session, slot = "identity", scope = "user", payload: object = {}) =>
          api
            .request(actor, "POST", `${path}/accounts/${scope}/${slot}/connections`, payload)
            .pipe(Effect.flatMap((r) => body(Resource, r)));
        const cp = (id: string) => `${prefix}/connections/${id}/interactive`;
        const start = (actor: Session, id: string, method: string) =>
          api.request(actor, "POST", `${cp(id)}/start`, { method });
        const status = (actor: Session, id: string) =>
          api.request(actor, "GET", `${cp(id)}/status`);
        const submit = (actor: Session, id: string) =>
          api.request(actor, "POST", `${cp(id)}/submit`, {
            value: "http://localhost:48765/done?code=synthetic",
          });
        const connected = (r: { status: number; body: unknown }) =>
          Effect.gen(function* () {
            expect(r.status, JSON.stringify(r.body)).toBe(200);
            return (yield* body(Connected, r)).account;
          });
        const link = (actor: Session, id: string) =>
          api.request(actor, "PUT", `${path}/accounts/user/identity/${id}`);
        const unlink = (actor: Session, id: string) =>
          api.request(actor, "DELETE", `${path}/accounts/user/identity/${id}`);
        const detail = (id: string) => api.request(actors.owner, "GET", `${prefix}/accounts/${id}`);
        const calls = () =>
          backend.calls.pipe(Effect.map((calls) => calls.filter((c) => c.step === "remove")));
        const backendConnection = yield* pending(actors.owner, "backend", "app");
        const backendResponse = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${backendConnection.id}/submit`,
          { method: "key", fields: { token: interactiveBackendKey } },
        );
        expect(backendResponse.status).toBe(200);
        const backendAccount = yield* body(Resource, backendResponse);
        const make = (actor: Session, shared = false) =>
          Effect.gen(function* () {
            const pendingConnection = yield* pending(
              actor,
              shared ? "sharedIdentity" : "identity",
              shared ? "app" : "user",
              shared ? { destination: { kind: "shared", audience: { kind: "everyone" } } } : {},
            );
            expect((yield* start(actor, pendingConnection.id, "paste")).status).toBe(200);
            return yield* connected(yield* submit(actor, pendingConnection.id));
          });
        // Use permission permits unlinking only this caller's link; it cannot retire the shared ref.
        const sharedA = yield* make(actors.owner, true),
          sharedB = yield* make(actors.owner, true);
        expect((yield* link(actors.member, sharedA.id)).status).toBe(200);
        expect((yield* link(actors.member, sharedB.id)).status).toBe(200);
        expect((yield* unlink(actors.member, sharedB.id)).status).toBe(200);
        expect(yield* calls()).toHaveLength(0);
        expect((yield* detail(sharedA.id)).status).toBe(200);
        expect((yield* detail(sharedB.id)).status).toBe(200);
        expect(
          (yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${sharedA.id}`)).status,
        ).toBe(403);
        expect((yield* detail(sharedA.id)).body).toMatchObject({ canReconnect: false });
        const reconnect = yield* api.request(
          actors.owner,
          "POST",
          `${path}/accounts/app/sharedIdentity/connections`,
          { account: sharedA.id },
        );
        expect(reconnect.status).toBe(422);
        expect(reconnect.body).toMatchObject({ _tag: "InteractiveReconnectUnsupported" });
        // Radio replacement retires a managed previous ref. Failure keeps the previous link.
        const first = yield* make(actors.owner);
        // A wrong-provider replacement must fail before touching the old credential.
        const beforeInvalid = (yield* calls()).length;
        const invalid = yield* link(actors.owner, backendAccount.id);
        expect(invalid.status).toBe(422);
        expect(invalid.body).toMatchObject({ _tag: "RequirementMismatch", reason: "provider" });
        expect(yield* calls()).toHaveLength(beforeInvalid);
        expect((yield* detail(first.id)).status).toBe(200);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([first.id]);
        yield* backend.refuseRemoval(true);
        expect((yield* link(actors.owner, sharedA.id)).status).toBe(503);
        expect((yield* detail(first.id)).status).toBe(200);
        yield* backend.refuseRemoval(false);
        expect((yield* link(actors.owner, sharedA.id)).status).toBe(200);
        expect((yield* detail(first.id)).status).toBe(403);
        // Connecting a replacement uses the same retirement, only when the new attempt connects.
        const replacement = yield* pending(actors.owner);
        expect((yield* start(actors.owner, replacement.id, "paste")).status).toBe(200);
        yield* backend.refuseRemoval(true);
        expect((yield* submit(actors.owner, replacement.id)).status).toBe(503);
        expect((yield* detail(sharedA.id)).status).toBe(200);
        expect((yield* status(actors.owner, replacement.id)).body).toMatchObject({
          state: "failed",
        });
        yield* backend.refuseRemoval(false);
        expect(
          (yield* api.request(actors.owner, "POST", `${cp(replacement.id)}/cancel`)).status,
        ).toBe(200);
        expect((yield* start(actors.owner, replacement.id, "paste")).status).toBe(200);
        const second = yield* connected(yield* submit(actors.owner, replacement.id));
        expect((yield* detail(sharedA.id)).status).toBe(403);
        // An in-flight step is waiting, and cancel allows a fresh method on the same connection.
        const attempt = yield* pending(actors.owner);
        expect((yield* start(actors.owner, attempt.id, "device")).status).toBe(200);
        const statusHold = yield* backend.holdStatus;
        const polling = yield* Effect.forkChild(status(actors.owner, attempt.id));
        yield* statusHold.started;
        expect((yield* submit(actors.owner, attempt.id)).body).toEqual({ state: "waiting" });
        yield* statusHold.release;
        expect((yield* Fiber.join(polling)).body).toEqual({ state: "waiting" });
        expect((yield* api.request(actors.owner, "POST", `${cp(attempt.id)}/cancel`)).status).toBe(
          200,
        );
        expect((yield* api.request(actors.owner, "POST", `${cp(attempt.id)}/cancel`)).status).toBe(
          200,
        );
        expect((yield* start(actors.owner, attempt.id, "paste")).status).toBe(200);
        expect((yield* api.request(actors.owner, "POST", `${cp(attempt.id)}/cancel`)).status).toBe(
          200,
        );
        const expired = yield* pending(actors.owner);
        expect((yield* start(actors.owner, expired.id, "expired")).status).toBe(200);
        expect((yield* status(actors.owner, expired.id)).body).toMatchObject({ state: "failed" });
        expect((yield* api.request(actors.owner, "POST", `${cp(expired.id)}/cancel`)).status).toBe(
          200,
        );
        expect((yield* api.request(actors.owner, "POST", `${cp(expired.id)}/cancel`)).status).toBe(
          200,
        );
        expect((yield* start(actors.owner, expired.id, "paste")).status).toBe(200);
        expect((yield* api.request(actors.owner, "POST", `${cp(expired.id)}/cancel`)).status).toBe(
          200,
        );
        // A held remove and a direct delete compete for one durable claim.
        const before = (yield* calls()).length;
        const removalHold = yield* backend.holdRemoval;
        yield* Effect.addFinalizer(() => removalHold.release);
        const retiring = yield* Effect.forkChild(unlink(actors.owner, second.id));
        yield* removalHold.started;
        const duplicate = yield* api.request(
          actors.owner,
          "DELETE",
          `${prefix}/accounts/${second.id}`,
        );
        expect(duplicate.status).toBe(409);
        expect(duplicate.body).toMatchObject({ _tag: "InteractiveRetirementBusy" });
        expect(yield* calls()).toHaveLength(before + 1);
        yield* removalHold.release;
        expect((yield* Fiber.join(retiring)).status).toBe(200);
        expect(yield* calls()).toHaveLength(before + 1);
        // Bulk deletion attempts cleanup, but provider refusal cannot keep the app or accounts.
        const surviving = yield* make(actors.owner);
        const beforeHook = (yield* calls()).length;
        // A storage fault in the real appRemoving hook refuses the deletion transaction.
        yield* legacyStorage([
          {
            sql: "create function e2e_refuse_app_removing() returns trigger language plpgsql as $$ begin raise exception 'Synthetic appRemoving refusal'; end $$",
          },
          {
            sql: "create trigger e2e_refuse_app_removing before delete on hosted_app_account_links for each statement execute function e2e_refuse_app_removing()",
          },
        ]);
        yield* serverControl("start");
        yield* Effect.gen(function* () {
          expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(500);
          expect(yield* calls()).toHaveLength(beforeHook);
          expect((yield* api.request(actors.owner, "GET", path)).status).toBe(200);
          expect((yield* detail(surviving.id)).status).toBe(200);
        }).pipe(
          Effect.ensuring(
            legacyStorage([
              { sql: "drop trigger e2e_refuse_app_removing on hosted_app_account_links" },
              { sql: "drop function e2e_refuse_app_removing()" },
            ]).pipe(Effect.andThen(serverControl("start")), Effect.orDie),
          ),
        );
        yield* backend.refuseRemoval(true);
        const appCallsBefore = (yield* calls()).length;
        const cleanupHold = yield* backend.holdRemoval;
        yield* Effect.addFinalizer(() => cleanupHold.release);
        const deleting = yield* Effect.forkChild(api.request(actors.owner, "DELETE", path));
        yield* cleanupHold.started;
        // The app and account rows are already committed away while external cleanup is held.
        expect((yield* api.request(actors.owner, "GET", path)).status).toBe(403);
        expect((yield* detail(surviving.id)).status).toBe(403);
        yield* cleanupHold.release;
        expect((yield* Fiber.join(deleting)).status).toBe(200);
        expect((yield* calls()).length).toBeGreaterThan(appCallsBefore);
        expect((yield* detail(surviving.id)).status).toBe(403);
        expect((yield* detail(sharedB.id)).status).toBe(403);
      }),
    ),
  );
  it.effect(scenarios.interactiveAccountDeletionEligibility.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const backend = yield* interactiveAccountBackend;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Interactive deletion ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: interactiveAccountSource(backend.origin, false, true) },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response),
          path = `${prefix}/apps/${app.id}`;
        let run: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (run !== undefined)
              yield* api.request(actors.owner, "POST", `${path}/workflow-runs/${run}/terminate`);
            yield* api.request(actors.owner, "DELETE", path);
          }).pipe(Effect.asVoid, Effect.orDie),
        );
        const connection = (scope: string, slot: string) =>
          api
            .request(actors.owner, "POST", `${path}/accounts/${scope}/${slot}/connections`, {})
            .pipe(Effect.flatMap((r) => body(Resource, r)));
        const key = yield* connection("app", "backend");
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/connections/${key.id}/submit`, {
            method: "key",
            fields: { token: interactiveBackendKey },
          })).status,
        ).toBe(200);
        // Start real app-scoped work before any interactive reference exists, so it cannot pin one.
        const scheduled = yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
          enabled: true,
          scope: "app",
        });
        expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
        expect(scheduled.body).toMatchObject({ actor: null });
        const copy = yield* body(Resource, scheduled);
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/schedules/tick/copies/${copy.id}/run`))
            .status,
        ).toBe(200);
        const Runs = Schema.Struct({
          items: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              status: Schema.String,
            }),
          ),
        });
        run = yield* api.request(actors.owner, "GET", `${path}/workflow-runs`).pipe(
          Effect.flatMap((r) => body(Runs, r)),
          Effect.flatMap(({ items }) => {
            const active = items.find((r) => r.status === "running" || r.status === "queued");
            return active === undefined
              ? Effect.fail(new Error("App workflow has not started"))
              : Effect.succeed(active.id);
          }),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick/copies/${copy.id}`, {
            enabled: false,
          })).status,
        ).toBe(200);
        const pending = yield* connection("user", "identity");
        const interactive = `${prefix}/connections/${pending.id}/interactive`;
        expect(
          (yield* api.request(actors.owner, "POST", `${interactive}/start`, { method: "paste" }))
            .status,
        ).toBe(200);
        const signedIn = yield* api.request(actors.owner, "POST", `${interactive}/submit`, {
          value: "http://localhost:48765/done?code=synthetic",
        });
        expect(signedIn.status).toBe(200);
        const account = (yield* body(Connected, signedIn)).account;
        const before = (yield* backend.calls).filter((c) => c.step === "remove").length;
        const refused = yield* api.request(actors.owner, "DELETE", path);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ _tag: "AppWorkflowsActive" });
        expect((yield* backend.calls).filter((c) => c.step === "remove")).toHaveLength(before);
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account.id}`)).status,
        ).toBe(200);
        expect((yield* api.request(actors.owner, "GET", path)).status).toBe(200);
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/workflow-runs/${run}/terminate`))
            .status,
        ).toBe(200);
        expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
        expect((yield* backend.calls).filter((c) => c.step === "remove").length).toBeGreaterThan(
          before,
        );
      }),
    ),
  );
});
