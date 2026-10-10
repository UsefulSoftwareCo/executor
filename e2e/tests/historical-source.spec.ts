/** Deploy a small older snapshot after unrelated source has grown. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Committed, Workspace } from "../support/app-authoring.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appsManifest } from "../support/apps-release.ts";

const files = [
  {
    path: "index.ts",
    content: `import {defineApp,object,query, router} from 'apps'; export default defineApp({accounts:{}},{tools: router({
  hello:query({input:object({})},async()=>"historical snapshot"),
})});`,
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("Historical source", (it) => {
  it.effect(scenarios.historicalSource.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const created = yield* api.request(actors.owner, "POST", prefix, {
          name: `Historical source ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(created.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), created);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const read = () =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "GET", `${path}/workspace`);
            expect(response.status).toBe(200);
            return yield* body(Workspace, response);
          });
        const initial = yield* read();
        let current = initial;
        for (let revision = 0; revision < 2; revision += 1) {
          // Workspace reads list files by path, so the saved list keeps that order.
          const later = [
            ...files,
            { path: "later.txt", content: randomBytes(256 * 1024).toString("base64") },
          ].toSorted((a, b) => a.path.localeCompare(b.path));
          const response = yield* api.request(actors.owner, "POST", `${path}/commits`, {
            expected: current.revision.commit,
            files: later,
            message: `Later revision ${revision}`,
          });
          expect(response.status).toBe(200);
          current = { revision: (yield* body(Committed, response)).revision, files: later };
        }
        expect(current.revision.commit).not.toBe(initial.revision.commit);
        const deployed = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          commit: initial.revision.commit,
        });
        expect(deployed.status).toBe(200);
        const source = yield* api.request(actors.owner, "GET", `${path}/source`);
        expect(source.status).toBe(200);
        const retained = yield* body(
          Schema.Struct({ sourceCommit: Schema.String, files: Workspace.fields.files }),
          source,
        );
        expect(retained.sourceCommit).toBe(initial.revision.commit);
        expect(retained.files).toEqual(files);
        expect(yield* read()).toEqual(current);
        const invalid = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          commit: "f".repeat(40),
        });
        expect(invalid.status).toBe(503);
        const afterFailure = yield* api.request(actors.owner, "GET", `${path}/source`);
        expect(afterFailure.status).toBe(200);
        expect(
          (yield* body(Schema.Struct({ files: Workspace.fields.files }), afterFailure)).files,
        ).toEqual(files);
      }),
    ),
  );
});
