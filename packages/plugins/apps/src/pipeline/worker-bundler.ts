/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message, executor/no-error-constructor, executor/no-json-parse, executor/no-instanceof-tagged-error, executor/no-instanceof-error -- boundary: subprocess-backed bundler validates package JSON and converts worker failures into typed AppExecutorError */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWorkerdModuleRunner,
  WORKERD_VERSION,
} from "@executor-js/runtime-workerd-subprocess";
import { build } from "esbuild";
import { Effect } from "effect";

import { AppExecutorError } from "../executor/app-tool-executor";
import { PUBLISH_LIMITS } from "./publish";
import type { BundleBackend, BundleInput, BundleOutput } from "./bundle";
import type { ToolchainRef } from "./descriptor";
import { WORKER_BUNDLER_ESBUILD_VERSION, WORKER_BUNDLER_VERSION } from "./worker-bundler-version";

const textEncoder = new TextEncoder();
const packageDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workerBundlerDir = join(packageDir, "node_modules", "@cloudflare", "worker-bundler");

const executorAppSource = `
const makeIntegrationDeclaration = (state) => Object.freeze({
  kind: "integration",
  slug: state.slug,
  mode: state.mode,
  ...(state.description !== undefined ? { description: state.description } : {}),
  array: () => makeIntegrationDeclaration({ ...state, mode: "many" }),
  describe: (text) => makeIntegrationDeclaration({ ...state, description: text }),
});
export const integration = (slug) => makeIntegrationDeclaration({ slug, mode: "one" });
export const defineTool = (definition) => ({ ...definition, "~executorAppTool": true });
`;

const driverModule = `
import { createWorker } from "./worker-bundler.js";

const executorAppSource = ${JSON.stringify(executorAppSource)};
const json = (body, status = 200) => Response.json(body, { status });
const moduleCode = (module) => {
  if (typeof module === "string") return module;
  if (module && typeof module.js === "string") return module.js;
  if (module && typeof module.cjs === "string") return module.cjs;
  return null;
};

export default {
  async fetch(request) {
    if (request.url.endsWith("/__health")) return json({ ok: true });
    if (!request.url.endsWith("/run")) return json({ ok: false, message: "not found" }, 404);
    try {
      const input = await request.json();
      const files = { ...input.files };
      files["__executor_entry.ts"] = "import artifact from " + JSON.stringify("./" + input.entry) + ";\\nexport default artifact;\\n";
      const result = await createWorker({
        files,
        entryPoint: "__executor_entry.ts",
        bundle: true,
        target: "es2022",
        minify: false,
        jsx: "automatic",
        conditions: ["workerd", "worker", "browser", "import", "default"],
        virtualModules: { "executor:app": executorAppSource },
      });
      const code = moduleCode(result.modules[result.mainModule]);
      if (code === null) {
        return json({ ok: false, message: "worker-bundler did not return JavaScript for " + result.mainModule });
      }
      return json({ ok: true, code, warnings: result.warnings ?? [] });
    } catch (error) {
      return json({ ok: false, message: error && error.message ? error.message : String(error) });
    }
  },
};
`;

const bundledWorkerBundler = async (): Promise<{
  readonly source: string;
  readonly wasm: Uint8Array;
}> => {
  const entry = join(workerBundlerDir, "dist", "index.js");
  const [result, wasm] = await Promise.all([
    build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      external: ["./esbuild.wasm"],
      logLevel: "silent",
    }),
    readFile(join(workerBundlerDir, "dist", "esbuild.wasm")),
  ]);
  const source = result.outputFiles[0]?.text;
  if (source === undefined) throw new Error("failed to bundle @cloudflare/worker-bundler");
  return { source, wasm };
};

const workerBundlerModule = bundledWorkerBundler();

const packageScriptError = (input: BundleInput): AppExecutorError | null => {
  const rawPackageJson = input.files.get("package.json");
  if (rawPackageJson === undefined) return null;
  try {
    const parsed = JSON.parse(rawPackageJson) as {
      readonly name?: unknown;
      readonly scripts?: unknown;
    };
    const scripts =
      parsed.scripts !== null &&
      typeof parsed.scripts === "object" &&
      !Array.isArray(parsed.scripts)
        ? (parsed.scripts as Record<string, unknown>)
        : {};
    const blocked = Object.keys(scripts).find((name) =>
      /^(pre|post)?install$|^prepare$/.test(name),
    );
    if (!blocked) return null;
    const packageName = typeof parsed.name === "string" ? parsed.name : "package.json";
    return new AppExecutorError({
      kind: "bundle",
      message: `package ${packageName} declares unsupported lifecycle script "${blocked}"`,
      diagnostics: [
        {
          path: "package.json",
          message: `lifecycle script "${blocked}" is not allowed in app publish dependencies`,
        },
      ],
    });
  } catch (cause) {
    return new AppExecutorError({
      kind: "bundle",
      message: "package.json is not valid JSON",
      diagnostics: [{ path: "package.json", message: "invalid package.json" }],
      cause,
    });
  }
};

const fileRecord = (files: ReadonlyMap<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [path, source] of files) out[path] = source;
  return out;
};

const enforceOutputLimit = (entry: string, code: string): AppExecutorError | null => {
  const size = textEncoder.encode(code).byteLength;
  return size <= PUBLISH_LIMITS.maxTotalBytes
    ? null
    : new AppExecutorError({
        kind: "bundle",
        message: `bundle for ${entry} is ${size} bytes, exceeding the limit of ${PUBLISH_LIMITS.maxTotalBytes} bytes`,
        diagnostics: [{ path: entry, message: "bundle exceeds publish size limit" }],
      });
};

const toolchain = (): ToolchainRef => ({
  bundler: {
    name: "@cloudflare/worker-bundler",
    version: `${WORKER_BUNDLER_VERSION} (esbuild-wasm ${WORKER_BUNDLER_ESBUILD_VERSION})`,
  },
  executor: { name: "workerd-subprocess", version: WORKERD_VERSION },
  target: "es2022",
});

export const makeWorkerBundlerBackend = (): BundleBackend => ({
  toolchain,
  bundle: (input): Effect.Effect<BundleOutput, AppExecutorError> =>
    Effect.tryPromise({
      try: async () => {
        const scriptError = packageScriptError(input);
        if (scriptError) throw scriptError;
        const modules = await workerBundlerModule;
        const runner = createWorkerdModuleRunner({
          mainModule: "driver.js",
          modules: {
            "driver.js": driverModule,
            "worker-bundler.js": modules.source,
            "esbuild.wasm": { kind: "wasm", bytes: modules.wasm },
          },
          globalOutbound: "internet",
          restartBackoffMs: 1,
        });
        try {
          const response = await runner.run<{
            readonly ok: boolean;
            readonly code?: string;
            readonly message?: string;
          }>({ files: fileRecord(input.files), entry: input.entry });
          if (!response.body.ok || typeof response.body.code !== "string") {
            throw new AppExecutorError({
              kind: "bundle",
              message: response.body.message ?? `worker-bundler failed for ${input.entry}`,
              diagnostics: [
                { path: input.entry, message: response.body.message ?? "worker-bundler failed" },
              ],
            });
          }
          const limitError = enforceOutputLimit(input.entry, response.body.code);
          if (limitError) throw limitError;
          return { code: response.body.code, toolchain: toolchain() };
        } finally {
          await runner.dispose();
        }
      },
      catch: (cause) =>
        cause instanceof AppExecutorError
          ? cause
          : new AppExecutorError({
              kind: "bundle",
              message: `worker-bundler failed for ${input.entry}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
    }),
});
