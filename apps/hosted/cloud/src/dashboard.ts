import type { DocumentRead, DocumentRenderContext } from "./contracts/dashboard.ts";
import { Effect } from "effect";
import { Dashboard } from "./infrastructure/dashboard-worker.ts";
import { cloudSite } from "./infrastructure/site.ts";
import { cloudObservability } from "./infrastructure/telemetry.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";

const server = () =>
  import("@executor-js/hosted-cloud-web/server").then((module) => module.default);

type HeldRead = DocumentRead & { dup?: () => HeldRead; [Symbol.dispose]?: () => void };

const render = async (request: Request, context: DocumentRenderContext, read: HeldRead) => {
  const held = read.dup?.() ?? read;
  const release = () => held[Symbol.dispose]?.();
  const origin = new URL(request.url).origin;
  const apiFetch: typeof globalThis.fetch = (input, init) => {
    const target =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), origin), init);
    return held(target.url, { method: target.method, headers: [...target.headers] });
  };
  const response = await server()
    .then((renderer) => renderer.fetch(request, { context: { ...context, apiFetch } }))
    .catch((cause: unknown) => {
      release();
      throw cause;
    });
  if (response.body === null) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) =>
      reader.read().then(
        (chunk) => {
          if (!chunk.done) return controller.enqueue(chunk.value);
          release();
          controller.close();
        },
        (cause: unknown) => {
          release();
          controller.error(cause);
        },
      ),
    cancel: (reason) => {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
};

export default Dashboard.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    const site = yield* cloudSite;
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      build: workerBuild("dashboard"),
      env: { EXECUTOR_SITE_BUILD: site.hash.output },
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
    };
  }),
  Effect.succeed(
    Dashboard.of({
      render: (request, context, read) => Effect.promise(() => render(request, context, read)),
    }),
  ),
);
