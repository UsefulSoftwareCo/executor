import {
  organizationDefaults,
  withCatalogAppUpdates,
  type CatalogAppFeed,
} from "@executor-js/hosted-server";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import type { Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
export { executorCloudApiDocument } from "../contracts/api.ts";

export const defaultApp = (
  executor: Executor,
  origin: string,
  document: Effect.Effect<HostedApiDocument>,
  catalogFeed?: CatalogAppFeed,
) =>
  Effect.flatMap(organizationDefaults(executor, origin, document), (initialize) =>
    withCatalogAppUpdates(executor, catalogFeed, initialize),
  );
