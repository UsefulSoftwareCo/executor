/**
 * A new Cloud team's Executor app is installed by the write request that dispatched its setup,
 * right after the team's durable workflow exists. The workflow runs the same job as well: it
 * waits for a fresh claim, finishes an attempt the request could not, and finds a finished job
 * done. Locally the workflow starts at once and often claims first, so both attempts then run
 * together; whatever the order, the team ends with one Executor app and one default profile per
 * manager.
 */
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
        // Fixture setup ends with ordinary write requests; nothing else starts the installation.
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
        // Each manager gets exactly one default profile on that app.
        for (const manager of [actors.owner, actors.admin])
          expect((yield* managementApp(manager)).app.id).toBe(app.id);
      }),
    ),
  );
});
