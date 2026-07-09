/* oxlint-disable executor/no-unknown-error-message -- test boundary: asserting the typed AppExecutorError message */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { env } from "cloudflare:workers";

import { AppExecutorError } from "../executor/app-tool-executor";
import { bundleEntry } from "./bundle";
import { makeDynamicWorkerBundlerBackend } from "./dynamic-worker-bundler";

declare const __WORKER_BUNDLER_SOURCE__: string;
declare const __WORKER_BUNDLER_WASM_BASE64__: string;

interface WorkerLoader {
  readonly load: (code: {
    readonly compatibilityDate: string;
    readonly compatibilityFlags?: readonly string[];
    readonly mainModule: string;
    readonly modules: Record<string, string | { readonly wasm: ArrayBuffer }>;
  }) => { readonly getEntrypoint: () => { readonly fetch: typeof fetch } };
  readonly get: (
    name: string | null,
    factory: () => {
      readonly compatibilityDate: string;
      readonly compatibilityFlags?: readonly string[];
      readonly mainModule: string;
      readonly modules: Record<string, string | { readonly wasm: ArrayBuffer }>;
    },
  ) => { readonly getEntrypoint: () => { readonly fetch: typeof fetch } };
}

const base64ToArrayBuffer = (value: string): ArrayBuffer => {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const files = (entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> =>
  new Map(entries);

const artifact = async () => ({
  source: __WORKER_BUNDLER_SOURCE__,
  wasm: base64ToArrayBuffer(__WORKER_BUNDLER_WASM_BASE64__),
});

const getOnly = (loader: WorkerLoader): WorkerLoader => ({
  load: undefined as never,
  get: (name, factory) => loader.get(name, factory),
});

const driver = `
import { createWorker } from "./worker-bundler.js";

const moduleCode = (module) => {
  if (typeof module === "string") return module;
  if (module && typeof module.js === "string") return module.js;
  if (module && typeof module.cjs === "string") return module.cjs;
  return null;
};

export default {
  async fetch() {
    const result = await createWorker({
      files: {
        "tool.ts": "export default { answer: 42 };",
        "__executor_entry.ts": "import artifact from './tool.ts';\\nexport default artifact;\\n",
      },
      entryPoint: "__executor_entry.ts",
      bundle: true,
      target: "es2022",
      minify: false,
      jsx: "automatic",
      conditions: ["workerd", "worker", "browser", "import", "default"],
      virtualModules: {},
    });
    const code = moduleCode(result.modules[result.mainModule]);
    return Response.json({ ok: typeof code === "string", code });
  },
};
`;

describe("dynamic Worker worker-bundler spike", () => {
  it("loads esbuild.wasm as a wasm module and bundles JavaScript", async () => {
    const loader = (env as { readonly LOADER: WorkerLoader }).LOADER;
    const worker = loader.load({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "driver.js",
      modules: {
        "driver.js": driver,
        "worker-bundler.js": __WORKER_BUNDLER_SOURCE__,
        "esbuild.wasm": { wasm: base64ToArrayBuffer(__WORKER_BUNDLER_WASM_BASE64__) },
      },
    });

    const response = await worker.getEntrypoint().fetch("https://worker.test/run");
    const body = (await response.json()) as { readonly ok?: unknown; readonly code?: unknown };

    expect(body.ok).toBe(true);
    expect(body.code).toEqual(expect.stringContaining("answer"));
  });
});

describe("dynamic Worker bundler backend", () => {
  const loader = getOnly((env as { readonly LOADER: WorkerLoader }).LOADER);

  it.effect("bundles a tool importing zod through the Worker Loader backend", () =>
    Effect.gen(function* () {
      const bundled = yield* bundleEntry(
        {
          entry: "tools/greet.ts",
          files: files([
            [
              "tools/greet.ts",
              `
                import { z } from "zod";
                import { defineTool } from "executor:app";

                const Input = z.object({ name: z.string() });

                export default defineTool({
                  description: "Greet",
                  input: Input,
                  async handler(input) {
                    return { greeting: "hello " + input.name };
                  },
                });
              `,
            ],
            ["package.json", JSON.stringify({ dependencies: { zod: "4.3.6" } })],
            ["bun.lock", ""],
          ]),
        },
        makeDynamicWorkerBundlerBackend({ loader, artifact }),
      );

      expect(bundled.code).toContain("Greet");
      expect(bundled.code).toContain("hello ");
    }),
  );

  it.effect("surfaces install failures as bundle AppExecutorError failures", () =>
    Effect.gen(function* () {
      const error = yield* bundleEntry(
        {
          entry: "tools/greet.ts",
          files: files([
            [
              "tools/greet.ts",
              `
                import missing from "executor-worker-bundler-missing-package";
                import { defineTool } from "executor:app";

                export default defineTool({
                  description: "Greet",
                  async handler() {
                    return { greeting: String(missing) };
                  },
                });
              `,
            ],
            [
              "package.json",
              JSON.stringify({
                dependencies: { "executor-worker-bundler-missing-package": "999.999.999" },
              }),
            ],
            ["bun.lock", ""],
          ]),
        },
        makeDynamicWorkerBundlerBackend({ loader, artifact }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(AppExecutorError);
      expect(error.kind).toBe("bundle");
      expect(error.message).toMatch(/failed to install|No matching version|notarget/i);
    }),
  );
});
