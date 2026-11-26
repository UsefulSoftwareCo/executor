import { organizationDefaults } from "@executor-js/hosted-server";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import type { Executor } from "@executor-js/sdk/core";
import type { Effect } from "effect";
export { executorCloudApiDocument } from "../contracts/api.ts";

export const defaultApp = (
  executor: Executor,
  origin: string,
  document: Effect.Effect<HostedApiDocument>,
) => organizationDefaults(executor, origin, document);
