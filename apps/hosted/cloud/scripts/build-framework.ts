/** Package the local app framework for the Worker bundler; no npm publication is required. */
import { build } from "esbuild";
import { generateFrameworkReference } from "../../../../packages/apps/scripts/reference.mjs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, FileSystem, Path } from "effect";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(new URL("../../../../", import.meta.url));
    for (const snapshot of [
      {
        name: "framework",
        entries: {
          index: "index",
          host: "host",
          "storage/facet": "facet",
          contracts: "contracts/host",
          mcp: "mcp",
          graphql: "graphql",
          openapi: "openapi",
          skills: "skills",
          "skills/effect": "implementation/skill-files",
          "operations/approval": "approval",
        },
        external: [],
      },
      {
        name: "browser-framework",
        entries: { index: "index", client: "client", effect: "effect", react: "react" },
        external: ["react", "react/*"],
      },
    ]) {
      const outdir = path.join(root, "apps/hosted/cloud/.generated", snapshot.name);
      const result = yield* Effect.tryPromise(() =>
        build({
          entryPoints: Object.fromEntries(
            Object.entries(snapshot.entries).map(([name, file]) => [
              name,
              path.join(root, `packages/apps/src/${file}.ts`),
            ]),
          ),
          outdir,
          bundle: true,
          splitting: true,
          format: "esm",
          platform: "browser",
          target: "es2022",
          minify: true,
          write: false,
          external: snapshot.external,
        }),
      );
      const files = Object.fromEntries(
        result.outputFiles.map((file) => [
          `node_modules/apps/${path.relative(outdir, file.path)}`,
          file.text,
        ]),
      );
      files["node_modules/apps/package.json"] = JSON.stringify({
        name: "apps",
        type: "module",
        exports: Object.fromEntries(
          Object.keys(snapshot.entries).map((name) => [
            name === "index" ? "." : `./${name}`,
            `./${name}.js`,
          ]),
        ),
      });
      yield* fs.makeDirectory(path.dirname(outdir), { recursive: true });
      yield* fs.writeFileString(
        path.join(path.dirname(outdir), `${snapshot.name}.json`),
        JSON.stringify(files),
      );
    }
    const directory = path.join(root, "packages/app-templates/executor/skills/app-authoring");
    const files = yield* Effect.forEach(
      (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".md")),
      (name) =>
        fs
          .readFileString(path.join(directory, name))
          .pipe(Effect.map((content) => [`skills/app-authoring/${name}`, content] as const)),
    );
    const reference = yield* Effect.promise(() => generateFrameworkReference());
    yield* fs.writeFileString(
      path.join(root, "apps/hosted/cloud/.generated/executor-authoring.json"),
      JSON.stringify({
        ...Object.fromEntries(files),
        "framework.ts": yield* fs.readFileString(path.join(directory, "../../framework.ts")),
        "framework-reference.json": JSON.stringify(reference),
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
