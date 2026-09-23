import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import { randomBytes } from "node:crypto";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { createScenario, populations, seedOrganization } from "../sdk/index.ts";
import { scenarios } from "../test-plan.ts";

const Summary = Schema.Struct({
  count: Schema.Number,
  open: Schema.Number,
  closed: Schema.Number,
  keys: Schema.Array(Schema.String),
});
layer(HostedLive, { excludeTestServices: true })("Testing SDK", (it) => {
  it.effect(scenarios.testingSdk.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence;
        const child = yield* Scope.fork(yield* Effect.scope);
        const other = yield* createScenario(target, {
          id: randomBytes(16).toString("hex"),
          label: "Overlapping organization",
        }).pipe(Scope.provide(child));
        if (other.actors === undefined)
          return yield* Effect.die(new Error("Hosted scenario requires actors"));
        expect(other.actors.organization.id).not.toBe(actors.organization.id);
        const [first, second] = yield* Effect.all(
          [
            seedOrganization(populations.populated),
            other.seed({ seed: 42, apps: 2, accounts: 4, records: 20 }).pipe(Scope.provide(child)),
          ],
          { concurrency: 2 },
        );
        const app = first.apps[0],
          otherApp = second.apps[0];
        if (app === undefined || otherApp === undefined)
          return yield* Effect.die(new Error("Missing seeded apps"));
        expect(app.name).toBe(otherApp.name);
        expect(app.id).not.toBe(otherApp.id);
        expect(first.accounts).toHaveLength(32);
        const call = (tool: string) =>
          api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/apps/${app.id}/tools/call`,
            { tool, profile: app.profile, input: {} },
          );
        const rows = yield* body(Summary, yield* call("queries.summary"));
        expect(rows.count).toBe(1000);
        expect(rows.open).toBe(800);
        expect(rows.closed).toBe(200);
        expect(new Set(rows.keys).size).toBe(1000);
        expect(
          yield* body(
            Schema.Struct({ name: Schema.String, private: Schema.Boolean, owner: Schema.String }),
            yield* call("queries.repository"),
          ),
        ).toEqual({ name: "operations", private: true, owner: "scenario-42" });
        // An actor may never read another scenario's organization, even on the shared deployment.
        const foreign = yield* api.request(
          actors.member,
          "GET",
          `/api/organizations/${other.actors.organization.id}/apps`,
        );
        expect([403, 404]).toContain(foreign.status);
        const secondRows = yield* body(
          Summary,
          yield* other.api.request(
            other.actors.owner,
            "POST",
            `/api/organizations/${other.actors.organization.id}/apps/${otherApp.id}/tools/call`,
            { tool: "queries.summary", profile: otherApp.profile, input: {} },
          ),
        );
        expect(secondRows.count).toBe(20);
        // A failed scenario must release its resources without touching the survivor.
        yield* Scope.close(child, Exit.fail(new Error("Deliberate scenario failure")));
        expect((yield* body(Summary, yield* call("queries.summary"))).count).toBe(1000);
        if (target.metadata.target === "cloud") {
          expect([403, 404]).toContain(
            (yield* api.request(
              actors.owner,
              "GET",
              `/api/organizations/${other.actors.organization.id}/access`,
            )).status,
          );
        }
        yield* evidence.json("population.json", first);
        yield* evidence.json("isolation.json", {
          first: actors.organization.id,
          second: other.actors.organization.id,
          sameResourceName: app.name,
          firstRecords: 1000,
          secondRecords: 20,
          survivorAfterFailure: true,
        });
      }),
    ),
  );
});
