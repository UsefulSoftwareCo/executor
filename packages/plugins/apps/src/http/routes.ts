import { Effect } from "effect";

import type { AppsRuntime } from "../plugin/runtime";
import type { Bindings } from "../plugin/bindings";

// ---------------------------------------------------------------------------
// Apps HTTP surface — a plain web handler (Request -> Response) the self-host
// app mounts as an extension route under `/api/apps/*`. Covers:
//   POST /api/apps/:scope/publish         { files }        -> descriptor
//   GET  /api/apps/:scope/descriptor                       -> descriptor
//   POST /api/apps/:scope/tools/:tool     { args, bindings } -> result
//   POST /api/apps/:scope/workflows/:wf/start { input, bindings } -> run
//   POST /api/apps/:scope/workflows/runs/:runId/signal { event, payload } -> run
//   GET  /api/apps/:scope/workflows/runs/:runId            -> run + steps
//   GET  /api/apps/:scope/workflows/runs                   -> runs
//   GET  /api/apps/:scope/ui/:name                         -> compiled bundle (JS)
//   GET  /api/apps/:scope/live (SSE)                       -> invalidations
//
// It's deliberately transport-thin: all logic is in AppsRuntime.
// ---------------------------------------------------------------------------

export interface AppsHttpDeps {
  readonly runtime: AppsRuntime;
  /** Mount prefix (default "/api/apps"). */
  readonly prefix?: string;
  /**
   * Authenticate an inbound request. Returns `true` when the caller is
   * authorized and `false` otherwise; the handler answers `false` with a 401.
   *
   * The apps surface (publish / invoke / workflow lifecycle / SSE) mutates
   * per-scope state and reaches real integrations, so it MUST be behind the same
   * credential the rest of `/api` requires. This seam lets the host thread its
   * own identity check (self-host's Better Auth session/bearer/api-key) in
   * without this package importing the host's auth stack. When omitted (tests
   * that drive the runtime directly) every request is allowed.
   */
  readonly authenticate?: (request: Request) => Promise<boolean>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as never);

export const makeAppsHttpRoutes = (
  deps: AppsHttpDeps,
): { readonly path: string; readonly handler: (request: Request) => Promise<Response> } => {
  const prefix = deps.prefix ?? "/api/apps";
  const runtime = deps.runtime;

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404 });

    // Auth gate: the whole apps surface (publish/invoke/workflows/ui/SSE) is
    // behind the host's identity check. An unauthenticated caller gets a 401
    // BEFORE any route logic runs — including the SSE stream.
    if (deps.authenticate) {
      const ok = await deps.authenticate(request).catch(() => false);
      if (!ok) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const rest = url.pathname.slice(prefix.length).replace(/^\//, "");
    const parts = rest.split("/").filter(Boolean);
    // parts[0] = scope
    const scope = parts[0];
    if (!scope) return json({ error: "scope required" }, 400);

    try {
      // POST :scope/publish
      if (parts[1] === "publish" && request.method === "POST") {
        const body = (await request.json()) as { files: Record<string, string>; message?: string };
        const files = new Map(Object.entries(body.files ?? {}));
        const out = await run(runtime.publish({ scope, files, message: body.message }));
        return json({ snapshotId: out.snapshotId, descriptor: out.descriptor });
      }

      // GET :scope/descriptor
      if (parts[1] === "descriptor" && request.method === "GET") {
        const descriptor = await run(runtime.getDescriptor(scope));
        return json({ descriptor });
      }

      // POST :scope/tools/:tool
      if (parts[1] === "tools" && parts[2] && request.method === "POST") {
        const body = (await request.json()) as { args?: unknown; bindings?: Bindings };
        const result = await run(
          runtime.invokeTool({
            scope,
            tool: parts[2],
            args: body.args ?? {},
            bindings: body.bindings ?? {},
          }),
        );
        return json({ result });
      }

      // POST :scope/workflows/:wf/start
      if (parts[1] === "workflows" && parts[3] === "start" && request.method === "POST") {
        const body = (await request.json()) as {
          input?: unknown;
          bindings?: Bindings;
          runId?: string;
        };
        const runView = await run(
          runtime.startWorkflow({
            scope,
            workflow: parts[2],
            input: body.input,
            bindings: body.bindings,
            runId: body.runId,
          }),
        );
        return json({ run: runView });
      }

      // POST :scope/workflows/runs/:runId/signal
      if (
        parts[1] === "workflows" &&
        parts[2] === "runs" &&
        parts[3] &&
        parts[4] === "signal" &&
        request.method === "POST"
      ) {
        const body = (await request.json()) as { event: string; payload?: unknown };
        const runView = await run(
          runtime.signalWorkflow({
            scope,
            runId: parts[3],
            event: body.event,
            payload: body.payload,
          }),
        );
        return json({ run: runView });
      }

      // GET :scope/workflows/runs/:runId
      if (parts[1] === "workflows" && parts[2] === "runs" && parts[3] && request.method === "GET") {
        const runView = await run(runtime.getRun(parts[3]));
        const steps = await run(runtime.listSteps(parts[3]));
        return json({ run: runView, steps });
      }

      // GET :scope/workflows/runs
      if (
        parts[1] === "workflows" &&
        parts[2] === "runs" &&
        !parts[3] &&
        request.method === "GET"
      ) {
        const runs = await run(runtime.listRuns(scope));
        return json({ runs });
      }

      // GET :scope/ui/:name -> compiled JS bundle, OR the self-booting HTML
      // document when `?document=html` (Fix 10: the fallback a non-UI MCP client
      // opens in a browser). Both are behind the same auth gate as the rest of
      // the surface.
      if (parts[1] === "ui" && parts[2] && request.method === "GET") {
        if (url.searchParams.get("document") === "html") {
          const doc = await run(runtime.getUiDocument(scope, parts[2]));
          if (!doc) return new Response("ui not found", { status: 404 });
          return new Response(doc.html, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-ui-title": doc.title ?? "",
              "x-ui-max-height": String(doc.maxHeight ?? ""),
            },
          });
        }
        const bundle = await run(runtime.getUiBundle(scope, parts[2]));
        if (!bundle) return new Response("ui not found", { status: 404 });
        return new Response(bundle.code, {
          status: 200,
          headers: {
            "content-type": "application/javascript",
            "x-ui-title": bundle.title ?? "",
            "x-ui-max-height": String(bundle.maxHeight ?? ""),
          },
        });
      }

      // GET :scope/live -> SSE invalidations
      if (parts[1] === "live" && request.method === "GET") {
        return sseResponse(scope, runtime);
      }

      return new Response("not found", { status: 404 });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return json({ error: message }, 400);
    }
  };

  return { path: `${prefix}/*`, handler };
};

// An SSE stream of `{table, version}` invalidations for a scope. Each scope-db
// write bumps a counter and publishes here; a `: keepalive` comment holds the
// connection open.
const sseResponse = (scope: string, runtime: AppsRuntime): Response => {
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`event: ready\ndata: {"scope":"${scope}"}\n\n`));
      unsubscribe = runtime.subscribeLive(scope, (event) => {
        try {
          controller.enqueue(
            enc.encode(
              `event: invalidate\ndata: ${JSON.stringify({ scope, table: event.table, version: event.version })}\n\n`,
            ),
          );
        } catch {
          /* controller closed */
        }
      });
      keepalive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`));
        } catch {
          /* closed */
        }
      }, 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (keepalive) clearInterval(keepalive);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};
