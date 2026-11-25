import { createServer } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const account = "0123456789abcdef0123456789abcdef";
const worker = "executor-next-hosted-api-test-e2e-gone-aaaaaaaaaaaaaaaa";
const secret = {
  resourceType: "Alchemy.Random",
  attr: { text: { __redacted__: "control-secret" } },
};

interface World {
  readonly workerExists: boolean;
  readonly requests: string[];
}

const standIn = (world: World) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly origin: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          const path = new URL(request.url ?? "/", "http://stand-in").pathname;
          world.requests.push(`${request.method} ${path}`);
          if (path === `/client/v4/accounts/${account}/workers/scripts/${worker}/content/v2`) {
            response.writeHead(world.workerExists ? 200 : 404, {
              "content-type": "application/json",
            });
            response.end(JSON.stringify({ success: world.workerExists }));
            return;
          }
          if (path === "/api/internal/app-domains/drain" && request.method === "POST") {
            const drains = request.headers.authorization === "Bearer control-secret";
            response.writeHead(drains ? 204 : 401);
            response.end();
            return;
          }
          response.writeHead(404);
          response.end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, close: () => server.close() }));
      });
    }),
    (server) => Effect.sync(server.close),
  );

const deleteDomains = (
  world: World,
  { stage = "test-e2e-gone", records }: { readonly stage?: string; readonly records: object },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const server = yield* standIn(world);
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-domain-cleanup-" });
    const recordsFile = path.join(directory, "records.json");
    const oldsFile = path.join(directory, "olds.json");
    yield* fs.writeFileString(recordsFile, JSON.stringify(records));
    yield* fs.writeFileString(
      oldsFile,
      JSON.stringify({
        origin: server.origin,
        workerName: worker,
        deployment: { assets: "a", bundle: "b", metadata: "c" },
        controller: { bundle: "d", metadata: "e" },
      }),
    );
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/cloud/scripts/test-stage-domain-cleanup.ts",
          "--stage",
          stage,
          "--records",
          recordsFile,
          "--olds",
          oldsFile,
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            CLOUDFLARE_ACCOUNT_ID: account,
            CLOUDFLARE_API_TOKEN: "cloudflare-token",
            TEST_STAGE_CLOUDFLARE_API: server.origin,
          },
        },
      ),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stdout, output: `${stdout}\n${stderr}` };
  }).pipe(Effect.scoped);

const workerRead = `GET /client/v4/accounts/${account}/workers/scripts/${worker}/content/v2`;
const drain = "POST /api/internal/app-domains/drain";

describe("Test-stage cleanup of a stage's app domains", () => {
  it.live(
    "forgets the record when the API Worker is gone and no control secret is recorded",
    () =>
      Effect.gen(function* () {
        const world: World = { workerExists: false, requests: [] };
        const result = yield* deleteDomains(world, { records: {} });
        expect(result.code, result.output).toBe(0);
        expect(result.stdout).toContain(
          `test-e2e-gone: its API Worker ${worker} is gone and no app domain control secret is recorded, so nothing can answer a drain. Forgetting its app domain lifecycle record.`,
        );
        expect(world.requests).toEqual([workerRead]);
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.live(
    "drains when the control secret is recorded, without reading the Worker",
    () =>
      Effect.gen(function* () {
        const world: World = { workerExists: false, requests: [] };
        const result = yield* deleteDomains(world, { records: { AppDomainControlSecret: secret } });
        expect(result.code, result.output).toBe(0);
        expect(result.stdout).not.toContain("Forgetting");
        expect(world.requests).toEqual([drain]);
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.live(
    "still fails, without draining, when the Worker is uploaded but no control secret is recorded",
    () =>
      Effect.gen(function* () {
        const world: World = { workerExists: true, requests: [] };
        const result = yield* deleteDomains(world, { records: {} });
        expect(result.code).toBe(1);
        expect(result.output).toContain("Deletion failed");
        expect(result.output).not.toContain("Forgetting");
        expect(world.requests).toEqual([workerRead]);
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.live(
    "never skips the drain outside a test stage",
    () =>
      Effect.gen(function* () {
        const world: World = { workerExists: false, requests: [] };
        const result = yield* deleteDomains(world, { stage: "v2", records: {} });
        expect(result.code).toBe(1);
        expect(result.output).not.toContain("Forgetting");
        expect(world.requests).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});
