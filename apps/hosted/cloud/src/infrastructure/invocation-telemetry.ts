import * as Cloudflare from "alchemy/Cloudflare";

export class InvocationTelemetry extends Cloudflare.Worker<InvocationTelemetry, {}>()(
  "InvocationTelemetry",
) {}
