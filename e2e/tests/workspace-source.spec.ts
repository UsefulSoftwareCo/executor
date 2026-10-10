/** Source snapshots and optimistic writes are verified through the real hosted API. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Committed, Workspace } from "../support/app-authoring.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";

const App = Schema.Struct({ id: Schema.String, repository: Schema.NullOr(Schema.String) });
const files = (value: string) => [
  { path: "index.ts", content: `export default ${JSON.stringify(value)};` },
  { path: "nested/deep/value.json", content: JSON.stringify({ value }) },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("Workspace source", (it) => {
  it.effect(scenarios.workspaceSource.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const create = (label: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", prefix, {
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
        const path = yield* create("snapshot");
        const initial = yield* read(path);
        expect(initial.files).toEqual(files("initial"));
        expect(initial.revision.commit).toMatch(/^[a-f0-9]{40}$/);
        // Preparation is asynchronous; later reads return the same snapshot.
        expect(yield* read(path)).toEqual(initial);
        expect(yield* read(path)).toEqual(initial);

        const writers = ["first writer", "second writer", "third writer", "fourth writer"];
        let winner = initial;
        for (let round = 0; round < 3; round += 1) {
          const previous = winner;
          const writes = yield* Effect.forEach(
            writers,
            (value) =>
              api.request(actors.owner, "POST", `${path}/commits`, {
                expected: previous.revision.commit,
                files: files(`${value} ${round}`),
                message: `${value} ${round}`,
              }),
            { concurrency: 4 },
          );
          expect(writes.map((response) => response.status).sort()).toEqual([200, 409, 409, 409]);
          const accepted = writes.findIndex((response) => response.status === 200);
          const response = writes[accepted];
          if (response === undefined)
            return yield* Effect.fail(new Error("No source write succeeded"));
          const { revision } = yield* body(Committed, response);
          expect(revision.commit).not.toBe(previous.revision.commit);
          winner = { revision, files: files(`${writers[accepted]} ${round}`) };
          expect(yield* read(path)).toEqual(winner);
        }
        const history = yield* api.request(actors.owner, "GET", `${path}/history`);
        expect(history.status).toBe(200);
        expect(
          yield* body(Schema.Array(Schema.Struct({ commit: Schema.String })), history),
        ).toHaveLength(4);

        const keyResponse = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Git source verification",
        });
        expect(keyResponse.status).toBe(200);
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          keyResponse,
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const git = yield* body(
          Schema.Struct({ path: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/git`),
        );
        const http = yield* HttpClient.HttpClient;
        for (const service of ["git-upload-pack", "git-receive-pack"])
          yield* Effect.scoped(
            Effect.gen(function* () {
              const response = yield* http.execute(
                HttpClientRequest.get(
                  `${target.metadata.origin}${git.path}/info/refs?service=${service}`,
                ).pipe(HttpClientRequest.bearerToken(key.key)),
              );
              expect(response.status).toBe(200);
              expect(yield* response.text).toContain(winner.revision.commit);
            }),
          );

        // Exercise the native Git proxy's POST body and read its response after headers return.
        const want = `want ${winner.revision.commit}\n`;
        const upload = yield* http.execute(
          HttpClientRequest.post(`${target.metadata.origin}${git.path}/git-upload-pack`).pipe(
            HttpClientRequest.bearerToken(key.key),
            HttpClientRequest.bodyText(
              `${(want.length + 4).toString(16).padStart(4, "0")}${want}00000009done\n`,
              "application/x-git-upload-pack-request",
            ),
          ),
        );
        expect(upload.status).toBe(200);
        const pack = new Uint8Array(yield* upload.arrayBuffer);
        expect(new TextDecoder().decode(pack.subarray(0, 12))).toBe("0008NAK\nPACK");

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
