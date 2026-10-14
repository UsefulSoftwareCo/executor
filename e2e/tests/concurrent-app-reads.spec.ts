/**
 * Requests that arrive together for one app share its evaluation and its runner, yet each one
 * finishes with its own I/O. On Workers, a request resumed inside another request's handler fails
 * with "Cannot perform I/O on behalf of a different request".
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String });
const Index = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
/** Readers that arrive while the first one's evaluation runs, and so join it. */
const readers = 6;

layer(HostedLive, { excludeTestServices: true })("Concurrent app reads", (it) => {
  it.effect(scenarios.concurrentAppReads.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // The factory takes long enough that every reader arrives while it runs.
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Slow catalog",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return {
    tools: router({
      echo: query(
        { description: "Echo a message", input: object({ message: string() }) },
        async (_, { message }) => message,
      ),
    }),
  };
});`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const root = `${prefix}/apps/${app.id}/tools`;

        const indexes = yield* Effect.forEach(
          Array.from({ length: readers }, (_, reader) => reader),
          () => api.request(actors.owner, "GET", `${root}/index`),
          { concurrency: "unbounded" },
        );
        for (const index of indexes) {
          expect(index.status, JSON.stringify(index.body)).toBe(200);
          expect((yield* body(Index, index)).items.map((tool) => tool.name)).toEqual(["echo"]);
        }

        const calls = yield* Effect.forEach(
          Array.from({ length: readers }, (_, reader) => reader),
          (reader) =>
            api.request(actors.owner, "POST", `${root}/call`, {
              tool: "echo",
              kind: "query",
              input: { message: `reader ${reader}` },
            }),
          { concurrency: "unbounded" },
        );
        expect(calls.map((call) => [call.status, call.body])).toEqual(
          Array.from({ length: readers }, (_, reader) => [200, `reader ${reader}`]),
        );
      }),
    ),
  );
});
