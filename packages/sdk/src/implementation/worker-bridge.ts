import type { SourceFile } from "../contracts/deployment.ts";
/** Retain package files in the server entry point and preserve invocation context across isolation. */
export const appBridge = (files: readonly SourceFile[]) => `
import app from "./index.ts";
import { createIsolatedAppHandler, hostContext, isolatedElicitation, isolatedWorkflowExecution, isolatedWorkflowControls } from "apps/host";
const handler = createIsolatedAppHandler(app);
const files = ${JSON.stringify(files)};
export default {
  async fetch(request, env) {
    // This entry point has no public route or host bindings. Only the trusted loader calls it.
    const { command, accounts, approval, replay, deadline, workflowRun } = await request.json();
    const lifetime = new AbortController();
    const delivery = env?.ELICITATION;
    const elicitation = delivery == null ? undefined : isolatedElicitation((prompt) => delivery(prompt), lifetime);
    try {
      return await handler(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { "content-type": "application/json", traceparent: request.headers.get("traceparent") ?? "" }, body: JSON.stringify(command), signal: AbortSignal.any([request.signal, lifetime.signal])
      }), { ...hostContext(accounts, approval), files, ...(replay === undefined ? {} : { replay }), ...(deadline === undefined ? {} : { deadline }), ...(env?.WORKFLOW && workflowRun ? { workflow: isolatedWorkflowExecution(workflowRun, env.WORKFLOW, lifetime.signal) } : {}), ...(env?.WORKFLOW_CONTROLS ? { workflowControls: isolatedWorkflowControls(env.WORKFLOW_CONTROLS) } : {}), ...(elicitation === undefined ? {} : { elicitation }), ...(env?.STORAGE === undefined ? {} : { storage: env.STORAGE }) });
    } finally { lifetime.abort(); }
  }
};`;

/** Runtime-owned RPC entrypoint. Retained fetch bridges continue to work and only new bridges use the callback. */
export const appRpcBridge = (module: string) => `
import bridge from ${JSON.stringify(`./${module}`)};
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
class Invocation extends RpcTarget {
  #controller = new AbortController();
  #result;
  constructor(body, headers, elicitation, workflow, controls) {
    super();
    const delivery = elicitation == null ? null : elicitation.dup();
    const execution = workflow == null ? null : workflow.dup();
    const management = controls == null ? null : controls.dup();
    this.#result = bridge.fetch(new Request("https://app.internal/dispatch", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: this.#controller.signal
    }), { ELICITATION: delivery, WORKFLOW: execution, WORKFLOW_CONTROLS: management }).then(response => response.json()).then(value => ({ ok: true, value }), error => ({ ok: false, error })).finally(() => { delivery?.[Symbol.dispose](); execution?.[Symbol.dispose](); management?.[Symbol.dispose](); });
  }
  async result() { const result = await this.#result; if (!result.ok) throw result.error; return result.value; }
  async cancel() { this.#controller.abort(); await this.#result; }
  [Symbol.dispose]() { this.#controller.abort(); }
}
export default class extends WorkerEntrypoint {
  start(body, headers, elicitation, workflow = null, controls = null) { return new Invocation(body, headers, elicitation, workflow, controls); }
}`;

/** A dynamic class receives only its own SQLite storage, with no platform bindings. */
export const appFacetBridge = (module: string) => `
import bridge from ${JSON.stringify(`./${module}`)};
import { DurableObject } from "cloudflare:workers";
import { facetStorage } from "apps/storage/facet";
export class ExecutorAppData extends DurableObject {
  #storage = facetStorage(this.ctx.storage);
  #calls = new Map();
  fetch(request) { return bridge.fetch(request, { STORAGE: this.#storage }); }
  async invoke(id, body, headers, elicitation, workflows) {
    const controller = new AbortController();
    this.#calls.set(id, controller);
    try {
      const response = await bridge.fetch(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: controller.signal
      }), { STORAGE: this.#storage, ELICITATION: elicitation, WORKFLOW_CONTROLS: workflows });
      return await response.json();
    } finally { this.#calls.delete(id); }
  }
  cancel(id) { this.#calls.get(id)?.abort(); }
}`;
