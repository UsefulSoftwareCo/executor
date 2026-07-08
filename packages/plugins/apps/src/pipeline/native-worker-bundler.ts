/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message, executor/no-json-parse, executor/no-double-cast, executor/no-instanceof-tagged-error, executor/no-instanceof-error -- boundary: Workers-only dynamic import and package JSON validation return typed AppExecutorError */
import { Effect } from "effect";

import { AppExecutorError } from "../executor/app-tool-executor";
import { PUBLISH_LIMITS } from "./publish";
import type { BundleBackend, BundleInput, BundleOutput } from "./bundle";
import type { ToolchainRef } from "./descriptor";
import { WORKER_BUNDLER_ESBUILD_VERSION, WORKER_BUNDLER_VERSION } from "./worker-bundler-version";

const textEncoder = new TextEncoder();

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
        { path: "package.json", message: `lifecycle script "${blocked}" is not allowed` },
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

const fileRecord = (files: ReadonlyMap<string, string>, entry: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [path, source] of files) out[path] = source;
  out["__executor_entry.ts"] =
    `import artifact from ${JSON.stringify(`./${entry}`)};\nexport default artifact;\n`;
  return out;
};

const moduleCode = (module: unknown): string | null => {
  if (typeof module === "string") return module;
  if (module && typeof module === "object" && "js" in module && typeof module.js === "string") {
    return module.js;
  }
  if (module && typeof module === "object" && "cjs" in module && typeof module.cjs === "string") {
    return module.cjs;
  }
  return null;
};

const toolchain = (): ToolchainRef => ({
  bundler: {
    name: "@cloudflare/worker-bundler",
    version: `${WORKER_BUNDLER_VERSION} (esbuild-wasm ${WORKER_BUNDLER_ESBUILD_VERSION})`,
  },
  executor: { name: "cloud-worker", version: "worker-loader" },
  target: "es2022",
});

export const makeNativeWorkerBundlerBackend = (): BundleBackend => ({
  toolchain,
  bundle: (input): Effect.Effect<BundleOutput, AppExecutorError> =>
    Effect.tryPromise({
      try: async () => {
        const scriptError = packageScriptError(input);
        if (scriptError) throw scriptError;
        const mod = (await import("@cloudflare/worker-bundler")) as unknown as {
          readonly createWorker: (options: {
            readonly files: Record<string, string>;
            readonly entryPoint: string;
            readonly bundle: true;
            readonly target: string;
            readonly minify: false;
            readonly jsx: "automatic";
            readonly conditions: readonly string[];
            readonly virtualModules: Record<string, string>;
          }) => Promise<{
            readonly mainModule: string;
            readonly modules: Readonly<Record<string, unknown>>;
          }>;
        };
        const result = await mod.createWorker({
          files: fileRecord(input.files, input.entry),
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
          throw new AppExecutorError({
            kind: "bundle",
            message: `worker-bundler failed for ${input.entry}: missing JavaScript output`,
            diagnostics: [{ path: input.entry, message: "missing JavaScript output" }],
          });
        }
        const size = textEncoder.encode(code).byteLength;
        if (size > PUBLISH_LIMITS.maxTotalBytes) {
          throw new AppExecutorError({
            kind: "bundle",
            message: `bundle for ${input.entry} is ${size} bytes, exceeding the limit of ${PUBLISH_LIMITS.maxTotalBytes} bytes`,
            diagnostics: [{ path: input.entry, message: "bundle exceeds publish size limit" }],
          });
        }
        return { code, toolchain: toolchain() };
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
