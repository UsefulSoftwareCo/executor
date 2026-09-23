/** Source snapshots and optimistic writes are verified through the real hosted API and delivered traces. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
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
  { path: "nested/deep/value.json", content: JSON.stringify({ value }) },
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
        const trace = (
          label: string,
          reuse = false,
          received?: {
            readonly traceId: string;
            readonly method: string;
            readonly completedSpan?: string;
          },
        ) =>
          Effect.gen(function* () {
            const request = received ?? (yield* evidence.requests).at(-1);
            if (request === undefined)
              return yield* Effect.fail(new Error("Missing request evidence"));
            const result = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) =>
                result.data.some(
                  ({ span }) =>
                    span.operationName ===
                    (received?.completedSpan ?? `http.server ${request.method}`),
                ) &&
                (target.metadata.target !== "cloud" ||
                  result.data.some(
                    ({ span }) =>
                      span.operationName ===
                      (reuse ? "source.repository.token.acquire" : "source.repository.initialize"),
                  ))
                  ? Effect.succeed(result)
                  : Effect.fail(new Error("Missing completed workspace request trace")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
              Effect.tapError(() =>
                telemetry.query(request.traceId).pipe(
                  Effect.flatMap((result) =>
                    evidence.json(`${label}-incomplete-trace.json`, {
                      traceId: request.traceId,
                      ...result,
                    }),
                  ),
                  Effect.ignore,
                ),
              ),
            );
            yield* evidence.json(`${label}-trace.json`, result);
            if (reuse && target.metadata.target === "cloud") {
              const acquisitions = result.data.filter(
                ({ span }) => span.operationName === "source.repository.token.acquire",
              );
              expect(acquisitions).toHaveLength(1);
              expect(acquisitions[0]?.span.tags["source.token.reused"]).toBe("true");
              expect(
                result.data.some(({ span }) => span.operationName === "source.repository.token"),
              ).toBe(false);
              expect(
                result.data.some(({ span }) => span.operationName === "source.repository.open"),
              ).toBe(false);
            }
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

        // Preparation is asynchronous. Complete one acquisition before asserting warm reuse.
        expect(yield* read(path)).toEqual(initial);
        expect(yield* read(path)).toEqual(initial);
        const existing = yield* trace("existing", true);
        expect(existing.filter((name) => name === "source.workspace.read")).toHaveLength(1);
        expect(existing).not.toContain("source.initial.read");
        expect(existing).not.toContain("source.git.refs");
        if (target.metadata.target === "cloud") {
          expect(existing.filter((operation) => operation === "source.git.clone")).toHaveLength(1);
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
          const saved = yield* trace(`saved-${round}`, true);
          expect(saved).not.toContain("source.repository.create");
          const accepted = writes.find((response) => response.status === 200);
          if (accepted === undefined)
            return yield* Effect.fail(new Error("No source write succeeded"));
          winner = yield* body(Workspace, accepted);
          expect(winner.revision.commit).not.toBe(previous.revision.commit);
          expect(yield* read(path)).toEqual(winner);
        }
        const history = yield* api.request(actors.owner, "GET", `${path}/history`);
        expect(history.status).toBe(200);
        expect(
          yield* body(Schema.Array(Schema.Struct({ commit: Schema.String })), history),
        ).toHaveLength(4);
        yield* trace("history", true);

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
        for (const service of ["git-upload-pack", "git-receive-pack"]) {
          const traceId = randomUUID().replaceAll("-", "");
          const spanId = randomUUID().replaceAll("-", "").slice(0, 16);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const response = yield* http.execute(
                HttpClientRequest.get(
                  `${target.metadata.origin}${git.path}/info/refs?service=${service}`,
                ).pipe(
                  HttpClientRequest.bearerToken(key.key),
                  HttpClientRequest.setHeader("traceparent", `00-${traceId}-${spanId}-01`),
                ),
              );
              expect(response.status).toBe(200);
              expect(yield* response.text).toContain(winner.revision.commit);
            }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
          );
          if (target.metadata.target === "cloud")
            // The streamed proxy body has completed above. Its coordinator span is the credential boundary.
            yield* trace(`proxy-${service}`, true, {
              traceId,
              method: "GET",
              completedSpan: "source.repository.credentials",
            });
        }

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
