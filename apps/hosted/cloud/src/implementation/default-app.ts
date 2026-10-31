/** The default management app is assembled only when its owning organization needs it. */
import {
  organizationDefaults,
  withCatalogAppUpdates,
  type CatalogAppFeed,
} from "@executor-js/hosted-server";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import type { Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
export { executorCloudApiDocument } from "../contracts/api.ts";

/** Load the management contract behind this feature's module boundary. */
export const defaultApp = (
  executor: Executor,
  origin: string,
  document: Effect.Effect<HostedApiDocument>,
  catalogFeed?: CatalogAppFeed,
) =>
  Effect.flatMap(organizationDefaults(executor, origin, document), (initialize) =>
    withCatalogAppUpdates(executor, catalogFeed, initialize),
  );
