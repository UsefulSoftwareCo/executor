/** Bundle only trusted runtime/framework source on the host. Authored code compiles inside workerd. */
import { build } from "esbuild";
import { Effect, Path } from "effect";
import type { Module } from "@alchemy.run/cloudflare-runtime/core";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";

/** Build the isolated compiler's framework and the trusted Worker entry point for this installation. */
export const bundleWorkerdHost = Effect.gen(function* () {
  const path = yield* Path.Path;
  const directory = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const snapshot = (entries: Readonly<Record<string, string>>, external: string[]) =>
    Effect.gen(function* () {
      const outdir = path.join(directory, ".runtime-framework");
      const entryPoints = yield* Effect.forEach(Object.entries(entries), ([name, specifier]) =>
        path
          .fromFileUrl(new URL(import.meta.resolve(specifier)))
          .pipe(Effect.map((file) => [name, file] as const)),
      );
      const result = yield* Effect.tryPromise(() =>
        build({
          entryPoints: Object.fromEntries(entryPoints),
          outdir,
          bundle: true,
          splitting: true,
          format: "esm",
          platform: "browser",
          target: "es2022",
          minify: true,
          write: false,
          external,
        }),
      );
      return Object.fromEntries(
        result.outputFiles.map((file) => [
          `node_modules/apps/${path.relative(outdir, file.path).split(path.sep).join("/")}`,
          file.text,
        ]),
      );
    });
  const server = yield* snapshot(
    {
      index: "apps",
      host: "apps/host",
      "storage/facet": "apps/storage/facet",
      contracts: "apps/contracts",
      mcp: "apps/mcp",
      graphql: "apps/graphql",
      openapi: "apps/openapi",
      skills: "apps/skills",
      "skills/effect": "apps/skills/effect",
      "operations/approval": "apps/operations/approval",
    },
    [],
  );
  const browser = yield* snapshot(
    { index: "apps", client: "apps/client", effect: "apps/effect", react: "apps/react" },
    ["react", "react/*"],
  );
  const outdir = path.join(directory, ".runtime-host");
  const compiled = yield* Effect.tryPromise(() =>
    build({
      // esbuild resolves .js to .ts in a checkout; installed packages contain the emitted .js.
      entryPoints: { main: path.join(directory, "workerd-entry.js") },
      outdir,
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      target: "es2022",
      write: false,
      external: ["cloudflare:*", "executor-framework"],
      loader: { ".wasm": "copy" },
    }),
  );
  const modules: Module[] = compiled.outputFiles.map((file) => ({
    name: path.relative(outdir, file.path).split(path.sep).join("/"),
    ...(file.path.endsWith(".wasm")
      ? { type: "Wasm" as const, content: file.contents }
      : { type: "ESModule" as const, content: file.text }),
  }));
  modules.sort((a, b) =>
    a.name === "main.js" ? -1 : b.name === "main.js" ? 1 : a.name.localeCompare(b.name),
  );
  modules.push({
    name: "executor-framework",
    type: "Json",
    content: JSON.stringify({ server, browser }),
  });
  return modules;
}).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));
