/** Narrow constructors provided by workerd; app modules never load these in Node. */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env> {
    protected readonly ctx: import("@cloudflare/workers-types").DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: import("@cloudflare/workers-types").DurableObjectState, env: Env);
  }
  export abstract class WorkflowEntrypoint<Env, Payload> {
    protected readonly env: Env;
    constructor(ctx: import("@cloudflare/workers-types").ExecutionContext, env: Env);
    abstract run(event: Readonly<{ payload: Payload }>, step: unknown): Promise<unknown>;
  }
}
/** Runtime-only modules provided by workerd, never imported by the Node host. */
declare module "executor-framework" {
  const framework: {
    readonly server: Readonly<Record<string, string>>;
    readonly browser: Readonly<Record<string, string>>;
  };
  export default framework;
}
