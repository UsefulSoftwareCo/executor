/** A real interactive account with a linked backend, shared by focused status regressions. */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { serverControl } from "./server-control.ts";
import { App, Resource } from "./contracts.ts";
import { appsManifest } from "./apps-release.ts";
import { interactiveAccountBackend, interactiveBackendKey } from "./interactive-account-backend.ts";
import { accountStatusBackend } from "./account-status-fixture.ts";

export const statusAccount = (
  source: (connect: string, check: string) => string,
  fields: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const backend = yield* interactiveAccountBackend,
      statusBackend = yield* accountStatusBackend;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const files = (content: string) => [{ path: "index.ts", content }, appsManifest];
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: "Status regression fixture",
      files: files(source(backend.origin, statusBackend.origin)),
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed),
      path = `${prefix}/apps/${app.id}`;
    const saved: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* serverControl("start");
        yield* api.request(actors.owner, "DELETE", path);
        for (const id of saved)
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
      }).pipe(Effect.orDie),
    );
    const pending = (scope: string, slot: string) =>
      api
        .request(actors.owner, "POST", `${path}/accounts/${scope}/${slot}/connections`, {})
        .pipe(Effect.flatMap((r) => body(Resource, r)));
    const key = yield* pending("app", "backend");
    const added = yield* api.request(
      actors.owner,
      "POST",
      `${prefix}/connections/${key.id}/submit`,
      {
        method: "key",
        fields: { token: interactiveBackendKey, short: "xy", ...fields },
      },
    );
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    saved.push((yield* body(Resource, added)).id);
    const connection = yield* pending("user", "identity"),
      steps = `${prefix}/connections/${connection.id}/interactive`;
    expect(
      (yield* api.request(actors.owner, "POST", `${steps}/start`, { method: "device" })).status,
    ).toBe(200);
    yield* api.request(actors.owner, "GET", `${steps}/status`);
    const result = yield* api.request(actors.owner, "GET", `${steps}/status`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const connected = yield* body(
      Schema.Struct({ state: Schema.Literal("connected"), account: Resource }),
      result,
    );
    saved.push(connected.account.id);
    const account = connected.account.id,
      accountPath = `${prefix}/accounts/${account}`;
    const check = () => api.request(actors.owner, "POST", `${accountPath}/health`);
    return {
      account,
      app: app.id,
      statusBackend,
      check,
      read: () => api.request(actors.owner, "GET", accountPath),
      deploy: (content: string) =>
        api.request(actors.owner, "POST", `${path}/deploy`, { files: files(content) }),
      connectOrigin: backend.origin,
      checkOrigin: statusBackend.origin,
    };
  });
