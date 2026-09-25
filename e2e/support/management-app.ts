/** Wait for the product's background provisioning through its public reads. */
import { Effect, Schedule, Schema } from "effect";
import { Actors } from "./actors.ts";
import { Api, SessionClients, body, type RequestFailed, type Session } from "./api.ts";
import { Inventory } from "./contracts.ts";
import { Profile } from "./profiles.ts";
import type { Response } from "./platform.ts";

export const managementApp = (actor: Session, organizationId?: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    return yield* waitForManagementApp(organizationId ?? actors.organization.id, (path) =>
      api.request(actor, "GET", path),
    );
  });

/** Await a synthetic actor's default profile inside the native setup deadline. */
export const prepareManagementApp = (actor: Session, organizationId: string) =>
  Effect.gen(function* () {
    const clients = yield* SessionClients;
    return yield* waitForManagementApp(organizationId, (path) =>
      clients.request(actor, "GET", path),
    );
  });

const waitForManagementApp = (
  organizationId: string,
  request: (path: string) => Effect.Effect<Response, RequestFailed>,
) =>
  Effect.gen(function* () {
    const root = `/api/organizations/${organizationId}`;
    return yield* Effect.gen(function* () {
      const inventory = yield* body(Inventory, yield* request(`${root}/inventory`));
      const app = inventory.apps.find((app) => app.slug === "executor");
      if (app === undefined)
        return yield* Effect.fail(new Error("Executor app provisioning is pending"));
      const profiles = yield* body(
        Schema.Array(Profile),
        yield* request(`${root}/apps/${app.id}/profiles`),
      );
      const profile = profiles[0];
      if (profiles.length !== 1 || profile === undefined)
        return yield* Effect.fail(new Error("Executor profile provisioning is pending"));
      return { app, profile };
    }).pipe(Effect.retry({ times: 40, schedule: Schedule.spaced("250 millis") }));
  });
