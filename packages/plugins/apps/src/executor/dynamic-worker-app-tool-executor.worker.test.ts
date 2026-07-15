import { describe, expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { makeDynamicWorkerAppToolExecutor } from "./dynamic-worker-app-tool-executor";

type WorkerLoader = Parameters<typeof makeDynamicWorkerAppToolExecutor>[0]["loader"];

describe("dynamic Worker app tool executor", () => {
  it.effect("invokes a completed tool through the generated driver", () =>
    Effect.gen(function* () {
      const loader = (env as { readonly LOADER: WorkerLoader }).LOADER;
      const executor = makeDynamicWorkerAppToolExecutor({ loader });
      const bundle = `
        export default {
          "~executorAppTool": true,
          description: "Fast",
          input: undefined,
          handler() { return { ok: true }; },
        };
      `;

      const result = yield* executor.invoke(
        bundle,
        { toolName: "fast" },
        {},
        { call: async () => null },
        { timeoutMs: 30_000, isolateKey: "timer-cleanup" },
      );

      expect(result.output).toEqual({ ok: true });
    }),
  );
});
