import { retireMethod } from "@executor-js/app-data/worker-bundle";
import type { SourceFile } from "../contracts/deployment.ts";

/**
 * The text files a server entry retains as `ctx.files`. `ui/` is the browser app: the host serves
 * it as compiled assets, and embedding it would make every build parse it as one string literal.
 */
const serverFiles = (files: readonly SourceFile[]) =>
  JSON.stringify(files.filter((file) => !file.path.startsWith("ui/")));
/**
 * The retained server entry for every protocol so far. It imports the framework's host module as a
 * namespace and uses only what protocol 1 guarantees, so it links against every protocol-1 framework. Optional
 * later additions are feature-detected: `isolatedCacheSession` first shipped after apps
 * 0.0.1-beta.0, and the invocation bridges skip caching when a build has no `cacheSession`.
 * `isolatedClock` first shipped in apps 0.0.1-beta.46; without it they report no dispatch time.
 */
export const appBridge = (files: readonly SourceFile[]) => `
import app from "./index.ts";
import * as host from "apps/host";
const handler = host.createIsolatedAppHandler(app);
const files = ${serverFiles(files)};
export default {
  cacheSession: host.isolatedCacheSession,
  clock: host.isolatedClock,
  async fetch(request, env) {
    // This entry point has no public route or host bindings. Only the trusted loader calls it.
    const { command, accounts, approval, replay, deadline, workflowRun } = await request.json();
    const lifetime = new AbortController();
    const delivery = env?.ELICITATION;
    const elicitation = delivery == null ? undefined : host.isolatedElicitation((prompt) => delivery(prompt), lifetime);
    try {
      return await handler(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { "content-type": "application/json", traceparent: request.headers.get("traceparent") ?? "" }, body: JSON.stringify(command), signal: AbortSignal.any([request.signal, lifetime.signal])
      }), { ...host.hostContext(accounts, approval), files, ...(env?.CACHE === undefined ? {} : { cache: env.CACHE }), ...(replay === undefined ? {} : { replay }), ...(deadline === undefined ? {} : { deadline }), ...(env?.WORKFLOW && workflowRun ? { workflow: host.isolatedWorkflowExecution(workflowRun, env.WORKFLOW, lifetime.signal) } : {}), ...(env?.WORKFLOW_CONTROLS ? { workflowControls: host.isolatedWorkflowControls(env.WORKFLOW_CONTROLS) } : {}), ...(elicitation === undefined ? {} : { elicitation }), ...(env?.STORAGE === undefined ? {} : { storage: env.STORAGE }) });
    } finally { lifetime.abort(); }
  }
};`;

/**
 * Entry for the SDK's in-process Node runtime. Every protocol so far uses the same host
 * functions; the entry records which one its framework speaks.
 */
export const nodeAppEntry = (protocol: number) => (files: readonly SourceFile[]) =>
  [
    'import app from "./source/index.ts";',
    'import * as host from "apps/host";',
    `export const protocol = ${protocol};`,
    "const handler = host.createAppHandler(app);",
    `const files = ${serverFiles(files)};`,
    // Redacted owns a private store per Effect instance. Decode on
    // the host side and re-wrap with the selected app framework.
    "export default (request, context, accounts) => handler(request, { ...context, ...host.hostContext(accounts, context.approval), files });",
  ].join("\n");

/**
 * The runtime's network module. Each bridge imports it before the app, so it evaluates first and
 * app code only ever sees the global `fetch` it installs; see app-network.ts.
 */
export const appNetworkModuleName = "__executor_network.js";
const networkImport = `import "./${appNetworkModuleName}";`;

/**
 * The app isolate's whole part of a call, on its own clock: from dispatching the request to reading
 * the response, so the framework's work outside its spans, such as decoding the request, collecting
 * telemetry and serializing the result, is counted. It reads the framework's own clock, so it agrees
 * with the app's spans; a build whose framework has no clock reports no dispatch time.
 */
const dispatchTiming = `const dispatched = (clock, started, value) => clock === undefined || typeof value !== "object" || value === null || Array.isArray(value) ? value : { ...value, dispatch: { elapsedMs: Number(clock() - started) / 1000000 } };`;

/**
 * Collect this isolate's garbage once a call is over, at most every ten seconds. workerd runs a
 * major collection only when an isolate's own JavaScript heap grows, but each call also leaves
 * runtime objects outside that heap, held by small wrappers that only such a collection frees.
 * An isolate whose heap stays small therefore keeps every call's objects. Hosts that run their
 * own workerd expose `gc`; elsewhere this does nothing.
 */
const collectGarbage = `let collected = 0;
const collect = () => { const gc = globalThis.gc; if (typeof gc !== "function" || Date.now() - collected < 10000) return; collected = Date.now(); gc(); };`;

/**
 * Runtime-owned RPC entrypoint. Retained fetch bridges continue to work and only new bridges use
 * the callback.
 *
 * `load: "call"` imports the app inside `start`, for a Worker that only declares a new build. A
 * module that throws while it loads then fails in this isolate, which still holds its stack; the
 * Worker Loader reports a failed static import without positions. RPC carries an error's name and
 * message but not its stack, so a new error with the same name carries the positions in its
 * message. The app's error is never changed: it may be frozen or have a read-only message, and
 * anything unexpected while reading it sends the original on unchanged.
 */
export const appRpcBridge = (module: string, load: "module" | "call" = "module") => `
${networkImport}
${
  load === "module"
    ? `import app from ${JSON.stringify(`./${module}`)};`
    : `const located = (error) => {
  try {
    const head = String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    if (typeof stack !== "string" || !stack.startsWith(head)) return error;
    const diagnostic = new Error(String(error.message) + stack.slice(head.length));
    diagnostic.name = String(error.name);
    return diagnostic;
  } catch {
    return error;
  }
};
const loadApp = () => import(${JSON.stringify(`./${module}`)}).then((loaded) => loaded.default, (error) => { throw located(error); });`
}
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import * as workers from "cloudflare:workers";
${dispatchTiming}
${collectGarbage}
class Invocation extends RpcTarget {
  #controller = new AbortController();
  #dispatch;
  #result;
  #cache;
  #cacheCallback;
  #stubs;
  constructor(bridge, body, headers, elicitation, workflow, controls, cache) {
    super();
    this.#cacheCallback = cache == null ? null : cache.dup();
    this.#cache = this.#cacheCallback == null ? undefined : bridge.cacheSession?.(this.#cacheCallback);
    const delivery = elicitation == null ? null : elicitation.dup();
    const execution = workflow == null ? null : workflow.dup();
    const management = controls == null ? null : controls.dup();
    this.#stubs = [delivery, execution, management];
    // The app runs once the runner asks for its result, after this start has returned: starting is
    // the runner's own time and never overlaps the app's.
    this.#dispatch = () => {
      const clock = bridge.clock;
      const started = clock?.();
      return bridge.fetch(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: this.#controller.signal
      }), { ELICITATION: delivery, WORKFLOW: execution, WORKFLOW_CONTROLS: management, CACHE: this.#cache?.cache }).then(response => response.json()).then(value => ({ ok: true, value: dispatched(clock, started, value) }), error => ({ ok: false, error })).finally(() => this.#release());
    };
  }
  #release() { for (const stub of this.#stubs) stub?.[Symbol.dispose](); this.#stubs = []; }
  async result() { this.#result ??= this.#dispatch(); const result = await this.#result; if (!result.ok) throw result.error; return result.value; }
  async drain() { await this.#result; await this.#cache?.drain(); this.#cacheCallback?.[Symbol.dispose](); this.#cacheCallback = null; collect(); }
  async cancel() { this.#controller.abort(); await this.#cache?.cancel(); await this.drain(); }
  [Symbol.dispose]() { this.#controller.abort(); if (this.#result === undefined) this.#release(); }
}
export default class extends WorkerEntrypoint {
  ${
    load === "module"
      ? "start(body, headers, elicitation, workflow = null, controls = null, cache = null) { return new Invocation(app, body, headers, elicitation, workflow, controls, cache); }"
      : "async start(body, headers, elicitation, workflow = null, controls = null, cache = null) { return new Invocation(await loadApp(), body, headers, elicitation, workflow, controls, cache); }"
  }
  ${retireMethod}
}`;

/** A dynamic class receives only its own SQLite storage, with no platform bindings. */
export const appFacetBridge = (module: string) => `
${networkImport}
import bridge from ${JSON.stringify(`./${module}`)};
import { DurableObject } from "cloudflare:workers";
import * as workers from "cloudflare:workers";
import { facetStorage } from "apps/storage/facet";
${dispatchTiming}
${collectGarbage}
/** Only the data supervisor reaches this entrypoint, to unload a facet it replaced. */
export default class extends workers.WorkerEntrypoint {
  ${retireMethod}
}
export class ExecutorAppData extends DurableObject {
  #storage = facetStorage(this.ctx.storage);
  #calls = new Map();
  #caches = new Map();
  fetch(request) { return bridge.fetch(request, { STORAGE: this.#storage }); }
  async invoke(id, body, headers, elicitation, workflows, cache) {
    const session = cache == null ? undefined : bridge.cacheSession?.(cache);
    if (session) this.#caches.set(id, session);
    const controller = new AbortController();
    this.#calls.set(id, controller);
    try {
      const clock = bridge.clock;
      const started = clock?.();
      const response = await bridge.fetch(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: controller.signal
      }), { STORAGE: this.#storage, ELICITATION: elicitation, WORKFLOW_CONTROLS: workflows, CACHE: session?.cache });
      return dispatched(clock, started, await response.json());
    } finally { this.#calls.delete(id); }
  }
  async finish(id) { try { await this.#caches.get(id)?.drain(); } finally { this.#caches.delete(id); collect(); } }
  async cancel(id) { this.#calls.get(id)?.abort(); await this.#caches.get(id)?.cancel(); this.#caches.delete(id); collect(); }
}`;
