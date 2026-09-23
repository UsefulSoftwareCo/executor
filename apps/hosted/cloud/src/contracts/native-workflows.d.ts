/** Runtime-only Cloudflare module; loaded inside the workflow invocation, never provisioning. */
declare module "cloudflare:workflows" {
  /** Stops the native engine from retrying the current step. */
  export class NonRetryableError extends Error {
    constructor(message?: string, name?: string);
  }
}
