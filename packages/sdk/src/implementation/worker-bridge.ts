import { retireMethod } from "@executor-js/app-data/worker-bundle";
import type { SourceFile } from "../contracts/version.ts";
import { asciiJson } from "./ascii-json.ts";
import { outboundGroupHeader } from "./app-network.ts";

export const serverFiles = <File extends SourceFile>(files: readonly File[]) =>
  files.filter((file) => !file.path.startsWith("ui/"));
export const serverFilesModule = "__executor_files.js";
export const serverFilesSource = (files: readonly SourceFile[]) =>
  `export default ${asciiJson(JSON.stringify(serverFiles(files)))};`;
export const appBridge = `
import app from "./index.ts";
import * as host from "apps/host";
import files from "./${serverFilesModule}";
const handler = host.createIsolatedAppHandler(app);
export default {
  cacheSession: host.isolatedCacheSession,
  clock: host.isolatedClock,
  async fetch(request, env) {
    // This entry point has no public route or host bindings. Only the trusted loader calls it.
    const { command, accounts, approval, caller, replay, deadline, workflowRun } = await request.json();
    const lifetime = new AbortController();
    const delivery = env?.ELICITATION;
    const elicitation = delivery == null ? undefined : host.isolatedElicitation((prompt) => delivery(prompt), lifetime);
    try {
      return await handler(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { "content-type": "application/json", traceparent: request.headers.get("traceparent") ?? "" }, body: JSON.stringify(command), signal: AbortSignal.any([request.signal, lifetime.signal])
      }), { ...host.hostContext(accounts, approval, caller), files, ...(env?.CACHE === undefined ? {} : { cache: env.CACHE }), ...(replay === undefined ? {} : { replay }), ...(deadline === undefined ? {} : { deadline }), ...(env?.WORKFLOW && workflowRun ? { workflow: host.isolatedWorkflowExecution(workflowRun, env.WORKFLOW, lifetime.signal) } : {}), ...(env?.WORKFLOW_CONTROLS ? { workflowControls: host.isolatedWorkflowControls(env.WORKFLOW_CONTROLS) } : {}), ...(elicitation === undefined ? {} : { elicitation }), ...(env?.STORAGE === undefined ? {} : { storage: env.STORAGE }) });
    } finally { lifetime.abort(); }
  }
};`;

export const nodeAppEntry = (protocol: number) => (files: readonly SourceFile[]) =>
  [
    'import app from "./source/index.ts";',
    'import * as host from "apps/host";',
    `export const protocol = ${protocol};`,
    "const handler = host.createAppHandler(app);",
    `const files = ${JSON.stringify(serverFiles(files))};`,
    "export default (request, context, accounts) => handler(request, { ...context, ...host.hostContext(accounts, context.approval, context.caller), files });",
  ].join("\n");

export const appNetworkModuleName = "__executor_network.js";
const networkImport = `import "./${appNetworkModuleName}";`;

const dispatchTiming = `const dispatched = (clock, started, value) => clock === undefined || typeof value !== "object" || value === null || Array.isArray(value) ? value : { ...value, dispatch: { elapsedMs: Number(clock() - started) / 1000000 } };`;

const collectGarbage = `let collected = 0;
const collect = () => { const gc = globalThis.gc; if (typeof gc !== "function" || Date.now() - collected < 10000) return; collected = Date.now(); gc(); };`;

export const appRpcBridge = (module: string, load: "module" | "call" = "module") => `
import { outboundGroup } from "./${appNetworkModuleName}";
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
    // A call the host names a group for runs in \`outboundGroup\`, so each request it sends names it.
    const { [${JSON.stringify(outboundGroupHeader)}]: group, ...forwarded } = headers;
    this.#dispatch = () => {
      const clock = bridge.clock;
      const started = clock?.();
      const send = () => bridge.fetch(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { ...forwarded, "content-type": "application/json" }, body, signal: this.#controller.signal
      }), { ELICITATION: delivery, WORKFLOW: execution, WORKFLOW_CONTROLS: management, CACHE: this.#cache?.cache });
      return (typeof group === "string" ? outboundGroup.run(group, send) : send()).then(response => response.json()).then(value => ({ ok: true, value: dispatched(clock, started, value) }), error => ({ ok: false, error })).finally(() => this.#release());
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
    // The runtime disposes a stub passed to a call when the call returns, and a stale read's
    // refresh outlives the call: keep a duplicate until the call's session is over.
    const callback = cache == null || bridge.cacheSession == null ? null : cache.dup();
    const session = callback == null ? undefined : bridge.cacheSession(callback);
    if (session) this.#caches.set(id, { session, callback });
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
  async finish(id) { const entry = this.#caches.get(id); try { await entry?.session.drain(); } finally { this.#release(id, entry); } }
  async cancel(id) { this.#calls.get(id)?.abort(); const entry = this.#caches.get(id); try { await entry?.session.cancel(); } finally { this.#release(id, entry); } }
  #release(id, entry) { entry?.callback[Symbol.dispose](); this.#caches.delete(id); collect(); }
}`;
