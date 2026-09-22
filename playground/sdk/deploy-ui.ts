/** Deploy the local React example through the same public HTTP contract used by agents. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ExecutorApi, OwnerId, SourceFiles } from "@executor-js/sdk";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../demo-apps/live-inbox/", import.meta.url));
    const files = yield* Effect.forEach(
      [
        "index.ts",
        "schema.ts",
        "ui/index.html",
        "ui/main.tsx",
        "ui/style.css",
        "skills/inbox/SKILL.md",
        "skills/inbox/references/examples.md",
      ],
      (file) =>
        fs
          .readFileString(path.join(root, file))
          .pipe(Effect.map((content) => ({ path: file, content }))),
    );
    const manifest = yield* fs
      .readFileString(path.join(root, "package.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
            ),
          ),
        ),
      );
    files.push({
      path: "package.json",
      content: JSON.stringify({
        dependencies: Object.fromEntries(
          Object.entries(manifest.dependencies).filter(([name]) => name !== "apps"),
        ),
      }),
    });
    const port = yield* Config.Number("EXECUTOR_PORT").pipe(Config.withDefault(4312));
    const key = yield* Config.Redacted("EXECUTOR_API_KEY");
    const client = yield* HttpApiClient.make(ExecutorApi, {
      baseUrl: `http://127.0.0.1:${port}`,
      transformClient: (http) =>
        http.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(key))),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    const result = yield* client.apps.deploy({
      payload: {
        owner: OwnerId.make("local"),
        name: "Live inbox",
        files: yield* Schema.decodeUnknownEffect(SourceFiles)(files),
      },
    });
    yield* Console.log(`http://${result.app.id.replace(/^app_/, "app-")}.localhost:${port}`);
  }).pipe(Effect.provide(NodeServices.layer)),
);
