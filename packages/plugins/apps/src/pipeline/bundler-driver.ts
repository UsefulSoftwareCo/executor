/* oxlint-disable executor/no-try-catch-or-throw, executor/no-json-parse, executor/no-instanceof-tagged-error -- boundary: worker-bundler driver and package validation convert toolchain failures into typed AppExecutorError */
import { AppExecutorError } from "../executor/app-tool-executor";
import type { BundleInput } from "./bundle";
import { PUBLISH_LIMITS } from "./publish";

const textEncoder = new TextEncoder();

export const executorAppSource = `
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

export const DEFAULT_REGISTRY_ORIGINS = ["https://registry.npmjs.org"] as const;

export const registryOriginsFromEnv = (): readonly string[] => [
  ...DEFAULT_REGISTRY_ORIGINS,
  ...(process.env.EXECUTOR_NPM_REGISTRY ? [new URL(process.env.EXECUTOR_NPM_REGISTRY).origin] : []),
];

export const driverModule = (options: {
  readonly token?: string;
  readonly registryOrigins: readonly string[];
}): string => `
import { createWorker } from "./worker-bundler.js";

const allowedRegistryOrigins = new Set(${JSON.stringify(options.registryOrigins)});
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!allowedRegistryOrigins.has(url.origin)) {
    throw new Error("publish worker outbound fetch blocked: " + url.origin);
  }
  return originalFetch(input, init);
};

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
    ${
      options.token
        ? `if (request.url.endsWith("/__health")) return json({ ok: true, runnerToken: ${JSON.stringify(options.token)} });`
        : ""
    }
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
      const installFailure = (result.warnings ?? []).find((warning) => /failed to install/i.test(String(warning)));
      if (installFailure) {
        return json({ ok: false, message: String(installFailure) });
      }
      for (const [path, module] of Object.entries(result.modules)) {
        const source = moduleCode(module) ?? "";
        if (/\\.node(?:$|[?#])|node-gyp|prebuild-install|node-pre-gyp/.test(path) || /\\.node(?:$|[?#])|node-gyp|prebuild-install|node-pre-gyp/.test(source)) {
          return json({ ok: false, message: "package dependency includes unsupported native module artifact: " + path });
        }
      }
      return json({ ok: true, code, warnings: result.warnings ?? [] });
    } catch (error) {
      return json({ ok: false, message: error && error.message ? error.message : String(error) });
    }
  },
};
`;

const blockedDependencySpec = (spec: string): boolean =>
  /^(?:https?:|git(?:\+|:)|file:|workspace:|link:|portal:)/.test(spec);

export const packageBoundaryError = (input: BundleInput): AppExecutorError | null => {
  for (const path of input.files.keys()) {
    if (/\.node$|(?:^|\/)(?:binding\.gyp|node-gyp|prebuilds?|node_modules\/.*\.node)/.test(path)) {
      return new AppExecutorError({
        kind: "bundle",
        message: `package dependency includes unsupported native module artifact: ${path}`,
        diagnostics: [
          { path, message: "native modules are not supported in app publish dependencies" },
        ],
      });
    }
  }
  const rawPackageJson = input.files.get("package.json");
  if (rawPackageJson === undefined) return null;
  try {
    const parsed = JSON.parse(rawPackageJson) as {
      readonly name?: unknown;
      readonly scripts?: unknown;
      readonly dependencies?: unknown;
      readonly devDependencies?: unknown;
      readonly optionalDependencies?: unknown;
      readonly peerDependencies?: unknown;
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
    const packageName = typeof parsed.name === "string" ? parsed.name : "package.json";
    if (blocked) {
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
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const deps = parsed[field];
      if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
      for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof spec === "string" && blockedDependencySpec(spec)) {
          return new AppExecutorError({
            kind: "bundle",
            message: `package dependency ${name} uses unsupported non-registry spec "${spec}"`,
            diagnostics: [
              {
                path: "package.json",
                message: `dependency ${name} must resolve from an allowed npm registry`,
              },
            ],
          });
        }
      }
    }
    return null;
  } catch (cause) {
    return new AppExecutorError({
      kind: "bundle",
      message: "package.json is not valid JSON",
      diagnostics: [{ path: "package.json", message: "invalid package.json" }],
      cause,
    });
  }
};

export const fileRecord = (files: ReadonlyMap<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [path, source] of files) out[path] = source;
  return out;
};

export const enforceOutputLimit = (entry: string, code: string): AppExecutorError | null => {
  const size = textEncoder.encode(code).byteLength;
  return size <= PUBLISH_LIMITS.maxTotalBytes
    ? null
    : new AppExecutorError({
        kind: "bundle",
        message: `bundle for ${entry} is ${size} bytes, exceeding the limit of ${PUBLISH_LIMITS.maxTotalBytes} bytes`,
        diagnostics: [{ path: entry, message: "bundle exceeds publish size limit" }],
      });
};
