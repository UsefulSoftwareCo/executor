import * as NodeServices from "@effect/platform-node/NodeServices";
import type { WorkerProps } from "alchemy/Cloudflare";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import {
  attributeChunk,
  packageBytes,
  sourcePathFrom,
  writeWorkerUpload,
  type WorkerUpload,
} from "./worker-upload.ts";

export type WorkerName =
  | "api"
  | "app-data"
  | "app-pages"
  | "mcp-server"
  | "dashboard"
  | "formatter"
  | "authoring"
  | "compiler"
  | "marketing"
  | "edge";

const uploadBudgets: Record<WorkerName, number> = {
  api: 6_000_000,
  "app-data": 750_000,
  "app-pages": 2_700_000,
  "mcp-server": 3_700_000,
  dashboard: 4_300_000,
  formatter: 2_500_000,
  authoring: 1_000_000,
  compiler: 1_700_000,
  marketing: 1_000_000,
  edge: 400_000,
};

type OutputBundle = Record<
  string,
  | {
      readonly type: "chunk";
      readonly code: string;
      readonly isEntry: boolean;
      readonly imports: ReadonlyArray<string>;
      readonly dynamicImports: ReadonlyArray<string>;
      readonly map: {
        readonly mappings: string;
        readonly sources: ReadonlyArray<string>;
      } | null;
    }
  | { readonly type: "asset"; readonly source: string | Uint8Array }
>;

export const uploadedModulesPlugin = "executor-uploaded-modules";

const uploadedModules = (worker: WorkerName) => ({
  name: uploadedModulesPlugin,
  async generateBundle(options: { readonly dir?: string }, bundle: OutputBundle) {
    const reach = (dynamic: boolean) => {
      const reached = new Set<string>();
      const visit = (name: string) => {
        const output = bundle[name];
        if (reached.has(name) || output?.type !== "chunk") return;
        reached.add(name);
        for (const imported of [...output.imports, ...(dynamic ? output.dynamicImports : [])])
          visit(imported);
      };
      for (const [name, output] of Object.entries(bundle))
        if (output.type === "chunk" && output.isEntry) visit(name);
      return reached;
    };
    const reachable = reach(true);
    let staticBytes = 0;
    for (const name of reach(false)) {
      const output = bundle[name];
      if (output?.type === "chunk") staticBytes += Buffer.byteLength(output.code);
    }
    let bytes = 0;
    const sources = new Map<string, number>();
    for (const [name, output] of Object.entries(bundle)) {
      if (output.type !== "chunk") continue;
      if (reachable.has(name)) {
        bytes += Buffer.byteLength(output.code);
        const unmapped = `(no source map: ${name.replace(/-[\w-]{8}\.js$/, ".js")})`;
        if (output.map === null)
          sources.set(unmapped, (sources.get(unmapped) ?? 0) + Buffer.byteLength(output.code));
        else
          attributeChunk(
            output.code,
            output.map,
            sources,
            sourcePathFrom(`${options.dir ?? "."}/${name.split("/").slice(0, -1).join("/")}`),
            unmapped,
          );
        continue;
      }
      delete bundle[name];
      delete bundle[`${name}.map`];
    }
    const upload: WorkerUpload = {
      worker,
      bytes,
      budget: uploadBudgets[worker],
      staticBytes,
      sources: Object.fromEntries([...sources].toSorted((a, b) => b[1] - a[1])),
    };
    await writeWorkerUpload(upload);
    if (bytes > upload.budget)
      throw new Error(
        `The ${worker} Worker uploads ${bytes} bytes of JavaScript; its budget is ${upload.budget}. ` +
          "Every uploaded module is compiled on each cold start, even one only loaded by a dynamic " +
          "import. Move rarely used code to another Worker or serve large data as static assets. " +
          "`bun run hosted:cloud:worker-sizes` shows what grew compared with main. Largest packages: " +
          `${packageBytes(upload.sources)
            .slice(0, 8)
            .map(([name, size]) => `${name} (${size})`)
            .join(", ")}.`,
      );
  },
});

const sentryArtifacts = (worker: WorkerName) => ({
  name: "executor-sentry-artifacts",
  writeBundle: (_options: unknown, bundle: OutputBundle) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* path.fromFileUrl(
          new URL(`../../.generated/sentry-worker/${worker}`, import.meta.url),
        );
        yield* fs.remove(directory, { recursive: true, force: true });
        yield* fs.makeDirectory(directory, { recursive: true });
        for (const [name, output] of Object.entries(bundle)) {
          if (!name.endsWith(".js") && !name.endsWith(".map")) continue;
          const target = path.join(directory, name);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          const contents = output.type === "chunk" ? output.code : output.source;
          if (typeof contents === "string") yield* fs.writeFileString(target, contents);
          else yield* fs.writeFile(target, contents);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
});

export const localTestModules: ReadonlyArray<readonly [passThrough: string, hook: string]> = [
  ["mcp-interaction-faults.ts", "mcp-interaction-faults-local.ts"],
];

const localTestHooks = () => {
  const directory = new URL(".", import.meta.url);
  return Object.fromEntries(
    localTestModules.map(([passThrough, hook]) => [
      fileURLToPath(new URL(passThrough, directory)),
      fileURLToPath(new URL(hook, directory)),
    ]),
  );
};

export const workerBuild = (
  worker: WorkerName,
  options: { readonly localTestHooks?: boolean } = {},
): NonNullable<WorkerProps["build"]> =>
  worker === "compiler"
    ? { output: { plugins: [uploadedModules(worker)] } }
    : {
        ...(options.localTestHooks === true
          ? { input: { resolve: { alias: localTestHooks() } } }
          : {}),
        output: {
          entryFileNames: `${worker}-[name].js`,
          chunkFileNames: `${worker}-[name]-[hash].js`,
          strictExecutionOrder: false,
          codeSplitting: {
            groups: [
              ...(worker === "dashboard"
                ? [{ name: "effect", test: "/node_modules/effect/", priority: 1 }]
                : []),
              { name: "dashboard", test: "/web/dist/server/" },
            ],
          },
          keepNames: false,
          sourcemap: "hidden",
          plugins: [
            uploadedModules(worker),
            ...(worker === "api" || worker === "app-pages" || worker === "mcp-server"
              ? [sentryArtifacts(worker)]
              : []),
          ],
        },
      };
