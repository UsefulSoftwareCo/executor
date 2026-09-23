/** Source snapshots and optimistic writes are verified through the real hosted API and delivered traces. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Workspace } from "../support/app-authoring.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const App = Schema.Struct({ id: Schema.String, repository: Schema.NullOr(Schema.String) });
const files = (value: string) => [
  { path: "index.ts", content: `export default ${JSON.stringify(value)};` },
];

layer(HostedLive, { excludeTestServices: true })("Workspace source", (it) => {
  it.effect(scenarios.workspaceSource.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const create = (label: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/drafts`, {
              name: `Source ${label} ${randomUUID().slice(0, 8)}`,
              files: files("initial"),
            });
            expect(response.status).toBe(200);
            const app = yield* body(App, response);
            expect(app.repository).toBeNull();
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return `${prefix}/${app.id}`;
          });
        const read = (path: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "GET", `${path}/workspace`);
            expect(response.status).toBe(200);
            return yield* body(Workspace, response);
          });
        const trace = (label: string) =>
          Effect.gen(function* () {
            const request = (yield* evidence.requests).at(-1);
            if (request === undefined)
              return yield* Effect.fail(new Error("Missing request evidence"));
            const result = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) =>
                result.data.some(
                  ({ span }) => span.operationName === `http.server ${request.method}`,
                )
                  ? Effect.succeed(result)
                  : Effect.fail(new Error("Missing completed workspace request trace")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
            );
            yield* evidence.json(`${label}-trace.json`, result);
            return result.data.map(({ span }) => span.operationName);
          });

        const path = yield* create("snapshot");
        const initial = yield* read(path);
        expect(initial.files).toEqual(files("initial"));
        expect(initial.revision.commit).toMatch(/^[a-f0-9]{40}$/);
        const initialized = yield* trace("initialized");
        expect(initialized.filter((name) => name === "source.initial.read")).toHaveLength(1);
        expect(initialized.filter((name) => name === "apps.repository.initialize")).toHaveLength(1);
        expect(initialized).not.toContain("source.workspace.read");
        if (target.metadata.target === "cloud") {
          expect(initialized.filter((name) => name === "source.repository.create")).toHaveLength(1);
          expect(
            initialized.filter((name) => name === "source.repository.initial-token.read"),
          ).toHaveLength(1);
          expect(initialized).not.toContain("source.repository.open");
          expect(initialized).not.toContain("source.repository.token");
        }

        expect(yield* read(path)).toEqual(initial);
        const existing = yield* trace("existing");
        expect(existing.filter((name) => name === "source.workspace.read")).toHaveLength(1);
        expect(existing).not.toContain("source.initial.read");
        expect(existing).not.toContain("source.git.refs");
        if (target.metadata.target === "cloud") {
          for (const name of [
            "source.repository.open",
            "source.repository.token",
            "source.git.clone",
          ])
            expect(
              existing.filter((operation) => operation === name),
              name,
            ).toHaveLength(1);
        }

        let winner = initial;
        for (let round = 0; round < 3; round += 1) {
          const previous = winner;
          const writes = yield* Effect.forEach(
            ["first writer", "second writer", "third writer", "fourth writer"],
            (value) =>
              api.request(actors.owner, "POST", `${path}/commits`, {
                expected: previous.revision.commit,
                files: files(`${value} ${round}`),
                message: `${value} ${round}`,
              }),
            { concurrency: 4 },
          );
          expect(writes.map((response) => response.status).sort()).toEqual([200, 409, 409, 409]);
          const saved = yield* trace(`saved-${round}`);
          expect(saved).not.toContain("source.repository.create");
          const accepted = writes.find((response) => response.status === 200);
          if (accepted === undefined)
            return yield* Effect.fail(new Error("No source write succeeded"));
          winner = yield* body(Workspace, accepted);
          expect(winner.revision.commit).not.toBe(previous.revision.commit);
          expect(yield* read(path)).toEqual(winner);
        }
        const stale = yield* api.request(actors.owner, "POST", `${path}/commits`, {
          expected: initial.revision.commit,
          files: files("stale write"),
          message: "Stale write",
        });
        expect(stale.status).toBe(409);
        expect(yield* read(path)).toEqual(winner);

        const pending = yield* create("concurrent initialization");
        const snapshots = yield* Effect.forEach([0, 1, 2], () => read(pending), { concurrency: 3 });
        const current = yield* read(pending);
        expect(current.files).toEqual(files("initial"));
        for (const snapshot of snapshots) expect(snapshot).toEqual(current);
      }),
    ),
  );
});
