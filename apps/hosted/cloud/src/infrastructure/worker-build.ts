/** Rolldown output rules for each Worker: upload only reachable modules, within a budget. */
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

/**
 * The most JavaScript each Worker may upload, in bytes. Cloudflare compiles every uploaded ES
 * module when an isolate starts, whether or not the Worker ever imports it: about 40 ms for each
 * megabyte, on every cold request (36-45 ms on test stages; see `notes/cloud-latency.md`).
 *
 * Each budget is a backstop with room above the Worker's size, so a build fails only on a large
 * mistake, and a change does not fail for arriving last. What holds a Worker's size is the check
 * job: it fails a pull request that adds more than 50 KB to one Worker unless the description
 * allows it (`scripts/worker-sizes.ts`), and flags a Worker with little of its budget left.
 *
 * Change a budget only in a pull request that does nothing else and says what the added
 * cold-start time buys. To make room instead, load rarely used code from another Worker: the API
 * Worker leaves rendering to `dashboard`, source formatting and Markdown parsing to `formatter`,
 * the authoring reference to `authoring` and MCP sessions to `mcp-server`.
 */
const uploadBudgets: Record<WorkerName, number> = {
  // A person or an agent waits on the first five's cold starts, so each has about a tenth of its
  // size as room.
  api: 6_000_000,
  // App runners and data supervisors: a cold tool call starts both isolates.
  "app-data": 750_000,
  "app-pages": 2_700_000,
  "mcp-server": 3_700_000,
  // Reached through a service binding, so most documents start a new isolate.
  dashboard: 4_300_000,
  // The rest are called rarely or already take seconds. `formatter` and `authoring` take what
  // the API Worker leaves out, so they have more room.
  formatter: 2_500_000,
  // Generated data: the published skills and the framework reference.
  authoring: 1_000_000,
  compiler: 1_700_000,
  marketing: 1_000_000,
  // A test stage's forwarding Worker: routing and a service binding call.
  edge: 400_000,
};

/** The fields of Rolldown's output bundle these rules read. */
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

/** The plugin that enforces a Worker's budget; `scripts/worker-builds.ts` builds Workers that use it. */
export const uploadedModulesPlugin = "executor-uploaded-modules";

/**
 * Rolldown emits a chunk for every dynamic import it finds, even when tree-shaking removes the
 * only code that loads it, such as deploy-time Vite support inside Alchemy. No uploaded module
 * can load such a chunk, so it is dropped with its source map. The budget is then checked
 * against exactly what Cloudflare receives, and the upload is written with each byte attributed
 * to its source so `bun run hosted:cloud:worker-sizes` can say what grew.
 */
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
        // Generated modules have no source; name them by their chunk without its content hash.
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

/** Collect exactly this Worker's output for Sentry; Alchemy's bundle folder retains older builds. */
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

/**
 * Modules an `alchemy dev` build replaces with a local test hook, by file name in this directory.
 * Deployed builds bundle each pass-through as written, so their uploads contain no hook for a
 * binding or a request to turn on. `scripts/worker-sizes.ts` fails if a deployed build uploads one.
 */
export const localTestModules: ReadonlyArray<readonly [passThrough: string, hook: string]> = [
  ["mcp-interaction-faults.ts", "mcp-interaction-faults-local.ts"],
];

/**
 * Resolve each pass-through in `localTestModules` to its hook instead. This is an alias, not a
 * plugin: `alchemy dev` sends Worker props to its local provider over RPC, which drops functions.
 */
const localTestHooks = () => {
  const directory = new URL(".", import.meta.url);
  return Object.fromEntries(
    localTestModules.map(([passThrough, hook]) => [
      fileURLToPath(new URL(passThrough, directory)),
      fileURLToPath(new URL(hook, directory)),
    ]),
  );
};

/**
 * Build options for one Worker. The compiler keeps Alchemy's default output. `localTestHooks`
 * is for `alchemy dev` only.
 */
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
          // Normal ESM ordering avoids an initializer wrapper around every module.
          // This graph is covered by the workerd MCP and app-UI tests; keep source maps for diagnostics.
          strictExecutionOrder: false,
          // Re-chunking the prebuilt dashboard graph by entry reach can evaluate a chunk that reads a
          // binding before the chunk that initializes it. One chunk keeps that graph's own module order.
          // The dashboard build imports this Worker's Effect, and a group also takes its modules'
          // dependencies: without a group of its own, Effect joins the dashboard chunk, and the
          // entry, which imports Effect too, then loads the whole renderer at startup instead of on
          // the first render. Groups are plain strings: Alchemy keeps these props as JSON.
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
