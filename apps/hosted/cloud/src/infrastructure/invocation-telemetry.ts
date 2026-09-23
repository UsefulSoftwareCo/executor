import * as Cloudflare from "alchemy/Cloudflare";

/** Private callback receiver shared by the API, app pages and compiler. */
export class InvocationTelemetry extends Cloudflare.Worker<InvocationTelemetry, {}>()(
  "InvocationTelemetry",
) {}
