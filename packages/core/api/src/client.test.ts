import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeExecutorApiClient } from "@executor-js/api/client";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("makeExecutorApiClient", () => {
  it.effect("calls the typed Executor API at the configured remote with explicit headers", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (captured) => [...captured, request]);
          return HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson([]), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      const client = yield* makeExecutorApiClient({
        baseUrl: "https://executor.example/api",
        headers: { authorization: "Bearer service-token" },
        transformClient: HttpClient.mapRequest((request) =>
          HttpClientRequest.setHeader(request, "x-executor-org", "acme"),
        ),
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(httpClient)));

      const integrations = yield* client.integrations.list();
      const [captured] = yield* Ref.get(requests);

      expect(integrations).toEqual([]);
      expect(captured).toMatchObject({
        method: "GET",
        url: "https://executor.example/api/integrations",
        headers: {
          authorization: "Bearer service-token",
          "x-executor-org": "acme",
        },
      });
    }),
  );

  it.effect("declares a public client boundary with no private runtime dependencies", () =>
    Effect.gen(function* () {
      const [source, changesetsSource] = yield* Effect.all([
        Effect.promise(() => readFile(new URL("../package.json", import.meta.url), "utf8")),
        Effect.promise(() =>
          readFile(new URL("../../../../.changeset/config.json", import.meta.url), "utf8"),
        ),
      ]);
      const manifest = decodeJson(source) as {
        readonly private?: boolean;
        readonly license?: string;
        readonly files?: ReadonlyArray<string>;
        readonly scripts?: Readonly<Record<string, string>>;
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
        readonly optionalDependencies?: Readonly<Record<string, string>>;
        readonly peerDependencies?: Readonly<Record<string, string>>;
        readonly publishConfig?: {
          readonly access?: string;
          readonly exports?: Readonly<Record<string, unknown>>;
        };
      };
      const changesets = decodeJson(changesetsSource) as {
        readonly ignore?: ReadonlyArray<string>;
      };

      expect(manifest).toMatchObject({
        license: "MIT",
        files: ["dist"],
        scripts: { build: "tsup" },
        peerDependencies: { effect: "catalog:" },
        publishConfig: {
          access: "public",
          exports: {
            "./client": {
              import: {
                types: "./dist/client.d.ts",
                default: "./dist/client.js",
              },
            },
          },
        },
      });
      expect(manifest.dependencies).toEqual({ "@executor-js/sdk": "workspace:*" });
      expect(manifest.devDependencies).toMatchObject({
        "@executor-js/execution": "workspace:*",
        "@executor-js/host-mcp": "workspace:*",
      });
      const publishableDependencies = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ];
      expect(publishableDependencies.filter((name) => changesets.ignore?.includes(name))).toEqual(
        [],
      );
      expect(manifest.private).not.toBe(true);
    }),
  );
});
