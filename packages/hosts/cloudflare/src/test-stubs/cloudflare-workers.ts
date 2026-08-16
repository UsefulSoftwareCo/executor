export const env: Record<string, unknown> = {};

export class DurableObject<Env = Cloudflare.Env> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}

export class WorkerEntrypoint {}

export const exports: Record<string, unknown> = {};
