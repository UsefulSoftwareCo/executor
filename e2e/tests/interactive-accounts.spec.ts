/** Public HTTP drives app-owned sign-ins; the app talks to a real synthetic backend. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
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
import { scenarios } from "../test-plan.ts";

const Account = Schema.Struct({ id: Schema.String, method: Schema.String, label: Schema.String });
const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Account });
const Links = Schema.Array(Schema.Struct({ account: Account }));
const Identity = Schema.Struct({ userId: Schema.String });
const Access = Schema.Struct({ revision: Schema.String });
const Refs = Schema.Struct({
  caller: Schema.String,
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      method: Schema.String,
      fields: Schema.Struct({ ref: Schema.String }),
      keys: Schema.Array(Schema.String),
    }),
  ),
});

layer(HostedLive, { excludeTestServices: true })("Interactive accounts", (it) => {
  it.effect(scenarios.interactiveAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const backend = yield* interactiveAccountBackend;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const apps: string[] = [];
        const accounts: { id: string; actor: Session }[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const app of apps)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`);
            for (const account of accounts)
              yield* api.request(account.actor, "DELETE", `${prefix}/accounts/${account.id}`);
          }).pipe(Effect.orDie),
        );
        const memberId = yield* api.request(actors.member, "GET", "/api/viewer").pipe(
          Effect.flatMap((response) => body(Identity, response)),
          Effect.map((viewer) => viewer.userId),
        );
        const deploy = () =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Interactive fixture ${randomUUID().slice(0, 8)}`,
              files: [
                { path: "index.ts", content: interactiveAccountSource(backend.origin) },
                appsManifest,
              ],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            apps.push(app.id);
            const path = `${prefix}/apps/${app.id}`;
            const access = yield* api
              .request(actors.owner, "GET", `${path}/access`)
              .pipe(Effect.flatMap((response) => body(Access, response)));
            expect(
              (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);
            return { app, path };
          });
        const { app, path } = yield* deploy();
        const pending = (actor: Session, scope = "user", slot = "identity") =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actor,
              "POST",
              `${path}/accounts/${scope}/${slot}/connections`,
              {},
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Resource, response);
          });
        const backendConnection = yield* pending(actors.owner, "app", "backend");
        const backendAccount = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${backendConnection.id}/submit`,
          { method: "key", fields: { token: interactiveBackendKey } },
        );
        expect(backendAccount.status, JSON.stringify(backendAccount.body)).toBe(200);
        accounts.push({ ...(yield* body(Resource, backendAccount)), actor: actors.owner });
        const connectPath = (id: string) => `${prefix}/connections/${id}/interactive`;
        const start = (actor: Session, id: string, method: string) =>
          api.request(actor, "POST", `${connectPath(id)}/start`, { method });
        const status = (actor: Session, id: string) =>
          api.request(actor, "GET", `${connectPath(id)}/status`);
        const connected = (actor: Session, response: { status: number; body: unknown }) =>
          Effect.gen(function* () {
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const result = yield* body(Connected, response);
            accounts.push({ id: result.account.id, actor });
            expect(JSON.stringify(response.body)).not.toContain("private-session-");
            return result.account;
          });
        const links = (actor: Session, scope = "user") =>
          api
            .request(actor, "GET", `${path}/accounts/${scope}`)
            .pipe(Effect.flatMap((response) => body(Links, response)));

        // Neither a missing slot handler nor a handler without an interactive requirement is valid.
        for (const source of [
          `import { defineApp, defineProvider, interactive } from "apps"; const p = defineProvider({ name: "Missing handlers", auth: { a: interactive({ label: "A" }) } }); export default defineApp({ user: { accounts: { identity: p } } }, {});`,
          `import { defineApp } from "apps"; export default defineApp({}, { connect: { identity: { start: async () => ({ session: "synthetic" }), status: async () => ({ state: "waiting" }) } } });`,
        ]) {
          const refused = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Invalid interactive fixture ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        }

        const device = yield* pending(actors.member);
        expect((yield* start(actors.member, device.id, "key")).status).toBe(422);
        const instructions = yield* start(actors.member, device.id, "device");
        expect(instructions.status, JSON.stringify(instructions.body)).toBe(200);
        expect(instructions.body).toMatchObject({
          url: `${backend.origin}/authorize`,
          code: expect.stringMatching(/^CODE-/),
        });
        expect(JSON.stringify(instructions.body)).not.toContain("session");
        expect((yield* status(actors.member, device.id)).body).toEqual({ state: "waiting" });
        const deviceAccount = yield* connected(
          actors.member,
          yield* status(actors.member, device.id),
        );
        // The app reported an identity, so it names the account.
        expect(deviceAccount).toMatchObject({
          method: "device",
          label: "Synthetic device account",
        });
        expect((yield* status(actors.member, device.id)).body).toMatchObject({
          state: "connected",
          account: { id: deviceAccount.id },
        });
        const publicConnection = yield* api.request(
          actors.member,
          "GET",
          `${prefix}/connections/${device.id}`,
        );
        expect(JSON.stringify(publicConnection.body)).not.toContain("private-session-");
        const detail = yield* api.request(
          actors.member,
          "GET",
          `${prefix}/accounts/${deviceAccount.id}`,
        );
        expect(detail.body).toMatchObject({
          health: { info: { displayName: "Synthetic device account" } },
        });
        const refs = yield* api
          .request(actors.member, "POST", `${path}/tools/call`, {
            tool: "refs",
            kind: "query",
            input: {},
          })
          .pipe(Effect.flatMap((response) => body(Refs, response)));
        expect(refs.caller).toBe(memberId);
        expect(refs.accounts).toEqual([
          {
            id: deviceAccount.id,
            method: "device",
            fields: { ref: expect.stringMatching(/^opaque-/) },
            keys: ["ref"],
          },
        ]);
        const deviceRef = refs.accounts[0]?.fields.ref;
        expect(deviceRef).toBeDefined();

        const other = yield* deploy();
        const crossApp = yield* api.request(
          actors.member,
          "PUT",
          `${other.path}/accounts/user/identity/${deviceAccount.id}`,
        );
        expect(crossApp.status, JSON.stringify(crossApp.body)).toBe(422);
        expect(crossApp.body).toMatchObject({ _tag: "RequirementMismatch", reason: "app_bound" });

        const paste = yield* pending(actors.member);
        const pasteInstructions = yield* start(actors.member, paste.id, "paste");
        expect(pasteInstructions.body).toMatchObject({
          paste: { label: "Paste the final address", placeholder: "http://localhost/..." },
        });
        const pasteAccount = yield* connected(
          actors.member,
          yield* api.request(actors.member, "POST", `${connectPath(paste.id)}/submit`, {
            value: "http://localhost:48765/done?code=synthetic",
          }),
        );
        expect(pasteAccount).toMatchObject({ method: "paste", label: "Synthetic pasted account" });

        const failed = yield* pending(actors.member);
        expect((yield* start(actors.member, failed.id, "failure")).status).toBe(200);
        expect((yield* status(actors.member, failed.id)).body).toEqual({
          state: "failed",
          message: "Synthetic refusal",
        });
        expect(
          (yield* api.request(actors.member, "POST", `${connectPath(failed.id)}/cancel`)).status,
        ).toBe(200);
        const cancelled = yield* pending(actors.member);
        expect((yield* start(actors.member, cancelled.id, "device")).status).toBe(200);
        expect(
          (yield* api.request(actors.owner, "GET", `${connectPath(cancelled.id)}/status`)).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", `${connectPath(cancelled.id)}/cancel`)).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/connections/${cancelled.id}`)).body,
        ).toMatchObject({ state: { status: "cancelled" } });
        expect((yield* start(actors.member, cancelled.id, "paste")).status).toBe(200);
        expect(
          (yield* api.request(actors.member, "POST", `${connectPath(cancelled.id)}/cancel`)).status,
        ).toBe(200);
        expect((yield* links(actors.member)).map((row) => row.account.id).sort()).toEqual(
          [deviceAccount.id, pasteAccount.id].sort(),
        );

        // A failed cleanup keeps the link. The successful retry runs with a changed backend answer.
        yield* backend.refuseRemoval(true);
        expect(
          (yield* api.request(
            actors.member,
            "DELETE",
            `${path}/accounts/user/identity/${deviceAccount.id}`,
          )).status,
        ).toBe(503);
        expect(
          (yield* links(actors.member)).some((row) => row.account.id === deviceAccount.id),
        ).toBe(true);
        yield* backend.refuseRemoval(false);
        expect(
          (yield* api.request(
            actors.member,
            "DELETE",
            `${path}/accounts/user/identity/${deviceAccount.id}`,
          )).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/accounts/${deviceAccount.id}`))
            .status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${pasteAccount.id}`))
            .status,
        ).toBe(200);
        expect(yield* links(actors.member)).toEqual([]);

        expect(
          (yield* api.request(
            actors.member,
            "POST",
            `${path}/accounts/app/sharedIdentity/connections`,
            {},
          )).status,
        ).toBe(403);
        const shared = yield* pending(actors.owner, "app", "sharedIdentity");
        expect((yield* start(actors.owner, shared.id, "device")).status).toBe(200);
        expect((yield* start(actors.member, shared.id, "device")).status).toBe(403);
        expect((yield* status(actors.owner, shared.id)).body).toEqual({ state: "waiting" });
        const sharedAccount = yield* connected(
          actors.owner,
          yield* status(actors.owner, shared.id),
        );
        expect(
          (yield* api.request(
            actors.member,
            "DELETE",
            `${path}/accounts/app/sharedIdentity/${sharedAccount.id}`,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(
            actors.owner,
            "DELETE",
            `${path}/accounts/app/sharedIdentity/${sharedAccount.id}`,
          )).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${sharedAccount.id}`))
            .status,
        ).toBe(403);

        const slow = yield* pending(actors.member);
        expect((yield* start(actors.member, slow.id, "slow")).status).toBe(200);
        const before = yield* Clock.currentTimeMillis;
        expect((yield* status(actors.member, slow.id)).status).toBe(422);
        expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(20_000);
        expect((yield* status(actors.member, slow.id)).body).toMatchObject({ state: "failed" });
        expect(
          (yield* api.request(actors.member, "POST", `${connectPath(slow.id)}/cancel`)).status,
        ).toBe(200);

        const gone = yield* pending(actors.member);
        expect((yield* start(actors.member, gone.id, "paste")).status).toBe(200);
        const orphan = yield* connected(
          actors.member,
          yield* api.request(actors.member, "POST", `${connectPath(gone.id)}/submit`, {
            value: "http://localhost:48765/done?code=synthetic",
          }),
        );
        const calls = yield* backend.calls;
        expect(
          calls
            .filter((call) => call.step === "start" && call.caller === memberId)
            .map((call) => call.method),
        ).toEqual(["device", "paste", "failure", "device", "paste", "slow", "paste"]);
        expect(
          calls.some(
            (call) => call.step === "remove" && call.method === "device" && call.ref === deviceRef,
          ),
        ).toBe(true);
        expect(calls.some((call) => call.step === "remove" && call.method === "paste")).toBe(true);
        expect(calls.filter((call) => call.step === "cancel").map((call) => call.method)).toEqual([
          "failure",
          "device",
          "paste",
          "slow",
        ]);
        expect(
          calls.filter((call) => call.step === "status" && call.method === "slow"),
        ).toHaveLength(1);
        expect(
          (yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${orphan.id}`)).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)).status,
        ).toBe(200);
        expect(
          (yield* backend.calls).filter((call) => call.step === "remove").length,
        ).toBeGreaterThan(calls.filter((call) => call.step === "remove").length);
      }),
    ),
  );
});
