/** A local, synthetic service proves account-dependent catalogs without a database. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { nodeRuntime, filesystemBlobStore } from "@executor-js/sdk/node";
import { AccountId, createAppRuntime } from "@executor-js/sdk";
import type { ResolvedAccountsInput } from "apps/contracts";

/** Build once, use two account contexts, refresh the catalog, and reload retained output. */
export async function runtimeWalkthrough(directory: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      let revision = 1;
      const server = yield* HttpServer.HttpServer;
      yield* server.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const token = request.headers.authorization;
          if (token !== "Bearer fixture-a" && token !== "Bearer fixture-b") {
            return yield* HttpServerResponse.json(
              { error: "Unknown fixture account" },
              { status: 401 },
            );
          }
          const first = token === "Bearer fixture-a";
          return yield* HttpServerResponse.json({
            names: [first ? `alpha${revision}` : "beta"],
            label: first ? "A" : "B",
          });
        }),
      );
      const address = server.address;
      if (address._tag === "UnixPathAddress")
        return yield* Effect.fail(new Error("Fixture did not listen on TCP"));
      const endpoint = `http://127.0.0.1:${address.port}`;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* path.fromFileUrl(
        new URL("./fixtures/runtime-app.ts", import.meta.url),
      );
      const source = yield* fs.readFileString(fixture);
      // The walkthrough uses the public Promise API; Effect owns the local server.
      return yield* Effect.promise(async () => {
        const blobs = filesystemBlobStore({ directory: `${directory}/blobs` });
        const runtime = createAppRuntime({
          runtime: nodeRuntime({ workDirectory: `${directory}/cache` }),
          blobs,
        });
        const built = await runtime.build({
          files: [
            {
              path: "index.ts",
              content: source,
            },
          ],
        });
        const declaration = built.requirements.accounts.service;
        if (declaration === undefined) throw new Error("Fixture declaration missing");
        const accounts = (suffix: string): ResolvedAccountsInput => ({
          service: {
            id: AccountId.make(`acc_${suffix}`),
            provider: declaration.definition,
            method: "apiKey",
            fields: { endpoint, token: `fixture-${suffix}` },
          },
          extras: [],
        });
        const first = accounts("a");
        const second = accounts("b");
        const firstCatalog = await runtime.inspect({
          app: "synthetic-app",
          build: built.build,
          accounts: first,
        });
        const secondCatalog = await runtime.inspect({
          app: "synthetic-app",
          build: built.build,
          accounts: second,
        });
        const firstResult = await runtime.call({
          app: "synthetic-app",
          build: built.build,
          database: built.requirements.database !== undefined,
          accounts: first,
          tool: "queries.alpha1",
          input: {},
        });
        const secondResult = await runtime.call({
          app: "synthetic-app",
          build: built.build,
          database: built.requirements.database !== undefined,
          accounts: second,
          tool: "queries.beta",
          input: { count: 3 },
        });
        revision = 2;
        const refreshedCatalog = await runtime.inspect({
          app: "synthetic-app",
          build: built.build,
          accounts: first,
        });
        const reloaded = createAppRuntime({
          runtime: nodeRuntime({ workDirectory: `${directory}/second-cache` }),
          blobs,
        });
        const reloadedResult = await reloaded.call({
          app: "synthetic-app",
          build: built.build,
          database: built.requirements.database !== undefined,
          accounts: first,
          tool: "queries.alpha2",
          input: {},
        });
        const nodeResult = await reloaded.call({
          app: "synthetic-app",
          build: built.build,
          database: built.requirements.database !== undefined,
          accounts: first,
          tool: "queries.node",
          input: {},
        });
        return {
          build: built.build,
          firstCatalog,
          secondCatalog,
          firstResult,
          secondResult,
          refreshedCatalog,
          reloadedResult,
          nodeResult,
        };
      });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeHttpServer.layerTest),
      Effect.scoped,
    ),
  );
}
