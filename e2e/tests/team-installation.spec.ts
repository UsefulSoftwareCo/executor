import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory } from "../support/contracts.ts";
import { managementApp } from "../support/management-app.ts";

const Directory = Schema.Struct({ pendingApp: Schema.Boolean });

layer(HostedLive, { excludeTestServices: true })("Team installation", (it) => {
  it.effect(scenarios.teamInstallationFromRequest.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const { app } = yield* managementApp(actors.owner);
        const directory = yield* body(
          Directory,
          yield* api.request(actors.owner, "GET", `/api/organizations/${organization}/resources`),
        );
        expect(directory.pendingApp).toBe(false);
        expect(app.name).toBe("Executor");
      }),
    ),
  );

  it.effect(scenarios.teamInstallationConcurrent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const { app } = yield* managementApp(actors.owner);
        const inventory = yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `/api/organizations/${organization}/inventory`),
        );
        expect(inventory.apps.filter((item) => item.name === "Executor")).toEqual([
          expect.objectContaining({ id: app.id }),
        ]);
        for (const manager of [actors.owner, actors.admin])
          expect((yield* managementApp(manager)).app.id).toBe(app.id);
      }),
    ),
  );
});
