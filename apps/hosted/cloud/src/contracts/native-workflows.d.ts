declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    constructor(message?: string, name?: string);
  }
}
