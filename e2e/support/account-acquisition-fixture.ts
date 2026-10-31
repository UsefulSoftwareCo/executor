import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "./actors.ts";
import { Api, body, type Session } from "./api.ts";
import { App, Resource } from "./contracts.ts";
import { appsManifest } from "./apps-release.ts";
import { acquisitionAppSource, acquisitionProduct } from "./acquisition-product.ts";
import { interactiveAccountBackend } from "./interactive-account-backend.ts";
import { serverControl } from "./server-control.ts";

const Deployed = Schema.Struct({
  ...App.fields,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const Revision = Schema.Struct({ revision: Schema.String });
const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Resource });

/** Hosted callers use the normal account routes against a complete registered product. */
export const acquisitionFixture = (hooks: { check?: boolean | "void" } = {}) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      backend = yield* interactiveAccountBackend;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const apps: string[] = [];
    const accounts: { id: string; actor: Session }[] = [];
    const trackAccount = (actor: Session, id: string) => accounts.push({ id, actor });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* serverControl("start");
        for (const app of apps) yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`);
        for (const account of accounts)
          yield* api.request(account.actor, "DELETE", `${prefix}/accounts/${account.id}`);
      }).pipe(Effect.orDie),
    );
    const deploy = (name: string) =>
      Effect.gen(function* () {
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [
            { path: "index.ts", content: acquisitionAppSource(backend.origin) },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(Deployed, response);
        apps.push(app.id);
        const path = `${prefix}/apps/${app.id}`;
        const access = yield* body(
          Revision,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        return { app, path };
      });
    const manager = yield* deploy("Reusable account manager");
    const provider = manager.app.requirements.accounts.identity!.provider;
    const configure = (
      options: {
        revision?: string;
        retained?: readonly string[];
        check?: boolean | "void";
      } = hooks,
    ) => acquisitionProduct({ provider, origin: backend.origin, ...options });
    yield* configure();
    const pending = (actor: Session, app = manager.app.id, account?: string) =>
      api.request(
        actor,
        "POST",
        `${prefix}/apps/${app}/accounts/user/identity/connections`,
        account === undefined ? {} : { account },
      );
    const connectPath = (id: string) => `${prefix}/connections/${id}/interactive`;
    const start = (actor: Session, id: string) =>
      api.request(actor, "POST", `${connectPath(id)}/start`, { method: "paste" });
    const submit = (actor: Session, id: string) =>
      api.request(actor, "POST", `${connectPath(id)}/submit`, {
        value: "http://localhost:48765/done?code=synthetic",
      });
    const create = (actor: Session, destination?: object) =>
      Effect.gen(function* () {
        const response = yield* api.request(
          actor,
          "POST",
          `${manager.path}/accounts/user/identity/connections`,
          destination === undefined ? {} : { destination },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const connection = (yield* body(Resource, response)).id;
        expect((yield* start(actor, connection)).status).toBe(200);
        const completed = yield* submit(actor, connection);
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const { account } = yield* body(Connected, completed);
        trackAccount(actor, account.id);
        expect(JSON.stringify(completed.body)).not.toContain("opaque-");
        expect(JSON.stringify(completed.body)).not.toContain("private-session-");
        return { account: account.id, connection };
      });
    return {
      api,
      actors,
      backend,
      prefix,
      manager,
      provider,
      configure,
      deploy,
      pending,
      connectPath,
      start,
      submit,
      create,
      trackAccount,
    };
  });
