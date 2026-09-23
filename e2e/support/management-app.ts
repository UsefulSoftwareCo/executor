/** Wait for the product's background provisioning through its public reads. */
import { Effect, Schedule, Schema } from "effect";
import { Actors } from "./actors.ts";
import { Api, body, type Session } from "./api.ts";
import { Inventory } from "./contracts.ts";
import { Profile } from "./profiles.ts";

export const managementApp = (actor: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    const root = `/api/organizations/${actors.organization.id}`;
    return yield* Effect.gen(function* () {
      const inventory = yield* body(
        Inventory,
        yield* api.request(actor, "GET", `${root}/inventory`),
      );
      const app = inventory.apps.find((app) => app.slug === "executor");
      if (app === undefined)
        return yield* Effect.fail(new Error("Executor app provisioning is pending"));
      const profiles = yield* body(
        Schema.Array(Profile),
        yield* api.request(actor, "GET", `${root}/apps/${app.id}/profiles`),
      );
      const profile = profiles[0];
      if (profiles.length !== 1 || profile === undefined)
        return yield* Effect.fail(new Error("Executor profile provisioning is pending"));
      return { app, profile };
    }).pipe(Effect.retry({ times: 40, schedule: Schedule.spaced("250 millis") }));
  });
